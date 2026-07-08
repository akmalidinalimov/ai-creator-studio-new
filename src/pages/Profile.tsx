import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Camera, Pencil, Settings as SettingsIcon, Share2 } from "lucide-react";
import { toast } from "sonner";
import TeacherProfile from "@/components/profile/TeacherProfile";

/* ------------------------------------------------------------------ types */

interface ProfileRow {
  id: string; name: string | null; last_name: string | null;
  avatar_url: string | null; bio: string | null; created_at: string;
}
interface PublicProfile { group_name: string | null; teacher_name: string | null }
interface Stats {
  lessons_completed: number; modules_completed: number;
  total_lessons: number; total_modules: number;
  current_streak: number; longest_streak: number;
  total_xp: number; level: number; xp_next_level: number;
  group_rank: number | null; group_size: number;
  homework_submitted: number; homework_avg_score: number | null;
  badges_earned: number; watch_minutes_total: number;
}
interface GroupRow {
  rank: number; user_id: string; first_name: string; last_initial: string;
  total_xp: number; level: number; current_streak: number; is_me: boolean;
}
interface BadgeRow {
  id: string; code: string; icon: string | null; position: number;
  name_uz: string; name_ru: string; name_en: string;
}
interface Celebration { module_id: string; image_url: string | null; caption: string | null }
interface HwRow { score: number | null; max_score: number; module_pos: number; module_title: string }

type Tab = "achievements" | "group" | "about" | "stats";

/* ------------------------------------------------------------- utilities */

const prevThreshold = (level: number) => 50 * Math.max(level - 1, 0) * level;

/** The profile inherits the platform backdrop (mint + pixel-dissolve from
 *  PageShell). Kept as a no-op seam in case a page-specific layer returns. */
export function ProfileBackground() {
  return null;
}

/** Conic streak ring: fills toward a full ring at a 30-day streak. */
function ringStyle(streak: number) {
  const deg = Math.round(Math.min(Math.max(streak, 0) / 30, 1) * 360);
  if (deg === 0) return { background: "hsl(var(--muted))" };
  return {
    background: `conic-gradient(from 210deg, #F59E0B, #EC4899 ${Math.round(deg / 2)}deg, #8B5CF6 ${deg}deg, hsl(var(--muted)) ${deg}deg)`,
  };
}

function Donut({ pct, size = 96 }: { pct: number; size?: number }) {
  const r = size / 2 - 8;
  const c = 2 * Math.PI * r;
  const filled = Math.min(Math.max(pct, 0), 1) * c;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${Math.round(pct * 100)}%`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth="10" />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#8B5CF6" strokeWidth="10"
        strokeLinecap="round" strokeDasharray={`${filled} ${c - filled}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="fill-foreground" fontSize="18" fontWeight="700">
        {Math.round(pct * 100)}%
      </text>
    </svg>
  );
}

/* ------------------------------------------------------------------ page */

export default function Profile() {
  const { user, role } = useAuth();
  const { t, i18n } = useTranslation();

  // Teachers/admins get the mentor variant of the same page.
  if (role === "teacher" || role === "admin") return <TeacherProfile />;
  return <StudentProfile userId={user?.id ?? null} t={t} lng={(i18n.language || "uz").slice(0, 2)} />;
}

