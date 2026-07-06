import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Camera, Pencil, Settings as SettingsIcon, Users } from "lucide-react";
import { toast } from "sonner";
import { BrandCover } from "@/pages/Profile";

interface TeacherStats { groups_count: number; students_total: number; graded_total: number; avg_score_given: number | null }
interface TeacherGroup {
  group_id: string; group_name: string; course_name: string | null;
  total_students: number; active_7d: number; avg_completion_pct: number; pending_homework: number;
}
interface TopStudent {
  rank: number; first_name: string; last_initial: string;
  total_xp: number; level: number; current_streak: number; completed_lessons: number;
}
interface ProfileRow { name: string | null; last_name: string | null; avatar_url: string | null; bio: string | null; created_at: string }

/** Mentor variant of the profile: gold ring, group stats, one-tap group switching. */
export default function TeacherProfile() {
  const { user, role } = useAuth();
  const { t } = useTranslation();
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [stats, setStats] = useState<TeacherStats | null>(null);
  const [groups, setGroups] = useState<TeacherGroup[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [top, setTop] = useState<TopStudent[]>([]);
  const [topLoading, setTopLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [bioDraft, setBioDraft] = useState<string | null>(null);
  const [savingBio, setSavingBio] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const [pRes, sRes, gRes] = await Promise.all([
          supabase.from("profiles").select("name, last_name, avatar_url, bio, created_at").eq("id", user.id).maybeSingle(),
          supabase.rpc("teacher_profile_stats" as any, { uid: user.id }),
          supabase.rpc("teacher_groups" as any, { uid: user.id }),
        ]);
        if (cancelled) return;
        setProfile((pRes.data as any) || null);
        const sRow: any = Array.isArray(sRes.data) ? sRes.data[0] : sRes.data;
        setStats(sRow || null);
        const gs = ((gRes.data as any) || []) as TeacherGroup[];
        setGroups(gs);
        if (gs.length > 0) setSelected(gs[0].group_id);
      } catch (e) {
        console.error("[TeacherProfile] load failed", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  // Top students of the selected group (re-fetched on switch).
  useEffect(() => {
    if (!user || !selected) { setTop([]); return; }
    let cancelled = false;
    setTopLoading(true);
    supabase.rpc("teacher_group_top" as any, { uid: user.id, _group_id: selected, _limit: 5 })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) console.error("[TeacherProfile] top failed", error);
        setTop(((data as any) || []) as TopStudent[]);
        setTopLoading(false);
      });
    return () => { cancelled = true; };
  }, [user, selected]);

  const uploadAvatar = async (file: File) => {
    if (!user) return;
    if (file.size > 4 * 1024 * 1024) { toast.error(t("profile.avatarTooBig")); return; }
    const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
    const path = `${user.id}/avatar-${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage.from("avatars").upload(path, file, { upsert: true, contentType: file.type });
    if (upErr) { toast.error(t("profile.avatarFailed")); return; }
    const { data: pub } = supabase.storage.from("avatars").getPublicUrl(path);
    const { error: updErr } = await supabase.from("profiles").update({ avatar_url: pub.publicUrl } as any).eq("id", user.id);
    if (updErr) { toast.error(t("profile.avatarFailed")); return; }
    setProfile((p) => (p ? { ...p, avatar_url: pub.publicUrl } : p));
    toast.success(t("profile.avatarSaved"));
  };

  const saveBio = async () => {
    if (!user || bioDraft === null) return;
    setSavingBio(true);
    const clean = bioDraft.trim().slice(0, 200);
    const { error } = await supabase.from("profiles").update({ bio: clean || null } as any).eq("id", user.id);
    setSavingBio(false);
    if (error) { toast.error(t("profile.bioFailed")); return; }
    setProfile((p) => (p ? { ...p, bio: clean || null } : p));
    setBioDraft(null);
    toast.success(t("profile.bioSaved"));
  };

  const fullName = [profile?.name, profile?.last_name].filter(Boolean).join(" ") || t("profile.teacher");
  const sel = groups.find((g) => g.group_id === selected) || null;

  if (loading) {
    return (
      <PageShell>
        <div className="max-w-2xl mx-auto space-y-4">
          <Card className="h-64 animate-pulse bg-muted/40" />
          <Card className="h-40 animate-pulse bg-muted/40" />
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <div className="max-w-2xl mx-auto space-y-4">
        {/* header — gold mentor treatment */}
        <Card className="overflow-hidden">
          <BrandCover>
            <Link to="/settings" className="absolute right-3 top-3 z-10 rounded-full bg-white/10 p-1.5 text-white hover:bg-white/20" aria-label={t("nav.mySettings")}>
              <SettingsIcon className="h-4 w-4" />
            </Link>
          </BrandCover>
          <div className="px-5 pb-5 -mt-10">
            <div className="flex flex-col items-center">
              <button type="button" onClick={() => fileRef.current?.click()}
                className="relative rounded-full p-[3px] bg-gradient-to-tr from-amber-400 via-yellow-300 to-amber-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                aria-label={t("profile.changeAvatar")}>
                {profile?.avatar_url ? (
                  <img src={profile.avatar_url} alt="" className="h-20 w-20 rounded-full object-cover border-[3px] border-background" />
                ) : (
                  <div className="h-20 w-20 rounded-full border-[3px] border-background bg-muted flex items-center justify-center text-2xl">
                    {(profile?.name || "?").slice(0, 1).toUpperCase()}
                  </div>
                )}
                <span className="absolute bottom-0 right-0 rounded-full bg-background border p-1"><Camera className="h-3.5 w-3.5" /></span>
              </button>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAvatar(f); e.currentTarget.value = ""; }} />
              <div className="mt-1">
                <span className="rounded-full bg-amber-500 text-white text-[11px] font-bold px-2.5 py-0.5">
                  {role === "admin" ? "Admin" : t("profile.teacherBadge")}
                </span>
              </div>
              <h1 className="mt-2 text-xl font-semibold tracking-tight text-center">{fullName}</h1>

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
                    <button className="rounded-md border px-2 py-1 hover:bg-muted" onClick={() => setBioDraft(null)}>{t("common.cancel")}</button>
                    <button className="rounded-md bg-primary text-primary-foreground px-2 py-1 disabled:opacity-50" onClick={saveBio} disabled={savingBio}>{t("common.save")}</button>
                  </div>
                </div>
              )}
            </div>

            {/* mentor stat row */}
            <div className="mt-4 grid grid-cols-4 divide-x rounded-lg border">
              {[
                { v: stats?.groups_count ?? 0, l: t("profile.tGroups") },
                { v: stats?.students_total ?? 0, l: t("profile.tStudents") },
                { v: stats?.graded_total ?? 0, l: t("profile.tGraded") },
                { v: stats?.avg_score_given ?? "—", l: t("profile.tAvgScore"), cls: "text-amber-500" },
              ].map((it, i) => (
                <div key={i} className="py-2.5 text-center">
                  <div className={`text-lg font-bold tabular-nums ${it.cls || ""}`}>{it.v}</div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{it.l}</div>
                </div>
              ))}
            </div>
          </div>
        </Card>

        {/* group switcher — one tap per group */}
        {groups.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">{t("profile.tNoGroups")}</Card>
        ) : (
          <>
            <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label={t("profile.tGroups")}>
              {groups.map((g) => (
                <button key={g.group_id} role="tab" aria-selected={selected === g.group_id}
                  onClick={() => setSelected(g.group_id)}
                  className={`shrink-0 rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
                    selected === g.group_id
                      ? "border-amber-500 bg-amber-500/10 font-semibold text-foreground"
                      : "text-muted-foreground hover:text-foreground"}`}>
                  <Users className="inline h-3.5 w-3.5 mr-1.5 -mt-0.5" />
                  {g.group_name}
                </button>
              ))}
            </div>

            {sel && (
              <div className="space-y-4">
                {/* selected group stats */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { v: sel.total_students, l: t("profile.tMembers") },
                    { v: sel.active_7d, l: t("profile.tActive7d"), cls: "text-emerald-500" },
                    { v: `${sel.avg_completion_pct}%`, l: t("profile.tCompletion"), cls: "text-violet-500" },
                    { v: sel.pending_homework, l: t("profile.tPending"), cls: sel.pending_homework > 0 ? "text-amber-500" : "" },
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

                {/* top students of the group */}
                <Card className="p-4">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
                    {t("profile.tTopStudents")} · {sel.group_name}
                  </div>
                  {topLoading ? (
                    <div className="h-24 animate-pulse bg-muted/40 rounded-md" />
                  ) : top.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("profile.tNoStudents")}</p>
                  ) : (
                    <ul className="space-y-1">
                      {top.map((s) => (
                        <li key={s.rank} className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm">
                          <span className="w-6 text-muted-foreground tabular-nums">{s.rank}</span>
                          <span className="flex-1 truncate">{s.first_name} {s.last_initial ? s.last_initial + "." : ""}</span>
                          <span className="text-xs text-muted-foreground tabular-nums">{s.completed_lessons} {t("profile.lessons")}</span>
                          <span className="text-xs text-amber-500 tabular-nums">{s.current_streak > 0 ? `${s.current_streak}🔥` : ""}</span>
                          <span className="w-14 text-right text-violet-500 tabular-nums font-semibold">{s.total_xp}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-3 flex gap-3 text-xs">
                    <Link to="/teacher/homework" className="text-pink-500 hover:underline">{t("profile.tGradeHomework")} →</Link>
                    <Link to="/admin/dashboard" className="text-muted-foreground hover:underline">{t("nav.adminDashboard")} →</Link>
                  </div>
                </Card>
              </div>
            )}
          </>
        )}
      </div>
    </PageShell>
  );
}
