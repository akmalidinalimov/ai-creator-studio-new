import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FileText, ImagePlus, Loader2, Play, Send, X } from "lucide-react";
import { useMiniApp } from "@/lib/telegram/MiniAppContext";
import { Button } from "@/components/ui-kit";
import { impersonatingReadonly } from "@/lib/mutate";
import {
  acceptsFile, DT_OPEN_TIME, effectiveKind, fileKindOf, maxFilesFor, newRequestId, pickerAccept, pickKinds, requiresHint,
  submitDailyTask, type FileKind, type PrepareTask, type SubmitAnswer,
} from "@/lib/dailyTasks";

/* The «Ilovadan topshirish» form of one daily task (Daily Tasks PR-7, spec §12).
 *
 * The files and the text go to submit-daily-task, which reposts them into the student's own group «Kunlik vazifalar»
 * topic as the bot (a plain caption naming the student) and hands them to the engine, which decides status and
 * points. One request id per form: a retry of the SAME form (network drop, Telegram busy) reuses it, so the server
 * never posts the same work twice and keeps the first claim time (a 23:59 submission stays on time). A definitive
 * answer (accepted / refused / invalid) starts a fresh id.
 *
 * While an admin previews as the student (impersonatingReadonly) the form is read-only and nothing is sent — the
 * expected no-op, never an error and never beaconed (spec G12).
 */

const MAX_ITEMS = 10; // mirrors submit-daily-task
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TEXT = 3500;

type Picked = { id: string; file: File; previewUrl: string | null; kind: FileKind; mime: string };

const JPEG_OK = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

/** A photo Telegram will take: big or exotic (HEIC) images are re-encoded to JPEG in the webview when it can decode
 *  them; anything that fails goes as-is (the server then sends it as a document — still a screenshot to the engine). */
