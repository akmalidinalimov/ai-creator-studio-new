import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, ImageOff, ExternalLink, Play, FileText, Link as LinkIcon, Loader2 } from "lucide-react";
import { Skeleton } from "@/components/ui-kit";
import { cn } from "@/lib/utils";
import { useMiniApp } from "@/lib/telegram/MiniAppContext";
import { resolveSubmissionMedia, fetchSubmissionMediaBlob, type ResolvedMedia, type QueueMedia } from "@/lib/teacherApi";

/**
 * GradePhoto — the submitted homework media for one grading card.
 *
 * Homework can be photo | video | document | link (often SEVERAL pieces in one submission — e.g. a
 * screen-recording video + the bot file). Media is resolved through the hw-image-url edge fn:
 *   - mode A lists every piece with a directly-loadable `url` (signed storage / external link) or
 *     `fetchable:true` (a Telegram file whose bytes stream via mode B — the bot token stays server-side).
 *   - photos load inline (tap → zoom lightbox); videos play in <video> on demand; documents open/inline;
 *     links open externally. Anything too large for Telegram's ~20MB getFile falls back per-piece to
 *     "Telegramda ochish" (the original message), so grading is never blocked.
 */

const DEGRADED_HINT: Record<string, string> = {
  media_too_large: "Fayl juda katta — Telegramda oching.",
  telegram_getfile_failed: "Faylni yuklab bo'lmadi — Telegramda oching.",
  image_unavailable: "Fayl endi mavjud emas — Telegramda oching.",
  no_viewable_media: "Ko'rish uchun media topilmadi.",
  submission_not_found: "Topshiriq topilmadi.",
  internal_error: "Xatolik — Telegramda ochib ko'ring.",
  request_failed: "Media yuklanmadi. Telegramda ochib ko'ring.",
};

const KIND_LABEL: Record<string, string> = { photo: "Rasm", video: "Video", document: "Hujjat", link: "Havola" };

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
  const [state, setState] = useState<
    { status: "loading" } | { status: "ready"; items: ResolvedMedia[] } | { status: "empty"; reason?: string }
  >({ status: "loading" });
  const [zoomSrc, setZoomSrc] = useState<string | null>(null);

  // Re-resolve whenever the card changes. `cancelled` drops a stale response so the wrong media can
  // never flash onto the new card.
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setZoomSrc(null);
    (async () => {
      const { items, reason } = await resolveSubmissionMedia(submissionId);
      if (cancelled) return;
      if (items.length === 0) setState({ status: "empty", reason });
      else setState({ status: "ready", items });
    })();
    return () => {
      cancelled = true;
    };
  }, [submissionId]);

  const openTg = useCallback(
    (url?: string | null) => {
      const target = url || firstMsgUrl(media);
      if (!target) return;
      const w = webApp as any;
      if (w?.openTelegramLink) w.openTelegramLink(target);
      else window.open(target, "_blank", "noopener,noreferrer");
    },
    [media, webApp],
  );

  if (state.status === "loading") {
    return <Skeleton className="h-[38vh] w-full rounded-lg" />;
  }

  if (state.status === "empty") {
    const msgUrl = firstMsgUrl(media);
    return (
      <DegradedCard
        hint={DEGRADED_HINT[state.reason || "no_viewable_media"] || DEGRADED_HINT.request_failed}
        onOpen={msgUrl ? () => openTg(msgUrl) : undefined}
      />
    );
  }

  const multi = state.items.length > 1;
  return (
    <>
      <div className="flex flex-col gap-2">
        {state.items.map((it) => (
          <div key={`${submissionId}:${it.index}`} className="flex flex-col gap-1">
            {multi && (
              <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                {KIND_LABEL[it.kind] || "Fayl"}
              </span>
            )}
            <MediaPiece submissionId={submissionId} item={it} alt={alt} onZoom={setZoomSrc} openTg={openTg} />
          </div>
        ))}
      </div>
      {zoomSrc && <Lightbox src={zoomSrc} alt={alt} onClose={() => setZoomSrc(null)} webApp={webApp} />}
    </>
  );
}

