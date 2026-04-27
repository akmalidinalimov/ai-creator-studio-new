import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { CheckCircle2, Circle, PlayCircle, Clock } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export default function CoursePage() {
  const { courseId } = useParams();
  const { user } = useAuth();
  const { t } = useTranslation();
  const [course, setCourse] = useState<any>(null);
  const [modules, setModules] = useState<any[]>([]);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      if (!courseId || !user) return;
      const { data: c } = await supabase.from("courses").select("*").eq("id", courseId).maybeSingle();
      const { data: ms } = await supabase
        .from("modules")
        .select("*, lessons(id, title, position, duration_seconds)")
        .eq("course_id", courseId)
        .order("position", { ascending: true });
      // sort lessons within each module
      (ms || []).forEach((m: any) => m.lessons.sort((a: any, b: any) => a.position - b.position));
      setCourse(c); setModules(ms || []);
      const allLessonIds = (ms || []).flatMap((m: any) => m.lessons.map((l: any) => l.id));
      if (allLessonIds.length) {
        const { data: prog } = await supabase
          .from("lesson_progress")
          .select("lesson_id, completed_at")
          .eq("user_id", user.id).in("lesson_id", allLessonIds);
        setCompleted(new Set((prog || []).filter((p: any) => p.completed_at).map((p: any) => p.lesson_id)));
      }
      setLoading(false);
    })();
  }, [courseId, user]);

  if (loading) return <PageShell><Skeleton className="h-64" /></PageShell>;
  if (!course) return <PageShell><p>{t("coursePage.notFound")}</p></PageShell>;

  const totalLessons = modules.reduce((s, m) => s + m.lessons.length, 0);
  const pct = totalLessons ? Math.round((completed.size / totalLessons) * 100) : 0;
  const nextLesson = modules.flatMap((m) => m.lessons).find((l: any) => !completed.has(l.id));

  return (
    <PageShell>
      <div className="grid lg:grid-cols-[1fr_320px] gap-8">
        <div className="space-y-8">
          <div>
            <Link to="/dashboard" className="text-xs text-muted-foreground hover:text-foreground">{t("coursePage.backToDashboard")}</Link>
            <h1 className="text-4xl font-semibold tracking-tight mt-2">{course.title}</h1>
            <p className="text-lg text-muted-foreground mt-2 max-w-2xl">{course.tagline}</p>
            <p className="mt-4 text-sm leading-relaxed max-w-2xl">{course.description}</p>
          </div>

          <div className="space-y-6">
            {modules.map((m, i) => (
              <Card key={m.id} className="overflow-hidden shadow-soft">
                <div className="px-5 py-4 border-b bg-muted/30">
                  <div className="text-xs text-muted-foreground">{t("coursePage.moduleN", { n: i + 1 })}</div>
                  <h3 className="text-lg font-semibold tracking-tight">{m.title}</h3>
                  {m.summary && <p className="text-sm text-muted-foreground mt-1">{m.summary}</p>}
                </div>
                <ul className="divide-y">
                  {m.lessons.map((l: any, j: number) => (
                    <li key={l.id}>
                      <Link to={`/lesson/${courseId}/${l.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-muted/40 transition-colors">
                        {completed.has(l.id) ? <CheckCircle2 className="h-4 w-4 text-foreground" /> : <Circle className="h-4 w-4 text-muted-foreground" />}
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{j + 1}. {l.title}</div>
                        </div>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground"><Clock className="h-3 w-3" />{Math.round((l.duration_seconds || 0) / 60)}m</div>
                      </Link>
                    </li>
                  ))}
                </ul>
                <div className="px-5 py-3 border-t bg-muted/20">
                  <Button asChild variant="outline" size="sm"><Link to={`/quiz/${m.id}`}>{t("coursePage.takeQuiz")}</Link></Button>
                </div>
              </Card>
            ))}
          </div>
        </div>

        <aside className="lg:sticky lg:top-20 h-fit space-y-5">
          <Card className="p-5 shadow-soft">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{t("coursePage.yourProgress")}</span>
              <span className="text-2xl font-semibold tabular-nums">{pct}%</span>
            </div>
            <Progress value={pct} className="mt-3 h-1.5" />
            <div className="grid grid-cols-3 gap-2 mt-5 text-center">
              <Stat n={modules.length} l={t("coursePage.stats.modules")} />
              <Stat n={totalLessons} l={t("coursePage.stats.lessons")} />
              <Stat n={`${course.duration_hours}h`} l={t("coursePage.stats.total")} />
            </div>
            {nextLesson && (
              <Button asChild className="w-full mt-5"><Link to={`/lesson/${courseId}/${nextLesson.id}`}><PlayCircle className="h-4 w-4" />{t("coursePage.continue")}</Link></Button>
            )}
            {pct === 100 && <Button asChild variant="outline" className="w-full mt-3"><Link to={`/certificate/${courseId}`}>{t("coursePage.viewCertificate")}</Link></Button>}
          </Card>
        </aside>
      </div>
    </PageShell>
  );
}

const Stat = ({ n, l }: { n: any; l: string }) => (
  <div><div className="text-base font-semibold tabular-nums">{n}</div><div className="text-[11px] text-muted-foreground">{l}</div></div>
);
