import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, ImageOff, ExternalLink } from "lucide-react";
import { Skeleton } from "@/components/ui-kit";
import { cn } from "@/lib/utils";
import { useMiniApp } from "@/lib/telegram/MiniAppContext";
import { resolveImageUrl, type QueueMedia } from "@/lib/teacherApi";

/**
 * GradePhoto — the homework photo for one grading card.
 *
 * The image is resolved through the hw-image-url edge fn (Task 2), which handles BOTH storage-bucket
 * uploads (signed URL) and Telegram-`file_id`-only bot captures (server-side getFile → token-free
 * data: URL). Because a large share of bot-captured homework is Telegram-hosted-only — and images can
 * be purged, non-image, or oversized — the degraded "rasmni ko'rib bo'lmadi — botda oching" state is
 * a COMMON path, not an edge case: it offers an "open in Telegram" affordance (from the media's
 * msg_url) so the teacher can still see the work in the bot chat.
 *
 * On success the photo taps to a full-screen portal lightbox with pinch-zoom + pan + double-tap, and
 * (in Telegram) disables the WebApp's vertical swipe-to-close so a pan gesture can't dismiss the app.
 */

const DEGRADED_HINT: Record<string, string> = {
  non_image_media: "Bu topshiriq rasm emas (video yoki hujjat).",
  image_too_large: "Rasm juda katta — Telegramda oching.",
  telegram_getfile_failed: "Rasmni yuklab bo'lmadi — Telegramda oching.",
  image_unavailable: "Rasm endi mavjud emas — Telegramda oching.",
  no_viewable_media: "Ko'rish uchun rasm topilmadi.",
  request_failed: "Rasmni yuklab bo'lmadi. Telegramda ochib ko'ring.",
};

function firstMsgUrl(media: QueueMedia[] | null | undefined): string | null {
  if (!Array.isArray(media)) return null;
  for (const m of media) {
    if (typeof m?.msg_url === "string" && /^https?:\/\//i.test(m.msg_url)) return m.msg_url;
  }
  return null;
}

export function GradePhoto({
  submissionId,
  media,
  alt,
}: {
  submissionId: string;
  media: QueueMedia[] | null;
  alt: string;
}) {
  const { webApp } = useMiniApp();
  const [state, setState] = useState<{ status: "loading" } | { status: "ok"; url: string } | { status: "degraded"; reason: string }>({
    status: "loading",
  });
  const [zoom, setZoom] = useState(false);

  // Re-resolve whenever the card changes. A cancelled flag drops a stale response from a previous
  // submission so the wrong photo can never flash onto the new card.
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setZoom(false);
    (async () => {
      const res = await resolveImageUrl(submissionId);
      if (cancelled) return;
      if (res.url === null) setState({ status: "degraded", reason: res.reason });
      else setState({ status: "ok", url: res.url });
    })();
    return () => {
      cancelled = true;
    };
  }, [submissionId]);

  const msgUrl = firstMsgUrl(media);
  const openInTelegram = useCallback(() => {
    if (!msgUrl) return;
    const w = webApp as any;
    if (w?.openTelegramLink) w.openTelegramLink(msgUrl);
    else window.open(msgUrl, "_blank", "noopener,noreferrer");
  }, [msgUrl, webApp]);

  if (state.status === "loading") {
    return <Skeleton className="h-[38vh] w-full rounded-lg" />;
  }

  if (state.status === "degraded") {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface-2 px-4 py-7 text-center">
        <ImageOff className="size-7 text-muted-foreground" aria-hidden />
        <p className="text-sm font-bold text-foreground">Rasmni ko'rib bo'lmadi</p>
        <p className="max-w-[28ch] text-xs font-semibold text-muted-foreground">
          {DEGRADED_HINT[state.reason] || DEGRADED_HINT.request_failed}
        </p>
        {msgUrl && (
          <button
            type="button"
            onClick={openInTelegram}
            className="mt-1 inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-tint px-3 text-[13px] font-bold text-foreground transition-colors hover:bg-tint/70"
          >
            <ExternalLink className="size-4" />
            Telegramda ochish
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setZoom(true)}
        aria-label="Rasmni kattalashtirish"
        className="block w-full overflow-hidden rounded-lg border border-border bg-black/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <img
          src={state.url}
          alt={alt}
          // Cap the photo below the fold (stable viewport) so the score chips + coral primary stay
          // visible without scrolling — and stay reachable when the feedback keyboard opens.
          className="mx-auto max-w-full object-contain"
          style={{ maxHeight: "min(42vh, calc(var(--tg-viewport-stable-height, 100vh) * 0.42))" }}
        />
      </button>
      {zoom && <Lightbox src={state.url} alt={alt} onClose={() => setZoom(false)} webApp={webApp} />}
    </>
  );
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

// Full-screen zoomable lightbox (portal to <body>). Pointer-events pinch + pan; double-tap toggles
// 1× ↔ 2.5×. Self-contained (no external lib) so typecheck/build stay clean.
function Lightbox({
  src,
  alt,
  onClose,
  webApp,
}: {
  src: string;
  alt: string;
  onClose: () => void;
  webApp: ReturnType<typeof useMiniApp>["webApp"];
}) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const lastDist = useRef<number | null>(null);
  const lastTap = useRef(0);

  useEffect(() => {
    // In Telegram, a downward pan would otherwise trigger swipe-to-close on the whole Mini App.
    webApp?.disableVerticalSwipes?.();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      // Restore the app DEFAULT (swipe-to-close DISABLED — set by useTelegramViewport in the shell),
      // NOT enableVerticalSwipes. The shell owns the default; the lightbox must leave it as it found
      // it, or a later downward scroll while grading could accidentally close the Mini App.
      webApp?.disableVerticalSwipes?.();
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [webApp, onClose]);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    const prev = pointers.current.get(e.pointerId)!;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    if (pts.length >= 2) {
      const d = dist(pts[0], pts[1]);
      if (lastDist.current != null && lastDist.current > 0) {
        setScale((s) => clamp(s * (d / lastDist.current!), 1, 5));
      }
      lastDist.current = d;
    } else if (pts.length === 1 && scale > 1) {
      setTx((t) => t + (e.clientX - prev.x));
      setTy((t) => t + (e.clientY - prev.y));
    }
  };

  const endPointer = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) lastDist.current = null;
    // Snap back to centered when fully zoomed out.
    setScale((s) => {
      if (s <= 1.02) {
        setTx(0);
        setTy(0);
        return 1;
      }
      return s;
    });
  };

  const onImgClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // don't let a tap on the image bubble to the backdrop-close
    const now = Date.now();
    if (now - lastTap.current < 300) {
      // double-tap: toggle zoom
      if (scale > 1) {
        setScale(1);
        setTx(0);
        setTy(0);
      } else {
        setScale(2.5);
      }
    }
    lastTap.current = now;
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 animate-fade-in"
      style={{ touchAction: "none" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        aria-label="Yopish"
        className="absolute right-3 top-3 z-10 grid size-10 place-items-center rounded-full bg-white/12 text-white backdrop-blur-sm"
        style={{ top: "calc(env(safe-area-inset-top) + 0.75rem)" }}
      >
        <X className="size-5" />
      </button>
      <img
        src={src}
        alt={alt}
        draggable={false}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onClick={onImgClick}
        className={cn("max-h-full max-w-full select-none object-contain")}
        style={{
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          transition: pointers.current.size ? "none" : "transform 120ms ease-out",
          touchAction: "none",
          cursor: scale > 1 ? "grab" : "zoom-in",
        }}
      />
    </div>,
    document.body,
  );
}
