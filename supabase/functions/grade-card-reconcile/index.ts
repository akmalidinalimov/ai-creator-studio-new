// grade-card-reconcile — service-role BACKSTOP that heals students graded but never DM'd their grade
// card (the P0 gap fixed forward in notify-grade-voice / #153) AND catches any future transient miss.
//
// Finds recently-scored, telegram-linked submissions whose grade card was never delivered for the
// current attempt (grade_card_notified_attempt IS NULL, or < attempt_number after a resubmission), sends
// each the grade card (confirming delivery), then marks it notified + stamps grade_card_dm_heartbeat.
// This is the "reconciler re-derives from source-of-truth" leg: triggers/forward-path are the instant
// route, this sweeps up anything they missed. Idempotent per attempt (ATOMIC claim), graceful (no
// telegram_id / blocked bot = skip, not a fault), internal-secret gated (only pg_cron may call it).
//
// The card TEXT mirrors notify-grade-voice / the bot's gradeStudentDM (hand-synced for now — a follow-up
// can consolidate all three into one _shared/grade-card.ts helper).
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
const BATCH = 60;         // bound work per run (this reconciler runs every 30 min)

const escHtml = (s = "") => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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

  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86400_000).toISOString();

  // Candidates: recently scored + not yet notified for at least SOME attempt. The "< attempt_number"
  // cross-column case (resubmission re-graded) is filtered in JS below (PostgREST can't compare two
  // columns). Rows already notified for the current attempt are filtered there too. Bounded fetch.
  const { data: rows, error: qErr } = await admin
    .from("homework_submissions")
    .select("id, user_id, assignment_id, score, previous_score, score_feedback, attempt_number, grade_card_notified_attempt, scored_at")
    .not("score", "is", null)
    .gte("scored_at", cutoff)
    .order("scored_at", { ascending: false })
    .limit(400);
  if (qErr) return json({ error: "query_failed", desc: qErr.message }, 500);

  const pending = (rows || []).filter((r: any) => {
    const attempt = (r.attempt_number as number) ?? 1;
    const notified = r.grade_card_notified_attempt as number | null;
    return notified == null || notified < attempt;
  }).slice(0, BATCH);

  let healed = 0, failed = 0, skipped = 0;

  for (const sub of pending) {
    const attempt = (sub.attempt_number as number) ?? 1;
    const notifiedAttempt = sub.grade_card_notified_attempt as number | null;
    // ATOMIC claim — exactly one sender per attempt even if the forward path fires concurrently.
    const { data: claimed } = await admin
      .from("homework_submissions")
      .update({ grade_card_notified_attempt: attempt })
      .eq("id", sub.id)
      .or(`grade_card_notified_attempt.is.null,grade_card_notified_attempt.lt.${attempt}`)
      .select("id")
      .maybeSingle();
    if (!claimed) { skipped++; continue; } // someone else just handled it

    const { data: student } = await admin.from("profiles").select("telegram_id, preferred_locale").eq("id", sub.user_id).maybeSingle();
    const tgId = student?.telegram_id ?? null;
    if (!tgId) {
      // No telegram_id (~70%) — un-claim so if they later start the bot a future run can reach them.
      await admin.from("homework_submissions").update({ grade_card_notified_attempt: notifiedAttempt }).eq("id", sub.id);
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
    } else if (out.recipient) {
      // Blocked / deleted account — a terminal recipient miss. Keep the claim (don't retry forever); it's
      // expected reach, not a fault, and the watchdog excludes recipient_error.
      failed++;
      await logHealth(admin, sub.user_id, "grade_card_dm_failed", { submission_id: sub.id, error: out.error, recipient_error: true, terminal: true, reconciled: true }, sub.id);
    } else {
      // Transient/content failure — un-claim so a later run retries.
      await admin.from("homework_submissions").update({ grade_card_notified_attempt: notifiedAttempt }).eq("id", sub.id);
      failed++;
      await logHealth(admin, sub.user_id, "grade_card_dm_failed", { submission_id: sub.id, error: out.error, recipient_error: false, terminal: out.terminal, reconciled: true }, sub.id);
    }
  }

  return json({ ok: true, candidates: pending.length, healed, failed, skipped });
});
