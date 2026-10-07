// How an uploaded homework file is posted to the group topic (sendPhoto / sendVideo / sendDocument), and the bot's
// upload ceilings. Pure — media.test.ts covers it; src/lib/homeworkFiles.ts mirrors it for the picker (the client
// refuses exactly what this refuses, so a student never uploads 50 MB to be told no).
//
// 2026-10-07 (owner): homework takes FILES too — module 2's first task is a PDF. Mirrors submit-daily-task's
// fileKindOf: the formats sendPhoto renders (≤ 10 MB) are photos, the common video formats are videos, everything
// else (PDF, DOCX, PPTX, XLSX, ZIP, HEIC, …) goes as a document. Teachers already open documents (GradePhoto: PDF in
// an iframe, others as a download tile via hw-image-url), and the bot already captures documents posted in a topic.

export type HomeworkFileKind = "photo" | "video" | "document";

export const MAX_ITEMS = 10;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;    // sendPhoto
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;    // sendVideo (multipart upload by a bot)
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024; // sendDocument (multipart upload by a bot)
export const MAX_TOTAL_BYTES = 150 * 1024 * 1024;   // per request — bounds what the edge runtime buffers

const PHOTO_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm", "video/3gpp", "video/x-m4v"]);

export function homeworkFileKind(mime: string, size: number): HomeworkFileKind {
  const m = String(mime || "").toLowerCase();
  if (PHOTO_TYPES.has(m) && size <= MAX_PHOTO_BYTES) return "photo";
  if (VIDEO_TYPES.has(m)) return "video";
  return "document";
}

export function maxBytesFor(kind: HomeworkFileKind): number {
  return kind === "photo" ? MAX_PHOTO_BYTES : kind === "video" ? MAX_VIDEO_BYTES : MAX_DOCUMENT_BYTES;
}

/** The Bot API method + multipart field for a kind, and where the sent message carries the file id. */
export function sendSpec(kind: HomeworkFileKind): { method: string; field: string } {
  return kind === "photo" ? { method: "sendPhoto", field: "photo" }
    : kind === "video" ? { method: "sendVideo", field: "video" }
    : { method: "sendDocument", field: "document" };
}

/** The file id in a sent Message: photo = array of sizes (largest last); video / document = one object. */
export function sentFileId(kind: HomeworkFileKind, result: any): string | null {
  if (!result || typeof result !== "object") return null;
  if (kind === "photo") {
    const sizes = Array.isArray(result.photo) ? result.photo : [];
    return sizes.length ? (sizes[sizes.length - 1]?.file_id ?? null) : null;
  }
  return (kind === "video" ? result.video?.file_id : result.document?.file_id) ?? null;
}

export function defaultFilename(kind: HomeworkFileKind): string {
  return kind === "photo" ? "homework.jpg" : kind === "video" ? "homework.mp4" : "homework.pdf";
}
