import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

interface Props {
  userId: string;
  /** Course used for forecast + module progress (first enrolled course). */
  courseId?: string;
}

function fmtHM(seconds: number, locale: string) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (locale === "uz") return `${h}s ${m}d`;
  if (locale === "ru") return `${h}ч ${m}м`;
  return `${h}h ${m}m`;
}

function startOfDayUTC(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function StudentAnalytics({ userId, courseId }: Props) {
  return (
    <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-3 mt-4">
      <WeeklyStudyTimeCard userId={userId} />
      <CompletionForecastCard userId={userId} courseId={courseId} />
      <ModuleProgressCard userId={userId} courseId={courseId} />
    </div>
  );
}

/* ---------- Weekly Study Time ---------- */
function WeeklyStudyTimeCard({ userId }: { userId: string }) {
  const { t, i18n } = useTranslation();
  const [days, setDays] = useState<{ date: string; seconds: number }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const today = startOfDayUTC(new Date());
      const start = new Date(today); start.setUTCDate(start.getUTCDate() - 6);
      const startStr = start.toISOString().slice(0, 10);
      const { data } = await supabase
        .from("daily_watch_summary")
        .select("watch_date, total_seconds")
        .eq("user_id", userId)
        .gte("watch_date", startStr);
      const map = new Map<string, number>();
      (data || []).forEach((r: any) => map.set(r.watch_date, Number(r.total_seconds) || 0));
      const out: { date: string; seconds: number }[] = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(start); d.setUTCDate(start.getUTCDate() + i);
        const key = d.toISOString().slice(0, 10);
        out.push({ date: key, seconds: map.get(key) || 0 });
      }
      setDays(out);
      setLoading(false);
    })();
  }, [userId]);

  const total = days.reduce((s, d) => s + d.seconds, 0);
  const max = Math.max(1, ...days.map((d) => d.seconds));
  const todayKey = startOfDayUTC(new Date()).toISOString().slice(0, 10);
  const dayLabels = i18n.language === "ru"
    ? ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"]
    : i18n.language === "en"
    ? ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]
    : ["Du","Se","Cho","Pa","Ju","Sha","Ya"];
  const dayIndex = (iso: string) => {
    // JS getUTCDay: 0=Sun..6=Sat. Convert to Mon=0..Sun=6
    const d = new Date(iso + "T00:00:00Z").getUTCDay();
    return (d + 6) % 7;
  };

  return (
    <Card className="rounded-2xl border bg-card p-4">
      <div className="text-sm font-medium text-muted-foreground">{t("weekly_study_time.title")}</div>
      <div className="text-2xl font-semibold mt-1 tabular-nums">
        {loading ? "—" : total > 0 ? fmtHM(total, i18n.language) : "0" + (i18n.language === "uz" ? "d" : i18n.language === "ru" ? "м" : "m")}
      </div>
      <div className="mt-3 flex items-end gap-1.5 h-16">
        {days.map((d) => {
          const isToday = d.date === todayKey;
          const h = d.seconds > 0 ? Math.max(8, (d.seconds / max) * 100) : 4;
          return (
            <div key={d.date} className="flex-1 flex flex-col items-center gap-1 min-w-0">
              <div
                className={`w-full rounded-t-md transition-colors ${isToday ? "bg-primary" : "bg-muted-foreground/30"}`}
                style={{ height: `${h}%` }}
              />
              <div className={`text-[10px] ${isToday ? "text-primary font-medium" : "text-muted-foreground"}`}>
                {dayLabels[dayIndex(d.date)]}
              </div>
            </div>
          );
        })}
      </div>
      {!loading && total === 0 && (
        <div className="text-xs text-muted-foreground mt-2">{t("weekly_study_time.empty")}</div>
      )}
    </Card>
  );
}

