import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Flame, PlayCircle, BookOpen, ArrowRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { StudentAnalytics } from "@/components/dashboard/StudentAnalytics";

interface CourseRow {
  id: string; title: string; tagline: string | null; cover_url: string | null; duration_hours: number | null;
  total: number; completed: number; nextLessonId?: string; nextCourseId?: string;
}

export default function Dashboard() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [streak, setStreak] = useState(0);
  const [displayName, setDisplayName] = useState("");

  useEffect(() => {
    (async () => {
      if (!user) return;
      const [{ data: profile }, { data: streakRow }, { data: enrollments }] = await Promise.all([
        supabase.from("profiles").select("name, last_name").eq("id", user.id).maybeSingle(),
        supabase.from("streaks").select("current_streak").eq("user_id", user.id).maybeSingle(),
        supabase.from("enrollments").select("course_id, courses(*)").eq("user_id", user.id),
      ]);
      const first = (profile?.name || "").trim();
      const last = ((profile as any)?.last_name || "").trim();
      const full = [first, last].filter(Boolean).join(" ");
      setDisplayName(full || first || t("dashboard.there"));
      setStreak(streakRow?.current_streak || 0);

      const rows: CourseRow[] = [];
      for (const e of enrollments || []) {
        const c: any = (e as any).courses;
        if (!c) continue;
        const { data: lessons } = await supabase
          .from("lessons")
          .select("id, position, modules!inner(course_id, position)")
          .eq("modules.course_id", c.id)
          .order("position", { ascending: true });
        const lessonIds = (lessons || []).map((l: any) => l.id);
        const total = lessonIds.length;
        const { data: progress } = await supabase
          .from("lesson_progress")
          .select("lesson_id, completed_at")
          .eq("user_id", user.id)
          .in("lesson_id", lessonIds.length ? lessonIds : ["00000000-0000-0000-0000-000000000000"]);
        const completedSet = new Set((progress || []).filter((p: any) => p.completed_at).map((p: any) => p.lesson_id));
        const next = (lessons || []).find((l: any) => !completedSet.has(l.id));
        rows.push({
          id: c.id, title: c.title, tagline: c.tagline, cover_url: c.cover_url, duration_hours: c.duration_hours,
          total, completed: completedSet.size,
          nextLessonId: next?.id, nextCourseId: c.id,
        });
      }
      setCourses(rows);
      setLoading(false);
    })();
  }, [user]);

  return (
    <PageShell>
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

        {loading ? (
          <div className="grid md:grid-cols-2 gap-4">
            {[0, 1].map((i) => <Skeleton key={i} className="h-48 rounded-xl" />)}
          </div>
        ) : courses.length === 0 ? (
          <Card className="p-10 text-center"><p className="text-muted-foreground">{t("dashboard.noCourses")}</p></Card>
        ) : (
          <>
            <div className="grid md:grid-cols-2 gap-5">
              {courses.map((c) => {
                const pct = c.total > 0 ? Math.round((c.completed / c.total) * 100) : 0;
                return (
                  <Card key={c.id} className="p-6 shadow-soft hover:shadow-elevated transition-shadow">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
                          <BookOpen className="h-3.5 w-3.5" />
                          <span>{c.duration_hours}h • {c.total} {t("dashboard.lessons")}</span>
                        </div>
                        <h3 className="text-xl font-semibold tracking-tight">{c.title}</h3>
                        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{c.tagline}</p>
                      </div>
                      <div className="text-right">
                        <div className="text-2xl font-semibold tabular-nums">{pct}%</div>
                        <div className="text-xs text-muted-foreground">{t("dashboard.complete")}</div>
                      </div>
                    </div>
                    <Progress value={pct} className="mt-4 h-1.5" />
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
