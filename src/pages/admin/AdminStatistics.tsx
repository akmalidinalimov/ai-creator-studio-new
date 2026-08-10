import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from "recharts";
import { Users as UsersIcon, Activity, Trophy, TrendingUp, Zap, Crown, RefreshCw } from "lucide-react";

const PALETTE = [
  "hsl(var(--primary))",
  "hsl(220 70% 60%)",
  "hsl(160 60% 45%)",
  "hsl(40 90% 55%)",
  "hsl(340 70% 60%)",
  "hsl(280 60% 60%)",
];
const TT = { background: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 };

type GroupRow = {
  group_id: string; group_name: string; tier_name: string | null; teacher_name: string;
  total_students: number; active_students: number; activated_count: number;
  badges_earned: number; students_with_badges: number;
  avg_completion_pct: number; accessible_lessons: number;
  total_xp: number; avg_xp: number;
  homework_submitted: number; homework_avg_score: number | null; pending_homework: number;
};

const shortName = (n: string) => n.replace(/\s*5\.0\s*$/i, "").replace(/-GURUH/i, "-G").trim();
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

function StatCard({ icon, label, value, sub, accent }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub?: string; accent?: string }) {
  return (
    <Card className="p-4 flex flex-col gap-1 shadow-soft">
      <div className="flex items-center gap-2 text-muted-foreground text-xs font-medium uppercase tracking-wide">
        <span style={accent ? { color: accent } : undefined}>{icon}</span>{label}
      </div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </Card>
  );
}

function ChartCard({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Card className="p-4 shadow-soft">
      <div className="mb-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </Card>
  );
}

