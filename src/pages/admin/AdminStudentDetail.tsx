import { useEffect, useMemo, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Copy, ExternalLink, BookOpen, ClipboardCheck, MessageSquare, Clock, Flame, Trophy } from "lucide-react";
import { toast } from "sonner";

type Profile = {
  id: string;
  name: string | null;
  last_name: string | null;
  email: string;
  avatar_url: string | null;
  status: string;
  preferred_language: string | null;
  telegram_id: number | null;
  telegram_username: string | null;
  telegram_onboarded_at: string | null;
  group_id: string | null;
  archived_at: string | null;
  created_at: string;
  groups?: { id: string; name: string; course_id?: string | null } | null;
};

function fmtDate(s?: string | null) {
  if (!s) return "—";
  try { return new Date(s).toLocaleString(); } catch { return s; }
}
function fmtMin(sec: number) {
  const m = Math.round((sec || 0) / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function fmtAgo(s?: string | null) {
  if (!s) return "—";
  const then = new Date(s).getTime();
  if (!Number.isFinite(then)) return "—";
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "hozirgina";
  if (min < 60) return `${min} daqiqa oldin`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} soat oldin`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} kun oldin`;
  const mo = Math.floor(d / 30);
  return `${mo} oy oldin`;
}

export default function AdminStudentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [role, setRole] = useState<string>("student");
  const [loading, setLoading] = useState(true);
  // Course scoping: which course this student's stats are shown for, plus the id-sets used to
  // filter every per-lesson / per-assignment read so the page is per-course (not cross-course).
  const [courseId, setCourseId] = useState<string | null>(null);
  const [courseOptions, setCourseOptions] = useState<{ id: string; title: string }[]>([]);
  const [lessonIds, setLessonIds] = useState<string[] | null>(null);
  const [assignmentIds, setAssignmentIds] = useState<string[] | null>(null);

  useEffect(() => {
    if (!id) return;
    (async () => {
      setLoading(true);
      const [{ data: p }, { data: r }, { data: enr }, { data: allCourses }] = await Promise.all([
        supabase.from("profiles").select("*, groups:group_id(id,name,course_id)").eq("id", id).maybeSingle(),
        supabase.from("user_roles").select("role").eq("user_id", id),
        supabase.from("enrollments").select("course_id").eq("user_id", id),
        supabase.from("courses").select("id,title"),
      ]);
      setProfile(p as any);
      const rank: Record<string, number> = { superadmin: 1, admin: 2, teacher: 3, student: 4 };
      const top = (r || []).map((x: any) => x.role).sort((a, b) => (rank[a] || 99) - (rank[b] || 99))[0];
      setRole(top || "student");
      // Resolve the student's course: their group's course first, else their enrollment(s).
      const titleById = new Map<string, string>(((allCourses as any[]) || []).map((c: any) => [c.id, c.title]));
      const groupCourse = ((p as any)?.groups?.course_id as string | null) || null;
      const enrolledIds = ((enr as any[]) || []).map((e: any) => e.course_id).filter(Boolean);
      const optIds = Array.from(new Set([groupCourse, ...enrolledIds].filter(Boolean))) as string[];
      setCourseOptions(optIds.map((cid) => ({ id: cid, title: titleById.get(cid) || "Course" })));
      setCourseId(groupCourse || enrolledIds[0] || null);
      setLoading(false);
    })();
  }, [id]);

  // Build the course's lesson + assignment id-sets whenever the active course changes.
  // NULL = unscoped (current behavior) when the student has no resolvable course.
  useEffect(() => {
    if (!courseId) { setLessonIds(null); setAssignmentIds(null); return; }
    (async () => {
      const { data: mods } = await supabase.from("modules").select("id").eq("course_id", courseId);
      const moduleIds = ((mods as any[]) || []).map((m: any) => m.id);
      if (!moduleIds.length) { setLessonIds([]); setAssignmentIds([]); return; }
      const [{ data: les }, { data: asg }] = await Promise.all([
        supabase.from("lessons").select("id").in("module_id", moduleIds),
        supabase.from("homework_assignments").select("id").in("module_id", moduleIds),
      ]);
      setLessonIds(((les as any[]) || []).map((l: any) => l.id));
      setAssignmentIds(((asg as any[]) || []).map((a: any) => a.id));
    })();
  }, [courseId]);

  const fullName = useMemo(
    () => [profile?.name, profile?.last_name].filter(Boolean).join(" ") || profile?.email || "—",
    [profile],
  );

  if (loading) {
    return <PageShell><div className="text-sm text-muted-foreground">Yuklanmoqda…</div></PageShell>;
  }
  if (!profile) {
    return (
      <PageShell>
        <div className="space-y-3">
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="gap-1">
            <ArrowLeft className="h-4 w-4" /> Orqaga
          </Button>
          <div className="text-sm text-muted-foreground">Talaba topilmadi.</div>
        </div>
      </PageShell>
    );
  }

  const copy = (s: string) => { navigator.clipboard.writeText(s); toast.success("Nusxalandi"); };

  return (
    <PageShell>
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="gap-1">
          <ArrowLeft className="h-4 w-4" /> Orqaga
        </Button>

        <Card className="p-5 shadow-soft">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-4">
              <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center text-lg font-semibold overflow-hidden">
                {profile.avatar_url ? <img src={profile.avatar_url} alt="" className="h-full w-full object-cover" /> : (fullName[0] || "?").toUpperCase()}
              </div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">{fullName}</h1>
                <div className="text-sm text-muted-foreground flex items-center gap-2 mt-1">
                  <span>{profile.email}</span>
                  <button onClick={() => copy(profile.email)} className="hover:text-foreground"><Copy className="h-3 w-3" /></button>
                </div>
                <div className="flex flex-wrap gap-2 mt-2">
                  <Badge variant="outline">{role}</Badge>
                  {profile.groups?.name && (
                    <Link to={`/admin/groups/${profile.groups.id}`}>
                      <Badge variant="secondary" className="hover:bg-secondary/80">Guruh: {profile.groups.name}</Badge>
                    </Link>
                  )}
                  {profile.telegram_id ? (
                    <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700 border-emerald-500/30">TG ulangan</Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">Telegram yo'q</Badge>
                  )}
                  {profile.status === "archived" && <Badge variant="destructive">Arxivlangan</Badge>}
                </div>
              </div>
            </div>
            <div className="text-xs text-muted-foreground space-y-0.5 text-right">
              <div>Qo'shilgan: {fmtDate(profile.created_at)}</div>
              {profile.telegram_username && <div>@{profile.telegram_username}</div>}
              {profile.telegram_id && <div>TG ID: {profile.telegram_id}</div>}
            </div>
          </div>
        </Card>

        {courseOptions.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Kurs:</span>
            <select
              className="h-8 rounded-md border bg-background px-2 text-sm"
              value={courseId || ""}
              onChange={(e) => setCourseId(e.target.value || null)}
            >
              {courseOptions.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          </div>
        )}

        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">📊 Umumiy</TabsTrigger>
            <TabsTrigger value="lessons">Darslar</TabsTrigger>
            <TabsTrigger value="homework">Vazifalar</TabsTrigger>
            <TabsTrigger value="telegram">Telegram</TabsTrigger>
            <TabsTrigger value="engagement">Faollik</TabsTrigger>
            <TabsTrigger value="profile">Profil</TabsTrigger>
          </TabsList>

          <TabsContent value="overview"><OverviewTab profile={profile} lessonIds={lessonIds} assignmentIds={assignmentIds} /></TabsContent>
          <TabsContent value="lessons"><LessonsTab userId={profile.id} lessonIds={lessonIds} /></TabsContent>
          <TabsContent value="homework"><HomeworkTab userId={profile.id} assignmentIds={assignmentIds} /></TabsContent>
          <TabsContent value="telegram"><TelegramTab profile={profile} /></TabsContent>
          <TabsContent value="engagement"><EngagementTab userId={profile.id} /></TabsContent>
          <TabsContent value="profile"><ProfileTab profile={profile} role={role} /></TabsContent>
        </Tabs>
      </div>
    </PageShell>
  );
}

