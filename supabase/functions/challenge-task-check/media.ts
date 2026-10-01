// challenge-task-check — Telegram media: which file the model sees, which file is fingerprinted, how the bytes are
// fetched (getFile INSIDE this function; the provider only ever receives base64), and the 64-bit dHash.
//
// CPU is the budget that matters on the edge (a CPU-killed run is how cron-engagement lost 74 reminders on 09-26):
//   * the model gets a Telegram-made JPEG size (a photo size <= 1600 px) or the original image document, never a
//     re-encode;
//   * the dHash is computed from the SMALLEST useful variant (a photo size >= 200 px, or the document's thumbnail),
//     so a decode costs milliseconds; the original is decoded only when nothing smaller exists (and <= 1.5 MB);
//   * HEIC / WebP / anything the decoder cannot read falls back to Telegram's JPEG thumbnail; with no thumbnail the
//     submission's fingerprint is 'unavailable' (health: fingerprint_unavailable_7d) — spec G29.
// A dHash is resolution-robust (9x8 area average), so a 320-px variant and a thumbnail of the same screenshot land
// within a couple of bits of each other; SQL compares them with challenge_task_dhash_distance.

import type { ImageMediaType } from "../_shared/ai-label.ts";

export interface TgSize {
  file_id: string;
  width: number | null;
  height: number | null;
  file_size: number | null;
}

export type VisualKind = "photo" | "image_doc" | "video" | "video_doc" | "document" | "video_note" | "animation";

/** One visual item of a message. */
export interface VisualRef {
  kind: VisualKind;
  /** photo / image_doc: the item IS an image (counts as the Instagram screenshot and is fingerprinted). */
  isImage: boolean;
  /** What the model should see: a photo size <= 1600 px, or the original image document. */
  aiFileId: string | null;
  aiFileSize: number | null;
  /** The small variant the dHash is computed from (photo) — documents use their thumbnail. */
  hashFileId: string | null;
  /** Telegram's JPEG preview (documents, videos, video notes). */
  thumbFileId: string | null;
  mime: string | null;
  durationSec: number | null;
}

export interface AudioRef {
  kind: "voice" | "audio";
  durationSec: number | null;
}

export interface MessageMedia {
  visuals: VisualRef[];
  audio: AudioRef[];
}

const AI_MAX_SIDE = 1600;
const HASH_MIN_SIDE = 200;

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null;
}

function str(x: unknown): string | null {
  return typeof x === "string" && x.length > 0 && x.length <= 512 ? x : null;
}

function size(x: unknown): TgSize | null {
  if (!isObj(x)) return null;
  const id = str(x.file_id);
  if (!id) return null;
  return { file_id: id, width: num(x.width), height: num(x.height), file_size: num(x.file_size) };
}

function longSide(s: TgSize): number {
  return Math.max(s.width ?? 0, s.height ?? 0);
}

function area(s: TgSize): number {
  return (s.width ?? 0) * (s.height ?? 0);
}

/** The photo size the model sees: the largest with a long side <= 1600 px and <= maxBytes, else the smallest. */
export function pickAiSize(sizes: TgSize[], maxBytes: number): TgSize | null {
  if (sizes.length === 0) return null;
  const fit = sizes.filter((s) => longSide(s) > 0 && longSide(s) <= AI_MAX_SIDE && (s.file_size ?? 0) <= maxBytes);
  if (fit.length > 0) return fit.reduce((a, b) => (area(b) > area(a) ? b : a));
  return sizes.reduce((a, b) => (area(b) < area(a) ? b : a));
}

/** The photo size the dHash is computed from: the smallest with a long side >= 200 px, else the largest. */
export function pickHashSize(sizes: TgSize[]): TgSize | null {
  if (sizes.length === 0) return null;
  const big = sizes.filter((s) => longSide(s) >= HASH_MIN_SIDE);
  if (big.length > 0) return big.reduce((a, b) => (area(b) < area(a) ? b : a));
  return sizes.reduce((a, b) => (area(b) > area(a) ? b : a));
}

function thumbOf(o: Record<string, unknown>): string | null {
  return size(o.thumbnail)?.file_id ?? size(o.thumb)?.file_id ?? null;
}

