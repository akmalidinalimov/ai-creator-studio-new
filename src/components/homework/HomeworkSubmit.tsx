import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ImagePlus, Loader2, Upload, X, Play } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { reportClientError } from "@/lib/beacon";
import { useAuth } from "@/contexts/AuthContext";
import { useMiniApp } from "@/lib/telegram/MiniAppContext";
import { Button } from "@/components/ui-kit";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { AssignableItem } from "@/lib/homeworkAssignable";

/* Reusable "submit for a KNOWN assignment" widget. Mounted by Homework.tsx (after a picker selection) and
 * ModuleHomework.tsx (preselected) — one code path, never duplicated.
 *
 * 2026-09-10 — IMAGES **AND VIDEO** UPLOAD IN-APP, STRAIGHT TO TELEGRAM (owner decision).
 * The student picks photos and/or videos here; we send the actual FILES (multipart) to submit-homework,
 * which posts them into their Telegram group HOMEWORK TOPIC as the bot on their behalf and records the
 * submission exactly like a bot-captured post. Nothing is stored in Supabase — no storage cost, and every
 * existing teacher grading surface already resolves Telegram-captured media.
 *
 * Telegram's BOT upload ceilings are hard limits (photo 10MB, video 50MB), so oversize files are rejected
 * client-side with a clear message + the "post it in your group topic yourself" fallback.
 *
 * Mount with `key={assignment.assignment_id}` when the assignment can change under the same parent —
 * remounting is what gives a fresh form per assignment.
 */

const MAX_ITEMS = 10; // mirrors submit-homework's MAX_ITEMS
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const mb = (n: number) => Math.round(n / (1024 * 1024));

type PickedItem = { id: string; file: File; previewUrl: string; kind: "photo" | "video" };

// Client-side downscale before upload — keeps mobile uploads fast and photos comfortably under Telegram's
// 10MB photo ceiling. Any failure falls back to the original file: compression is a nice-to-have, never a
// submission blocker. Videos are never re-encoded (can't be, reliably, in a browser).
async function compressHomeworkImage(file: File, maxDim = 1600, quality = 0.82): Promise<Blob> {
  if (file.size <= 1.5 * 1024 * 1024) return file;
  try {
    return await new Promise<Blob>((resolve, reject) => {
      const img = new Image();
      const objUrl = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(objUrl);
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("canvas unavailable")); return; }
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", quality);
      };
      img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error("could not read image")); };
      img.src = objUrl;
    });
  } catch {
    return file;
  }
}

function extForBlob(blob: Blob, originalName: string): string {
  const type = blob.type || "";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  const m = /\.([a-zA-Z0-9]+)$/.exec(originalName);
  return (m?.[1] || "jpg").toLowerCase();
}

// submit-homework returns stable string codes — map the ones a student can realistically hit to friendly
// copy; anything unmapped falls back to a generic retry message rather than surfacing a raw code.
function submitErrorMessage(code: string, t: TFunction): string {
  switch (code) {
    case "not_assignable":
      return t("homework.picker.errNotAssignable");
    case "media_required":
    case "image_not_found":
    case "image_path_required":
      return t("homework.picker.errMediaRequired");
    case "too_many_files":
    case "too_many_images":
      return t("homework.picker.tooManyImages", { max: MAX_ITEMS });
    case "file_too_large":
      return t("homework.picker.errTooLarge", { photo: mb(MAX_PHOTO_BYTES), video: mb(MAX_VIDEO_BYTES) });
    case "batch_too_large":
      return t("homework.picker.errBatchTooLarge");
    case "submit_in_progress":
      return t("homework.picker.errInProgress");
    case "unsupported_media":
      return t("homework.picker.invalidFile");
    case "topic_not_configured":
    case "no_group":
      return t("homework.picker.videoNoTopic");
    case "telegram_post_failed":
      return t("homework.picker.errTelegramPost");
    case "unauthorized":
    case "forbidden":
      return t("homework.picker.errAuth");
    default:
      return t("homework.picker.errGeneric");
  }
}

