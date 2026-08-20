// TeacherGrade — `/tg/teacher/grade`, the mobile grading queue (Phase 1 centerpiece).
//
// Renders INSIDE TeacherShell (App.tsx owns the shell + bottom nav + staff guard), so this file is
// page CONTENT only. One-at-a-time card: photo (GradePhoto) → max_score-derived score chips (+ a
// "boshqa" free entry) → collapsible feedback → the SINGLE coral primary "Baholash → keyingi" that
// submits and auto-advances. Every write goes through src/lib/teacherApi.ts, which mirrors
// TeacherHomework.saveScore's exact columns so XP triggers fire identically (see that file's header).
//
// QUEUE MODEL: `remaining` is the working list (front = current card). `doneCount` counts items
// handled this session (graded / skipped / redo / co-teacher-claimed) and drives the "3 / 12"
// progress. `processed` (a ref Set) remembers handled ids so a background reconcile() refetch never
// re-surfaces a skipped/redone item, while still pruning items a co-teacher graded ahead of us and
// appending brand-new submissions — without disturbing the card currently on screen.
//
// STATES (all required): loading (Skeleton) · error/offline (navigator.onLine + retry) · empty /
// end-of-queue ("Baholash tugadi ✅") · submit-in-flight (disabled primary + spinner) · submit-failed
// (toast, KEEP the score, DON'T advance) · already-graded-by-co-teacher (gentle "boshqa ustoz
// baholadi" skip, member-forgiveness) · undo (Sonner toast "Ortga" RE-OPENS the just-graded item for
// correction — purely client-side, NO DB score-clear; the correction lands on the next submitScore).
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, MessageSquarePlus, RotateCcw, SkipForward } from "lucide-react";
import { Card, Button, StatusChip, ProgressBar, EmptyState, Skeleton } from "@/components/ui-kit";
import { cn } from "@/lib/utils";
import { GradePhoto } from "@/components/teacher/GradePhoto";
import { VoiceRecorder } from "@/components/homework/VoiceRecorder";
import { uploadFeedbackVoice, removeFeedbackVoice } from "@/lib/homeworkAudio";
import {
  fetchPendingQueue,
  submitScore,
  returnForRedo,
  type PendingSubmission,
} from "@/lib/teacherApi";

const PENDING_COUNT_KEY = ["teacher-pending-grading-count"]; // prefix — invalidates usePendingGrading

