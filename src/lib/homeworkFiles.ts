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
