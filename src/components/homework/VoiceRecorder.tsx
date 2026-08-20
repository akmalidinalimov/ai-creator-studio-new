import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mic, MicOff, RotateCcw, Square, Trash2 } from "lucide-react";
import { Mp3Encoder } from "@breezystack/lamejs";
import { Button } from "@/components/ui-kit";

/**
 * VoiceRecorder — shared mic-record → client MP3 encode → preview control.
 *
 * Used by teacher grading screens (Mini App `TeacherGrade` + web `TeacherProfile` /
 * `TeacherHomework`, wired in Task 3) to attach an optional voice note alongside text feedback.
 * Fully self-contained: owns the mic stream, the Web Audio capture graph, and the MP3 encode — the
 * parent only ever sees a finalized `audio/mpeg` Blob via `onChange` (or `null` on clear).
 *
 * CAPTURE PATH (why Web Audio + ScriptProcessorNode, not MediaRecorder): MediaRecorder only
 * produces compressed containers (webm/opus on Chrome/Android — unplayable on iOS Safari, and not
 * raw PCM an MP3 encoder can consume). Instead: getUserMedia → AudioContext →
 * MediaStreamAudioSourceNode → ScriptProcessorNode accumulates raw Float32 PCM frames as they
 * arrive; on stop we concatenate them, resample to a fixed 22.05 kHz (small + clear for speech,
 * and within lamejs's supported input rates regardless of the mic's native rate — commonly 44.1 or
 * 48 kHz), convert to 16-bit PCM, and encode to MP3 with lamejs at 64 kbps mono. AudioWorklet would
 * be the modern replacement but needs a separately-loaded module file; ScriptProcessorNode (though
 * deprecated) needs no extra asset and runs everywhere this app does, including Telegram's in-app
 * webview — the brief's explicit "pick what builds + works reliably in a webview" tradeoff.
 *
 * CAPS: 2:00 hard auto-stop (checked on a recording-elapsed interval). ~4 MB post-encode size cap —
 * an over-cap blob is discarded with an inline error, never handed to the parent.
 *
 * FALLBACK (mic blocked/unsupported — a real risk in the Telegram webview per the design doc's
 * risk list): if `navigator.mediaDevices.getUserMedia` doesn't exist, or requesting it throws or is
 * denied, the component renders a disabled reason row and NEVER throws — the parent's text-feedback
 * path must keep working regardless of mic availability.
 */

const MAX_DURATION_MS = 2 * 60 * 1000; // 2:00 hard cap (brief)
const MAX_SIZE_BYTES = 4 * 1024 * 1024; // ~4 MB post-encode cap (brief)
const TARGET_SAMPLE_RATE = 22050; // small + clear for speech (brief: 22.05–44.1 kHz range)
const MP3_KBPS = 64; // brief: ~64–96 kbps
const MIN_DURATION_MS = 300; // guard against an accidental tap producing a near-empty blob
const ENCODE_BLOCK_SIZE = 1152; // lamejs's expected per-call PCM frame size

const NO_MIC_REASON = "Mikrofon mavjud emas — matn yozing yoki botdan ovoz yuboring";

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function floatTo16BitPCM(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// Linear-interpolation resample — good enough for speech and avoids pulling in a resampler dep.
function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const idx0 = Math.floor(srcPos);
    const idx1 = Math.min(idx0 + 1, input.length - 1);
    const frac = srcPos - idx0;
    out[i] = input[idx0] * (1 - frac) + input[idx1] * frac;
  }
  return out;
}

function concatFloat32(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function encodeMp3Mono(samples: Int16Array, sampleRate: number, kbps: number): Blob {
  const encoder = new Mp3Encoder(1, sampleRate, kbps);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < samples.length; i += ENCODE_BLOCK_SIZE) {
    const buf = encoder.encodeBuffer(samples.subarray(i, i + ENCODE_BLOCK_SIZE));
    if (buf.length > 0) chunks.push(buf);
  }
  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(tail);
  return new Blob(chunks, { type: "audio/mpeg" });
}

function getUserMediaSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

export interface VoiceRecorderProps {
  value: Blob | null;
  onChange: (mp3: Blob | null) => void;
  disabled?: boolean;
}

