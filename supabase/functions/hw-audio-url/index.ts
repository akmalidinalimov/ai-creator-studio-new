// hw-audio-url — resolve a homework submission's PLAYABLE voice-feedback URL for the student
// in-app player (Voice homework feedback, Task 4).
//
// POST { submission_id: uuid }
//   -> { url: string }                      // a playable https/data URL the client can put in <audio>
//   -> { url: null, reason: string }         // no voice feedback / degraded (graceful, HTTP 200)
//   -> { error: "forbidden" } (403)          // caller is neither the student nor a teacher/admin
//
// Teachers now leave voice feedback on a graded submission from TWO sources (see
// docs/superpowers/plans/2026-08-20-voice-homework-feedback.md):
//   - app-recorded (Task 1 storage, Task 3 upload UI): `score_feedback_voice_path`, an object key
//     "<student_user_id>/<submission_id>.mp3" inside the PRIVATE `homework-audio` bucket
//     (20260820140000_voice_feedback_storage.sql).
//   - bot-recorded (2026-07-16, `20260716140000_grade_voice_feedback.sql`): `score_feedback_voice_file_id`,
//     a Telegram file_id for a VOICE message the teacher sent the bot — no http url, only resolvable
//     server-side via Telegram's file API.
// The two columns are alternates ("whichever is set") for the same fact, not guaranteed mutually
// exclusive by any DB constraint. This function resolves the bucket path first (student's own
// storage), and falls through to the Telegram file_id if the bucket path is absent OR its signed
// URL can't be minted (e.g. purged object) — mirroring hw-image-url's storage-then-Telegram
// fallback so a submission carrying both sources still resolves.
//
// Auth: the caller's Supabase session JWT (verify_jwt = true in supabase/config.toml — the gateway
// rejects unauthenticated calls before this code runs). The frontend obtains that session the same
// way every other authenticated Mini App / web endpoint does. This function NEVER touches Telegram
// initData itself.
//
// RBAC: the caller must be the submission's own STUDENT (self), OR a teacher of the student's
// group (groups.teacher_id ∪ group_teachers, junction-aware via the is_group_teacher(_group_id,_uid)
// RPC, SECURITY DEFINER), OR a platform admin/superadmin. Anyone else gets 403. No URL is minted
// before this passes.
//
// SECURITY (bot-token containment): a Telegram file URL embeds the BOT TOKEN
// (https://api.telegram.org/file/bot<token>/<path>) — that is how Telegram serves files — and the
// bot token controls the ENTIRE bot, so it must NEVER leave the server. This function therefore
// fetches the Telegram file SERVER-SIDE (the token stays inside the function) and returns a
// token-free `data:<mime>;base64,<bytes>` URL in the same `{ url }` field. The client never sees the
// token in any form (no network URL, no history, no screenshare). The token is also never logged
// (not to console, not to admin_actions). A ~6 MB size guard prevents a pathological base64 blowup.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BUCKET = "homework-audio";
const SIGNED_TTL = 3600; // ~1h — long enough to listen/replay, short enough not to be a durable leak
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const MAX_AUDIO_BYTES = 6 * 1024 * 1024; // ~6 MB — voice notes are small; guards base64 blowup
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Incident doctrine (CLAUDE.md #5): failures must be DB-visible, not log-only, so the watchdog
// layer can see them. Best-effort + non-blocking: a failed health write must never break the actual
// response, and never carries the bot token or any resolved URL. Only real degradations are logged
// here — "no voice feedback exists" (the teacher simply left none) is an EXPECTED outcome, not a
// failure, and a purged storage object under retention is likewise expected (mirrors hw-image-url).
async function logHealth(
  admin: any,
  actorUserId: string | null,
  action: string,
  details: Record<string, unknown>,
  submissionId: string | null,
) {
  try {
    const { error } = await admin.from("admin_actions").insert({
      actor_user_id: actorUserId,
      action,
      target_user_id: null,
      target_resource_type: "homework_submission",
      target_resource_id: submissionId,
      details: { ...details, source: "hw-audio-url" },
    });
    if (error) console.error("hw-audio-url logHealth insert failed", error.message);
  } catch (e) {
    console.error("hw-audio-url logHealth threw", String(e));
  }
}

// audio/* MIME from a Telegram file_path extension. Returns null when unknown (caller then falls
// back to the response content-type header if it's audio/*, else audio/ogg — Telegram voice notes
// are ogg/opus).
function contentTypeFromPath(filePath: string): string | null {
  const ext = filePath.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case "oga":
    case "ogg": return "audio/ogg";
    case "mp3": return "audio/mpeg";
    case "m4a":
    case "mp4": return "audio/mp4";
    case "wav": return "audio/wav";
    default: return null;
  }
}

