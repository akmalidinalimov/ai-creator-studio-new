import { forwardRef, useImperativeHandle, useEffect, useRef } from "react";
import { reportClientError } from "@/lib/beacon";

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
  const lastTickPosRef = useRef<number>(0);
  const durationRef = useRef<number>(0);
  const endedFiredRef = useRef<boolean>(false);
  // Latest resume position, read once when the player is ready. Kept in a ref so
  // the iframe src does NOT depend on resumeSeconds (see below).
  const resumeRef = useRef<number>(resumeSeconds);
  resumeRef.current = resumeSeconds;

  // The iframe src is deliberately INDEPENDENT of resumeSeconds. Baking `?t=` into
  // the URL meant any later resumeSeconds change (a parent re-render after a token
  // refresh / tab-focus re-emit) rebuilt the src and RELOADED the video mid-play.
  // We resume via the player.js API on `ready` instead, so the src changes only
  // when the actual video (libraryId/videoGuid) does.
  const params = new URLSearchParams({
    autoplay: autoPlay ? "true" : "false",
    loop: "false",
    muted: "false",
    preload: "true",
  });
  const src = `https://iframe.mediadelivery.net/embed/${libraryId}/${videoGuid}?${params.toString()}`;

  // Wire player.js
  useEffect(() => {
    let cancelled = false;
    let player: any = null;
    let interval: number | null = null;
    // Stall detector: if playback STARTS but no `timeupdate` ever arrives (the Telegram-webview
    // "player loads but ticks never fire" failure → watched-but-no-credit), beacon it. Armed only on
    // `play`, disarmed on the first tick, so a merely-paused video never false-fires.
    let sawTick = false;
    let stallTimer: number | null = null;

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
          // Resume ONCE, via the API, to the last-watched position — never via the
          // iframe URL (which would reload the video). Progress has virtually always
          // loaded by the time `ready` fires (iframe + player.js network load is
          // slower than the DB read), so the ref holds the real resume value.
          const resumeAt = Math.max(0, Math.floor(resumeRef.current || 0));
          if (resumeAt > 0 && typeof player.setCurrentTime === "function") {
            player.setCurrentTime(resumeAt);
          }
        });
        player.on("timeupdate", (e: { seconds?: number; duration?: number }) => {
          if (!sawTick) {
            sawTick = true; // ticks work → disarm the stall detector
            if (stallTimer) { window.clearTimeout(stallTimer); stallTimer = null; }
          }
          if (typeof e?.seconds === "number") lastTimeRef.current = e.seconds;
          if (typeof e?.duration === "number" && e.duration > 0) durationRef.current = e.duration;
        });
        // Playback started: if no tick has arrived in 15s, the progress bridge is dead in this
        // webview — the student would watch the whole lesson and get no completion/XP. Make it loud.
        player.on("play", () => {
          if (sawTick || stallTimer) return;
          stallTimer = window.setTimeout(() => {
            stallTimer = null;
            if (sawTick) return;
            try {
              reportClientError({ type: "video_error", message: "no_timeupdate_ticks", extra: { lib: libraryId } });
            } catch { /* ignore */ }
          }, 15000);
        });
        player.on("ended", () => {
          if (endedFiredRef.current) return;
          endedFiredRef.current = true;
          const dur = durationRef.current || lastTimeRef.current;
          onTimeUpdate?.(dur, dur);
          onEnded?.();
        });

        // Throttled tick: every 5s while playing, push a progress update.
        // Also auto-fire `ended` when we're within 5s of the known duration —
        // Bunny's iframe `ended` event is unreliable across origins, so this
        // ensures completion is recorded even if it never fires.
        interval = window.setInterval(() => {
          const now = Date.now();
          if (now - lastTickRef.current < 4500) return;
          if (lastTimeRef.current <= 0) return;
          // Only count time if playback actually advanced since the last tick.
          // Bunny's `timeupdate` stops firing when paused, so a paused/backgrounded
          // tab would otherwise farm ~5s of watch-time per tick (inflating streaks,
          // daily goal and leaderboard). A stalled position ⇒ skip this tick.
          if (lastTimeRef.current <= lastTickPosRef.current + 0.5) {
            lastTickPosRef.current = lastTimeRef.current;
            return;
          }
          lastTickPosRef.current = lastTimeRef.current;
          lastTickRef.current = now;
          onTimeUpdate?.(lastTimeRef.current, durationRef.current || 0);
          if (
            !endedFiredRef.current &&
            durationRef.current > 0 &&
            lastTimeRef.current >= durationRef.current - 5
          ) {
            endedFiredRef.current = true;
            const dur = durationRef.current;
            onTimeUpdate?.(dur, dur);
            onEnded?.();
          }
        }, 5000);
      })
      .catch((err) => {
        console.warn("[BunnyVideoPlayer] player.js unavailable:", err);
        // Beacon: player.js failed to load → progress tracking + resume are degraded for this student.
        try {
          reportClientError({
            type: "video_error",
            message: `player.js load failed: ${err instanceof Error ? err.message : String(err)}`,
            extra: { lib: libraryId },
          });
        } catch { /* ignore */ }
      });

    return () => {
      cancelled = true;
      if (interval) window.clearInterval(interval);
      if (stallTimer) window.clearTimeout(stallTimer);
      try { player?.off?.("timeupdate"); player?.off?.("ended"); player?.off?.("ready"); player?.off?.("play"); } catch {}
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
          {watermarkEmail}
        </div>
      )}
    </div>
  );
});