export function VoiceRecorder({ value, onChange, disabled }: VoiceRecorderProps): JSX.Element {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [encoding, setEncoding] = useState(false);
  const [unavailable, setUnavailable] = useState(!getUserMediaSupported());
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const chunksRef = useRef<Float32Array[]>([]);
  const startedAtRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stoppingRef = useRef(false); // guards against a double-stop (hard cap racing a manual tap)

  // Preview object URL mirrors `value` — created/revoked on every change, and on unmount, so no
  // blob: URL ever leaks.
  useEffect(() => {
    if (!value) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(value);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [value]);

  const teardownCapture = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (processorRef.current) processorRef.current.onaudioprocess = null;
    processorRef.current?.disconnect();
    processorRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    gainRef.current?.disconnect();
    gainRef.current = null;
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  // No leaked mic/track/AudioContext if the parent unmounts mid-recording (e.g. navigating away
  // from the grading screen while the mic is live).
  useEffect(() => {
    return () => teardownCapture();
  }, [teardownCapture]);

  const finishRecording = useCallback(() => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    setRecording(false);

    const elapsed = Date.now() - startedAtRef.current;
    const nativeRate = audioCtxRef.current?.sampleRate ?? 44100;
    const chunks = chunksRef.current;
    chunksRef.current = [];
    teardownCapture();

    if (elapsed < MIN_DURATION_MS || chunks.length === 0) {
      // Accidental tap-and-release — discard silently, back to idle, no error noise.
      stoppingRef.current = false;
      return;
    }

    setEncoding(true);
    // Defer the CPU-heavy encode a tick so the "Qayta ishlanmoqda…" state actually paints before
    // the main thread gets busy — encoding up to 2 minutes of audio synchronously is fine for this
    // duration cap, just not instant.
    setTimeout(() => {
      try {
        const pcm = concatFloat32(chunks);
        const resampled = resampleLinear(pcm, nativeRate, TARGET_SAMPLE_RATE);
        const int16 = floatTo16BitPCM(resampled);
        const blob = encodeMp3Mono(int16, TARGET_SAMPLE_RATE, MP3_KBPS);
        if (blob.size > MAX_SIZE_BYTES) {
          setError("Ovozli xabar juda katta (4 MB dan oshdi). Qisqaroq yozib ko'ring.");
          onChange(null);
        } else {
          setError(null);
          onChange(blob);
        }
      } catch {
        setError("Ovozni qayta ishlab bo'lmadi. Qayta urinib ko'ring.");
        onChange(null);
      } finally {
        setEncoding(false);
        stoppingRef.current = false;
      }
    }, 0);
  }, [onChange, teardownCapture]);

  const startRecording = useCallback(async () => {
    if (recording || encoding) return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const AudioContextCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) throw new Error("no-audio-context");
      const audioCtx = new AudioContextCtor();
      audioCtxRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      sourceRef.current = source;
      // ScriptProcessorNode over AudioWorklet: no separate module asset to load — the simplest
      // thing that builds + runs reliably in a Telegram in-app webview (see header comment).
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      // Silent sink: a ScriptProcessorNode only fires `onaudioprocess` once connected through to
      // the destination, but connecting the mic straight to speakers would echo it back live — a
      // zero-gain node keeps the graph "pulled" without any audible output.
      const gain = audioCtx.createGain();
      gain.gain.value = 0;
      gainRef.current = gain;

      chunksRef.current = [];
      processor.onaudioprocess = (e) => {
        chunksRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };

      source.connect(processor);
      processor.connect(gain);
      gain.connect(audioCtx.destination);

      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setRecording(true);
      tickRef.current = setInterval(() => {
        const ms = Date.now() - startedAtRef.current;
        setElapsedMs(ms);
        if (ms >= MAX_DURATION_MS) finishRecording();
      }, 200);
    } catch {
      // Missing device, denied permission, blocked webview — never throw. Degrade to the same
      // disabled fallback as "unsupported" so the parent's text feedback keeps working.
      teardownCapture();
      setRecording(false);
      setUnavailable(true);
    }
  }, [recording, encoding, finishRecording, teardownCapture]);

  const handleDelete = useCallback(() => {
    setError(null);
    onChange(null);
  }, [onChange]);

  const handleReRecord = useCallback(() => {
    onChange(null);
    void startRecording();
  }, [onChange, startRecording]);

  const retrySupport = useCallback(() => {
    setUnavailable(false);
    setError(null);
  }, []);

  // ---- states -------------------------------------------------------------------------------

  if (unavailable) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2.5">
        <MicOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-[12.5px] font-semibold leading-snug text-muted-foreground">{NO_MIC_REASON}</p>
          {!disabled && (
            <button
              type="button"
              onClick={retrySupport}
              className="text-[11.5px] font-bold text-foreground underline underline-offset-2"
            >
              Qayta urinish
            </button>
          )}
        </div>
      </div>
    );
  }

  if (value) {
    return (
      <div className="min-w-0 space-y-2 rounded-lg border border-border bg-surface-2 p-3">
        {previewUrl && <audio controls src={previewUrl} className="w-full" />}
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" block disabled={disabled} onClick={handleReRecord}>
            <RotateCcw className="size-4" />
            Qayta yozish
          </Button>
          <Button type="button" variant="ghost" size="sm" block disabled={disabled} onClick={handleDelete}>
            <Trash2 className="size-4" />
            O'chirish
          </Button>
        </div>
      </div>
    );
  }

  if (encoding) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2.5">
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
        <span className="text-[13px] font-bold text-foreground">Qayta ishlanmoqda…</span>
      </div>
    );
  }

  if (recording) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2.5">
        <span className="relative flex size-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75" />
          <span className="relative inline-flex size-2.5 rounded-full bg-danger" />
        </span>
        <span className="flex-1 text-sm font-extrabold tabular-nums text-foreground">
          {formatElapsed(elapsedMs)} / 2:00
        </span>
        <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={finishRecording}>
          <Square className="size-4" />
          To'xtatish
        </Button>
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-1.5">
      <Button type="button" variant="ghost" block disabled={disabled} onClick={() => void startRecording()}>
        <Mic className="size-4" />
        Ovozli izoh yozish
      </Button>
      {error && <p className="text-xs font-semibold text-danger-2">{error}</p>}
    </div>
  );
}