async function toUploadable(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || (JPEG_OK.has(file.type) && file.size <= 1.5 * 1024 * 1024)) return file;
  try {
    const blob = await new Promise<Blob>((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * scale));
        c.height = Math.max(1, Math.round(img.height * scale));
        const ctx = c.getContext("2d");
        if (!ctx) { reject(new Error("canvas")); return; }
        ctx.drawImage(img, 0, 0, c.width, c.height);
        c.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/jpeg", 0.85);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
      img.src = url;
    });
    return new File([blob], (file.name || "screenshot").replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

export interface DailyTaskSubmitProps {
  task: PrepareTask;
  topicUrl: string | null;
  /** prepare's limits.caption_text_max: the room the text has in the caption under this student's header. A longer
   *  text is posted as its own message, so it leaves room for one file fewer (at most 10 messages per request). */
  captionTextMax?: number | null;
  /** Called after the engine answered (the page reloads its data). */
  onDone: () => void;
}

export default function DailyTaskSubmit({ task, topicUrl, captionTextMax, onDone }: DailyTaskSubmitProps) {
  const { t } = useTranslation();
  const { webApp } = useMiniApp();
  const [items, setItems] = useState<Picked[]>([]);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showFallback, setShowFallback] = useState(false);
  const requestId = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const itemsRef = useRef<Picked[]>([]);
  itemsRef.current = items;
  const readonly = impersonatingReadonly();

  useEffect(() => () => { for (const it of itemsRef.current) if (it.previewUrl) URL.revokeObjectURL(it.previewUrl); }, []);

  const accepts = task.accepts ?? [];
  const accept = pickerAccept(accepts);
  const takesText = accepts.includes("text") || accepts.includes("link");
  // 10 files, or 9 with a text too long for the caption (the server refuses 11 messages before posting anything)
  const maxItems = maxFilesFor(text, captionTextMax);
  const overCap = items.length > maxItems;
  const hint = useMemo(
    () => requiresHint(task.requires ?? [], { kinds: items.flatMap((i) => pickKinds(i.kind, i.mime)), text }),
    [task.requires, items, text],
  );

  // Any edit after an answer is a new submission: a new request id.
  const touched = () => { requestId.current = null; };

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files || []);
    e.target.value = "";
    if (!list.length) return;
    const picked: Picked[] = [];
    let tooBig = false, off = false;
    for (const f of list) {
      if (f.size > MAX_FILE_BYTES) { tooBig = true; continue; }
      // an image the webview can re-encode to JPEG (toUploadable) goes as a photo when the task takes photos
      const raw: FileKind = f.type.startsWith("image/") && accepts.includes("photo") ? "photo" : fileKindOf(f.type, f.size);
      const kind = effectiveKind(raw, accepts);
      if (!acceptsFile(accepts, kind, f.type)) { off = true; continue; }
      picked.push({ id: newRequestId(), file: f, kind, mime: f.type || "",
                    previewUrl: f.type.startsWith("image/") || f.type.startsWith("video/") ? URL.createObjectURL(f) : null });
    }
    if (picked.length) {
      touched();
      setItems((prev) => {
        const room = maxItems - prev.length;
        for (const it of picked.slice(Math.max(0, room))) if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
        if (picked.length > room) {
          toast.error(maxItems < MAX_ITEMS
            ? t("dailyTasks.submit.errors.too_many_files_with_text", { max: maxItems })
            : t("dailyTasks.submit.errors.too_many_files", { max: MAX_ITEMS }));
        }
        return [...prev, ...picked.slice(0, Math.max(0, room))];
      });
    }
    if (tooBig) toast.error(t("dailyTasks.submit.errors.file_too_large"));
    else if (off && !picked.length) toast.error(t("dailyTasks.submit.errors.kind_not_accepted"));
  };

  const remove = (id: string) => {
    if (submitting) return;
    touched();
    setItems((prev) => {
      const x = prev.find((p) => p.id === id);
      if (x?.previewUrl) URL.revokeObjectURL(x.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  };

  const reset = () => {
    setItems((prev) => { for (const it of prev) if (it.previewUrl) URL.revokeObjectURL(it.previewUrl); return []; });
    setText("");
    setShowFallback(false);
    requestId.current = null;
  };

  const labelList = (missing: unknown) =>
    (Array.isArray(missing) ? missing : []).map((l) => t(`dailyTasks.labels.${String(l)}`, { defaultValue: String(l) })).join(", ");

  const explain = (a: SubmitAnswer) => {
    if (a.ok) {
      const r = (a.result ?? {}) as { outcome?: string; submission?: { status?: string; points?: number; potential_points?: number; missing?: string[] } };
      if (a.pending) toast.success(t("dailyTasks.submit.pending"));
      else if (r.outcome === "no_slot") toast.error(t("dailyTasks.submit.noSlot"));
      else if (r.outcome === "attempts_exhausted") toast.error(t("dailyTasks.reasons.attempts_exhausted"));
      else {
        const s = r.submission?.status ?? "";
        if (s === "accepted") toast.success(t("dailyTasks.submit.result.accepted", { points: r.submission?.points ?? r.submission?.potential_points ?? 0 }));
        else if (s === "checking") toast.success(t("dailyTasks.submit.result.checking"));
        else if (s === "needs_more") toast.message(t("dailyTasks.submit.result.needs_more", { items: labelList(r.submission?.missing) }));
        else if (s === "rejected") toast.error(t("dailyTasks.submit.result.rejected"));
        else toast.success(t("dailyTasks.submit.result.default"));
      }
      if (a.failed > 0) toast.error(t("dailyTasks.submit.partial", { posted: a.posted, total: a.posted + a.failed }));
      return;
    }
    if (a.code === "not_allowed") {
      toast.error(t(`dailyTasks.reasons.${a.reason ?? "closed"}`, { defaultValue: t("dailyTasks.submit.errors.generic"), time: DT_OPEN_TIME }));
      return;
    }
    if (a.code === "telegram_post_failed" && a.retryAfter) {
      toast.error(t("dailyTasks.submit.errors.rate_limited", { sec: a.retryAfter }));
      return;
    }
    toast.error(t(`dailyTasks.submit.errors.${a.code}`, { max: a.max ?? MAX_ITEMS, defaultValue: t("dailyTasks.submit.errors.generic") }));
  };

  const submit = async () => {
    if (submitting) return;
    if (impersonatingReadonly()) return; // expected preview no-op (G12): nothing is sent, nothing is beaconed
    const body = text.trim();
    if (!items.length && !body) { toast.error(t("dailyTasks.submit.errors.empty")); return; }
    const cap = maxFilesFor(body.slice(0, MAX_TEXT), captionTextMax);
    if (itemsRef.current.length > cap) { toast.error(t("dailyTasks.submit.errors.too_many_files_with_text", { max: cap })); return; }
    setSubmitting(true);
    try {
      if (!requestId.current) requestId.current = newRequestId();
      const fd = new FormData();
      fd.append("task_id", String(task.id));
      fd.append("request_id", requestId.current);
      if (body) fd.append("text", body.slice(0, MAX_TEXT));
      for (const it of itemsRef.current) {
        const f = it.kind === "photo" ? await toUploadable(it.file) : it.file;
        if (f.size > MAX_FILE_BYTES) { // a photo over 10 MB goes as a file (the server's fileKindOf), up to 50 MB
          toast.error(t("dailyTasks.submit.errors.file_too_large"));
          return;
        }
        fd.append("files", f, f.name || "file");
      }
      const a = await submitDailyTask(fd);
      if (!a.ok && a.code === "impersonation_readonly") return;
      explain(a);
      // Keep the id (and the form) only when a retry of THIS form may still land it: Telegram busy / a twin still
      // posting / the network. Everything else is a definitive answer.
      const retryable = !a.ok && ["telegram_post_failed", "in_progress", "network", "unavailable", "error"].includes(a.code);
      if (!a.ok && a.code === "telegram_post_failed") setShowFallback(true);
      if (!retryable) {
        if (a.ok) reset();
        else requestId.current = null;
        if (a.ok || a.code === "not_allowed" || a.code === "refused" || a.code === "expired") onDone();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const openTopic = (url: string) => { try { webApp?.openTelegramLink?.(url); } catch { /* the <a> is the fallback */ } };

  return (
    <div className="space-y-3">
      {readonly && (
        <div className="rounded-md border border-border bg-tint px-3 py-2 text-xs font-semibold text-muted-foreground">{t("dailyTasks.submit.readonly")}</div>
      )}

      {accept && (
        <>
          <input ref={fileInput} type="file" accept={accept} multiple className="hidden" onChange={onFiles} data-testid="dt-file-input" />
          {items.length > 0 ? (
            <div className="grid grid-cols-3 gap-2">
              {items.map((it) => (
                <div key={it.id} className="relative aspect-square">
                  {it.previewUrl && it.mime.startsWith("video/") ? (
                    <>
                      <video src={it.previewUrl} muted playsInline preload="metadata" className="h-full w-full rounded-lg border border-border object-cover" />
                      <span className="pointer-events-none absolute inset-0 flex items-center justify-center"><Play className="size-6 fill-white/90 text-white drop-shadow" /></span>
                    </>
                  ) : it.previewUrl ? (
                    <img src={it.previewUrl} alt="" className="h-full w-full rounded-lg border border-border object-cover" />
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-1 rounded-lg border border-border bg-surface-2 p-1 text-center">
                      <FileText className="size-5 text-muted-foreground" />
                      <span className="line-clamp-2 break-all text-[10px] font-semibold text-muted-foreground">{it.file.name}</span>
                    </div>
                  )}
                  <button type="button" onClick={() => remove(it.id)} disabled={submitting} aria-label={t("dailyTasks.submit.remove")}
                    className="absolute -right-1.5 -top-1.5 flex size-6 items-center justify-center rounded-full bg-card text-foreground shadow-soft ring-1 ring-border disabled:opacity-50">
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
              {items.length < maxItems && (
                <button type="button" onClick={() => fileInput.current?.click()} disabled={submitting || readonly}
                  className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-border bg-surface-2 text-muted-foreground disabled:opacity-50">
                  <ImagePlus className="size-5" />
                  <span className="text-[11px] font-bold">{t("dailyTasks.submit.addMore")}</span>
                </button>
              )}
            </div>
          ) : (
            <button type="button" onClick={() => fileInput.current?.click()} disabled={readonly}
              className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-surface-2 py-7 text-center disabled:opacity-50">
              <ImagePlus className="size-6 text-muted-foreground" />
              <span className="text-[13px] font-bold text-foreground">{t("dailyTasks.submit.pick")}</span>
              <span className="text-[11.5px] font-semibold text-muted-foreground">{t("dailyTasks.submit.pickHint")}</span>
            </button>
          )}
        </>
      )}

      {takesText && (
        <div>
          <label htmlFor="dt-text" className="mb-1.5 block text-[12.5px] font-bold text-foreground">{t("dailyTasks.submit.textLabel")}</label>
          <textarea
            id="dt-text"
            value={text}
            onChange={(e) => { setText(e.target.value.slice(0, MAX_TEXT)); touched(); }}
            placeholder={task.type === "instagram" ? t("dailyTasks.submit.igPlaceholder") : t("dailyTasks.submit.textPlaceholder")}
            rows={4}
            disabled={submitting || readonly}
            className="w-full resize-none rounded-lg border border-border bg-card p-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
          />
        </div>
      )}

      {overCap && (
        <p role="alert" className="text-xs font-semibold text-destructive" data-testid="dt-over-cap">
          {t("dailyTasks.submit.errors.too_many_files_with_text", { max: maxItems })}
        </p>
      )}

      {hint.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] font-semibold" aria-label={t("dailyTasks.submit.needs")}>
          <span className="text-muted-foreground">{t("dailyTasks.submit.needs")}:</span>
          {hint.map((h, i) => (
            <span key={i} className={`rounded-full px-2 py-0.5 ${h.met ? "bg-good/15 text-good-2" : "bg-tint text-muted-foreground"}`}>
              {h.met ? "✓ " : ""}{t(`dailyTasks.labels.${h.label}`, { defaultValue: h.label })}
            </span>
          ))}
        </div>
      )}

      <Button variant="primary" block disabled={submitting || readonly || overCap || (!items.length && !text.trim())} onClick={() => void submit()}>
        {submitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        {submitting ? t("dailyTasks.submit.sending") : t("dailyTasks.submit.send")}
      </Button>

      {showFallback && topicUrl && (
        <div className="rounded-lg border border-primary bg-primary/5 p-3">
          <div className="text-[12px] font-semibold text-muted-foreground">{t("dailyTasks.submit.fallback")}</div>
          <a href={topicUrl} target="_blank" rel="noopener noreferrer" onClick={() => openTopic(topicUrl)}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-bold text-foreground">
            📌 {t("dailyTasks.openTopic")}
          </a>
        </div>
      )}
    </div>
  );
}