function agoUz(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "hozirgina";
  if (m < 60) return `${m} daqiqa oldin`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} soat oldin`;
  const d = Math.floor(h / 24);
  return `${d} kun oldin`;
}

// student_name arrives as "Ism Familiya (@username)"; strip the handle for compact toast lines.
const plainName = (s: PendingSubmission) => s.student_name.replace(/\s*\(@[^)]*\)\s*$/, "").trim() || "O'quvchi";

// Preset score chips derived from max_score (top band), clamped to non-negative. Shared by the chip
// row and the undo re-open so a restored score lands back on its chip when it matches one.
const chipValuesFor = (maxScore: number) => [maxScore, maxScore - 1, maxScore - 2, maxScore - 3].filter((v) => v >= 0);

export default function TeacherGrade() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [remaining, setRemaining] = useState<PendingSubmission[]>([]);
  const [doneCount, setDoneCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Per-card input. chipScore = a preset chip; when customOpen, the free numeric entry wins instead.
  const [chipScore, setChipScore] = useState<number | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [voiceBlob, setVoiceBlob] = useState<Blob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [redoing, setRedoing] = useState(false);

  const processed = useRef<Set<string>>(new Set());
  // Remembers the last successfully-uploaded voice object for the CURRENT item, so that if the
  // teacher undoes, deletes the restored note, and re-submits without recording a replacement, we
  // can best-effort clean up the now-orphaned storage object (see handleSubmit).
  const lastVoiceUploadRef = useRef<{ submissionId: string; path: string } | null>(null);

  const current = remaining[0] ?? null;
  const total = doneCount + remaining.length;
  const position = remaining.length ? doneCount + 1 : total;
  const pct = total > 0 ? (doneCount / total) * 100 : 100;
  const offline = typeof navigator !== "undefined" && !navigator.onLine;

  const resetInputs = useCallback(() => {
    setChipScore(null);
    setCustomOpen(false);
    setCustom("");
    setShowFeedback(false);
    setFeedback("");
    setVoiceBlob(null);
  }, []);

  // Re-open-to-correct (undo): put an already-entered score + feedback + voice note BACK into the
  // inputs so the teacher only has to fix the mis-tap and re-submit. A value matching a preset chip
  // restores the chip; anything else opens the free "boshqa" entry pre-filled. No DB write — purely
  // local state (the voice blob is the SAME object already uploaded by the just-undone submit; if
  // the teacher deletes it before re-submitting, handleSubmit best-effort removes that object).
  const restoreInputs = useCallback((item: PendingSubmission, score: number, fb: string, voice: Blob | null) => {
    if (chipValuesFor(item.max_score).includes(score)) {
      setChipScore(score);
      setCustomOpen(false);
      setCustom("");
    } else {
      setChipScore(null);
      setCustomOpen(true);
      setCustom(String(score));
    }
    setFeedback(fb);
    setVoiceBlob(voice);
    setShowFeedback(fb.trim() !== "" || voice != null);
  }, []);

  const advance = useCallback(() => {
    setRemaining((prev) => prev.slice(1));
    setDoneCount((c) => c + 1);
    resetInputs();
  }, [resetInputs]);

  // Initial load / retry.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const q = await fetchPendingQueue();
        if (cancelled) return;
        processed.current = new Set();
        setRemaining(q);
        setDoneCount(0);
        resetInputs();
      } catch {
        if (!cancelled) setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey, resetInputs]);

  // Non-disruptive background reconcile after a write: preserve the on-screen card (head), prune
  // items a co-teacher graded ahead of us (gone from the fresh server queue), and append brand-new
  // submissions. Skipped/redone/graded ids stay hidden via `processed`. A failed refetch is a no-op.
  const reconcile = useCallback(async () => {
    try {
      const fresh = await fetchPendingQueue();
      const freshIds = new Set(fresh.map((f) => f.submission_id));
      setRemaining((prev) => {
        if (prev.length === 0) {
          return fresh.filter((f) => !processed.current.has(f.submission_id));
        }
        const [head, ...rest] = prev;
        const keptRest = rest.filter((p) => freshIds.has(p.submission_id));
        const known = new Set(prev.map((p) => p.submission_id));
        const added = fresh.filter(
          (f) => !known.has(f.submission_id) && !processed.current.has(f.submission_id),
        );
        return [head, ...keptRest, ...added];
      });
    } catch {
      /* keep the local queue; reconcile is best-effort */
    }
  }, []);

  const invalidateBadge = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: PENDING_COUNT_KEY });
  }, [queryClient]);

  const chosen = customOpen ? (custom.trim() === "" ? null : Number(custom)) : chipScore;
  // `homework_submissions.score` is a smallint — scores are whole numbers (0..max_score, low/failing valid).
  const chosenValid =
    current != null && chosen != null && Number.isInteger(chosen) && chosen >= 0 && chosen <= current.max_score;

  const chipValues = current ? chipValuesFor(current.max_score) : [];

  const handleSubmit = async () => {
    if (!current || !chosenValid || submitting || redoing) return;
    const item = current;
    const value = chosen as number;
    const fb = feedback;
    // The recorder's `disabled` prop can't interrupt an in-progress recording, so we simply take
    // whatever finalized blob is in state right now — a mid-recording/mid-encode note (still null,
    // onChange hasn't fired yet) is treated as no-voice-this-round, which is acceptable (T2 note).
    const blob = voiceBlob;
    setSubmitting(true);
    try {
      // Fix round 1 (Important A): default to `undefined`, NOT null. The RPC backing this queue
      // (teacher_pending_submissions) never returns any existing score_feedback_voice_path, so this
      // screen has no way to know whether one already exists — leaving voicePath undefined tells
      // submitScore to preserve whatever is already on the row instead of clobbering it with null.
      let voicePath: string | null | undefined = undefined;
      if (blob) {
        try {
          voicePath = await uploadFeedbackVoice(item.user_id, item.submission_id, blob);
          lastVoiceUploadRef.current = { submissionId: item.submission_id, path: voicePath };
        } catch {
          toast.error("Ovozli izohni yuklab bo'lmadi. Qayta urinib ko'ring.");
          return;
        }
      } else if (lastVoiceUploadRef.current?.submissionId === item.submission_id) {
        // The teacher deleted a note that WE uploaded earlier this round (e.g. after an undo
        // re-opened this item with a restored note) — we know about this one, so explicitly clear
        // it (not just "preserve") and best-effort clean up the now-orphaned object.
        voicePath = null;
        void removeFeedbackVoice(item.user_id, item.submission_id);
        lastVoiceUploadRef.current = null;
      }

      const res = await submitScore(item.submission_id, value, fb, voicePath);

      if (res.status === "already_graded") {
        // Member-forgiveness: a co-teacher grabbed it between load and submit. Don't clobber; skip it.
        processed.current.add(item.submission_id);
        advance();
        invalidateBadge();
        void reconcile();
        toast.message("Boshqa ustoz baholadi", { description: `${plainName(item)} — o'tkazib yuborildi` });
        return;
      }
      if (res.status === "error") {
        // KEEP the score, DON'T advance — a grade must never be silently lost.
        toast.error("Baholashda xatolik. Bal saqlanmadi — qayta urinib ko'ring.");
        return;
      }

      // Success — advance immediately, offer a 6s undo (auto-advance makes a fat-finger unrecoverable).
      processed.current.add(item.submission_id);
      advance();
      invalidateBadge();
      toast.success(`${plainName(item)} — ${value}/${item.max_score} ✓`, {
        duration: 6000,
        action: {
          // "Ortga" RE-OPENS this item to CORRECT the score — purely client-side, NO DB write here.
          // The grade stays committed (safe: identical to having no undo) until the teacher re-submits a
          // corrected value, which is a guard-allowed score-CHANGE (non-null→non-null) that re-uses the
          // idempotent hw_score:<assignment_id> XP ref-key. We restore the entered score + feedback so
          // only the mis-tap needs fixing. There is NO score→null clear anywhere (that would trip
          // homework_submissions_guard and orphan the score — see teacherApi.ts).
          label: "Ortga",
          onClick: () => {
            processed.current.delete(item.submission_id);
            setRemaining((prev) => [item, ...prev.filter((p) => p.submission_id !== item.submission_id)]);
            setDoneCount((c) => Math.max(0, c - 1));
            restoreInputs(item, value, fb, blob);
            toast.info("Qayta baholash uchun ochildi");
          },
        },
      });
      void reconcile();
    } catch {
      // supabase-js can THROW on a network failure (exactly when offline). Treat it like a returned
      // {status:"error"}: keep the entered score, DON'T advance. The finally clears `submitting` so
      // the coral primary can never wedge disabled+spinning until a remount.
      toast.error("Baholashda xatolik. Bal saqlanmadi — qayta urinib ko'ring.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSkip = () => {
    if (!current || submitting || redoing) return;
    processed.current.add(current.submission_id);
    advance();
  };

  const handleRedo = async () => {
    if (!current || redoing || submitting) return;
    const item = current;
    setRedoing(true);
    try {
      const r = await returnForRedo(item.submission_id);
      if (!r.ok) {
        toast.error("Qaytarib bo'lmadi. Qayta urinib ko'ring.");
        return;
      }
      processed.current.add(item.submission_id);
      advance();
      invalidateBadge();
      void reconcile();
      toast.success(`${plainName(item)} — talabaga qaytarildi 🔓`);
    } catch {
      // supabase-js can THROW on a network failure — treat like a failed return, keep the item. The
      // finally clears `redoing` so the button (and the submit/skip lock) can never wedge.
      toast.error("Qaytarib bo'lmadi. Qayta urinib ko'ring.");
    } finally {
      setRedoing(false);
    }
  };

  // ---- states ------------------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-2 flex-1 rounded-full" />
          <Skeleton className="h-4 w-12" />
        </div>
        <Card className="space-y-4">
          <Skeleton className="h-[38vh] w-full rounded-lg" />
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-28" />
          <div className="flex gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-11 w-14 rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-11 w-full rounded-lg" />
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={offline ? "📡" : "⚠️"}
        title={offline ? "Internet yo'q" : "Xatolik"}
        body={
          offline
            ? "Ulanishni tekshiring va qayta urinib ko'ring."
            : "Baholash navbatini yuklab bo'lmadi. Birozdan so'ng qayta urinib ko'ring."
        }
        cta={
          <Button variant="secondary" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
            Qayta urinish
          </Button>
        }
      />
    );
  }

  if (!current) {
    return (
      <EmptyState
        icon="✅"
        title="Baholash tugadi"
        body={
          doneCount > 0
            ? "Barcha ishlar baholandi. Ajoyib ish! Yangi topshiriqlar kelganda shu yerda ko'rinadi."
            : "Hozircha baholanadigan ish yo'q. Yangi topshiriqlar kelganda shu yerda ko'rinadi."
        }
        cta={
          <Button variant="secondary" size="sm" onClick={() => navigate("/tg/teacher")}>
            Bosh sahifa
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Progress: slim bar + "3 / 12" (tabular-nums). */}
      <div className="flex items-center gap-3">
        <ProgressBar value={pct} />
        <span className="flex-none tabular-nums text-sm font-bold text-muted-foreground">
          {position} / {total}
        </span>
      </div>

      <Card className="space-y-3.5">
        <GradePhoto submissionId={current.submission_id} media={current.media} alt={current.assignment_title} />

        {/* Student + module/task label + submitted-ago. */}
        <div className="min-w-0 space-y-1">
          <div className="truncate text-[15px] font-extrabold tracking-tight text-foreground">
            {current.student_name}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-[12.5px] font-semibold text-muted-foreground">
              Modul {current.module_number} · Vazifa {current.task_number}
            </span>
            <span className="text-[12.5px] font-semibold text-muted-foreground">· {agoUz(current.submitted_at)}</span>
          </div>
          {current.is_resubmission && (
            <div className="flex items-center gap-2 pt-0.5">
              <StatusChip kind="wait" label="Qayta topshirilgan" />
              {current.previous_score != null && (
                <span className="text-[11.5px] font-semibold text-muted-foreground tabular-nums">
                  oldingi bal: {current.previous_score}/{current.max_score}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Score chips derived from max_score (top band). "boshqa" reveals a free 0..max entry —
            a low/failing score is valid. These are SELECTION (emerald when picked), not the primary. */}
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {chipValues.map((v) => {
              const selected = !customOpen && chipScore === v;
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => {
                    setChipScore(v);
                    setCustomOpen(false);
                    setCustom("");
                  }}
                  aria-pressed={selected}
                  className={cn(
                    "min-h-[44px] min-w-[52px] rounded-lg border px-3 text-base font-extrabold tabular-nums transition-colors",
                    selected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-tint text-foreground hover:bg-tint/70",
                  )}
                >
                  {v}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => {
                setCustomOpen(true);
                setChipScore(null);
              }}
              aria-pressed={customOpen}
              className={cn(
                "min-h-[44px] rounded-lg border px-3 text-sm font-bold transition-colors",
                customOpen
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-tint text-foreground hover:bg-tint/70",
              )}
            >
              boshqa
            </button>
          </div>

          {customOpen && (
            <div className="flex items-center gap-2">
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={current.max_score}
                value={custom}
                autoFocus
                onChange={(e) => setCustom(e.target.value)}
                placeholder={`0–${current.max_score}`}
                className="w-28 rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-base font-extrabold tabular-nums text-foreground placeholder:text-sm placeholder:font-semibold placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <span className="text-xs font-semibold text-muted-foreground">/ {current.max_score}</span>
              {custom.trim() !== "" && !chosenValid && (
                <span className="text-xs font-semibold text-danger-2">0–{current.max_score} oralig'ida</span>
              )}
            </div>
          )}
        </div>

        {/* Feedback kept OUT of the default fold (keyboard would cover the photo/chips/primary).
            Voice note lives beside the text field, revealed together. */}
        {showFeedback ? (
          <div className="space-y-2">
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={3}
              placeholder="Izoh (ixtiyoriy)"
              className="w-full resize-none rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <VoiceRecorder value={voiceBlob} onChange={setVoiceBlob} disabled={submitting || redoing} />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowFeedback(true)}
            className="inline-flex min-h-[40px] items-center gap-1.5 text-[13px] font-bold text-muted-foreground transition-colors hover:text-foreground"
          >
            <MessageSquarePlus className="size-4" />
            Izoh qo'shish
            {(feedback.trim() !== "" || voiceBlob) && <span className="text-cta">•</span>}
          </button>
        )}

        {/* The ONE coral primary — submits + auto-advances. */}
        <Button variant="primary" block disabled={!chosenValid || submitting || redoing} onClick={handleSubmit}>
          {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
          Baholash → keyingi
        </Button>

        {/* Ghost secondaries — skip + return-for-redo (never coral). */}
        <div className="flex gap-2">
          <Button variant="ghost" block onClick={handleSkip} disabled={submitting || redoing}>
            <SkipForward className="size-4" />
            O'tkazib yuborish
          </Button>
          <Button variant="ghost" block onClick={handleRedo} disabled={redoing || submitting}>
            {redoing ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
            🔓 Qaytarish
          </Button>
        </div>
      </Card>
    </div>
  );
}
