// hw-image-url — resolve a homework submission's VIEWABLE media for the teacher grading UI.
//
// Two modes, both authenticated (verify_jwt=true) + junction-aware RBAC (teacher-of-group ∪ admin):
//
//   A) POST { submission_id }            -> { items: ResolvedItem[] }   // metadata for the whole gallery
//   B) POST { submission_id, index }     -> raw media BYTES (streamed, Content-Type set)   // one item
//                                        -> { reason }  (application/json)  when it can't be inlined
//   -> { error: "forbidden" } (403)      // caller is not a teacher of the submission's group / not admin
//
// WHY BOTH MODES: homework is photo | video | document | link (20260707020000_homework_multimedia.sql;
// the webhook tags `kind`). The Telegram-captured majority (video + document — the most common types
// now) carries only a `file_id`, so an <img> / <video src> can't load it directly. Historically this
// endpoint resolved ONLY images (kind==="photo") and returned "non_image_media" for everything else,
// which meant teachers could not view video/document homework in the app at all. It now resolves EVERY
// kind:
//   - mode A returns, per media item, either a directly-loadable https `url` (signed storage URL or an
//     external link) or `fetchable:true` (a Telegram file the client streams via mode B), plus its
//     `kind` and a per-item `msg_url` Telegram fallback.
//   - mode B streams the Telegram file's raw bytes so the client can play `<video>` / show `<img>` /
//     open a document from an object URL — no base64 blowup, and the video seeks once loaded.
// buildItems() is shared by both modes so item indices are stable between the metadata call and the
// byte-fetch call.
//
// SECURITY (bot-token containment — unchanged, extended to bytes): a Telegram file URL embeds the BOT
// TOKEN (https://api.telegram.org/file/bot<token>/<path>), which controls the whole bot, so it must
// NEVER leave the server. Mode B fetches the file SERVER-SIDE and streams the response body straight
// through to the client — the token stays inside the function, appears in no URL / header / log, and
// the client only ever receives the raw media bytes. Telegram's Bot API getFile can only download
// files up to ~20MB; anything larger returns { reason: "media_too_large" } and the client falls back
// to opening the original message in Telegram (which streams any size natively).
//
// Auth: the caller's Supabase session JWT (from tg-miniapp-auth). RBAC via is_group_teacher (junction-
// aware, groups.teacher_id ∪ group_teachers) OR platform admin/superadmin. Students / unrelated
// teachers get 403 in both modes; no URL is signed and no byte is streamed before RBAC passes.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // Lets the client read the byte-vs-control marker even if the response is treated as cross-origin.
  "Access-Control-Expose-Headers": "X-Hw-Media-Bytes",
};

const BUCKET = "homework_images";
const SIGNED_TTL = 3600; // ~1h — long enough to grade, short enough not to be a durable leak
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const MAX_MEDIA_BYTES = 20 * 1024 * 1024; // Telegram Bot API getFile ceiling. Above it -> Telegram fallback.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isHttp = (s: unknown): s is string => typeof s === "string" && /^https?:\/\//i.test(s);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

type MediaItem = { kind?: string; url?: string; msg_url?: string; file_id?: string };
// The normalized, ordered list of resolvable pieces. Both modes derive it identically so `index` is stable.
type SrcItem = { kind: string; storagePath?: string; httpUrl?: string; fileId?: string; msg_url?: string };

// Incident doctrine (CLAUDE.md #5): real failures are DB-visible, not log-only. Best-effort +
// non-blocking; never carries the bot token or resolved bytes.
async function logHealth(admin: any, actorUserId: string | null, action: string, details: Record<string, unknown>, submissionId: string | null) {
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

// MIME from a Telegram file_path extension (image / video / document / audio). null -> caller falls
// back to the fetch response's content-type header, else application/octet-stream.
function contentTypeFromPath(filePath: string): string | null {
  const ext = filePath.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case "jpg": case "jpeg": return "image/jpeg";
    case "png": return "image/png";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "heic": return "image/heic";
    case "mp4": return "video/mp4";
    case "mov": return "video/quicktime";
    case "m4v": return "video/x-m4v";
    case "webm": return "video/webm";
    case "3gp": return "video/3gpp";
    case "avi": return "video/x-msvideo";
    case "mkv": return "video/x-matroska";
    case "pdf": return "application/pdf";
    case "txt": return "text/plain; charset=utf-8";
    case "json": return "application/json";
    case "zip": return "application/zip";
    case "doc": return "application/msword";
    case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xls": return "application/vnd.ms-excel";
    case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "ppt": return "application/vnd.ms-powerpoint";
    case "pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "mp3": return "audio/mpeg";
    case "ogg": case "oga": return "audio/ogg";
    case "m4a": return "audio/mp4";
    default: return null;
  }
}

