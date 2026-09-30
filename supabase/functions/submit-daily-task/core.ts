// submit-daily-task — the Mini App's «Kunlik vazifalar» submission (Challenge 6.0 Daily Tasks PR-7, spec §12 / G12 / G28).
//
// Everything that decides lives in the SQL engine (PR-3, spec I1): challenge_task_prepare_miniapp says whether this
// student may submit for this task right now, challenge_task_submit_claim takes the request claim (its time IS the
// submission time, G28), challenge_task_capture_miniapp attributes / evaluates / settles. This module only:
//   1. validates the upload (sizes, counts, the task's accepted kinds) BEFORE anything is posted;
//   2. reposts the files + text into the student's OWN group's «Kunlik vazifalar» topic AS THE BOT, with a plain
//      (no parse_mode) caption that names the student — Telegram has no "post as user" API for a Mini App;
//   3. records what it posted (challenge_task_submit_record → claim state 'posted'), so the reconciler's Mini App heal
//      finishes a capture this function could not (I4), then captures it.
//
// The chat and thread come from prepare_miniapp's topic, which reads challenge_task_topics() by the STUDENT'S group:
// (daily_task_chat_id, daily_task_topic_id) — never a topic id alone (thread 10 exists in both 5- and 6-GURUH).
//
// THE CAPTURE VIEW. The engine classifies what it is given (challenge_task_classify): a caption is text, and text
// counts toward a task's min_text_chars. Our header ("📱 Ali Valiyev …") is ~60 characters, so capturing the posted
// Message as-is would satisfy a "screenshot + text" task with no text from the student. captureView() therefore
// hands the engine each posted Message with the header REMOVED: the student's own text on the message that carried
// it, no text anywhere else. What the class sees in the topic and what the engine judges differ only by our header.
//
// Idempotency (request_id, chosen by the client once per form and reused on a retry of the same form):
//   claim new       → post, record, capture
//   'posted'        → the earlier request posted but did not capture: capture its recorded items (no repost)
//   'captured'      → answer the capture again ('duplicate'), no repost
//   'claimed'       → another request is posting (409 in_progress); older than CLAIM_STALE_MS = it died → take over
//   'failed'        → nothing was posted (a Telegram error): a retry takes the claim back and posts, KEEPING the
//                     original claim time (so a 23:59 submission that hit a 429 stays on time); a capture refusal
//                     ('not_allowed') is final
//   'abandoned'     → the reconciler gave up on it: 409 expired (the client starts a new request)
// Both take-overs are compare-and-set on (state, updated_at), so two retries cannot both post.
//
// Graceful is not silent: every refusal, partial post and failed step is an admin_actions row (logHealth /
// logHealthOnce, or the SQL side's own 'challenge_task_miniapp_post_failed' / 'challenge_task_miniapp_refused');
// claims stuck in 'posted' / 'failed' are counted by challenge_tasks_health().miniapp.
//
// Impersonation (G12): an admin previewing as a student holds that student's real session (admin-impersonate mints a
// magic link), so the server cannot tell; the Mini App gates the submit on impersonatingReadonly() and never calls
// this function then (an expected no-op, never beaconed). The prepare mode is read-only and stays allowed.

import { formatTaskDate } from "../_shared/daily-task-render.ts";
import type { MediaGroupItem, MultipartFile, SendResultOutcome } from "../_shared/telegram-send.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** The PostgREST-shaped subset of the service-role client this module uses (a fake in tests, PGlite in the harness). */
export interface Db {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: Any; error: Any }>;
  from(table: string): Any;
}

export type SendResult = { outcome: SendResultOutcome; result: Any };

/** The three ways a part reaches the topic. The real one wraps _shared/telegram-send.ts with the bot token. */
export interface Poster {
  text(fields: Record<string, unknown>): Promise<SendResult>;
  single(method: "sendPhoto" | "sendVideo" | "sendDocument", fields: Record<string, string | number>, file: MultipartFile): Promise<SendResult>;
  album(fields: Record<string, string | number>, items: MediaGroupItem[]): Promise<{ outcome: SendResultOutcome; result: Any[] | null }>;
}

