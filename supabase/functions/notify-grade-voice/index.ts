// notify-grade-voice — push a student their GRADE on an app/web grade (Mini App, web teacher tools).
//
// POST { submission_id: uuid }
//   -> { ok:true, card_sent:bool, voice_sent:bool, reason? }
//   -> { error:"unauthorized" } (401) / { error:"forbidden" } (403) / { error:"submission_id required" } (400)
//
// WHY THIS SENDS THE GRADE CARD NOW (P0, grade_delivery_watchdog SILENCE alarm 2026-09-03):
// the BOT grading flow DMs the student a full grade card (webhook gradeStudentDM) and stamps
// grade_card_dm_heartbeat; but Mini App / web grading called this function, which used to DM ONLY when a
// VOICE note existed — a plain score+text grade in the app notified the student of NOTHING. As teachers
// moved to Mini App grading, students were graded silently. This function now sends the SAME grade card
// (score/max + feedback + XP) on every app grade, plus the voice note if one was recorded, and stamps the
// delivery heartbeat so the watchdog sees this path too.
//
// Dedup: ONE grade-card DM per graded ATTEMPT (homework_submissions.grade_card_notified_attempt,
// 20260903100000). A plain feedback edit re-saves scored_at but not attempt_number → no re-spam; a
// resubmission bumps attempt_number → correctly re-notifies. The voice send keeps its own idempotency
// (only fires when a voice path is present; a re-invoke without voice is a no-op no_voice).
//
// Auth: the caller's Supabase session JWT (verify_jwt = true in supabase/config.toml).
// RBAC: caller must be a teacher of the submission's student's group (is_group_teacher, junction-aware)
//   OR a platform admin/superadmin. A student can never trigger their own grade DM. Anyone else → 403.
// Member-forgiveness (CLAUDE.md): a student with no telegram_id (~70% never pressed Start) is a graceful
//   no-send, HTTP 200, NOT a failure — and NOT marked notified (a later reconciler can still reach them).
// SECURITY: the bot token is used ONLY inside this function; never returned, embedded in the signed audio
//   URL, or logged. Only REAL non-deliveries (blocked/errored, recipient_error flagged) are DB-visible.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { sendTelegram } from "../_shared/telegram-send.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BUCKET = "homework-audio";
const SIGNED_TTL = 600; // ~10 min — Telegram fetches the URL itself right after this call returns
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// The grade card — byte-for-byte the bot's tt.gradeStudentDM (webhook index.ts:280/567/846), so a student
// gets the SAME message whether graded via bot or app. title + fb are HTML-escaped by the caller.
const GRADE_CARD: Record<Locale, (title: string, sc: number, mx: number, fb: string, xp?: number) => string> = {
  uz: (title, sc, mx, fb, xp) => `🎉 Vazifangiz baholandi!\n\n📝 <b>${title}</b>\nBaho: <b>${sc}/${mx}</b>${xp ? `\n⚡ +${xp} XP` : ""}${fb ? `\nIzoh: ${fb}` : ""}`,
  ru: (title, sc, mx, fb, xp) => `🎉 Ваша работа оценена!\n\n📝 <b>${title}</b>\nОценка: <b>${sc}/${mx}</b>${xp ? `\n⚡ +${xp} XP` : ""}${fb ? `\nКомментарий: ${fb}` : ""}`,
  en: (title, sc, mx, fb, xp) => `🎉 Your homework was graded!\n\n📝 <b>${title}</b>\nScore: <b>${sc}/${mx}</b>${xp ? `\n⚡ +${xp} XP` : ""}${fb ? `\nFeedback: ${fb}` : ""}`,
};
const VOICE_CAPTION: Record<Locale, (title: string) => string> = {
  uz: (title) => `🎧 "${title}" bo'yicha yangi ovozli izoh — balingizni ko'rish uchun ilovani oching.`,
  ru: (title) => `🎧 Новый голосовой комментарий к "${title}" — откройте приложение, чтобы увидеть оценку.`,
  en: (title) => `🎧 New voice feedback on "${title}" — open the app for your score.`,
};
const TITLE_FALLBACK: Record<Locale, string> = { uz: "Uy vazifasi", ru: "Домашнее задание", en: "Homework" };

