import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { CheckCircle2, Circle, PlayCircle, Clock, Lock } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export default function CoursePage() {
  const { courseId } = useParams();
  const { user } = useAuth();
  const { t } = useTranslation();
  const [course, setCourse] = useState<any>(null);
  const [modules, setModules] = useState<any[]>([]);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [moduleLimit, setModuleLimit] = useState<number | null>(null);
  const [accountType, setAccountType] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!courseId || !user) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
     try {
      const { data: c, error: cErr } = await supabase.from("courses").select("*").eq("id", courseId).maybeSingle();
      if (cErr) throw cErr;
      const { data: ms, error: mErr } = await supabase
        .from("modules")
        .select("*, lessons(id, title, position, duration_seconds)")
        .eq("course_id", courseId)
        .order("position", { ascending: true });
      if (mErr) throw mErr;
      // sort lessons within each module
      (ms || []).forEach((m: any) => m.lessons.sort((a: any, b: any) => a.position - b.position));
      if (cancelled) return;
      setCourse(c); setModules(ms || []);
      const { data: lim } = await supabase.rpc("my_module_limit" as any, { _course_id: courseId });
      if (cancelled) return;
      setModuleLimit(typeof lim === "number" ? lim : null);
      // Provisional (trial) accounts see homework/points/stats but NO lessons. Default 'paid'.
      const { data: prof } = await supabase.from("profiles").select("account_type").eq("id", user.id).maybeSingle();
      if (cancelled) return;
      setAccountType(((prof as any)?.account_type as string) ?? "paid");
      const allLessonIds = (ms || []).flatMap((m: any) => m.lessons.map((l: any) => l.id));
      if (allLessonIds.length) {
        const { data: prog } = await supabase
          .from("lesson_progress")
          .select("lesson_id, completed_at")
          .eq("user_id", user.id).in("lesson_id", allLessonIds);
        if (cancelled) return;
        setCompleted(new Set((prog || []).filter((p: any) => p.completed_at).map((p: any) => p.lesson_id)));
      }
     } catch (e) {
       if (!cancelled) { console.error("[CoursePage] load failed", e); setError(true); }
     } finally {
       if (!cancelled) setLoading(false);
     }
    })();
    return () => { cancelled = true; };
  }, [courseId, user, reloadKey]);

  if (loading) return <PageShell><Skeleton className="h-64" /></PageShell>;
  if (error) return (
    <PageShell>
      <div className="text-center py-16">
        <p className="text-muted-foreground">{t("coursePage.loadError", "Kursni yuklab bo'lmadi.")}</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={() => setReloadKey((k) => k + 1)}>{t("common.retry", "Qayta urinish")}</Button>
      </div>
    </PageShell>
  );
  if (!course) return <PageShell><p>{t("coursePage.notFound")}</p></PageShell>;

  const accessibleCount = moduleLimit == null ? modules.length : Math.min(moduleLimit, modules.length);
  const accessibleModules = modules.slice(0, accessibleCount);
  const isModuleLocked = (i: number) => moduleLimit != null && i >= moduleLimit;
  const totalLessons = accessibleModules.reduce((s, m) => s + m.lessons.length, 0);
  const pct = totalLessons ? Math.round((completed.size / totalLessons) * 100) : 0;
  const nextLesson = accessibleModules.flatMap((m) => m.lessons).find((l: any) => !completed.has(l.id));

  return (
    <PageShell>
      <div className="grid lg:grid-cols-[1fr_320px] gap-8 min-w-0">
        <div className="space-y-8 min-w-0">
          <div className="min-w-0">
            <Link to="/dashboard" className="text-xs text-muted-foreground hover:text-foreground">{t("coursePage.backToDashboard")}</Link>
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-semibold tracking-tight mt-2 break-words">{course.title}</h1>
            <p className="text-base sm:text-lg text-muted-foreground mt-2 max-w-2xl break-words">{course.tagline}</p>
            <p className="mt-4 text-sm leading-relaxed max-w-2xl break-words">{course.description}</p>
          </div>

          {accountType === "provisional" ? (
            <Card className="p-8 text-center shadow-soft">
              <div className="text-4xl mb-3">🔒</div>
              <h2 className="text-xl font-semibold">{t("coursePage.trialTitle", "Sinov (trial) hisobi")}</h2>
              <p className="text-muted-foreground mt-2 max-w-md mx-auto leading-relaxed">{t("coursePage.trialBody", "Darsliklar to'liq to'lovdan so'ng ochiladi. Uy vazifalaringiz, ballaringiz va statistikangiz saqlanib qoladi — to'lovdan keyin hammasi shu yerda bo'ladi.")}</p>
              <p className="text-sm text-muted-foreground mt-4">{t("coursePage.trialContact", "To'lov uchun administrator bilan bog'laning.")}</p>
            </Card>
          ) : (
          <div className="space-y-6">
            {modules.map((m, i) => {
              const locked = isModuleLocked(i);
              return (
              <Card key={m.id} className={`overflow-hidden shadow-soft ${locked ? "opacity-70" : ""}`}>
                <div className="px-4 sm:px-5 py-4 border-b bg-muted/30 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("coursePage.moduleN", { n: i + 1 })}</div>
                    {locked && <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground"><Lock className="h-3 w-3" />{t("coursePage.locked")}</span>}
                  </div>
                  <h3 className="text-base sm:text-lg font-semibold tracking-tight break-words mt-0.5">{m.title}</h3>
                  {m.summary && <p className="text-sm text-muted-foreground mt-1 break-words">{m.summary}</p>}
                </div>
                {locked ? (
                  <div className="px-4 sm:px-5 py-4 text-sm text-muted-foreground flex items-center gap-2">
                    <Lock className="h-4 w-4 shrink-0" /><span>{t("coursePage.lockedHint")}</span>
                  </div>
                ) : (
                  <>
                    <ul className="divide-y">
                      {m.lessons.map((l: any, j: number) => (
                        <li key={l.id}>
                          <Link to={`/lesson/${courseId}/${l.id}`} className="flex items-center gap-3 px-4 sm:px-5 py-3 hover:bg-muted/40 transition-colors min-h-[44px]">
                            {completed.has(l.id) ? <CheckCircle2 className="h-4 w-4 text-foreground shrink-0" /> : <Circle className="h-4 w-4 text-muted-foreground shrink-0" />}
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium break-words">{j + 1}. {l.title}</div>
                            </div>
                            <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0"><Clock className="h-3 w-3" />{Math.round((l.duration_seconds || 0) / 60)}m</div>
                          </Link>
                        </li>
                      ))}
                    </ul>
                    <div className="px-4 sm:px-5 py-3 border-t bg-muted/20">
                      <Button asChild variant="outline" size="sm" className="w-full sm:w-auto min-h-[44px] sm:min-h-0"><Link to={`/quiz/${m.id}`}>{t("coursePage.takeQuiz")}</Link></Button>
                    </div>
                  </>
                )}
              </Card>
              );
            })}
          </div>
          )}
        </div>

        <aside className="lg:sticky lg:top-20 h-fit space-y-5 min-w-0">
          <Card className="p-5 shadow-soft">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{t("coursePage.yourProgress")}</span>
              <span className="text-2xl font-semibold tabular-nums">{pct}%</span>
            </div>
            <Progress value={pct} className="mt-3 h-1.5" />
            <div className="grid grid-cols-3 gap-2 mt-5 text-center">
              <Stat n={accessibleCount} l={t("coursePage.stats.modules")} />
              <Stat n={totalLessons} l={t("coursePage.stats.lessons")} />
              <Stat n={`${course.duration_hours}h`} l={t("coursePage.stats.total")} />
            </div>
            {accountType !== "provisional" && nextLesson && (
              <Button asChild className="w-full mt-5"><Link to={`/lesson/${courseId}/${nextLesson.id}`}><PlayCircle className="h-4 w-4" />{t("coursePage.continue")}</Link></Button>
            )}
            
          </Card>
        </aside>
      </div>
    </PageShell>
  );
}

const Stat = ({ n, l }: { n: any; l: string }) => (
  <div><div className="text-base font-semibold tabular-nums">{n}</div><div className="text-[11px] text-muted-foreground">{l}</div></div>
);