function StudentProfile({ userId, t, lng }: { userId: string | null; t: any; lng: string }) {
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [pub, setPub] = useState<PublicProfile | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [group, setGroup] = useState<GroupRow[]>([]);
  const [badges, setBadges] = useState<BadgeRow[]>([]);
  const [earned, setEarned] = useState<Set<string>>(new Set());
  const [celebs, setCelebs] = useState<Celebration[]>([]);
  const [week, setWeek] = useState<{ day: string; minutes: number }[]>([]);
  const [xpWeeks, setXpWeeks] = useState<{ label: string; xp: number }[]>([]);
  const [homework, setHomework] = useState<HwRow[]>([]);
  const [tab, setTab] = useState<Tab>("achievements");
  const [loading, setLoading] = useState(true);
  const [savingBio, setSavingBio] = useState(false);
  const [bioDraft, setBioDraft] = useState<string | null>(null);
  const [avatarBroken, setAvatarBroken] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const sectionRefs = {
    progress: useRef<HTMLDivElement>(null),
    activity: useRef<HTMLDivElement>(null),
    homework: useRef<HTMLDivElement>(null),
    group: useRef<HTMLDivElement>(null),
  };

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      try {
        const since = new Date(Date.now() - 56 * 86400_000).toISOString();
        const weekStart = new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10);
        const [pRes, pubRes, sRes, gRes, bRes, ubRes, cRes, dRes, xRes, hRes] = await Promise.all([
          supabase.from("profiles").select("id, name, last_name, avatar_url, bio, created_at").eq("id", userId).maybeSingle(),
          supabase.rpc("public_profile" as any, { _uid: userId }),
          supabase.rpc("profile_stats" as any, { uid: userId }),
          supabase.rpc("group_leaderboard" as any, { uid: userId, _limit: 20 }),
          supabase.from("badges").select("id, code, icon, position, name_uz, name_ru, name_en").order("position"),
          supabase.from("user_badges").select("badge_id").eq("user_id", userId),
          supabase.from("module_celebrations").select("module_id, image_url, caption").eq("user_id", userId).order("created_at", { ascending: false }),
          supabase.from("daily_watch_summary").select("watch_date, total_seconds").eq("user_id", userId).gte("watch_date", weekStart),
          supabase.from("xp_events").select("amount, created_at").eq("user_id", userId).gte("created_at", since),
          supabase.from("homework_submissions")
            .select("score, homework_assignments(max_score, modules(position, title))")
            .eq("user_id", userId),
        ]);
        if (cancelled) return;
        setProfile((pRes.data as any) || null);
        const pubRow: any = Array.isArray(pubRes.data) ? pubRes.data[0] : pubRes.data;
        setPub(pubRow ? { group_name: pubRow.group_name, teacher_name: pubRow.teacher_name } : null);
        const sRow: any = Array.isArray(sRes.data) ? sRes.data[0] : sRes.data;
        setStats(sRow || null);
        setGroup(((gRes.data as any) || []) as GroupRow[]);
        setBadges(((bRes.data as any) || []) as BadgeRow[]);
        setEarned(new Set((((ubRes.data as any) || []) as any[]).map((r) => r.badge_id)));
        setCelebs(((cRes.data as any) || []) as Celebration[]);

        // Weekly activity: fill all 7 days (locale-aware initials).
        const dayNames = lng === "ru" ? ["Вс","Пн","Вт","Ср","Чт","Пт","Сб"]
          : lng === "en" ? ["Su","Mo","Tu","We","Th","Fr","Sa"]
          : ["Ya","Du","Se","Ch","Pa","Ju","Sh"];
        const byDate = new Map<string, number>(
          (((dRes.data as any) || []) as any[]).map((r) => [r.watch_date, Math.round((r.total_seconds || 0) / 60)]),
        );
        const days: { day: string; minutes: number }[] = [];
        for (let i = 6; i >= 0; i--) {
          const d = new Date(Date.now() - i * 86400_000);
          const key = d.toISOString().slice(0, 10);
          days.push({ day: dayNames[d.getDay()], minutes: byDate.get(key) || 0 });
        }
        setWeek(days);

        // XP trend: 8 weekly buckets.
        const buckets = Array.from({ length: 8 }, () => 0);
        for (const e of (((xRes.data as any) || []) as any[])) {
          const age = Date.now() - new Date(e.created_at).getTime();
          const w = Math.min(Math.floor(age / (7 * 86400_000)), 7);
          buckets[7 - w] += e.amount;
        }
        setXpWeeks(buckets.map((xp, i) => ({ label: `${i + 1}`, xp })));

        // Homework scorecard.
        const hw: HwRow[] = (((hRes.data as any) || []) as any[])
          .map((r) => ({
            score: r.score,
            max_score: r.homework_assignments?.max_score ?? 10,
            module_pos: r.homework_assignments?.modules?.position ?? 0,
            module_title: r.homework_assignments?.modules?.title ?? "",
          }))
          .sort((a, b) => a.module_pos - b.module_pos);
        setHomework(hw);
      } catch (e) {
        console.error("[Profile] load failed", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userId, lng]);

  const pickBadgeName = (b: BadgeRow) => (lng === "ru" ? b.name_ru : lng === "en" ? b.name_en : b.name_uz);
  const earnedBadges = useMemo(() => badges.filter((b) => earned.has(b.id)), [badges, earned]);
  const fullName = [profile?.name, profile?.last_name].filter(Boolean).join(" ") || t("profile.student");

  const openStats = (section: keyof typeof sectionRefs) => {
    setTab("stats");
    setTimeout(() => sectionRefs[section].current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };

  const uploadAvatar = async (file: File) => {
    if (!userId) return;
    try {
      // Resize/compress to a small square BEFORE upload. Works for any input size (no more 4MB
      // rejection) and keeps stored avatars tiny (~tens of KB) — faster + far less VPS storage.
      const blob = await new Promise<Blob>((resolve, reject) => {
        const img = new Image();
        const objUrl = URL.createObjectURL(file);
        img.onload = () => {
          URL.revokeObjectURL(objUrl);
          const MAX = 512;
          const scale = Math.min(1, MAX / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) { reject(new Error("canvas unavailable")); return; }
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", 0.85);
        };
        img.onerror = () => { URL.revokeObjectURL(objUrl); reject(new Error("could not read image")); };
        img.src = objUrl;
      });
      const path = `${userId}/avatar-${Date.now()}.jpg`;
      const { error: upErr } = await supabase.storage.from("avatars").upload(path, blob, { upsert: true, contentType: "image/jpeg" });
      if (upErr) { toast.error(t("profile.avatarFailed")); return; }
      const { data: pubUrl } = supabase.storage.from("avatars").getPublicUrl(path);
      const url = pubUrl.publicUrl;
      const { error: updErr } = await supabase.from("profiles").update({ avatar_url: url } as any).eq("id", userId);
      if (updErr) { toast.error(t("profile.avatarFailed")); return; }
      setAvatarBroken(false);
      setProfile((p) => (p ? { ...p, avatar_url: url } : p));
      toast.success(t("profile.avatarSaved"));
    } catch (_e) {
      toast.error(t("profile.avatarFailed"));
    }
  };

  const saveBio = async () => {
    if (!userId || bioDraft === null) return;
    setSavingBio(true);
    const clean = bioDraft.trim().slice(0, 200);
    const { error } = await supabase.from("profiles").update({ bio: clean || null } as any).eq("id", userId);
    setSavingBio(false);
    if (error) { toast.error(t("profile.bioFailed")); return; }
    setProfile((p) => (p ? { ...p, bio: clean || null } : p));
    setBioDraft(null);
    toast.success(t("profile.bioSaved"));
  };

  const xpPrev = prevThreshold(stats?.level ?? 1);
  const xpPct = stats ? Math.min(Math.max((stats.total_xp - xpPrev) / Math.max(stats.xp_next_level - xpPrev, 1), 0), 1) : 0;
  const top = group[0];
  const xpToTop = top && stats && !top.is_me ? Math.max(top.total_xp - stats.total_xp, 0) : 0;

  if (loading) {
    return (
      <PageShell>
        <ProfileBackground />
        <div className="relative z-10 max-w-2xl mx-auto space-y-4">
          <Card className="h-64 animate-pulse bg-muted/40" />
          <Card className="h-40 animate-pulse bg-muted/40" />
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <ProfileBackground />
      <div className="relative z-10 max-w-2xl mx-auto space-y-4">
        {/* ---------------- header card (solid surface for readability) ---------------- */}
        <Card className="relative overflow-hidden">
          <Link to="/settings" className="absolute right-2 top-2 z-10 rounded-full bg-foreground/5 p-1.5 text-foreground/70 hover:bg-foreground/10" aria-label={t("nav.mySettings")}>
            <SettingsIcon className="h-4 w-4" />
          </Link>
          <div className="px-5 pb-5 pt-8">
            {/* avatar + streak ring + level */}
            <div className="flex flex-col items-center">
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="relative rounded-full p-[3px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                style={ringStyle(stats?.current_streak ?? 0)}
                aria-label={t("profile.changeAvatar")}
              >
                {profile?.avatar_url && !avatarBroken ? (
                  <img src={profile.avatar_url} alt="" className="h-20 w-20 rounded-full object-cover border-[3px] border-background"
                    onError={() => setAvatarBroken(true)} />
                ) : (
                  <div className="h-20 w-20 rounded-full border-[3px] border-background bg-muted flex items-center justify-center text-2xl">
                    {(profile?.name || "?").slice(0, 1).toUpperCase()}
                  </div>
                )}
                <span className="absolute bottom-0 right-0 rounded-full bg-background border p-1"><Camera className="h-3.5 w-3.5" /></span>
              </button>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAvatar(f); e.currentTarget.value = ""; }} />
              <div className="mt-1 flex items-center justify-center">
                <span className="rounded-full bg-violet-600 text-white text-[11px] font-bold px-2 py-0.5 tabular-nums">L{stats?.level ?? 1}</span>
              </div>
              <h1 className="mt-2 text-xl font-semibold tracking-tight text-center">{fullName}</h1>

              {/* group + teacher */}
              <div className="mt-2 flex flex-wrap justify-center gap-1.5">
                {pub?.group_name && (
                  <span className="rounded-full border bg-muted/40 px-2.5 py-0.5 text-xs text-muted-foreground">
                    {t("profile.group")} · <b className="text-foreground">{pub.group_name}</b>
                  </span>
                )}
                {pub?.teacher_name && (
                  <span className="rounded-full border bg-muted/40 px-2.5 py-0.5 text-xs text-muted-foreground">
                    {t("profile.teacher")} · <b className="text-foreground">{pub.teacher_name}</b>
                  </span>
                )}
              </div>

              {/* bio */}
              {bioDraft === null ? (
                <button type="button" onClick={() => setBioDraft(profile?.bio ?? "")}
                  className="mt-2 text-center text-sm text-muted-foreground max-w-md inline-flex items-start gap-1.5 hover:text-foreground">
                  <span>{profile?.bio || t("profile.addBio")}</span>
                  <Pencil className="h-3 w-3 mt-1 shrink-0" />
                </button>
              ) : (
                <div className="mt-2 w-full max-w-md">
                  <textarea value={bioDraft} onChange={(e) => setBioDraft(e.target.value)} maxLength={200} rows={2}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm" placeholder={t("profile.bioPlaceholder")} />
                  <div className="mt-1 flex items-center justify-end gap-2 text-xs">
                    <span className="text-muted-foreground tabular-nums">{bioDraft.length}/200</span>
                    <Button size="sm" variant="ghost" onClick={() => setBioDraft(null)}>{t("common.cancel")}</Button>
                    <Button size="sm" onClick={saveBio} disabled={savingBio}>{t("common.save")}</Button>
                  </div>
                </div>
              )}
            </div>

            {/* 4 tappable stats (option C shortcuts) */}
            <div className="mt-4 grid grid-cols-4 divide-x rounded-lg border bg-muted/30">
              {[
                { v: stats?.modules_completed ?? 0, l: t("profile.statModules"), s: "progress" as const },
                { v: `${stats?.current_streak ?? 0}🔥`, l: t("profile.statStreak"), s: "activity" as const, cls: "text-amber-500" },
                { v: stats?.level ?? 1, l: t("profile.statLevel"), s: "progress" as const, cls: "text-violet-500" },
                { v: stats?.group_rank ? `#${stats.group_rank}` : "—", l: t("profile.statRank"), s: "group" as const },
              ].map((it, i) => (
                <button key={i} type="button" onClick={() => openStats(it.s)}
                  className="py-2.5 text-center hover:bg-muted/50 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2">
                  <div className={`text-lg font-bold tabular-nums ${it.cls || ""}`}>{it.v}</div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{it.l}</div>
                </button>
              ))}
            </div>

            {/* XP progress to next level */}
            <div className="mt-3">
              <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
                <span>{stats?.total_xp ?? 0} XP</span>
                <span>{t("profile.nextLevel", { level: (stats?.level ?? 1) + 1 })}: {stats?.xp_next_level ?? 100} XP</span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-muted overflow-hidden">
                <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-pink-500" style={{ width: `${Math.round(xpPct * 100)}%` }} />
              </div>
            </div>

            {/* badge shelf */}
            {earnedBadges.length > 0 && (
              <div className="mt-3 flex justify-center gap-1.5" aria-label={t("profile.badges")}>
                {earnedBadges.slice(0, 6).map((b) => (
                  <span key={b.id} title={pickBadgeName(b)} className="h-8 w-8 rounded-lg border bg-muted/40 flex items-center justify-center text-base">
                    {b.icon || "🏅"}
                  </span>
                ))}
              </div>
            )}
          </div>
        </Card>

        {/* ---------------- tabs ---------------- */}
        <div className="flex gap-1 border-b overflow-x-auto" role="tablist">
          {([
            ["achievements", t("profile.tabAchievements")],
            ["group", t("profile.tabGroup")],
            ["about", t("profile.tabAbout")],
            ["stats", `📊 ${t("profile.tabStats")}`],
          ] as [Tab, string][]).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
              className={`px-3 pb-2 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ${
                tab === id ? "border-pink-500 font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
              {label}
            </button>
          ))}
        </div>

        {/* Yutuqlar */}
        {tab === "achievements" && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              {celebs.map((c) => (
                <div key={c.module_id} className="aspect-square rounded-lg overflow-hidden border bg-gradient-to-br from-violet-500/20 to-pink-500/20">
                  {c.image_url
                    ? <img src={c.image_url} alt={c.caption?.split("\n")[0] || ""} className="h-full w-full object-cover" loading="lazy" />
                    : <div className="h-full w-full flex items-center justify-center text-2xl">🏆</div>}
                </div>
              ))}
              {Array.from({ length: Math.max(0, (stats?.total_modules ?? 0) - celebs.length) }).slice(0, 6).map((_, i) => (
                <div key={`l${i}`} className="aspect-square rounded-lg border border-dashed bg-muted/30 flex items-center justify-center text-muted-foreground">🔒</div>
              ))}
            </div>
            <Card className="p-4">
              <div className="text-sm font-semibold mb-3">{t("profile.badges")} · {earnedBadges.length}/{badges.length}</div>
              <div className="grid grid-cols-4 gap-2">
                {badges.map((b) => (
                  <div key={b.id} className={`rounded-lg border p-2 text-center ${earned.has(b.id) ? "" : "opacity-35 grayscale"}`}>
                    <div className="text-xl">{b.icon || "🏅"}</div>
                    <div className="text-[10px] mt-0.5 text-muted-foreground leading-tight">{pickBadgeName(b)}</div>
                  </div>
                ))}
              </div>
              <Link to="/badges" className="mt-3 inline-block text-xs text-pink-500 hover:underline">{t("common.more")} →</Link>
            </Card>
          </div>
        )}

        {/* Guruh */}
        {tab === "group" && <GroupBoard group={group} xpToTop={xpToTop} t={t} />}

        {/* Haqida */}
        {tab === "about" && (
          <Card className="p-5 space-y-3 text-sm">
            <div><span className="text-muted-foreground">{t("profile.memberSince")}: </span>
              {profile?.created_at ? new Date(profile.created_at).toLocaleDateString() : "—"}</div>
            <div><span className="text-muted-foreground">{t("profile.watchTotal")}: </span>
              <span className="tabular-nums">{Math.round((stats?.watch_minutes_total ?? 0) / 60 * 10) / 10} {t("profile.hours")}</span></div>
            <div><span className="text-muted-foreground">{t("profile.longestStreak")}: </span>
              <span className="tabular-nums">{stats?.longest_streak ?? 0} {t("profile.days")} 🔥</span></div>
            <div className="pt-2 border-t">
              <Link to="/settings" className="text-pink-500 hover:underline">{t("nav.mySettings")} →</Link>
            </div>
          </Card>
        )}

        {/* 📊 Statistika */}
        {tab === "stats" && stats && (
          <div className="space-y-4">
            {/* course progress — full-width, absolute KPI rows */}
            <Card ref={sectionRefs.progress as any} className="p-4 scroll-mt-20">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("profile.courseProgress")}</div>
              <div className="mt-3 flex items-center gap-5">
                <Donut pct={stats.total_lessons > 0 ? stats.lessons_completed / stats.total_lessons : 0} size={104} />
                <div className="flex-1 space-y-2.5">
                  <KpiRow icon="📚" value={`${stats.lessons_completed}/${stats.total_lessons}`} label={t("profile.kpiLessonsWatched")} />
                  <KpiRow icon="📦" value={`${stats.modules_completed}/${stats.total_modules}`} label={t("profile.kpiModulesDone")} />
                  <KpiRow icon="📝" value={`${stats.homework_submitted}`} label={t("profile.kpiHwSubmitted")} />
                </div>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                {t("profile.courseDoneHint", { pct: stats.total_lessons > 0 ? Math.round((stats.lessons_completed / stats.total_lessons) * 100) : 0 })}
              </p>
            </Card>

            {/* XP & level — full-width */}
            <Card className="p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("profile.xpTitle")}</div>
              <div className="mt-3 space-y-2.5">
                <KpiRow icon="⚡" value={`${stats.total_xp} XP`} label={`${t("profile.levelWord")} ${stats.level} · ${levelName(stats.level, t)}`} valueCls="text-violet-500" />
                <KpiRow icon="🎯" value={`${Math.max(stats.xp_next_level - stats.total_xp, 0)} XP`} label={t("profile.kpiToNextLevel", { level: stats.level + 1 })} />
              </div>
              <div className="mt-3 h-2 rounded-full bg-muted overflow-hidden">
                <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-pink-500" style={{ width: `${Math.round(xpPct * 100)}%` }} />
              </div>
              <div className="mt-3 flex items-end gap-1 h-10" aria-label="XP trend">
                {xpWeeks.map((w, i) => {
                  const max = Math.max(...xpWeeks.map((x) => x.xp), 1);
                  return <div key={i} className="flex-1 rounded-t bg-gradient-to-t from-violet-500/40 to-violet-500" style={{ height: `${Math.max((w.xp / max) * 100, 4)}%` }} title={`${w.xp} XP`} />;
                })}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">{t("profile.last8Weeks")} · {t("profile.xpNote")}</p>
            </Card>

            {/* weekly activity */}
            <Card ref={sectionRefs.activity as any} className="p-4 scroll-mt-20">
              <div className="flex items-baseline justify-between">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("profile.weeklyActivity")}</div>
                <div className="text-xs tabular-nums text-amber-500 font-semibold">{stats.current_streak}🔥 · {t("profile.best")}: {stats.longest_streak}</div>
              </div>
              <div className="mt-3 flex items-end gap-2 h-24">
                {week.map((d, i) => {
                  const max = Math.max(...week.map((x) => x.minutes), 1);
                  const today = i === week.length - 1;
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center gap-1">
                      <div className={`w-full rounded-t ${today ? "bg-gradient-to-t from-pink-500/50 to-pink-500" : "bg-gradient-to-t from-violet-500/40 to-violet-500"}`}
                        style={{ height: `${Math.max((d.minutes / max) * 100, 3)}%` }} title={`${d.minutes} min`} />
                      <span className="text-[10px] text-muted-foreground">{d.day}</span>
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 space-y-2.5">
                <KpiRow icon="⏱" value={`${week.reduce((s, d) => s + d.minutes, 0)} ${t("profile.minutes")}`} label={t("profile.kpiWeekWatch")} />
                <KpiRow icon="🔥" value={`${stats.current_streak} ${t("profile.days")}`} label={t("profile.kpiStreakRow", { best: stats.longest_streak })} valueCls="text-amber-500" />
              </div>
            </Card>

            {/* homework scorecard — absolute scores, one row per assignment */}
            <Card ref={sectionRefs.homework as any} className="p-4 scroll-mt-20">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("profile.homeworkScores")}</div>
              <div className="mt-3 space-y-2.5">
                <KpiRow icon="📝" value={`${stats.homework_submitted}`} label={t("profile.kpiHwSubmitted")} />
                {stats.homework_avg_score != null && (
                  <KpiRow icon="⭐" value={`${stats.homework_avg_score}/10`} label={t("profile.kpiAvgScore")} valueCls="text-emerald-500" />
                )}
              </div>
              {homework.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">{t("profile.noHomework")}</p>
              ) : (
                <ul className="mt-4 divide-y">
                  {homework.map((h, i) => (
                    <li key={i} className="flex items-center gap-3 py-2 text-sm">
                      <span className="flex-1 truncate">
                        <span className="text-muted-foreground tabular-nums">{h.module_pos + 1}-modul</span>
                        {h.module_title ? <span className="text-muted-foreground"> · {h.module_title}</span> : null}
                      </span>
                      {h.score == null ? (
                        <span className="text-xs text-muted-foreground">⏳ {t("profile.hwPending")}</span>
                      ) : (
                        <span className={`font-bold tabular-nums ${h.score >= 9 ? "text-emerald-500" : h.score >= 6 ? "text-violet-500" : "text-amber-500"}`}>
                          {h.score}/{h.max_score} {t("profile.points")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* group rating */}
            <div ref={sectionRefs.group} className="scroll-mt-20">
              <GroupBoard group={group.slice(0, 5)} xpToTop={xpToTop} t={t} compact />
            </div>

            {/* wrapped share card */}
            <Card className="p-5 text-center bg-gradient-to-br from-violet-600/15 via-pink-500/10 to-amber-400/15 border-pink-500/30">
              <div className="text-2xl font-extrabold tracking-tight bg-gradient-to-r from-amber-400 to-pink-500 bg-clip-text text-transparent tabular-nums">
                {stats.group_rank ? `#${stats.group_rank}` : "★"} · {stats.current_streak}🔥 · {stats.total_xp} XP
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{pub?.group_name ? `${pub.group_name} · ` : ""}AI Creators</div>
              <Button
                className="mt-3" size="sm"
                onClick={async () => {
                  const text = t("profile.shareText", { rank: stats.group_rank ?? "★", streak: stats.current_streak, xp: stats.total_xp });
                  try {
                    if (navigator.share) await navigator.share({ text });
                    else { await navigator.clipboard.writeText(text); toast.success(t("profile.copied")); }
                  } catch { /* user cancelled */ }
                }}>
                <Share2 className="h-4 w-4 mr-1.5" /> {t("profile.share")}
              </Button>
            </Card>
          </div>
        )}
      </div>
    </PageShell>
  );
}