/**
 * The visual and audio items of one Telegram Message (a Bot API object from webhook_inbox.raw_update or a Mini App
 * claim). Mirrors challenge_task_classify's kinds: image_doc / video_doc = a document whose mime is image/* / video/*;
 * a GIF (animation) or sticker is never work.
 */
export function extractMedia(msg: unknown, maxAiBytes: number): MessageMedia {
  const out: MessageMedia = { visuals: [], audio: [] };
  if (!isObj(msg)) return out;
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const sizes = msg.photo.map(size).filter((s): s is TgSize => s !== null);
    const ai = pickAiSize(sizes, maxAiBytes);
    const h = pickHashSize(sizes);
    if (ai) {
      out.visuals.push({
        kind: "photo", isImage: true, aiFileId: ai.file_id, aiFileSize: ai.file_size, hashFileId: h?.file_id ?? ai.file_id,
        thumbFileId: null, mime: "image/jpeg", durationSec: null,
      });
    }
  }
  if (!(("animation" in msg) || ("sticker" in msg)) && isObj(msg.document)) {
    const d = msg.document;
    const id = str(d.file_id);
    const mime = typeof d.mime_type === "string" ? d.mime_type.toLowerCase() : null;
    if (id) {
      const image = !!mime && mime.startsWith("image/");
      const video = !!mime && mime.startsWith("video/");
      out.visuals.push({
        kind: image ? "image_doc" : video ? "video_doc" : "document", isImage: image,
        aiFileId: image ? id : null, aiFileSize: num(d.file_size), hashFileId: null, thumbFileId: thumbOf(d), mime,
        durationSec: null,
      });
    }
  }
  if (isObj(msg.video)) {
    const v = msg.video;
    out.visuals.push({
      kind: "video", isImage: false, aiFileId: null, aiFileSize: null, hashFileId: null, thumbFileId: thumbOf(v),
      mime: typeof v.mime_type === "string" ? v.mime_type : null, durationSec: num(v.duration),
    });
  }
  if (isObj(msg.video_note)) {
    const v = msg.video_note;
    out.visuals.push({
      kind: "video_note", isImage: false, aiFileId: null, aiFileSize: null, hashFileId: null, thumbFileId: thumbOf(v),
      mime: null, durationSec: num(v.duration),
    });
  }
  for (const k of ["voice", "audio"] as const) {
    if (isObj(msg[k])) out.audio.push({ kind: k, durationSec: num((msg[k] as Record<string, unknown>).duration) });
  }
  return out;
}

/** Image type by magic bytes (never trust a declared mime). null = not something a provider accepts (HEIC, TIFF…). */
export function sniffImage(b: Uint8Array): ImageMediaType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a &&
    b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 &&
    b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/** Standard base64 (what both providers take), chunked so a multi-MB image never overflows the call stack. */
export function toBase64(b: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < b.length; i += CHUNK) s += String.fromCharCode(...b.subarray(i, i + CHUNK));
  return btoa(s);
}

// ─────────────────────────── dHash ───────────────────────────

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  rgba: Uint8Array | Uint8ClampedArray;
}

/** An image decoder (index.ts passes imagescript; tests pass a fake). null = cannot decode. */
export interface ImageCodec {
  decode(bytes: Uint8Array): Promise<DecodedImage | null>;
}

/**
 * The 64-bit difference hash: luminance area-averaged into a 9x8 grid (alpha composited on white), then bit =
 * left cell brighter than its right neighbour, row-major, most significant bit first -> 16 lowercase hex chars (the
 * format SQL's challenge_task_dhash_distance accepts). null for an image smaller than the grid or a bad buffer.
 */
