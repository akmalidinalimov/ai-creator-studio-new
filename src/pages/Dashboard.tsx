import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Zap, TrendingUp, Trophy, Award, ClipboardCheck, ChevronRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { ModuleCelebrationModal } from "@/components/ModuleCelebrationModal";
import { tierFor, formatXp } from "@/lib/xp";
import {
  Hero,
  StatTile,
  ProgressRing,
  TierBadge,
  StreakChip,
  Card,
  SectionHeader,
  Button,
  EmptyState,
  Skeleton,
} from "@/components/ui-kit";

// Weekly-XP ring target — spec (§7) pins the metric (xp_events, Tashkent-Monday reset) but not
// the target. RULING (xp-data-sources.md, 2026-08-18): hardcode a launch default here rather than
// invent a new platform_settings key. OWNER-ATTENTION: revisit this value / consider moving it to
// platform_settings later for no-deploy tuning.
const WEEKLY_XP_GOAL = 150;

/** Start (00:00) of the current week, Monday-anchored, in Asia/Tashkent (fixed UTC+5, no DST),
 *  returned as a UTC ISO string for use in a `.gte("created_at", …)` filter. Mirrors the server's
 *  `date_trunc('week', now() at time zone 'Asia/Tashkent')` convention (see xp-data-sources.md). */
function tashkentWeekStartIso(): string {
  const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
  const shifted = new Date(Date.now() + TASHKENT_OFFSET_MS);
  const dow = shifted.getUTCDay(); // 0=Sun..6=Sat, in Tashkent-shifted terms
  const daysSinceMonday = (dow + 6) % 7;
  const mondayShiftedMs = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() - daysSinceMonday,
    0, 0, 0, 0,
  );
  return new Date(mondayShiftedMs - TASHKENT_OFFSET_MS).toISOString();
}

interface CourseRow {
  id: string; title: string; tagline: string | null; cover_url: string | null; duration_hours: number | null;
  total: number; completed: number; nextLessonId?: string; nextCourseId?: string;
  nextLessonTitle?: string; nextLessonDurationSec?: number | null;
  nextModuleTitle?: string; nextModuleRank?: number; nextLessonPositionInModule?: number;
  modulesTotal: number; modulesCompleted: number;
  lastActivityMs: number; // most-recent lesson activity in this course (0 = never touched)
}

interface StatsRow {
  totalXp: number; level: number; groupRank: number | null; badges: number; streak: number;
}

