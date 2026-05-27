import { useEffect, useMemo, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Copy, ExternalLink } from "lucide-react";
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
  groups?: { id: string; name: string } | null;
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

export default function AdminStudentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [role, setRole] = useState<string>("student");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    (async () => {
      setLoading(true);
      const [{ data: p }, { data: r }] = await Promise.all([
        supabase.from("profiles").select("*, groups:group_id(id,name)").eq("id", id).maybeSingle(),
        supabase.from("user_roles").select("role").eq("user_id", id),
      ]);
      setProfile(p as any);
      const rank: Record<string, number> = { superadmin: 1, admin: 2, teacher: 3, student: 4 };
      const top = (r || []).map((x: any) => x.role).sort((a, b) => (rank[a] || 99) - (rank[b] || 99))[0];
      setRole(top || "student");
      setLoading(false);
    })();
  }, [id]);

  const fullName = useMemo(
    () => [profile?.name, profile?.last_name].filter(Boolean).join(" ") || profile?.email || "—",
    [profile],
  );

  if (loading) {
    return <PageShell><div className="text-sm text-muted-foreground">Loading…</div></PageShell>;
  }
  if (!profile) {
    return <PageShell><div className="text-sm text-muted-foreground">Student not found.</div></PageShell>;
  }

  const copy = (s: string) => { navigator.clipboard.writeText(s); toast.success("Copied"); };

  return (
    <PageShell>
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="gap-1">
          <ArrowLeft className="h-4 w-4" /> Back
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
                      <Badge variant="secondary" className="hover:bg-secondary/80">Group: {profile.groups.name}</Badge>
                    </Link>
                  )}
                  {profile.telegram_id ? (
                    <Badge variant="outline" className="bg-emerald-500/10 text-emerald-700 border-emerald-500/30">TG linked</Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">No Telegram</Badge>
                  )}
                  {profile.status === "archived" && <Badge variant="destructive">Archived</Badge>}
                </div>
              </div>
            </div>
            <div className="text-xs text-muted-foreground space-y-0.5 text-right">
              <div>Joined: {fmtDate(profile.created_at)}</div>
              {profile.telegram_username && <div>@{profile.telegram_username}</div>}
              {profile.telegram_id && <div>TG ID: {profile.telegram_id}</div>}
            </div>
          </div>
        </Card>

        <Tabs defaultValue="lessons">
          <TabsList>
            <TabsTrigger value="lessons">Lessons</TabsTrigger>
            <TabsTrigger value="homework">Homework</TabsTrigger>
            <TabsTrigger value="telegram">Telegram</TabsTrigger>
            <TabsTrigger value="engagement">Engagement</TabsTrigger>
            <TabsTrigger value="profile">Profile</TabsTrigger>
          </TabsList>

          <TabsContent value="lessons"><LessonsTab userId={profile.id} /></TabsContent>
          <TabsContent value="homework"><HomeworkTab userId={profile.id} /></TabsContent>
          <TabsContent value="telegram"><TelegramTab profile={profile} /></TabsContent>
          <TabsContent value="engagement"><EngagementTab userId={profile.id} /></TabsContent>
          <TabsContent value="profile"><ProfileTab profile={profile} role={role} /></TabsContent>
        </Tabs>
      </div>
    </PageShell>
  );
}

