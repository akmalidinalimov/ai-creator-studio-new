import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Clock, BookOpen, FileCheck2, Flame, PlayCircle, Award, LogIn } from "lucide-react";
import { effectiveLeafGrades, summarizeHomework } from "@/lib/homeworkStats";

interface LessonRow {
  lesson_id: string;
  lesson_title: string;
  module_title: string;
  course_title: string;
  course_id: string;
  watch_seconds: number;
  updated_at: string;
  completed_at: string | null;
}

interface HomeworkRow {
  id: string;
  module_title: string;
  task_number: number;
  submitted_at: string;
  score: number | null;
  max_score: number;
  is_late: boolean;
  telegram_message_url: string | null;
}

interface BadgeRow {
  earned_at: string;
  name: string;
  icon: string | null;
}

interface DayCell {
  date: string;
  seconds: number;
}

interface LoginRow {
  created_at: string;
  event: string;
}

function fmtHM(seconds: number, locale: string) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (locale === "uz") return `${h}s ${m}d`;
  if (locale === "ru") return `${h}ч ${m}м`;
  return `${h}h ${m}m`;
}

function fmtDate(iso: string, locale: string) {
  return new Intl.DateTimeFormat(locale === "uz" ? "uz" : locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export default function MyActivity() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const [totalSeconds, setTotalSeconds] = useState(0);
  const [completedCount, setCompletedCount] = useState(0);
  const [hwCount, setHwCount] = useState(0);
  const [hwScored, setHwScored] = useState(0);
  const [hwAvg, setHwAvg] = useState<number | null>(null);
  const [streakCur, setStreakCur] = useState(0);
  const [streakLong, setStreakLong] = useState(0);

  const [lessons, setLessons] = useState<LessonRow[]>([]);
  const [homework, setHomework] = useState<HomeworkRow[]>([]);
  const [badges, setBadges] = useState<BadgeRow[]>([]);
  const [days, setDays] = useState<DayCell[]>([]);
  const [logins, setLogins] = useState<LoginRow[]>([]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
     try {
      // daily_watch_summary.watch_date is stored in Asia/Tashkent — compute windows/keys in Tashkent.
      const tkStr = (n: number): string => {
        const base = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent" }).format(new Date());
        const d = new Date(base + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
        return d.toISOString().slice(0, 10);
      };
      const since90Str = tkStr(-89);
      const since30 = new Date();
      since30.setUTCDate(since30.getUTCDate() - 29);

      const [
        { data: progress },
        { data: hw },
        { data: streak },
        { data: dws },
        { data: badgeRows },
        { data: authRows },
      ] = await Promise.all([
        supabase
          .from("lesson_progress")
          .select(
            "lesson_id, watch_seconds_total, updated_at, completed_at, lessons!inner(title, modules!inner(title, position, courses!inner(id, title)))"
          )
          .eq("user_id", user.id)
          .order("updated_at", { ascending: false }),
        supabase
          .from("homework_submissions")
          .select(
            "id, assignment_id, submitted_at, score, score_feedback, scored_at, previous_attempts, is_late, telegram_message_url, homework_assignments!inner(task_number, max_score, modules!inner(title, position))"
          )
          .eq("user_id", user.id)
          .order("submitted_at", { ascending: false }),
        supabase.from("streaks").select("current_streak, longest_streak").eq("user_id", user.id).maybeSingle(),
        supabase
          .from("daily_watch_summary")
          .select("watch_date, total_seconds")
          .eq("user_id", user.id)
          .gte("watch_date", since90Str),
        supabase
          .from("user_badges")
          .select("earned_at, badges!inner(name_uz, name_ru, name_en, icon)")
          .eq("user_id", user.id)
          .order("earned_at", { ascending: false }),
        supabase
          .from("auth_events")
          .select("created_at, event")
          .eq("user_id", user.id)
          .gte("created_at", since30.toISOString())
          .order("created_at", { ascending: false })
          .limit(50),
      ]);

      // Lessons watched
      const lessonRows: LessonRow[] = (progress || []).map((p: any) => ({
        lesson_id: p.lesson_id,
        lesson_title: p.lessons?.title || "—",
        module_title: p.lessons?.modules?.title || "—",
        course_title: p.lessons?.modules?.courses?.title || "—",
        course_id: p.lessons?.modules?.courses?.id || "",
        watch_seconds: Number(p.watch_seconds_total) || 0,
        updated_at: p.updated_at,
        completed_at: p.completed_at,
      }));
      setLessons(lessonRows);
      setTotalSeconds(lessonRows.reduce((s, r) => s + r.watch_seconds, 0));
      setCompletedCount(lessonRows.filter((r) => r.completed_at).length);

      // Homework
      const hwRows: HomeworkRow[] = (hw || []).map((h: any) => ({
        id: h.id,
        module_title: h.homework_assignments?.modules?.title || "—",
        task_number: h.homework_assignments?.task_number || 1,
        submitted_at: h.submitted_at,
        score: h.score,
        max_score: h.homework_assignments?.max_score || 10,
        is_late: !!h.is_late,
        telegram_message_url: h.telegram_message_url,
      }));
      setHomework(hwRows);
      setHwCount(hwRows.length);

      // Effective-grade average — mirrors HomeworkProfileSection / homeworkStats:
      // honors max_score normalization (/10) and falls back to the last scored
      // previous attempt when the live submission isn't scored.
      const leafMax = new Map<string, number>();
      (hw || []).forEach((h: any) => {
        if (h.assignment_id) {
          leafMax.set(h.assignment_id, Number(h.homework_assignments?.max_score) || 0);
        }
      });
      const leaves = Array.from(leafMax.entries()).map(([id, max_score]) => ({ id, max_score }));
      const subs = (hw || []).map((h: any) => ({
        assignment_id: h.assignment_id,
        score: h.score,
        score_feedback: h.score_feedback ?? null,
        scored_at: h.scored_at ?? null,
        previous_attempts: h.previous_attempts ?? null,
      }));
      const summary = summarizeHomework(effectiveLeafGrades(leaves, subs));
      setHwScored(summary.scoredCount);
      setHwAvg(summary.avg10);

      setStreakCur(streak?.current_streak || 0);
      setStreakLong(streak?.longest_streak || 0);

      // Daily heatmap (last 90 days)
      const dwsMap = new Map<string, number>();
      (dws || []).forEach((r: any) => dwsMap.set(r.watch_date, Number(r.total_seconds) || 0));
      const out: DayCell[] = [];
      for (let i = 0; i < 90; i++) {
        const key = tkStr(-89 + i);
        out.push({ date: key, seconds: dwsMap.get(key) || 0 });
      }
      setDays(out);

      const lang = i18n.language as "uz" | "ru" | "en";
      const nameKey = `name_${lang === "ru" ? "ru" : lang === "en" ? "en" : "uz"}`;
      setBadges(
        (badgeRows || []).map((b: any) => ({
          earned_at: b.earned_at,
          name: b.badges?.[nameKey] || b.badges?.name_uz || "—",
          icon: b.badges?.icon || null,
        }))
      );

      setLogins((authRows || []).filter((r: any) => r.event === "login" || r.event === "magic_login"));
     } catch (e) {
       if (!cancelled) { console.error("[MyActivity] load failed", e); setError(true); }
     } finally {
       if (!cancelled) setLoading(false);
     }
    })();
    return () => { cancelled = true; };
  }, [user, i18n.language, reloadKey]);

  const maxDay = Math.max(1, ...days.map((d) => d.seconds));
  const cellShade = (s: number) => {
    if (s <= 0) return "bg-muted/40";
    const pct = s / maxDay;
    if (pct < 0.25) return "bg-primary/25";
    if (pct < 0.5) return "bg-primary/45";
    if (pct < 0.75) return "bg-primary/70";
    return "bg-primary";
  };

  return (
    <PageShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{t("activity.title")}</h1>
          <p className="text-muted-foreground mt-1">{t("activity.subtitle")}</p>
        </div>

        {!loading && error && (
          <Card className="p-6 text-center">
            <p className="text-sm text-muted-foreground">Faoliyat ma'lumotlarini yuklab bo'lmadi.</p>
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="mt-3 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            >
              Qayta urinish
            </button>
          </Card>
        )}

        {/* Lifetime tiles */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Clock className="h-3.5 w-3.5" />{t("activity.totalWatch")}</div>
            <div className="text-2xl font-semibold mt-1 tabular-nums">{loading ? "—" : fmtHM(totalSeconds, i18n.language)}</div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><BookOpen className="h-3.5 w-3.5" />{t("activity.lessonsCompleted")}</div>
            <div className="text-2xl font-semibold mt-1 tabular-nums">{loading ? "—" : completedCount}</div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><FileCheck2 className="h-3.5 w-3.5" />{t("activity.homework")}</div>
            <div className="text-2xl font-semibold mt-1 tabular-nums">
              {loading ? "—" : `${hwCount}`}
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              {hwScored > 0 ? `${t("activity.avgScore")}: ${hwAvg?.toFixed(1)} / 10` : t("activity.noneScored")}
            </div>
          </Card>
          <Card className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Flame className="h-3.5 w-3.5" />{t("activity.streak")}</div>
            <div className="text-2xl font-semibold mt-1 tabular-nums">{loading ? "—" : streakCur}</div>
            <div className="text-[11px] text-muted-foreground mt-0.5">{t("activity.longest")}: {streakLong}</div>
          </Card>
        </div>

        {/* Heatmap */}
        <Card className="p-4">
          <div className="text-sm font-medium">{t("activity.last90Days")}</div>
          {loading ? (
            <Skeleton className="h-16 mt-3" />
          ) : (
            <div className="mt-3 grid grid-flow-col grid-rows-7 gap-1 overflow-x-auto">
              {days.map((d) => (
                <div
                  key={d.date}
                  title={`${d.date} • ${fmtHM(d.seconds, i18n.language)}`}
                  className={`w-3 h-3 rounded-sm ${cellShade(d.seconds)}`}
                />
              ))}
            </div>
          )}
        </Card>

        {/* Videos watched */}
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium flex items-center gap-2"><PlayCircle className="h-4 w-4" />{t("activity.videosWatched")}</div>
            <div className="text-xs text-muted-foreground">{lessons.length}</div>
          </div>
          {loading ? (
            <Skeleton className="h-32 mt-3" />
          ) : lessons.length === 0 ? (
            <div className="text-sm text-muted-foreground mt-3">{t("activity.noVideos")}</div>
          ) : (
            <div className="mt-3 divide-y">
              {lessons.slice(0, 50).map((l) => (
                <Link
                  key={l.lesson_id}
                  to={`/lesson/${l.course_id}/${l.lesson_id}`}
                  className="py-2.5 flex items-center justify-between gap-3 hover:bg-muted/40 rounded px-2 -mx-2 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{l.lesson_title}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {l.course_title} • {l.module_title}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs tabular-nums">{fmtHM(l.watch_seconds, i18n.language)}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {fmtDate(l.updated_at, i18n.language)}
                      {l.completed_at && <span className="ml-1 text-primary">✓</span>}
                    </div>
                  </div>
                </Link>
              ))}
              {lessons.length > 50 && (
                <div className="text-xs text-muted-foreground pt-2">+{lessons.length - 50}</div>
              )}
            </div>
          )}
        </Card>

        {/* Homework history */}
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium flex items-center gap-2"><FileCheck2 className="h-4 w-4" />{t("activity.homeworkHistory")}</div>
            <div className="text-xs text-muted-foreground">{homework.length}</div>
          </div>
          {loading ? (
            <Skeleton className="h-24 mt-3" />
          ) : homework.length === 0 ? (
            <div className="text-sm text-muted-foreground mt-3">{t("activity.noHomework")}</div>
          ) : (
            <div className="mt-3 divide-y">
              {homework.map((h) => (
                <div key={h.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">
                      {h.module_title} • #{h.task_number}
                    </div>
                    <div className="text-xs text-muted-foreground">{fmtDate(h.submitted_at, i18n.language)}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {h.is_late && <Badge variant="outline" className="text-[10px]">{t("activity.late")}</Badge>}
                    {h.score != null ? (
                      <Badge variant="secondary" className="tabular-nums">{h.score}/{h.max_score}</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">{t("activity.pending")}</Badge>
                    )}
                    {h.telegram_message_url && (
                      <a href={h.telegram_message_url} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
                        TG
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Badges */}
        {badges.length > 0 && (
          <Card className="p-4">
            <div className="text-sm font-medium flex items-center gap-2"><Award className="h-4 w-4" />{t("activity.badgesEarned")}</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {badges.map((b, i) => (
                <Badge key={i} variant="secondary" className="text-xs">
                  {b.icon ? <span className="mr-1">{b.icon}</span> : null}
                  {b.name}
                </Badge>
              ))}
            </div>
          </Card>
        )}

        {/* Logins */}
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium flex items-center gap-2"><LogIn className="h-4 w-4" />{t("activity.recentLogins")}</div>
            <div className="text-xs text-muted-foreground">{logins.length}</div>
          </div>
          {loading ? (
            <Skeleton className="h-16 mt-3" />
          ) : logins.length === 0 ? (
            <div className="text-sm text-muted-foreground mt-3">{t("activity.noLogins")}</div>
          ) : (
            <div className="mt-3 space-y-1.5 max-h-64 overflow-y-auto">
              {logins.map((l, i) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{fmtDate(l.created_at, i18n.language)}</span>
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{l.event}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </PageShell>
  );
}
