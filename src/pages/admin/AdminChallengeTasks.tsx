import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChallengeTaskDrawer } from "@/components/admin/ChallengeTaskDrawer";
import {
  POST_STATE_UZ, prettyDate, SOURCE_UZ, STATUS_UZ, type GroupLite, type PostRow, type TaskRow,
} from "@/components/admin/challengeTasksShared";
import { ChallengePlanImportDialog } from "@/components/admin/ChallengePlanImportDialog";
import { ChallengeTaskResults } from "@/components/admin/ChallengeTaskResults";
import { ChallengeWeekApprove } from "@/components/admin/ChallengeWeekApprove";
import { weekFromSearch } from "@/lib/weekApproval";
import {
  addDays, inWindow, isoWeekday, MONTH_UZ, readCalendarConfig, requiresSummary, tashkentToday, WEEKDAY_SHORT_UZ,
  type CalendarConfig, type TaskSource,
} from "@/lib/dailyTasksPlan";
import { AlertTriangle, ChevronLeft, ChevronRight, Plus, Upload, RefreshCw } from "lucide-react";

type Course = { id: string; title: string };

const STATUS_CLASS: Record<string, string> = {
  approved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  draft: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  cancelled: "bg-muted text-muted-foreground border-border line-through",
};

function StatusChip({ status }: { status: string }) {
  return <span className={`inline-block rounded border px-1.5 py-px text-[10px] ${STATUS_CLASS[status] ?? ""}`}>{STATUS_UZ[status] ?? status}</span>;
}

const monthStart = (ym: string) => `${ym}-01`;
function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
const isMissingRelation = (msg: string | undefined, code?: string) =>
  code === "42P01" || code === "PGRST205" || /does not exist|could not find the table/i.test(msg ?? "");

/**
 * Admin → Kunlik vazifalar (Challenge 6.0 daily tasks, PR-2). The task calendar: a month grid on Tashkent dates
 * (rest days greyed), a week list, the day drawer (edit / approve / cancel, requires, live post preview, manual
 * post links) and the plan importer. Writes go through mutate() (table, RLS admin-only) or the admin RPCs.
 * Nothing here posts: the engine and the worker (later PRs) read this calendar.
 */