// Base64-encode bytes in chunks — a single String.fromCharCode(...wholeArray) spread blows the call
// stack on large inputs. 0x8000 keeps each spread well under the argument-count limit.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Resolve a Telegram file_id -> a token-free data: URL by fetching the file SERVER-SIDE. The bot
// token is used only inside this function (getFile + the file fetch) and NEVER appears in the return
// value or any log. Returns:
//   { url }        — a `data:<mime>;base64,<bytes>` URL
//   { tooLarge }   — file exceeds MAX_AUDIO_BYTES (caller -> reason:"audio_too_large")
//   null           — any failure (bot token missing, getFile !ok, no file_path, fetch !ok)
type TgResolve = { url: string } | { tooLarge: true } | null;
async function resolveTelegramFileUrl(fileId: string): Promise<TgResolve> {
  if (!BOT_TOKEN) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const filePath = j && j.ok ? j?.result?.file_path : null;
    if (!filePath || typeof filePath !== "string") return null;

    // Fetch the bytes here — the token-bearing URL is built and consumed server-side only.
    const fileResp = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
    if (!fileResp.ok) {
      try { await fileResp.body?.cancel(); } catch { /* ignore */ }
      return null;
    }
    // Cheap pre-check on the declared length before buffering the whole body.
    const declaredLen = Number(fileResp.headers.get("content-length") || "0");
    if (declaredLen > MAX_AUDIO_BYTES) {
      try { await fileResp.body?.cancel(); } catch { /* ignore */ }
      return { tooLarge: true };
    }
    const bytes = new Uint8Array(await fileResp.arrayBuffer());
    if (bytes.length > MAX_AUDIO_BYTES) return { tooLarge: true }; // headers can lie / be absent

    let ct = contentTypeFromPath(filePath);
    if (!ct) {
      const hdr = (fileResp.headers.get("content-type") || "").split(";")[0].trim();
      ct = hdr.startsWith("audio/") ? hdr : "audio/ogg";
    }
    return { url: `data:${ct};base64,${bytesToBase64(bytes)}` };
  } catch {
    return null;
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
  if (!UUID_RE.test(submissionId)) return json({ error: "invalid_submission_id" }, 400);

  try {
    // --- 2. Load the submission (service role bypasses RLS) + the student's group. ---
    const { data: sub, error: subErr } = await admin
      .from("homework_submissions")
      .select("id, user_id, score_feedback_voice_path, score_feedback_voice_file_id")
      .eq("id", submissionId)
      .maybeSingle();
    if (subErr) throw subErr;
    if (!sub) return json({ url: null, reason: "submission_not_found" }, 404);

    const { data: prof, error: profErr } = await admin
      .from("profiles")
      .select("group_id")
      .eq("id", sub.user_id)
      .maybeSingle();
    if (profErr) throw profErr;
    const groupId: string | null = prof?.group_id ?? null;

    // --- 3. RBAC: the submission's own student (self) OR a junction-aware teacher of the
    // student's group (groups.teacher_id ∪ group_teachers, via is_group_teacher) OR a platform
    // admin/superadmin. Anyone else -> 403. ---
    let allowed = sub.user_id === uid;
    if (!allowed && groupId) {
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

    // --- 4. Resolve a playable URL, in precedence order: app-recorded storage object first
    // (score_feedback_voice_path), then bot-captured Telegram voice note (score_feedback_voice_file_id),
    // else no voice feedback exists. A purged/inaccessible storage object is not a hard failure —
    // fall through to a Telegram file_id if the submission also carries one (see header comment). ---
    let triedStorage = false;
    const voicePath = typeof sub.score_feedback_voice_path === "string" && sub.score_feedback_voice_path
      ? sub.score_feedback_voice_path
      : "";
    if (voicePath) {
      triedStorage = true;
      const { data: signed, error: signErr } = await admin.storage
        .from(BUCKET).createSignedUrl(voicePath, SIGNED_TTL);
      if (!signErr && signed?.signedUrl) return json({ url: signed.signedUrl });
      // Object purged or inaccessible — EXPECTED, not a health signal on its own. Fall through: a
      // submission could carry both a bucket path AND a Telegram file_id.
    }

    // 4b) Telegram file_id -> server-side getFile -> token-free data: URL.
    const fileId = typeof sub.score_feedback_voice_file_id === "string" && sub.score_feedback_voice_file_id
      ? sub.score_feedback_voice_file_id
      : "";
    if (fileId) {
      const res = await resolveTelegramFileUrl(fileId);
      if (res && "url" in res) return json({ url: res.url }); // token-free data: URL
      if (res && "tooLarge" in res) return json({ url: null, reason: "audio_too_large" });
      // getFile / file fetch failed: a real degradation of the proxy path — DB-visible (no token).
      await logHealth(admin, uid, "hw_audio_resolve_degraded",
        { submission_id: submissionId, reason: "telegram_getfile_failed" }, submissionId);
      return json({ url: null, reason: "telegram_getfile_failed" });
    }

    // 4c) Nothing to resolve. A purged storage object vs. a submission with no voice feedback at
    // all — distinct reasons so the client can message each correctly. Neither is a health signal.
    return json({ url: null, reason: triedStorage ? "audio_unavailable" : "no_voice" });
  } catch (e) {
    // Unexpected failure -> DB-visible health signal (incident doctrine), best-effort, then 500.
    await logHealth(admin, uid, "hw_audio_url_error",
      { submission_id: submissionId, error: String((e as any)?.message ?? e) }, submissionId);
    return json({ url: null, reason: "internal_error" }, 500);
  }
});