/* ───────── Overview ───────── */
type Activity = { ts: string; kind: "homework" | "lesson" | "group" | "login"; label: string };

function OverviewTab({ profile, lessonIds, assignmentIds }: { profile: Profile; lessonIds: string[] | null; assignmentIds: string[] | null }) {
  const userId = profile.id;
  const tgId = profile.telegram_id;
  const [kpi, setKpi] = useState({
    lessonsCompleted: 0,
    watchSec: 0,
    hwSubmitted: 0,
    hwGraded: 0,
    groupMsgs: 0,
    lastGroupMsg: null as string | null,
    currentStreak: 0,
    rank: null as number | null,
    lastActive: null as string | null,
  });
  const [timeline, setTimeline] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [
        { data: lp },
        { data: subs },
        groupCountRes,
        { data: groupRecent },
        { data: logins },
        { data: streak },
        { data: lb },
        { data: assigns },
      ] = await Promise.all([
        (() => {
          let q = supabase.from("lesson_progress")
            .select("watch_seconds_total, completed_at, updated_at, lesson_id, lessons:lesson_id(title)")
            .eq("user_id", userId);
          if (lessonIds) q = q.in("lesson_id", lessonIds);
          return q.order("updated_at", { ascending: false }).limit(300);
        })(),
        (() => {
          let q = supabase.from("homework_submissions")
            .select("assignment_id, score, submitted_at")
            .eq("user_id", userId);
          if (assignmentIds) q = q.in("assignment_id", assignmentIds);
          return q.order("submitted_at", { ascending: false }).limit(300);
        })(),
        tgId
          ? supabase.from("group_message_events").select("id", { count: "exact", head: true }).eq("telegram_user_id", tgId)
          : Promise.resolve({ count: 0 } as any),
        tgId
          ? supabase.from("group_message_events").select("created_at").eq("telegram_user_id", tgId).order("created_at", { ascending: false }).limit(20)
          : Promise.resolve({ data: [] } as any),
        supabase.from("auth_events").select("event, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(15),
        supabase.from("streaks").select("current_streak, longest_streak").eq("user_id", userId).maybeSingle(),
        supabase.from("leaderboard_cache").select("rank, score").eq("user_id", userId).maybeSingle(),
        (() => {
          let q = supabase.from("homework_assignments").select("id, title, task_number");
          if (assignmentIds) q = q.in("id", assignmentIds);
          return q.limit(500);
        })(),
      ]);

      const lpRows = (lp || []) as any[];
      const subRows = (subs || []) as any[];
      const lessonsCompleted = lpRows.filter((x) => x.completed_at).length;
      const watchSec = lpRows.reduce((s, x) => s + Number(x.watch_seconds_total || 0), 0);
      const hwSubmitted = subRows.length;
      const hwGraded = subRows.filter((s) => s.score != null).length;
      const groupMsgs = (groupCountRes as any)?.count || 0;
      const lastGroupMsg = (groupRecent || [])[0]?.created_at || null;
      const titleById = new Map<string, string>();
      (assigns || []).forEach((a: any) => titleById.set(a.id, `#${a.task_number} ${a.title || ""}`.trim()));

      // Build unified activity timeline.
      const acts: Activity[] = [];
      subRows.slice(0, 25).forEach((s) => {
        if (s.submitted_at) acts.push({ ts: s.submitted_at, kind: "homework", label: `Vazifa topshirdi: ${titleById.get(s.assignment_id) || ""}`.trim() });
      });
      lpRows.filter((x) => x.completed_at).slice(0, 25).forEach((x) => {
        acts.push({ ts: x.completed_at, kind: "lesson", label: `Darsni tugatdi: ${x.lessons?.title || x.lesson_id}` });
      });
      (groupRecent || []).slice(0, 20).forEach((g: any) => {
        acts.push({ ts: g.created_at, kind: "group", label: "Telegram guruhga yozdi" });
      });
      (logins || []).slice(0, 15).forEach((l: any) => {
        acts.push({ ts: l.created_at, kind: "login", label: `Tizimga kirdi (${l.event})` });
      });
      acts.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

      const lastActive = acts[0]?.ts || null;

      setKpi({
        lessonsCompleted,
        watchSec,
        hwSubmitted,
        hwGraded,
        groupMsgs,
        lastGroupMsg,
        currentStreak: streak?.current_streak ?? 0,
        rank: lb?.rank ?? null,
        lastActive,
      });
      setTimeline(acts.slice(0, 30));
      setLoading(false);
    })();
  }, [userId, tgId, lessonIds, assignmentIds]);

  const kindMeta: Record<Activity["kind"], { icon: any; cls: string }> = {
    homework: { icon: ClipboardCheck, cls: "text-emerald-600" },
    lesson: { icon: BookOpen, cls: "text-blue-600" },
    group: { icon: MessageSquare, cls: "text-violet-600" },
    login: { icon: Clock, cls: "text-muted-foreground" },
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard icon={<BookOpen className="h-4 w-4" />} label="Darslar tugatildi" value={kpi.lessonsCompleted} sub={fmtMin(kpi.watchSec)} />
        <KpiCard icon={<ClipboardCheck className="h-4 w-4" />} label="Vazifa topshirdi" value={kpi.hwSubmitted} sub={`${kpi.hwGraded} baholangan`} />
        <KpiCard icon={<MessageSquare className="h-4 w-4" />} label="Guruh xabarlari" value={kpi.groupMsgs} sub={kpi.lastGroupMsg ? `oxirgi: ${fmtAgo(kpi.lastGroupMsg)}` : "yozmagan"} />
        <KpiCard icon={<Flame className="h-4 w-4" />} label="Streak" value={`${kpi.currentStreak}d`} sub="umumiy (barcha kurslar)" />
        <KpiCard icon={<Trophy className="h-4 w-4" />} label="Reyting" value={kpi.rank ? `#${kpi.rank}` : "—"} sub="umumiy reyting" />
        <KpiCard icon={<Clock className="h-4 w-4" />} label="Oxirgi faollik" value={fmtAgo(kpi.lastActive)} sub={kpi.lastActive ? fmtDate(kpi.lastActive) : undefined} />
      </div>

      <Card className="overflow-hidden shadow-soft">
        <div className="p-4 border-b">
          <h3 className="font-semibold text-sm">So'nggi faolliklar</h3>
          <p className="text-xs text-muted-foreground">Darslar, vazifalar, Telegram guruh xabarlari va kirishlar</p>
        </div>
        <div className="divide-y">
          {loading && <div className="p-6 text-center text-sm text-muted-foreground">Yuklanmoqda…</div>}
          {!loading && timeline.length === 0 && <div className="p-6 text-center text-sm text-muted-foreground">Hali faollik yo'q.</div>}
          {timeline.map((a, i) => {
            const M = kindMeta[a.kind];
            const Icon = M.icon;
            return (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                <Icon className={`h-4 w-4 shrink-0 ${M.cls}`} />
                <span className="text-sm flex-1 min-w-0 truncate">{a.label}</span>
                <span className="text-xs text-muted-foreground whitespace-nowrap" title={fmtDate(a.ts)}>{fmtAgo(a.ts)}</span>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

function KpiCard({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: any; sub?: string }) {
  return (
    <Card className="p-4 shadow-soft">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">{icon}<span>{label}</span></div>
      <div className="text-2xl font-semibold tracking-tight mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
    </Card>
  );
}

/* ───────── Lessons ───────── */
function LessonsTab({ userId, lessonIds }: { userId: string; lessonIds: string[] | null }) {
  const [rows, setRows] = useState<any[]>([]);
  const [kpi, setKpi] = useState({ completed: 0, watchSec: 0, last7Sec: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      let pq = supabase
        .from("lesson_progress")
        .select("lesson_id, watch_seconds_total, max_position_seconds, last_position_seconds, completed_at, updated_at, lessons:lesson_id(id, title, position, duration_seconds, module_id, modules:module_id(id, title, position))")
        .eq("user_id", userId);
      if (lessonIds) pq = pq.in("lesson_id", lessonIds);
      const { data: progress } = await pq.order("updated_at", { ascending: false });
      const r = (progress || []) as any[];
      r.sort((a, b) => {
        const am = a.lessons?.modules?.position ?? 0, bm = b.lessons?.modules?.position ?? 0;
        if (am !== bm) return am - bm;
        return (a.lessons?.position ?? 0) - (b.lessons?.position ?? 0);
      });
      setRows(r);
      const completed = r.filter((x) => x.completed_at).length;
      const watchSec = r.reduce((s, x) => s + Number(x.watch_seconds_total || 0), 0);
      const cutoff = Date.now() - 7 * 86400_000;
      const { data: dws } = await supabase
        .from("daily_watch_summary")
        .select("total_seconds, watch_date")
        .eq("user_id", userId)
        .gte("watch_date", new Date(cutoff).toISOString().slice(0, 10));
      const last7Sec = (dws || []).reduce((s: number, x: any) => s + Number(x.total_seconds || 0), 0);
      setKpi({ completed, watchSec, last7Sec });
      setLoading(false);
    })();
  }, [userId, lessonIds]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Stat label="Tugatilgan darslar" value={kpi.completed} />
        <Stat label="Umumiy ko'rish vaqti" value={fmtMin(kpi.watchSec)} />
        <Stat label="So'nggi 7 kun" value={fmtMin(kpi.last7Sec)} />
      </div>
      <Card className="overflow-hidden shadow-soft">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs">
            <tr>
              <th className="text-left p-3">Modul</th>
              <th className="text-left p-3">Dars</th>
              <th className="text-left p-3">Progress</th>
              <th className="text-left p-3">Ko'rish vaqti</th>
              <th className="text-left p-3">Tugatilgan</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={5} className="p-4 text-center text-muted-foreground">Yuklanmoqda…</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={5} className="p-4 text-center text-muted-foreground">Hali dars faolligi yo'q.</td></tr>}
            {rows.map((r) => {
              const dur = Number(r.lessons?.duration_seconds || 0);
              const max = Number(r.max_position_seconds || 0);
              const pct = dur > 0 ? Math.min(100, Math.round((max / dur) * 100)) : 0;
              return (
                <tr key={r.lesson_id} className="border-t">
                  <td className="p-3 text-muted-foreground text-xs">{r.lessons?.modules?.title || "—"}</td>
                  <td className="p-3 font-medium">{r.lessons?.title || r.lesson_id}</td>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-24 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs tabular-nums">{pct}%</span>
                    </div>
                  </td>
                  <td className="p-3 text-xs tabular-nums">{fmtMin(Number(r.watch_seconds_total || 0))}</td>
                  <td className="p-3 text-xs text-muted-foreground">{r.completed_at ? fmtDate(r.completed_at) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/* ───────── Homework ───────── */
function HomeworkTab({ userId, assignmentIds }: { userId: string; assignmentIds: string[] | null }) {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [{ data: assigns }, { data: subs }] = await Promise.all([
        (() => {
          let q = supabase.from("homework_assignments").select("id, title, task_number, max_score, module_id, modules:module_id(title, position)").eq("is_active", true);
          if (assignmentIds) q = q.in("id", assignmentIds);
          return q;
        })(),
        (() => {
          let q = supabase.from("homework_submissions").select("*").eq("user_id", userId);
          if (assignmentIds) q = q.in("assignment_id", assignmentIds);
          return q.order("submitted_at", { ascending: false });
        })(),
      ]);
      const subsByAssign = new Map<string, any>();
      (subs || []).forEach((s: any) => { if (!subsByAssign.has(s.assignment_id)) subsByAssign.set(s.assignment_id, s); });
      const merged = (assigns || []).map((a: any) => ({ a, s: subsByAssign.get(a.id) || null }));
      merged.sort((x, y) => {
        const xm = x.a.modules?.position ?? 0, ym = y.a.modules?.position ?? 0;
        if (xm !== ym) return xm - ym;
        return (x.a.task_number || 0) - (y.a.task_number || 0);
      });
      setRows(merged);
      setLoading(false);
    })();
  }, [userId, assignmentIds]);

  return (
    <Card className="overflow-hidden shadow-soft">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs">
          <tr>
            <th className="text-left p-3">Modul</th>
            <th className="text-left p-3">Vazifa</th>
            <th className="text-left p-3">Holat</th>
            <th className="text-left p-3">Ball</th>
            <th className="text-left p-3">Urinishlar</th>
            <th className="text-left p-3">Manba</th>
            <th className="text-left p-3">Topshirilgan</th>
            <th className="text-left p-3"></th>
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={8} className="p-4 text-center text-muted-foreground">Yuklanmoqda…</td></tr>}
          {!loading && rows.length === 0 && <tr><td colSpan={8} className="p-4 text-center text-muted-foreground">Vazifalar yo'q.</td></tr>}
          {rows.map(({ a, s }) => {
            const attempts = (s?.previous_attempts?.length || 0) + (s ? 1 : 0);
            const status = !s ? "topshirilmagan" : s.score != null ? "baholangan" : s.is_late ? "kechikkan" : "topshirilgan";
            return (
              <tr key={a.id} className="border-t">
                <td className="p-3 text-xs text-muted-foreground">{a.modules?.title || "—"}</td>
                <td className="p-3 font-medium">#{a.task_number} {a.title}</td>
                <td className="p-3">
                  <Badge variant={s?.score != null ? "default" : !s ? "outline" : "secondary"}>{status}</Badge>
                  {s?.is_late && <Badge variant="destructive" className="ml-1">kechikkan</Badge>}
                </td>
                <td className="p-3 tabular-nums">{s?.score != null ? `${s.score}/${a.max_score}` : "—"}</td>
                <td className="p-3 tabular-nums">{attempts || "—"}</td>
                <td className="p-3 text-xs text-muted-foreground">{s?.source || "—"}</td>
                <td className="p-3 text-xs text-muted-foreground">{fmtDate(s?.submitted_at)}</td>
                <td className="p-3">
                  {s?.telegram_message_url && (
                    <a href={s.telegram_message_url} target="_blank" rel="noreferrer" className="text-primary inline-flex items-center gap-1 text-xs">
                      Ochish <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

/* ───────── Telegram ───────── */
function TelegramTab({ profile }: { profile: Profile }) {
  const [dms, setDms] = useState<any[]>([]);
  const [intents, setIntents] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [groupCount, setGroupCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [{ data: q }, { data: i }, { data: e }, cnt] = await Promise.all([
        supabase.from("homework_teacher_dm_queue").select("*").eq("student_id", profile.id).order("created_at", { ascending: false }).limit(50),
        supabase.from("bot_homework_intents").select("*").eq("user_id", profile.id).order("created_at", { ascending: false }).limit(20),
        profile.telegram_id
          ? supabase.from("group_message_events").select("*").eq("telegram_user_id", profile.telegram_id).order("created_at", { ascending: false }).limit(30)
          : Promise.resolve({ data: [] } as any),
        profile.telegram_id
          ? supabase.from("group_message_events").select("id", { count: "exact", head: true }).eq("telegram_user_id", profile.telegram_id)
          : Promise.resolve({ count: 0 } as any),
      ]);
      setDms(q || []); setIntents(i || []); setEvents(e || []);
      setGroupCount((cnt as any)?.count || 0);
      setLoading(false);
    })();
  }, [profile.id, profile.telegram_id]);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h3 className="font-semibold mb-2">Ulanish holati</h3>
        <div className="text-sm grid grid-cols-2 md:grid-cols-4 gap-3">
          <div><div className="text-xs text-muted-foreground">Telegram ID</div><div className="tabular-nums">{profile.telegram_id || "—"}</div></div>
          <div><div className="text-xs text-muted-foreground">Username</div><div>{profile.telegram_username ? `@${profile.telegram_username}` : "—"}</div></div>
          <div><div className="text-xs text-muted-foreground">Onboarded</div><div>{fmtDate(profile.telegram_onboarded_at)}</div></div>
          <div><div className="text-xs text-muted-foreground">Guruh xabarlari</div><div className="tabular-nums">{groupCount}{events[0] ? ` · oxirgi ${fmtAgo(events[0].created_at)}` : ""}</div></div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="p-3 font-semibold text-sm">O'qituvchi DM navbati (bu talaba topshiriqlari haqida bildirishnomalar)</div>
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs">
            <tr><th className="text-left p-3">Qachon</th><th className="text-left p-3">Modul/Vazifa</th><th className="text-left p-3">Holat</th><th className="text-left p-3">Xato</th></tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={4} className="p-4 text-center text-muted-foreground">Yuklanmoqda…</td></tr>}
            {!loading && dms.length === 0 && <tr><td colSpan={4} className="p-4 text-center text-muted-foreground">O'qituvchi DM lari yo'q.</td></tr>}
            {dms.map((d) => (
              <tr key={d.id} className="border-t">
                <td className="p-3 text-xs text-muted-foreground">{fmtDate(d.created_at)}</td>
                <td className="p-3">M{d.module_number} #{d.task_number} — {d.assignment_title || "—"}</td>
                <td className="p-3">
                  {d.sent_at ? <Badge variant="default">yuborildi</Badge> :
                    d.queued_for_quiet_hours ? <Badge variant="secondary">navbatda (tinch soat)</Badge> :
                    <Badge variant="outline">kutilmoqda</Badge>}
                </td>
                <td className="p-3 text-xs text-destructive">{d.error || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="overflow-hidden">
        <div className="p-3 font-semibold text-sm">So'nggi guruh xabarlari (ushbu Telegram akkauntdan)</div>
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs">
            <tr><th className="text-left p-3">Qachon</th><th className="text-left p-3">Chat/Thread</th><th className="text-left p-3">Xabar ID</th></tr>
          </thead>
          <tbody>
            {!loading && events.length === 0 && <tr><td colSpan={3} className="p-4 text-center text-muted-foreground">Xabarlar yo'q.</td></tr>}
            {events.map((e) => (
              <tr key={e.id} className="border-t">
                <td className="p-3 text-xs text-muted-foreground">{fmtDate(e.created_at)}</td>
                <td className="p-3 text-xs tabular-nums">{e.telegram_chat_id} / {e.telegram_thread_id ?? "—"}</td>
                <td className="p-3 text-xs tabular-nums">{e.telegram_message_id}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="overflow-hidden">
        <div className="p-3 font-semibold text-sm">So'nggi topshirish niyatlari (intents)</div>
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs">
            <tr><th className="text-left p-3">Qachon</th><th className="text-left p-3">Modul</th><th className="text-left p-3">Topic/Chat</th><th className="text-left p-3">Tugaydi</th></tr>
          </thead>
          <tbody>
            {!loading && intents.length === 0 && <tr><td colSpan={4} className="p-4 text-center text-muted-foreground">Intent yo'q.</td></tr>}
            {intents.map((i) => (
              <tr key={i.id} className="border-t">
                <td className="p-3 text-xs text-muted-foreground">{fmtDate(i.created_at)}</td>
                <td className="p-3 text-xs">{i.module_id?.slice(0, 8)}…</td>
                <td className="p-3 text-xs tabular-nums">{i.telegram_chat_id} / {i.telegram_thread_id}</td>
                <td className="p-3 text-xs text-muted-foreground">{fmtDate(i.expires_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/* ───────── Engagement ───────── */
function EngagementTab({ userId }: { userId: string }) {
  const [streak, setStreak] = useState<any>(null);
  const [leaderboard, setLeaderboard] = useState<any>(null);
  const [logins, setLogins] = useState<any[]>([]);
  const [nudges, setNudges] = useState<any[]>([]);
  const [badges, setBadges] = useState<any[]>([]);
  const [heatmap, setHeatmap] = useState<{ date: string; sec: number }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
      const since90 = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
      const [{ data: s }, { data: lb }, { data: ae }, { data: nl }, { data: ub }, { data: dws }] = await Promise.all([
        supabase.from("streaks").select("*").eq("user_id", userId).maybeSingle(),
        supabase.from("leaderboard_cache").select("*").eq("user_id", userId).maybeSingle(),
        supabase.from("auth_events").select("event, created_at, ip").eq("user_id", userId).gte("created_at", since30).order("created_at", { ascending: false }).limit(50),
        supabase.from("nudge_log").select("*").eq("profile_id", userId).order("sent_at", { ascending: false }).limit(30),
        supabase.from("user_badges").select("earned_at, badges!inner(code, name_en, icon)").eq("user_id", userId).order("earned_at", { ascending: false }),
        supabase.from("daily_watch_summary").select("watch_date, total_seconds").eq("user_id", userId).gte("watch_date", since90),
      ]);
      setStreak(s); setLeaderboard(lb); setLogins(ae || []); setNudges(nl || []); setBadges(ub || []);
      setHeatmap((dws || []).map((x: any) => ({ date: x.watch_date, sec: Number(x.total_seconds || 0) })));
      setLoading(false);
    })();
  }, [userId]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Joriy streak" value={`${streak?.current_streak ?? 0}d`} />
        <Stat label="Eng uzun streak" value={`${streak?.longest_streak ?? 0}d`} />
        <Stat label="Reyting o'rni" value={leaderboard?.rank ? `#${leaderboard.rank}` : "—"} />
        <Stat label="Nishonlar" value={badges.length} />
      </div>

      <Card className="p-4">
        <div className="font-semibold text-sm mb-2">Ko'rish issiqligi (90 kun)</div>
        <div className="grid grid-cols-[repeat(90,minmax(0,1fr))] gap-0.5">
          {Array.from({ length: 90 }).map((_, i) => {
            // watch_date is Asia/Tashkent — build the cell date in Tashkent so early-morning
            // watches land in the correct day cell (was UTC, off by one for 00:00–05:00 TST).
            const date = (() => {
              const b = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent" }).format(new Date());
              const d = new Date(b + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - (89 - i));
              return d.toISOString().slice(0, 10);
            })();
            const sec = heatmap.find((h) => h.date === date)?.sec || 0;
            const lvl = sec === 0 ? 0 : sec < 600 ? 1 : sec < 1800 ? 2 : sec < 3600 ? 3 : 4;
            const cls = ["bg-muted", "bg-primary/20", "bg-primary/40", "bg-primary/70", "bg-primary"][lvl];
            return <div key={i} title={`${date}: ${fmtMin(sec)}`} className={`h-3 rounded-sm ${cls}`} />;
          })}
        </div>
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        <Card className="overflow-hidden">
          <div className="p-3 font-semibold text-sm">So'nggi kirishlar (30 kun)</div>
          <table className="w-full text-sm">
            <tbody>
              {loading && <tr><td className="p-4 text-center text-muted-foreground">Yuklanmoqda…</td></tr>}
              {!loading && logins.length === 0 && <tr><td className="p-4 text-center text-muted-foreground">Kirishlar yo'q.</td></tr>}
              {logins.map((l, i) => (
                <tr key={i} className="border-t">
                  <td className="p-2 text-xs text-muted-foreground">{fmtDate(l.created_at)}</td>
                  <td className="p-2 text-xs">{l.event}</td>
                  <td className="p-2 text-xs text-muted-foreground">{l.ip || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card className="overflow-hidden">
          <div className="p-3 font-semibold text-sm">Yuborilgan eslatmalar</div>
          <table className="w-full text-sm">
            <tbody>
              {!loading && nudges.length === 0 && <tr><td className="p-4 text-center text-muted-foreground">Eslatmalar yo'q.</td></tr>}
              {nudges.map((n) => (
                <tr key={n.id} className="border-t">
                  <td className="p-2 text-xs text-muted-foreground">{fmtDate(n.sent_at)}</td>
                  <td className="p-2 text-xs">{n.nudge_type}</td>
                  <td className="p-2 text-xs">{n.clicked_at ? <Badge variant="default">bosilgan</Badge> : n.error ? <Badge variant="destructive">xato</Badge> : <Badge variant="outline">yuborilgan</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      {badges.length > 0 && (
        <Card className="p-4">
          <div className="font-semibold text-sm mb-3">Nishonlar</div>
          <div className="flex flex-wrap gap-2">
            {badges.map((b: any, i: number) => (
              <Badge key={i} variant="secondary" className="gap-1">
                {b.badges?.icon} {b.badges?.name_en || b.badges?.code}
              </Badge>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

/* ───────── Profile ───────── */
function ProfileTab({ profile, role }: { profile: Profile; role: string }) {
  const rows: [string, any][] = [
    ["Ism", [profile.name, profile.last_name].filter(Boolean).join(" ") || "—"],
    ["Email", profile.email],
    ["Rol", role],
    ["Holat", profile.status],
    ["Guruh", profile.groups?.name || "—"],
    ["Til", profile.preferred_language || "—"],
    ["Telegram ID", profile.telegram_id || "—"],
    ["Telegram username", profile.telegram_username ? `@${profile.telegram_username}` : "—"],
    ["TG onboarded", fmtDate(profile.telegram_onboarded_at)],
    ["Arxivlangan", fmtDate(profile.archived_at)],
    ["Qo'shilgan", fmtDate(profile.created_at)],
  ];
  return (
    <Card className="overflow-hidden shadow-soft">
      <table className="w-full text-sm">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-t">
              <td className="p-3 text-muted-foreground text-xs w-48">{k}</td>
              <td className="p-3">{String(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="p-3 text-xs text-muted-foreground border-t">
        Tahrirlash uchun <Link to="/admin/users" className="text-primary underline">Foydalanuvchilar</Link> sahifasidan foydalaning.
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: any }) {
  return (
    <Card className="p-4 shadow-soft">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tracking-tight mt-1 tabular-nums">{value}</div>
    </Card>
  );
}