// ---- one media piece (photo / video / document / link) ----
type BlobState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; url: string; ct: string }
  | { status: "fail"; reason: string };

function MediaPiece({
  submissionId,
  item,
  alt,
  onZoom,
  openTg,
}: {
  submissionId: string;
  item: ResolvedMedia;
  alt: string;
  onZoom: (src: string) => void;
  openTg: (url?: string | null) => void;
}) {
  const kind = item.kind;
  const [blob, setBlob] = useState<BlobState>({ status: "idle" });
  const blobRef = useRef<string | null>(null);

  const revoke = () => {
    if (blobRef.current) {
      URL.revokeObjectURL(blobRef.current);
      blobRef.current = null;
    }
  };
  useEffect(() => () => revoke(), []);

  const load = useCallback(async () => {
    setBlob({ status: "loading" });
    const res = await fetchSubmissionMediaBlob(submissionId, item.index);
    if ("reason" in res) {
      setBlob({ status: "fail", reason: res.reason });
      return;
    }
    revoke();
    blobRef.current = res.blobUrl;
    setBlob({ status: "ok", url: res.blobUrl, ct: res.contentType });
  }, [submissionId, item.index]);

  // Photos are small → load inline immediately. Video/document load on demand (avoids downloading
  // large files the teacher may not open).
  useEffect(() => {
    if (item.fetchable && kind === "photo") void load();
  }, [item.fetchable, kind, load]);

  const tgFallback = item.msg_url ? () => openTg(item.msg_url) : undefined;

  // 1) Directly-loadable url (signed storage image, external link, or already-http media).
  if (item.url) {
    if (kind === "link") return <LinkTile url={item.url} />;
    if (kind === "video") return <VideoEl src={item.url} />;
    if (kind === "document") return <DocTile ready href={item.url} />;
    return <ImageTile src={item.url} alt={alt} onZoom={onZoom} />;
  }

  // 2) mode A already knows it's unresolvable (e.g. purged storage object).
  if (item.reason) {
    return <DegradedCard small hint={DEGRADED_HINT[item.reason] || DEGRADED_HINT.request_failed} onOpen={tgFallback} />;
  }

  // 3) Telegram file → stream bytes via mode B.
  if (item.fetchable) {
    if (blob.status === "fail") {
      return <DegradedCard small hint={DEGRADED_HINT[blob.reason] || DEGRADED_HINT.request_failed} onOpen={tgFallback} />;
    }
    if (kind === "photo") {
      if (blob.status === "ok") return <ImageTile src={blob.url} alt={alt} onZoom={onZoom} />;
      return <Skeleton className="h-[30vh] w-full rounded-lg" />;
    }
    if (kind === "video") {
      if (blob.status === "ok") return <VideoEl src={blob.url} autoPlay />;
      return <PlayTile label="Videoni ko'rish" loading={blob.status === "loading"} onClick={load} />;
    }
    // document (or any other fetchable kind)
    if (blob.status === "ok") {
      if (blob.ct.startsWith("image/")) return <ImageTile src={blob.url} alt={alt} onZoom={onZoom} />;
      if (blob.ct.startsWith("application/pdf")) {
        return <iframe title={alt} src={blob.url} className="h-[46vh] w-full rounded-lg border border-border bg-white" />;
      }
      return <DocTile ready href={blob.url} />;
    }
    return <DocTile label="Hujjatni ochish" loading={blob.status === "loading"} onClick={load} />;
  }

  return <DegradedCard small hint={DEGRADED_HINT.no_viewable_media} onOpen={tgFallback} />;
}