export interface Deps {
  admin: Db;
  poster: Poster;
  /** logHealth / logHealthOnce from _shared/edge.ts (injected so tests can record them). */
  health(action: string, details: Record<string, unknown>, userId: string): Promise<void>;
  healthOnce(action: string, dedupeKey: string, details: Record<string, unknown>, userId: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

// ── limits: Telegram's BOT upload ceilings (hard) and what one edge request may buffer ──
export const MAX_ITEMS = 10;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 50 * 1024 * 1024; // sendVideo / sendDocument by a bot
export const MAX_TOTAL_BYTES = 150 * 1024 * 1024;
export const MAX_TEXT = 3500; // + the header stays under sendMessage's 4096
export const CAPTION_MAX = 1024; // Telegram's caption limit (UTF-16 units = String.length)
export const CLAIM_STALE_MS = 7 * 60_000; // longer than any edge wall clock: a 'claimed' row this old is dead
export const RATE_LIMIT_WAIT_MAX_SEC = 20; // a 429 with a short retry_after is waited out inside the request
export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export type FileKind = "photo" | "video" | "document";
export interface InFile {
  kind: FileKind;
  blob: Blob;
  name: string;
  size: number;
  mime: string;
}

/** sendPhoto takes JPEG / PNG / WebP; any other image (HEIC, GIF, …) goes as a document (the engine calls it image_doc). */
export function fileKindOf(mime: string): FileKind {
  const m = String(mime || "").toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg" || m === "image/png" || m === "image/webp") return "photo";
  if (m === "video/mp4" || m === "video/quicktime" || m === "video/webm" || m === "video/3gpp" || m === "video/x-m4v") return "video";
  return "document";
}

/** A file's kind in the task's `accepts` vocabulary: an image or video sent as a document is a 'document' there too. */
export function acceptsFile(accepts: string[], f: Pick<InFile, "kind" | "mime">): boolean {
  const a = new Set(accepts);
  if (f.kind === "photo") return a.has("photo") || a.has("document");
  if (f.kind === "video") return a.has("video") || a.has("document");
  if (a.has("document")) return true;
  const m = f.mime.toLowerCase();
  if (m.startsWith("image/")) return a.has("photo");
  if (m.startsWith("video/")) return a.has("video");
  if (m.startsWith("audio/")) return a.has("audio") || a.has("voice");
  return false;
}

export function acceptsText(accepts: string[]): boolean {
  return accepts.includes("text") || accepts.includes("link");
}

export type SubmitInput = { taskId: number; requestId: string; text: string; files: InFile[] };

/** Validate the parsed form. null = fine; else the error code (and its details) for a 400/413. */
export function validateInput(i: SubmitInput): { error: string; status: number; details?: Record<string, unknown> } | null {
  if (!Number.isSafeInteger(i.taskId) || i.taskId <= 0) return { error: "bad_task_id", status: 400 };
  if (!REQUEST_ID_RE.test(i.requestId)) return { error: "bad_request_id", status: 400 };
  if (i.text.length > MAX_TEXT) return { error: "text_too_long", status: 400, details: { max: MAX_TEXT } };
  if (i.files.length === 0 && i.text.trim() === "") return { error: "empty", status: 400 };
  if (i.files.length > MAX_ITEMS) return { error: "too_many_files", status: 400, details: { max: MAX_ITEMS } };
  for (const f of i.files) {
    const cap = f.kind === "photo" ? MAX_PHOTO_BYTES : MAX_FILE_BYTES;
    if (f.size <= 0) return { error: "empty_file", status: 400 };
    if (f.size > cap) return { error: "file_too_large", status: 413, details: { kind: f.kind, max_bytes: cap } };
  }
  const total = i.files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_TOTAL_BYTES) return { error: "batch_too_large", status: 413, details: { max_bytes: MAX_TOTAL_BYTES } };
  return null;
}

/** multipart/form-data → SubmitInput (task_id, request_id, text, files[]). */
export function parseForm(form: FormData): SubmitInput {
  const s = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  const files: InFile[] = form.getAll("files")
    .filter((f): f is File => typeof f === "object" && f !== null && typeof (f as File).size === "number" && (f as File).size > 0)
    .map((f) => ({ kind: fileKindOf(f.type), blob: f, name: String(f.name || "file"), size: f.size, mime: String(f.type || "") }));
  return {
    taskId: /^[1-9][0-9]{0,15}$/.test(s("task_id").trim()) ? Number(s("task_id").trim()) : 0,
    requestId: s("request_id").trim(),
    text: s("text").replace(/\r\n/g, "\n").trim(),
    files,
  };
}

// ── the repost ──────────────────────────────────────────────────────────────────────────────────────────────
export type Profile = { name?: string | null; last_name?: string | null; telegram_username?: string | null };
export type TaskRef = { id: number; date?: string | null; title?: string | null };

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** The plain-text header naming the student and the task (no parse_mode anywhere: every field is user-supplied). */
export function buildHeader(p: Profile | null, task: TaskRef): string {
  const name = clip([p?.name, p?.last_name].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ") || "O‘quvchi", 64);
  const uname = String(p?.telegram_username ?? "").trim().replace(/^@+/, "");
  const who = uname && /^[A-Za-z0-9_]{3,32}$/.test(uname) ? `${name} (@${uname})` : name;
  const date = task.date ? formatTaskDate(task.date, "uz") : "";
  const title = clip(String(task.title ?? "").trim(), 120);
  return `📱 ${who} — ilova orqali\n📅 ${[date, title].filter(Boolean).join(" · ") || "Kunlik vazifa"}`;
}

export type Part =
  | { kind: "text"; text: string; carriesText: boolean }
  | { kind: "media"; files: InFile[]; caption: string; carriesText: boolean };

/**
 * What to send, in order. The student's text rides the first media caption when header + text fit in 1024;
 * otherwise (or with no files) it is its own text message first and every media part carries the header only.
 * Photos and videos share one album; documents get their own (Telegram never mixes the two).
 */
export function planParts(files: InFile[], text: string, header: string): Part[] {
  const full = text ? `${header}\n\n${text}` : header;
  const visual = files.filter((f) => f.kind !== "document");
  const docs = files.filter((f) => f.kind === "document");
  const media = [visual, docs].filter((g) => g.length > 0);
  if (media.length === 0) return [{ kind: "text", text: full, carriesText: !!text }];
  const parts: Part[] = [];
  let captionUsed = false;
  if (text && full.length > CAPTION_MAX) {
    parts.push({ kind: "text", text: full, carriesText: true });
    captionUsed = true;
  }
  for (const g of media) {
    parts.push({ kind: "media", files: g, caption: captionUsed ? header : full, carriesText: !captionUsed && !!text });
    captionUsed = true;
  }
  return parts;
}

/** The Message keys that make it a media message (what challenge_task_classify reads a kind from). */
const MEDIA_KEYS = ["photo", "video", "document", "audio", "voice", "video_note", "animation", "sticker"] as const;
/** The keys of a Bot API Message the engine reads (challenge_task_classify / capture_miniapp). Everything else is dropped. */
const VIEW_KEYS = ["message_id", "date", "message_thread_id", "is_topic_message", "media_group_id", ...MEDIA_KEYS] as const;

/**
 * A posted Message as the engine should judge it: our header removed (see the file comment). `studentText` is set
 * only on the ONE message that carried the student's text; every other view has no text at all. The bot's `from`,
 * the forum-topic `reply_to_message` and the entities of our caption are dropped with everything else.
 */
export function captureView(m: Any, studentText: string | null): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const k of VIEW_KEYS) if (m?.[k] !== undefined) v[k] = m[k];
  v.chat = { id: m?.chat?.id, type: m?.chat?.type ?? "supergroup" };
  if (studentText) {
    if (MEDIA_KEYS.some((k) => m?.[k] !== undefined)) v.caption = studentText;
    else v.text = studentText;
  }
  return v;
}