/* ------------------------------------------------------------ group board */

function GroupBoard({ group, xpToTop, t, compact }: { group: GroupRow[]; xpToTop: number; t: any; compact?: boolean }) {
  if (group.length === 0) {
    return <Card className="p-6 text-center text-sm text-muted-foreground">{t("profile.noGroup")}</Card>;
  }
  return (
    <Card className="p-4">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">{t("profile.groupRating")}</div>
      <ul className="space-y-1">
        {group.map((r) => (
          <li key={r.user_id}
            className={`flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm ${r.is_me ? "bg-violet-500/10 border border-violet-500/30 font-semibold" : ""}`}>
            <span className="w-6 text-muted-foreground tabular-nums">{r.rank}</span>
            <span className="flex-1 truncate">{r.first_name} {r.last_initial ? r.last_initial + "." : ""}{r.is_me ? ` (${t("profile.you")})` : ""}</span>
            <span className="text-xs text-amber-500 tabular-nums">{r.current_streak > 0 ? `${r.current_streak}🔥` : ""}</span>
            <span className="w-14 text-right text-violet-500 tabular-nums font-semibold">{r.total_xp}</span>
          </li>
        ))}
      </ul>
      {xpToTop > 0 && (
        <div className="mt-2 text-xs text-muted-foreground tabular-nums">{t("profile.toFirst", { xp: xpToTop })} ↑</div>
      )}
      <div className="mt-2 text-[11px] text-muted-foreground">{t("profile.groupDesc")}</div>
    </Card>
  );
}

/* ------------------------------------------------------------- KPI row */

function KpiRow({ icon, value, label, valueCls }: { icon: string; value: string; label: string; valueCls?: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-base w-6 text-center" aria-hidden>{icon}</span>
      <span className={`font-bold tabular-nums whitespace-nowrap ${valueCls || ""}`}>{value}</span>
      <span className="text-sm text-muted-foreground truncate">{label}</span>
    </div>
  );
}

/** Named levels (status framing beats bare numbers). Clamps to the last name. */
function levelName(level: number, t: any): string {
  const names: string[] = t("profile.levelNames", { returnObjects: true }) as any;
  if (!Array.isArray(names) || names.length === 0) return "";
  return names[Math.min(Math.max(level - 1, 0), names.length - 1)];
}
