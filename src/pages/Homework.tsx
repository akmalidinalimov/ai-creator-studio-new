import { Fragment, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Clock,
  ImagePlus,
  Loader2,
  Plus,
  Star,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { cn } from "@/lib/utils";
import { formatXp } from "@/lib/xp";
import { effectiveLeafGrades } from "@/lib/homeworkStats";
import { Card, SectionHeader, StatTile, StatusChip, XpPill, Button, EmptyState, Skeleton } from "@/components/ui-kit";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

/* Vazifa (homework) hub. Mockup: data-screen="homework" + "hw-detail" + "upload".
 *
 * Item 4 (2026-08-18) added the real in-app submit flow on top of the originally read-only
 * hub (Task 2.6): "Yangi vazifa topshirish" now opens a picker (student_assignable_homework()
 * RPC — supabase/migrations/20260818160000_*.sql) instead of linking out to the group's
 * Telegram topic, the student picks a leaf assignment, uploads a photo (+ optional note),
 * and submit-homework (supabase/functions/submit-homework/index.ts) writes the submission —
 * same table, same XP triggers, same teacher-DM queue the bot capture paths use, so grading
 * and notifications are untouched. See doPicker* state below and the PickerList component at
 * the bottom of this file. The read-only summary/filter/graded-detail views below are
 * unchanged.
 *
 * Data model: homework_submissions has UNIQUE(assignment_id, user_id) — one row per
 * assignment for this student, so "submission" and "assignment" are 1:1 here. Effective
 * score reuses effectiveLeafGrades() (src/lib/homeworkStats.ts) — the SAME fallback
 * HomeworkProfileSection.tsx/HomeworkSection.tsx use: a resubmission clears the live
 * `score` but the last *scored* entry in previous_attempts still counts until the new
 * grade lands. On top of that we layer the score_is_stale override those two components
 * also apply independently: a stale row (score present but flagged awaiting-regrade)
 * must NOT read as freshly "graded" just because a number happens to be sitting in
 * `score` — see status derivation below.
 *
 * "Redo" status: the brief asks for a StatusChip kind="redo" row, but there is no
 * "needs resubmit" flag anywhere in the schema (only `score_is_stale`, which means the
 * opposite — already resubmitted, awaiting a NEW grade). Per the brief's own fallback
 * instruction, nothing here is fabricated into "redo": every non-graded row buckets as
 * "waiting". The redo UI path (chip + "Qayta yuklash") stays wired for forward
 * compatibility but is never reached by real data today — documented in the task report.
 *
 * Images: submitted_image_url is a PRIVATE `homework_images` bucket path (needs
 * createSignedUrl, mirrors TeacherHomework.tsx's Drawer) — resolved lazily only when a
 * graded row is opened, not for the whole list. Newer multi-media submissions carry a
 * `media` jsonb array (see 20260707020000_homework_multimedia.sql); only items with a
 * direct http(s) `url` can be inlined as an <img> — Telegram-hosted-only entries
 * (file_id/msg_url, no url) can't be embedded without a bot-API proxy, so they're
 * skipped rather than shown broken. Per the storage retention design (hybrid delete —
 * docs/superpowers/specs/2026-08-17-ui-redesign-design.md §6.3), a signed-URL failure or
 * an empty resolved set is NOT treated as an error: it renders a graceful "image
 * unavailable" note, never a broken <img>.
 */

type MediaItem = { kind?: string; url?: string; msg_url?: string; file_id?: string };

interface SubmissionRaw {
  id: string;
  assignment_id: string;
  submitted_at: string;
  submitted_text: string | null;
  submitted_image_url: string | null;
  media: MediaItem[] | null;
  score: number | null;
  score_feedback: string | null;
  score_is_stale: boolean | null;
  scored_by: string | null;
  scored_at: string | null;
  previous_attempts: any[] | null;
  homework_assignments: {
    id: string;
    title: string;
    max_score: number;
    modules: { title: string | null; position: number | null } | null;
  } | null;
}

type HwStatus = "graded" | "waiting" | "redo";

interface HwItem {
  id: string;
  assignmentId: string;
  title: string;
  moduleTitle: string;
  submittedAt: string;
  maxScore: number;
  status: HwStatus;
  effectiveScore: number | null;
  effectiveFeedback: string | null;
  submittedText: string;
  submittedImageUrl: string | null;
  media: MediaItem[];
  scoredBy: string | null;
  xpEarned: number;
}

type FilterKind = "all" | "waiting" | "graded";

// student_assignable_homework() row shape — supabase/migrations/20260818160000_*.sql. `state`
// is the RPC's own unification of both resubmission mechanisms (bot capture path's
// previous_score/null-score reset vs. start_homework_resubmission()'s score_is_stale flag) —
// the picker never needs to know which one produced it.
type AssignableState = "none" | "pending" | "graded" | "needs_redo";

interface AssignableItem {
  assignment_id: string;
  module_id: string;
  module_number: number;
  module_title: string;
  is_sap: boolean;
  step_number: number;
  title: string;
  max_score: number;
  state: AssignableState;
  score: number | null;
  attempt_number: number | null;
  submission_id: string | null;
}

function relativeTime(iso: string, t: TFunction): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return t("settings.justNow");
  if (mins < 60) return t("settings.minAgo", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("settings.hourAgo", { n: hours });
  const days = Math.floor(hours / 24);
  return t("settings.dayAgo", { n: days });
}

// Client-side downscale before upload — same approach as Profile.tsx's avatar compressor:
// skip the re-encode round-trip for already-small files, downscale+re-encode large ones so
// mobile uploads stay fast. Any failure (unsupported format, canvas error) falls back to the
// original file untouched — compression is a nice-to-have, never a submission blocker.
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
function pickerErrorMessage(code: string, t: TFunction): string {
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

export default function Homework() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  const [items, setItems] = useState<HwItem[]>([]);
  const [teacherNames, setTeacherNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState<FilterKind>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [images, setImages] = useState<string[] | null>(null);
  const [imagesLoading, setImagesLoading] = useState(false);

  // ---- in-app submit flow (item 4) ----
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState(false);
  const [pickerItems, setPickerItems] = useState<AssignableItem[]>([]);
  const [stage, setStage] = useState<"list" | "upload">("list");
  const [pickedItem, setPickedItem] = useState<AssignableItem | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [confirmResubmitOpen, setConfirmResubmitOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const subsRes = await supabase
          .from("homework_submissions")
          .select(
            "id, assignment_id, submitted_at, submitted_text, submitted_image_url, media, score, score_feedback, score_is_stale, scored_by, scored_at, previous_attempts, homework_assignments(id, title, max_score, modules(title, position))",
          )
          .eq("user_id", user.id)
          .order("submitted_at", { ascending: false });
        if (subsRes.error) throw subsRes.error;
        if (cancelled) return;

        const rows = ((subsRes.data as any[]) || []) as SubmissionRaw[];

        // Effective-score fallback — exact reuse of HomeworkProfileSection.tsx's logic.
        const leaves = rows.map((r) => ({ id: r.assignment_id, max_score: r.homework_assignments?.max_score ?? 0 }));
        const subsLite = rows.map((r) => ({
          assignment_id: r.assignment_id,
          score: r.score,
          score_feedback: r.score_feedback,
          scored_at: r.scored_at,
          previous_attempts: r.previous_attempts,
        }));
        const effByAssignment = new Map(effectiveLeafGrades(leaves, subsLite).map((e) => [e.assignment_id, e]));

        // XP actually awarded per assignment, read straight from the ledger (ref-key
        // idempotent — xp_on_homework() in 20260706090000_profile_gamification_phase1.sql:
        // +15 on submit, +25 more if scored >=9) rather than re-deriving the trigger's
        // arithmetic client-side, so this stays correct even if the award rule changes.
        const { data: xpRows } = await supabase
          .from("xp_events" as any)
          .select("amount, reason, ref_key")
          .eq("user_id", user.id)
          .in("reason", ["homework_submit", "homework_high_score"]);
        const xpByAssignment = new Map<string, number>();
        ((xpRows as any[]) || []).forEach((r) => {
          const key = typeof r.ref_key === "string" ? r.ref_key.split(":")[1] : null;
          if (!key) return;
          xpByAssignment.set(key, (xpByAssignment.get(key) || 0) + Number(r.amount || 0));
        });

        const built: HwItem[] = rows.map((r) => {
          const eff = effByAssignment.get(r.assignment_id);
          // score_is_stale = re-opened for regrade (HomeworkProfileSection/HomeworkSection
          // convention) — even if a (now-stale) number sits in `score`, this is NOT a
          // finished grade yet, so it must bucket as "waiting", not "graded".
          const isStale = !!r.score_is_stale;
          const status: HwStatus = eff?.effective_score != null && !isStale ? "graded" : "waiting";
          return {
            id: r.id,
            assignmentId: r.assignment_id,
            title: r.homework_assignments?.title || "—",
            moduleTitle: r.homework_assignments?.modules?.title || "—",
            submittedAt: r.submitted_at,
            maxScore: r.homework_assignments?.max_score ?? 10,
            status,
            effectiveScore: eff?.effective_score ?? null,
            effectiveFeedback: eff?.effective_feedback ?? null,
            submittedText: r.submitted_text || "",
            submittedImageUrl: r.submitted_image_url,
            media: Array.isArray(r.media) ? r.media : [],
            scoredBy: r.scored_by,
            xpEarned: xpByAssignment.get(r.assignment_id) || 0,
          };
        });
        setItems(built);

        // Teacher display names for the graded-detail context/feedback card. No FK-embed
        // exists from scored_by → profiles (plain uuid column), so this is a manual,
        // best-effort lookup — a missing name just falls back to a generic label.
        const teacherIds = Array.from(new Set(built.filter((i) => i.scoredBy).map((i) => i.scoredBy as string)));
        if (teacherIds.length) {
          const { data: profRows } = await supabase.from("profiles").select("id, name").in("id", teacherIds);
          const names: Record<string, string> = {};
          ((profRows as any[]) || []).forEach((p) => {
            names[p.id] = p.name || "";
          });
          if (!cancelled) setTeacherNames(names);
        }
      } catch (e) {
        if (!cancelled) {
          console.error("[Homework] load failed", e);
          setError(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, reloadKey]);

  const { gradedCount, waitingCount, avg10 } = useMemo(() => {
    let graded = 0;
    let waiting = 0;
    let earned = 0;
    let maxScored = 0;
    items.forEach((it) => {
      if (it.status === "graded") {
        graded++;
        earned += it.effectiveScore ?? 0;
        maxScored += it.maxScore;
      } else {
        waiting++; // "redo" (never produced today — see file header) folds in here too
      }
    });
    return {
      gradedCount: graded,
      waitingCount: waiting,
      avg10: maxScored > 0 ? +((earned / maxScored) * 10).toFixed(1) : null,
    };
  }, [items]);

  const filteredItems = useMemo(() => {
    if (filter === "graded") return items.filter((i) => i.status === "graded");
    if (filter === "waiting") return items.filter((i) => i.status !== "graded");
    return items;
  }, [items, filter]);

  const selected = selectedId ? (items.find((i) => i.id === selectedId) ?? null) : null;

  // Lazy image resolution — only when a graded row is opened (never for the whole list).
  useEffect(() => {
    if (!selected) {
      setImages(null);
      return;
    }
    let cancelled = false;
    setImagesLoading(true);
    (async () => {
      const urls: string[] = [];
      for (const m of selected.media) {
        if (m.kind === "photo" && typeof m.url === "string" && /^https?:\/\//.test(m.url)) urls.push(m.url);
      }
      if (urls.length === 0 && selected.submittedImageUrl) {
        const raw = selected.submittedImageUrl;
        if (/^https?:\/\//.test(raw)) {
          urls.push(raw);
        } else {
          try {
            const { data, error: signErr } = await supabase.storage.from("homework_images").createSignedUrl(raw, 600);
            if (!signErr && data?.signedUrl) urls.push(data.signedUrl);
          } catch {
            // Object purged (7-day retention policy) or otherwise inaccessible — the
            // "image unavailable" fallback below handles this gracefully.
          }
        }
      }
      if (!cancelled) {
        setImages(urls);
        setImagesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected?.id]);

  // ---- in-app submit flow (item 4) ----

  const resetUploadForm = () => {
    setFile(null);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setNote("");
    setUploadedPath(null);
  };

  const loadPickerItems = async (preselectAssignmentId?: string) => {
    setPickerLoading(true);
    setPickerError(false);
    try {
      const { data, error } = await supabase.rpc("student_assignable_homework" as any);
      if (error) throw error;
      const rows = ((data as any[]) || []) as AssignableItem[];
      setPickerItems(rows);
      if (preselectAssignmentId) {
        const match = rows.find((r) => r.assignment_id === preselectAssignmentId);
        if (match) {
          setPickedItem(match);
          setStage("upload");
        }
      }
    } catch (e) {
      console.error("[Homework] picker load failed", e);
      setPickerError(true);
    } finally {
      setPickerLoading(false);
    }
  };

  // preselectAssignmentId: used by the "Qayta yuklash" row action (redo state) to jump
  // straight to that assignment's upload screen instead of the picker list.
  const openPicker = (preselectAssignmentId?: string) => {
    setStage("list");
    setPickedItem(null);
    resetUploadForm();
    setPickerOpen(true);
    void loadPickerItems(preselectAssignmentId);
  };

  const handlePickerOpenChange = (open: boolean) => {
    if (!open) {
      if (submitting) return; // never drop an in-flight submit (close/Esc/overlay tap alike)
      resetUploadForm();
      setStage("list");
      setPickedItem(null);
    }
    setPickerOpen(open);
  };

  const selectPickerItem = (item: AssignableItem) => {
    resetUploadForm();
    setPickedItem(item);
    setStage("upload");
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

  // Uploads (once) to the private homework_images bucket at "<uid>/<uuid>.<ext>" — the RLS
  // path shape submit-homework's `image_path.startsWith(userId + "/")` check requires. Cached
  // via uploadedPath so a submit retry (network blip, or the 409 already-graded confirm) never
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
      console.error("[Homework] image upload failed", error);
      return null;
    }
    setUploadedPath(path);
    return path;
  };

  const submitHomework = async (resubmit: boolean) => {
    if (!pickedItem || !file || submitting) return;
    setSubmitting(true);
    try {
      const imagePath = await uploadSelectedImage();
      if (!imagePath) {
        toast.error(t("homework.picker.uploadFailed"));
        return;
      }
      const body: Record<string, unknown> = { assignment_id: pickedItem.assignment_id, image_path: imagePath };
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
        toast.error(pickerErrorMessage(code, t));
        return;
      }

      toast.success(
        data?.status === "resubmitted" ? t("homework.picker.resubmitSuccess") : t("homework.picker.submitSuccess"),
      );
      setPickerOpen(false);
      resetUploadForm();
      setPickedItem(null);
      setStage("list");
      setReloadKey((k) => k + 1); // refreshes the read-only hub list underneath
    } catch (e) {
      console.error("[Homework] submit failed", e);
      toast.error(t("homework.picker.errGeneric"));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <PageShell>
        <div className="mx-auto max-w-2xl space-y-4">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-56" />
          <div className="grid grid-cols-3 gap-2">
            <Skeleton className="h-20 rounded-md" />
            <Skeleton className="h-20 rounded-md" />
            <Skeleton className="h-20 rounded-md" />
          </div>
          <Skeleton className="h-11 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-2xl" />
          <Skeleton className="h-16 w-full rounded-md" />
          <Skeleton className="h-16 w-full rounded-md" />
          <Skeleton className="h-16 w-full rounded-md" />
        </div>
      </PageShell>
    );
  }

  if (error) {
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    return (
      <PageShell>
        <div className="mx-auto max-w-2xl">
          <EmptyState
            icon={offline ? "📡" : "⚠️"}
            title={offline ? t("common.offlineTitle") : t("common.errorTitle")}
            body={offline ? t("common.offlineBody") : t("homework.loadError")}
            cta={
              <Button variant="secondary" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
                {t("common.retry")}
              </Button>
            }
          />
        </div>
      </PageShell>
    );
  }

  // -------------------------------------------------------------- graded detail
  if (selected) {
    const teacherName = (selected.scoredBy && teacherNames[selected.scoredBy]) || "";
    const hasMedia = selected.media.length > 0 || !!selected.submittedImageUrl;
    return (
      <PageShell>
        <div className="mx-auto max-w-2xl space-y-4">
          <div className="pt-1 text-center">
            {/* NOT font-display: Unbounded's digits corrupt under the global
                font-feature-settings (see StatTile/XpPill/PodiumSlot). */}
            <div className="text-[46px] font-extrabold leading-none tracking-tight text-good-2">
              {formatXp(selected.effectiveScore ?? 0, locale)}
              <span className="ml-1 text-base font-bold text-muted-foreground">
                /{formatXp(selected.maxScore, locale)}
              </span>
            </div>
            <div className="mt-2.5 flex items-center justify-center gap-2">
              <XpPill xp={selected.xpEarned} locale={locale} />
              <span className="text-xs font-semibold text-muted-foreground">{t("homework.xpEarnedSuffix")}</span>
            </div>
          </div>

          <Card className="flex items-center gap-3">
            <div className="grid size-[42px] flex-none place-items-center rounded-md bg-primary text-primary-foreground">
              <ClipboardCheck className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-bold text-foreground">{selected.title}</div>
              <div className="truncate text-xs font-semibold text-muted-foreground">
                {selected.moduleTitle}
                {teacherName ? ` · ${t("homework.teacherPrefix", { name: teacherName })}` : ""}
              </div>
            </div>
          </Card>

          <SectionHeader title={t("homework.yourWorkTitle")} />
          {selected.submittedText && (
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{selected.submittedText}</p>
          )}
          {imagesLoading ? (
            <div className="flex gap-2">
              <Skeleton className="size-[72px] rounded-md" />
              <Skeleton className="size-[72px] rounded-md" />
            </div>
          ) : images && images.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {images.map((u) => (
                <a key={u} href={u} target="_blank" rel="noreferrer">
                  <img src={u} alt="" className="size-[72px] rounded-md border border-border object-cover" />
                </a>
              ))}
            </div>
          ) : hasMedia ? (
            <p className="text-xs font-semibold text-muted-foreground">{t("homework.imageUnavailable")}</p>
          ) : null}

          {selected.effectiveFeedback && (
            <div className="rounded-lg border border-border bg-surface-2 p-3.5">
              <div className="mb-2 flex items-center gap-2">
                <div className="grid size-[30px] flex-none place-items-center rounded-md bg-primary text-[12px] font-extrabold text-primary-foreground">
                  {(teacherName || "O").slice(0, 1).toUpperCase()}
                </div>
                <div>
                  <div className="text-[13px] font-bold text-foreground">{teacherName || t("homework.teacherFallback")}</div>
                  <div className="text-[11px] font-semibold text-muted-foreground">{t("homework.feedbackTitle")}</div>
                </div>
              </div>
              <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground/90">
                {selected.effectiveFeedback}
              </p>
            </div>
          )}

          <Button variant="ghost" block onClick={() => setSelectedId(null)}>
            <ArrowLeft className="size-4" />
            {t("homework.backToList")}
          </Button>
        </div>
      </PageShell>
    );
  }

  // -------------------------------------------------------------------- hub list
  return (
    <PageShell>
      <div className="mx-auto max-w-2xl space-y-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-foreground">{t("homework.title")}</h1>
          <p className="text-sm font-semibold text-muted-foreground">{t("homework.subtitle")}</p>
        </div>

        {items.length === 0 ? (
          <EmptyState
            icon="📝"
            title={t("homework.emptyTitle")}
            body={t("homework.emptyBody")}
            cta={
              <Button variant="primary" block onClick={() => openPicker()}>
                <Plus className="size-4" />
                {t("homework.newSubmissionCta")}
              </Button>
            }
          />
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <StatTile icon={<CheckCircle2 />} label={t("homework.statGraded")} value={formatXp(gradedCount, locale)} />
              <StatTile
                icon={<Clock />}
                label={t("homework.statWaiting")}
                value={formatXp(waitingCount, locale)}
                highlight
              />
              <StatTile
                icon={<Star />}
                label={t("homework.statAvg")}
                value={avg10 != null ? formatXp(avg10, locale) : "—"}
              />
            </div>

            <Button variant="primary" block onClick={() => openPicker()}>
              <Plus className="size-4" />
              {t("homework.newSubmissionCta")}
            </Button>

            <div className="flex gap-1 rounded-2xl bg-tint p-1" role="tablist">
              {(["all", "waiting", "graded"] as FilterKind[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={filter === f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    "flex-1 rounded-xl px-3 py-2 text-[12.5px] font-bold transition-colors",
                    filter === f ? "bg-card text-foreground shadow-soft" : "text-muted-foreground",
                  )}
                >
                  {t(`homework.filter${f === "all" ? "All" : f === "waiting" ? "Waiting" : "Graded"}`)}
                </button>
              ))}
            </div>

            {filteredItems.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">{t("homework.filterEmpty")}</p>
            ) : (
              <div>
                {filteredItems.map((it) => (
                  <HwListRow
                    key={it.id}
                    item={it}
                    locale={locale}
                    t={t}
                    onOpen={() => setSelectedId(it.id)}
                    onResubmit={() => openPicker(it.assignmentId)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <Dialog open={pickerOpen} onOpenChange={handlePickerOpenChange}>
        <DialogContent className="max-w-md gap-4 border-border bg-card p-5 text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground">
              {stage === "list" ? t("homework.picker.title") : t("homework.picker.uploadTitle")}
            </DialogTitle>
          </DialogHeader>

          {stage === "list" ? (
            <div className="-mx-1 max-h-[65vh] overflow-y-auto px-1">
              {pickerLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-16 w-full rounded-md" />
                  <Skeleton className="h-16 w-full rounded-md" />
                  <Skeleton className="h-16 w-full rounded-md" />
                </div>
              ) : pickerError ? (
                <EmptyState
                  icon="⚠️"
                  title={t("common.errorTitle")}
                  body={t("homework.picker.loadError")}
                  cta={
                    <Button variant="secondary" size="sm" onClick={() => void loadPickerItems()}>
                      {t("common.retry")}
                    </Button>
                  }
                />
              ) : pickerItems.length === 0 ? (
                <EmptyState icon="🎉" title={t("homework.picker.emptyTitle")} body={t("homework.picker.emptyBody")} />
              ) : (
                <PickerList items={pickerItems} onSelect={selectPickerItem} t={t} locale={locale} />
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <button
                type="button"
                onClick={() => setStage("list")}
                className="inline-flex items-center gap-1 text-[12.5px] font-bold text-muted-foreground"
              >
                <ArrowLeft className="size-3.5" />
                {t("homework.picker.backToPicker")}
              </button>

              <Card className="flex items-center gap-3">
                <div className="grid size-[42px] flex-none place-items-center rounded-md bg-primary text-primary-foreground">
                  <ClipboardCheck className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-bold text-foreground">{pickedItem?.title}</div>
                  <div className="truncate text-xs font-semibold text-muted-foreground">
                    {pickedItem?.module_title}
                    {pickedItem
                      ? ` · ${t("homework.picker.maxScoreLabel", { max: formatXp(pickedItem.max_score, locale) })}`
                      : ""}
                  </div>
                </div>
              </Card>

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
                  <img
                    src={previewUrl}
                    alt=""
                    className="max-h-64 w-full rounded-lg border border-border object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="absolute bottom-2 right-2 rounded-full bg-card/90 px-3 py-1.5 text-[11.5px] font-bold text-foreground shadow-soft"
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
                  <span className="text-[11.5px] font-semibold text-muted-foreground">
                    {t("homework.picker.pickPhotoHint")}
                  </span>
                </button>
              )}

              <div>
                <label className="mb-1.5 block text-[12.5px] font-bold text-foreground">
                  {t("homework.picker.noteLabel")}
                </label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t("homework.picker.notePlaceholder")}
                  rows={3}
                  className="w-full resize-none rounded-lg border border-border bg-card p-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <Button variant="primary" block disabled={!file || submitting} onClick={() => void submitHomework(false)}>
                {submitting ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                {submitting ? t("homework.picker.submitting") : t("homework.picker.submitCta")}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

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
    </PageShell>
  );
}

function HwListRow({
  item,
  locale,
  t,
  onOpen,
  onResubmit,
}: {
  item: HwItem;
  locale: string;
  t: TFunction;
  onOpen: () => void;
  onResubmit: () => void;
}) {
  const clickable = item.status === "graded";
  return (
    <Card
      onClick={clickable ? onOpen : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen();
              }
            }
          : undefined
      }
      className={cn(
        "mb-2 flex items-center gap-3 p-[11px]",
        clickable && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      )}
    >
      <div className="grid size-11 flex-none place-items-center rounded-md bg-primary text-primary-foreground">
        <ClipboardCheck className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-bold text-foreground">{item.title}</div>
        <div className="truncate text-[11.5px] font-semibold text-muted-foreground">
          {item.moduleTitle} · {relativeTime(item.submittedAt, t)}
        </div>
      </div>
      {item.status === "graded" ? (
        <div className="flex flex-none flex-col items-end gap-1">
          <span className="text-[15px] font-extrabold tabular-nums text-foreground">
            {formatXp(item.effectiveScore ?? 0, locale)}/{formatXp(item.maxScore, locale)}
          </span>
          <StatusChip kind="ok" label={t("homework.statusGraded")} />
        </div>
      ) : item.status === "redo" ? (
        <Button
          variant="primary"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onResubmit();
          }}
        >
          {t("homework.resubmitCta")}
        </Button>
      ) : (
        <div className="flex flex-none flex-col items-end gap-1">
          <StatusChip kind="wait" label={t("homework.statusWaiting")} />
          <span className="text-[11px] font-semibold text-gold-2">{t("homework.waitingHint")}</span>
        </div>
      )}
      {clickable && <ChevronRight className="size-4 flex-none text-muted-foreground" />}
    </Card>
  );
}

// Picker list — grouped by module (rows already arrive module-ordered from the RPC, so a
// SectionHeader is inserted whenever module_id changes rather than pre-grouping into a map).
function PickerList({
  items,
  onSelect,
  t,
  locale,
}: {
  items: AssignableItem[];
  onSelect: (item: AssignableItem) => void;
  t: TFunction;
  locale: string;
}) {
  let lastModuleId: string | null = null;
  return (
    <div>
      {items.map((item, idx) => {
        const showHeader = item.module_id !== lastModuleId;
        lastModuleId = item.module_id;
        return (
          <Fragment key={item.assignment_id}>
            {showHeader && (
              <SectionHeader
                title={t("homework.picker.moduleHeader", { n: item.module_number, title: item.module_title })}
                className={idx === 0 ? "mt-0" : undefined}
              />
            )}
            <Card
              onClick={() => onSelect(item)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(item);
                }
              }}
              className="mb-2 flex cursor-pointer items-center gap-3 p-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <div className="grid size-9 flex-none place-items-center rounded-md bg-tint text-[11px] font-extrabold text-foreground">
                V{item.step_number}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-bold text-foreground">{item.title}</div>
                <div className="truncate text-[11.5px] font-semibold text-muted-foreground">{item.module_title}</div>
              </div>
              {renderPickerStateChip(item, t, locale)}
              <ChevronRight className="size-4 flex-none text-muted-foreground" />
            </Card>
          </Fragment>
        );
      })}
    </div>
  );
}

function renderPickerStateChip(item: AssignableItem, t: TFunction, locale: string) {
  switch (item.state) {
    case "graded":
      return (
        <StatusChip
          kind="ok"
          label={t("homework.picker.stateGraded", {
            score: formatXp(item.score ?? 0, locale),
            max: formatXp(item.max_score, locale),
          })}
        />
      );
    case "needs_redo":
      return <StatusChip kind="redo" label={t("homework.statusRedo")} />;
    case "pending":
      return <StatusChip kind="wait" label={t("homework.statusWaiting")} />;
    default:
      return <StatusChip kind="none" label={t("homework.picker.stateNone")} />;
  }
}
