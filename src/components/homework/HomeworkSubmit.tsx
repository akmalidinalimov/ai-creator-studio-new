import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ImagePlus, Loader2, Upload, X } from "lucide-react";
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

/* Reusable "submit for a KNOWN assignment" widget — extracted 2026-08-18 (module-end homework
 * feature) from src/pages/Homework.tsx's picker "upload" stage. Both Homework.tsx (after a picker
 * selection) and the module-end homework screen (src/pages/ModuleHomework.tsx, preselected) mount
 * the same code path — never duplicated.
 *
 * 2026-09-10 — MULTIPLE IMAGES + VIDEO HAND-OFF (owner ask "upload images and videos in the app"):
 *   - IMAGES: students now pick SEVERAL photos; each is compressed + uploaded to the private
 *     homework_images bucket at "<uid>/<uuid>.<ext>" and submit-homework receives image_paths[].
 *   - VIDEOS: Telegram does not let a Mini App post a file into the group as the student, and
 *     storing videos in Supabase would balloon storage cost, so a picked video is NOT uploaded here
 *     — instead the student is guided to post it in their group's homework topic (the bot captures
 *     it exactly like today, any size). This replaces the old blunt "only images" rejection.
 *
 * Mount with `key={assignment.assignment_id}` whenever the assignment can change under the same
 * parent — this component intentionally has no effect that resets picked files on an assignment
 * change; remounting on a key change gives the "fresh form per assignment" behavior. A successful
 * submit's internal reset (resetForm) leaves a clean form behind for screens that stay mounted.
 */

const MAX_IMAGES = 10; // mirrors submit-homework's MAX_IMAGES cap

type PickedImage = { id: string; file: File; previewUrl: string; uploadedPath: string | null };

// Client-side downscale before upload — same approach as Profile.tsx's avatar compressor: skip the
// re-encode for already-small files, downscale+re-encode large ones so mobile uploads stay fast and
// land under the bucket's 5MB image cap. Any failure falls back to the original file — compression is
// a nice-to-have, never a submission blocker.
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
        if (!ctx) {
          reject(new Error("canvas unavailable"));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", quality);
      };
      img.onerror = () => {
        URL.revokeObjectURL(objUrl);
        reject(new Error("could not read image"));
      };
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
  if (type.includes("heic")) return "heic";
  if (type.includes("heif")) return "heif";
  const m = /\.([a-zA-Z0-9]+)$/.exec(originalName);
  return (m?.[1] || "jpg").toLowerCase();
}

// submit-homework's error bodies are stable string codes — map the ones a student can realistically
// hit to friendly copy; anything unmapped falls back to a generic retry message.
function submitErrorMessage(code: string, t: TFunction): string {
  switch (code) {
    case "not_assignable":
      return t("homework.picker.errNotAssignable");
    case "image_not_found":
    case "image_path_required":
      return t("homework.picker.errImageNotFound");
    case "too_many_images":
      return t("homework.picker.tooManyImages", { max: MAX_IMAGES });
    case "unauthorized":
    case "forbidden":
      return t("homework.picker.errAuth");
    default:
      return t("homework.picker.errGeneric");
  }
}

