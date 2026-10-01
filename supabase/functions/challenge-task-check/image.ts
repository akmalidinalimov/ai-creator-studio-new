// challenge-task-check — the real image decoder (imagescript, the decoder Supabase's own edge examples use: JPEG /
// PNG / TIFF / GIF; HEIC and WebP throw "Unsupported image type", which becomes null -> the thumbnail fallback).
// imagescript loads its JPEG codec (WASM) from deno.land on the isolate's first decode; if that ever fails, decode()
// answers null, the submission's fingerprint is 'unavailable' and the run heartbeat shows hashes = 0 — visible, never
// a crash. Imported ONLY by index.ts: CI's `deno test` (no --allow-net) never loads it; the PGlite harness
// _challenge/testing/daily-tasks-ai-check-check.ts runs it on real JPEG / PNG bytes.

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