// The student's group homework-topic deep-link — now only a FALLBACK surface (for a file too big for the
// bot to upload, or a group whose topic isn't configured). Resolved via a SECURITY DEFINER RPC because
// public.groups is admin-only under RLS (see 20260910100000_my_homework_topic_url.sql).
let _topicUrlCache: { uid: string; moduleId: string | null; url: string | null } | null = null;
async function resolveGroupTopicUrl(uid: string, moduleId: string | null): Promise<string | null> {
  if (_topicUrlCache && _topicUrlCache.uid === uid && _topicUrlCache.moduleId === moduleId) return _topicUrlCache.url;
  let url: string | null = null;
  try {
    // p_module_id MATTERS: the RPC prefers the module's own topic (group_module_topics) over the group-level
    // one, mirroring the server's posting precedence. Omitting it would show a wrong/blank fallback link for
    // any group configured with per-module topics.
    const { data } = await supabase.rpc("my_homework_topic_url" as any, { p_module_id: moduleId });
    url = typeof data === "string" && data ? data : null;
  } catch { /* best-effort */ }
  _topicUrlCache = { uid, moduleId, url };
  return url;
}

export interface HomeworkSubmitProps {
  assignment: AssignableItem;
  /** Called after a successful submit or resubmit (toast already shown). */
  onDone: () => void;
  /** Lets the parent guard against dropping an in-flight submit (e.g. closing a dialog). */
  onSubmittingChange?: (submitting: boolean) => void;
  className?: string;
}

