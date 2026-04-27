import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";
import Hls from "hls.js";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

interface Props {
  libraryId: string;
  videoGuid: string;
  watermarkEmail?: string;
  onTimeUpdate?: (seconds: number, duration: number) => void;
  onEnded?: () => void;
  autoPlay?: boolean;
}

export interface BunnyPlayerHandle {
  video: HTMLVideoElement | null;
}

const CORNERS = [
  { top: "8%", left: "6%" },
  { top: "8%", right: "6%" },
  { bottom: "12%", left: "6%" },
  { bottom: "12%", right: "6%" },
];

export const BunnyVideoPlayer = forwardRef<BunnyPlayerHandle, Props>(function BunnyVideoPlayer(
  { libraryId, videoGuid, watermarkEmail, onTimeUpdate, onEnded, autoPlay },
  ref,
) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const retriesRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [wm, setWm] = useState({ text: `${watermarkEmail || ""} • ${Date.now()}`, pos: CORNERS[0] });

  useImperativeHandle(ref, () => ({ video: videoRef.current }), []);

  const fetchSignedUrl = useCallback(async (): Promise<string> => {
    const { data, error } = await supabase.functions.invoke("bunny-sign", {
      body: { library_id: libraryId, video_guid: videoGuid },
    });
    if (error) throw new Error(error.message || "Failed to sign Bunny URL");
    if (!data?.signed_url) throw new Error("No signed URL returned");
    return data.signed_url as string;
  }, [libraryId, videoGuid]);

  const attach = useCallback(async (signedUrl: string) => {
    const video = videoRef.current;
    if (!video) return;

    // Clean up previous HLS instance
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    // Native HLS (Safari)
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = signedUrl;
      return;
    }

    if (Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      hlsRef.current = hls;
      hls.loadSource(signedUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, async (_evt, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && retriesRef.current < 3) {
          retriesRef.current += 1;
          try {
            const fresh = await fetchSignedUrl();
            const t = video.currentTime;
            const wasPlaying = !video.paused;
            hls.loadSource(fresh);
            hls.once(Hls.Events.MANIFEST_PARSED, () => {
              try { video.currentTime = t; if (wasPlaying) video.play().catch(() => {}); } catch {}
            });
          } catch (e) {
            setError((e as Error).message);
          }
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          try { hls.recoverMediaError(); } catch {}
        } else {
          setError(t("lesson.bunny.playbackError"));
        }
      });
    } else {
      setError(t("lesson.bunny.notSupported"));
    }
  }, [fetchSignedUrl, t]);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    retriesRef.current = 0;
    try {
      const url = await fetchSignedUrl();
      await attach(url);
      setLoading(false);
    } catch (e) {
      setLoading(false);
      setError((e as Error).message || t("lesson.bunny.signError"));
    }
  }, [fetchSignedUrl, attach, t]);

  // Initial load + on guid/library change
  useEffect(() => {
    if (!libraryId || !videoGuid) return;
    load();
    return () => {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      if (refreshTimerRef.current) { window.clearTimeout(refreshTimerRef.current); refreshTimerRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryId, videoGuid]);

  // Refresh signed URL every 25 minutes
  useEffect(() => {
    if (error) return;
    refreshTimerRef.current = window.setInterval(async () => {
      const video = videoRef.current;
      if (!video) return;
      try {
        const fresh = await fetchSignedUrl();
        const t = video.currentTime;
        const wasPlaying = !video.paused;
        if (hlsRef.current) {
          hlsRef.current.loadSource(fresh);
          hlsRef.current.once(Hls.Events.MANIFEST_PARSED, () => {
            try { video.currentTime = t; if (wasPlaying) video.play().catch(() => {}); } catch {}
          });
        } else {
          video.src = fresh;
          video.currentTime = t;
          if (wasPlaying) video.play().catch(() => {});
        }
      } catch (e) {
        console.warn("Bunny signed URL refresh failed", e);
      }
    }, 25 * 60 * 1000) as unknown as number;
    return () => {
      if (refreshTimerRef.current) { window.clearInterval(refreshTimerRef.current); refreshTimerRef.current = null; }
    };
  }, [fetchSignedUrl, error]);

  // Watermark rotation
  useEffect(() => {
    if (!watermarkEmail) return;
    const id = setInterval(() => {
      const pos = CORNERS[Math.floor(Math.random() * CORNERS.length)];
      setWm({ text: `${watermarkEmail} • ${Date.now()}`, pos });
    }, 2000);
    return () => clearInterval(id);
  }, [watermarkEmail]);

  // Time update / ended
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTu = () => onTimeUpdate?.(v.currentTime, v.duration || 0);
    const onEnd = () => onEnded?.();
    v.addEventListener("timeupdate", onTu);
    v.addEventListener("ended", onEnd);
    return () => {
      v.removeEventListener("timeupdate", onTu);
      v.removeEventListener("ended", onEnd);
    };
  }, [onTimeUpdate, onEnded]);

  if (error) {
    return (
      <div className="aspect-video w-full bg-black flex items-center justify-center p-6">
        <div className="max-w-md text-center text-white space-y-3">
          <div className="text-base font-semibold">{t("lesson.bunny.errorTitle")}</div>
          <div className="text-sm text-white/70">{error}</div>
          <Button variant="secondary" size="sm" onClick={load}>{t("common.retry")}</Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative bg-black select-none"
      style={{ WebkitUserSelect: "none", WebkitTouchCallout: "none" } as any}
      onContextMenu={(e) => e.preventDefault()}
    >
      <video
        ref={videoRef}
        controls
        playsInline
        preload="metadata"
        autoPlay={autoPlay}
        className="w-full aspect-video"
        controlsList="nodownload noremoteplayback noplaybackrate"
        disablePictureInPicture
        // @ts-ignore
        disableRemotePlayback
      />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-white/70 text-sm pointer-events-none">
          {t("lesson.bunny.loading")}
        </div>
      )}
      {watermarkEmail && (
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
    </div>
  );
});
