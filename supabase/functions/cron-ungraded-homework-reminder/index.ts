// Hourly job: DMs the teacher (or all admins if no teacher) when a homework
// submission has been ungraded for 24h+. Up to 3 reminders, 24h apart.
// Mirrors notify-homework-submission for auth + Telegram send pattern.
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

async function sendMessage(chatId: number, text: string, inlineKeyboard?: any[][]) {
  const body: any = { chat_id: chatId, text, parse_mode: "HTML" };
  if (inlineKeyboard) body.reply_markup = { inline_keyboard: inlineKeyboard };
  return tg("sendMessage", body);
}

const __admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
let __sec: string | null = null;
async function __internalSecret(): Promise<string> {
  if (__sec) return __sec;
  const { data, error } = await __admin.rpc("internal_fn_secret");
  if (error) throw error;
  __sec = data as string;
  return __sec;
}

type Locale = "uz" | "ru" | "en";
const normLocale = (c?: string | null): Locale => {
  const l = (c || "").toLowerCase().slice(0, 2);
  if (l === "ru") return "ru";
  if (l === "en") return "en";
  return "uz";
};

function tashkentHour(): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tashkent", hour12: false, hour: "2-digit" });
    let h = parseInt(fmt.format(new Date()).slice(0, 2), 10);
    if (h === 24) h = 0;
    return h;
  } catch {
    return new Date().getUTCHours() + 5;
  }
}

const TEACHER_COPY = {
  uz: (s: string, t: string, h: number, n: number) =>
    `⏳ <b>${s}</b>ning «${t}» topshirig'i ${h} soatdan beri baholanmagan. Iltimos, baholang. (eslatma ${n}/3)`,
  ru: (s: string, t: string, h: number, n: number) =>
    `⏳ Работа «${t}» от <b>${s}</b> не оценена уже ${h} ч. Пожалуйста, оцените. (напоминание ${n}/3)`,
  en: (s: string, t: string, h: number, n: number) =>
    `⏳ <b>${s}</b>'s «${t}» has been awaiting grading for ${h}h. Please grade it. (reminder ${n}/3)`,
};
const ADMIN_COPY = {
  uz: (s: string, t: string, h: number, n: number) =>
    `⚠️ <b>${s}</b>ning «${t}» topshirig'i ${h} soatdan beri baholanmagan va guruhga o'qituvchi biriktirilmagan. Iltimos, ko'rib chiqing. (eslatma ${n}/3)`,
  ru: (s: string, t: string, h: number, n: number) =>
    `⚠️ Работа «${t}» от <b>${s}</b> не оценена ${h} ч, и в группе нет преподавателя. Пожалуйста, проверьте. (напоминание ${n}/3)`,
  en: (s: string, t: string, h: number, n: number) =>
    `⚠️ <b>${s}</b>'s «${t}» has been ungraded for ${h}h and the group has no teacher. Please review. (reminder ${n}/3)`,
};
const TEACHER_BTN: Record<Locale, string> = { uz: "🎯 Baholash", ru: "🎯 Оценить", en: "🎯 Grade" };
const ADMIN_BTN: Record<Locale, string> = { uz: "🎯 Ko'rib chiqish", ru: "🎯 Проверить", en: "🎯 Review" };
const TEACHER_URL = "https://aicreator.academy/teacher/homework";
const ADMIN_URL = "https://aicreator.academy/admin/homework";