export default function HomeworkSubmit({ assignment, onDone, onSubmittingChange, className }: HomeworkSubmitProps) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const { webApp } = useMiniApp();

  const [topicUrl, setTopicUrl] = useState<string | null>(null);
  const [topicLoaded, setTopicLoaded] = useState(false);
  const [items, setItems] = useState<PickedItem[]>([]);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [needTopicFallback, setNeedTopicFallback] = useState(false); // a file was too big for the bot
  const [confirmResubmitOpen, setConfirmResubmitOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const itemsRef = useRef<PickedItem[]>([]);
  itemsRef.current = items;

  useEffect(() => {
    if (!user) return;
    let alive = true;
    void resolveGroupTopicUrl(user.id, assignment.module_id ?? null)
      .then((url) => { if (alive) { setTopicUrl(url); setTopicLoaded(true); } });
    return () => { alive = false; };
  }, [user, assignment.module_id]);

  // Revoke outstanding object URLs on unmount (abandoned form / navigation).
  useEffect(() => {
    return () => { for (const it of itemsRef.current) URL.revokeObjectURL(it.previewUrl); };
  }, []);

  // Scaling safety net (graceful ≠ silent): if the fallback is needed but the group has no topic link
  // configured, say so AND beacon it, so a mis-configured group is caught the moment a student hits it.
  const beaconedMissingRef = useRef(false);
  useEffect(() => {
    if (needTopicFallback && topicLoaded && !topicUrl && !beaconedMissingRef.current) {
      beaconedMissingRef.current = true;
      reportClientError({
        type: "other",
        message: "hw_topic_url_missing",
        route: "/homework",
        extra: { assignment_id: assignment.assignment_id },
      });
    }
  }, [needTopicFallback, topicLoaded, topicUrl, assignment.assignment_id]);

  const setSubmittingTracked = (v: boolean) => { setSubmitting(v); onSubmittingChange?.(v); };

  const resetForm = () => {
    setItems((prev) => { for (const it of prev) URL.revokeObjectURL(it.previewUrl); return []; });
    setNote("");
    setNeedTopicFallback(false);
  };

  const removeItem = (id: string) => {
    if (submitting) return;
    setItems((prev) => {
      const target = prev.find((x) => x.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((x) => x.id !== id);
    });
  };

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files || []);
    e.target.value = ""; // allow re-picking the same file later
    if (!list.length) return;

    const picked: PickedItem[] = [];
    let tooBig = false;
    let unsupported = false;

    for (const f of list) {
      const isVideo = (f.type || "").startsWith("video/");
      const isImage = (f.type || "").startsWith("image/");
      if (!isVideo && !isImage) { unsupported = true; continue; }
      // Telegram's bot ceilings are hard — reject here with a clear message instead of failing mid-upload.
      if (f.size > (isVideo ? MAX_VIDEO_BYTES : MAX_PHOTO_BYTES)) { tooBig = true; continue; }
      picked.push({
        id: crypto.randomUUID(),
        file: f,
        previewUrl: URL.createObjectURL(f),
        kind: isVideo ? "video" : "photo",
      });
    }

    if (picked.length) {
      setItems((prev) => {
        const room = MAX_ITEMS - prev.length;
        if (room <= 0) {
          for (const it of picked) URL.revokeObjectURL(it.previewUrl);
          toast.error(t("homework.picker.tooManyImages", { max: MAX_ITEMS }));
          return prev;
        }
        const kept = picked.slice(0, room);
        for (const it of picked.slice(room)) URL.revokeObjectURL(it.previewUrl);
        if (picked.length > room) toast.error(t("homework.picker.tooManyImages", { max: MAX_ITEMS }));
        return [...prev, ...kept];
      });
    }
    if (tooBig) {
      setNeedTopicFallback(true); // surface the "post it in your topic" card for the oversize file
      toast.error(t("homework.picker.errTooLarge", { photo: mb(MAX_PHOTO_BYTES), video: mb(MAX_VIDEO_BYTES) }));
    } else if (unsupported && !picked.length) {
      toast.error(t("homework.picker.invalidFile"));
    }
  };

  const submitHomework = async (resubmit: boolean) => {
    if (!items.length || submitting) return;
    setSubmittingTracked(true);
    try {
      // Send the real FILES (multipart). submit-homework posts them into the group's homework topic as the
      // bot on the student's behalf — nothing is written to Supabase storage.
      const fd = new FormData();
      fd.append("assignment_id", assignment.assignment_id);
      const trimmedNote = note.trim();
      if (trimmedNote) fd.append("submitted_text", trimmedNote);
      if (resubmit) fd.append("resubmit", "true");
      for (const it of itemsRef.current) {
        if (it.kind === "photo") {
          const blob = await compressHomeworkImage(it.file);
          const ext = extForBlob(blob, it.file.name);
          fd.append("files", new File([blob], `homework.${ext}`, { type: blob.type || it.file.type || "image/jpeg" }));
        } else {
          fd.append("files", it.file, it.file.name || "homework.mp4");
        }
      }

      const { data, error } = await supabase.functions.invoke("submit-homework", { body: fd });
      if (error) {
        let code = "";
        try {
          const j = await (error as any).context?.json?.();
          code = j?.error || "";
        } catch { /* body unreadable — generic message below */ }
        if (!resubmit && code === "already_graded") {
          setConfirmResubmitOpen(true); // selection stays intact
          return;
        }
        // Always leave an escape hatch: for a topic mis-config AND for a failed Telegram post (bot lacks
        // posting rights / topic closed), retrying in-app won't self-heal — show the "post it yourself" card.
        if (code === "topic_not_configured" || code === "no_group" || code === "telegram_post_failed") {
          setNeedTopicFallback(true);
        }
        toast.error(submitErrorMessage(code, t));
        return;
      }

      // Partial success: some files never reached the topic. Say so rather than a flat "submitted!" —
      // otherwise the student can't know to re-send the missing item.
      const failedN = Number((data as any)?.failed ?? 0);
      const postedN = Number((data as any)?.posted ?? 0);
      if (failedN > 0) {
        toast.error(t("homework.picker.partialUpload", { posted: postedN, total: postedN + failedN }));
      } else {
        toast.success(
          data?.status === "resubmitted" ? t("homework.picker.resubmitSuccess") : t("homework.picker.submitSuccess"),
        );
      }
      resetForm();
      onDone();
    } catch (e) {
      console.error("[HomeworkSubmit] submit failed", e);
      toast.error(t("homework.picker.errGeneric"));
    } finally {
      setSubmittingTracked(false);
    }
  };

  const canAddMore = items.length < MAX_ITEMS;
  const showTopicCard = needTopicFallback && topicLoaded;

  return (
    <div className={className}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        multiple
        className="hidden"
        onChange={onFileChange}
      />

      {items.length > 0 ? (
        <div className="grid grid-cols-3 gap-2">
          {items.map((it) => (
            <div key={it.id} className="relative aspect-square">
              {it.kind === "video" ? (
                <>
                  <video
                    src={it.previewUrl}
                    muted
                    playsInline
                    preload="metadata"
                    className="h-full w-full rounded-lg border border-border object-cover"
                  />
                  <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <Play className="size-6 fill-white/90 text-white drop-shadow" />
                  </span>
                </>
              ) : (
                <img src={it.previewUrl} alt="" className="h-full w-full rounded-lg border border-border object-cover" />
              )}
              <button
                type="button"
                onClick={() => removeItem(it.id)}
                disabled={submitting}
                aria-label={t("homework.picker.removeImage")}
                className="absolute -right-1.5 -top-1.5 flex size-6 items-center justify-center rounded-full bg-card text-foreground shadow-soft ring-1 ring-border disabled:pointer-events-none disabled:opacity-50"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
          {canAddMore && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={submitting}
              className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-border bg-surface-2 text-muted-foreground disabled:opacity-50"
            >
              <ImagePlus className="size-5" />
              <span className="text-[11px] font-bold">{t("homework.picker.addMore")}</span>
            </button>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-surface-2 py-8 text-center"
        >
          <ImagePlus className="size-6 text-muted-foreground" />
          <span className="text-[13px] font-bold text-foreground">{t("homework.picker.pickPhoto")}</span>
          <span className="text-[11.5px] font-semibold text-muted-foreground">{t("homework.picker.pickPhotoHint")}</span>
        </button>
      )}

      {/* Oversize / no-topic fallback — deliberately placed IMMEDIATELY under the picker (not below the
          Submit button) so the student sees WHY their big file was refused and where to put it, right where
          they just tried. Normal submissions never render this. Posting in the topic is a first-class
          submission path: the bot captures it there exactly like any other homework post. */}
      {showTopicCard && topicUrl && (
        <div className="mt-3 rounded-lg border border-primary bg-primary/5 p-3 ring-1 ring-primary/40">
          <div className="text-[12.5px] font-bold text-foreground">{t("homework.picker.topicTitle")}</div>
          <div className="mt-0.5 text-[11.5px] font-semibold text-muted-foreground">{t("homework.picker.topicHint")}</div>
          <a
            href={topicUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              try { webApp?.openTelegramLink?.(topicUrl); } catch { /* native <a> is the fallback */ }
            }}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-bold text-foreground"
          >
            📌 {t("homework.picker.topicCta")}
          </a>
        </div>
      )}
      {showTopicCard && !topicUrl && (
        <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <div className="text-[12.5px] font-bold text-foreground">{t("homework.picker.videoNoTopicTitle")}</div>
          <div className="mt-0.5 text-[11.5px] font-semibold text-muted-foreground">{t("homework.picker.videoNoTopic")}</div>
        </div>
      )}

      <div className="mt-4">
        <label className="mb-1.5 block text-[12.5px] font-bold text-foreground">{t("homework.picker.noteLabel")}</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("homework.picker.notePlaceholder")}
          rows={3}
          disabled={submitting}
          className="w-full resize-none rounded-lg border border-border bg-card p-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
        />
      </div>

      <Button
        variant="primary"
        block
        disabled={!items.length || submitting}
        onClick={() => void submitHomework(false)}
        className="mt-4"
      >
        {submitting ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
        {submitting ? t("homework.picker.submitting") : t("homework.picker.submitCta")}
      </Button>

      <AlertDialog open={confirmResubmitOpen} onOpenChange={setConfirmResubmitOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("homework.picker.alreadyGradedTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("homework.picker.alreadyGradedBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setConfirmResubmitOpen(false); void submitHomework(true); }}
            >
              {t("homework.picker.resubmitConfirmCta")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
