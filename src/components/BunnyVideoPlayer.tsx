import { forwardRef, useImperativeHandle, useEffect, useRef, useState } from "react";

interface Props {
  libraryId: string;
  videoGuid: string;
  watermarkEmail?: string;
  autoPlay?: boolean;
  /** Resume position in seconds (passed via ?t= to the iframe). */
  resumeSeconds?: number;
  /** Called ~every 5s with current playback time and duration. */
  onTimeUpdate?: (seconds: number, duration: number) => void;
  /** Called when the video reaches its natural end. */
  onEnded?: () => void;
}

export interface BunnyPlayerHandle {
  video: HTMLVideoElement | null;
}

// Loads Bunny's player.js SDK once. Returns the global playerjs object.
let playerJsPromise: Promise<any> | null = null;
function loadPlayerJs(): Promise<any> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if ((window as any).playerjs) return Promise.resolve((window as any).playerjs);
  if (playerJsPromise) return playerJsPromise;
  playerJsPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://assets.mediadelivery.net/playerjs/player-0.1.0.min.js";
    s.async = true;
    s.onload = () => resolve((window as any).playerjs);
    s.onerror = () => {
      // Fallback to the canonical playerjs CDN
      const s2 = document.createElement("script");
      s2.src = "https://cdn.embed.ly/player-0.1.0.min.js";
      s2.async = true;
      s2.onload = () => resolve((window as any).playerjs);
      s2.onerror = () => reject(new Error("playerjs failed to load"));
      document.head.appendChild(s2);
    };
    document.head.appendChild(s);
  });
  return playerJsPromise;
}

export const BunnyVideoPlayer = forwardRef<BunnyPlayerHandle, Props>(function BunnyVideoPlayer(
  { libraryId, videoGuid, watermarkEmail, autoPlay = false, resumeSeconds = 0, onTimeUpdate, onEnded },
  ref,
) {
  useImperativeHandle(ref, () => ({ video: null }), []);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const lastTickRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const durationRef = useRef<number>(0);
  const endedFiredRef = useRef<boolean>(false);

  const [wmStamp, setWmStamp] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!watermarkEmail) return;
    const id = window.setInterval(() => setWmStamp(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, [watermarkEmail]);

  // Build src with resume position
  const params = new URLSearchParams({
    autoplay: autoPlay ? "true" : "false",
    loop: "false",
    muted: "false",
    preload: "true",
  });
  const startAt = Math.max(0, Math.floor(resumeSeconds || 0));
  if (startAt > 0) params.set("t", String(startAt));
  const src = `https://iframe.mediadelivery.net/embed/${libraryId}/${videoGuid}?${params.toString()}`;

  // Wire player.js
  useEffect(() => {
    let cancelled = false;
    let player: any = null;
    let interval: number | null = null;

    loadPlayerJs()
      .then((playerjs) => {
        if (cancelled || !iframeRef.current || !playerjs) return;
        player = new playerjs.Player(iframeRef.current);
        player.on("ready", () => {
          if (typeof player.getDuration === "function") {
            player.getDuration((d: number) => {
              if (typeof d === "number" && d > 0) durationRef.current = d;
            });
          }
        });
        player.on("timeupdate", (e: { seconds?: number; duration?: number }) => {
          if (typeof e?.seconds === "number") lastTimeRef.current = e.seconds;
          if (typeof e?.duration === "number" && e.duration > 0) durationRef.current = e.duration;
        });
        player.on("ended", () => {
          if (endedFiredRef.current) return;
          endedFiredRef.current = true;
          const dur = durationRef.current || lastTimeRef.current;
          onTimeUpdate?.(dur, dur);
          onEnded?.();
        });

        // Throttled tick: every 5s while playing, push a progress update.
        interval = window.setInterval(() => {
          const now = Date.now();
          if (now - lastTickRef.current < 4500) return;
          if (lastTimeRef.current <= 0) return;
          lastTickRef.current = now;
          onTimeUpdate?.(lastTimeRef.current, durationRef.current || 0);
        }, 5000);
      })
      .catch((err) => {
        console.warn("[BunnyVideoPlayer] player.js unavailable:", err);
      });

    return () => {
      cancelled = true;
      if (interval) window.clearInterval(interval);
      try { player?.off?.("timeupdate"); player?.off?.("ended"); player?.off?.("ready"); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryId, videoGuid]);

  return (
    <div className="relative w-full aspect-video bg-black overflow-hidden rounded-lg">
      <iframe
        ref={iframeRef}
        src={src}
        loading="lazy"
        allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture;"
        allowFullScreen
        className="absolute inset-0 w-full h-full border-0"
        title="Bunny video player"
      />
      {watermarkEmail && (
        <div className="absolute bottom-2 right-2 pointer-events-none select-none text-white/40 text-xs font-mono bg-black/30 px-2 py-1 rounded">
          {watermarkEmail} · {wmStamp}
        </div>
      )}
    </div>
  );
});
