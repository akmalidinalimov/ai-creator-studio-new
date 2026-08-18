import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Camera, Zap, TrendingUp, Flame, Award, Globe, Bell, Eye, ChevronRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import TeacherProfile from "@/components/profile/TeacherProfile";
import { tierFor, xpToNextTier, formatXp } from "@/lib/xp";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import {
  Card,
  StatTile,
  TierBar,
  TierBadge,
  SectionHeader,
  Button,
  EmptyState,
  Skeleton,
} from "@/components/ui-kit";

/* ------------------------------------------------------------------ types */

interface ProfileRow {
  name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  telegram_username: string | null;
  hide_from_group_boards: boolean | null;
}

interface StatsRow {
  total_xp: number;
  level: number;
  group_rank: number | null;
  badges_earned: number;
  current_streak: number;
}

interface EarnedBadge {
  id: string;
  icon: string | null;
  name_uz: string;
  name_ru: string;
  name_en: string;
}

/* ------------------------------------------------------------------ page */

export default function Profile() {
  const { user, role } = useAuth();

  // Teachers/admins get the mentor variant of the same page.
  if (role === "teacher" || role === "admin") return <TeacherProfile />;
  return <StudentProfile userId={user?.id ?? null} />;
}

function StudentProfile({ userId }: { userId: string | null }) {
  const { t, i18n } = useTranslation();
  const lng = (i18n.language || "uz").slice(0, 2);
  const locale = i18n.language;

  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [groupName, setGroupName] = useState<string | null>(null);
  const [stats, setStats] = useState<StatsRow | null>(null);
  const [earnedBadges, setEarnedBadges] = useState<EarnedBadge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [avatarBroken, setAvatarBroken] = useState(false);
  const [savingVis, setSavingVis] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const [pRes, pubRes, sRes, ubRes] = await Promise.all([
          supabase
            .from("profiles")
            .select("name, last_name, avatar_url, telegram_username, hide_from_group_boards")
            .eq("id", userId)
            .maybeSingle(),
          supabase.rpc("public_profile" as any, { _uid: userId }),
          // profile_stats(uid): total_xp (user_xp.total_xp — drives the tier), level,
          // group_rank (user_group_rating_xp-based), badges_earned (catalog-joined, orphan-safe)
          // and current_streak — the exact fields xp-data-sources.md pins for this screen, in one
          // round trip (same RPC Home/Dashboard.tsx already uses).
          supabase.rpc("profile_stats" as any, { uid: userId }),
          // Orphan-safe by construction: `badges!inner(...)` drops any user_badges row whose
          // badge_id no longer exists in the catalog (badge-orphan-count lesson).
          supabase
            .from("user_badges")
            .select("badges!inner(id, icon, name_uz, name_ru, name_en)")
            .eq("user_id", userId),
        ]);
        if (cancelled) return;
        setProfile((pRes.data as any) || null);
        const pubRow: any = Array.isArray(pubRes.data) ? pubRes.data[0] : pubRes.data;
        setGroupName(pubRow?.group_name ?? null);
        const sRow: any = Array.isArray(sRes.data) ? sRes.data[0] : sRes.data;
        setStats(sRow || null);
        const eb = (((ubRes.data as any) || []) as any[])
          .map((r) => r.badges)
          .filter(Boolean) as EarnedBadge[];
        setEarnedBadges(eb);
      } catch (e) {
        if (!cancelled) {
          console.error("[Profile] load failed", e);
          setError(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, reloadKey]);

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

  // Self-service board-visibility opt-out (board-visibility-optout lesson). set_board_visibility
  // is self-or-admin; here the caller always targets their own id. Display-visibility only — XP,
  // /leaderboard and the teacher/admin digest are untouched (see the RPC's own comment).
  const onVisibilityChange = async (checked: boolean) => {
    if (!userId) return;
    setSavingVis(true);
    const { error } = await supabase.rpc("set_board_visibility" as any, { _student: userId, _hidden: !checked });
    setSavingVis(false);
    if (error) { toast.error(t("profile.boardVisibilityFailed")); return; }
    setProfile((p) => (p ? { ...p, hide_from_group_boards: !checked } : p));
    toast.success(checked ? t("profile.boardVisibilityShown") : t("profile.boardVisibilityHidden"));
  };

  const pickBadgeName = (b: EarnedBadge) => (lng === "ru" ? b.name_ru : lng === "en" ? b.name_en : b.name_uz);
  const fullName = [profile?.name, profile?.last_name].filter(Boolean).join(" ") || t("profile.student");

  // Tier is driven by user_xp.total_xp (profile_stats.total_xp), NEVER user_group_rating_xp
  // (xp-ranking-primitive / xp-data-sources.md). tierFor().name is Uzbek regardless of locale —
  // an accepted, known limitation (shared across Home/Reyting).
  const totalXp = stats?.total_xp ?? 0;
  const tier = tierFor(totalXp);
  const toNextXp = xpToNextTier(totalXp);
  const nextTierName = tier.next !== null ? tierFor(tier.next).name : null;
  const tierPct = toNextXp === null ? 100 : Math.round(((totalXp - tier.min) / Math.max(tier.next! - tier.min, 1)) * 100);

  const currentLangLabel = SUPPORTED_LANGUAGES.find((l) => l.code === lng)?.label ?? "";
  const visible = !(profile?.hide_from_group_boards ?? false);

  if (loading) {
    return (
      <PageShell>
        <div className="max-w-2xl mx-auto space-y-4">
          <Skeleton className="h-44 w-full rounded-lg" />
          <div className="grid grid-cols-4 gap-2">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-md" />)}
          </div>
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-32 w-full rounded-lg" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      </PageShell>
    );
  }

  if (error) {
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    return (
      <PageShell>
        <div className="max-w-2xl mx-auto">
          <EmptyState
            icon={offline ? "📡" : "⚠️"}
            title={offline ? t("common.offlineTitle") : t("common.errorTitle")}
            body={offline ? t("common.offlineBody") : t("profile.loadError")}
            cta={
              <Button variant="secondary" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
                {t("common.retry")}
              </Button>
            }
          />
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <div className="max-w-2xl mx-auto space-y-4">
        {/* header: avatar + name + @username · group + streak */}
        <Card className="flex flex-col items-center gap-1 text-center">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="relative rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            aria-label={t("profile.changeAvatar")}
          >
            {profile?.avatar_url && !avatarBroken ? (
              <img
                src={profile.avatar_url}
                alt=""
                className="h-20 w-20 rounded-full border-2 border-border object-cover"
                onError={() => setAvatarBroken(true)}
              />
            ) : (
              <div className="grid h-20 w-20 place-items-center rounded-full border-2 border-border bg-tint text-2xl font-extrabold text-primary">
                {(profile?.name || "?").slice(0, 1).toUpperCase()}
              </div>
            )}
            <span className="absolute -bottom-1 -right-1 rounded-full border border-border bg-card p-1.5 text-muted-foreground">
              <Camera className="h-3.5 w-3.5" />
            </span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAvatar(f); e.currentTarget.value = ""; }}
          />
          <h1 className="mt-1 break-words text-xl font-extrabold tracking-tight text-foreground">{fullName}</h1>
          {(profile?.telegram_username || groupName) && (
            <div className="text-sm font-semibold text-muted-foreground">
              {profile?.telegram_username ? <span>@{profile.telegram_username}</span> : null}
              {profile?.telegram_username && groupName ? <span> · </span> : null}
              {groupName ? <span className="uppercase">{groupName}</span> : null}
            </div>
          )}
        </Card>

        {/* 4 stat tiles — matches the mockup's Profil stat grid exactly: XP / Daraja / Seriya /
            Nishon. NOT the Home tiles (Home swaps Seriya for Reyting/rank — rank lives on the
            Reyting screen only, per review). */}
        <div className="grid grid-cols-4 gap-2">
          <StatTile icon={<Zap />} label={t("home.statXp")} value={formatXp(totalXp, locale)} highlight />
          <StatTile icon={<TrendingUp />} label={t("home.statLevel")} value={formatXp(stats?.level ?? 1, locale)} />
          <StatTile icon={<Flame />} label={t("home.statStreak")} value={formatXp(stats?.current_streak ?? 0, locale)} />
          <StatTile icon={<Award />} label={t("home.statBadges")} value={formatXp(stats?.badges_earned ?? 0, locale)} />
        </div>

        {/* tier progress */}
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <TierBadge tier={tier.key} />
            {toNextXp !== null && nextTierName ? (
              <span className="text-xs font-bold tabular-nums text-muted-foreground">
                {t("profile.tierNudge", { tier: nextTierName, xp: formatXp(toNextXp, locale) })}
              </span>
            ) : (
              <span className="text-good text-xs font-bold">{t("profile.tierMax")}</span>
            )}
          </div>
          <TierBar pct={tierPct} className="mt-3" />
        </Card>

        {/* earned badges */}
        <SectionHeader
          title={t("profile.badges")}
          action={earnedBadges.length > 0 ? formatXp(earnedBadges.length, locale) : undefined}
        />
        {earnedBadges.length === 0 ? (
          <EmptyState icon="🏅" title={t("profile.noBadgesTitle")} body={t("profile.noBadgesBody")} />
        ) : (
          <div className="grid grid-cols-4 gap-2">
            {earnedBadges.map((b) => (
              <Card key={b.id} className="p-2.5 text-center">
                <div className="text-2xl">{b.icon || "🏅"}</div>
                <div className="mt-1 text-[10.5px] font-semibold leading-tight text-muted-foreground">
                  {pickBadgeName(b)}
                </div>
              </Card>
            ))}
          </div>
        )}

        {/* settings */}
        <SectionHeader title={t("profile.settingsTitle")} />
        <Card className="divide-y divide-border p-0">
          <Link to="/settings" className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-tint/40">
            <Globe className="size-[18px] flex-none text-muted-foreground" />
            <span className="flex-1 text-[13.5px] font-bold text-foreground">{t("profile.settingsLanguage")}</span>
            <span className="text-xs font-semibold text-muted-foreground">{currentLangLabel}</span>
            <ChevronRight className="size-4 flex-none text-muted-foreground" />
          </Link>
          <Link to="/settings" className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-tint/40">
            <Bell className="size-[18px] flex-none text-muted-foreground" />
            <span className="flex-1 text-[13.5px] font-bold text-foreground">{t("profile.settingsNotifications")}</span>
            <ChevronRight className="size-4 flex-none text-muted-foreground" />
          </Link>
          <div className="flex items-center gap-3 px-4 py-3.5">
            <Eye className="size-[18px] flex-none text-muted-foreground" />
            <label htmlFor="board-visibility" className="flex-1 text-[13.5px] font-bold text-foreground">
              {t("profile.settingsBoardVisibility")}
            </label>
            <Switch id="board-visibility" checked={visible} disabled={savingVis} onCheckedChange={onVisibilityChange} />
          </div>
        </Card>
      </div>
    </PageShell>
  );
}