export function dhashFromRgba(img: DecodedImage): string | null {
  const { width: w, height: h, rgba } = img;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 9 || h < 8 || rgba.length < w * h * 4) return null;
  const grid = new Float64Array(72);
  for (let cy = 0; cy < 8; cy++) {
    const y0 = Math.floor((cy * h) / 8), y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * h) / 8));
    for (let cx = 0; cx < 9; cx++) {
      const x0 = Math.floor((cx * w) / 9), x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * w) / 9));
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        let p = (y * w + x0) * 4;
        for (let x = x0; x < x1; x++, p += 4) {
          const a = rgba[p + 3] / 255;
          const lum = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
          sum += lum * a + 255 * (1 - a);
        }
      }
      grid[cy * 9 + cx] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  let hex = "";
  for (let cy = 0; cy < 8; cy++) {
    let byte = 0;
    for (let cx = 0; cx < 8; cx++) byte = (byte << 1) | (grid[cy * 9 + cx] > grid[cy * 9 + cx + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/** Hamming distance of two 16-hex dHashes (the TS twin of SQL challenge_task_dhash_distance; tests only). */
export function dhashDistance(a: string, b: string): number | null {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return null;
  let d = 0;
  for (let i = 0; i < 16; i += 8) {
    let x = parseInt(a.slice(i, i + 8), 16) ^ parseInt(b.slice(i, i + 8), 16);
    while (x) {
      d += x & 1;
      x >>>= 1;
    }
  }
  return d;
}

// ─────────────────────────── getFile + download ───────────────────────────

export type Download =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; systemic: boolean; reason: string };

// The only place this function talks to api.telegram.org: file RETRIEVAL (getFile + the file bytes), never a
// message send (sends go through _shared/telegram-send.ts). The token-bearing URL never reaches an error string:
// every failure below is a fixed reason code.
// eslint-disable-next-line no-restricted-syntax -- getFile / file-byte media retrieval, not a message send (like hw-image-url)
const TG_API = "https://api.telegram.org";

/**
 * getFile, then the bytes. systemic = worth retrying later without charging the row (network, timeout, Telegram
 * 429 / 5xx, a bad bot token); otherwise the file itself is the problem (too big, gone, wrong id).
 */
export async function downloadTelegramFile(
  fetchFn: typeof fetch, botToken: string, fileId: string, maxBytes: number, timeoutMs: number,
): Promise<Download> {
  if (!botToken) return { ok: false, systemic: true, reason: "bot_token_missing" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let gf: Response;
    try {
      gf = await fetchFn(`${TG_API}/bot${botToken}/getFile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: fileId }),
        signal: ctl.signal,
      });
    } catch {
      return { ok: false, systemic: true, reason: ctl.signal.aborted ? "getfile_timeout" : "getfile_network" };
    }
    // deno-lint-ignore no-explicit-any
    let gj: any = null;
    try {
      gj = await gf.json();
    } catch {
      return { ok: false, systemic: true, reason: "getfile_bad_json" };
    }
    if (!gf.ok || !gj?.ok) {
      const code = Number(gj?.error_code ?? gf.status);
      const systemic = code === 401 || code === 404 || code === 429 || code >= 500;
      return { ok: false, systemic, reason: `getfile_${Number.isFinite(code) ? code : "error"}` };
    }
    const path = typeof gj?.result?.file_path === "string" ? gj.result.file_path : null;
    const declared = Number(gj?.result?.file_size ?? 0);
    if (!path || !/^[A-Za-z0-9_./-]{1,256}$/.test(path)) return { ok: false, systemic: false, reason: "getfile_no_path" };
    if (declared > maxBytes) return { ok: false, systemic: false, reason: "file_too_big" };
    let fr: Response;
    try {
      fr = await fetchFn(`${TG_API}/file/bot${botToken}/${path}`, { signal: ctl.signal });
    } catch {
      return { ok: false, systemic: true, reason: ctl.signal.aborted ? "file_timeout" : "file_network" };
    }
    if (!fr.ok) {
      await fr.body?.cancel();
      return { ok: false, systemic: fr.status === 429 || fr.status >= 500, reason: `file_${fr.status}` };
    }
    let buf: ArrayBuffer;
    try {
      buf = await fr.arrayBuffer();
    } catch {
      return { ok: false, systemic: true, reason: ctl.signal.aborted ? "file_timeout" : "file_read" };
    }
    if (buf.byteLength === 0) return { ok: false, systemic: false, reason: "file_empty" };
    if (buf.byteLength > maxBytes) return { ok: false, systemic: false, reason: "file_too_big" };
    return { ok: true, bytes: new Uint8Array(buf) };
  } finally {
    clearTimeout(timer);
  }
}