// Ordered, resolvable media for a submission. Prefer the media[] array (current path); fall back to the
// legacy scalar columns for old rows that predate media[]. Only pieces with a real source are kept.
function buildItems(sub: any): SrcItem[] {
  const media: MediaItem[] = Array.isArray(sub.media) ? (sub.media as MediaItem[]) : [];
  const items: SrcItem[] = [];
  if (media.length) {
    for (const m of media) {
      const kind = (typeof m?.kind === "string" && m.kind) ? m.kind : "photo";
      const it: SrcItem = { kind, msg_url: typeof m?.msg_url === "string" ? m.msg_url : undefined };
      if (isHttp(m?.url)) it.httpUrl = m!.url;                                   // external link / already-http image
      else if (typeof m?.url === "string" && m.url) it.storagePath = m.url;      // private bucket key
      if (typeof m?.file_id === "string" && m.file_id) it.fileId = m.file_id;    // Telegram file
      if (it.httpUrl || it.storagePath || it.fileId) items.push(it);
    }
  } else {
    if (typeof sub.submitted_image_url === "string" && sub.submitted_image_url) {
      if (isHttp(sub.submitted_image_url)) items.push({ kind: "photo", httpUrl: sub.submitted_image_url });
      else items.push({ kind: "photo", storagePath: sub.submitted_image_url });
    }
    if (typeof sub.telegram_file_id === "string" && sub.telegram_file_id) {
      const kind = (typeof sub.telegram_file_kind === "string" && sub.telegram_file_kind) ? sub.telegram_file_kind : "photo";
      items.push({ kind, fileId: sub.telegram_file_id, msg_url: typeof sub.telegram_message_url === "string" ? sub.telegram_message_url : undefined });
    }
  }
  return items;
}

