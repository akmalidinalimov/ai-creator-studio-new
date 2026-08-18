// hw-image-url — resolve a homework submission's VIEWABLE image URL for the teacher Mini App.
//
// POST { submission_id: uuid }
//   -> { url: string }                      // a viewable https URL the client can put in <img>
//   -> { url: null, reason: string }         // no viewable media / degraded (graceful, HTTP 200)
//   -> { error: "forbidden" } (403)          // caller is not a teacher of the submission's group
//
// This is the C2 blocker (Teacher Mini App Phase 1, Task 2): homework captured via the Telegram bot
// is often Telegram-hosted ONLY — the media entry carries a `file_id` (and `telegram_file_id`) with
// no http url, so an <img src> can't render it. Bot-captured photos live behind the Telegram file
// API; web/miniapp uploads live in the PRIVATE `homework_images` bucket. This function resolves
// either kind into a URL a browser can load:
//   - storage-bucket path (submitted_image_url or a media[] entry that is a bucket key) -> signed URL
//   - Telegram file_id (no http url)                             -> server-side getFile -> token-free data: URL
//   - an already-http media url (e.g. an externally posted link)                        -> returned as-is
//   - nothing viewable                                                                  -> { url: null, reason }
//
// Media shapes (mirrors src/pages/Homework.tsx header + the bot capture paths in
// telegram-bot-webhook/index.ts ~5210 picker-finalize / ~5910 auto-capture):
//   - web/miniapp:      submitted_image_url = "<uid>/<file>" (bucket key), media = [{kind:"photo", url:"<uid>/<file>"}]
//                       — `url` here is the SAME bucket key, NOT http (see submit-homework/index.ts:358).
//   - bot photo/video:  submitted_image_url = null, media = [{kind, file_id, msg_url}], telegram_file_id = file_id
//   - bot link post:    media = [{kind, url:"https://…", msg_url}] — `url` IS http (an external link)
// Only `url` (never `msg_url`, which is a t.me message link) is treated as a media http source.
//
// Auth: the caller's Supabase session JWT (verify_jwt = true in supabase/config.toml — the gateway
// rejects unauthenticated calls before this code runs). The frontend obtains that session from
// tg-miniapp-auth (Telegram initData -> minted Supabase session) and then calls this like any other
// authenticated endpoint. This function NEVER touches Telegram initData itself.
//
// RBAC (junction-aware, per CLAUDE.md "teachers of a group" = groups.teacher_id ∪ group_teachers):
// the caller must be a teacher of the submission's student's group — checked via the
// is_group_teacher(_group_id,_uid) RPC (SECURITY DEFINER, live since #86) — OR a platform
// admin/superadmin. Students and unrelated teachers get 403. No URL is minted before this passes.
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

const BUCKET = "homework_images";
const SIGNED_TTL = 3600; // ~1h — long enough to grade, short enough not to be a durable leak
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // ~6 MB — homework photos are small; guards base64 blowup
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isHttp = (s: unknown): s is string => typeof s === "string" && /^https?:\/\//i.test(s);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

type MediaItem = { kind?: string; url?: string; msg_url?: string; file_id?: string };

// Incident doctrine (CLAUDE.md #5): failures must be DB-visible, not log-only, so the watchdog
// layer can see them. Best-effort + non-blocking: a failed health write must never break the actual
// response, and never carries the bot token or any resolved URL. Only real degradations are logged
// here — "no viewable media" (the student simply posted no image) is an EXPECTED outcome, not a
// failure, and a purged storage object under the 7-day retention policy is likewise expected (see
// src/pages/Homework.tsx: a signed-URL failure is deliberately not treated as an error).
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
      details: { ...details, source: "hw-image-url" },
    });
    if (error) console.error("hw-image-url logHealth insert failed", error.message);
  } catch (e) {
    console.error("hw-image-url logHealth threw", String(e));
  }
}

