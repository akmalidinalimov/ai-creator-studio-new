import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Megaphone, Search, Settings as SettingsIcon, Users } from "lucide-react";
import { toast } from "sonner";
import { VoiceRecorder } from "@/components/homework/VoiceRecorder";
import { uploadFeedbackVoice, removeFeedbackVoice } from "@/lib/homeworkAudio";

/* Mission Control (design A) with the cross-group grading queue (design B).
   Group context is ALWAYS visible as chips; grading is one tap per score. */

interface TeacherStats { groups_count: number; students_total: number; graded_total: number; avg_score_given: number | null }
interface TeacherGroup {
  group_id: string; group_name: string; course_name: string | null;
  total_students: number; active_7d: number; avg_completion_pct: number; pending_homework: number;
}
interface QueueItem {
  id: string; user_id: string; submitted_text: string; submitted_image_url: string | null;
  submitted_at: string; max_score: number; module_pos: number; module_title: string;
  prompt: string; is_resub: boolean; prev_score: number | null;
  media: Array<{ kind: string; url?: string; msg_url?: string }>; tg_url: string | null;
  student: string; group_name: string;
  // Task 3 (voice-homework-feedback): a voice note left on a PRIOR grading round of this same
  // submission row (a resubmission keeps score_feedback_voice_path — start_homework_resubmission
  // doesn't clear it). Additive/display-only here; grade() resolves the final value to write.
  voice_path: string | null;
}
interface RosterRow {
  id: string; name: string; last_name: string | null; telegram_username: string | null;
  last_activity_at: string | null; completed_lessons: number; avg_score: number | null;
}
interface TeacherWeek {
  graded: number; grading_med_min: number | null; on_time_pct: number | null;
  ungraded_backlog: number; oldest_pending_hours: number | null;
  feedback_rate: number | null; avg_score_pct: number | null;
  questions: number; answered: number; answer_rate: number | null; median_wait_min: number | null;
  active_days: number; days_window: number; week_messages: number; last_active: string | null;
}
type Tab = "home" | "queue" | "roster" | "stats";

const daysSince = (iso: string | null) =>
  iso == null ? null : Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000);

