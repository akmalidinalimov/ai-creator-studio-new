/**
 * Kunlik vazifalar (Challenge 6.0 daily tasks) — the Mini App side (Daily Tasks PR-7).
 *
 * The SQL engine (PR-3) decides everything: whether a student may submit, what a submission counts for, its
 * status and points (spec I1). This module only calls it and shapes its answers for the pages:
 *   my_challenge_tasks()                 the student's task list, streak and points (authenticated RPC)
 *   submit-daily-task {mode:"prepare"}   may I submit this task now + the task post text (edge fn, read-only)
 *   submit-daily-task multipart          the submission: the files are reposted into the student's group topic
 *   my_challenge_task_move/withdraw/restore, my_telegram_write_access_granted   the student's one-tap writes
 *
 * IMPERSONATION (spec G12): an admin previewing as a student holds that student's real session, so every WRITE
 * here is gated on impersonatingReadonly() FIRST and returns the expected `impersonation_readonly` no-op — never
 * sent, never beaconed. (The RPC names are also in impersonationGuard's WRITE_RPCS, the second layer.) Reads stay
 * allowed so the admin can see what the student sees.
 */
import { supabase } from "@/integrations/supabase/client";
import { impersonatingReadonly } from "@/lib/mutate";
import { reportClientError } from "@/lib/beacon";

// ─────────────────────────────── shapes (what the engine returns) ───────────────────────────────
export type DtStatus = "needs_more" | "checking" | "accepted" | "rejected" | "withdrawn" | "merged" | "voided" | "expired";

export interface MySubmission {
  id: number;
  status: DtStatus | string;
  points?: number | null;
  late_days?: number | null;
  missing?: string[] | null;
  reason?: string | null;
  submitted_at?: string | null;
}

export interface MyTask {
  id: number;
  date: string;
  day_no?: number | null;
  type: "general" | "instagram" | string;
  title: string;
  open: boolean;
  closed: boolean;
  submission: MySubmission | null;
}

export interface MyTasks {
  ok: true;
  enabled: boolean;
  miniapp: boolean;
  topic_url: string | null;
  streak: number;
  points: number;
  tasks: MyTask[];
}

export type MyTasksResult = MyTasks | { ok: false; reason: string };

export interface RequiresGroup {
  any: string[];
  min?: number;
  label?: string;
}

export interface PrepareTask {
  id: number;
  date: string;
  type: string;
  title: string;
  accepts: string[];
  requires: RequiresGroup[];
  late_days?: number;
  points?: number;
}

export interface Prepare {
  ok: boolean;
  reason: string | null;
  detail: string | null;
  task: PrepareTask | null;
  submission: { id: number; status: string; missing?: string[] | null } | null;
  submission_id: number | null;
  open_tasks: { task_id: number; date: string; type: string; title: string; late: boolean }[];
  topic_url: string | null;
  text: string | null;
  limits?: { max_items: number; max_photo_bytes: number; max_file_bytes: number; max_text: number; max_messages?: number;
             caption_text_max?: number };
}

// ─────────────────────────────── reads ───────────────────────────────
const missingFn = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "PGRST202" || e.code === "42883" || /could not find the function|does not exist/i.test(e.message ?? ""));

/** The student's daily-task page data. Any failure is `{ok:false}` (the page hides / offers a retry). */
export async function loadMyTasks(): Promise<MyTasksResult> {
  try {
    const { data, error } = await supabase.rpc("my_challenge_tasks" as never);
    if (error) {
      // Before the engine is deployed the RPC does not exist: expected, silent. Anything else is a real failure.
      if (!missingFn(error)) reportClientError({ type: "other", message: "daily_tasks_load_failed", extra: { code: error.code ?? null } });
      return { ok: false, reason: missingFn(error) ? "not_deployed" : "error" };
    }
    const d = (data ?? {}) as Partial<MyTasks> & { ok?: boolean; reason?: string };
    if (!d.ok) return { ok: false, reason: d.reason ?? "not_in_challenge" };
    return {
      ok: true,
      enabled: !!d.enabled,
      miniapp: !!d.miniapp,
      topic_url: typeof d.topic_url === "string" ? d.topic_url : null,
      streak: Number(d.streak ?? 0) || 0,
      points: Number(d.points ?? 0) || 0,
      tasks: Array.isArray(d.tasks) ? (d.tasks as MyTask[]) : [],
    };
  } catch (e) {
    reportClientError({ type: "other", message: "daily_tasks_load_failed", extra: { error: String((e as Error)?.message ?? e).slice(0, 200) } });
    return { ok: false, reason: "error" };
  }
}