type Posted = { message: Any; studentText: string | null };
export type PostRun = { posted: Posted[]; failed: number; lastError: SendResultOutcome | null; stoppedEarly: boolean };

const methodFor = (k: FileKind) => (k === "photo" ? "sendPhoto" : k === "video" ? "sendVideo" : "sendDocument") as
  "sendPhoto" | "sendVideo" | "sendDocument";
const fieldFor = (k: FileKind) => (k === "photo" ? "photo" : k === "video" ? "video" : "document");

/** In-request waiting for 429s is bounded: past this total the request stops and the student retries later. */
export const RATE_LIMIT_WAIT_BUDGET_SEC = 30;

/**
 * Post every part. A short 429 is waited out once (within RATE_LIMIT_WAIT_BUDGET_SEC per request); an album that
 * fails falls back to single items; a photo / video Telegram cannot take goes again as a document. A missing topic
 * or a rate limit that persists stops the run (nothing after it would land) and the rest count as failed.
 */
export async function postParts(deps: Deps, chatId: number, threadId: number, parts: Part[], studentText: string): Promise<PostRun> {
  const run: PostRun = { posted: [], failed: 0, lastError: null, stoppedEarly: false };
  const base = { chat_id: chatId, message_thread_id: threadId };
  let waitLeft = RATE_LIMIT_WAIT_BUDGET_SEC;
  const stop = (o: SendResultOutcome) => o.klass === "topic_missing" || o.klass === "rate_limited";

  // one send, with at most one wait for a short retry_after while the request's wait budget lasts
  async function withWait<T extends { outcome: SendResultOutcome }>(fn: () => Promise<T>): Promise<T> {
    const r = await fn();
    const after = r.outcome.retryAfterSec ?? 1;
    if (r.outcome.klass === "rate_limited" && after <= RATE_LIMIT_WAIT_MAX_SEC && after <= waitLeft) {
      waitLeft -= after;
      await deps.sleep((after + 0.5) * 1000);
      return await fn();
    }
    return r;
  }

  async function sendOne(f: InFile, caption: string): Promise<SendResult> {
    const fields: Record<string, string | number> = { ...base, ...(caption ? { caption } : {}) };
    if (f.kind === "video") fields.supports_streaming = "true";
    let r = await withWait(() => deps.poster.single(methodFor(f.kind), fields, { field: fieldFor(f.kind), blob: f.blob, filename: f.name }));
    if (!r.outcome.ok && f.kind !== "document" && (r.outcome.klass === "content" || r.outcome.klass === "transient")) {
      // Telegram could not take it as a photo / video (HEIC-like data, odd dimensions, a codec): the same bytes as a
      // file still carry the work (the engine counts an image / video document as a screenshot / video).
      const docFields: Record<string, string | number> = { ...base, ...(caption ? { caption } : {}) };
      r = await withWait(() => deps.poster.single("sendDocument", docFields, { field: "document", blob: f.blob, filename: f.name }));
    }
    return r;
  }

  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    if (run.stoppedEarly) {
      run.failed += part.kind === "text" ? 1 : part.files.length;
      continue;
    }
    if (part.kind === "text") {
      const r = await withWait(() => deps.poster.text({ ...base, text: part.text, link_preview_options: { is_disabled: true } }));
      if (r.outcome.ok && r.result) run.posted.push({ message: r.result, studentText: part.carriesText ? studentText : null });
      else {
        run.failed++;
        run.lastError = r.outcome;
        if (stop(r.outcome)) run.stoppedEarly = true;
      }
      continue;
    }
    let captionPending = true;
    const note = (m: Any) => {
      run.posted.push({ message: m, studentText: captionPending && part.carriesText ? studentText : null });
      captionPending = false;
    };
    if (part.files.length >= 2) {
      const items: MediaGroupItem[] = part.files.map((f, i) => ({ type: f.kind, blob: f.blob, filename: f.name, ...(i === 0 ? { caption: part.caption } : {}) }));
      const r = await withWait(() => deps.poster.album(base, items));
      if (r.outcome.ok && Array.isArray(r.result) && r.result.length > 0) {
        r.result.forEach((m) => note(m));
        continue;
      }
      run.lastError = r.outcome;
      if (stop(r.outcome)) {
        run.failed += part.files.length;
        run.stoppedEarly = true;
        continue;
      }
      // otherwise: the album as single items
    }
    for (const f of part.files) {
      if (run.stoppedEarly) { run.failed++; continue; }
      const r = await sendOne(f, captionPending ? part.caption : "");
      if (r.outcome.ok && r.result) note(r.result);
      else {
        run.failed++;
        run.lastError = r.outcome;
        if (stop(r.outcome)) run.stoppedEarly = true;
      }
    }
  }
  return run;
}