// Resolve the student's group homework-topic deep-link (t.me/c/<chat>/<topic>) once per session — the
// destination for videos (and anything the app can't upload). Cached module-level: HomeworkSubmit
// remounts per assignment, so this avoids re-querying on every assignment switch.
let _topicUrlCache: { uid: string; url: string | null } | null = null;
async function resolveGroupTopicUrl(uid: string): Promise<string | null> {
  if (_topicUrlCache && _topicUrlCache.uid === uid) return _topicUrlCache.url;
  let url: string | null = null;
  try {
    const { data: prof } = await supabase.from("profiles").select("group_id").eq("id", uid).maybeSingle();
    const gid = (prof as { group_id?: string } | null)?.group_id;
    if (gid) {
      const { data: gr } = await supabase.from("groups").select("homework_topic_url").eq("id", gid).maybeSingle();
      url = (gr as { homework_topic_url?: string } | null)?.homework_topic_url || null;
    }
  } catch { /* best-effort — no deep-link if we can't resolve it */ }
  _topicUrlCache = { uid, url };
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
  const [images, setImages] = useState<PickedImage[]>([]);
  const [videoPicked, setVideoPicked] = useState(false);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmResubmitOpen, setConfirmResubmitOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Keep a live ref to the current images so the unmount cleanup (and the upload loop) can read the
  // latest without re-subscribing effects on every pick.
  const imagesRef = useRef<PickedImage[]>([]);
  imagesRef.current = images;

  useEffect(() => {
    if (!user) return;
    let alive = true;
    void resolveGroupTopicUrl(user.id).then((url) => { if (alive) { setTopicUrl(url); setTopicLoaded(true); } });
    return () => { alive = false; };
  }, [user]);

  // Scaling safety net (doctrine: graceful ≠ silent). The topic hand-off is fully per-student
  // (profiles.group_id → that group's homework_topic_url), so it scales to any number of groups — BUT only
  // if each group's link is set (AdminGroups form). The failure mode when a NEW group (6.0: ~12 groups) is
  // created WITHOUT its link is a student who picks a video and has nowhere to go. Don't dead-end silently:
  // show a clear fallback (below) AND beacon it once, so admins catch the mis-configured group the moment a
  // real student hits it — not up to a week later via weekly-admin-topic-check. Landed in client_error_events
  // (auto-flagged miniapp) as message 'hw_topic_url_missing'.
  const beaconedMissingRef = useRef(false);
  useEffect(() => {
    if (videoPicked && topicLoaded && !topicUrl && !beaconedMissingRef.current) {
      beaconedMissingRef.current = true;
      reportClientError({
        type: "other",
        message: "hw_topic_url_missing",
        route: "/homework",
        extra: { assignment_id: assignment.assignment_id },
      });
    }
  }, [videoPicked, topicLoaded, topicUrl, assignment.assignment_id]);

  // Revoke every outstanding object URL on unmount (abandon / navigate away). Per-image revokes on
  // remove + on successful reset happen inline below; this covers the "just left" case.
  useEffect(() => {
    return () => {
      for (const im of imagesRef.current) URL.revokeObjectURL(im.previewUrl);
    };
  }, []);

  const setSubmittingTracked = (v: boolean) => {
    setSubmitting(v);
    onSubmittingChange?.(v);
  };

  const resetForm = () => {
    setImages((prev) => {
      for (const im of prev) URL.revokeObjectURL(im.previewUrl);
      return [];
    });
    setVideoPicked(false);
    setNote("");
  };

  const removeImage = (id: string) => {
    if (submitting) return;
    setImages((prev) => {
      const target = prev.find((im) => im.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((im) => im.id !== id);
    });
  };

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files || []);
    e.target.value = ""; // allow re-picking the exact same file later
    if (!list.length) return;

    let sawVideo = false;
    let sawOther = false;
    const picked: PickedImage[] = [];
    for (const f of list) {
      if (f.type.startsWith("image/")) {
        picked.push({ id: crypto.randomUUID(), file: f, previewUrl: URL.createObjectURL(f), uploadedPath: null });
      } else if (f.type.startsWith("video/")) {
        sawVideo = true;
      } else {
        sawOther = true;
      }
    }

    if (picked.length) {
      setImages((prev) => {
        const room = MAX_IMAGES - prev.length;
        if (room <= 0) {
          for (const im of picked) URL.revokeObjectURL(im.previewUrl);
          toast.error(t("homework.picker.tooManyImages", { max: MAX_IMAGES }));
          return prev;
        }
        const kept = picked.slice(0, room);
        for (const im of picked.slice(room)) URL.revokeObjectURL(im.previewUrl);
        if (picked.length > room) toast.error(t("homework.picker.tooManyImages", { max: MAX_IMAGES }));
        return [...prev, ...kept];
      });
    }

    // Videos are handled via the Telegram topic (see the guidance card), never uploaded here — guide,
    // don't reject. A non-image / non-video pick is the only real "invalid file".
    if (sawVideo) {
      setVideoPicked(true);
      toast(t("homework.picker.videoToTopic"));
    } else if (sawOther && !picked.length) {
      toast.error(t("homework.picker.invalidFile"));
    }
  };

  // Uploads each not-yet-uploaded image (once) to homework_images at "<uid>/<uuid>.<ext>" — the RLS
  // path shape submit-homework's `p.startsWith(userId + "/")` check requires. Caches the path on the
  // item so a submit retry (network blip, or the 409 already-graded confirm) never re-uploads it.
  // Returns the ordered paths, or null if any upload fails (submit is aborted on null).
  const uploadAllImages = async (): Promise<string[] | null> => {
    if (!user) return null;
    const paths: string[] = [];
    for (const im of imagesRef.current) {
      if (im.uploadedPath) { paths.push(im.uploadedPath); continue; }
      const blob = await compressHomeworkImage(im.file);
      const ext = extForBlob(blob, im.file.name);
      const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage
        .from("homework_images")
        .upload(path, blob, { contentType: blob.type || im.file.type || "image/jpeg" });
      if (error) {
        console.error("[HomeworkSubmit] image upload failed", error);
        return null;
      }
      setImages((prev) => prev.map((x) => (x.id === im.id ? { ...x, uploadedPath: path } : x)));
      paths.push(path);
    }
    return paths;
  };

  const submitHomework = async (resubmit: boolean) => {
    if (!images.length || submitting) return;
    setSubmittingTracked(true);
    try {
      const paths = await uploadAllImages();
      if (!paths || !paths.length) {
        toast.error(t("homework.picker.uploadFailed"));
        return;
      }
      const body: Record<string, unknown> = { assignment_id: assignment.assignment_id, image_paths: paths };
      const trimmedNote = note.trim();
      if (trimmedNote) body.submitted_text = trimmedNote;
      if (resubmit) body.resubmit = true;

      const { data, error } = await supabase.functions.invoke("submit-homework", { body });
      if (error) {
        // On an HTTP error, supabase-js puts the response body in error.context, not `data`.
        let code = "";
        try {
          const j = await (error as any).context?.json?.();
          code = j?.error || "";
        } catch {
          // body unreadable — falls through to the generic error message below
        }
        if (!resubmit && code === "already_graded") {
          setConfirmResubmitOpen(true); // the files stay uploaded + selection stays intact
          return;
        }
        toast.error(submitErrorMessage(code, t));
        return;
      }

      toast.success(
        data?.status === "resubmitted" ? t("homework.picker.resubmitSuccess") : t("homework.picker.submitSuccess"),
      );
      resetForm();
      onDone();
    } catch (e) {
      console.error("[HomeworkSubmit] submit failed", e);
      toast.error(t("homework.picker.errGeneric"));
    } finally {
      setSubmittingTracked(false);
    }
  };

  const canAddMore = images.length < MAX_IMAGES;

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

      {images.length > 0 ? (
        <div className="grid grid-cols-3 gap-2">
          {images.map((im) => (
            <div key={im.id} className="relative aspect-square">
              <img src={im.previewUrl} alt="" className="h-full w-full rounded-lg border border-border object-cover" />
              <button
                type="button"
                onClick={() => removeImage(im.id)}
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
        disabled={!images.length || submitting}
        onClick={() => void submitHomework(false)}
        className="mt-4"
      >
        {submitting ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
        {submitting ? t("homework.picker.submitting") : t("homework.picker.submitCta")}
      </Button>

      {topicUrl && (
        <div
          className={`mt-4 rounded-lg border p-3 ${
            videoPicked ? "border-primary bg-primary/5 ring-1 ring-primary/40" : "border-border bg-surface-2"
          }`}
        >
          <div className="text-[12.5px] font-bold text-foreground">{t("homework.picker.topicTitle")}</div>
          <div className="mt-0.5 text-[11.5px] font-semibold text-muted-foreground">{t("homework.picker.topicHint")}</div>
          <a
            href={topicUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              // The real <a target=_blank> is the fallback; openTelegramLink is the RELIABLE path
              // inside the Telegram Mini App (a plain <a> can silently no-op in some clients).
              try {
                webApp?.openTelegramLink?.(topicUrl);
              } catch {
                /* native <a> navigation is the fallback */
              }
            }}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-bold text-foreground"
          >
            📌 {t("homework.picker.topicCta")}
          </a>
        </div>
      )}

      {/* Fallback when this student's group has NO homework_topic_url configured (a new group set up
          without its link) — a clear message instead of a silent dead-end; the missing config was beaconed
          above so admins are alerted. */}
      {!topicUrl && topicLoaded && videoPicked && (
        <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <div className="text-[12.5px] font-bold text-foreground">{t("homework.picker.videoNoTopicTitle")}</div>
          <div className="mt-0.5 text-[11.5px] font-semibold text-muted-foreground">{t("homework.picker.videoNoTopic")}</div>
        </div>
      )}

      <AlertDialog open={confirmResubmitOpen} onOpenChange={setConfirmResubmitOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("homework.picker.alreadyGradedTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("homework.picker.alreadyGradedBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmResubmitOpen(false);
                void submitHomework(true);
              }}
            >
              {t("homework.picker.resubmitConfirmCta")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