export default function Dashboard() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [displayName, setDisplayName] = useState("");
  const [stats, setStats] = useState<StatsRow | null>(null);
  const [weeklyXp, setWeeklyXp] = useState(0);
  const [dailyRemaining, setDailyRemaining] = useState(0);
  const [hwPendingCount, setHwPendingCount] = useState(0);
  const [hwGradedCount, setHwGradedCount] = useState(0);
  const [hwAvgScore, setHwAvgScore] = useState<number | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
     try {
      const weekStartIso = tashkentWeekStartIso();
      const [profRes, statsRes, enrollRes, weekXpRes, dailyRes, hwRes] = await Promise.all([
        supabase.from("profiles").select("name, last_name").eq("id", user.id).maybeSingle(),
        // profile_stats(uid): total_xp/level/group_rank/badges_earned/current_streak are the SAME
        // underlying reads xp-data-sources.md pins (user_xp.total_xp, user_group_rating_xp-based
        // rank, badges ∩ catalog join) — already secured + used by Profile.tsx/Leaderboard's
        // sibling RPCs. One round trip instead of four separate queries for the same numbers.
        supabase.rpc("profile_stats" as any, { uid: user.id }),
        supabase.from("enrollments").select("course_id, tier_id, courses(*), course_tiers(module_limit)").eq("user_id", user.id),
        // Haftalik XP: CONFIRMED source per xp-data-sources.md — sum xp_events.amount over the
        // current Tashkent-Monday week. NOT user_group_rating_xp (leaderboard-only).
        supabase.from("xp_events" as any).select("amount").eq("user_id", user.id).gte("created_at", weekStartIso),
        supabase.rpc("daily_goal_progress", { uid: user.id }),
        supabase.from("homework_submissions").select("score").eq("user_id", user.id),
      ]);
      if (enrollRes.error) throw enrollRes.error;
      const profile = profRes.data; const enrollments = enrollRes.data;
      const first = (profile?.name || "").trim();
      const last = ((profile as any)?.last_name || "").trim();
      const full = [first, last].filter(Boolean).join(" ");
      setDisplayName(full || first || t("dashboard.there"));

      const sRow: any = Array.isArray(statsRes.data) ? statsRes.data[0] : statsRes.data;
      setStats({
        totalXp: sRow?.total_xp ?? 0,
        level: sRow?.level ?? 1,
        groupRank: sRow?.group_rank ?? null,
        badges: sRow?.badges_earned ?? 0,
        streak: sRow?.current_streak ?? 0,
      });

      const weekAmt = (((weekXpRes.data as any[]) || [])).reduce((sum, e) => sum + (e.amount || 0), 0);
      setWeeklyXp(weekAmt);

      const dailyRow: any = Array.isArray(dailyRes.data) ? dailyRes.data[0] : dailyRes.data;
      setDailyRemaining(Math.max((dailyRow?.target ?? 0) - (dailyRow?.done ?? 0), 0));

      const hwRows = ((hwRes.data as any[]) || []);
      const graded = hwRows.filter((r) => r.score != null);
      setHwPendingCount(hwRows.filter((r) => r.score == null).length);
      setHwGradedCount(graded.length);
      setHwAvgScore(graded.length ? graded.reduce((s, r) => s + Number(r.score), 0) / graded.length : null);

      const rows: CourseRow[] = [];
      for (const e of enrollments || []) {
        const c: any = (e as any).courses;
        if (!c) continue;
        // Tier cap: null = unlimited. Modules are ranked by position (matching
        // has_module_access); only the first `limit` modules are accessible.
        const limit: number | null = (e as any).course_tiers?.module_limit ?? null;
        const { data: lessonsData } = await supabase
          .from("lessons")
          .select("id, position, title, duration_seconds, modules!inner(id, course_id, position, title)")
          .eq("modules.course_id", c.id);
        const raw = (lessonsData || []).map((l: any) => ({
          id: l.id, lp: l.position ?? 0, title: l.title as string, dur: l.duration_seconds as number | null,
          mid: l.modules?.id, mp: l.modules?.position ?? 0, mtitle: l.modules?.title as string,
        }));
        // Rank modules by position so the cap matches the backend's rank logic.
        const modRank = new Map<string, number>();
        Array.from(new Map(raw.map((l) => [l.mid, l.mp])).entries())
          .sort((a, b) => a[1] - b[1])
          .forEach(([mid], i) => modRank.set(mid, i + 1));
        const modTitleByMid = new Map<string, string>();
        raw.forEach((l) => { if (!modTitleByMid.has(l.mid)) modTitleByMid.set(l.mid, l.mtitle); });
        let ordered = raw
          .sort((a, b) => (modRank.get(a.mid)! - modRank.get(b.mid)!) || a.lp - b.lp);
        if (limit != null) ordered = ordered.filter((l) => (modRank.get(l.mid) ?? 1e9) <= limit);
        const lessonIds = ordered.map((l) => l.id);
        const total = lessonIds.length;
        const { data: progress } = await supabase
          .from("lesson_progress")
          .select("lesson_id, completed_at, updated_at")
          .eq("user_id", user.id)
          .in("lesson_id", lessonIds.length ? lessonIds : ["00000000-0000-0000-0000-000000000000"]);
        const completedSet = new Set((progress || []).filter((p: any) => p.completed_at).map((p: any) => p.lesson_id));
        const lastActivityMs = (progress || []).reduce((mx: number, p: any) => {
          const ts = p.updated_at ? Date.parse(p.updated_at) : 0;
          return ts > mx ? ts : mx;
        }, 0);
        const next = ordered.find((l) => !completedSet.has(l.id));
        const nextPositionInModule = next
          ? ordered.filter((l) => l.mid === next.mid).findIndex((l) => l.id === next.id) + 1
          : undefined;

        // Module completion (accessible modules only) for the compact "Kursim" card's
        // "N / M modul tugallandi" line — a module counts as done when every one of its
        // (tier-accessible) lessons is completed.
        const moduleLessonIds = new Map<string, string[]>();
        ordered.forEach((l) => {
          const arr = moduleLessonIds.get(l.mid) || [];
          arr.push(l.id);
          moduleLessonIds.set(l.mid, arr);
        });
        const modulesTotal = moduleLessonIds.size;
        const modulesCompleted = Array.from(moduleLessonIds.values())
          .filter((ids) => ids.length > 0 && ids.every((id) => completedSet.has(id))).length;

        rows.push({
          id: c.id, title: c.title, tagline: c.tagline, cover_url: c.cover_url, duration_hours: c.duration_hours,
          total, completed: completedSet.size,
          nextLessonId: next?.id, nextCourseId: c.id,
          nextLessonTitle: next?.title, nextLessonDurationSec: next?.dur,
          nextModuleTitle: next ? modTitleByMid.get(next.mid) : undefined,
          nextModuleRank: next ? modRank.get(next.mid) : undefined,
          nextLessonPositionInModule: nextPositionInModule,
          modulesTotal, modulesCompleted,
          lastActivityMs,
        });
      }
      if (cancelled) return;
      // "Continue where you left off" must show the course the student is actually working
      // in. Enrollment order is arbitrary, so a student enrolled in 2 courses (e.g. finished
      // 4.0 + active 5.0) could see the stale one. Order by most-recent activity, then by
      // progress, so the resume card + course list lead with the live course.
      rows.sort((a, b) => (b.lastActivityMs - a.lastActivityMs) || (b.completed - a.completed));
      setCourses(rows);
     } catch (e) {
       if (!cancelled) { console.error("[Dashboard] load failed", e); setError(true); }
     } finally {
       if (!cancelled) setLoading(false);
     }
    })();
    return () => { cancelled = true; };
  }, [user, reloadKey]);

  const resume = courses.find((c) => c.nextLessonId && c.completed < c.total) || courses.find((c) => c.nextLessonId);
  const hasAnyProgress = courses.some((c) => c.completed > 0);
  const totalXp = stats?.totalXp ?? 0;
  // First-run/empty per brief: 0 progress = no XP AND no completed lessons anywhere.
  const isFirstRun = !loading && !error && courses.length > 0 && totalXp === 0 && !hasAnyProgress;
  const tierInfo = stats ? tierFor(totalXp) : null;
  const weeklyPct = WEEKLY_XP_GOAL > 0 ? Math.round((weeklyXp / WEEKLY_XP_GOAL) * 100) : 0;
  const weeklyRemaining = Math.max(WEEKLY_XP_GOAL - weeklyXp, 0);

  const greetingSubtitle = isFirstRun && resume
    ? t("home.greetingSubtitleWelcome", { course: resume.title })
    : dailyRemaining > 0
      ? t("home.greetingSubtitle", { n: dailyRemaining })
      : t("home.greetingSubtitleDone");

  return (
    <PageShell>
      <ModuleCelebrationModal />
      <div className="max-w-2xl mx-auto space-y-4">
        {loading ? (
          <>
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-5 w-64" />
            <Skeleton className="h-[150px] w-full rounded-lg" />
            <div className="grid grid-cols-4 gap-2">
              {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-md" />)}
            </div>
            <Skeleton className="h-20 w-full rounded-lg" />
            <Skeleton className="h-20 w-full rounded-lg" />
          </>
        ) : error ? (
          <Card className="p-10 text-center">
            <p className="text-sm text-muted-foreground mb-4">{t("dashboard.loadError", "Kurslarni yuklab bo'lmadi.")}</p>
            <Button variant="secondary" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
              {t("common.retry")}
            </Button>
          </Card>
        ) : courses.length === 0 ? (
          <Card className="p-10 text-center"><p className="text-sm text-muted-foreground">{t("dashboard.noCourses")}</p></Card>
        ) : (
          <>
            <div className="space-y-1">
              <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">
                {t("home.greeting", { name: displayName })}
              </h1>
              <p className="text-sm font-semibold text-muted-foreground">{greetingSubtitle}</p>
            </div>

            <div className="flex items-center justify-between gap-2 flex-wrap">
              <StreakChip days={stats?.streak ?? 0} />
              {tierInfo && <TierBadge tier={tierInfo.key} />}
            </div>

            {isFirstRun ? (
              <>
                <EmptyState
                  icon="🚀"
                  title={t("home.emptyTitle")}
                  body={t("home.emptyBody")}
                  cta={
                    <Button
                      variant="primary"
                      block
                      disabled={!resume?.nextLessonId}
                      onClick={() => resume?.nextLessonId && navigate(`/lesson/${resume.id}/${resume.nextLessonId}`)}
                    >
                      {t("home.emptyCta")}
                    </Button>
                  }
                />
                <Card className="flex items-center gap-3">
                  <ProgressRing pct={0} size={52} />
                  <div>
                    <div className="text-sm font-extrabold text-foreground">
                      {t("home.emptyStatusLine", { xp: formatXp(0, i18n.language), level: formatXp(1, i18n.language) })}
                    </div>
                    <div className="text-xs font-semibold text-muted-foreground">
                      {t("home.emptyTierHint", { tier: tierFor(0).name })}
                    </div>
                  </div>
                </Card>
              </>
            ) : (
              <>
                {resume?.nextLessonId && (
                  <Hero
                    coverLabel={
                      resume.nextModuleRank != null
                        ? t("home.heroModuleLabel", { n: formatXp(resume.nextModuleRank, i18n.language), title: resume.nextModuleTitle })
                        : undefined
                    }
                    title={resume.nextLessonTitle || resume.title}
                    meta={
                      resume.nextLessonDurationSec
                        ? t("home.heroMeta", {
                            step: formatXp(resume.nextLessonPositionInModule ?? 1, i18n.language),
                            minutes: formatXp(Math.max(1, Math.round(resume.nextLessonDurationSec / 60)), i18n.language),
                          })
                        : t("home.heroMetaNoDuration", { step: formatXp(resume.nextLessonPositionInModule ?? 1, i18n.language) })
                    }
                    progress={resume.total > 0 ? Math.round((resume.completed / resume.total) * 100) : 0}
                    ctaLabel={resume.completed === 0 ? t("home.startCourseCta") : t("home.continueCta")}
                    onCtaClick={() => navigate(`/lesson/${resume.id}/${resume.nextLessonId}`)}
                    onPlayClick={() => navigate(`/lesson/${resume.id}/${resume.nextLessonId}`)}
                  />
                )}

                <div className="grid grid-cols-4 gap-2">
                  <StatTile icon={<Zap />} label={t("home.statXp")} value={formatXp(totalXp, i18n.language)} highlight />
                  <StatTile icon={<TrendingUp />} label={t("home.statLevel")} value={formatXp(stats?.level ?? 1, i18n.language)} />
                  <StatTile
                    icon={<Trophy />}
                    label={t("home.statRank")}
                    value={stats?.groupRank != null ? `#${formatXp(stats.groupRank, i18n.language)}` : "—"}
                  />
                  <StatTile icon={<Award />} label={t("home.statBadges")} value={formatXp(stats?.badges ?? 0, i18n.language)} />
                </div>

                <SectionHeader title={t("home.weeklyGoalTitle")} />
                <Card className="flex items-center gap-4">
                  <ProgressRing pct={weeklyPct} size={56} />
                  <div>
                    <div className="text-sm font-extrabold text-foreground">
                      {formatXp(weeklyXp, i18n.language)} / {formatXp(WEEKLY_XP_GOAL, i18n.language)} XP
                    </div>
                    <div className="text-xs font-semibold text-muted-foreground">
                      {weeklyRemaining > 0
                        ? t("home.weeklyGoalSubtitle", { xp: formatXp(weeklyRemaining, i18n.language) })
                        : t("home.weeklyGoalReached")}
                    </div>
                  </div>
                </Card>

                {(hwPendingCount > 0 || hwGradedCount > 0) && (
                  <>
                    <SectionHeader title={t("home.homeworkTitle")} action={<Link to="/homework">{t("home.homeworkAction")}</Link>} />
                    <Link to="/homework" className="block">
                      <Card className="flex items-center gap-3 cursor-pointer hover:bg-tint/40 transition-colors">
                        <div className="grid size-[42px] flex-none place-items-center rounded-md bg-accent text-accent-foreground">
                          <ClipboardCheck className="size-[22px]" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-[14.5px] font-extrabold text-foreground">
                            {hwPendingCount > 0
                              ? t("home.homeworkPending", { count: formatXp(hwPendingCount, i18n.language) })
                              : t("home.homeworkAllGraded")}
                          </div>
                          <div className="text-xs font-semibold text-muted-foreground">
                            {hwAvgScore != null
                              ? t("home.homeworkAvg", {
                                  avg: formatXp(Math.round(hwAvgScore * 10) / 10, i18n.language),
                                  count: formatXp(hwGradedCount, i18n.language),
                                })
                              : t("home.homeworkNoneGraded")}
                          </div>
                        </div>
                        <ChevronRight className="size-[18px] flex-none text-muted-foreground" />
                      </Card>
                    </Link>
                  </>
                )}

                {resume && (
                  <>
                    <SectionHeader title={t("home.myCourseTitle")} action={<Link to="/lessons">{t("home.myCourseAction")}</Link>} />
                    <Link to="/lessons" className="block">
                      <Card className="flex items-center gap-3 cursor-pointer hover:bg-tint/40 transition-colors">
                        <ProgressRing pct={resume.total > 0 ? Math.round((resume.completed / resume.total) * 100) : 0} size={48} />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-extrabold text-foreground truncate">{resume.title}</div>
                          <div className="text-xs font-semibold text-muted-foreground">
                            {t("home.myCourseMeta", {
                              moduleRank: formatXp(resume.nextModuleRank ?? 1, i18n.language),
                              completed: formatXp(resume.modulesCompleted, i18n.language),
                              total: formatXp(resume.modulesTotal, i18n.language),
                            })}
                          </div>
                        </div>
                        <ChevronRight className="size-[18px] flex-none text-muted-foreground" />
                      </Card>
                    </Link>
                  </>
                )}
              </>
            )}
          </>
        )}
      </div>
    </PageShell>
  );
}
