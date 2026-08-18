import { useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ImagePlus, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
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
 * feature) from src/pages/Homework.tsx's picker "upload" stage (item 4, 2026-08-18), which had
 * the full flow inline: photo picker + preview + optional note → upload to the private
 * `homework_images` bucket at `<uid>/<uuid>.<ext>` → supabase.functions.invoke("submit-homework")
 * → in-flight submit lock → 409 already_graded → resubmit-confirm dialog → friendly error
 * mapping that keeps the current selection on failure. That mechanism is now here, UNCHANGED,
 * so both Homework.tsx (after a picker selection) and the new module-end homework screen
 * (src/pages/ModuleHomework.tsx, preselected) call the exact same code path — never duplicated.
 *
 * Mount with `key={assignment.assignment_id}` whenever the assignment can change under the same
 * parent (e.g. Homework.tsx's picker, switching between list rows) — this component intentionally
 * has no prop/effect that resets file/note state on an assignment change; remounting on a key
 * change is what gives the same "fresh form per assignment" behavior the old imperative
 * resetUploadForm() gave, and it also means a successful submit's internal reset (see
 * submitHomework below) is enough to leave a clean form behind for screens that stay mounted
 * (ModuleHomework.tsx doesn't close/unmount after a submit the way Homework.tsx's dialog does).
 */

// Client-side downscale before upload — same approach as Profile.tsx's avatar compressor: skip
// the re-encode round-trip for already-small files, downscale+re-encode large ones so mobile
// uploads stay fast. Any failure (unsupported format, canvas error) falls back to the original
// file untouched — compression is a nice-to-have, never a submission blocker.
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

// submit-homework's error bodies are stable string codes (index.ts) — map the ones a student
// can realistically hit to friendly copy; anything unmapped (internal_error, bad_json, ...)
// falls back to a generic retry message rather than surfacing a raw code.
function submitErrorMessage(code: string, t: TFunction): string {
  switch (code) {
    case "not_assignable":
      return t("homework.picker.errNotAssignable");
    case "image_not_found":
    case "image_path_required":
      return t("homework.picker.errImageNotFound");
    case "unauthorized":
    case "forbidden":
      return t("homework.picker.errAuth");
    default:
      return t("homework.picker.errGeneric");
  }
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

  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [confirmResubmitOpen, setConfirmResubmitOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const setSubmittingTracked = (v: boolean) => {
    setSubmitting(v);
    onSubmittingChange?.(v);
  };

  const resetForm = () => {
    setFile(null);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setNote("");
    setUploadedPath(null);
  };

  const onFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the exact same file later
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      toast.error(t("homework.picker.invalidFile"));
      return;
    }
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(f);
    });
    setFile(f);
    setUploadedPath(null); // a new file always needs a fresh upload
  };

  // Uploads (once) to the private homework_images bucket at "<uid>/<uuid>.<ext>" — the RLS path
  // shape submit-homework's `image_path.startsWith(userId + "/")` check requires. Cached via
  // uploadedPath so a submit retry (network blip, or the 409 already-graded confirm) never
  // re-uploads the same file.
  const uploadSelectedImage = async (): Promise<string | null> => {
    if (!user || !file) return null;
    if (uploadedPath) return uploadedPath;
    const blob = await compressHomeworkImage(file);
    const ext = extForBlob(blob, file.name);
    const path = `${user.id}/${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage
      .from("homework_images")
      .upload(path, blob, { contentType: blob.type || file.type || "image/jpeg" });
    if (error) {
      console.error("[HomeworkSubmit] image upload failed", error);
      return null;
    }
    setUploadedPath(path);
    return path;
  };

  const submitHomework = async (resubmit: boolean) => {
    if (!file || submitting) return;
    setSubmittingTracked(true);
    try {
      const imagePath = await uploadSelectedImage();
      if (!imagePath) {
        toast.error(t("homework.picker.uploadFailed"));
        return;
      }
      const body: Record<string, unknown> = { assignment_id: assignment.assignment_id, image_path: imagePath };
      const trimmedNote = note.trim();
      if (trimmedNote) body.submitted_text = trimmedNote;
      if (resubmit) body.resubmit = true;

      const { data, error } = await supabase.functions.invoke("submit-homework", { body });
      if (error) {
        // On an HTTP error, supabase-js puts the response body in error.context, not `data`
        // (same pattern as AdminUsers.tsx's admin-impersonate call).
        let code = "";
        try {
          const j = await (error as any).context?.json?.();
          code = j?.error || "";
        } catch {
          // body unreadable — falls through to the generic error message below
        }
        if (!resubmit && code === "already_graded") {
          setConfirmResubmitOpen(true); // the file stays uploaded + selection stays intact
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

  return (
    <div className={className}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={onFileChange}
      />

      {previewUrl ? (
        <div className="relative">
          <img src={previewUrl} alt="" className="max-h-64 w-full rounded-lg border border-border object-cover" />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={submitting}
            className="absolute bottom-2 right-2 rounded-full bg-card/90 px-3 py-1.5 text-[11.5px] font-bold text-foreground shadow-soft disabled:pointer-events-none disabled:opacity-50"
          >
            {t("homework.picker.changePhoto")}
          </button>
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
        disabled={!file || submitting}
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
