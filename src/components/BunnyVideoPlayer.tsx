import { forwardRef, useImperativeHandle, useEffect, useState } from "react";

// TODO: The supabase/functions/bunny-sign edge function is no longer used by
// playback (Bunny's iframe handles auth internally). It can be removed in a
// future cleanup pass once AdminBunnyDiagnostics is also retired.

interface Props {
  libraryId: string;
  videoGuid: string;
  watermarkEmail?: string;
  autoPlay?: boolean;
  // Kept for API compatibility with the previous custom player. Iframe embeds
  // do not expose timeupdate / ended events to the parent page, so these are
  // no-ops here.
  onTimeUpdate?: (seconds: number, duration: number) => void;
  onEnded?: () => void;
}

export interface BunnyPlayerHandle {
  // Iframe embeds do not give us access to the underlying <video> element.
  video: HTMLVideoElement | null;
}

export const BunnyVideoPlayer = forwardRef<BunnyPlayerHandle, Props>(function BunnyVideoPlayer(
  { libraryId, videoGuid, watermarkEmail, autoPlay = false },
  ref,
) {
  useImperativeHandle(ref, () => ({ video: null }), []);

  const [wmStamp, setWmStamp] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!watermarkEmail) return;
    const id = window.setInterval(() => setWmStamp(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, [watermarkEmail]);

  const params = new URLSearchParams({
    autoplay: autoPlay ? "true" : "false",
    loop: "false",
    muted: "false",
  });
  const src = `https://iframe.mediadelivery.net/embed/${libraryId}/${videoGuid}?${params.toString()}`;

  return (
    <div className="relative w-full aspect-video bg-black overflow-hidden rounded-lg">
      <iframe
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