export default function AdminChallengeTasks() {
  const [cfg, setCfg] = useState<CalendarConfig | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState("");
  const [groups, setGroups] = useState<GroupLite[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [posts, setPosts] = useState<PostRow[]>([]);
  const [missing, setMissing] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const today = tashkentToday();
  // PR-9: the bot's «👀 Ko‘rib chiqish» opens …/admin/challenge/tasks?week=YYYY-MM-DD -> the week list, on that week
  const [focusWeek] = useState<string | null>(() => weekFromSearch(typeof window !== "undefined" ? window.location.search : ""));
  const [month, setMonth] = useState((focusWeek ?? today).slice(0, 7));
  const [view, setView] = useState<"month" | "weeks" | "results">(focusWeek ? "weeks" : "month");
  const [drawer, setDrawer] = useState<{ open: boolean; taskId: number | null; date: string }>({ open: false, taskId: null, date: today });
  const [importOpen, setImportOpen] = useState(false);

  // config + the challenge's courses (course_ids, the courses of group_ids, and of the E2E test groups)
  useEffect(() => {
    (async () => {
      const [ps, cs, gs] = await Promise.all([
        supabase.from("platform_settings").select("key,value").in("key", ["challenge", "challenge_tasks"]),
        supabase.from("courses").select("id,title").order("title"),
        supabase.from("groups").select("id,course_id"),
      ]);
      const byKey = Object.fromEntries(((ps.data ?? []) as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
      const c = readCalendarConfig(byKey.challenge, byKey.challenge_tasks);
      setCfg(c);
      const groupCourse = new Map(((gs.data ?? []) as { id: string; course_id: string | null }[]).map((g) => [g.id, g.course_id]));
      const scope = new Set<string>(c.courseIds);
      for (const gid of [...c.groupIds, ...c.testGroupIds]) {
        const cid = groupCourse.get(gid);
        if (cid) scope.add(cid);
      }
      const list = ((cs.data ?? []) as Course[]).filter((x) => scope.has(x.id));
      setCourses(list);
      setCourseId((prev) => prev || (list.find((x) => c.courseIds.includes(x.id)) ?? list[0])?.id || "");
      if (list.length === 0) setLoading(false);
    })();
  }, []);

  const reload = useCallback(async () => {
    if (!courseId) return;
    setLoading(true);
    setLoadErr(null);
    try {
      const [t, g] = await Promise.all([
        supabase.from("challenge_tasks").select("*").eq("course_id", courseId).order("task_date").order("id"),
        supabase.from("groups").select("id,name,daily_task_chat_id,daily_task_topic_id").eq("course_id", courseId).order("name"),
      ]);
      if (t.error) {
        if (isMissingRelation(t.error.message, t.error.code)) { setMissing(true); return; }
        setLoadErr(t.error.message);
        return;
      }
      setMissing(false);
      const rows = (t.data ?? []) as unknown as TaskRow[];
      setTasks(rows);
      setGroups((g.data ?? []) as GroupLite[]);
      const ids = rows.map((r) => r.id);
      if (ids.length === 0) { setPosts([]); return; }
      const p = await supabase.from("challenge_task_posts")
        .select("task_id,group_id,kind,state,chat_id,thread_id,message_id,sent_at").in("task_id", ids);
      setPosts((p.data ?? []) as PostRow[]);
    } finally {
      setLoading(false);
    }
  }, [courseId]);

  useEffect(() => { void reload(); }, [reload]);

  // the deep-linked week scrolls into view once the list has rendered
  useEffect(() => {
    if (!focusWeek || loading || view !== "weeks") return;
    document.getElementById(`week-${focusWeek}`)?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [focusWeek, loading, view]);

  const byDate = useMemo(() => {
    const m = new Map<string, TaskRow[]>();
    for (const t of tasks) {
      const list = m.get(t.task_date) ?? [];
      list.push(t);
      m.set(t.task_date, list);
    }
    for (const list of m.values()) list.sort((a, b) => Number(a.status === "cancelled") - Number(b.status === "cancelled"));
    return m;
  }, [tasks]);
  const liveOn = (d: string) => byDate.get(d)?.find((t) => t.status !== "cancelled") ?? null;
  const approvedOn = (d: string) => byDate.get(d)?.some((t) => t.status === "approved") ?? false;
  const topicGroups = groups.filter((g) => g.daily_task_topic_id);

  if (!cfg) {
    return <PageShell><p className="text-sm text-muted-foreground">Yuklanmoqda…</p></PageShell>;
  }

  // is_task_day(d) = a configured weekday OR an approved task exists (spec §6.2 / G6)
  const isTaskDay = (d: string) => cfg.weekdays.includes(isoWeekday(d)) || approvedOn(d);
  const tomorrow = addDays(today, 1);
  const tomorrowMissing = cfg.weekdays.includes(isoWeekday(tomorrow)) && !approvedOn(tomorrow) && inWindow(tomorrow, cfg);

  // the owner's rule of thumb: keep the next task days approved at least a week ahead
  const nextTaskDays: string[] = [];
  for (let d = today, i = 0; nextTaskDays.length < 5 && i < 60; d = addDays(d, 1), i++) {
    if (cfg.weekdays.includes(isoWeekday(d)) && inWindow(d, cfg)) nextTaskDays.push(d);
  }
  const nextApproved = nextTaskDays.filter(approvedOn).length;
  const counts = {
    approved: tasks.filter((t) => t.status === "approved").length,
    draft: tasks.filter((t) => t.status === "draft").length,
  };

  // month grid: Monday-first weeks covering the month
  const first = monthStart(month);
  const last = addDays(monthStart(shiftMonth(month, 1)), -1);
  const gridStart = addDays(first, -(isoWeekday(first) - 1));
  const gridEnd = addDays(last, 7 - isoWeekday(last));
  const days: string[] = [];
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 1)) days.push(d);

  // week list: every task (cancelled too) grouped by the Monday of its week
  const weeks = new Map<string, TaskRow[]>();
  for (const t of tasks) {
    const monday = addDays(t.task_date, -(isoWeekday(t.task_date) - 1));
    const list = weeks.get(monday) ?? [];
    list.push(t);
    weeks.set(monday, list);
  }
  if (focusWeek && !weeks.has(focusWeek)) weeks.set(focusWeek, []); // a deep-linked week with no task still shows
  const openDay = (d: string) => setDrawer({ open: true, taskId: liveOn(d)?.id ?? null, date: d });
  const openTask = (t: TaskRow) => setDrawer({ open: true, taskId: t.id, date: t.task_date });
  const drawerTask = drawer.taskId !== null ? tasks.find((t) => t.id === drawer.taskId) ?? null : null;
  const course = courses.find((c) => c.id === courseId);
  const postsOf = (taskId: number) => posts.filter((p) => p.task_id === taskId && p.kind === "task");

  return (
    <PageShell>
      <div className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">📅 Kunlik vazifalar</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Challenge kunlik vazifalari kalendari (Toshkent vaqti). Faqat tasdiqlangan vazifa e’lon qilinadi — shu kuni 09:00 da
              guruhlarning «Kunlik vazifalar» topikiga.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {courses.length > 1 && (
              <Select value={courseId} onValueChange={setCourseId}>
                <SelectTrigger className="w-[240px]"><SelectValue placeholder="Kurs" /></SelectTrigger>
                <SelectContent>{courses.map((c) => <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>)}</SelectContent>
              </Select>
            )}
            <Button variant="outline" size="sm" onClick={() => void reload()} disabled={!courseId}><RefreshCw className="h-4 w-4" /></Button>
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)} disabled={!courseId || missing}>
              <Upload className="h-4 w-4 mr-1" /> Rejani import qilish
            </Button>
            <Button size="sm" onClick={() => setDrawer({ open: true, taskId: null, date: tomorrow })} disabled={!courseId || missing}>
              <Plus className="h-4 w-4 mr-1" /> Vazifa
            </Button>
          </div>
        </div>

        {courses.length === 0 && (
          <Card className="p-4 text-sm">Challenge doirasida kurs yo‘q (platform_settings.challenge.course_ids / group_ids).</Card>
        )}
        {missing && (
          <Card className="p-4 text-sm border-amber-500/40">
            Kalendar jadvali hali bazada yo‘q — migratsiya (20260930122010) qo‘llanganidan keyin sahifa ishlaydi.
          </Card>
        )}
        {loadErr && <Card className="p-4 text-sm text-rose-600">Yuklab bo‘lmadi: {loadErr}</Card>}

        {!missing && courseId && (
          <>
            {tomorrowMissing && (
              <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-700 dark:text-rose-400 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span><b>Ertangi vazifa yo‘q!</b> {prettyDate(tomorrow)} — vazifa kuni, lekin tasdiqlangan vazifa yo‘q.</span>
                <Button size="sm" variant="outline" className="ml-auto" onClick={() => openDay(tomorrow)}>Ochish</Button>
              </div>
            )}
            {!cfg.enabled && (
              <div className="rounded-md border px-4 py-2 text-xs text-muted-foreground">
                Tizim hali yoqilmagan (challenge_tasks.enabled = false): bot hech narsa e’lon qilmaydi va ball bermaydi. Shu vaqtgacha
                vazifani xodim qo‘lda e’lon qilsa — o‘sha kunni «Retro» deb belgilab, har guruh uchun xabar havolasini kiriting.
              </div>
            )}
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">Tasdiqlangan: {counts.approved}</Badge>
              <Badge variant="outline">Qoralama: {counts.draft}</Badge>
              <Badge variant={nextApproved < nextTaskDays.length ? "destructive" : "outline"}>
                Keyingi {nextTaskDays.length} vazifa kunidan tasdiqlangan: {nextApproved}
              </Badge>
              <Badge variant="outline">Vazifa kunlari: {cfg.weekdays.map((d) => WEEKDAY_SHORT_UZ[d - 1]).join(", ")}</Badge>
              <Badge variant="outline">«Kunlik vazifalar» topiki bor guruhlar: {topicGroups.length}/{groups.length}</Badge>
              {cfg.windowStart && <Badge variant="outline">Challenge: {cfg.windowStart}{cfg.windowEnd ? ` — ${cfg.windowEnd}` : " dan"}</Badge>}
            </div>

            <Tabs value={view} onValueChange={(v) => setView(v as "month" | "weeks" | "results")}>
              <TabsList>
                <TabsTrigger value="month">Oy</TabsTrigger>
                <TabsTrigger value="weeks">Haftalar ro‘yxati</TabsTrigger>
                <TabsTrigger value="results">Natijalar</TabsTrigger>
              </TabsList>
            </Tabs>

            {view === "results" && <ChallengeTaskResults tasks={tasks} groups={groups} today={today} />}

            {view === "month" && (
              <Card className="p-3 shadow-soft">
                <div className="flex items-center justify-between mb-2">
                  <Button size="icon" variant="ghost" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft className="h-4 w-4" /></Button>
                  <span className="text-sm font-medium capitalize">{MONTH_UZ[Number(month.slice(5, 7)) - 1]} {month.slice(0, 4)}</span>
                  <Button size="icon" variant="ghost" onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight className="h-4 w-4" /></Button>
                </div>
                <div className="overflow-x-auto">
                  <div className="grid grid-cols-7 gap-1 min-w-[700px]">
                    {WEEKDAY_SHORT_UZ.map((w, i) => (
                      <div key={w} className={`text-center text-[11px] font-medium py-1 ${cfg.weekdays.includes(i + 1) ? "" : "text-muted-foreground/60"}`}>{w}</div>
                    ))}
                    {days.map((d) => {
                      const live = liveOn(d);
                      const cancelled = (byDate.get(d) ?? []).filter((t) => t.status === "cancelled").length;
                      const rest = !isTaskDay(d);
                      const outside = d.slice(0, 7) !== month;
                      const manual = live ? postsOf(live.id).filter((p) => p.state === "manual").length : 0;
                      const sent = live ? postsOf(live.id).filter((p) => p.state === "sent" || p.state === "sent_via_sql").length : 0;
                      return (
                        <button key={d} type="button" onClick={() => openDay(d)}
                          className={`text-left rounded-md border p-1.5 min-h-[92px] flex flex-col gap-1 transition-colors hover:border-primary/60
                            ${rest ? "bg-muted/60" : "bg-background"} ${outside ? "opacity-50" : ""} ${d === today ? "ring-1 ring-primary" : ""}
                            ${d === tomorrow && tomorrowMissing ? "border-rose-500/60" : ""}`}>
                          <div className="flex items-center justify-between text-[11px]">
                            <span className={d === today ? "font-semibold text-primary" : "text-muted-foreground"}>{Number(d.slice(8))}</span>
                            {rest && <span className="text-[10px] text-muted-foreground">dam</span>}
                            {!inWindow(d, cfg) && !rest && <span className="text-[10px] text-muted-foreground">oynadan tashqari</span>}
                          </div>
                          {live && (
                            <>
                              <div className="flex flex-wrap items-center gap-1">
                                <span className="text-[11px]">{live.type === "instagram" ? "📸" : "📝"}</span>
                                <StatusChip status={live.status} />
                                {live.source === "retro" && <span className="text-[10px] text-muted-foreground">retro</span>}
                              </div>
                              <div className="text-[11px] leading-snug line-clamp-2">{live.title}</div>
                              {(manual > 0 || sent > 0) && (
                                <div className="text-[10px] text-muted-foreground">
                                  {sent > 0 && `🤖 ${sent}/${topicGroups.length} `}{manual > 0 && `✋ ${manual}/${topicGroups.length}`}
                                </div>
                              )}
                            </>
                          )}
                          {!live && !rest && inWindow(d, cfg) && <span className="text-[10px] text-muted-foreground mt-auto">+ vazifa</span>}
                          {cancelled > 0 && <span className="text-[10px] text-muted-foreground">bekor: {cancelled}</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground mt-2">
                  Kulrang — dam olish kuni (vazifa kunlari: platform_settings.challenge_tasks.task_weekdays). 🤖 — bot e’lon qilgan, ✋ — qo‘lda e’lon qilingan guruhlar.
                </p>
              </Card>
            )}

            {view === "weeks" && (
              <Card className="p-0 overflow-x-auto shadow-soft">
                {weeks.size === 0 && <p className="p-4 text-sm text-muted-foreground">{loading ? "Yuklanmoqda…" : "Hali vazifa yo‘q. «Rejani import qilish» yoki «+ Vazifa»."}</p>}
                {[...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([monday, list]) => (
                  <div key={monday} id={`week-${monday}`} data-focused={monday === focusWeek ? "true" : undefined}
                    className={`border-b last:border-b-0 ${monday === focusWeek ? "ring-2 ring-inset ring-primary" : ""}`}>
                    <div className="px-4 py-2 bg-muted/40 text-xs font-medium flex flex-wrap items-center gap-2">
                      <span>{prettyDate(monday)} — {prettyDate(addDays(monday, 6))}</span>
                      {monday === focusWeek && <Badge variant="outline" className="text-[10px]">Botdagi havola</Badge>}
                      <span className="ml-auto" />
                      <ChallengeWeekApprove weekStart={monday} courseId={courseId}
                        drafts={list.filter((t) => t.status === "draft").length} onDone={() => void reload()} />
                    </div>
                    {list.length === 0 && <p className="px-4 py-3 text-xs text-muted-foreground">Bu haftada vazifa yo‘q.</p>}
                    <table className="w-full text-sm min-w-[760px]">
                      <tbody>
                        {list.map((t) => (
                          <tr key={t.id} className="border-t first:border-t-0 hover:bg-muted/30 cursor-pointer" onClick={() => openTask(t)}>
                            <td className="px-4 py-2 whitespace-nowrap text-xs w-[150px]">{prettyDate(t.task_date)}</td>
                            <td className="px-2 py-2 text-xs w-[40px]">{t.type === "instagram" ? "📸" : "📝"}</td>
                            <td className="px-2 py-2">
                              <div className="font-medium text-sm">{t.title}</div>
                              <div className="text-[11px] text-muted-foreground">{requiresSummary(t.requires)}</div>
                            </td>
                            <td className="px-2 py-2 text-xs whitespace-nowrap">
                              {postsOf(t.id).map((p) => POST_STATE_UZ[p.state] ?? p.state).filter((v, i, a) => a.indexOf(v) === i).join(", ") || "—"}
                            </td>
                            <td className="px-2 py-2 text-xs whitespace-nowrap">{t.plan_ref ?? ""} {SOURCE_UZ[t.source as TaskSource] ?? t.source}</td>
                            <td className="px-4 py-2 text-right"><StatusChip status={t.status} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </Card>
            )}
          </>
        )}
      </div>

      {courseId && (
        <ChallengeTaskDrawer
          open={drawer.open}
          onOpenChange={(v) => setDrawer((prev) => ({ ...prev, open: v }))}
          task={drawerTask}
          date={drawer.date}
          courseId={courseId}
          cfg={cfg}
          groups={groups}
          posts={posts}
          onChanged={() => void reload()}
        />
      )}
      {courseId && (
        <ChallengePlanImportDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          courseId={courseId}
          courseTitle={course?.title ?? ""}
          cfg={cfg}
          existing={tasks}
          onImported={() => void reload()}
        />
      )}
    </PageShell>
  );
}