/* ---------- Completion Forecast ---------- */
function CompletionForecastCard({ userId, courseId }: { userId: string; courseId?: string }) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "done" } | { kind: "forecast"; date: Date } | { kind: "keepgoing" }>({ kind: "loading" });

  useEffect(() => {
    (async () => {
      if (!courseId) { setState({ kind: "keepgoing" }); return; }
      // total + completed lessons in this course
      const { data: lessons } = await supabase
        .from("lessons")
        .select("id, modules!inner(course_id)")
        .eq("modules.course_id", courseId);
      const lessonIds = (lessons || []).map((l: any) => l.id);
      const total = lessonIds.length;
      if (total === 0) { setState({ kind: "keepgoing" }); return; }

      const since = new Date(); since.setUTCDate(since.getUTCDate() - 14);
      const { data: prog } = await supabase
        .from("lesson_progress")
        .select("lesson_id, completed_at")
        .eq("user_id", userId)
        .in("lesson_id", lessonIds)
        .not("completed_at", "is", null);
      const completedTotal = (prog || []).length;
      const recentCount = (prog || []).filter((p: any) => p.completed_at && new Date(p.completed_at) >= since).length;

      if (completedTotal >= total) { setState({ kind: "done" }); return; }
      const pace = recentCount / 14;
      if (pace <= 0) { setState({ kind: "keepgoing" }); return; }
      const remaining = total - completedTotal;
      const days = Math.ceil(remaining / pace);
      const dt = new Date(); dt.setUTCDate(dt.getUTCDate() + days);
      setState({ kind: "forecast", date: dt });
    })();
  }, [userId, courseId]);

  const fmtDate = (d: Date) =>
    new Intl.DateTimeFormat(i18n.language === "uz" ? "uz" : i18n.language, { day: "numeric", month: "long" }).format(d);

  return (
    <Card className="rounded-2xl border bg-card p-4">
      <div className="text-sm font-medium text-muted-foreground">{t("forecast.title")}</div>
      {state.kind === "loading" && <div className="text-2xl font-semibold mt-1">—</div>}
      {state.kind === "done" && (
        <>
          <div className="text-2xl font-semibold mt-1">{t("forecast.complete")}</div>
          <div className="text-xs text-muted-foreground mt-1">100%</div>
        </>
      )}
      {state.kind === "keepgoing" && (
        <>
          <div className="text-2xl font-semibold mt-1">{t("forecast.keep_going_title")}</div>
          <div className="text-xs text-muted-foreground mt-1">{t("forecast.keep_going_sub")}</div>
        </>
      )}
      {state.kind === "forecast" && (
        <>
          <div className="text-2xl font-semibold mt-1 tabular-nums">{fmtDate(state.date)}</div>
          <div className="text-xs text-muted-foreground mt-1">{t("forecast.subline")}</div>
        </>
      )}
    </Card>
  );
}

/* ---------- Module Progress ---------- */
function ModuleProgressCard({ userId, courseId }: { userId: string; courseId?: string }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<{ id: string; title: string; total: number; completed: number }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      if (!courseId) { setLoading(false); return; }
      const { data: ms } = await supabase
        .from("modules")
        .select("id, title, position, lessons(id)")
        .eq("course_id", courseId)
        .order("position", { ascending: true });
      const allLessonIds = (ms || []).flatMap((m: any) => m.lessons.map((l: any) => l.id));
      const { data: prog } = allLessonIds.length
        ? await supabase
            .from("lesson_progress")
            .select("lesson_id, completed_at")
            .eq("user_id", userId)
            .in("lesson_id", allLessonIds)
            .not("completed_at", "is", null)
        : { data: [] as any[] };
      const completedSet = new Set((prog || []).map((p: any) => p.lesson_id));
      setRows((ms || []).map((m: any) => ({
        id: m.id,
        title: m.title,
        total: m.lessons.length,
        completed: m.lessons.filter((l: any) => completedSet.has(l.id)).length,
      })));
      setLoading(false);
    })();
  }, [userId, courseId]);

  const visible = rows.slice(0, 5);
  const more = Math.max(0, rows.length - 5);
  const truncate = (s: string) => (s.length > 20 ? s.slice(0, 20) + "…" : s);

  return (
    <Card className="rounded-2xl border bg-card p-4">
      <div className="text-sm font-medium text-muted-foreground">{t("modules.progress_title")}</div>
      {loading ? (
        <div className="text-2xl font-semibold mt-1">—</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted-foreground mt-2">{t("modules.not_started")}</div>
      ) : (
        <div className="mt-3 space-y-2.5">
          {visible.map((m) => {
            const pct = m.total > 0 ? Math.round((m.completed / m.total) * 100) : 0;
            return (
              <div key={m.id} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate">{truncate(m.title)}</span>
                  <span className="tabular-nums text-muted-foreground">{pct}%</span>
                </div>
                <Progress value={pct} className="h-1.5" />
              </div>
            );
          })}
          {more > 0 && (
            <div className="text-[11px] text-muted-foreground pt-1">+{more} {t("common.more") || "more"}</div>
          )}
        </div>
      )}
    </Card>
  );
}
