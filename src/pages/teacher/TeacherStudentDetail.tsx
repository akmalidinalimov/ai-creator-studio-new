// TeacherStudentDetail — `/tg/teacher/groups/student/:studentId`, the student-detail screen (Phase 2,
// Task 2). Reached from the Task-1 roster (`TeacherGroups` → `navigate('/tg/teacher/groups/student/:id')`,
// which also `setGroupId`'s the shared selection to that student's group).
//
// Renders INSIDE `TeacherShell` (App.tsx owns the shell + bottom nav + staff guard), so this file is
// page CONTENT only (bare column, no `max-w-2xl`/`px` — the shell owns those).
//
// ── THE HOMEWORK-HISTORY READ: a DIRECT RLS query, NO new backend. ──────────────────────────────────
// `homework_submissions` policy "hws own select" (src: 20260706200000_fix_teacher_homework_rls.sql:24 —
// still the latest def; #86/20260818190000 only references it in a comment, never redefines it) is:
//     auth.uid() = user_id
//     OR has_role(auth.uid(),'admin')
//     OR (has_role(auth.uid(),'teacher') AND public.is_teacher_of(user_id, auth.uid()))
// and `is_teacher_of` was rewritten JUNCTION-AWARE in 20260818190000:124 (its teachership test is now
// `public.is_group_teacher(p.group_id, _teacher)` = primary groups.teacher_id ∪ group_teachers). So the
// AUTHENTICATED teacher client's `.from('homework_submissions').select(...).eq('user_id', studentId)`
// returns that student's rows for a CO-TEACHER of the student's group — no RPC needed. A student NOT in
// the teacher's scope fails `is_teacher_of` → RLS returns [] (rendered as the "no homework yet" empty).
//
// ── THE BASICS (name / group / lessons) are NOT directly readable by a teacher. ─────────────────────
// `profiles` ("profiles select own or admin") and `lesson_progress` ("progress select own or admin") are
// own-or-admin ONLY (no teacher branch — verified in 20260426085840). A teacher's direct read of another
// student's profile/lesson_progress therefore returns []. The visibility-correct source is the junction-
// gated `staff_group_members(_group_id)` RPC (gated by can_see_group, so co-teachers pass), which already
// returns name/completed_lessons/avg_score per student. We resolve the student there (the shared selected
// group first — the roster set it on navigate — then the teacher's other groups as a safety net). XP +
// streak are omitted, not invented: no cheap teacher-visible read exists for them.
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { BellRing, BookOpen, ChevronLeft, ClipboardCheck, Star } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useSelectedGroup } from "@/hooks/useSelectedGroup";
import { effectiveLeafGrades } from "@/lib/homeworkStats";
import { formatXp } from "@/lib/xp";
import { Card, SectionHeader, StatTile, StatusChip, Button, EmptyState, Skeleton } from "@/components/ui-kit";

// A `homework_submissions` row (+ embedded assignment/module) as read via the "hws own select" RLS policy.
interface SubmissionRaw {
  id: string;
  assignment_id: string;
  submitted_at: string;
  score: number | null;
  score_feedback: string | null;
  score_is_stale: boolean | null;
  scored_at: string | null;
  previous_attempts: any[] | null;
  homework_assignments: {
    title: string;
    max_score: number;
    modules: { title: string | null; position: number | null } | null;
  } | null;
}

type HwStatus = "graded" | "waiting";

interface HwItem {
  id: string;
  title: string;
  moduleTitle: string;
  submittedAt: string;
  maxScore: number;
  status: HwStatus;
  score: number | null;
  feedback: string | null;
}

// A `staff_group_members(_group_id)` row (columns per 20260502225517_...:163, cited in TeacherGroups).
interface RosterMember {
  id: string;
  name: string | null;
  last_name: string | null;
  completed_lessons: number | null;
  avg_score: number | null;
}

interface Basics {
  fullName: string;
  groupName: string | null;
  completedLessons: number;
}

const offlineNow = () => typeof navigator !== "undefined" && !navigator.onLine;

const fullNameOf = (m: RosterMember) =>
  [m.name, m.last_name].map((s) => (s || "").trim()).filter(Boolean).join(" ") || "O'quvchi";

