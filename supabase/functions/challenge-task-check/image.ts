// challenge-task-check — the real image decoder (imagescript: pure JS/WASM, JPEG / PNG / TIFF / GIF; HEIC and WebP
// throw "Unsupported image type", which becomes null -> the thumbnail fallback in check.ts).
// Kept out of media.ts so the pure dHash code and its unit tests never depend on the decoder.

import { decode, Image } from "https://deno.land/x/imagescript@1.3.0/mod.ts";
import type { DecodedImage, ImageCodec } from "./media.ts";

/** Never decode something large on the edge's CPU budget: the dHash is computed from a small variant anyway. */
export const MAX_DECODE_BYTES = 1_500_000;

export const imagescriptCodec: ImageCodec = {
  async decode(bytes: Uint8Array): Promise<DecodedImage | null> {
    if (bytes.length === 0 || bytes.length > MAX_DECODE_BYTES) return null;
    try {
      const img = await decode(bytes);
      if (!(img instanceof Image)) return null; // an animated GIF (a GIF object of frames) is never a screenshot
      return { width: img.width, height: img.height, rgba: img.bitmap };
    } catch {
      return null;
    }
  },
};
