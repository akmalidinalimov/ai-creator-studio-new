// notify-grade-voice — push an app-recorded voice feedback note to the student as a Telegram
// audio DM (Voice homework feedback, Task 6 — the final task of the feature).
//
// POST { submission_id: uuid }
//   -> { ok:true, sent:true }                          // DM sent, health row logged
//   -> { ok:true, sent:false, reason:"no_voice" }       // no score_feedback_voice_path on the row
//   -> { ok:true, sent:false, reason:"no_telegram" }    // student never started the bot (~70%)
//   -> { ok:true, sent:false, reason:"..." }            // signed-URL / Telegram send failure (graceful)
//   -> { error:"unauthorized" } (401) / { error:"forbidden" } (403) / { error:"submission_id required" } (400)
//
// Task 3 uploads the teacher's MP3 to the PRIVATE `homework-audio` bucket
// (<student_user_id>/<submission_id>.mp3, 20260820140000_voice_feedback_storage.sql) and sets
// `score_feedback_voice_path` on the submission. Task 5's in-app player (hw-audio-url) covers every
// student who opens the app; THIS function additionally reaches the subset who have started the bot
// on Telegram, proactively, at grade time — a NEW push, scoped to voice only (app grades otherwise
// send no DM today; the bot's OWN grading flow already DMs via gradeStudentDM/sendVoice and is
// untouched by this function).
//
// Auth: the caller's Supabase session JWT (verify_jwt = true in supabase/config.toml).
//
// RBAC (gate it — this triggers a DM to a student): the caller must be a teacher of the
// submission's student's group (groups.teacher_id ∪ group_teachers, junction-aware via the
// is_group_teacher(_group_id,_uid) RPC, SECURITY DEFINER) OR a platform admin/superadmin. Mirrors
// hw-image-url's gate shape MINUS the student-self branch — a student must never be able to trigger
// their own grade DM (that would let them re-trigger a push at will, and it's simply not their action
// to take). Anyone else gets 403, no signed URL is ever minted.
//
// SECURITY (bot-token containment): the bot token is read from TELEGRAM_BOT_TOKEN and used ONLY
// inside this function's Telegram fetch call. It is never returned to the client, never embedded in
// the signed audio URL (that's a Supabase Storage signed URL, no Telegram token involved), and never
// logged (not to console, not to admin_actions).
//
// Member-forgiveness (CLAUDE.md): a student who never pressed Start on the bot has no telegram_id —
// EXPECTED for ~70% of students, not a failure, so it's a graceful `sent:false` with HTTP 200. A
// blocked bot / chat-not-found Telegram response is likewise graceful (the student blocked the bot or
// deleted their account) — never a hard error, never thrown. Every outcome is DB-visible via
// logHealth so the watchdog layer can see real degradations vs. expected no-sends (only the FAILURE
// path — genuinely blocked/errored sends — is logged; "no_voice"/"no_telegram" are simply expected
// and not logged, mirroring hw-image-url/hw-audio-url's convention of only logging real degradations).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BUCKET = "homework-audio";
const SIGNED_TTL = 600; // ~10 min — Telegram fetches the URL itself right after this call returns
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

const CAPTION: Record<Locale, (title: string) => string> = {
  uz: (title) => `🎧 "${title}" bo'yicha yangi ovozli izoh — balingizni ko'rish uchun ilovani oching.`,
  ru: (title) => `🎧 Новый голосовой комментарий к "${title}" — откройте приложение, чтобы увидеть оценку.`,
  en: (title) => `🎧 New voice feedback on "${title}" — open the app for your score.`,
};

// Fix round 1 (Minor): a titleless assignment used a hardcoded Uzbek fallback regardless of the
// student's locale, so a ru/en student could get an Uzbek word inside an otherwise-localized
// caption. Keyed off the same Locale used for CAPTION so both stay in sync.
const TITLE_FALLBACK: Record<Locale, string> = {
  uz: "Uy vazifasi",
  ru: "Домашнее задание",
  en: "Homework",
};

// Incident doctrine (CLAUDE.md #5): failures must be DB-visible, not log-only, so the watchdog layer
// can see them. Best-effort + non-blocking: a failed health write must never break the actual
// response, and never carries the bot token or the signed audio URL.
async function logHealth(
  admin: any,
  actorUserId: string | null,
  studentUserId: string | null,
  action: string,
  details: Record<string, unknown>,
  submissionId: string | null,
) {
  try {
    const { error } = await admin.from("admin_actions").insert({
      actor_user_id: actorUserId,
      action,
      target_user_id: studentUserId,
      target_resource_type: "homework_submission",
      target_resource_id: submissionId,
      details: { ...details, source: "notify-grade-voice" },
    });
    if (error) console.error("notify-grade-voice logHealth insert failed", error.message);
  } catch (e) {
    console.error("notify-grade-voice logHealth threw", String(e));
  }
}

