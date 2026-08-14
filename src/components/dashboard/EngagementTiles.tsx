import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ProgressRing } from "@/components/dashboard/ProgressRing";
import { Flame, Target, Award, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { TierProgress, type TierInfo } from "@/components/TierProgress";

export function EngagementTiles() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [streak, setStreak] = useState(0);
  const [goal, setGoal] = useState({ target: 1, done: 0 });
  const [badgeStats, setBadgeStats] = useState({ earned: 0, total: 0 });
  const [tierInfo, setTierInfo] = useState<TierInfo | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const [{ data: s }, { data: g }, { data: badges }, { data: mine }, { data: xp }] = await Promise.all([
          supabase.from("streaks").select("current_streak").eq("user_id", user.id).maybeSingle(),
          supabase.rpc("daily_goal_progress", { uid: user.id }),
          supabase.from("badges").select("id"),
          supabase.from("user_badges").select("badge_id, earned_at").eq("user_id", user.id),
          supabase.from("user_xp" as any).select("total_xp").eq("user_id", user.id).maybeSingle(),
        ]);
        if (cancelled) return;
        setStreak(s?.current_streak || 0);
        const row: any = Array.isArray(g) ? g[0] : (g as any);
        if (row) setGoal({ target: row.target ?? 1, done: row.done ?? 0 });
        // Count only badges that still exist in the catalog (exclude imported orphan awards → no >total inflation).
        const catalogIds = new Set((badges || []).map((b: any) => b.id));
        setBadgeStats({ earned: (mine || []).filter((b: any) => catalogIds.has(b.badge_id)).length, total: (badges || []).length });

        // Prestige tier + "almost there" hook; celebrate a tier-up once (localStorage, like badges).
        const totalXp = (xp as any)?.total_xp ?? 0;
        const { data: ti } = await supabase.rpc("xp_tier_for" as any, { _total: totalXp });
        if (!cancelled && ti) {
          setTierInfo(ti as TierInfo);
          const seenTier = Number(localStorage.getItem("seen_tier") || "0");
          const idx = (ti as any).tier_index ?? 0;
          if (seenTier > 0 && idx > seenTier) {
            toast.success(`Yangi bosqich: ${(ti as any).tier_emoji} ${(ti as any).tier_name}! 🎉`);
          }
          localStorage.setItem("seen_tier", String(idx));
        }

        // Toast newly-earned badges (last 1 hour)
        const recent = (mine || []).filter((b: any) => new Date(b.earned_at).getTime() > Date.now() - 3600_000);
        if (recent.length) {
          const seen = JSON.parse(localStorage.getItem("seen_badges") || "[]");
          const namesById: Record<string, string> = {};
          const { data: bn } = await supabase.from("badges").select("id, name_uz");
          (bn || []).forEach((b: any) => { namesById[b.id] = b.name_uz; });
          recent.forEach((b: any) => {
            if (!seen.includes(b.badge_id)) {
              toast.success(`Yangi nishon: ${namesById[b.badge_id] || ""} 🎉`);
              seen.push(b.badge_id);
            }
          });
          localStorage.setItem("seen_badges", JSON.stringify(seen));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
      </div>
    );
  }

  // Positive-only streak treatment: never alarm-red. Warms as it grows.
  const streakTone = streak >= 7 ? "text-primary" : streak > 0 ? "text-orange-500" : "text-muted-foreground";
  const goalPct = Math.min(100, (goal.done / Math.max(goal.target, 1)) * 100);
  const goalDone = goal.done >= goal.target;

  return (
    <div className="space-y-3">
      {tierInfo && <TierProgress info={tierInfo} />}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <Card className="p-4 shadow-soft flex items-center gap-3">
        <span className={`inline-flex items-center justify-center w-11 h-11 rounded-xl bg-muted ${streakTone}`}>
          <Flame className="h-5 w-5" />
        </span>
        <div>
          <div className="text-xs text-muted-foreground font-medium">Seriya</div>
          <div className="text-2xl font-bold tabular-nums leading-tight">{streak} <span className="text-sm font-medium text-muted-foreground">kun</span></div>
        </div>
      </Card>

      <Card className="p-4 shadow-soft flex items-center justify-between gap-2">
        <div>
          <div className="text-xs text-muted-foreground font-medium flex items-center gap-1.5"><Target className="h-3.5 w-3.5" /> Bugungi maqsad</div>
          <div className="text-2xl font-bold tabular-nums mt-1 leading-tight">{goal.done}<span className="text-muted-foreground">/{goal.target}</span> <span className="text-sm font-medium text-muted-foreground">dars</span></div>
        </div>
        <ProgressRing value={goalPct} size={52} stroke={5} className="shrink-0" label={goalDone ? "✓" : `${Math.round(goalPct)}%`} />
      </Card>

      <Link to="/badges" className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
        <Card className="p-4 shadow-soft hover:bg-muted/40 hover:shadow-elevated transition-all duration-200 cursor-pointer h-full flex items-center gap-3">
          <span className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-muted text-primary">
            <Award className="h-5 w-5" />
          </span>
          <div className="flex-1">
            <div className="text-xs text-muted-foreground font-medium">Nishonlar</div>
            <div className="text-2xl font-bold tabular-nums leading-tight">{badgeStats.earned}<span className="text-muted-foreground text-base font-semibold">/{badgeStats.total}</span></div>
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground" />
        </Card>
      </Link>
      </div>
    </div>
  );
}