// ── the request ─────────────────────────────────────────────────────────────────────────────────────────────
export type Reply = { status: number; body: Record<string, unknown> };

const rpcMissing = (e: Any) => ["PGRST202", "42883"].includes(String(e?.code ?? "")) || /could not find the function|does not exist/i.test(String(e?.message ?? ""));
const errCode = (e: Any) => String(e?.code ?? "") || null;

/** prepare_miniapp reasons after which the task text may be shown (the task is the student's own and already posted). */
const TEXT_OK = new Set(["closed", "done", "attempts_exhausted"]);

/**
 * mode "prepare": may this student submit (for this task) right now, plus the task post text when it is theirs to
 * see. Read-only; allowed while impersonating. taskId null = the open-task list only.
 */
export async function handlePrepare(deps: Deps, userId: string, taskId: number | null): Promise<Reply> {
  const { data: prep, error } = await deps.admin.rpc("challenge_task_prepare_miniapp", { _user: userId, _task_id: taskId });
  if (error) {
    await deps.healthOnce("challenge_task_miniapp_rpc_failed", `prepare:${rpcMissing(error) ? "missing" : errCode(error)}`,
      { stage: "prepare", code: errCode(error), missing: rpcMissing(error) }, userId);
    return { status: 503, body: { error: "unavailable" } };
  }
  const p = (prep ?? {}) as Any;
  let text: string | null = null;
  if (taskId !== null && (p.ok === true || TEXT_OK.has(String(p.reason ?? "")))) {
    const { data: card, error: cErr } = await deps.admin.rpc("challenge_task_card", { _task_id: taskId, _tg_user: null });
    if (cErr) {
      await deps.healthOnce("challenge_task_miniapp_rpc_failed", `card:${errCode(cErr)}`, { stage: "card", code: errCode(cErr) }, userId);
    } else if (card?.ok && typeof card.text === "string") {
      text = card.text;
    }
  }
  return {
    status: 200,
    body: {
      ok: p.ok === true,
      reason: p.reason ?? null,
      detail: p.detail ?? null,
      task: p.task ?? null,
      submission: p.submission ?? null,
      submission_id: p.submission_id ?? null,
      open_tasks: Array.isArray(p.open_tasks) ? p.open_tasks : [],
      topic_url: typeof p.topic?.url === "string" ? p.topic.url : null,
      text,
      limits: { max_items: MAX_ITEMS, max_photo_bytes: MAX_PHOTO_BYTES, max_file_bytes: MAX_FILE_BYTES, max_text: MAX_TEXT },
    },
  };
}