// Telegram sendAudio: the file lives in our private storage bucket, so we hand Telegram a
// short-lived SIGNED HTTPS URL and let Telegram fetch the bytes itself (no proxying through this
// function, no bot-token leak — the signed URL carries a Supabase Storage token, never the bot's).
async function sendAudio(
  chatId: number,
  audioUrl: string,
  caption: string,
  title: string,
): Promise<{ ok: true } | { ok: false; description: string }> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, audio: audioUrl, caption, title }),
    });
    const j: any = await resp.json().catch(() => null);
    if (resp.ok && j?.ok) return { ok: true };
    return { ok: false, description: String(j?.description || `http_${resp.status}`) };
  } catch (e) {
    return { ok: false, description: String((e as any)?.message ?? e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // --- 1. Auth: resolve the caller from their JWT (never log the JWT). verify_jwt=true means the
  // gateway already rejected anonymous callers, but we still need auth.uid() for RBAC. ---
  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!jwt) return json({ error: "unauthorized" }, 401);
  const { data: userData, error: authErr } = await admin.auth.getUser(jwt);
  if (authErr || !userData?.user) return json({ error: "unauthorized" }, 401);
  const uid = userData.user.id;

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const submissionId = String(body?.submission_id || "").trim();
  if (!submissionId) return json({ error: "submission_id required" }, 400);
  if (!UUID_RE.test(submissionId)) return json({ error: "submission_id required" }, 400);

  try {
    // --- 2. Load the submission + the student's group. ---
    const { data: sub, error: subErr } = await admin
      .from("homework_submissions")
      .select("id, user_id, assignment_id, score_feedback_voice_path")
      .eq("id", submissionId)
      .maybeSingle();
    if (subErr) throw subErr;
    if (!sub) return json({ ok: true, sent: false, reason: "submission_not_found" });

    const { data: prof, error: profErr } = await admin
      .from("profiles")
      .select("group_id")
      .eq("id", sub.user_id)
      .maybeSingle();
    if (profErr) throw profErr;
    const groupId: string | null = prof?.group_id ?? null;

    // --- 3. RBAC (junction-aware, no student-self branch): a teacher of the student's group
    // (groups.teacher_id ∪ group_teachers, via is_group_teacher) OR a platform admin/superadmin.
    // Anyone else — including the student themself — gets 403. No signed URL, no DM is sent before
    // this passes. ---
    let allowed = false;
    if (groupId) {
      const { data: isTeacher, error: itErr } = await admin
        .rpc("is_group_teacher", { _group_id: groupId, _uid: uid });
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

    // --- 4. Graceful no-sends (HTTP 200, member-forgiveness convention — neither is a failure). ---
    const voicePath = typeof sub.score_feedback_voice_path === "string" && sub.score_feedback_voice_path
      ? sub.score_feedback_voice_path
      : "";
    if (!voicePath) return json({ ok: true, sent: false, reason: "no_voice" });

    const { data: student, error: stuErr } = await admin
      .from("profiles")
      .select("telegram_id, preferred_locale")
      .eq("id", sub.user_id)
      .maybeSingle();
    if (stuErr) throw stuErr;
    const telegramId = student?.telegram_id ?? null;
    if (!telegramId) return json({ ok: true, sent: false, reason: "no_telegram" }); // ~70% never started the bot
    const locale = normLocale(student?.preferred_locale);

    // --- 5. Assignment title (best-effort — a missing title still lets the DM go out, just with a
    // locale-appropriate fallback word instead of the assignment name). ---
    const { data: assignment } = await admin
      .from("homework_assignments")
      .select("title")
      .eq("id", sub.assignment_id)
      .maybeSingle();
    const title = (assignment?.title && String(assignment.title).trim()) || TITLE_FALLBACK[locale];

    // --- 6. Sign a short-lived URL for the private homework-audio object; Telegram fetches it. ---
    const { data: signed, error: signErr } = await admin.storage
      .from(BUCKET).createSignedUrl(voicePath, SIGNED_TTL);
    if (signErr || !signed?.signedUrl) {
      await logHealth(admin, uid, sub.user_id, "grade_voice_dm_failed",
        { submission_id: submissionId, desc: `sign_failed: ${signErr?.message || "no_url"}` }, submissionId);
      return json({ ok: true, sent: false, reason: "sign_failed" });
    }

    if (!BOT_TOKEN) {
      await logHealth(admin, uid, sub.user_id, "grade_voice_dm_failed",
        { submission_id: submissionId, desc: "bot_token_missing" }, submissionId);
      return json({ ok: true, sent: false, reason: "bot_token_missing" });
    }

    // --- 7. Send. A blocked bot / never-started chat is a Telegram-level `ok:false` — graceful, not
    // a hard error (member-forgiveness): the student simply won't get this DM, the in-app player
    // (Task 5) still covers them. ---
    const caption = CAPTION[locale](title);
    const result = await sendAudio(Number(telegramId), signed.signedUrl, caption, title);
    if (result.ok) {
      await logHealth(admin, uid, sub.user_id, "grade_voice_dm_sent", { submission_id: submissionId }, submissionId);
      return json({ ok: true, sent: true });
    }
    await logHealth(admin, uid, sub.user_id, "grade_voice_dm_failed",
      { submission_id: submissionId, desc: result.description }, submissionId);
    return json({ ok: true, sent: false, reason: "telegram_send_failed" });
  } catch (e) {
    // Unexpected failure -> DB-visible health signal (incident doctrine), best-effort, then 500.
    await logHealth(admin, uid, null, "grade_voice_dm_failed",
      { submission_id: submissionId, desc: `error: ${String((e as any)?.message ?? e)}` }, submissionId);
    return json({ error: "unknown" }, 500);
  }
});