export default function TeacherProfile() {
  const { user, role } = useAuth();
  const { t } = useTranslation();
  const [profileName, setProfileName] = useState("");
  const [stats, setStats] = useState<TeacherStats | null>(null);
  const [week, setWeek] = useState<TeacherWeek | null>(null);
  const [xp, setXp] = useState<{ total_xp: number; level: number; xp_next_level: number } | null>(null);
  const [groups, setGroups] = useState<TeacherGroup[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("home");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [queueLoading, setQueueLoading] = useState(true);
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [top, setTop] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  /* ---------- initial load: identity, groups, cross-group grading queue ---------- */
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const [pRes, sRes, gRes, wRes, xRes] = await Promise.all([
          supabase.from("profiles").select("name, last_name, active_teacher_group_id").eq("id", user.id).maybeSingle(),
          supabase.rpc("teacher_profile_stats" as any, { uid: user.id }),
          supabase.rpc("teacher_groups" as any, { uid: user.id }),
          supabase.rpc("teacher_weekly_self" as any, { uid: user.id, p_days: 7 }),
          supabase.rpc("teacher_xp" as any, { uid: user.id }),
        ]);
        if (cancelled) return;
        const p: any = pRes.data;
        setProfileName([p?.name, p?.last_name].filter(Boolean).join(" ") || t("profile.teacher"));
        const sRow: any = Array.isArray(sRes.data) ? sRes.data[0] : sRes.data;
        setStats(sRow || null);
        const wRow: any = Array.isArray(wRes.data) ? wRes.data[0] : wRes.data;
        setWeek(wRow || null);
        const xRow: any = Array.isArray(xRes.data) ? xRes.data[0] : xRes.data;
        setXp(xRow || null);
        const gs = ((gRes.data as any) || []) as TeacherGroup[];
        setGroups(gs);
        const active = gs.find((g) => g.group_id === p?.active_teacher_group_id)?.group_id || gs[0]?.group_id || null;
        setSelected(active);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  /* Queue: pending submissions across ALL the teacher's groups (RLS scopes rows
     to their students), oldest first. Student names via staff_list_students. */
  const loadQueue = async () => {
    setQueueLoading(true);
    try {
      const [subsRes, studentsRes] = await Promise.all([
        supabase.from("homework_submissions")
          // Pending = never scored OR resubmitted after grading (stale score).
          // score_feedback_voice_path (Task 3, voice-homework-feedback): not in the generated
          // types yet (Task 1's migration), but PostgREST doesn't need a typed column list — the
          // `as any` cast on the mapped row below covers it.
          .select("id, user_id, submitted_text, submitted_image_url, submitted_at, score, score_is_stale, previous_attempts, media, telegram_message_url, score_feedback_voice_path, homework_assignments(max_score, title, description, modules(position, title))")
          .or("score.is.null,score_is_stale.eq.true")
          .order("submitted_at", { ascending: true })
          .limit(100),
        supabase.rpc("staff_list_students" as any),
      ]);
      const byId = new Map((((studentsRes.data as any) || []) as any[]).map((s) => [s.id, s]));
      const groupName = (gid: string | null) => groups.find((g) => g.group_id === gid)?.group_name || "";
      const items: QueueItem[] = (((subsRes.data as any) || []) as any[])
        .filter((r) => byId.has(r.user_id)) // only students visible to this teacher
        .map((r) => {
          const st = byId.get(r.user_id);
          const prev = Array.isArray(r.previous_attempts) ? r.previous_attempts : [];
          const prevScore = r.score_is_stale
            ? (r.score ?? (prev.length ? prev[prev.length - 1]?.score : null))
            : (prev.length ? prev[prev.length - 1]?.score : null);
          return {
            id: r.id, user_id: r.user_id,
            submitted_text: r.submitted_text || "",
            submitted_image_url: r.submitted_image_url,
            submitted_at: r.submitted_at,
            max_score: r.homework_assignments?.max_score ?? 10,
            module_pos: r.homework_assignments?.modules?.position ?? 0,
            module_title: r.homework_assignments?.modules?.title ?? "",
            prompt: r.homework_assignments?.description || r.homework_assignments?.title || "",
            is_resub: !!r.score_is_stale || prev.length > 0,
            prev_score: prevScore ?? null,
            media: Array.isArray(r.media) ? r.media : [],
            tg_url: r.telegram_message_url || null,
            student: [st.name, st.last_name ? st.last_name[0] + "." : ""].filter(Boolean).join(" "),
            group_name: groupName(st.group_id),
            voice_path: r.score_feedback_voice_path ?? null,
          };
        });
      setQueue(items);
    } finally {
      setQueueLoading(false);
    }
  };
  useEffect(() => { if (!loading && user) loadQueue(); /* eslint-disable-next-line */ }, [loading]);

  /* Roster for the selected group. */
  useEffect(() => {
    if (!selected) { setRoster([]); return; }
    let cancelled = false;
    setRosterLoading(true);
    supabase.rpc("staff_group_members" as any, { _group_id: selected }).then(({ data }) => {
      if (cancelled) return;
      setRoster((((data as any) || []) as RosterRow[]));
      setRosterLoading(false);
    });
    supabase.rpc("teacher_group_top" as any, { uid: user!.id, _group_id: selected, _limit: 5 })
      .then(({ data }) => { if (!cancelled) setTop(((data as any) || [])); });
    return () => { cancelled = true; };
  }, [selected, user]);

  const pickGroup = async (gid: string) => {
    setSelected(gid);
    if (user) await supabase.from("profiles").update({ active_teacher_group_id: gid } as any).eq("id", user.id);
  };

  /* One-tap grading with a 6-second undo (safety net for fat fingers). `voicePath` (Task 3,
     voice-homework-feedback) is additive: the caller (QueueCard) uploads a new recording FIRST
     and resolves the value to write (new path / unchanged existing path / null if cleared) — this
     never changes score/score_feedback/scored_by/scored_at/score_is_stale or their semantics. */
  const grade = async (item: QueueItem, score: number, feedback?: string, voicePath?: string | null) => {
    const { error } = await supabase.from("homework_submissions")
      .update({
        score, score_feedback: feedback?.trim() || null,
        scored_by: user!.id, scored_at: new Date().toISOString(), score_is_stale: false,
        score_feedback_voice_path: voicePath ?? null,
      } as any)
      .eq("id", item.id);
    if (error) { toast.error(t("profile.tGradeFailed")); return; }
    const bump = (delta: number) =>
      setGroups((gs) => gs.map((g) => g.group_name === item.group_name ? { ...g, pending_homework: Math.max(g.pending_homework + delta, 0) } : g));
    setQueue((q) => q.filter((x) => x.id !== item.id));
    bump(-1);
    toast.success(`${item.student} — ${score}/${item.max_score} ✓`, {
      duration: 6000,
      action: {
        // "Undo" RE-OPENS this item to CORRECT the score — purely client-side, NO DB write here.
        // The grade stays committed (safe: identical to having no undo) until the teacher re-grades
        // with a corrected value, which is a guard-allowed score CHANGE (non-null→non-null) reusing the
        // idempotent hw_score:<assignment_id> XP ref-key. There is NO score→null clear anywhere:
        // clearing score→null WITHOUT bumping attempt_number trips homework_submissions_guard, which
        // reverts NEW.score := OLD.score but leaves scored_by/scored_at NULL — orphaning the row (it
        // vanishes from every grading queue AND keeps its +25 XP forever). Mirror of the #88 Mini App
        // fix (TeacherGrade.tsx); the grade_orphan_watchdog guards against any regression.
        label: t("profile.tUndo"),
        onClick: () => {
          setQueue((q) => [item, ...q.filter((x) => x.id !== item.id)].sort((a, b) => a.submitted_at.localeCompare(b.submitted_at)));
          bump(1);
          toast.info(t("profile.tReopened"));
        },
      },
    });
  };

  /* One-tap nudge for inactive students (rate-limited server-side to 1/day). */
  const [nudged, setNudged] = useState<Set<string>>(new Set());
  const nudge = async (studentId: string, name: string) => {
    const { data, error } = await supabase.functions.invoke("teacher-nudge-student", { body: { student_id: studentId } });
    const errMsg = (error as any)?.message || (data as any)?.error;
    if (errMsg === "already_nudged_today" || (error && String((error as any).context?.status) === "429")) {
      toast.info(t("profile.tNudgedAlready")); setNudged((s) => new Set(s).add(studentId)); return;
    }
    if (error || (data as any)?.error) { toast.error(t("profile.tNudgeFailed")); return; }
    setNudged((s) => new Set(s).add(studentId));
    toast.success(t("profile.tNudgeSent", { name }));
  };

  const sel = groups.find((g) => g.group_id === selected) || null;
  // Median durations arrive in minutes; show minutes under an hour, else hours (1dp under 10h).
  const fmtDur = (min: number | null | undefined) => {
    if (min == null) return "—";
    if (min < 60) return t("profile.twMin", { n: Math.round(min) });
    return t("profile.twHours", { n: (min / 60).toFixed(min < 600 ? 1 : 0) });
  };
  // Teacher level → localized name + emoji ladder (🌱→🏆). Reuses the generic XP curve.
  const LVL_EMOJI = ["🌱", "📗", "🎓", "🏅", "🏆"];
  const lvlNames = t("profile.tLevelNames", { returnObjects: true }) as unknown as string[];
  const lvl = xp?.level ?? 1;
  const lvlName = (Array.isArray(lvlNames) && lvlNames[Math.min(lvl, lvlNames.length) - 1]) || `Lv ${lvl}`;
  const lvlEmoji = LVL_EMOJI[Math.min(lvl, LVL_EMOJI.length) - 1] || "🎓";
  const inactive3d = useMemo(() => roster.filter((r) => (daysSince(r.last_activity_at) ?? 99) >= 3), [roster]);
  const oldestDays = queue.length ? daysSince(queue[0].submitted_at) : null;
  // Inactivity range filter: null = everyone, 3/7/14 = inactive >= N days.
  const [inactFilter, setInactFilter] = useState<number | null>(null);
  const filteredRoster = useMemo(() => {
    const q = search.trim().toLowerCase();
    return roster.filter((r) => {
      if (q && !`${r.name} ${r.last_name || ""} ${r.telegram_username || ""}`.toLowerCase().includes(q)) return false;
      if (inactFilter != null && (daysSince(r.last_activity_at) ?? 999) < inactFilter) return false;
      return true;
    });
  }, [roster, search, inactFilter]);

  // Bulk reminder: nudge every student in the current filtered list.
  const [bulkBusy, setBulkBusy] = useState(false);
  const bulkNudge = async () => {
    setBulkBusy(true);
    let ok = 0, skipped = 0;
    for (const r of filteredRoster.slice(0, 60)) {
      if (nudged.has(r.id)) { skipped++; continue; }
      const { data, error } = await supabase.functions.invoke("teacher-nudge-student", { body: { student_id: r.id } });
      const err = (error as any)?.message || (data as any)?.error;
      if (!error && !(data as any)?.error) { ok++; setNudged((s) => new Set(s).add(r.id)); }
      else { skipped++; if (err === "already_nudged_today") setNudged((s) => new Set(s).add(r.id)); }
      await new Promise((res) => setTimeout(res, 150));
    }
    setBulkBusy(false);
    toast.success(t("profile.tBulkDone", { ok, skipped }));
  };

  if (loading) {
    return (
      <PageShell>
        <div className="max-w-2xl mx-auto space-y-4">
          <Card className="h-40 animate-pulse bg-muted/40" />
          <Card className="h-64 animate-pulse bg-muted/40" />
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <div className="max-w-2xl mx-auto space-y-4">
        {/* identity row */}
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-gradient-to-tr from-amber-400 to-amber-500 text-white flex items-center justify-center font-bold">
            {profileName.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="font-semibold leading-tight truncate">{profileName}</div>
            <div className="text-xs text-muted-foreground">
              {role === "admin" ? "Admin" : t("profile.teacherBadge")} · {stats?.groups_count ?? 0} {t("profile.tGroups").toLowerCase()} · {stats?.students_total ?? 0} {t("profile.tStudents").toLowerCase()}
            </div>
            {xp && (
              <div className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                <span>{lvlEmoji}</span><span>{lvlName}</span>
                <span className="text-muted-foreground tabular-nums">· {xp.total_xp} XP</span>
              </div>
            )}
          </div>
          <Link to="/settings" className="ml-auto rounded-full p-2 text-muted-foreground hover:bg-muted" aria-label={t("nav.mySettings")}>
            <SettingsIcon className="h-4 w-4" />
          </Link>
        </div>

        {/* group chips — always visible; amber dot = needs attention */}
        {groups.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide" role="tablist" aria-label={t("profile.tGroups")}>
            {groups.map((g) => {
              const attention = g.pending_homework > 0 || (g.total_students > 0 && g.active_7d / g.total_students < 0.3);
              // Course identity on every chip: colored dot + short course label,
              // so multi-course teachers always know which world a group is in.
              const courseIdx = [...new Set(groups.map((x) => x.course_name))].indexOf(g.course_name);
              const dotCls = courseIdx % 2 === 0 ? "bg-primary" : "bg-violet-500";
              const shortCourse = (g.course_name || "").replace(/AI CREATORS\s*/i, "");
              return (
                <button key={g.group_id} role="tab" aria-selected={selected === g.group_id}
                  onClick={() => pickGroup(g.group_id)}
                  className={`shrink-0 rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
                    selected === g.group_id
                      ? "border-primary bg-primary/10 font-semibold text-foreground"
                      : "bg-card text-muted-foreground hover:text-foreground"}`}>
                  <span className={`inline-block h-2 w-2 rounded-full ${dotCls} mr-1.5 align-middle`} aria-hidden />
                  {g.group_name}
                  {shortCourse && <span className="ml-1 text-[10px] text-muted-foreground align-middle">· {shortCourse}</span>}
                  {attention && <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500 ml-1.5 align-middle" aria-label="!" />}
                </button>
              );
            })}
          </div>
        )}

        {/* tabs */}
        <div className="flex gap-1 border-b overflow-x-auto" role="tablist">
          {([
            ["home", `🏠 ${t("profile.tTabHome")}`],
            ["queue", `📝 ${t("profile.tTabQueue")}${queue.length ? ` · ${queue.length}` : ""}`],
            ["roster", `👥 ${t("profile.tTabRoster")}`],
            ["stats", `📊 ${t("profile.tTabStats")}`],
          ] as [Tab, string][]).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className={`px-3 pb-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ${
                tab === id ? "border-primary font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
              {label}
            </button>
          ))}
        </div>

        {/* ---------------- HOME: cockpit ---------------- */}
        {tab === "home" && sel && (
          <div className="space-y-4">
            {/* daily digest: what happened in the last 24h (from loaded data) */}
            <Card className="p-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">🕐 {t("profile.tDigest")}</span>
              <span>📝 <b className="tabular-nums">{queue.filter((q) => (daysSince(q.submitted_at) ?? 9) < 1).length}</b> {t("profile.tDigestNew")}</span>
              <span>✅ <b className="tabular-nums">{roster.filter((r) => (daysSince(r.last_activity_at) ?? 9) < 1).length}</b> {t("profile.tDigestActive")}</span>
            </Card>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { v: sel.total_students, l: t("profile.tMembers") },
                { v: sel.active_7d, l: t("profile.tActive7d"), cls: "text-emerald-600" },
                { v: sel.pending_homework, l: sel.pending_homework > 0 ? t("profile.tPendingHint") : t("profile.tPending"), cls: sel.pending_homework > 0 ? "text-amber-600" : "" },
                { v: `${sel.avg_completion_pct}%`, l: t("profile.tCompletion"), cls: "text-primary" },
              ].map((it, i) => (
                <Card key={i} className="p-3 text-center">
                  <div className={`text-xl font-bold tabular-nums ${it.cls || ""}`}>{it.v}</div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{it.l}</div>
                </Card>
              ))}
            </div>
            {sel.course_name && (
              <div className="text-xs text-muted-foreground -mt-1">{t("profile.tCourse")}: <b className="text-foreground">{sel.course_name}</b></div>
            )}

            {/* quick actions */}
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => setTab("queue")} className="rounded-xl border bg-card p-4 text-left hover:border-primary transition-colors">
                <div className="text-xl">📝</div>
                <div className="font-semibold text-sm mt-1">{t("profile.tTabQueue")}</div>
                <div className="text-xs text-muted-foreground">{queue.length ? t("profile.tQueueCount", { n: queue.length }) : t("profile.tQueueEmpty")}</div>
              </button>
              <button onClick={() => setTab("roster")} className="rounded-xl border bg-card p-4 text-left hover:border-primary transition-colors">
                <div className="text-xl">👥</div>
                <div className="font-semibold text-sm mt-1">{t("profile.tTabRoster")}</div>
                <div className="text-xs text-muted-foreground">{sel.total_students} {t("profile.tStudents").toLowerCase()}</div>
              </button>
              <button onClick={() => setTab("stats")} className="rounded-xl border bg-card p-4 text-left hover:border-primary transition-colors">
                <div className="text-xl">📊</div>
                <div className="font-semibold text-sm mt-1">{t("profile.tTabStats")}</div>
                <div className="text-xs text-muted-foreground">{t("profile.tTopStudents")}</div>
              </button>
              <a href="https://t.me" onClick={(e) => { e.preventDefault(); toast.info(t("profile.tBroadcastHint")); }}
                className="rounded-xl border bg-card p-4 text-left hover:border-primary transition-colors">
                <div className="text-xl"><Megaphone className="h-5 w-5 inline text-primary" /></div>
                <div className="font-semibold text-sm mt-1">{t("profile.tBroadcast")}</div>
                <div className="text-xs text-muted-foreground">{t("profile.tInBot")}</div>
              </a>
            </div>

            {/* attention feed */}
            <Card className="p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">🚨 {t("profile.tAttention")}</div>
              <ul className="space-y-2 text-sm">
                {queue.length > 0 && (
                  <li className="flex items-center gap-2">
                    <span>⏰</span>
                    <span className="flex-1">{t("profile.tOldestPending", { days: oldestDays ?? 0 })}</span>
                    <Button size="sm" onClick={() => setTab("queue")}>{t("profile.tGrade")}</Button>
                  </li>
                )}
                {inactive3d.length > 0 && (
                  <li className="flex items-center gap-2">
                    <span>😴</span>
                    <span className="flex-1">{t("profile.tInactiveCount", { n: inactive3d.length })}</span>
                    <Button size="sm" variant="outline" onClick={() => { setTab("roster"); setSearch(""); setInactFilter(3); }}>{t("common.more")}</Button>
                  </li>
                )}
                {queue.length === 0 && inactive3d.length === 0 && (
                  <li className="text-muted-foreground">✅ {t("profile.tAllGood")}</li>
                )}
              </ul>
            </Card>
          </div>
        )}

        {/* ---------------- QUEUE: one-tap grading, oldest first, cross-group ---------------- */}
        {tab === "queue" && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">{t("profile.tQueueNote")}</p>
            {queueLoading ? (
              <Card className="h-32 animate-pulse bg-muted/40" />
            ) : queue.length === 0 ? (
              <Card className="p-8 text-center text-sm text-muted-foreground">🎉 {t("profile.tQueueEmpty")}</Card>
            ) : (
              queue.map((item) => <QueueCard key={item.id} item={item} onGrade={grade} t={t} />)
            )}
          </div>
        )}

        {/* ---------------- ROSTER: searchable, flagged ---------------- */}
        {tab === "roster" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
              <Search className="h-4 w-4 text-muted-foreground" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("common.search")}
                className="flex-1 bg-transparent text-sm outline-none" />
              <span className="text-xs text-muted-foreground tabular-nums">{filteredRoster.length}</span>
            </div>

            {/* inactivity range filter + bulk reminder */}
            <div className="flex flex-wrap items-center gap-2">
              {([[null, t("profile.tAllStudents")], [3, "😴 3+ kun"], [7, "😴 7+ kun"], [14, "😴 14+ kun"]] as [number | null, string][]).map(([v, label]) => (
                <button key={String(v)} onClick={() => setInactFilter(v)}
                  className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                    inactFilter === v ? "border-primary bg-primary/10 font-semibold text-foreground" : "bg-card text-muted-foreground hover:text-foreground"}`}>
                  {label}
                </button>
              ))}
              {inactFilter != null && filteredRoster.length > 0 && (
                <Button size="sm" className="ml-auto" disabled={bulkBusy} onClick={bulkNudge}>
                  {bulkBusy ? "…" : `👋 ${t("profile.tBulkNudge", { n: filteredRoster.length })}`}
                </Button>
              )}
            </div>
            {rosterLoading ? (
              <Card className="h-40 animate-pulse bg-muted/40" />
            ) : (
              <Card className="divide-y">
                {filteredRoster.map((r) => {
                  const d = daysSince(r.last_activity_at);
                  return (
                    <div key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                      <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-semibold">
                        {(r.name || "?").slice(0, 1).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="truncate font-medium">{r.name} {r.last_name || ""}</div>
                        <div className="text-xs text-muted-foreground tabular-nums">
                          {r.completed_lessons} {t("profile.lessons")}{r.avg_score != null ? ` · ${t("profile.avg").toLowerCase()} ${r.avg_score}/10` : ""}
                        </div>
                      </div>
                      {d != null && d >= 3 && <span className="text-[11px] rounded-md bg-amber-500/15 text-amber-600 px-1.5 py-0.5">😴 {d}{t("profile.days").slice(0, 1)}</span>}
                      {d != null && d >= 3 && (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={nudged.has(r.id)}
                          onClick={() => nudge(r.id, r.name)} title={t("profile.tNudgeTitle")}>
                          {nudged.has(r.id) ? "✓" : `👋 ${t("profile.tNudge")}`}
                        </Button>
                      )}
                      {r.telegram_username && (
                        <a href={`https://t.me/${r.telegram_username}`} target="_blank" rel="noreferrer"
                          className="text-xs text-primary hover:underline">💬</a>
                      )}
                    </div>
                  );
                })}
                {filteredRoster.length === 0 && <div className="p-6 text-center text-sm text-muted-foreground">{t("profile.tNoStudents")}</div>}
              </Card>
            )}
          </div>
        )}

        {/* ---------------- STATS: your week (self KPIs) + top students ---------------- */}
        {tab === "stats" && (
          <div className="space-y-4">
            {/* Level & XP — progression/mastery framing (feeds competence, not ranking) */}
            {xp && (
              <Card className="p-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">{lvlEmoji} {lvlName}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{xp.total_xp} XP</span>
                </div>
                {(() => {
                  const prevT = 50 * (lvl - 1) * lvl; // XP threshold to reach the current level
                  const span = Math.max(xp.xp_next_level - prevT, 1);
                  const pct = Math.min(100, Math.max(0, Math.round(((xp.total_xp - prevT) / span) * 100)));
                  return (
                    <>
                      <div className="mt-2 h-2 rounded-full bg-muted overflow-hidden">
                        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {t("profile.tToNext", { xp: Math.max(xp.xp_next_level - xp.total_xp, 0) })}
                      </div>
                    </>
                  );
                })()}
              </Card>
            )}
            {/* Your week — the teacher's OWN scorecard, framed as impact/competence, not surveillance */}
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">📈 {t("profile.twTitle")}</div>
              <div className="text-xs text-muted-foreground mb-2">{t("profile.twSubtitle", { days: week?.days_window ?? 7 })}</div>
              {week && (week.graded > 0 || week.questions > 0 || week.active_days > 0) ? (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {[
                      { v: week.graded, l: t("profile.twGraded") },
                      { v: week.on_time_pct != null ? `${week.on_time_pct}%` : "—", l: t("profile.twOnTime"), cls: "text-emerald-600" },
                      { v: week.answer_rate != null ? `${week.answer_rate}%` : "—", l: t("profile.twAnswerRate"), cls: "text-primary" },
                      { v: week.active_days, l: t("profile.twActiveDays") },
                    ].map((it, i) => (
                      <Card key={i} className="p-3 text-center">
                        <div className={`text-xl font-bold tabular-nums ${it.cls || ""}`}>{it.v}</div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{it.l}</div>
                      </Card>
                    ))}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>⏱️ {t("profile.twMedGrading")}: <b className="text-foreground tabular-nums">{fmtDur(week.grading_med_min)}</b></span>
                    <span>💬 {t("profile.twMedWait")}: <b className="text-foreground tabular-nums">{fmtDur(week.median_wait_min)}</b></span>
                    {week.ungraded_backlog > 0 && (
                      <span>📥 {t("profile.twBacklog")}: <b className="text-amber-600 tabular-nums">{week.ungraded_backlog}</b></span>
                    )}
                  </div>
                </>
              ) : (
                <Card className="p-4 text-sm text-muted-foreground">{t("profile.twEmpty")}</Card>
              )}
            </div>

            {/* Top students of the selected group */}
            {sel && (
              <Card className="p-4">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
                  🏆 {t("profile.tTopStudents")} · {sel.group_name}
                </div>
                {top.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("profile.tNoStudents")}</p>
                ) : (
                  <ul className="space-y-1">
                    {top.map((s: any) => (
                      <li key={s.rank} className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm">
                        <span className="w-6 text-muted-foreground tabular-nums">{s.rank}</span>
                        <span className="flex-1 truncate">{s.first_name} {s.last_initial ? s.last_initial + "." : ""}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">{s.completed_lessons} {t("profile.lessons")}</span>
                        <span className="text-xs text-amber-600 tabular-nums">{s.current_streak > 0 ? `${s.current_streak}🔥` : ""}</span>
                        <span className="w-14 text-right text-primary tabular-nums font-semibold">{s.total_xp}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-3 flex gap-3 text-xs">
                  <Link to="/teacher/homework" className="text-primary hover:underline">{t("profile.tGradeHomework")} →</Link>
                  <Link to="/admin/dashboard" className="text-muted-foreground hover:underline">{t("nav.adminDashboard")} →</Link>
                </div>
              </Card>
            )}
          </div>
        )}
      </div>
    </PageShell>
  );
}

/* ---------------- queue card: one-tap scores + optional feedback ---------------- */

/* Teacher-editable feedback presets per score band (stored per browser). */
const DEFAULT_PRESETS: Record<string, string[]> = {
  hi: ["Zo'r ish! 🔥", "Ajoyib bajarilgan! 👏"],
  mid: ["Yaxshi, lekin yana bir oz mehnat kerak.", "Yaxshi urinish — keyingi safar batafsilroq."],
  lo: ["Vazifani qayta ko'rib chiqing — topshiriq shartiga e'tibor bering.", "Qaytadan urinib ko'ring, savollar bo'lsa yozing."],
};
function presetsFor(score: number, max: number): string[] {
  let saved: Record<string, string[]> | null = null;
  try { saved = JSON.parse(localStorage.getItem("fbPresets") || "null"); } catch { /* ignore */ }
  const p = saved || DEFAULT_PRESETS;
  const band = score >= max * 0.9 ? "hi" : score >= max * 0.6 ? "mid" : "lo";
  return p[band] || [];
}

function QueueCard({
  item, onGrade, t,
}: {
  item: QueueItem;
  onGrade: (i: QueueItem, s: number, f?: string, voicePath?: string | null) => void;
  t: any;
}) {
  const [feedback, setFeedback] = useState("");
  const [showFb, setShowFb] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const [pick, setPick] = useState<number | null>(null);
  // Task 3 (voice-homework-feedback): `voiceBlob` = a freshly-recorded note pending upload.
  // `existingPath` starts at whatever this submission already carries (a resubmission can retain a
  // voice note from an earlier grading round) and becomes null the moment the teacher deletes it —
  // `send` resolves the final value to write from these two, exactly mirroring how `feedback`
  // (typed fresh each round, no server pre-fill) already behaves.
  const [voiceBlob, setVoiceBlob] = useState<Blob | null>(null);
  const [existingPath, setExistingPath] = useState<string | null>(item.voice_path);
  const [uploadingVoice, setUploadingVoice] = useState(false);
  const d = daysSince(item.submitted_at) ?? 0;
  const send = async (score: number) => {
    let voicePath: string | null = existingPath;
    if (voiceBlob) {
      setUploadingVoice(true);
      try {
        voicePath = await uploadFeedbackVoice(item.user_id, item.id, voiceBlob);
      } catch {
        toast.error("Ovozli izohni yuklab bo'lmadi. Qayta urinib ko'ring.");
        setUploadingVoice(false);
        return;
      }
      setUploadingVoice(false);
    } else if (existingPath == null && item.voice_path) {
      // The teacher explicitly deleted a prior note without recording a replacement — best-effort
      // clean up the now-orphaned object (the write below already carries voicePath=null).
      void removeFeedbackVoice(item.user_id, item.id);
    }
    onGrade(item, score, feedback, voicePath);
  };
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-sm flex-wrap">
        <b className="truncate">{item.student}</b>
        <span className="text-xs text-muted-foreground truncate">· {item.group_name} · {item.module_pos + 1}-modul</span>
        {item.is_resub && (
          <span className="text-[11px] rounded-md bg-violet-500/15 text-violet-600 px-1.5 py-0.5">
            🔁 {t("profile.tResub")}{item.prev_score != null ? ` · ${t("profile.tPrevScore")}: ${item.prev_score}/${item.max_score}` : ""}
          </span>
        )}
        <span className={`ml-auto text-[11px] rounded-md px-1.5 py-0.5 tabular-nums ${d >= 3 ? "bg-amber-500/15 text-amber-600" : "bg-muted text-muted-foreground"}`}>
          {t("profile.tDaysAgo", { n: d })}
        </span>
      </div>

      {/* T1: the assignment prompt, one tap away — judge without navigating */}
      {item.prompt && (
        <div className="mt-2">
          <button onClick={() => setShowPrompt((v) => !v)} className="text-xs text-primary hover:underline">
            {showPrompt ? "▾" : "▸"} {t("profile.tShowPrompt")}
          </button>
          {showPrompt && <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap border-l-2 border-primary/30 pl-2">{item.prompt}</p>}
        </div>
      )}

      {item.submitted_text && (
        <p className="mt-2 text-sm text-muted-foreground whitespace-pre-wrap line-clamp-4">{item.submitted_text}</p>
      )}
      {/* Multi-media: one chip per attached item, opening the Telegram message */}
      {item.media.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.media.map((m, i) => {
            const icon = m.kind === "photo" ? "🖼" : m.kind === "video" ? "🎬" : m.kind === "link" ? "🔗" : "📄";
            const href = m.kind === "link" ? m.url : (m.msg_url || item.tg_url || undefined);
            return href ? (
              <a key={i} href={href} target="_blank" rel="noreferrer"
                className="text-[11px] rounded-md border px-2 py-0.5 text-muted-foreground hover:border-primary hover:text-foreground">
                {icon} {m.kind}{item.media.length > 1 ? ` ${i + 1}` : ""}
              </a>
            ) : <span key={i} className="text-[11px] rounded-md border px-2 py-0.5 text-muted-foreground">{icon} {m.kind}</span>;
          })}
        </div>
      )}
      {/* T1: inline image with lightbox instead of a new tab */}
      {item.submitted_image_url && (
        <>
          <img src={item.submitted_image_url} alt="" loading="lazy" onClick={() => setLightbox(true)}
            className="mt-2 h-24 rounded-md border object-cover cursor-zoom-in" />
          {lightbox && (
            <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 cursor-zoom-out" onClick={() => setLightbox(false)}>
              <img src={item.submitted_image_url} alt="" className="max-h-full max-w-full rounded-lg" />
            </div>
          )}
        </>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {[item.max_score, 8, 6, 4].filter((v, i, a) => a.indexOf(v) === i && v <= item.max_score).map((s) => (
          <Button key={s} size="sm" variant={pick === s ? "default" : "outline"}
            onClick={() => { setPick(s); if (!showFb) void send(s); }}>
            {s === item.max_score ? `✓ ${s}` : s}
          </Button>
        ))}
        <button onClick={() => setShowFb((v) => !v)} className="text-xs text-muted-foreground hover:text-foreground">
          ✍️ {t("profile.tFeedback")}
        </button>
      </div>

      {showFb && (
        <div className="mt-2 space-y-1.5">
          {/* T2: one-tap feedback presets for the picked score band */}
          {pick != null && (
            <div className="flex flex-wrap gap-1.5">
              {presetsFor(pick, item.max_score).map((p, i) => (
                <button key={i} onClick={() => setFeedback(p)}
                  className="text-[11px] rounded-full border px-2.5 py-1 text-muted-foreground hover:border-primary hover:text-foreground">
                  {p.length > 42 ? p.slice(0, 42) + "…" : p}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder={t("profile.tFeedbackPh")}
              className="flex-1 rounded-md border bg-background px-3 py-1.5 text-sm" maxLength={500} />
            <Button size="sm" disabled={pick == null || uploadingVoice} onClick={() => pick != null && void send(pick)}>
              {t("profile.tSend")}
            </Button>
          </div>
          {/* Task 3: voice note beside the text field. A retained prior note (resubmission) shows as
              a compact removable chip; recording a new one overwrites the same deterministic
              storage key regardless. */}
          {existingPath && !voiceBlob && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground">
              <span className="flex-1 truncate">🎤 Saqlangan ovozli izoh mavjud</span>
              <button type="button" onClick={() => setExistingPath(null)} className="font-medium text-destructive hover:underline">
                O'chirish
              </button>
            </div>
          )}
          <VoiceRecorder value={voiceBlob} onChange={setVoiceBlob} disabled={uploadingVoice} />
        </div>
      )}
    </Card>
  );
}