type Claim = { state: string; items: Any; claimed_at: string; updated_at: string; error: string | null; task_id: number };

async function readClaim(deps: Deps, userId: string, requestId: string): Promise<Claim | null> {
  const { data, error } = await deps.admin.from("challenge_task_submit_claims")
    .select("state,items,claimed_at,updated_at,error,task_id")
    .eq("user_id", userId).eq("request_id", requestId).maybeSingle();
  if (error) throw error;
  return (data ?? null) as Claim | null;
}

/** Compare-and-set a claim back to 'claimed' (a retry after a failure, or the take-over of a dead request). */
async function takeClaim(deps: Deps, userId: string, requestId: string, from: Claim): Promise<boolean> {
  const { data, error } = await deps.admin.from("challenge_task_submit_claims")
    .update({ state: "claimed", error: null, updated_at: new Date(deps.now()).toISOString() })
    .eq("user_id", userId).eq("request_id", requestId).eq("state", from.state).eq("updated_at", from.updated_at)
    .select("claimed_at").maybeSingle();
  if (error) throw error;
  return !!data;
}

async function capture(deps: Deps, userId: string, taskId: number, requestId: string, claimedAt: string, views: Any[],
                       extra: Record<string, unknown>): Promise<Reply> {
  const { data, error } = await deps.admin.rpc("challenge_task_capture_miniapp", {
    _user: userId, _task_id: taskId, _request_id: requestId, _claimed_at: claimedAt, _messages: views,
  });
  if (error || !data || data.status === "error") {
    // The claim is 'posted' with its items: the reconciler's Mini App heal captures it within minutes (I4).
    await deps.health("challenge_task_miniapp_capture_failed", {
      request_id: requestId, task_id: taskId, code: errCode(error), missing: error ? rpcMissing(error) : false,
      reason: data?.reason ?? null,
    }, userId);
    return { status: 202, body: { ok: true, pending: true, ...extra } };
  }
  if (data.outcome === "refused" || data.outcome === "disabled") {
    return { status: 409, body: { error: "refused", reason: data.reason ?? data.outcome, ...extra } };
  }
  return { status: 200, body: { ok: true, result: data, ...extra } };
}