/* ───────── Lessons ───────── */
function LessonsTab({ userId }: { userId: string }) {
  const [rows, setRows] = useState<any[]>([]);
  const [kpi, setKpi] = useState({ completed: 0, watchSec: 0, last7Sec: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data: progress } = await supabase
        .from("lesson_progress")
        .select("lesson_id, watch_seconds_total, max_position_seconds, last_position_seconds, completed_at, updated_at, lessons:lesson_id(id, title, position, duration_seconds, module_id, modules:module_id(id, title, position))")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false });
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
  }, [userId]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Stat label="Lessons completed" value={kpi.completed} />
        <Stat label="Total watch time" value={fmtMin(kpi.watchSec)} />
        <Stat label="Last 7 days" value={fmtMin(kpi.last7Sec)} />
      </div>
      <Card className="overflow-hidden shadow-soft">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs">
            <tr>
              <th className="text-left p-3">Module</th>
              <th className="text-left p-3">Lesson</th>
              <th className="text-left p-3">Progress</th>
              <th className="text-left p-3">Watch time</th>
              <th className="text-left p-3">Completed</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={5} className="p-4 text-center text-muted-foreground">Loading…</td></tr>}
            {!loading && rows.length === 0 && <tr><td colSpan={5} className="p-4 text-center text-muted-foreground">No lesson activity yet.</td></tr>}
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
function HomeworkTab({ userId }: { userId: string }) {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [{ data: assigns }, { data: subs }] = await Promise.all([
        supabase.from("homework_assignments").select("id, title, task_number, max_score, module_id, modules:module_id(title, position)").eq("is_active", true),
        supabase.from("homework_submissions").select("*").eq("user_id", userId).order("submitted_at", { ascending: false }),
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
  }, [userId]);

  return (
    <Card className="overflow-hidden shadow-soft">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs">
          <tr>
            <th className="text-left p-3">Module</th>
            <th className="text-left p-3">Task</th>
            <th className="text-left p-3">Status</th>
            <th className="text-left p-3">Score</th>
            <th className="text-left p-3">Attempts</th>
            <th className="text-left p-3">Source</th>
            <th className="text-left p-3">Submitted</th>
            <th className="text-left p-3"></th>
          </tr>
        </thead>
        <tbody>
          {loading && <tr><td colSpan={8} className="p-4 text-center text-muted-foreground">Loading…</td></tr>}
          {!loading && rows.length === 0 && <tr><td colSpan={8} className="p-4 text-center text-muted-foreground">No assignments.</td></tr>}
          {rows.map(({ a, s }) => {
            const attempts = (s?.previous_attempts?.length || 0) + (s ? 1 : 0);
            const status = !s ? "not submitted" : s.score != null ? `graded` : s.is_late ? "late" : "submitted";
            return (
              <tr key={a.id} className="border-t">
                <td className="p-3 text-xs text-muted-foreground">{a.modules?.title || "—"}</td>
                <td className="p-3 font-medium">#{a.task_number} {a.title}</td>
                <td className="p-3">
                  <Badge variant={s?.score != null ? "default" : !s ? "outline" : "secondary"}>{status}</Badge>
                  {s?.is_late && <Badge variant="destructive" className="ml-1">late</Badge>}
                </td>
                <td className="p-3 tabular-nums">{s?.score != null ? `${s.score}/${a.max_score}` : "—"}</td>
                <td className="p-3 tabular-nums">{attempts || "—"}</td>
                <td className="p-3 text-xs text-muted-foreground">{s?.source || "—"}</td>
                <td className="p-3 text-xs text-muted-foreground">{fmtDate(s?.submitted_at)}</td>
                <td className="p-3">
                  {s?.telegram_message_url && (
                    <a href={s.telegram_message_url} target="_blank" rel="noreferrer" className="text-primary inline-flex items-center gap-1 text-xs">
                      Open <ExternalLink className="h-3 w-3" />
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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [{ data: q }, { data: i }, { data: e }] = await Promise.all([
        supabase.from("homework_teacher_dm_queue").select("*").eq("student_id", profile.id).order("created_at", { ascending: false }).limit(50),
        supabase.from("bot_homework_intents").select("*").eq("user_id", profile.id).order("created_at", { ascending: false }).limit(20),
        profile.telegram_id
          ? supabase.from("group_message_events").select("*").eq("telegram_user_id", profile.telegram_id).order("created_at", { ascending: false }).limit(30)
          : Promise.resolve({ data: [] } as any),
      ]);
      setDms(q || []); setIntents(i || []); setEvents(e || []);
      setLoading(false);
    })();
  }, [profile.id, profile.telegram_id]);

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h3 className="font-semibold mb-2">Link status</h3>
        <div className="text-sm grid grid-cols-2 md:grid-cols-4 gap-3">
          <div><div className="text-xs text-muted-foreground">Telegram ID</div><div className="tabular-nums">{profile.telegram_id || "—"}</div></div>
          <div><div className="text-xs text-muted-foreground">Username</div><div>{profile.telegram_username ? `@${profile.telegram_username}` : "—"}</div></div>
          <div><div className="text-xs text-muted-foreground">Onboarded</div><div>{fmtDate(profile.telegram_onboarded_at)}</div></div>
          <div><div className="text-xs text-muted-foreground">Group</div><div>{profile.groups?.name || "—"}</div></div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="p-3 font-semibold text-sm">Teacher DM queue (notifications about this student's submissions)</div>
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs">
            <tr><th className="text-left p-3">When</th><th className="text-left p-3">Module/Task</th><th className="text-left p-3">Status</th><th className="text-left p-3">Error</th></tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={4} className="p-4 text-center text-muted-foreground">Loading…</td></tr>}
            {!loading && dms.length === 0 && <tr><td colSpan={4} className="p-4 text-center text-muted-foreground">No teacher DMs.</td></tr>}
            {dms.map((d) => (
              <tr key={d.id} className="border-t">
                <td className="p-3 text-xs text-muted-foreground">{fmtDate(d.created_at)}</td>
                <td className="p-3">M{d.module_number} #{d.task_number} — {d.assignment_title || "—"}</td>
                <td className="p-3">
                  {d.sent_at ? <Badge variant="default">sent</Badge> :
                    d.queued_for_quiet_hours ? <Badge variant="secondary">queued (quiet hours)</Badge> :
                    <Badge variant="outline">pending</Badge>}
                </td>
                <td className="p-3 text-xs text-destructive">{d.error || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card className="overflow-hidden">
        <div className="p-3 font-semibold text-sm">Recent submit intents</div>
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs">
            <tr><th className="text-left p-3">When</th><th className="text-left p-3">Module</th><th className="text-left p-3">Topic/Chat</th><th className="text-left p-3">Expires</th></tr>
          </thead>
          <tbody>
            {!loading && intents.length === 0 && <tr><td colSpan={4} className="p-4 text-center text-muted-foreground">No intents.</td></tr>}
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

      <Card className="overflow-hidden">
        <div className="p-3 font-semibold text-sm">Recent group messages (from this Telegram account)</div>
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs">
            <tr><th className="text-left p-3">When</th><th className="text-left p-3">Chat/Thread</th><th className="text-left p-3">Message ID</th></tr>
          </thead>
          <tbody>
            {!loading && events.length === 0 && <tr><td colSpan={3} className="p-4 text-center text-muted-foreground">No events.</td></tr>}
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
        supabase.from("user_badges").select("earned_at, badges:badge_id(code, name_en, icon)").eq("user_id", userId).order("earned_at", { ascending: false }),
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
        <Stat label="Current streak" value={`${streak?.current_streak ?? 0}d`} />
        <Stat label="Longest streak" value={`${streak?.longest_streak ?? 0}d`} />
        <Stat label="Leaderboard rank" value={leaderboard?.rank ? `#${leaderboard.rank}` : "—"} />
        <Stat label="Badges earned" value={badges.length} />
      </div>

      <Card className="p-4">
        <div className="font-semibold text-sm mb-2">Watch heatmap (90d)</div>
        <div className="grid grid-cols-[repeat(90,minmax(0,1fr))] gap-0.5">
          {Array.from({ length: 90 }).map((_, i) => {
            const date = new Date(Date.now() - (89 - i) * 86400_000).toISOString().slice(0, 10);
            const sec = heatmap.find((h) => h.date === date)?.sec || 0;
            const lvl = sec === 0 ? 0 : sec < 600 ? 1 : sec < 1800 ? 2 : sec < 3600 ? 3 : 4;
            const cls = ["bg-muted", "bg-primary/20", "bg-primary/40", "bg-primary/70", "bg-primary"][lvl];
            return <div key={i} title={`${date}: ${fmtMin(sec)}`} className={`h-3 rounded-sm ${cls}`} />;
          })}
        </div>
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        <Card className="overflow-hidden">
          <div className="p-3 font-semibold text-sm">Recent logins (30d)</div>
          <table className="w-full text-sm">
            <tbody>
              {loading && <tr><td className="p-4 text-center text-muted-foreground">Loading…</td></tr>}
              {!loading && logins.length === 0 && <tr><td className="p-4 text-center text-muted-foreground">No logins.</td></tr>}
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
          <div className="p-3 font-semibold text-sm">Nudges sent</div>
          <table className="w-full text-sm">
            <tbody>
              {!loading && nudges.length === 0 && <tr><td className="p-4 text-center text-muted-foreground">No nudges.</td></tr>}
              {nudges.map((n) => (
                <tr key={n.id} className="border-t">
                  <td className="p-2 text-xs text-muted-foreground">{fmtDate(n.sent_at)}</td>
                  <td className="p-2 text-xs">{n.nudge_type}</td>
                  <td className="p-2 text-xs">{n.clicked_at ? <Badge variant="default">clicked</Badge> : n.error ? <Badge variant="destructive">error</Badge> : <Badge variant="outline">sent</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      {badges.length > 0 && (
        <Card className="p-4">
          <div className="font-semibold text-sm mb-3">Badges</div>
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
    ["Name", [profile.name, profile.last_name].filter(Boolean).join(" ") || "—"],
    ["Email", profile.email],
    ["Role", role],
    ["Status", profile.status],
    ["Group", profile.groups?.name || "—"],
    ["Preferred language", profile.preferred_language || "—"],
    ["Telegram ID", profile.telegram_id || "—"],
    ["Telegram username", profile.telegram_username ? `@${profile.telegram_username}` : "—"],
    ["TG onboarded", fmtDate(profile.telegram_onboarded_at)],
    ["Archived at", fmtDate(profile.archived_at)],
    ["Joined", fmtDate(profile.created_at)],
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
        To edit, use the <Link to="/admin/users" className="text-primary underline">Manage Users</Link> drawer.
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