// Incident doctrine: failures DB-visible (not log-only). Best-effort; never breaks the response, never
// carries the bot token or the signed audio URL.
async function logHealth(
  admin: any, actorUserId: string | null, studentUserId: string | null,
  action: string, details: Record<string, unknown>, submissionId: string | null,
) {
  try {
    const { error } = await admin.from("admin_actions").insert({
      actor_user_id: actorUserId, action, target_user_id: studentUserId,
      target_resource_type: "homework_submission", target_resource_id: submissionId,
      details: { ...details, source: "notify-grade-voice" },
    });
    if (error) console.error("notify-grade-voice logHealth insert failed", error.message);
  } catch (e) {
    console.error("notify-grade-voice logHealth threw", String(e));
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // --- 1. Auth (never log the JWT). verify_jwt=true already rejected anonymous; we need auth.uid() for RBAC. ---
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!jwt) return json({ error: "unauthorized" }, 401);
  const { data: userData, error: authErr } = await admin.auth.getUser(jwt);
  if (authErr || !userData?.user) return json({ error: "unauthorized" }, 401);
  const uid = userData.user.id;

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const submissionId = String(body?.submission_id || "").trim();
  if (!submissionId || !UUID_RE.test(submissionId)) return json({ error: "submission_id required" }, 400);
  // voice_fresh = a NEW voice note was recorded THIS grading round. The grade card always sends (deduped
  // per attempt); the voice only sends when freshly recorded, so a plain re-grade never re-pushes a
  // PRESERVED older note (the exact double-send the caller's old voice-only gating prevented).
  const voiceFresh = body?.voice_fresh === true;

  try {
    // --- 2. Load the submission. ---
    const { data: sub, error: subErr } = await admin
      .from("homework_submissions")
      .select("id, user_id, assignment_id, score, score_feedback, score_feedback_voice_path, attempt_number, grade_card_notified_attempt")
      .eq("id", submissionId)
      .maybeSingle();
    if (subErr) throw subErr;
    if (!sub) return json({ ok: true, card_sent: false, voice_sent: false, reason: "submission_not_found" });

    // --- 3. RBAC (junction-aware, no student-self branch). ---
    const { data: prof, error: profErr } = await admin
      .from("profiles").select("group_id").eq("id", sub.user_id).maybeSingle();
    if (profErr) throw profErr;
    const groupId: string | null = prof?.group_id ?? null;
    let allowed = false;
    if (groupId) {
      const { data: isTeacher, error: itErr } = await admin.rpc("is_group_teacher", { _group_id: groupId, _uid: uid });
      if (itErr) throw itErr;
      allowed = isTeacher === true;
    }
    if (!allowed) {
      const { data: roles, error: rErr } = await admin
        .from("user_roles").select("role").eq("user_id", uid).in("role", ["admin", "superadmin"]);
      if (rErr) throw rErr;
      allowed = !!roles?.length;
    }
    if (!allowed) return json({ error: "forbidden" }, 403);

    if (!BOT_TOKEN) {
      await logHealth(admin, uid, sub.user_id, "grade_card_dm_failed", { submission_id: submissionId, desc: "bot_token_missing" }, submissionId);
      return json({ ok: true, card_sent: false, voice_sent: false, reason: "bot_token_missing" });
    }

    // --- 4. The recipient. A student with no telegram_id (~70% never Started) is a graceful no-send. ---
    const { data: student, error: stuErr } = await admin
      .from("profiles").select("telegram_id, preferred_locale").eq("id", sub.user_id).maybeSingle();
    if (stuErr) throw stuErr;
    const telegramId = student?.telegram_id ?? null;
    if (!telegramId) return json({ ok: true, card_sent: false, voice_sent: false, reason: "no_telegram" });
    const locale = normLocale(student?.preferred_locale);

    // --- 5. Assignment (title + max_score). ---
    const { data: assignment } = await admin
      .from("homework_assignments").select("title, max_score").eq("id", sub.assignment_id).maybeSingle();
    const title = (assignment?.title && String(assignment.title).trim()) || TITLE_FALLBACK[locale];
    const max = (assignment?.max_score as number) || 10;

    let cardSent = false;
    let voiceSent = false;

    // --- 6. GRADE CARD (the P0 fix). Once per graded attempt (dedup). ---
    const score = (sub as any).score;
    const attempt = ((sub as any).attempt_number as number) ?? 1;
    const notifiedAttempt = (sub as any).grade_card_notified_attempt as number | null;
    const alreadyNotified = notifiedAttempt != null && notifiedAttempt >= attempt;
    if (typeof score === "number" && !alreadyNotified) {
      const fb = typeof sub.score_feedback === "string" ? sub.score_feedback.trim() : "";
      const xp = score >= 9 ? 25 : undefined; // matches gradeStudentDM's threshold; +25 award is idempotent
      const text = GRADE_CARD[locale](escHtml(title), score, max, escHtml(fb), xp);
      const out = await sendTelegram(BOT_TOKEN, "sendMessage", { chat_id: Number(telegramId), text, parse_mode: "HTML" }, { record: false });
      if (out.ok) {
        cardSent = true;
        // dedup marker (per attempt) + delivery heartbeat so grade_delivery_watchdog sees the APP path,
        // not just the bot's. Best-effort — never fail the response over recording.
        await admin.from("homework_submissions").update({ grade_card_notified_attempt: attempt }).eq("id", submissionId);
        await admin.from("app_settings").upsert({ key: "grade_card_dm_heartbeat", value: { last_sent_at: new Date().toISOString() } }, { onConflict: "key" });
        await logHealth(admin, uid, sub.user_id, "grade_card_dm_sent", { submission_id: submissionId, score, max, attempt }, submissionId);
      } else {
        // recipient_error (blocked/never-started) is EXPECTED reach, not a fault — the watchdog excludes it.
        await logHealth(admin, uid, sub.user_id, "grade_card_dm_failed",
          { submission_id: submissionId, error: out.error, recipient_error: out.recipient, terminal: out.terminal, score, max }, submissionId);
      }
    }

    // --- 7. VOICE note (if one was recorded this round) — unchanged behavior, now after the card. ---
    const voicePath = typeof sub.score_feedback_voice_path === "string" && sub.score_feedback_voice_path
      ? sub.score_feedback_voice_path : "";
    if (voicePath && voiceFresh) {
      const { data: signed, error: signErr } = await admin.storage.from(BUCKET).createSignedUrl(voicePath, SIGNED_TTL);
      if (signErr || !signed?.signedUrl) {
        await logHealth(admin, uid, sub.user_id, "grade_voice_dm_failed", { submission_id: submissionId, desc: `sign_failed: ${signErr?.message || "no_url"}` }, submissionId);
      } else {
        const out = await sendTelegram(BOT_TOKEN, "sendAudio",
          { chat_id: Number(telegramId), audio: signed.signedUrl, caption: VOICE_CAPTION[locale](title), title }, { record: false });
        if (out.ok) {
          voiceSent = true;
          await logHealth(admin, uid, sub.user_id, "grade_voice_dm_sent", { submission_id: submissionId }, submissionId);
        } else {
          await logHealth(admin, uid, sub.user_id, "grade_voice_dm_failed", { submission_id: submissionId, desc: out.error, recipient_error: out.recipient }, submissionId);
        }
      }
    }

    return json({ ok: true, card_sent: cardSent, voice_sent: voiceSent });
  } catch (e) {
    await logHealth(admin, uid, null, "grade_card_dm_failed", { submission_id: submissionId, desc: `error: ${String((e as any)?.message ?? e)}` }, submissionId);
    return json({ error: "unknown" }, 500);
  }
});