// Relative "submitted N ago" in Uzbek; null/blank → "—". Same shape as TeacherGroups' agoUz.
function agoUz(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "hozirgina";
  if (m < 60) return `${m} daqiqa oldin`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} soat oldin`;
  const d = Math.floor(h / 24);
  return `${d} kun oldin`;
}

export default function TeacherStudentDetail() {
  const { studentId } = useParams<{ studentId: string }>();
  const navigate = useNavigate();
  // The teacher's groups (junction-aware) + the shared selection — used to locate the student's basics
  // within visibility. Never throws (auth/RPC/empty all resolve to groups: []).
  const { groups, groupId, loading: groupsLoading } = useSelectedGroup();

  const [items, setItems] = useState<HwItem[]>([]);
  const [hwLoading, setHwLoading] = useState(true);
  const [hwError, setHwError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [basics, setBasics] = useState<Basics | null>(null);
  const [basicsResolved, setBasicsResolved] = useState(false);

  // ── Homework history via the direct RLS query (see file header). ─────────────────────────────────
  useEffect(() => {
    if (!studentId) {
      setHwLoading(false);
      return;
    }
    let cancelled = false;
    setHwLoading(true);
    setHwError(false);
    (async () => {
      try {
        const { data, error } = await supabase
          .from("homework_submissions")
          .select(
            "id, assignment_id, submitted_at, score, score_feedback, score_is_stale, scored_at, previous_attempts, homework_assignments(title, max_score, modules(title, position))",
          )
          .eq("user_id", studentId)
          .order("submitted_at", { ascending: false });
        if (cancelled) return;
        if (error) throw error;

        const rows = ((data as any[]) || []) as SubmissionRaw[];
        // Effective-score fallback — exact reuse of Homework.tsx's logic (a resubmission clears the live
        // `score` but the last scored attempt still counts until the new grade lands).
        const leaves = rows.map((r) => ({ id: r.assignment_id, max_score: r.homework_assignments?.max_score ?? 0 }));
        const subs = rows.map((r) => ({
          assignment_id: r.assignment_id,
          score: r.score,
          score_feedback: r.score_feedback,
          scored_at: r.scored_at,
          previous_attempts: r.previous_attempts,
        }));
        const effByAssignment = new Map(effectiveLeafGrades(leaves, subs).map((e) => [e.assignment_id, e]));

        const built: HwItem[] = rows.map((r) => {
          const eff = effByAssignment.get(r.assignment_id);
          // score_is_stale = re-opened for regrade → even with a (stale) number in `score`, this is NOT a
          // finished grade yet: bucket as "waiting" (identical to Homework.tsx). "redo" is intentionally
          // never produced — no "needs resubmit" flag exists in the schema (see Homework.tsx header).
          const stale = !!r.score_is_stale;
          const status: HwStatus = eff?.effective_score != null && !stale ? "graded" : "waiting";
          return {
            id: r.id,
            title: r.homework_assignments?.title || "—",
            moduleTitle: r.homework_assignments?.modules?.title || "—",
            submittedAt: r.submitted_at,
            maxScore: r.homework_assignments?.max_score ?? 10,
            status,
            score: eff?.effective_score ?? null,
            feedback: eff?.effective_feedback ?? null,
          };
        });
        setItems(built);
      } catch (e) {
        if (!cancelled) {
          console.error("[TeacherStudentDetail] homework read failed", e);
          setHwError(true);
        }
      } finally {
        if (!cancelled) setHwLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studentId, reloadKey]);

  // ── Basics via the junction-gated staff_group_members RPC (see file header). Best-effort: any failure
  //    leaves basics null (generic header, lessons tile "—") — never blocks the homework content. ────
  useEffect(() => {
    if (groupsLoading) return; // wait for the teacher's group list first
    if (!studentId) {
      setBasicsResolved(true);
      return;
    }
    let cancelled = false;
    setBasicsResolved(false);
    (async () => {
      // Selected group first (the roster set it on navigate / it persists across a refresh), then the
      // teacher's other groups as a safety net for a deep-link into a non-selected group.
      const ordered = [...groups.filter((g) => g.id === groupId), ...groups.filter((g) => g.id !== groupId)];
      for (const g of ordered) {
        try {
          // Not in the generated types — cast the RPC name (frontend-typecheck-verify convention).
          const { data, error } = await supabase.rpc("staff_group_members" as any, { _group_id: g.id });
          if (cancelled) return;
          if (error) continue;
          const m = (((data as any[]) || []) as RosterMember[]).find((r) => r.id === studentId);
          if (m) {
            setBasics({
              fullName: fullNameOf(m),
              groupName: g.name,
              completedLessons: m.completed_lessons ?? 0,
            });
            setBasicsResolved(true);
            return;
          }
        } catch {
          /* try the next group */
        }
      }
      if (!cancelled) {
        setBasics(null);
        setBasicsResolved(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [groupsLoading, groups, groupId, studentId]);

  // Summary tiles derived from the readable homework rows (self-consistent with the list below).
  const summary = useMemo(() => {
    let earned = 0;
    let maxScored = 0;
    items.forEach((it) => {
      if (it.status === "graded" && it.score != null) {
        earned += it.score;
        maxScored += it.maxScore;
      }
    });
    return {
      submitted: items.length,
      avg10: maxScored > 0 ? +((earned / maxScored) * 10).toFixed(1) : null,
    };
  }, [items]);

  const loading = hwLoading || groupsLoading || !basicsResolved;

  const BackRow = (
    <div className="flex items-center justify-between gap-2">
      <Button variant="ghost" size="sm" onClick={() => navigate(-1)} aria-label="Orqaga">
        <ChevronLeft className="size-4" />
        Orqaga
      </Button>
      {/* Nudge is Phase 3 — a disabled "tez orada" stub (no coral; read screen). */}
      <Button variant="ghost" size="sm" disabled aria-disabled="true" title="Tez orada" className="gap-1.5">
        <BellRing className="size-4" />
        Eslatma
        <span className="text-[9px] font-semibold uppercase tracking-wide opacity-70">tez orada</span>
      </Button>
    </div>
  );

  if (loading) {
    return (
      <div className="space-y-4">
        {BackRow}
        <div className="space-y-1">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="grid grid-cols-3 gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[76px] rounded-md" />
          ))}
        </div>
        <Skeleton className="h-5 w-40" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[84px] w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (hwError) {
    return (
      <div className="space-y-4">
        {BackRow}
        <EmptyState
          icon={offlineNow() ? "📡" : "⚠️"}
          title={offlineNow() ? "Internet yo'q" : "Xatolik"}
          body={
            offlineNow()
              ? "Ulanishni tekshiring va qayta urinib ko'ring."
              : "Vazifa tarixini yuklab bo'lmadi. Birozdan so'ng qayta urinib ko'ring."
          }
          cta={
            <Button variant="secondary" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
              Qayta urinish
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {BackRow}

      <div className="min-w-0 space-y-1">
        <h1 className="truncate text-2xl font-extrabold tracking-tight text-foreground">
          {basics?.fullName ?? "O'quvchi"}
        </h1>
        {basics?.groupName && (
          <p className="truncate text-sm font-semibold text-muted-foreground">{basics.groupName}</p>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <StatTile
          icon={<BookOpen />}
          label="Darslar"
          value={basics ? formatXp(basics.completedLessons, "uz") : "—"}
        />
        <StatTile
          icon={<Star />}
          label="O'rtacha"
          value={summary.avg10 != null ? formatXp(summary.avg10, "uz") : "—"}
        />
        <StatTile icon={<ClipboardCheck />} label="Vazifalar" value={formatXp(summary.submitted, "uz")} />
      </div>

      <SectionHeader title="Vazifa tarixi" />

      {items.length === 0 ? (
        <EmptyState
          icon="📝"
          title="Hali vazifa topshirmagan"
          body="Bu o'quvchi hali biror vazifa topshirmagan. Topshirilganda shu yerda ko'rinadi."
        />
      ) : (
        <div className="space-y-2">
          {items.map((it) => (
            <HwHistoryRow key={it.id} item={it} />
          ))}
        </div>
      )}
    </div>
  );
}

// One homework-history entry — reuses the Homework.tsx graded-detail presentation (the `text-good-2`
// score, the `StatusChip`, and the feedback card's `bg-surface-2`/`border-border`) so teacher and
// student read the same artifact.
function HwHistoryRow({ item }: { item: HwItem }) {
  return (
    <Card className="space-y-2.5 p-3">
      <div className="flex items-center gap-3">
        <div className="grid size-10 flex-none place-items-center rounded-md bg-primary text-primary-foreground">
          <ClipboardCheck className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-bold text-foreground">{item.title}</div>
          <div className="truncate text-[11.5px] font-semibold text-muted-foreground">
            {item.moduleTitle} · {agoUz(item.submittedAt)}
          </div>
        </div>
        {item.status === "graded" ? (
          <div className="flex flex-none flex-col items-end gap-1">
            <span className="text-[15px] font-extrabold tabular-nums text-good-2">
              {formatXp(item.score ?? 0, "uz")}/{formatXp(item.maxScore, "uz")}
            </span>
            <StatusChip kind="ok" label="Baholandi" />
          </div>
        ) : (
          <StatusChip kind="wait" label="Kutilmoqda" />
        )}
      </div>

      {item.feedback && (
        <div className="rounded-lg border border-border bg-surface-2 p-3">
          <div className="mb-1 text-[11px] font-semibold text-muted-foreground">O'qituvchi izohi</div>
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/90">{item.feedback}</p>
        </div>
      )}
    </Card>
  );
}