/** mode "submit": the multipart form. */
export async function handleSubmit(deps: Deps, userId: string, input: SubmitInput, profile: Profile | null): Promise<Reply> {
  const bad = validateInput(input);
  if (bad) {
    await deps.healthOnce("challenge_task_miniapp_submit_refused", `${userId}:${bad.error}`,
      { reason: bad.error, task_id: input.taskId || null, ...(bad.details ?? {}) }, userId);
    return { status: bad.status, body: { error: bad.error, ...(bad.details ?? {}) } };
  }

  // 1. the engine's gate (the same one capture_miniapp re-checks)
  const { data: prep, error: pErr } = await deps.admin.rpc("challenge_task_prepare_miniapp", { _user: userId, _task_id: input.taskId });
  if (pErr) {
    await deps.health("challenge_task_miniapp_rpc_failed", { stage: "prepare", code: errCode(pErr), missing: rpcMissing(pErr) }, userId);
    return { status: 503, body: { error: "unavailable" } };
  }
  const p = (prep ?? {}) as Any;
  const topicUrl = typeof p.topic?.url === "string" ? p.topic.url : null;

  // 2. a retry of this request? One that already POSTED is finished whatever the gate says now (its work is in the
  //    topic; e.g. it may have been accepted since, and prepare now says 'done'). Nothing is ever reposted.
  let existing: Claim | null;
  try { existing = await readClaim(deps, userId, input.requestId); } catch (e) {
    await deps.health("challenge_task_miniapp_rpc_failed", { stage: "claim_read", code: errCode(e) }, userId);
    return { status: 503, body: { error: "unavailable" } };
  }
  if (existing && Number(existing.task_id) !== input.taskId) return { status: 400, body: { error: "request_id_reused" } };
  if (existing && (existing.state === "posted" || existing.state === "captured") && Array.isArray(existing.items) && existing.items.length > 0) {
    return await capture(deps, userId, input.taskId, input.requestId, existing.claimed_at, existing.items, { replayed: true, topic_url: topicUrl });
  }

  // 3. the engine said no: nothing is claimed, nothing is posted
  if (p.ok !== true) {
    await deps.healthOnce("challenge_task_miniapp_submit_refused", `${userId}:${p.reason ?? "not_ok"}:${input.taskId}`,
      { reason: p.reason ?? "not_ok", detail: p.detail ?? null, task_id: input.taskId }, userId);
    return { status: 409, body: { error: "not_allowed", reason: p.reason ?? null, detail: p.detail ?? null, topic_url: topicUrl } };
  }

  // 4. what the task accepts (the picker enforces it too; the server never posts what the task cannot use)
  const accepts: string[] = Array.isArray(p.task?.accepts) ? p.task.accepts.map(String) : [];
  const offKind = input.files.find((f) => !acceptsFile(accepts, f));
  if (offKind || (input.text && input.files.length === 0 && !acceptsText(accepts))) {
    await deps.healthOnce("challenge_task_miniapp_submit_refused", `${userId}:kind_not_accepted:${input.taskId}`,
      { reason: "kind_not_accepted", task_id: input.taskId, kind: offKind?.kind ?? "text", mime: offKind?.mime ?? null }, userId);
    return { status: 400, body: { error: "kind_not_accepted", accepts } };
  }

  // 5. the student's OWN group's daily topic (challenge_task_topics() by their group: chat AND thread)
  const chatId = Number(p.topic?.chat_id);
  const threadId = Number(p.topic?.thread_id);
  if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(threadId) || threadId <= 1) {
    await deps.health("challenge_task_miniapp_topic_missing", { task_id: input.taskId, topic: p.topic ?? null }, userId);
    return { status: 409, body: { error: "topic_not_configured" } };
  }

  // 6. the claim. Its time is the submission time (G28): a retry that takes a failed / dead claim back keeps it.
  let claimedAt: string;
  if (!existing) {
    const { data: claim, error: cErr } = await deps.admin.rpc("challenge_task_submit_claim", {
      _user: userId, _request_id: input.requestId, _task_id: input.taskId,
    });
    if (cErr) {
      await deps.health("challenge_task_miniapp_rpc_failed", { stage: "claim", code: errCode(cErr), missing: rpcMissing(cErr) }, userId);
      return { status: 503, body: { error: "unavailable" } };
    }
    if (!claim?.ok) return { status: 400, body: { error: claim?.reason ?? "bad_request_id" } };
    if (!claim.new) return { status: 409, body: { error: "in_progress" } }; // a concurrent twin claimed it first
    claimedAt = String(claim.claimed_at);
  } else {
    const c = existing;
    if (c.state === "abandoned") return { status: 409, body: { error: "expired" } };
    if (c.state === "failed" && c.error === "not_allowed") return { status: 409, body: { error: "refused", reason: "not_allowed" } };
    const stale = c.state === "claimed" && deps.now() - Date.parse(c.updated_at) > CLAIM_STALE_MS;
    if (!(c.state === "failed" || stale)) return { status: 409, body: { error: "in_progress" } };
    let took = false;
    try { took = await takeClaim(deps, userId, input.requestId, c); } catch (e) {
      await deps.health("challenge_task_miniapp_rpc_failed", { stage: "claim_take", code: errCode(e) }, userId);
      return { status: 503, body: { error: "unavailable" } };
    }
    if (!took) return { status: 409, body: { error: "in_progress" } };
    if (stale) {
      await deps.health("challenge_task_miniapp_claim_taken_over", { request_id: input.requestId, task_id: input.taskId }, userId);
    }
    claimedAt = c.claimed_at;
  }

  // 7. post
  const header = buildHeader(profile, { id: input.taskId, date: p.task?.date ?? null, title: p.task?.title ?? null });
  const parts = planParts(input.files, input.text, header);
  const run = await postParts(deps, chatId, threadId, parts, input.text);

  if (run.posted.length === 0) {
    const err = run.lastError?.error ?? "telegram_post_failed";
    // SQL writes 'challenge_task_miniapp_post_failed' and closes the claim as 'failed' (a retry may take it back).
    const { error: rErr } = await deps.admin.rpc("challenge_task_submit_record", {
      _user: userId, _request_id: input.requestId, _messages: null, _error: String(err).slice(0, 300),
    });
    if (rErr) await deps.health("challenge_task_miniapp_rpc_failed", { stage: "record_failed", code: errCode(rErr) }, userId);
    return {
      status: 502,
      body: {
        error: "telegram_post_failed",
        klass: run.lastError?.klass ?? null,
        retry_after: run.lastError?.klass === "rate_limited" ? run.lastError.retryAfterSec : null,
        topic_url: topicUrl,
      },
    };
  }

  // 8. record what landed (claim → 'posted'), then capture it
  const views = run.posted.map((x) => captureView(x.message, x.studentText));
  const { error: recErr } = await deps.admin.rpc("challenge_task_submit_record", {
    _user: userId, _request_id: input.requestId, _messages: views, _error: null,
  });
  if (recErr) await deps.health("challenge_task_miniapp_rpc_failed", { stage: "record", code: errCode(recErr), request_id: input.requestId }, userId);
  if (run.failed > 0) {
    await deps.health("challenge_task_miniapp_post_partial", {
      request_id: input.requestId, task_id: input.taskId, posted: run.posted.length, failed: run.failed,
      klass: run.lastError?.klass ?? null, error: run.lastError?.error ?? null,
    }, userId);
  }
  return await capture(deps, userId, input.taskId, input.requestId, claimedAt, views,
    { posted: run.posted.length, failed: run.failed, topic_url: topicUrl });
}