// ---- presentational pieces ----
function ImageTile({ src, alt, onZoom }: { src: string; alt: string; onZoom: (src: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onZoom(src)}
      aria-label="Rasmni kattalashtirish"
      className="block w-full overflow-hidden rounded-lg border border-border bg-black/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <img
        src={src}
        alt={alt}
        className="mx-auto max-w-full object-contain"
        style={{ maxHeight: "min(42vh, calc(var(--tg-viewport-stable-height, 100vh) * 0.42))" }}
      />
    </button>
  );
}

function VideoEl({ src, autoPlay }: { src: string; autoPlay?: boolean }) {
  return (
    <video
      src={src}
      controls
      autoPlay={autoPlay}
      playsInline
      className="w-full rounded-lg border border-border bg-black"
      style={{ maxHeight: "min(46vh, calc(var(--tg-viewport-stable-height, 100vh) * 0.46))" }}
    />
  );
}

function PlayTile({ label, loading, onClick }: { label: string; loading: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="relative grid h-[30vh] w-full place-items-center overflow-hidden rounded-lg border border-border bg-black/40 transition-colors hover:bg-black/30 disabled:opacity-80"
    >
      <div className="flex flex-col items-center gap-2 text-foreground">
        {loading ? (
          <Loader2 className="size-9 animate-spin text-primary" aria-hidden />
        ) : (
          <span className="grid size-14 place-items-center rounded-full bg-primary text-primary-foreground">
            <Play className="size-7" style={{ marginLeft: 3 }} aria-hidden />
          </span>
        )}
        <span className="text-[13px] font-bold">{loading ? "Yuklanmoqda…" : label}</span>
      </div>
    </button>
  );
}

// Document: `href` (ready to open in a new tab, via an anchor so it isn't popup-blocked) OR a button
// that fetches the bytes first (`onClick`).
function DocTile({
  ready,
  href,
  label = "Hujjatni ochish",
  loading,
  onClick,
}: {
  ready?: boolean;
  href?: string;
  label?: string;
  loading?: boolean;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <span className="grid size-11 place-items-center rounded-lg bg-tint text-foreground">
        {loading ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <FileText className="size-5" aria-hidden />}
      </span>
      <span className="text-[13px] font-bold text-foreground">{loading ? "Yuklanmoqda…" : label}</span>
    </>
  );
  const cls =
    "flex min-h-[56px] w-full items-center gap-3 rounded-lg border border-border bg-surface-2 px-4 py-3 text-left transition-colors hover:bg-tint/30";
  if (ready && href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
        {inner}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} disabled={loading} className={cn(cls, "disabled:opacity-80")}>
      {inner}
    </button>
  );
}

function LinkTile({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex min-h-[56px] w-full items-center gap-3 rounded-lg border border-border bg-surface-2 px-4 py-3 transition-colors hover:bg-tint/30"
    >
      <span className="grid size-11 place-items-center rounded-lg bg-tint text-foreground">
        <LinkIcon className="size-5" aria-hidden />
      </span>
      <span className="truncate text-[13px] font-bold text-primary">{url}</span>
    </a>
  );
}

function DegradedCard({ hint, onOpen, small }: { hint: string; onOpen?: () => void; small?: boolean }) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2 rounded-lg border border-border bg-surface-2 text-center",
        small ? "px-4 py-4" : "px-4 py-7",
      )}
    >
      <ImageOff className={cn("text-muted-foreground", small ? "size-5" : "size-7")} aria-hidden />
      <p className="max-w-[30ch] text-xs font-semibold text-muted-foreground">{hint}</p>
      {onOpen && (
        <button
          type="button"
          onClick={onOpen}
          className="mt-1 inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-tint px-3 text-[13px] font-bold text-foreground transition-colors hover:bg-tint/70"
        >
          <ExternalLink className="size-4" />
          Telegramda ochish
        </button>
      )}
    </div>
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
    webApp?.disableVerticalSwipes?.();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
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
    e.stopPropagation();
    const now = Date.now();
    if (now - lastTap.current < 300) {
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