/** Read the `{error, …}` body of a non-2xx edge-function answer (supabase-js puts the Response in error.context). */
export async function functionErrorBody(error: unknown, data: unknown): Promise<Record<string, unknown> | null> {
  if (data && typeof data === "object" && "error" in (data as object)) return data as Record<string, unknown>;
  const ctx = (error as { context?: unknown } | null)?.context;
  if (ctx && typeof (ctx as Response).json === "function") {
    try {
      const j = await (ctx as Response).clone().json();
      return j && typeof j === "object" ? (j as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** May I submit (this task) now, plus the task post text. Read-only: allowed while impersonating. */
export async function prepareTask(taskId: number | null): Promise<Prepare | { error: string }> {
  try {
    const { data, error } = await supabase.functions.invoke("submit-daily-task", { body: { mode: "prepare", task_id: taskId } });
    if (error) {
      const body = await functionErrorBody(error, data);
      const code = String(body?.error ?? "error");
      if (code !== "unauthorized") reportClientError({ type: "other", message: "daily_task_prepare_failed", extra: { code, task_id: taskId } });
      return { error: code };
    }
    return data as Prepare;
  } catch (e) {
    reportClientError({ type: "other", message: "daily_task_prepare_failed", extra: { error: String((e as Error)?.message ?? e).slice(0, 200) } });
    return { error: "network" };
  }
}

// ─────────────────────────────── writes (impersonation-gated) ───────────────────────────────
export type SubmitAnswer =
  | { ok: true; pending: boolean; result: Record<string, unknown> | null; posted: number; failed: number }
  | { ok: false; code: string; reason?: string | null; retryAfter?: number | null; topicUrl?: string | null; status?: number;
      max?: number | null };

/** Codes the student can meet in normal use (never beaconed). Anything else is a real failure and is. */
const EXPECTED_CODES = new Set([
  "impersonation_readonly", "not_allowed", "in_progress", "expired", "refused", "kind_not_accepted", "empty", "too_many_files",
  "too_many_files_with_text",
  "file_too_large", "batch_too_large", "text_too_long", "empty_file", "telegram_post_failed", "unauthorized", "request_id_reused",
  "network", "too_many_requests",
]);

/** The multipart submission. `form` carries task_id, request_id, text and files. */
export async function submitDailyTask(form: FormData): Promise<SubmitAnswer> {
  if (impersonatingReadonly()) return { ok: false, code: "impersonation_readonly" }; // expected preview no-op
  let answer: SubmitAnswer;
  try {
    const { data, error } = await supabase.functions.invoke("submit-daily-task", { body: form });
    if (error) {
      const body = await functionErrorBody(error, data);
      const status = Number((error as { context?: { status?: number } })?.context?.status ?? 0) || undefined;
      answer = {
        ok: false,
        code: String(body?.error ?? (status ? "error" : "network")),
        reason: (body?.reason as string | null | undefined) ?? null,
        retryAfter: typeof body?.retry_after === "number" ? (body.retry_after as number) : null,
        topicUrl: typeof body?.topic_url === "string" ? (body.topic_url as string) : null,
        status,
        max: typeof body?.max === "number" ? (body.max as number) : null,
      };
    } else {
      const d = (data ?? {}) as Record<string, unknown>;
      answer = {
        ok: true,
        pending: d.pending === true,
        result: (d.result as Record<string, unknown> | undefined) ?? null,
        posted: Number(d.posted ?? 0) || 0,
        failed: Number(d.failed ?? 0) || 0,
      };
    }
  } catch (e) {
    answer = { ok: false, code: "network", reason: String((e as Error)?.message ?? e).slice(0, 200) };
  }
  if (!answer.ok && !EXPECTED_CODES.has(answer.code)) {
    reportClientError({ type: "other", message: "daily_task_submit_failed", extra: { code: answer.code, status: answer.status ?? null } });
  }
  return answer;
}

export type CorrectionOp = "move" | "withdraw" | "restore";
export type CorrectionAnswer = { ok: boolean; reason: string | null };

/** The student's one-tap corrections (the engine enforces the owner lock, the windows and the move limit). */
export async function correctSubmission(op: CorrectionOp, submissionId: number, targetTaskId?: number): Promise<CorrectionAnswer> {
  if (impersonatingReadonly()) return { ok: false, reason: "impersonation_readonly" };
  const name = op === "move" ? "my_challenge_task_move" : op === "withdraw" ? "my_challenge_task_withdraw" : "my_challenge_task_restore";
  const args = op === "move" ? { _sub: submissionId, _target_task: targetTaskId } : { _sub: submissionId };
  try {
    const { data, error } = await supabase.rpc(name as never, args as never);
    if (error) {
      reportClientError({ type: "other", message: "daily_task_correction_failed", extra: { op, code: error.code ?? null } });
      return { ok: false, reason: "error" };
    }
    const d = (data ?? {}) as { ok?: boolean; reason?: string | null };
    return { ok: d.ok !== false, reason: d.reason ?? null };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (/read-only impersonation/i.test(msg)) return { ok: false, reason: "impersonation_readonly" };
    reportClientError({ type: "other", message: "daily_task_correction_failed", extra: { op, error: msg.slice(0, 200) } });
    return { ok: false, reason: "error" };
  }
}

/** Record that the student let the bot message them (after Telegram's requestWriteAccess said yes). */
export async function recordWriteAccessGranted(): Promise<boolean> {
  if (impersonatingReadonly()) return false;
  try {
    const { data, error } = await supabase.rpc("my_telegram_write_access_granted" as never);
    if (error) {
      reportClientError({ type: "other", message: "write_access_record_failed", extra: { code: error.code ?? null } });
      return false;
    }
    return data === true;
  } catch {
    return false;
  }
}

// ─────────────────────────────── pure helpers ───────────────────────────────
/**
 * The task post as the SQL renderer produced it (challenge_task_render_post_text: Telegram HTML with ONLY <b> and the
 * entities &amp; &lt; &gt;) → plain segments for React. Never rendered as HTML: any other tag stays literal text.
 */
export function parsePostHtml(s: string | null | undefined): { text: string; bold: boolean }[] {
  const unescape = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const out: { text: string; bold: boolean }[] = [];
  const src = String(s ?? "");
  const re = /<b>([\s\S]*?)<\/b>/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m.index > last) out.push({ text: unescape(src.slice(last, m.index)), bold: false });
    out.push({ text: unescape(m[1]), bold: true });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ text: unescape(src.slice(last)), bold: false });
  return out.filter((x) => x.text.length > 0);
}

export type Tone = "ok" | "wait" | "redo" | "none";

/** A status (a submission's, or a row's from taskStatus) → the chip colour. */
export function statusTone(status: string | null | undefined): Tone {
  if (status === "accepted") return "ok";
  if (status === "checking" || status === "open") return "wait";
  if (status === "needs_more" || status === "rejected") return "redo";
  return "none";
}

/**
 * When a task opens: platform_settings.challenge_tasks.post_time (live "09:00", Tashkent). The engine's open_at is that
 * time on the task's date, or EARLIER when the bot or staff posted it earlier that day — never later — so "opens at
 * 09:00" is a promise the engine keeps. (A 'retro' task opens at 00:00 and is never shown as not_open on its day.)
 */
export const DT_OPEN_TIME = "09:00";

/**
 * The ONE status rule for a task row — the Dashboard card, the /challenge/tasks list and the task page all use this, so
 * they never disagree. The student's submission wins; else closed → "missed", open → "open", neither → "not_open".
 * my_challenge_tasks lists today's task from 00:00 Tashkent, before it opens: that is "not open yet · 09:00", never
 * "Topshirilmagan" (not submitted) for a task nobody could submit yet.
 */
export function taskStatus(task: Pick<MyTask, "open" | "closed" | "submission">): string {
  return task.submission?.status ?? (task.closed ? "missed" : task.open ? "open" : "not_open");
}

/**
 * Who the daily-task views are for — one rule for the card, the list and the task page.
 *   student   my_challenge_tasks answered ok (and prepare, when asked, did not refuse the account)
 *   outside   not a challenge student: no group, or a group outside the challenge (a 5.0 student) — my_challenge_tasks
 *             'not_in_challenge', prepare_miniapp held_sender/no_group|sender_out_of_scope, or no_profile
 *   staff     an admin / teacher (prepare_miniapp 'staff'; my_challenge_tasks 'staff' once fix/daily-tasks-pre-monday lands)
 *   inactive  an archived / not-active profile (prepare held_sender/inactive; my_challenge_tasks 'inactive', same PR)
 *   null      not known (a load error, the RPC not deployed): the caller keeps its own error / fallback handling.
 * my_challenge_tasks' explicit verdict wins; prepare's refusal of the ACCOUNT (never of the task) comes next.
 */
export type DtScope = "student" | "outside" | "staff" | "inactive";

const MY_SCOPE: Record<string, DtScope> = {
  not_in_challenge: "outside", not_signed_in: "outside", staff: "staff", inactive: "inactive",
};

export function scopeOf(mine: MyTasksResult | null, prep?: Prepare | { error: string } | null): DtScope | null {
  if (mine && !mine.ok && MY_SCOPE[mine.reason]) return MY_SCOPE[mine.reason];
  const p = prep && !("error" in prep) ? prep : null;
  if (p && !p.ok) {
    if (p.reason === "staff") return "staff";
    if (p.reason === "no_profile") return "outside";
    if (p.reason === "held_sender") {
      if (p.detail === "no_group" || p.detail === "sender_out_of_scope") return "outside";
      if (p.detail === "inactive") return "inactive";
    }
  }
  return mine?.ok ? "student" : null;
}

/** The empty state a page shows for an account that is not a challenge student (i18n keys under dailyTasks). Anything
 *  but staff / inactive gets the plain "this is for challenge-group students" note. */
export function scopeEmptyKeys(scope: DtScope | null): { title: string; body: string } {
  if (scope === "staff") return { title: "notInChallengeTitle", body: "reasons.staff" };
  if (scope === "inactive") return { title: "notInChallengeTitle", body: "reasons.inactive" };
  return { title: "notInChallengeTitle", body: "notInChallengeBody" };
}

/** An idempotency key for one submission form (kept across retries of the same form). */
export function newRequestId(): string {
  try {
    const u = globalThis.crypto?.randomUUID?.();
    if (u) return u.replace(/-/g, "");
  } catch { /* fall through */ }
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export type FileKind = "photo" | "video" | "document";

export const DT_MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Mirrors submit-daily-task's fileKindOf: sendPhoto formats up to 10 MB are photos, a video is a video, the rest files. */
export function fileKindOf(mime: string, size = 0): FileKind {
  const m = String(mime || "").toLowerCase();
  if ((m === "image/jpeg" || m === "image/jpg" || m === "image/png" || m === "image/webp") && size <= DT_MAX_PHOTO_BYTES) return "photo";
  if (m === "video/mp4" || m === "video/quicktime" || m === "video/webm" || m === "video/3gpp" || m === "video/x-m4v") return "video";
  return "document";
}

/** Mirrors submit-daily-task's effectiveKind: a task that takes files but not photos / videos gets them as files. */
export function effectiveKind(kind: FileKind, accepts: string[]): FileKind {
  if (kind === "photo" && !accepts.includes("photo") && accepts.includes("document")) return "document";
  if (kind === "video" && !accepts.includes("video") && accepts.includes("document")) return "document";
  return kind;
}

/** Mirrors submit-daily-task's acceptsFile (the server refuses what this refuses). */
export function acceptsFile(accepts: string[], kind: FileKind, mime: string): boolean {
  const a = new Set(accepts);
  if (kind === "photo") return a.has("photo") || a.has("document");
  if (kind === "video") return a.has("video") || a.has("document");
  if (a.has("document")) return true;
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return a.has("photo");
  if (m.startsWith("video/")) return a.has("video");
  if (m.startsWith("audio/")) return a.has("audio") || a.has("voice");
  return false;
}

/** Mirrors submit-daily-task: the engine captures at most this many messages per Mini App request. */
export const DT_MAX_MESSAGES = 10;
/** Mirrors submit-daily-task's CAPTION_TEXT_SAFE: a text this long fits the caption under any header. */
export const DT_CAPTION_TEXT_SAFE = 760;

/**
 * How many files may go with this text. A text longer than the caption room (prepare's limits.caption_text_max: the
 * room under THIS student's header) is posted as its own message, so it leaves room for DT_MAX_MESSAGES - 1 files —
 * the server refuses 10 files + such a text (too_many_files_with_text) before anything is posted.
 */
export function maxFilesFor(text: string, captionTextMax?: number | null): number {
  const room = typeof captionTextMax === "number" && Number.isFinite(captionTextMax) && captionTextMax >= 0 ? captionTextMax : DT_CAPTION_TEXT_SAFE;
  return text.trim().length > room ? DT_MAX_MESSAGES - 1 : DT_MAX_MESSAGES;
}

/** The file picker's accept attribute for a task. */
export function pickerAccept(accepts: string[]): string {
  if (accepts.includes("document")) return "*/*";
  const parts: string[] = [];
  if (accepts.includes("photo")) parts.push("image/*");
  if (accepts.includes("video")) parts.push("video/*");
  if (accepts.includes("audio") || accepts.includes("voice")) parts.push("audio/*");
  return parts.join(",");
}

const URL_RE = /(https?:\/\/[^\s<>"]+|www\.[^\s<>"]+|t\.me\/[^\s<>"]+|instagram\.com\/[^\s<>"]+)/gi;
const IG_POST_RE = /(?:instagram\.com|instagr\.am)\/(?:[A-Za-z0-9_.]{1,30}\/)?(?:p|reel|reels|tv)\/[A-Za-z0-9_-]{5,40}/i;

/**
 * A HINT of which `requires` groups the current picks satisfy (the same counting as the engine's
 * challenge_task_requires_eval, simplified: every picked image counts as a screenshot). The engine's missing[] after
 * the submit is the truth; this only helps the student not forget a piece.
 */
export function requiresHint(
  requires: RequiresGroup[],
  picks: { kinds: string[]; text: string },
  minText = 20,
): { label: string; met: boolean }[] {
  const counts = new Map<string, number>();
  for (const k of picks.kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  const textLen = picks.text.replace(URL_RE, "").trim().length;
  const hasLink = URL_RE.test(picks.text);
  URL_RE.lastIndex = 0;
  if (hasLink) counts.set("link", 1);
  if (IG_POST_RE.test(picks.text)) counts.set("ig_link", 1);
  return (requires ?? []).map((g) => {
    let n = 0;
    for (const k of g.any ?? []) {
      if (k === "text") n += textLen >= minText ? 1 : 0;
      else n += counts.get(k) ?? 0;
    }
    return { label: g.label ?? (g.any ?? []).join("/"), met: n >= (g.min ?? 1) };
  });
}

/** The kinds a picked file contributes (as the engine will classify the repost). */
export function pickKinds(kind: FileKind, mime: string): string[] {
  if (kind === "photo") return ["photo"];
  if (kind === "video") return ["video"];
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return ["image_doc"];
  if (m.startsWith("video/")) return ["video_doc"];
  return ["document"];
}

/** Today's date in Tashkent (UTC+5, no DST), YYYY-MM-DD. */
export function tashkentToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 5 * 3_600_000).toISOString().slice(0, 10);
}

/** The Tashkent date (YYYY-MM-DD) of a timestamp, or null. */
export function tashkentDateOf(ts: string | null | undefined): string | null {
  const ms = Date.parse(String(ts ?? ""));
  return Number.isFinite(ms) ? tashkentToday(new Date(ms)) : null;
}

const MONTHS: Record<string, string[]> = {
  uz: ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"],
  ru: ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"],
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
};

/** "2026-10-05" → "5-oktabr" / "5 октября" / "Oct 5" — the same words the bot's receipts use. */
export function formatTaskDate(iso: string | null | undefined, lng = "uz"): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m) return String(iso ?? "");
  const l = MONTHS[lng.slice(0, 2)] ? lng.slice(0, 2) : "uz";
  const mon = MONTHS[l][Number(m[2]) - 1];
  const day = Number(m[3]);
  if (!mon) return String(iso);
  return l === "uz" ? `${day}-${mon}` : l === "ru" ? `${day} ${mon}` : `${mon} ${day}`;
}
