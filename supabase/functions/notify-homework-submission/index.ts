// v3.14.18: Drains homework_teacher_dm_queue and DMs teachers about student submissions.
// Triggered by pg_cron every minute. Respects notifications_enabled, quiet hours, RBAC.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";

function tg(method: string, body: unknown) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const MSG = {
  uz: (name: string, mn: number, tn: number, title: string) =>
    `📝 <b>Yangi topshiriq</b>\n\n<b>${name}</b> Modul ${mn} · Vazifa ${tn} ni topshirdi${title ? `\n«${title}»` : ""}`,
  ru: (name: string, mn: number, tn: number, title: string) =>
    `📝 <b>Новая работа</b>\n\n<b>${name}</b> отправил(а) Модуль ${mn} · Задание ${tn}${title ? `\n«${title}»` : ""}`,
  en: (name: string, mn: number, tn: number, title: string) =>
    `📝 <b>New submission</b>\n\n<b>${name}</b> submitted Module ${mn} · Task ${tn}${title ? `\n"${title}"` : ""}`,
};

const __admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
let __sec: string | null = null;
let __lastFetch = 0;
async function __internalSecret(force = false): Promise<string> {
  const now = Date.now();
  // Cache the Vault secret, but allow a forced re-fetch on mismatch (rotation self-heal). Debounce the
  // forced path to ≤1 RPC / 15s so a wrong-secret flood on this verify_jwt=false endpoint can't amplify.
  if (__sec && (!force || now - __lastFetch < 15_000)) return __sec;
  __lastFetch = now;
  const { data, error } = await __admin.rpc("internal_fn_secret");
  if (error) throw error;
  __sec = data as string;
  return __sec;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const __p = req.headers.get("x-internal-secret");
  let __s = await __internalSecret();
  // Cached for the instance's lifetime; if internal_fn_secret was rotated, a warm instance holds the
  // stale value and would 403 valid cron calls — re-fetch once on mismatch before rejecting (self-heals).
  if (!__p || __p !== __s) __s = await __internalSecret(true);
  if (!__p || __p !== __s) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (!BOT_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: "bot not configured" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const admin = __admin;

  // Minute tick for the picker sweep: guarantees the ~10-min auto-fallback fires even when the
  // group chat is silent (the in-webhook sweep runs only on organic traffic — quiet nights
  // starved it). Best-effort, never blocks DM delivery.
  try {
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/telegram-bot-webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-secret": __s },
      body: JSON.stringify({ action: "sweep_pending" }),
    });
  } catch (_e) { /* best-effort */ }

  const { data: pending, error } = await admin
    .from("homework_teacher_dm_queue")
    .select("*")
    .is("sent_at", null)
    .lte("scheduled_for", new Date().toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(100);
  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const rows = (pending || []) as any[];
  if (!rows.length) {
    return new Response(JSON.stringify({ ok: true, processed: 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const teacherIds = Array.from(new Set(rows.map((r) => r.teacher_id)));
  const groupIds = Array.from(new Set(rows.map((r) => r.group_id)));
  const [{ data: profs }, { data: groups }, { data: gTeachers }] = await Promise.all([
    admin.from("profiles").select("id, telegram_id, preferred_locale, notifications_enabled").in("id", teacherIds),
    admin.from("groups").select("id, teacher_id").in("id", groupIds),
    admin.from("group_teachers").select("group_id, teacher_id").in("group_id", groupIds),
  ]);
  const profMap = new Map<string, any>((profs || []).map((p: any) => [p.id, p]));
  const groupMap = new Map<string, any>((groups || []).map((g: any) => [g.id, g]));
  // RBAC set of valid (group, teacher) pairs = primary ∪ co-teachers (group_teachers). A co-teacher row
  // the reconciler fanned out is legitimate and must NOT be permanently closed as "no longer assigned".
  const teacherOfGroup = new Set<string>();
  for (const g of (groups || []) as any[]) if (g.teacher_id) teacherOfGroup.add(`${g.id}:${g.teacher_id}`);
  for (const gt of (gTeachers || []) as any[]) teacherOfGroup.add(`${gt.group_id}:${gt.teacher_id}`);

  let sent = 0, skipped = 0;

  for (const row of rows) {
    const markSent = async (err?: string) => {
      await admin.from("homework_teacher_dm_queue").update({ sent_at: new Date().toISOString(), error: err || null }).eq("id", row.id);
    };
    // Transient failure (429 burst at the 08:00 flush, 5xx, network blip): leave sent_at NULL so
    // the every-minute cron retries. Cap 30 (~30 min of minute-retries) — high enough that the
    // SQL fallback deliverer (claims rows >15 min overdue) always gets a shot before we give up,
    // low enough that a poison row can't loop forever.
    const RETRY_CAP = 30;
    const markRetry = async (err: string) => {
      const attempts = ((row.retry_count as number | null) ?? 0) + 1;
      if (attempts > RETRY_CAP) { await markSent(`gave_up_after_${RETRY_CAP}_retries: ${err}`.slice(0, 300)); return; }
      await admin.from("homework_teacher_dm_queue").update({ retry_count: attempts, error: err.slice(0, 300) }).eq("id", row.id);
    };
    const teacher = profMap.get(row.teacher_id);
    const grp = groupMap.get(row.group_id);
    // RBAC: teacher must still be a teacher of the group (primary OR co-teacher)
    if (!grp || !teacherOfGroup.has(`${row.group_id}:${row.teacher_id}`)) {
      await markSent("teacher_no_longer_assigned"); skipped++; continue;
    }
    if (!teacher || !teacher.telegram_id || teacher.notifications_enabled === false) {
      await markSent("notifications_disabled_or_no_telegram"); skipped++; continue;
    }

    const loc = (teacher.preferred_locale === "ru" || teacher.preferred_locale === "en") ? teacher.preferred_locale : "uz";
    // An auto-GUESSED attribution carries "(taxminiy)" in the stored title. Make it loud + offer a
    // one-tap ✏️ retag so a wrong guess is cheap to fix (the row.task_number here is already the
    // sap-aware step written by the fixed queue insert, so "Vazifa 1/2/3" now renders correctly).
    const guessed = /\(taxminiy\)/.test(row.assignment_title || "");
    let text = (MSG as any)[loc](row.student_name || "—", row.module_number, row.task_number, row.assignment_title || "");
    if (guessed) {
      text += loc === "ru"
        ? "\n\n⚠️ <b>Авто-назначено</b> — задание выбрано примерно. Если неверно — исправьте ✏️."
        : loc === "en"
        ? "\n\n⚠️ <b>Auto-assigned</b> — the task was guessed. If it's wrong, fix it with ✏️."
        : "\n\n⚠️ <b>Avto-belgilangan</b> — vazifa taxminan tanlandi. Noto'g'ri bo'lsa ✏️ bilan to'g'rilang.";
    }
    // Class F fix (2026-08-18 review): a miniapp-sourced row's message_url is a bot deep-link
    // placeholder (https://t.me/<bot>?start=hw_<id>_<attempt> — see submit-homework/index.ts and
    // the reconcile_teacher_dm_queue() migration that mirrors it), not a real group-topic post —
    // tapping "Open post" for one just opens the bot chat, a dead end. Real topic links always
    // look like https://t.me/c/<chat>/<thread>/<message> (buildMessageLink, telegram-bot-webhook/
    // index.ts:4679-4683) and never carry a "?start=" query string, so this check is unambiguous
    // without needing a schema change or extra join. "🎯 Grade" already renders the image via a
    // signed URL for miniapp submissions (telegram-bot-webhook/index.ts:4057-4063), so it alone is
    // still a complete, working action for those rows.
    const isRealTopicLink = /^https:\/\/t\.me\/c\//.test(row.message_url || "");
    const buttons = [
      ...(isRealTopicLink
        ? [{ text: loc === "ru" ? "📂 Открыть пост" : loc === "en" ? "📂 View post" : "📂 Topshirgan postni ko'rish", url: row.message_url }]
        : []),
      { text: loc === "ru" ? "🎯 Оценить" : loc === "en" ? "🎯 Grade" : "🎯 Baholash", callback_data: `gs:open:${row.submission_id}` },
    ];
    const retagRow = guessed
      ? [[{ text: loc === "ru" ? "✏️ Изменить задание" : loc === "en" ? "✏️ Change task" : "✏️ Vazifani o'zgartirish", callback_data: `hwmv:${row.submission_id}` }]]
      : [];
    try {
      const resp = await tg("sendMessage", {
        chat_id: Number(teacher.telegram_id),
        text,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [buttons, ...retagRow] },
      });
      let okBody: any = null;
      try { okBody = await resp.clone().json(); } catch { /* ignore */ }
      if (!resp.ok || !okBody?.ok) {
        const errTxt = okBody ? JSON.stringify(okBody) : await resp.text().catch(() => "");
        console.error("hw teacher dm fail", row.id, resp.status, errTxt);
        const code = okBody?.error_code ?? resp.status;
        if (code === 429 || code >= 500) {
          await markRetry(`tg_${code}_${String(errTxt).slice(0, 120)}`); // transient → retry next minute
        } else {
          await markSent(`tg_${code}_${String(errTxt).slice(0, 120)}`); // permanent (403 blocked, 400 bad chat) → no point retrying
        }
        skipped++;
      } else {
        await markSent();
        sent++;
        try {
          await admin.from("admin_actions").insert({
            actor_user_id: row.student_id,
            action: "homework_submission_dm_sent",
            target_user_id: row.teacher_id,
            target_resource_type: "homework_submission",
            target_resource_id: row.submission_id,
            details: {
              student_id: row.student_id,
              group_id: row.group_id,
              module_id: row.module_id,
              message_url: row.message_url,
              queued_for_quiet_hours: !!row.queued_for_quiet_hours,
            },
          });
        } catch { /* ignore */ }
      }
    } catch (e) {
      console.error("hw teacher dm exception", row.id, e);
      await markRetry(String(e)); // network-level exception = transient → retry next minute
      skipped++;
    }
  }

  return new Response(JSON.stringify({ ok: true, processed: rows.length, sent, skipped }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
