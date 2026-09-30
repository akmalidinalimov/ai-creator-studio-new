// TeacherGrade — `/tg/teacher/grade`, the mobile grading queue (Phase 1 centerpiece).
//
// Renders INSIDE TeacherShell (App.tsx owns the shell + bottom nav + staff guard), so this file is
// page CONTENT only. One-at-a-time card: photo (GradePhoto) → max_score-derived score chips (+ a
// "boshqa" free entry) → collapsible feedback → the SINGLE coral primary "Baholash → keyingi" that
// submits and auto-advances. Every write goes through src/lib/teacherApi.ts, which mirrors
// TeacherHomework.saveScore's exact columns so XP triggers fire identically (see that file's header).
//
// QUEUE MODEL: `queue` is every item still waiting, in the RPC's oldest-first order; the card on screen
// is the first item of `queue` that passes the filter (`visible[0]`). `handled` lists the items handled
// this session (graded / skipped / redo / co-teacher-claimed); the ones under the current filter drive
// the "3 / 12" progress. `processed` (a ref Set) remembers handled ids so a background reconcile()
// refetch never re-surfaces a skipped/redone item, while still pruning items a co-teacher graded ahead
// of us and appending brand-new submissions — without disturbing the card currently on screen.
// Items leave the queue BY ID (never "drop the head").
//
// THE INPUTS BELONG TO ONE SUBMISSION: the score, feedback and voice note are tied to the submission they
// were entered for (`inputsForRef`), and are cleared the moment any OTHER card is on screen — whatever
// moved it: grading/skipping, a filter chip, the bottom nav's "Baholash" tab (same route, so no remount,
// but the URL filter goes), a ?group= link that only resolves once the teacher's groups load, a background
// reconcile. One rule, not one reset per path, so a typed score or a recorded note can never land on a
// student the teacher is not looking at. An "Ortga" re-opens its card and claims the inputs for it, so an
// "Ortga" tapped while another grade is still being written keeps its restored score (audit TUI-6).
//
// FILTER (teacher audit PR-4, TUI-1): a teacher of AI Creators 5.0 and Challenge 6.0 can work through one
// course or one group at a time — "Hammasi · N", one chip per course with its count, one per group
// (GradeFilterBar; the rules are in src/lib/gradeFilter.ts). The whole queue is still loaded (the chips
// need every count); the filter only chooses which item is on screen. It starts at "Hammasi" unless the
// URL says otherwise (?course= / ?group=, e.g. from Home's per-course counts): the Groups screen's pick
// does NOT follow the teacher here, so work is never hidden by a choice made elsewhere. A URL filter that
// names nothing there (a stale link) is taken out of the URL once the queue and the groups have loaded,
// so it cannot wake up later and switch the card by itself. The filter is locked while a write is in
// flight. The card's course chip carries the course's colour (src/lib/courseTone.ts).
//
// STATES (all required): loading (Skeleton) · error/offline (navigator.onLine + retry) · empty /
// end-of-queue ("Baholash tugadi ✅") · nothing under the chosen filter ("Hammasini ko'rsatish") ·
// submit-in-flight (disabled primary + spinner) · submit-failed (toast, KEEP the score, DON'T
// advance) · already-graded-by-co-teacher (gentle "boshqa ustoz baholadi" skip, member-forgiveness) ·
// undo (Sonner toast "Ortga" RE-OPENS the just-graded item for correction — purely client-side, NO DB
// score-clear; the correction lands on the next submitScore).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, MessageSquarePlus, Mic, RotateCcw, SkipForward } from "lucide-react";
import { Card, Button, StatusChip, ProgressBar, EmptyState, Skeleton } from "@/components/ui-kit";
import { cn } from "@/lib/utils";
import { GradePhoto } from "@/components/teacher/GradePhoto";
import { GradeFilterBar } from "@/components/teacher/GradeFilterBar";
import { VoiceRecorder } from "@/components/homework/VoiceRecorder";
import { uploadFeedbackVoice, removeFeedbackVoice } from "@/lib/homeworkAudio";
import { hwLabel, scopeTag } from "@/lib/hwLabel";
import { courseTone } from "@/lib/courseTone";
import {
  NO_FILTER,
  buildGradeFilter,
  filterFromSearch,
  matchesFilter,
  searchFromFilter,
  type GradeFilter,
} from "@/lib/gradeFilter";
import { useSelectedGroup } from "@/hooks/useSelectedGroup";
import {
  fetchPendingQueue,
  submitScore,
  returnForRedo,
  notifyGradeVoice,
  requestTeacherVoiceInTelegram,
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
  const [searchParams, setSearchParams] = useSearchParams();
  // The teacher's groups (junction-aware teacher_groups), so a group with nothing waiting still has its chip.
  // Only the list is used: the shared selected group is deliberately NOT a grading filter (see the header).
  const { groups: teacherGroups, loading: groupsLoading } = useSelectedGroup();

  const [queue, setQueue] = useState<PendingSubmission[]>([]);
  const [handled, setHandled] = useState<PendingSubmission[]>([]);
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
  const [requestingVoice, setRequestingVoice] = useState(false);

  const processed = useRef<Set<string>>(new Set());
  // Remembers the last successfully-uploaded voice object for the CURRENT item, so that if the
  // teacher undoes, deletes the restored note, and re-submits without recording a replacement, we
  // can best-effort clean up the now-orphaned storage object (see handleSubmit).
  const lastVoiceUploadRef = useRef<{ submissionId: string; path: string } | null>(null);
  // Fix round 1 (Task 6 duplicate-DM bug): true ONLY when the VoiceRecorder itself just delivered a
  // BRAND NEW recording via onChange (handleVoiceChange below) — NOT when `restoreInputs` puts an
  // already-uploaded blob back into `voiceBlob` after "Ortga" undo. `voiceBlob` alone can't tell
  // these apart (both leave it truthy), so gating notifyGradeVoice on `voiceBlob` fired a SECOND
  // Telegram DM for the exact same note on every undo→fix-score→resubmit. Reset on every
  // resetInputs() (new card) and explicitly cleared in restoreInputs() (a restore is not a new
  // recording).
  const voiceRecordedThisRoundRef = useRef(false);
  // The submission the inputs above were entered for (null = nothing entered). See "THE INPUTS BELONG TO ONE
  // SUBMISSION" in the header: whenever another card is on screen, the inputs are cleared.
  const inputsForRef = useRef<string | null>(null);

  const wanted = useMemo(() => filterFromSearch(searchParams), [searchParams]);
  const model = useMemo(
    () => buildGradeFilter(queue, handled, teacherGroups, wanted),
    [queue, handled, teacherGroups, wanted],
  );
  const visible = model.visible;
  const current = visible[0] ?? null;
  const currentId = current?.submission_id ?? null;
  // The id of the card on screen, readable from async handlers (reconcile, the voice recorder, the inputs).
  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = currentId;
  // The filter in force, readable from the undo toast (its closure is from an older render).
  const filterRef = useRef<GradeFilter>(model.filter);
  filterRef.current = model.filter;
  const doneInView = handled.filter((h) => matchesFilter(h, model.filter)).length;
  const total = doneInView + visible.length;
  const position = visible.length ? doneInView + 1 : total;
  const pct = total > 0 ? (doneInView / total) * 100 : 100;
  const offline = typeof navigator !== "undefined" && !navigator.onLine;

  const resetInputs = useCallback(() => {
    setChipScore(null);
    setCustomOpen(false);
    setCustom("");
    setShowFeedback(false);
    setFeedback("");
    setVoiceBlob(null);
    voiceRecordedThisRoundRef.current = false;
    inputsForRef.current = null;
  }, []);

  // The teacher entered something on the card on screen: the inputs are now that submission's.
  const claimInputs = useCallback(() => {
    inputsForRef.current = currentIdRef.current;
  }, []);

  // ONE rule for every way the card can change (see the header): inputs entered for another submission are
  // cleared. A layout effect, so the new card is never painted — or tapped — with the old card's score.
  useLayoutEffect(() => {
    if (inputsForRef.current !== null && inputsForRef.current !== currentId) resetInputs();
  }, [currentId, resetInputs]);

  // Wraps VoiceRecorder's onChange: a non-null blob here means the recorder JUST finished capturing
  // + encoding a fresh note (VoiceRecorder only calls onChange from finishRecording/handleDelete/
  // handleReRecord — never as a reaction to the parent setting `value`), so this is the ONLY place
  // `voiceRecordedThisRoundRef` may be set true. `forId` is the card the recorder was on: a note that
  // finishes encoding after its card has left the screen belongs to that student, never to this one.
  const handleVoiceChange = useCallback((forId: string | null, blob: Blob | null) => {
    if (forId === null || forId !== currentIdRef.current) {
      if (blob) toast.message("Ovozli izoh saqlanmadi", { description: "U boshqa o'quvchining ishi uchun yozilgan edi." });
      return;
    }
    inputsForRef.current = forId;
    voiceRecordedThisRoundRef.current = blob != null;
    setVoiceBlob(blob);
  }, []);
  const onVoiceChange = useCallback((blob: Blob | null) => handleVoiceChange(currentId, blob), [currentId, handleVoiceChange]);

  // Voice bridge. Telegram's webview denies Mini Apps the microphone on most devices, so the in-app
  // recorder is a dead end there. This asks the bot to prompt the teacher in her Telegram chat, where the
  // native recorder always works; the bot attaches the note to THIS submission and delivers it. We
  // deliberately do NOT close the Mini App — that would throw away the score she hasn't submitted yet.
  const requestVoiceInTelegram = useCallback(async (submissionId: string) => {
    setRequestingVoice(true);
    try {
      const r = await requestTeacherVoiceInTelegram(submissionId);
      if (r.ok) {
        toast.success("Botga xabar yuborildi", {
          description: "Bahoni saqlang, so'ng Telegram chatida ovozli izohni yuboring.",
        });
      } else if (r.code === "no_telegram") {
        toast.error("Telegram akkauntingiz ulanmagan — botni oching va /start bosing.");
      } else if (r.code === "busy") {
        toast.error("Botda boshqa amal ochiq — uni tugating yoki /cancel yuboring, so'ng qayta bosing.");
      } else if (r.code === "prompt_failed") {
        toast.error("Botga xabar yetkazilmadi — botni oching, /start bosing va qayta urinib ko'ring.");
      } else {
        toast.error("Xatolik yuz berdi. Qaytadan urinib ko'ring.");
      }
    } finally {
      setRequestingVoice(false);
    }
  }, []);

  // Re-open-to-correct (undo): put an already-entered score + feedback + voice note BACK into the
  // inputs so the teacher only has to fix the mis-tap and re-submit. A value matching a preset chip
  // restores the chip; anything else opens the free "boshqa" entry pre-filled. No DB write — purely
  // local state (the voice blob is the SAME object already uploaded by the just-undone submit; if
  // the teacher deletes it before re-submitting, handleSubmit best-effort removes that object).
  const restoreInputs = useCallback((item: PendingSubmission, score: number, fb: string, voice: Blob | null) => {
    // The restored inputs are the re-opened item's (it is put back on screen in the same update).
    inputsForRef.current = item.submission_id;
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
    // An undo-restore is NOT a new recording, even though `voice` (the same blob object already
    // uploaded by the just-undone submit) is truthy — must not re-arm the Telegram-push gate.
    voiceRecordedThisRoundRef.current = false;
    setShowFeedback(fb.trim() !== "" || voice != null);
  }, []);

  // `item` is handled: it leaves the queue BY ID. If it was the card on screen, the next card comes up and the
  // inputs rule clears them; after an "Ortga" during this item's write, the re-opened card (and its restored
  // score) stays put.
  const advance = useCallback((item: PendingSubmission) => {
    setQueue((prev) => prev.filter((p) => p.submission_id !== item.submission_id));
    setHandled((prev) => [...prev.filter((p) => p.submission_id !== item.submission_id), item]);
  }, []);

  // A new filter may show another card; the inputs rule clears the inputs when it does.
  const changeFilter = useCallback(
    (f: GradeFilter) => {
      setSearchParams(searchFromFilter(f), { replace: true });
    },
    [setSearchParams],
  );

  // A URL filter naming a course or group that is not there is ignored (buildGradeFilter drops it). Take it out of
  // the URL too, or it would wake up when that course's first new item arrives and switch the card by itself.
  // Judged only once the queue AND the teacher's groups have loaded: a ?group= of a group with nothing waiting
  // is only known from teacher_groups.
  const appliedCourse = model.filter.courseId;
  const appliedGroup = model.filter.groupId;
  const urlFilterStale = wanted.courseId !== appliedCourse || wanted.groupId !== appliedGroup;
  useEffect(() => {
    if (loading || error || groupsLoading || !urlFilterStale) return;
    setSearchParams(searchFromFilter({ courseId: appliedCourse, groupId: appliedGroup }), { replace: true });
  }, [loading, error, groupsLoading, urlFilterStale, appliedCourse, appliedGroup, setSearchParams]);

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
        setQueue(q);
        setHandled([]);
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

  // Non-disruptive background reconcile after a write: preserve the on-screen card, prune items a
  // co-teacher graded ahead of us (gone from the fresh server queue), and append brand-new
  // submissions. Skipped/redone/graded ids stay hidden via `processed`. A failed refetch is a no-op.
  const reconcile = useCallback(async () => {
    try {
      const fresh = await fetchPendingQueue();
      const freshIds = new Set(fresh.map((f) => f.submission_id));
      setQueue((prev) => {
        const onScreen = currentIdRef.current;
        const kept = prev.filter((p) => p.submission_id === onScreen || freshIds.has(p.submission_id));
        const known = new Set(prev.map((p) => p.submission_id));
        const added = fresh.filter(
          (f) => !known.has(f.submission_id) && !processed.current.has(f.submission_id),
        );
        return [...kept, ...added];
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
  // Card label parts: "5.0 · 1-GURUH PRE" (chip) and "M2 V1 — <title>" (line). course_title is the TASK's course.
  const currentScope = current ? scopeTag(current.course_title, current.group_name) : "";
  const currentTask = current
    ? hwLabel({ moduleNumber: current.module_number, step: current.task_number, title: current.assignment_title })
    : "";

  const handleSubmit = async () => {
    if (!current || !chosenValid || submitting || redoing) return;
    const item = current;
    const value = chosen as number;
    const fb = feedback;
    // The recorder's `disabled` prop can't interrupt an in-progress recording, so we simply take
    // whatever finalized blob is in state right now — a mid-recording/mid-encode note (still null,
    // onChange hasn't fired yet) is treated as no-voice-this-round, which is acceptable (T2 note).
    const blob = voiceBlob;
    // Read with the blob, not after the write: if the card changes while the write is in flight, the inputs
    // rule clears the ref, but this note is still this student's and still new.
    const voiceFresh = voiceRecordedThisRoundRef.current;
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
        advance(item);
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

      // Success. A NEW voice note recorded THIS round (gated on voiceRecordedThisRoundRef, NOT on
      // `blob` — an undo→resubmit still has `blob` truthy but must NOT re-fire) gets pushed to the
      // student's Telegram DM if they've started the bot — fire-and-forget: never awaited, never
      // allowed to affect the grade UI (notifyGradeVoice swallows its own errors).
      notifyGradeVoice(item.submission_id, { voiceFresh });

      // Advance immediately, offer a 6s undo (auto-advance makes a fat-finger unrecoverable).
      processed.current.add(item.submission_id);
      advance(item);
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
            setQueue((prev) => [item, ...prev.filter((p) => p.submission_id !== item.submission_id)]);
            setHandled((prev) => prev.filter((p) => p.submission_id !== item.submission_id));
            // The re-opened item must be the card on screen (or the inputs rule would clear its restored
            // score): if the filter was changed since, widen it back to "Hammasi" in the same update.
            if (!matchesFilter(item, filterRef.current)) changeFilter(NO_FILTER);
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
    advance(current);
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
      advance(item);
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

  if (model.total === 0) {
    return (
      <EmptyState
        icon="✅"
        title="Baholash tugadi"
        body={
          handled.length > 0
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

  // Course + group chips; locked while a grade or a return is being written (the card must not change mid-write).
  const filterBar = <GradeFilterBar model={model} onChange={changeFilter} disabled={submitting || redoing} />;

  if (!current) {
    // Work is waiting, just not under the chosen course / group.
    return (
      <div className="space-y-4">
        {filterBar}
        <EmptyState
          icon="✅"
          title="Bu tanlovda ish qolmadi"
          body={
            doneInView > 0
              ? "Tanlangan kurs yoki guruhdagi ishlar baholandi. Boshqa ishlar hali kutmoqda."
              : "Tanlangan kurs yoki guruhda baholanadigan ish yo'q. Boshqa ishlar kutmoqda."
          }
          cta={
            <Button variant="secondary" size="sm" onClick={() => changeFilter(NO_FILTER)}>
              Hammasini ko'rsatish ({model.total})
            </Button>
          }
        />
      </div>
    );
  }

  const tone = courseTone(current.course_title);

  return (
    <div className="space-y-4">
      {filterBar}

      {/* Progress under the chosen filter: slim bar + "3 / 12" (tabular-nums). */}
      <div className="flex items-center gap-3">
        <ProgressBar value={pct} />
        <span className="flex-none tabular-nums text-sm font-bold text-muted-foreground">
          {position} / {total}
        </span>
      </div>

      <Card className="space-y-3.5">
        <GradePhoto submissionId={current.submission_id} media={current.media} alt={current.assignment_title} />

        {/* Student + course/group chip + "M<n> V<step> — <title>" + submitted-ago. Chip and line together are
            the shared hw-label ("5.0 · 1-GURUH PRE · M2 V1 — <title>", src/lib/hwLabel.ts): the Challenge
            6.0 tasks are copies of the 5.0 tasks, so name + "Modul 2 · Vazifa 1" alone could be either course.
            The chip is in the course's colour (the TASK's course), the same colour as its filter chip. */}
        <div className="min-w-0 space-y-1">
          <div className="truncate text-[15px] font-extrabold tracking-tight text-foreground">
            {current.student_name}
          </div>
          {currentScope && (
            <span
              className={cn(
                "inline-block max-w-full truncate rounded-full px-2.5 py-1 align-middle text-[11px] font-extrabold",
                tone.chip,
              )}
              title={currentScope}
              data-course-tone={tone.key}
            >
              {currentScope}
            </span>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 max-w-full truncate text-[12.5px] font-semibold text-muted-foreground" title={currentTask}>
              {currentTask}
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
                    claimInputs();
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
                claimInputs();
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
                onChange={(e) => {
                  claimInputs();
                  setCustom(e.target.value);
                }}
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
              onChange={(e) => {
                claimInputs();
                setFeedback(e.target.value);
              }}
              rows={3}
              placeholder="Izoh (ixtiyoriy)"
              className="w-full resize-none rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <VoiceRecorder
              value={voiceBlob}
              onChange={onVoiceChange}
              disabled={submitting || redoing}
              fallback={
                current ? (
                  <button
                    type="button"
                    onClick={() => void requestVoiceInTelegram(current.submission_id)}
                    disabled={requestingVoice || submitting || redoing}
                    className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-[12.5px] font-bold text-foreground disabled:opacity-50"
                  >
                    {requestingVoice ? <Loader2 className="size-4 animate-spin" /> : <Mic className="size-4" />}
                    Telegramda ovoz yozish
                  </button>
                ) : null
              }
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              claimInputs();
              setShowFeedback(true);
            }}
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
