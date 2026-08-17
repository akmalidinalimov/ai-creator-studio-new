import { useEffect, useRef, useState, useCallback } from "react";
import { toast } from "sonner";
import { isTouchDevice, isTelegramWebView } from "@/lib/platform";

interface Settings {
  watermark: boolean;
  no_right_click: boolean;
  pause_on_blur: boolean;
  devtools_detect: boolean;
  hardened_controls: boolean;
}

const DEFAULTS: Settings = {
  watermark: true, no_right_click: true, pause_on_blur: true,
  devtools_detect: true, hardened_controls: true,
};

interface Props {
  src: string;
  watermarkText: string;
  /** Called periodically to refresh signed URL. Should return a fresh signed URL. */
  refreshSrc?: () => Promise<string | null>;
  videoRef?: React.RefObject<HTMLVideoElement>;
  settings?: Partial<Settings>;
}

const CORNERS = [
  { top: "8%", left: "6%" },
  { top: "8%", right: "6%" },
  { bottom: "12%", left: "6%" },
  { bottom: "12%", right: "6%" },
];

export function ProtectedVideo({ src, watermarkText, refreshSrc, videoRef: externalRef, settings }: Props) {
  const internalRef = useRef<HTMLVideoElement>(null);
  const videoRef = externalRef || internalRef;
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [s] = useState<Settings>({ ...DEFAULTS, ...(settings || {}) });
  // Anti-piracy heuristics (pause-on-blur, devtools-size check, FPS watchdog, keydown blocking)
  // false-positive badly on mobile and in the Telegram in-app webview — an app-switch, the mobile
  // URL bar, or a low-end GPU trip them and interrupt LEGITIMATE playback. Only run that aggressive
  // layer on non-touch desktop; the signed-URL + watermark protections still apply everywhere.
  const [aggressive] = useState(() => !isTouchDevice() && !isTelegramWebView());
  const [currentSrc, setCurrentSrc] = useState(src);
  const [wm, setWm] = useState({ text: watermarkText, pos: CORNERS[0] });
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const fpsToastFiredRef = useRef(false);

  // Sync incoming src
  useEffect(() => { setCurrentSrc(src); }, [src]);

  // Watermark rotation
  useEffect(() => {
    if (!s.watermark) return;
    const id = setInterval(() => {
      const pos = CORNERS[Math.floor(Math.random() * CORNERS.length)];
      setWm({ text: watermarkText, pos });
    }, 2000);
    return () => clearInterval(id);
  }, [s.watermark, watermarkText]);

  // Pause on blur / visibility change
  useEffect(() => {
    if (!s.pause_on_blur || !aggressive) return;
    const pause = () => { try { videoRef.current?.pause(); } catch {} };
    const onVis = () => { if (document.hidden) pause(); };
    window.addEventListener("blur", pause);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("blur", pause);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [s.pause_on_blur, aggressive, videoRef]);

  // DevTools detection
  useEffect(() => {
    if (!s.devtools_detect || !aggressive) return;
    const check = () => {
      const open =
        (window.outerHeight - window.innerHeight) > 200 ||
        (window.outerWidth - window.innerWidth) > 200;
      setDevtoolsOpen(open);
      if (open) { try { videoRef.current?.pause(); } catch {} }
    };
    check();
    const id = setInterval(check, 1000);
    return () => clearInterval(id);
  }, [s.devtools_detect, aggressive, videoRef]);

  // Block keyboard shortcuts (desktop only — touch devices have no physical shortcuts to block)
  useEffect(() => {
    if (!aggressive) return;
    const onKey = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // Ctrl/Cmd+S, Ctrl/Cmd+P
      if (meta && (key === "s" || key === "p")) { e.preventDefault(); return false; }
      // Ctrl+Shift+S
      if (e.ctrlKey && e.shiftKey && key === "s") { e.preventDefault(); return false; }
      // Cmd+Shift+3/4/5 (Mac screenshots)
      if (e.metaKey && e.shiftKey && (key === "3" || key === "4" || key === "5")) { e.preventDefault(); return false; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [aggressive]);

  // Signed-URL refresh every 25 minutes
  useEffect(() => {
    if (!refreshSrc) return;
    const id = setInterval(async () => {
      try {
        const fresh = await refreshSrc();
        if (!fresh || !videoRef.current) return;
        const v = videoRef.current;
        const wasPlaying = !v.paused;
        const t = v.currentTime;
        setCurrentSrc(fresh);
        // After src swap, restore position + play state
        requestAnimationFrame(() => {
          if (videoRef.current) {
            videoRef.current.currentTime = t;
            if (wasPlaying) videoRef.current.play().catch(() => {});
          }
        });
      } catch {}
    }, 25 * 60 * 1000);
    return () => clearInterval(id);
  }, [refreshSrc, videoRef]);

  // FPS watchdog (desktop only — low-end mobile GPUs drop below 30fps on normal playback)
  useEffect(() => {
    if (!aggressive) return;
    let raf = 0; let last = performance.now();
    const samples: number[] = [];
    let lowSeconds = 0;
    const tick = () => {
      const now = performance.now();
      const fps = 1000 / (now - last);
      last = now;
      samples.push(fps);
      if (samples.length > 60) samples.shift();
      // Once per second, check avg
      if (samples.length >= 30) {
        const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
        if (avg < 30) {
          lowSeconds += 1 / 30;
          if (lowSeconds > 5 && !fpsToastFiredRef.current) {
            fpsToastFiredRef.current = true;
            toast.message("Performance drop detected — screen recording or another heavy process may be running.");
          }
        } else {
          lowSeconds = 0;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [aggressive]);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    if (s.no_right_click) { e.preventDefault(); return false; }
  }, [s.no_right_click]);

  return (
    <div
      ref={wrapperRef}
      className="relative bg-black select-none"
      style={{ WebkitUserSelect: "none", WebkitTouchCallout: "none" } as any}
      onContextMenu={onContextMenu}
    >
      <video
        ref={videoRef}
        src={currentSrc}
        controls
        playsInline
        className="w-full aspect-video"
        onContextMenu={onContextMenu}
        controlsList={s.hardened_controls ? "nodownload noremoteplayback noplaybackrate" : undefined}
        disablePictureInPicture={s.hardened_controls}
        // @ts-ignore - non-standard but widely supported
        disableRemotePlayback={s.hardened_controls}
      />

      {s.watermark && (
        <div
          aria-hidden="true"
          className="absolute z-50 text-[13px] font-medium pointer-events-none transition-all duration-500"
          style={{
            ...wm.pos,
            opacity: 0.35,
            color: "white",
            textShadow: "0 1px 3px rgba(0,0,0,0.6)",
            mixBlendMode: "difference",
          }}
        >
          {wm.text}
        </div>
      )}

      {devtoolsOpen && (
        <div className="absolute inset-0 z-[60] bg-black/95 text-white flex flex-col items-center justify-center text-center p-6">
          <div className="text-lg font-semibold mb-2">Please close developer tools to continue.</div>
          <div className="text-sm text-white/70 max-w-md">
            For the security of course content, video playback is paused while developer tools are open.
          </div>
        </div>
      )}
    </div>
  );
}