export default function AdminStatistics() {
  const [courses, setCourses] = useState<{ id: string; title: string; published: boolean }[]>([]);
  const [courseId, setCourseId] = useState("");
  const [windowDays, setWindowDays] = useState(7);
  const [rows, setRows] = useState<GroupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState("activePct");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("courses").select("id, title, published").order("published", { ascending: false }).order("created_at", { ascending: false });
      const cs = (data || []) as any[];
      setCourses(cs);
      if (cs.length && !courseId) setCourseId(cs[0].id);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = async () => {
    if (!courseId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc("admin_course_group_stats" as any, { _course_id: courseId, _window_days: windowDays });
      if (error) throw error;
      setRows(((data || []) as GroupRow[]));
    } catch (e) {
      console.error("[AdminStatistics] load failed", e);
      setRows([]);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [courseId, windowDays]);

  const overall = useMemo(() => {
    const t = rows.reduce((a, r) => ({
      students: a.students + r.total_students,
      active: a.active + r.active_students,
      activated: a.activated + r.activated_count,
      badges: a.badges + r.badges_earned,
      xp: a.xp + Number(r.total_xp || 0),
      hw: a.hw + r.homework_submitted,
      pending: a.pending + r.pending_homework,
      // weighted completion (by students)
      compNum: a.compNum + r.avg_completion_pct * r.total_students,
    }), { students: 0, active: 0, activated: 0, badges: 0, xp: 0, hw: 0, pending: 0, compNum: 0 });
    const avgCompletion = t.students > 0 ? Math.round(t.compNum / t.students) : 0;
    const mostActive = [...rows].sort((a, b) => pct(b.active_students, b.total_students) - pct(a.active_students, a.total_students))[0];
    return { ...t, avgCompletion, mostActive };
  }, [rows]);

  const barData = useMemo(() => rows.map((r) => ({
    name: shortName(r.group_name),
    Talabalar: r.total_students, Faol: r.active_students,
    Nishonlar: r.badges_earned, "Tugallanish %": r.avg_completion_pct,
    "O'rtacha XP": r.avg_xp,
  })), [rows]);
  const activePie = useMemo(() => [
    { name: "Faol", value: overall.active },
    { name: "Nofaol", value: Math.max(overall.students - overall.active, 0) },
  ], [overall]);

  // Ranking: sortable by any metric; default = most active first (active %). Pending sorts asc (less = better).
  const sortedRows = useMemo(() => {
    const withPct = rows.map((r) => ({ ...r, activePct: pct(r.active_students, r.total_students) }));
    const val = (r: any) => (sortKey === "activePct" ? r.activePct : Number(r[sortKey] ?? 0));
    return withPct.sort((a, b) => (sortDir === "desc" ? val(b) - val(a) : val(a) - val(b)));
  }, [rows, sortKey, sortDir]);
  const toggleSort = (k: string) => {
    if (sortKey === k) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortKey(k); setSortDir(k === "pending_homework" ? "asc" : "desc"); }
  };
  const Th = ({ k, label }: { k: string; label: string }) => (
    <th className="px-3 py-2 text-right">
      <button onClick={() => toggleSort(k)} className="inline-flex items-center gap-1 hover:text-foreground uppercase tracking-wide">
        {label}{sortKey === k && <span className="text-[10px]">{sortDir === "desc" ? "▼" : "▲"}</span>}
      </button>
    </th>
  );

  return (
    <PageShell>
      <div className="space-y-5">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">📊 Statistika</h1>
            <p className="text-muted-foreground mt-1">Kurs bo'yicha guruhlar va talabalar statistikasi</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="inline-flex rounded-md border overflow-hidden">
              {[7, 30].map((d) => (
                <button key={d} onClick={() => setWindowDays(d)}
                  className={`px-3 py-1.5 text-sm ${windowDays === d ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted"}`}>
                  {d} kun
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Yangilash
            </Button>
            <Select value={courseId} onValueChange={setCourseId}>
              <SelectTrigger className="w-[240px]"><SelectValue placeholder="Kursni tanlang" /></SelectTrigger>
              <SelectContent>
                {courses.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.title}{!c.published ? " (qoralama)" : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </div>
        ) : rows.length === 0 ? (
          <Card className="p-8 text-center text-muted-foreground">Bu kurs uchun guruh topilmadi.</Card>
        ) : (
          <>
            {/* Overall KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <StatCard icon={<UsersIcon className="h-4 w-4" />} label="Jami talabalar" value={overall.students}
                sub={`${overall.activated} faollashgan`} accent={PALETTE[1]} />
              <StatCard icon={<Activity className="h-4 w-4" />} label={`Faol (${windowDays} kun)`}
                value={overall.active} sub={`${pct(overall.active, overall.students)}% faol`} accent={PALETTE[2]} />
              <StatCard icon={<Trophy className="h-4 w-4" />} label="Yig'ilgan nishonlar" value={overall.badges} accent={PALETTE[3]} />
              <StatCard icon={<TrendingUp className="h-4 w-4" />} label="O'rtacha tugallanish" value={`${overall.avgCompletion}%`} accent={PALETTE[0]} />
              <StatCard icon={<Zap className="h-4 w-4" />} label="Jami XP" value={overall.xp.toLocaleString()} accent={PALETTE[4]} />
              <StatCard icon={<Crown className="h-4 w-4" />} label="Eng faol guruh"
                value={<span className="text-base">{overall.mostActive ? shortName(overall.mostActive.group_name) : "—"}</span>}
                sub={overall.mostActive ? `${pct(overall.mostActive.active_students, overall.mostActive.total_students)}% faol` : undefined} accent={PALETTE[5]} />
            </div>

            {/* Infographics */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <ChartCard title="Talabalar va faollik" hint="Guruh bo'yicha jami va faol talabalar">
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={barData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip contentStyle={TT} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="Talabalar" fill={PALETTE[1]} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="Faol" fill={PALETTE[2]} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title="Faol va nofaol" hint={`Butun kurs bo'yicha (${windowDays} kun)`}>
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie data={activePie} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2}
                      label={(e) => `${e.name}: ${e.value}`}>
                      <Cell fill={PALETTE[2]} />
                      <Cell fill="hsl(var(--muted))" />
                    </Pie>
                    <Tooltip contentStyle={TT} />
                  </PieChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title="Yig'ilgan nishonlar" hint="Guruh bo'yicha jami nishonlar">
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={barData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip contentStyle={TT} />
                    <Bar dataKey="Nishonlar" radius={[4, 4, 0, 0]}>
                      {barData.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard title="O'rtacha tugallanish %" hint="Tarifga moslangan (ochiq modullar bo'yicha)">
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={barData} layout="vertical" margin={{ left: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11 }} unit="%" />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={70} />
                    <Tooltip contentStyle={TT} />
                    <Bar dataKey="Tugallanish %" radius={[0, 4, 4, 0]}>
                      {barData.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>

            {/* Per-group detail table */}
            <Card className="p-0 overflow-hidden shadow-soft">
              <div className="px-4 py-3 border-b bg-muted/30 flex items-center justify-between gap-2 flex-wrap">
                <h3 className="text-sm font-semibold">Guruhlar reytingi</h3>
                <span className="text-xs text-muted-foreground">Ustundan bosib tartiblang · standart: eng faol birinchi</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 w-8 text-center">#</th>
                      <th className="px-3 py-2">Guruh</th><th className="px-3 py-2">Tarif</th><th className="px-3 py-2">Ustoz</th>
                      <Th k="total_students" label="Talaba" /><Th k="activePct" label="Faol" />
                      <Th k="badges_earned" label="Nishon" /><Th k="avg_completion_pct" label="Tugallanish" />
                      <Th k="total_xp" label="Jami XP" /><Th k="homework_submitted" label="Vazifa" />
                      <Th k="homework_avg_score" label="O'rt. baho" /><Th k="pending_homework" label="Kutilmoqda" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((r, i) => (
                      <tr key={r.group_id} className="border-t hover:bg-muted/20">
                        <td className="px-3 py-2 text-center">{i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : <span className="text-muted-foreground">{i + 1}</span>}</td>
                        <td className="px-3 py-2 font-medium">{r.group_name}</td>
                        <td className="px-3 py-2">{r.tier_name || "—"}</td>
                        <td className="px-3 py-2">{r.teacher_name}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.total_students}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.active_students} <span className="text-muted-foreground text-xs">({r.activePct}%)</span></td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.badges_earned}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.avg_completion_pct}%</td>
                        <td className="px-3 py-2 text-right tabular-nums">{Number(r.total_xp).toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.homework_submitted}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.homework_avg_score != null ? Number(r.homework_avg_score).toFixed(1) : "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.pending_homework > 0 ? <span className="text-amber-600 dark:text-amber-400">{r.pending_homework}</span> : 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </div>
    </PageShell>
  );
}
