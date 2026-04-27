import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ResponsiveContainer, AreaChart, Area, LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from "recharts";
import { toast } from "sonner";
import { Users as UsersIcon, LogIn, Activity, Trophy, Shield } from "lucide-react";
import { Link } from "react-router-dom";
import { formatDistanceToNow } from "date-fns";
import { useTranslation } from "react-i18next";
import { enUS, ru, uz } from "date-fns/locale";

const PALETTE = [
  "hsl(var(--primary))",
  "hsl(220 70% 60%)",
  "hsl(160 60% 45%)",
  "hsl(40 90% 55%)",
  "hsl(340 70% 60%)",
  "hsl(280 60% 60%)",
  "hsl(190 70% 50%)",
  "hsl(20 80% 55%)",
];

const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
const fmtDay = (d: Date) => d.toISOString().slice(5, 10);

export default function AdminDashboard() {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language === "ru" ? ru : i18n.language === "uz" ? uz : enUS;
  const [courses, setCourses] = useState<{ id: string; title: string; published: boolean }[]>([]);
  const [courseId, setCourseId] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const [stats, setStats] = useState({ total: 0, logins30d: 0, active7d: 0, completions: 0 });
  const [dailyLogins, setDailyLogins] = useState<{ day: string; count: number }[]>([]);
  const [dau, setDau] = useState<{ day: string; count: number }[]>([]);
  const [lessonsPerDay, setLessonsPerDay] = useState<{ day: string; count: number }[]>([]);
  const [moduleEngagement, setModuleEngagement] = useState<{ name: string; value: number }[]>([]);
  const [moduleFunnel, setModuleFunnel] = useState<{ name: string; completed: number; drop?: number }[]>([]);
  const [stuckByModule, setStuckByModule] = useState<{ name: string; count: number }[]>([]);
  const [stuck, setStuck] = useState<any[]>([]);
  const [recentActions, setRecentActions] = useState<any[]>([]);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("admin_actions")
        .select("id, action, actor_user_id, target_user_id, target_resource_type, details, created_at")
        .order("created_at", { ascending: false })
        .limit(25);
      const rows = data || [];
      const ids = Array.from(new Set(rows.flatMap((r: any) => [r.actor_user_id, r.target_user_id]).filter(Boolean)));
      let names: Record<string, string> = {};
      if (ids.length) {
        const { data: profs } = await supabase.from("profiles").select("id, name, last_name, email").in("id", ids);
        (profs || []).forEach((p: any) => {
          names[p.id] = [p.name, p.last_name].filter(Boolean).join(" ") || p.email || p.id.slice(0, 8);
        });
      }
      setRecentActions(rows.map((r: any) => ({
        ...r,
        actor_name: names[r.actor_user_id] || "Unknown",
        target_name: r.target_user_id ? (names[r.target_user_id] || "Unknown") : null,
      })));
    })();
  }, []);

  useEffect(() => {
    supabase.from("courses").select("id, title, published").order("title").then(({ data }) => {
      const list = data || [];
      setCourses(list);
      const first = list.find((c: any) => c.published) || list[0];
      if (first) setCourseId(first.id);
    });
  }, []);

  useEffect(() => { if (courseId) load(); /* eslint-disable-next-line */ }, [courseId]);

  const load = async () => {
    setLoading(true);
    try {
      const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
      const since7 = new Date(Date.now() - 7 * 86400_000).toISOString();

      // Top stats
      const { count: totalUsers } = await supabase.from("profiles").select("id", { count: "exact", head: true });
      const { data: events30 } = await supabase.from("auth_events").select("user_id, created_at").gte("created_at", since30).limit(50000);
      const { data: prog7 } = await supabase.from("lesson_progress").select("user_id, updated_at").gte("updated_at", since7).limit(50000);
      const active7 = new Set((prog7 || []).map((p: any) => p.user_id)).size;

      // Module + lesson info for course
      const { data: mods } = await supabase
        .from("modules")
        .select("id, title, position, lessons(id, published)")
        .eq("course_id", courseId)
        .order("position");
      const modules = (mods || []) as any[];

      // All lessons in course (published)
      const allLessonIds = modules.flatMap((m: any) => (m.lessons || []).filter((l: any) => l.published).map((l: any) => l.id));

      // Course progress (completed lessons across this course)
      const { data: completedRows } = allLessonIds.length
        ? await supabase.from("lesson_progress").select("user_id, lesson_id, updated_at").in("lesson_id", allLessonIds).not("completed_at", "is", null).limit(50000)
        : { data: [] as any[] };

      const completedSet = new Map<string, Set<string>>(); // user -> set of lesson ids
      (completedRows || []).forEach((r: any) => {
        if (!completedSet.has(r.user_id)) completedSet.set(r.user_id, new Set());
        completedSet.get(r.user_id)!.add(r.lesson_id);
      });

      // course completions = users who completed ALL lessons
      let completions = 0;
      if (allLessonIds.length > 0) {
        completedSet.forEach((s) => { if (s.size >= allLessonIds.length) completions++; });
      }

      setStats({
        total: totalUsers || 0,
        logins30d: (events30 || []).length,
        active7d: active7,
        completions,
      });

      // Daily logins (30d)
      const dayMap = new Map<string, Set<string>>();
      const loginMap = new Map<string, number>();
      for (let i = 29; i >= 0; i--) {
        const d = startOfDay(new Date(Date.now() - i * 86400_000));
        loginMap.set(fmtDay(d), 0);
        dayMap.set(fmtDay(d), new Set());
      }
      (events30 || []).forEach((e: any) => {
        const k = fmtDay(startOfDay(new Date(e.created_at)));
        if (loginMap.has(k)) loginMap.set(k, (loginMap.get(k) || 0) + 1);
      });
      setDailyLogins(Array.from(loginMap, ([day, count]) => ({ day, count })));

      // DAU (30d)
      const { data: prog30 } = await supabase.from("lesson_progress").select("user_id, updated_at").gte("updated_at", new Date(Date.now() - 30 * 86400_000).toISOString()).limit(100000);
      (prog30 || []).forEach((p: any) => {
        const k = fmtDay(startOfDay(new Date(p.updated_at)));
        if (dayMap.has(k)) dayMap.get(k)!.add(p.user_id);
      });
      setDau(Array.from(dayMap, ([day, set]) => ({ day, count: set.size })));

      // Lessons completed per day (30d, this course)
      const lpdMap = new Map<string, number>();
      for (let i = 29; i >= 0; i--) {
        const d = startOfDay(new Date(Date.now() - i * 86400_000));
        lpdMap.set(fmtDay(d), 0);
      }
      (completedRows || []).forEach((r: any) => {
        const k = fmtDay(startOfDay(new Date(r.updated_at)));
        if (lpdMap.has(k)) lpdMap.set(k, (lpdMap.get(k) || 0) + 1);
      });
      setLessonsPerDay(Array.from(lpdMap, ([day, count]) => ({ day, count })));

      // Module engagement pie + funnel
      const engagement: { name: string; value: number }[] = [];
      const funnel: { name: string; completed: number; drop?: number }[] = [];
      modules.forEach((m: any) => {
        const lessonIds: string[] = (m.lessons || []).filter((l: any) => l.published).map((l: any) => l.id);
        if (lessonIds.length === 0) return;
        // Engagement: distinct students who completed >=1 lesson in module
        const engSet = new Set<string>();
        // Funnel: students who completed ALL lessons in module
        const userCompletedInMod = new Map<string, number>();
        (completedRows || []).forEach((r: any) => {
          if (lessonIds.includes(r.lesson_id)) {
            engSet.add(r.user_id);
            userCompletedInMod.set(r.user_id, (userCompletedInMod.get(r.user_id) || 0) + 1);
          }
        });
        let allDone = 0;
        userCompletedInMod.forEach((c) => { if (c >= lessonIds.length) allDone++; });
        engagement.push({ name: m.title, value: engSet.size });
        funnel.push({ name: m.title, completed: allDone });
      });
      // compute drop deltas
      for (let i = 1; i < funnel.length; i++) {
        funnel[i].drop = funnel[i - 1].completed - funnel[i].completed;
      }
      setModuleEngagement(engagement);
      setModuleFunnel(funnel);

      // Stuck students: latest progress > 7d ago, not 100%
      const latestByUser = new Map<string, { updated_at: string; lesson_id: string }>();
      (completedRows || []).forEach((r: any) => {
        const cur = latestByUser.get(r.user_id);
        if (!cur || new Date(r.updated_at) > new Date(cur.updated_at)) {
          latestByUser.set(r.user_id, { updated_at: r.updated_at, lesson_id: r.lesson_id });
        }
      });
      const stuckUserIds: { user_id: string; updated_at: string; lesson_id: string; pct: number }[] = [];
      latestByUser.forEach((v, uid) => {
        const ageDays = (Date.now() - new Date(v.updated_at).getTime()) / 86400_000;
        const pct = allLessonIds.length ? Math.round(((completedSet.get(uid)?.size || 0) / allLessonIds.length) * 100) : 0;
        if (ageDays >= 7 && pct < 100) stuckUserIds.push({ user_id: uid, updated_at: v.updated_at, lesson_id: v.lesson_id, pct });
      });

      // Stuck-by-module bars
      const lessonToModule = new Map<string, string>();
      modules.forEach((m: any) => (m.lessons || []).forEach((l: any) => lessonToModule.set(l.id, m.title)));
      const stuckMod = new Map<string, number>();
      modules.forEach((m: any) => stuckMod.set(m.title, 0));
      stuckUserIds.forEach((s) => {
        const t = lessonToModule.get(s.lesson_id);
        if (t) stuckMod.set(t, (stuckMod.get(t) || 0) + 1);
      });
      setStuckByModule(Array.from(stuckMod, ([name, count]) => ({ name, count })));

      // Hydrate stuck table with profiles + lesson titles
      if (stuckUserIds.length) {
        const userIds = stuckUserIds.map((s) => s.user_id);
        const lessonIds = Array.from(new Set(stuckUserIds.map((s) => s.lesson_id)));
        const [{ data: profs }, { data: lessonRows }] = await Promise.all([
          supabase.from("profiles").select("id, name, email").in("id", userIds),
          supabase.from("lessons").select("id, title").in("id", lessonIds),
        ]);
        const pmap = new Map((profs || []).map((p: any) => [p.id, p]));
        const lmap = new Map((lessonRows || []).map((l: any) => [l.id, l.title]));
        const enriched = stuckUserIds
          .map((s) => ({
            ...s,
            name: pmap.get(s.user_id)?.name || pmap.get(s.user_id)?.email || "—",
            email: pmap.get(s.user_id)?.email || "",
            lesson_title: lmap.get(s.lesson_id) || "—",
            days_since: Math.floor((Date.now() - new Date(s.updated_at).getTime()) / 86400_000),
          }))
          .sort((a, b) => b.days_since - a.days_since)
          .slice(0, 50);
        setStuck(enriched);
      } else {
        setStuck([]);
      }
    } catch (e: any) {
      toast.error(e.message || t("admin.dashboard.loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <PageShell>
      <div className="space-y-6">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">{t("admin.dashboard.title")}</h1>
            <p className="text-muted-foreground mt-1">{t("admin.dashboard.subtitle")}</p>
          </div>
          <Select value={courseId} onValueChange={setCourseId}>
            <SelectTrigger className="w-[260px]"><SelectValue placeholder={t("admin.dashboard.selectCourse")} /></SelectTrigger>
            <SelectContent>
              {courses.map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.title}{!c.published && t("admin.dashboard.draftSuffix")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard icon={<UsersIcon className="h-4 w-4" />} label={t("admin.dashboard.stats.totalStudents")} value={stats.total} />
          <StatCard icon={<LogIn className="h-4 w-4" />} label={t("admin.dashboard.stats.logins30d")} value={stats.logins30d} />
          <StatCard icon={<Activity className="h-4 w-4" />} label={t("admin.dashboard.stats.active7d")} value={stats.active7d} />
          <StatCard icon={<Trophy className="h-4 w-4" />} label={t("admin.dashboard.stats.completions")} value={stats.completions} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ChartCard title={t("admin.dashboard.charts.dailyLogins")}>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={dailyLogins}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))" }} />
                <Area type="monotone" dataKey="count" stroke={PALETTE[0]} fill={PALETTE[0]} fillOpacity={0.2} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title={t("admin.dashboard.charts.dau")}>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={dau}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))" }} />
                <Line type="monotone" dataKey="count" stroke={PALETTE[2]} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title={t("admin.dashboard.charts.moduleEngagement")}>
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={moduleEngagement} dataKey="value" nameKey="name" outerRadius={90} label={(e) => `${e.value}`}>
                  {moduleEngagement.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))" }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title={t("admin.dashboard.charts.moduleFunnel")}>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={moduleFunnel}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={50} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))" }}
                  formatter={(v: any, _n: any, p: any) => p?.payload?.drop != null ? [`${v} (drop −${p.payload.drop})`, "completed"] : [v, "completed"]}
                />
                <Bar dataKey="completed" fill={PALETTE[1]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title={t("admin.dashboard.charts.lessonsPerDay")}>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={lessonsPerDay}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))" }} />
                <Bar dataKey="count" fill={PALETTE[3]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title={t("admin.dashboard.charts.stuckByModule")}>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={stuckByModule}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={50} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))" }} />
                <Bar dataKey="count" fill={PALETTE[4]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>

        <Card className="overflow-hidden shadow-soft">
          <div className="p-4 border-b">
            <h3 className="font-semibold">{t("admin.dashboard.stuck.title")}</h3>
            <p className="text-xs text-muted-foreground">{t("admin.dashboard.stuck.subtitle")}</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs">
                <tr>
                  <th className="text-left p-3">{t("admin.dashboard.stuck.name")}</th>
                  <th className="text-left p-3">{t("admin.dashboard.stuck.lastLesson")}</th>
                  <th className="text-left p-3">{t("admin.dashboard.stuck.daysIdle")}</th>
                  <th className="text-left p-3">{t("admin.dashboard.stuck.progress")}</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">{t("admin.dashboard.stuck.loading")}</td></tr>}
                {!loading && stuck.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">{t("admin.dashboard.stuck.empty")}</td></tr>}
                {stuck.map((s, i) => (
                  <tr key={i} className="border-t hover:bg-muted/20">
                    <td className="p-3 font-medium">{s.name}<div className="text-xs text-muted-foreground">{s.email}</div></td>
                    <td className="p-3 text-muted-foreground">{s.lesson_title}</td>
                    <td className="p-3 tabular-nums">{s.days_since}d</td>
                    <td className="p-3 tabular-nums">{s.pct}%</td>
                    <td className="p-3 text-right">
                      <Button variant="outline" size="sm" onClick={() => toast.info(t("admin.dashboard.stuck.queuedToast"))}>{t("admin.dashboard.stuck.sendEmail")}</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="overflow-hidden shadow-soft">
          <div className="p-4 border-b flex items-center justify-between">
            <div>
              <h3 className="font-semibold flex items-center gap-2"><Shield className="h-4 w-4" /> {t("admin.dashboard.recent.title")}</h3>
              <p className="text-xs text-muted-foreground">{t("admin.dashboard.recent.subtitle")}</p>
            </div>
            <Link to="/admin/audit"><Button variant="outline" size="sm">{t("admin.dashboard.recent.viewAll")}</Button></Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs">
                <tr>
                  <th className="text-left p-3">{t("admin.dashboard.recent.headers.when")}</th>
                  <th className="text-left p-3">{t("admin.dashboard.recent.headers.actor")}</th>
                  <th className="text-left p-3">{t("admin.dashboard.recent.headers.action")}</th>
                  <th className="text-left p-3">{t("admin.dashboard.recent.headers.target")}</th>
                </tr>
              </thead>
              <tbody>
                {recentActions.length === 0 && (
                  <tr><td colSpan={4} className="p-6 text-center text-muted-foreground">{t("admin.dashboard.recent.empty")}</td></tr>
                )}
                {recentActions.map((a) => (
                  <tr key={a.id} className="border-t hover:bg-muted/20">
                    <td className="p-3 text-muted-foreground whitespace-nowrap">{formatDistanceToNow(new Date(a.created_at), { addSuffix: true, locale: dateLocale })}</td>
                    <td className="p-3 font-medium">{a.actor_name}</td>
                    <td className="p-3"><code className="text-xs bg-muted px-1.5 py-0.5 rounded">{t(`admin.audit.actions.${a.action}`, { defaultValue: a.action })}</code></td>
                    <td className="p-3 text-muted-foreground">{a.target_name || a.target_resource_type || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </PageShell>
  );
}

const StatCard = ({ icon, label, value }: { icon: React.ReactNode; label: string; value: any }) => (
  <Card className="p-5 shadow-soft">
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</div>
    <div className="text-3xl font-semibold tracking-tight mt-1 tabular-nums">{value}</div>
  </Card>
);

const ChartCard = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <Card className="p-5 shadow-soft">
    <h3 className="font-semibold text-sm mb-4">{title}</h3>
    {children}
  </Card>
);
