import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Flame, PlayCircle, BookOpen, ArrowRight, Sparkles } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { StudentAnalytics } from "@/components/dashboard/StudentAnalytics";
import { EngagementTiles } from "@/components/dashboard/EngagementTiles";
import { ModuleCelebrationModal } from "@/components/ModuleCelebrationModal";
import { ProgressRing } from "@/components/dashboard/ProgressRing";

interface CourseRow {
  id: string; title: string; tagline: string | null; cover_url: string | null; duration_hours: number | null;
  total: number; completed: number; nextLessonId?: string; nextCourseId?: string;
}

export default function Dashboard() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [streak, setStreak] = useState(0);
  const [displayName, setDisplayName] = useState("");

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
     try {
      const [profRes, streakRes, enrollRes] = await Promise.all([
        supabase.from("profiles").select("name, last_name").eq("id", user.id).maybeSingle(),
        supabase.from("streaks").select("current_streak").eq("user_id", user.id).maybeSingle(),
        supabase.from("enrollments").select("course_id, tier_id, courses(*), course_tiers(module_limit)").eq("user_id", user.id),
      ]);
      if (enrollRes.error) throw enrollRes.error;
      const profile = profRes.data; const streakRow = streakRes.data; const enrollments = enrollRes.data;
      const first = (profile?.name || "").trim();
      const last = ((profile as any)?.last_name || "").trim();
      const full = [first, last].filter(Boolean).join(" ");
      setDisplayName(full || first || t("dashboard.there"));
      setStreak(streakRow?.current_streak || 0);

      const rows: CourseRow[] = [];
      for (const e of enrollments || []) {
        const c: any = (e as any).courses;
        if (!c) continue;
        // Tier cap: null = unlimited. Modules are ranked by position (matching
        // has_module_access); only the first `limit` modules are accessible.
        const limit: number | null = (e as any).course_tiers?.module_limit ?? null;
        const { data: lessons } = await supabase
          .from("lessons")
          .select("id, position, modules!inner(id, course_id, position)")
          .eq("modules.course_id", c.id);
        const raw = (lessons || []).map((l: any) => ({
          id: l.id, lp: l.position ?? 0, mid: l.modules?.id, mp: l.modules?.position ?? 0,
        }));
        // Rank modules by position so the cap matches the backend's rank logic.
        const modRank = new Map<string, number>();
        Array.from(new Map(raw.map((l) => [l.mid, l.mp])).entries())
          .sort((a, b) => a[1] - b[1])
          .forEach(([mid], i) => modRank.set(mid, i + 1));
        let ordered = raw
          .sort((a, b) => (modRank.get(a.mid)! - modRank.get(b.mid)!) || a.lp - b.lp);
        if (limit != null) ordered = ordered.filter((l) => (modRank.get(l.mid) ?? 1e9) <= limit);
        const lessonIds = ordered.map((l) => l.id);
        const total = lessonIds.length;
        const { data: progress } = await supabase
          .from("lesson_progress")
          .select("lesson_id, completed_at")
          .eq("user_id", user.id)
          .in("lesson_id", lessonIds.length ? lessonIds : ["00000000-0000-0000-0000-000000000000"]);
        const completedSet = new Set((progress || []).filter((p: any) => p.completed_at).map((p: any) => p.lesson_id));
        const next = ordered.find((l) => !completedSet.has(l.id));
        rows.push({
          id: c.id, title: c.title, tagline: c.tagline, cover_url: c.cover_url, duration_hours: c.duration_hours,
          total, completed: completedSet.size,
          nextLessonId: next?.id, nextCourseId: c.id,
        });
      }
      if (cancelled) return;
      setCourses(rows);
     } catch (e) {
       if (!cancelled) { console.error("[Dashboard] load failed", e); setError(true); }
     } finally {
       if (!cancelled) setLoading(false);
     }
    })();
    return () => { cancelled = true; };
  }, [user, reloadKey]);

  return (
    <PageShell>
      <ModuleCelebrationModal />
      <div className="space-y-8">
        <div className="flex items-end justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">{t("dashboard.welcome", { name: displayName })}</h1>
            <p className="text-muted-foreground mt-1">{t("dashboard.pickUp")}</p>
          </div>
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg border bg-card shadow-soft">
            <Flame className="h-4 w-4 text-orange-500" />
            <span className="font-semibold tabular-nums">{streak}</span>
            <span className="text-sm text-muted-foreground">{t("dashboard.dayStreak")}</span>
          </div>
        </div>

        {(() => {
          if (loading || error || courses.length === 0) return null;
          const resume = courses.find((c) => c.nextLessonId && c.completed < c.total) || courses.find((c) => c.nextLessonId);
          if (!resume?.nextLessonId) return null;
          const pct = resume.total > 0 ? Math.round((resume.completed / resume.total) * 100) : 0;
          const fresh = resume.completed === 0;
          return (
            <Card className="relative overflow-hidden p-0 border-primary/20 shadow-soft">
              <div className="absolute inset-0 bg-gradient-to-br from-primary/[0.06] to-transparent pointer-events-none" />
              <div className="relative flex flex-col sm:flex-row items-start sm:items-center gap-5 p-6">
                <ProgressRing value={pct} size={72} stroke={6} className="shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-primary uppercase tracking-wide">
                    <Sparkles className="h-3.5 w-3.5" /> {fresh ? t("dashboard.startTitle", "Start here") : t("dashboard.resumeTitle", "Continue where you left off")}
                  </div>
                  <h2 className="text-xl font-semibold tracking-tight mt-1 truncate">{resume.title}</h2>
                  <p className="text-sm text-muted-foreground mt-0.5">{resume.completed}/{resume.total} {t("dashboard.lessons")} · {pct}% {t("dashboard.complete")}</p>
                </div>
                <Button asChild size="lg" className="w-full sm:w-auto shrink-0">
                  <Link to={`/lesson/${resume.id}/${resume.nextLessonId}`}>
                    <PlayCircle className="h-5 w-5" /> {fresh ? t("dashboard.startCourse") : t("dashboard.continueLearning")}
                  </Link>
                </Button>
              </div>
            </Card>
          );
        })()}

        <EngagementTiles />

        <div className="flex justify-end">
          <Button asChild variant="outline" size="sm">
            <Link to="/activity">{t("dashboard.viewFullHistory")} <ArrowRight className="h-4 w-4" /></Link>
          </Button>
        </div>

        {loading ? (
          <div className="grid md:grid-cols-2 gap-4">
            {[0, 1].map((i) => <Skeleton key={i} className="h-48 rounded-xl" />)}
          </div>
        ) : error ? (
          <Card className="p-10 text-center">
            <p className="text-muted-foreground">{t("dashboard.loadError", "Kurslarni yuklab bo'lmadi.")}</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={() => setReloadKey((k) => k + 1)}>
              {t("common.retry", "Qayta urinish")}
            </Button>
          </Card>
        ) : courses.length === 0 ? (
          <Card className="p-10 text-center"><p className="text-muted-foreground">{t("dashboard.noCourses")}</p></Card>
        ) : (
          <>
            <div className="grid md:grid-cols-2 gap-5">
              {courses.map((c) => {
                const pct = c.total > 0 ? Math.round((c.completed / c.total) * 100) : 0;
                return (
                  <Card key={c.id} className="p-6 shadow-soft hover:shadow-elevated transition-shadow duration-200">
                    <div className="flex items-start gap-4">
                      <ProgressRing value={pct} size={60} stroke={5} className="shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1.5">
                          <BookOpen className="h-3.5 w-3.5" />
                          <span>{c.duration_hours}h • {c.total} {t("dashboard.lessons")}</span>
                        </div>
                        <h3 className="text-lg font-semibold tracking-tight leading-snug">{c.title}</h3>
                        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{c.tagline}</p>
                      </div>
                    </div>
                    <div className="mt-5 flex items-center justify-between gap-3">
                      <Button asChild variant="default" size="sm">
                        <Link to={c.nextLessonId ? `/lesson/${c.id}/${c.nextLessonId}` : `/course/${c.id}`}>
                          <PlayCircle className="h-4 w-4" />
                          {c.completed === 0 ? t("dashboard.startCourse") : pct === 100 ? t("dashboard.review") : t("dashboard.continueLearning")}
                        </Link>
                      </Button>
                      <Button asChild variant="ghost" size="sm">
                        <Link to={`/course/${c.id}`}>{t("dashboard.coursePage")} <ArrowRight className="h-4 w-4" /></Link>
                      </Button>
                    </div>
                  </Card>
                );
              })}
            </div>
            {user && <StudentAnalytics userId={user.id} courseId={courses[0]?.id} />}
          </>
        )}
      </div>
    </PageShell>
  );
}
