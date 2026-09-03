// grade-card-reconcile — service-role BACKSTOP that heals students graded but never DM'd their grade
// card (the P0 gap fixed forward in notify-grade-voice / #153) AND catches any future transient miss.
//
// All 3 grade-card senders now share ONE dedup contract — homework_submissions.grade_card_notified_attempt
// (stamped by the bot flow in telegram-bot-webhook, by the app flow in notify-grade-voice, and here). So a
// row where that marker is NULL genuinely never had its card delivered for this attempt: this reconciler
// finds those, ATOMICALLY claims each (UPDATE ... WHERE grade_card_notified_attempt IS NULL — which also
// makes it race-safe against a concurrent grade, since any grade write stamps the marker), sends the card
// confirming delivery, stamps grade_card_dm_heartbeat. Idempotent, graceful, internal-secret gated
// (only pg_cron may call it), quiet-hours gated (no student DMs 22:00-08:00 Tashkent).
//
// The card TEXT mirrors notify-grade-voice / the bot's gradeStudentDM (hand-synced; a follow-up can
// consolidate all three into one _shared/grade-card.ts helper).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { sendTelegram } from "../_shared/telegram-send.ts";
import { verifyInternalSecret } from "../_shared/internal-secret.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const LOOKBACK_DAYS = 14; // heal grades from the last 2 weeks; older cohorts have the in-app view
const BATCH = 60;         // bounded work per run; oldest-pending-first so a backlog drains steadily

const escHtml = (s = "") => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Quiet hours: never DM a student 22:00-08:00 Tashkent (UTC+5, no DST) — mirrors cron-ungraded-homework-reminder.
function tashkentHour(): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tashkent", hour12: false, hour: "2-digit" });
    let h = parseInt(fmt.format(new Date()).slice(0, 2), 10);
    if (h === 24) h = 0;
    return h;
  } catch { return 12; } // on failure assume daytime (fail toward delivering, not toward a night-time send)
}

type Locale = "uz" | "ru" | "en";
function normLocale(code?: string | null): Locale {
  const l = (code || "").toLowerCase().slice(0, 2);
  if (l === "ru") return "ru";
  if (l === "en") return "en";
  return "uz";
}
// Same TEXT as notify-grade-voice GRADE_CARD / the bot's tt.gradeStudentDM (webhook index.ts:280/567/846).
const GRADE_CARD: Record<Locale, (title: string, sc: number, mx: number, fb: string, xp?: number) => string> = {
  uz: (t, sc, mx, fb, xp) => `🎉 Vazifangiz baholandi!\n\n📝 <b>${t}</b>\nBaho: <b>${sc}/${mx}</b>${xp ? `\n⚡ +${xp} XP` : ""}${fb ? `\nIzoh: ${fb}` : ""}`,
  ru: (t, sc, mx, fb, xp) => `🎉 Ваша работа оценена!\n\n📝 <b>${t}</b>\nОценка: <b>${sc}/${mx}</b>${xp ? `\n⚡ +${xp} XP` : ""}${fb ? `\nКомментарий: ${fb}` : ""}`,
  en: (t, sc, mx, fb, xp) => `🎉 Your homework was graded!\n\n📝 <b>${t}</b>\nScore: <b>${sc}/${mx}</b>${xp ? `\n⚡ +${xp} XP` : ""}${fb ? `\nFeedback: ${fb}` : ""}`,
};
const TITLE_FALLBACK: Record<Locale, string> = { uz: "Uy vazifasi", ru: "Домашнее задание", en: "Homework" };

