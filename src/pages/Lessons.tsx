import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ChevronRight, Play } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { formatXp } from "@/lib/xp";
import { cn } from "@/lib/utils";
import { aggregateHomeworkState, getHomeworkStateChip, type AssignableItem } from "@/lib/homeworkAssignable";
import {
  ProgressRing,
  SectionHeader,
  Button,
  EmptyState,
  Skeleton,
  ModuleRow,
  LessonRow,
  StatusChip,
  type ModuleRowState,
  type StatusChipKind,
} from "@/components/ui-kit";

// Fixed lesson-completion XP award — supabase/migrations/20260706090000_profile_gamification_phase1.sql
// xp_on_lesson_complete() awards a flat +20 per lesson_progress.completed_at (ref-key idempotent,
// reconciled by reconcile_all_xp()). Static constant like Dashboard.tsx's WEEKLY_XP_GOAL — not
// read from a settings table because the award amount itself isn't tunable today.
const LESSON_XP = 20;

interface LessonRec {
  id: string;
  title: string;
  position: number;
  durationSec: number | null;
  moduleId: string;
}

interface ModuleRec {
  id: string;
  title: string;
  position: number;
  lessons: LessonRec[];
}

export default function Lessons() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [trial, setTrial] = useState(false);
  const [enrolled, setEnrolled] = useState(true);

  const [courseId, setCourseId] = useState<string | null>(null);
  const [courseTitle, setCourseTitle] = useState("");
  const [modules, setModules] = useState<ModuleRec[]>([]);
  const [moduleLimit, setModuleLimit] = useState<number | null>(null);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Module-end homework (module-homework feature, 2026-08-18): student_assignable_homework()
  // rows grouped by module_id, so a module's LessonRows can be followed by a single "Uy
  // vazifasi" step row when that module has assignable homework. Fetched independently of the
  // course/module load above and fails SILENTLY (console.error only) — this is purely additive
  // decoration on top of Darslar, so an RPC hiccup must never break the core lesson list.
  const [homeworkByModule, setHomeworkByModule] = useState<Map<string, AssignableItem[]>>(new Map());

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const [profRes, enrollRes] = await Promise.all([
          supabase.from("profiles").select("account_type").eq("id", user.id).maybeSingle(),
          supabase
            .from("enrollments")
            .select("course_id, tier_id, courses(*), course_tiers(module_limit)")
            .eq("user_id", user.id),
        ]);
        if (enrollRes.error) throw enrollRes.error;
        if (cancelled) return;

        const isTrial = (((profRes.data as any)?.account_type as string) ?? "paid") === "provisional";
        setTrial(isTrial);

        const enrollments = (enrollRes.data || []).filter((e: any) => e.courses);
        if (!enrollments.length) {
          setEnrolled(false);
          setLoading(false);
          return;
        }
        setEnrolled(true);
        // Provisional (trial) accounts see homework/XP/stats but NO lessons (repo invariant —
        // mirrors CoursePage.tsx). Skip the module/lesson fetch entirely for them.
        if (isTrial) { setLoading(false); return; }

        const courseIds = enrollments.map((e: any) => e.courses.id as string);
        const { data: modsData, error: mErr } = await supabase
          .from("modules")
          .select("id, course_id, position, title, lessons(id, title, position, duration_seconds)")
          .in("course_id", courseIds)
          .order("position", { ascending: true });
        if (mErr) throw mErr;

        const modulesByCourse = new Map<string, ModuleRec[]>();
        (modsData || []).forEach((m: any) => {
          const rawLessons: LessonRec[] = ((m.lessons || []) as any[]).map(
            (l: any): LessonRec => ({
              id: l.id as string,
              title: l.title as string,
              position: (l.position as number) ?? 0,
              durationSec: (l.duration_seconds as number) ?? null,
              moduleId: m.id as string,
            }),
          );
          const lessons: LessonRec[] = rawLessons.sort((a, b) => a.position - b.position);
          const rec: ModuleRec = { id: m.id, title: m.title, position: m.position ?? 0, lessons };
          const arr = modulesByCourse.get(m.course_id) || [];
          arr.push(rec);
          modulesByCourse.set(m.course_id, arr);
        });
        modulesByCourse.forEach((arr) => arr.sort((a, b) => a.position - b.position));

        // Per-course tier-capped, position-ranked lesson order — mirrors Dashboard.tsx's
        // has_module_access-matching logic: modules ranked by position, only the first
        // `module_limit` accessible (null = unlimited). Used both to pick which enrolled course
        // is the "primary" one to browse here, and to scope the lesson_progress query.
        const perCourse = enrollments.map((e: any) => {
          const c = e.courses;
          const limit: number | null = e.course_tiers?.module_limit ?? null;
          const allModules = modulesByCourse.get(c.id) || [];
          const accessibleModules = limit == null ? allModules : allModules.slice(0, limit);
          const orderedLessons = accessibleModules.flatMap((m) => m.lessons);
          return { id: c.id as string, title: c.title as string, moduleLimit: limit, allModules, orderedLessons };
        });

        const allAccessibleLessonIds = perCourse.flatMap((c) => c.orderedLessons.map((l) => l.id));
        const { data: progressData } = await supabase
          .from("lesson_progress")
          .select("lesson_id, completed_at, updated_at")
          .eq("user_id", user.id)
          .in("lesson_id", allAccessibleLessonIds.length ? allAccessibleLessonIds : ["00000000-0000-0000-0000-000000000000"]);
        const completedSet = new Set((progressData || []).filter((p: any) => p.completed_at).map((p: any) => p.lesson_id as string));
        const lastActivityByLesson = new Map<string, number>();
        (progressData || []).forEach((p: any) => {
          if (p.updated_at) lastActivityByLesson.set(p.lesson_id, Date.parse(p.updated_at));
        });

        // Same "continue where you left off" course selection as Dashboard.tsx: most-recent
        // activity first, then most progress — so this page (and Home's "Kursim" card / the
        // Darslar tab, which both link here without a courseId) show the course the student is
        // actually working in.
        const ranked = perCourse.map((c) => {
          const total = c.orderedLessons.length;
          const doneCount = c.orderedLessons.filter((l) => completedSet.has(l.id)).length;
          const nextLesson = c.orderedLessons.find((l) => !completedSet.has(l.id));
          const lastActivityMs = c.orderedLessons.reduce((mx, l) => Math.max(mx, lastActivityByLesson.get(l.id) ?? 0), 0);
          return { ...c, total, doneCount, nextLesson, lastActivityMs };
        });
        ranked.sort((a, b) => (b.lastActivityMs - a.lastActivityMs) || (b.doneCount - a.doneCount));
        const primary =
          ranked.find((c) => c.nextLesson && c.doneCount < c.total) || ranked.find((c) => c.nextLesson) || ranked[0];

        if (cancelled) return;
        setCourseId(primary.id);
        setCourseTitle(primary.title);
        setModules(primary.allModules);
        setModuleLimit(primary.moduleLimit);
        setCompleted(completedSet);
      } catch (e) {
        if (!cancelled) { console.error("[Lessons] load failed", e); setError(true); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user, reloadKey]);

  // Module-end homework rows — independent, non-blocking fetch (see homeworkByModule above).
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error: rpcErr } = await supabase.rpc("student_assignable_homework" as any);
        if (rpcErr) throw rpcErr;
        if (cancelled) return;
        const rows = ((data as any[]) || []) as AssignableItem[];
        const byModule = new Map<string, AssignableItem[]>();
        rows.forEach((r) => {
          const arr = byModule.get(r.module_id) || [];
          arr.push(r);
          byModule.set(r.module_id, arr);
        });
        setHomeworkByModule(byModule);
      } catch (e) {
        // Non-blocking: the homework step row simply won't render for any module — Darslar
        // itself (lessons, progress, resume) is unaffected.
        if (!cancelled) console.error("[Lessons] module homework load failed", e);
      }
    })();
    return () => { cancelled = true; };
  }, [user, reloadKey]);

  const accessibleModules = moduleLimit == null ? modules : modules.slice(0, moduleLimit);
  const orderedAccessibleLessons = accessibleModules.flatMap((m) => m.lessons);
  const totalAccessible = orderedAccessibleLessons.length;
  const doneAccessible = orderedAccessibleLessons.filter((l) => completed.has(l.id)).length;
  const pct = totalAccessible ? Math.round((doneAccessible / totalAccessible) * 100) : 0;
  const nextLesson = orderedAccessibleLessons.find((l) => !completed.has(l.id));
  const activeModuleIndex = nextLesson ? modules.findIndex((m) => m.id === nextLesson.moduleId) : -1;
  const activeModuleId = activeModuleIndex >= 0 ? modules[activeModuleIndex].id : null;
  const activeModuleRank = activeModuleIndex >= 0 ? activeModuleIndex + 1 : null;

  const offline = typeof navigator !== "undefined" && !navigator.onLine;

  const toggleExpanded = (moduleId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(moduleId)) next.delete(moduleId); else next.add(moduleId);
      return next;
    });
  };

  return (
    <PageShell>
      <div className="max-w-2xl mx-auto space-y-4">
        {loading ? (
          <>
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-2">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-4 w-32" />
              </div>
              <Skeleton className="h-[52px] w-[52px] rounded-full" />
            </div>
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-14 w-full rounded-md" />
            <Skeleton className="h-14 w-full rounded-md" />
            <Skeleton className="h-14 w-full rounded-md" />
          </>
        ) : error ? (
          <EmptyState
            icon={offline ? "📡" : "⚠️"}
            title={offline ? t("common.offlineTitle") : t("common.errorTitle")}
            body={offline ? t("common.offlineBody") : t("darslar.loadError")}
            cta={
              <Button variant="secondary" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
                {t("common.retry")}
              </Button>
            }
          />
        ) : !enrolled ? (
          <EmptyState icon="📚" title={t("darslar.emptyTitle")} body={t("darslar.emptyBody")} />
        ) : trial ? (
          <EmptyState
            icon="🔒"
            title={t("darslar.trialTitle")}
            body={t("darslar.trialBody")}
            cta={<p className="text-xs font-semibold text-muted-foreground">{t("darslar.trialContact")}</p>}
          />
        ) : (
          <>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h1 className="font-display text-[19px] font-extrabold tracking-tight text-foreground truncate">
                  {t("darslar.title")}
                </h1>
                <p className="text-xs font-semibold text-muted-foreground truncate">
                  {t("darslar.subtitle", { course: courseTitle, count: formatXp(modules.length, i18n.language) })}
                </p>
              </div>
              <ProgressRing pct={pct} size={52} />
            </div>

            {nextLesson && courseId && (
              <div
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/lesson/${courseId}/${nextLesson.id}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    navigate(`/lesson/${courseId}/${nextLesson.id}`);
                  }
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-lg p-3.5 shadow-elevated",
                  "bg-gradient-to-br from-primary to-foreground dark:to-background",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-extrabold uppercase tracking-wide text-white/80">
                    {t("darslar.resumeLabel")}
                  </div>
                  <div className="mt-0.5 truncate text-[14.5px] font-extrabold text-white">
                    {activeModuleRank != null
                      ? t("darslar.resumeTitle", { n: formatXp(activeModuleRank, i18n.language), title: nextLesson.title })
                      : nextLesson.title}
                  </div>
                </div>
                <Button variant="primary" size="sm" tabIndex={-1} aria-hidden className="pointer-events-none flex-none">
                  <Play className="size-3.5" fill="currentColor" strokeWidth={0} />
                  {t("darslar.resumeCta")}
                </Button>
              </div>
            )}

            <SectionHeader
              title={t("darslar.modulesHeader")}
              action={t("darslar.modulesProgress", { pct: formatXp(pct, i18n.language) })}
            />

            {modules.map((m, idx) => {
              const rank = idx + 1;
              const capped = moduleLimit != null && rank > moduleLimit;
              const total = m.lessons.length;
              const doneCount = m.lessons.filter((l) => completed.has(l.id)).length;
              const fullyDone = total > 0 && doneCount === total;
              const isActive = !capped && m.id === activeModuleId;
              // Real access model (has_module_access / is_module_tier_locked, migration
              // 20260615030000_tier_lock_rank_fix.sql): gates PURELY on rank vs module_limit —
              // there is no sequential "finish-in-order" gate, and CoursePage.tsx already lets a
              // student open any within-cap module's lessons regardless of completion order. So
              // "within cap, not yet started" is `available` (openable), NOT `locked` — only a
              // rank beyond `module_limit` is truly `locked`.
              const state: ModuleRowState = capped ? "locked" : fullyDone ? "done" : isActive ? "active" : "available";
              const isOpen = state === "active" || ((state === "done" || state === "available") && expanded.has(m.id));

              let meta: string | undefined;
              let lockReason: string | undefined;
              if (state === "done") meta = t("darslar.moduleDone", { completed: formatXp(doneCount, i18n.language), total: formatXp(total, i18n.language) });
              else if (state === "active") meta = t("darslar.moduleActive", { completed: formatXp(doneCount, i18n.language), total: formatXp(total, i18n.language) });
              else if (state === "available") meta = t("darslar.moduleAvailable", { completed: formatXp(doneCount, i18n.language), total: formatXp(total, i18n.language) });
              else lockReason = t("darslar.moduleLockedTier"); // state === "locked" is always the tier-cap case now

              const handleModuleClick =
                state === "done" || state === "available"
                  ? () => toggleExpanded(m.id)
                  : state === "locked"
                    ? () => toast(lockReason)
                    : undefined;

              return (
                <div key={m.id}>
                  <ModuleRow
                    state={state}
                    n={rank}
                    title={m.title}
                    meta={meta}
                    lockReason={lockReason}
                    onClick={handleModuleClick}
                  />
                  {isOpen && (
                    <>
                      {m.lessons.map((l, j) => {
                        const done = completed.has(l.id);
                        const here = !!nextLesson && l.id === nextLesson.id;
                        const minutes = Math.max(1, Math.round((l.durationSec || 0) / 60));
                        return (
                          <LessonRow
                            key={l.id}
                            state={done ? "done" : "upcoming"}
                            title={l.title}
                            here={here}
                            index={formatXp(j + 1, i18n.language)}
                            meta={
                              here
                                ? t("darslar.lessonHereMeta", { minutes: formatXp(minutes, i18n.language), xp: formatXp(LESSON_XP, i18n.language) })
                                : t("darslar.lessonMeta", { minutes: formatXp(minutes, i18n.language) })
                            }
                            onClick={() => courseId && navigate(`/lesson/${courseId}/${l.id}`)}
                          />
                        );
                      })}
                      {/* Module-end homework step (non-blocking — text + submit, no video;
                          appears only if the RPC returned assignable homework for this module.
                          Never affects `state`/`isOpen`/progression above.) */}
                      {(() => {
                        const hwItems = homeworkByModule.get(m.id);
                        if (!hwItems || hwItems.length === 0) return null;
                        const agg = aggregateHomeworkState(hwItems);
                        const chip = getHomeworkStateChip(agg.state, agg.score, agg.max, t, i18n.language);
                        return (
                          <HomeworkStepRow
                            label={t("darslar.homeworkStepLabel")}
                            chip={chip}
                            onClick={() => navigate(`/homework/module/${m.id}`)}
                          />
                        );
                      })()}
                    </>
                  )}
                </div>
              );
            })}
            <div className="h-2" />
          </>
        )}
      </div>
    </PageShell>
  );
}

// Module-end homework row — matches LessonRow's visual language (ml-11 indent, rounded-md
// border, bg-surface-2 leading circle) but with a 📝 icon and a trailing StatusChip instead of
// a done/upcoming marker, since this row represents a whole homework task (or several, rolled
// up via aggregateHomeworkState), not a single lesson.
function HomeworkStepRow({
  label,
  chip,
  onClick,
}: {
  label: string;
  chip: { kind: StatusChipKind; label: string };
  onClick: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="ml-11 mb-1.5 flex cursor-pointer items-center gap-2.5 rounded-md border border-border bg-surface-2 px-[11px] py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <div className="grid size-[26px] flex-none place-items-center rounded-sm bg-card text-sm" aria-hidden>
        📝
      </div>
      <div className="min-w-0 flex-1 text-[13px] font-bold text-foreground">{label}</div>
      <StatusChip kind={chip.kind} label={chip.label} />
      <ChevronRight className="size-4 flex-none text-muted-foreground" />
    </div>
  );
}