// image/* MIME from a Telegram file_path extension. Returns null when unknown (caller then falls
// back to the response content-type header, else image/jpeg).
function contentTypeFromPath(filePath: string): string | null {
  const ext = filePath.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "png": return "image/png";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
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
//   { tooLarge }   — file exceeds MAX_IMAGE_BYTES (caller -> reason:"image_too_large")
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
    if (declaredLen > MAX_IMAGE_BYTES) {
      try { await fileResp.body?.cancel(); } catch { /* ignore */ }
      return { tooLarge: true };
    }
    const bytes = new Uint8Array(await fileResp.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) return { tooLarge: true }; // headers can lie / be absent

    let ct = contentTypeFromPath(filePath);
    if (!ct) {
      const hdr = (fileResp.headers.get("content-type") || "").split(";")[0].trim();
      ct = hdr.startsWith("image/") ? hdr : "image/jpeg";
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
      .select("id, user_id, submitted_image_url, media, telegram_file_id")
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

    // --- 3. RBAC (junction-aware): a teacher of the student's group (groups.teacher_id ∪
    // group_teachers, via is_group_teacher) OR a platform admin/superadmin. Anyone else -> 403. ---
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

    // --- 4. Resolve a viewable URL, in precedence order. ---
    const media: MediaItem[] = Array.isArray(sub.media) ? (sub.media as MediaItem[]) : [];

    // 4a) An already-http media url (external link the student posted) is viewable as-is.
    for (const m of media) {
      if (isHttp(m?.url)) return json({ url: m.url });
    }

    // 4b) Storage path (private homework_images bucket key): submitted_image_url (non-http) or a
    // media entry whose `url` is a bucket key (miniapp/web upload) -> short-lived signed URL.
    let storagePath = "";
    if (sub.submitted_image_url && !isHttp(sub.submitted_image_url)) {
      storagePath = String(sub.submitted_image_url);
    } else {
      for (const m of media) {
        if (typeof m?.url === "string" && m.url && !isHttp(m.url)) { storagePath = m.url; break; }
      }
    }
    let triedStorage = false;
    if (storagePath) {
      triedStorage = true;
      const { data: signed, error: signErr } = await admin.storage
        .from(BUCKET).createSignedUrl(storagePath, SIGNED_TTL);
      if (!signErr && signed?.signedUrl) return json({ url: signed.signedUrl });
      // Object purged (7-day retention) or inaccessible — EXPECTED, not a health signal.
      // Fall through: a submission could carry both a bucket key AND a Telegram file_id.
    }

    // 4c) Telegram file_id (no viewable http url) -> getFile proxy URL.
    let fileId = "";
    for (const m of media) {
      if (typeof m?.file_id === "string" && m.file_id) { fileId = m.file_id; break; }
    }
    if (!fileId && typeof sub.telegram_file_id === "string" && sub.telegram_file_id) {
      fileId = sub.telegram_file_id;
    }
    if (fileId) {
      const res = await resolveTelegramFileUrl(fileId);
      if (res && "url" in res) return json({ url: res.url }); // token-free data: URL
      if (res && "tooLarge" in res) return json({ url: null, reason: "image_too_large" });
      // getFile / file fetch failed: a real degradation of the proxy path — DB-visible (no token).
      await logHealth(admin, uid, "hw_image_url_getfile_failed",
        { submission_id: submissionId, reason: "telegram_getfile_failed" }, submissionId);
      return json({ url: null, reason: "telegram_getfile_failed" });
    }

    // 4d) Nothing viewable. Distinguish a purged storage object from a truly image-less submission.
    return json({ url: null, reason: triedStorage ? "image_unavailable" : "no_viewable_media" });
  } catch (e) {
    // Unexpected failure -> DB-visible health signal (incident doctrine), best-effort, then 500.
    await logHealth(admin, uid, "hw_image_url_error",
      { submission_id: submissionId, error: String((e as any)?.message ?? e) }, submissionId);
    return json({ url: null, reason: "internal_error" }, 500);
  }
});