async function logHealth(admin: any, studentUserId: string | null, action: string, details: Record<string, unknown>, submissionId: string | null) {
  try {
    await admin.from("admin_actions").insert({
      actor_user_id: null, action, target_user_id: studentUserId,
      target_resource_type: "homework_submission", target_resource_id: submissionId,
      details: { ...details, source: "grade-card-reconcile" },
    });
  } catch (e) { console.error("grade-card-reconcile logHealth threw", String(e)); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  if (!(await verifyInternalSecret(req, admin))) return json({ error: "forbidden" }, 403);
  if (!BOT_TOKEN) return json({ error: "not_configured" }, 500);

  const hr = tashkentHour();
  if (hr < 8 || hr >= 22) return json({ ok: true, skipped_quiet_hours: true, hour: hr });

  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();

  // Directly select the genuinely-undelivered set (marker IS NULL) — bounded, oldest-first so a backlog
  // drains steadily, no cross-column filter / 400-row starvation. Everything already delivered (bot, app)
  // carries a non-null marker and is excluded.
  const { data: rows, error: qErr } = await admin
    .from("homework_submissions")
    .select("id, user_id, assignment_id, score, previous_score, score_feedback, attempt_number")
    .not("score", "is", null)
    .is("grade_card_notified_attempt", null)
    .gte("scored_at", cutoff)
    .order("scored_at", { ascending: true })
    .limit(BATCH);
  if (qErr) return json({ error: "query_failed", desc: qErr.message }, 500);

  let healed = 0, failed = 0, skipped = 0;

  for (const sub of (rows || [])) {
    const attempt = (sub.attempt_number as number) ?? 1;
    // ATOMIC claim: WHERE marker IS NULL. If a concurrent grade (bot/app) stamped it since our SELECT,
    // this returns 0 rows → we skip (that path owns the send). Also prevents two reconciler runs racing.
    const { data: claimed } = await admin
      .from("homework_submissions")
      .update({ grade_card_notified_attempt: attempt })
      .eq("id", sub.id)
      .is("grade_card_notified_attempt", null)
      .select("id")
      .maybeSingle();
    if (!claimed) { skipped++; continue; }

    const { data: student } = await admin.from("profiles").select("telegram_id, preferred_locale").eq("id", sub.user_id).maybeSingle();
    const tgId = student?.telegram_id ?? null;
    if (!tgId) {
      // No telegram_id (~70%) — un-claim (back to NULL) so a future run reaches them if they start the bot.
      await admin.from("homework_submissions").update({ grade_card_notified_attempt: null }).eq("id", sub.id);
      skipped++;
      continue;
    }
    const locale = normLocale(student?.preferred_locale);
    const { data: a } = await admin.from("homework_assignments").select("title, max_score").eq("id", sub.assignment_id).maybeSingle();
    const title = (a?.title && String(a.title).trim()) || TITLE_FALLBACK[locale];
    const max = (a?.max_score as number) || 10;
    const fb = typeof sub.score_feedback === "string" ? sub.score_feedback.trim() : "";
    const prev = sub.previous_score as number | null;
    const gained25xp = (prev == null || prev < 9) && (sub.score as number) >= 9;
    const text = GRADE_CARD[locale](escHtml(title), sub.score as number, max, escHtml(fb), gained25xp ? 25 : undefined);

    const out = await sendTelegram(BOT_TOKEN, "sendMessage", { chat_id: Number(tgId), text, parse_mode: "HTML" }, { record: false });
    if (out.ok) {
      healed++;
      await admin.from("app_settings").upsert({ key: "grade_card_dm_heartbeat", value: { last_sent_at: new Date().toISOString() } }, { onConflict: "key" });
      await logHealth(admin, sub.user_id, "grade_card_dm_sent", { submission_id: sub.id, score: sub.score, max, attempt, reconciled: true }, sub.id);
    } else if (out.terminal) {
      // TERMINAL (recipient blocked/deleted OR content that will never render): keep the claim so we never
      // retry-forever DM a blocked user every 30 min. recipient_error is expected reach (watchdog excludes it).
      failed++;
      await logHealth(admin, sub.user_id, "grade_card_dm_failed", { submission_id: sub.id, error: out.error, recipient_error: out.recipient, content_error: out.content, terminal: true, reconciled: true }, sub.id);
    } else {
      // Transient (network / 5xx) — un-claim so a later run retries.
      await admin.from("homework_submissions").update({ grade_card_notified_attempt: null }).eq("id", sub.id);
      failed++;
      await logHealth(admin, sub.user_id, "grade_card_dm_failed", { submission_id: sub.id, error: out.error, recipient_error: false, terminal: false, reconciled: true }, sub.id);
    }
  }

  return json({ ok: true, candidates: (rows || []).length, healed, failed, skipped });
});