// Junction-aware RBAC: teacher of the student's group (is_group_teacher) OR platform admin/superadmin.
async function callerMayView(admin: any, uid: string, studentId: string): Promise<boolean> {
  const { data: prof, error: profErr } = await admin.from("profiles").select("group_id").eq("id", studentId).maybeSingle();
  if (profErr) throw profErr;
  const groupId: string | null = prof?.group_id ?? null;
  if (groupId) {
    const { data: isTeacher, error: itErr } = await admin.rpc("is_group_teacher", { _group_id: groupId, _uid: uid });
    if (itErr) throw itErr;
    if (isTeacher === true) return true;
  }
  const { data: roles, error: rErr } = await admin.from("user_roles").select("role").eq("user_id", uid).in("role", ["admin", "superadmin"]);
  if (rErr) throw rErr;
  return !!roles?.length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // --- Auth: resolve the caller from their JWT (never logged). ---
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
  const rawIndex = body?.index;
  const isRaw = Number.isInteger(rawIndex) && rawIndex >= 0; // mode B when a valid index is present

  try {
    // --- Load the submission + RBAC (service role bypasses RLS). ---
    const { data: sub, error: subErr } = await admin
      .from("homework_submissions")
      .select("id, user_id, submitted_image_url, media, telegram_file_id, telegram_file_kind, telegram_message_url")
      .eq("id", submissionId)
      .maybeSingle();
    if (subErr) throw subErr;
    if (!sub) return isRaw ? json({ reason: "submission_not_found" }, 404) : json({ items: [], reason: "submission_not_found" }, 404);

    const allowed = await callerMayView(admin, uid, sub.user_id);
    if (!allowed) return json({ error: "forbidden" }, 403);

    const items = buildItems(sub);

    // ================= MODE B: stream the raw bytes of one item =================
    // A real getFile failure (revoked token, rate-limit, stale file_id) must be DB-visible via
    // logHealth (incident-doctrine health-signal rule) and reported as telegram_getfile_failed — NOT
    // silently mislabeled "too large". Only a genuine >20MB file returns media_too_large (expected;
    // the client falls back to Telegram, which streams any size). Both Telegram fetches sit inside
    // local try/catch so a thrown exception from a token-bearing URL can never reach the outer catch's
    // String(e.message) logging path (bot-token containment, defense-in-depth).
    if (isRaw) {
      const it = items[rawIndex as number];
      if (!it || !it.fileId) return json({ reason: "no_viewable_media" }); // storage/link items aren't fetched here

      const failGetFile = async (why: string, extra: Record<string, unknown> = {}) => {
        await logHealth(admin, uid, "hw_media_getfile_failed",
          { submission_id: submissionId, index: rawIndex, reason: why, ...extra }, submissionId);
        return json({ reason: "telegram_getfile_failed" });
      };

      if (!BOT_TOKEN) return await failGetFile("bot_token_missing");

      let gj: any = null;
      try {
        const gf = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file_id: it.fileId }),
        });
        gj = await gf.json().catch(() => null);
      } catch {
        return await failGetFile("getfile_fetch_threw"); // never surface the token-bearing URL/exception
      }
      const filePath = gj && gj.ok ? gj?.result?.file_path : null;
      const fileSize = gj?.result?.file_size;
      if (!filePath || typeof filePath !== "string") {
        // Distinguish "file too big" (>20MB — expected) from a real getFile failure by the description.
        const desc = String(gj?.description || "").toLowerCase();
        if (desc.includes("too big") || desc.includes("too large")) return json({ reason: "media_too_large" });
        return await failGetFile("getfile_not_ok", { code: gj?.error_code ?? null });
      }
      if (typeof fileSize === "number" && fileSize > MAX_MEDIA_BYTES) return json({ reason: "media_too_large" });

      let fr: Response;
      try {
        fr = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
      } catch {
        return await failGetFile("file_fetch_threw"); // never surface the token-bearing URL/exception
      }
      if (!fr.ok || !fr.body) {
        try { await fr.body?.cancel(); } catch { /* ignore */ }
        return await failGetFile("file_fetch_not_ok", { status: fr.status });
      }
      const declaredLen = Number(fr.headers.get("content-length") || "0");
      if (declaredLen > MAX_MEDIA_BYTES) {
        try { await fr.body.cancel(); } catch { /* ignore */ }
        return json({ reason: "media_too_large" });
      }
      let ct = contentTypeFromPath(filePath);
      if (!ct) {
        const hdr = (fr.headers.get("content-type") || "").split(";")[0].trim();
        ct = hdr || "application/octet-stream";
      }
      const filename = (filePath.split("/").pop() || "homework").replace(/[^\w.\-]+/g, "_");
      // Stream Telegram's body straight through — the token-bearing URL is consumed server-side only.
      // No post-download byte cap here (unlike the old base64 path): intentional streaming tradeoff,
      // bounded by both the file_size + content-length checks above and Telegram's own ~20MB ceiling.
      // X-Hw-Media-Bytes marks this as raw bytes so the client never confuses a real application/json
      // homework document with a { reason } control message.
      const headers: Record<string, string> = {
        ...corsHeaders,
        "Content-Type": ct,
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        "X-Hw-Media-Bytes": "1",
      };
      if (declaredLen) headers["Content-Length"] = String(declaredLen);
      return new Response(fr.body, { status: 200, headers });
    }

    // ================= MODE A: metadata for the whole gallery =================
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.httpUrl) { out.push({ index: i, kind: it.kind, url: it.httpUrl, msg_url: it.msg_url }); continue; }
      if (it.storagePath) {
        const { data: signed, error: signErr } = await admin.storage.from(BUCKET).createSignedUrl(it.storagePath, SIGNED_TTL);
        if (!signErr && signed?.signedUrl) out.push({ index: i, kind: it.kind, url: signed.signedUrl, msg_url: it.msg_url });
        else out.push({ index: i, kind: it.kind, reason: "image_unavailable", msg_url: it.msg_url }); // purged (7-day retention) — expected
        continue;
      }
      if (it.fileId) { out.push({ index: i, kind: it.kind, fetchable: true, msg_url: it.msg_url }); continue; }
    }
    return json({ items: out });
  } catch (e) {
    await logHealth(admin, uid, "hw_image_url_error", { submission_id: submissionId, mode: isRaw ? "raw" : "meta", error: String((e as any)?.message ?? e) }, submissionId);
    return isRaw ? json({ reason: "internal_error" }, 500) : json({ items: [], reason: "internal_error" }, 500);
  }
});
