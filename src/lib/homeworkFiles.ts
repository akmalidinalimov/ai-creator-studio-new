// Mirrors supabase/functions/submit-homework/media.ts — the picker refuses exactly what the server refuses, so a
// student never uploads 50 MB to be told no. Photos (JPEG/PNG/WebP ≤ 10 MB) go as photos, the common video formats
// as videos, everything else (PDF, Word, PowerPoint, …) as a file (Telegram document). Caps are the bot's limits.

export type HomeworkFileKind = "photo" | "video" | "document";

export const HW_MAX_ITEMS = 10;
export const HW_MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const HW_MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const HW_MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

const PHOTO_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm", "video/3gpp", "video/x-m4v"]);

export function homeworkFileKind(mime: string, size: number): HomeworkFileKind {
  const m = String(mime || "").toLowerCase();
  if (PHOTO_TYPES.has(m) && size <= HW_MAX_PHOTO_BYTES) return "photo";
  if (VIDEO_TYPES.has(m)) return "video";
  return "document";
}

/** The pre-compression kind: an oversize JPEG/PNG/WebP is still a photo here — the client downscales it first. */
export function pickedKind(mime: string): HomeworkFileKind {
  const m = String(mime || "").toLowerCase();
  if (PHOTO_TYPES.has(m)) return "photo";
  if (VIDEO_TYPES.has(m)) return "video";
  return "document";
}

export function homeworkMaxBytes(kind: HomeworkFileKind): number {
  return kind === "photo" ? HW_MAX_PHOTO_BYTES : kind === "video" ? HW_MAX_VIDEO_BYTES : HW_MAX_DOCUMENT_BYTES;
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Wait until this upload's submission is RECORDED (it is in the class topic by then), without holding a connection
 * open: short reads every `everyMs`, at most `maxMs`. `read` returns the row's submitted_at (server time; set on every
 * submit and resubmit, never by grading) or null. `baseline` = that value read BEFORE the upload ("none" = no row
 * yet); arrival = a submitted_at different from and newer than it. When the baseline could not be read (offline),
 * fall back to the phone clock with a wide margin. 2026-10-08: the server keeps working after the phone loses the
 * connection — 19 students in a week were told "Failed to fetch" for uploads that then arrived.
 */
export async function waitForSubmission(
  read: () => Promise<string | null>,
  since: { baseline: string | null | "unknown"; startedMs: number },
  opts: { everyMs?: number; maxMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const every = opts.everyMs ?? 5_000;
  const max = opts.maxMs ?? 75_000;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const isNew = (at: string): boolean => {
    if (since.baseline === "unknown") return Date.parse(at) >= since.startedMs - 120_000;
    if (since.baseline === null) return true;                    // there was no row: any row is this upload
    return at !== since.baseline && Date.parse(at) > Date.parse(since.baseline);
  };
  const start = now();
  for (;;) {
    try {
      const at = await read();
      if (at && isNew(at)) return true;
    } catch { /* still offline: keep waiting */ }
    if (now() - start >= max) return false;
    await sleep(every);
  }
}

/**
 * A supabase.functions.invoke error with NO HTTP answer (the connection dropped / never reached the server).
 * functions-js wraps it as FunctionsFetchError whose `context` is the original TypeError — NOT a Response — so
 * "has context" is not the test (the first version of this fix keyed on it and never fired).
 */
export function isFunctionNetworkError(error: unknown): boolean {
  if (!error) return false;
  const e = error as { name?: string; context?: unknown };
  return e.name === "FunctionsFetchError" || !(typeof Response !== "undefined" && e.context instanceof Response);
}