function fullName(p: any): string {
  const a = (p?.name || "").trim();
  const b = (p?.last_name || "").trim();
  return [a, b].filter(Boolean).join(" ") || "—";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const __p = req.headers.get("x-internal-secret");
  const __s = await __internalSecret();
  if (!__p || __p !== __s) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (!BOT_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: "bot not configured" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const admin = __admin;

  // QUIET HOURS: skip whole run between 22:00 and 08:00 Tashkent
  const hr = tashkentHour();
  if (hr < 8 || hr >= 22) {
    return new Response(JSON.stringify({ ok: true, skipped: "quiet_hours", hour: hr }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // Candidate query
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: subs, error: subsErr } = await admin
    .from("homework_submissions")
    .select("id, user_id, assignment_id, submitted_at")
    .is("score", null)
    .lt("submitted_at", cutoff)
    .order("submitted_at", { ascending: true })
    .limit(500);
  if (subsErr) {
    return new Response(JSON.stringify({ ok: false, error: subsErr.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const allSubs = (subs || []) as any[];
  if (!allSubs.length) {
    return new Response(JSON.stringify({ ok: true, processed: 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const subIds = allSubs.map((s) => s.id);
  const { data: rems } = await admin
    .from("homework_ungraded_reminders")
    .select("submission_id, reminders_sent, last_reminder_at, cycle_submitted_at")
    .in("submission_id", subIds);
  const remMap = new Map<string, any>((rems || []).map((r: any) => [r.submission_id, r]));

  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const eligible = allSubs.filter((s) => {
    const r = remMap.get(s.id);
    const sameCycle = !!(r && r.cycle_submitted_at && new Date(r.cycle_submitted_at).getTime() === new Date(s.submitted_at).getTime());
    const sent = sameCycle ? (r?.reminders_sent ?? 0) : 0;
    if (sent >= 3) return false;
    if (sameCycle && r?.last_reminder_at && new Date(r.last_reminder_at).getTime() >= dayAgo) return false;
    return true;
  }).slice(0, 200);

  if (!eligible.length) {
    return new Response(JSON.stringify({ ok: true, processed: 0, total_candidates: allSubs.length }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  // Bulk load related rows
  const studentIds = Array.from(new Set(eligible.map((s) => s.user_id)));
  const assignmentIds = Array.from(new Set(eligible.map((s) => s.assignment_id)));
  const [{ data: students }, { data: assignments }] = await Promise.all([
    admin.from("profiles").select("id, name, last_name, group_id, preferred_locale").in("id", studentIds),
    admin.from("homework_assignments").select("id, title, module_id").in("id", assignmentIds),
  ]);
  const studentMap = new Map<string, any>((students || []).map((p: any) => [p.id, p]));
  const assignMap = new Map<string, any>((assignments || []).map((a: any) => [a.id, a]));
  const moduleIds = Array.from(new Set((assignments || []).map((a: any) => a.module_id).filter(Boolean)));
  const { data: modules } = moduleIds.length
    ? await admin.from("modules").select("id, title").in("id", moduleIds)
    : { data: [] as any[] };
  const moduleMap = new Map<string, any>((modules || []).map((m: any) => [m.id, m]));

  const groupIds = Array.from(new Set((students || []).map((p: any) => p.group_id).filter(Boolean)));
  const { data: groups } = groupIds.length
    ? await admin.from("groups").select("id, teacher_id").in("id", groupIds)
    : { data: [] as any[] };
  const groupMap = new Map<string, any>((groups || []).map((g: any) => [g.id, g]));

  const teacherIds = Array.from(new Set((groups || []).map((g: any) => g.teacher_id).filter(Boolean)));
  const { data: teachers } = teacherIds.length
    ? await admin.from("profiles").select("id, telegram_id, preferred_locale, notifications_enabled").in("id", teacherIds)
    : { data: [] as any[] };
  const teacherMap = new Map<string, any>((teachers || []).map((t: any) => [t.id, t]));

  // Admins fallback (cached for the run)
  let adminRecipients: any[] | null = null;
  async function loadAdmins() {
    if (adminRecipients) return adminRecipients;
    const { data: roles } = await admin.from("user_roles").select("user_id, role").in("role", ["admin", "superadmin"] as any);
    const ids = Array.from(new Set((roles || []).map((r: any) => r.user_id)));
    if (!ids.length) { adminRecipients = []; return adminRecipients; }
    const { data: profs } = await admin.from("profiles").select("id, telegram_id, preferred_locale, notifications_enabled").in("id", ids);
    adminRecipients = (profs || []).filter((p: any) => p.telegram_id && p.notifications_enabled !== false);
    return adminRecipients;
  }

  let sent = 0, skipped = 0;

  for (const s of eligible) {
    try {
      const student = studentMap.get(s.user_id);
      if (!student) { skipped++; continue; }
      const assignment = assignMap.get(s.assignment_id);
      const mod = assignment?.module_id ? moduleMap.get(assignment.module_id) : null;
      const taskTitle = [mod?.title, assignment?.title].filter(Boolean).join(" · ") || "—";
      const studentName = fullName(student);
      const hours = Math.floor((Date.now() - new Date(s.submitted_at).getTime()) / 3600000);

      const grp = student.group_id ? groupMap.get(student.group_id) : null;
      const teacher = grp?.teacher_id ? teacherMap.get(grp.teacher_id) : null;

      type R = { chatId: number; locale: Locale };
      let recipients: R[] = [];
      let kind: "teacher" | "admin" = "teacher";
      if (teacher && teacher.telegram_id && teacher.notifications_enabled !== false) {
        recipients = [{ chatId: Number(teacher.telegram_id), locale: normLocale(teacher.preferred_locale) }];
      } else {
        kind = "admin";
        const admins = await loadAdmins();
        recipients = admins.map((a: any) => ({ chatId: Number(a.telegram_id), locale: normLocale(a.preferred_locale) }));
      }
      if (!recipients.length) { skipped++; continue; }

      const rr = remMap.get(s.id);
      const sameCycle = !!(rr && rr.cycle_submitted_at && new Date(rr.cycle_submitted_at).getTime() === new Date(s.submitted_at).getTime());
      const prevSent = sameCycle ? (rr?.reminders_sent ?? 0) : 0;
      const n = prevSent + 1;

      let anySent = false;
      for (const r of recipients) {
        const text = kind === "teacher"
          ? TEACHER_COPY[r.locale](studentName, taskTitle, hours, n)
          : ADMIN_COPY[r.locale](studentName, taskTitle, hours, n);
        const btn = kind === "teacher"
          ? [{ text: TEACHER_BTN[r.locale], url: TEACHER_URL }]
          : [{ text: ADMIN_BTN[r.locale], url: ADMIN_URL }];
        try {
          const resp = await sendMessage(r.chatId, text, [btn]);
          const ok = resp.ok;
          if (ok) anySent = true;
          else console.error("ungraded reminder send fail", s.id, resp.status, await resp.text().catch(() => ""));
        } catch (e) {
          console.error("ungraded reminder send exception", s.id, e);
        }
      }

      if (!anySent) { skipped++; continue; }

      // Upsert tracker (increment)
      await admin.from("homework_ungraded_reminders").upsert({
        submission_id: s.id,
        reminders_sent: n,
        last_reminder_at: new Date().toISOString(),
        cycle_submitted_at: s.submitted_at,
      }, { onConflict: "submission_id" });

      try {
        await admin.from("admin_actions").insert({
          actor_user_id: s.user_id,
          action: "ungraded_homework_reminder_sent",
          target_resource_type: "homework_submission",
          target_resource_id: s.id,
          details: { recipient_kind: kind, reminders_sent: n, hours_waiting: hours },
        });
      } catch { /* ignore */ }

      sent++;
    } catch (e) {
      console.error("ungraded reminder loop error", s.id, e);
      skipped++;
    }
  }

  return new Response(JSON.stringify({ ok: true, processed: eligible.length, sent, skipped }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
