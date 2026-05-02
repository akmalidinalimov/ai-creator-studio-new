import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";

export function EngagementTiles() {
  const { user } = useAuth();
  const [streak, setStreak] = useState(0);
  const [goal, setGoal] = useState({ target: 1, done: 0 });
  const [badgeStats, setBadgeStats] = useState({ earned: 0, total: 0 });

  useEffect(() => {
    if (!user) return;
    (async () => {
      const [{ data: s }, { data: g }, { data: badges }, { data: mine }] = await Promise.all([
        supabase.from("streaks").select("current_streak").eq("user_id", user.id).maybeSingle(),
        supabase.rpc("daily_goal_progress", { uid: user.id }),
        supabase.from("badges").select("id"),
        supabase.from("user_badges").select("badge_id, earned_at").eq("user_id", user.id),
      ]);
      setStreak(s?.current_streak || 0);
      const row: any = Array.isArray(g) ? g[0] : (g as any);
      if (row) setGoal({ target: row.target ?? 1, done: row.done ?? 0 });
      setBadgeStats({ earned: (mine || []).length, total: (badges || []).length });

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
    })();
  }, [user]);

  const streakColor = streak === 0 ? "text-red-500" : streak < 7 ? "text-orange-500" : "text-green-500";
  const goalPct = Math.min(100, (goal.done / Math.max(goal.target, 1)) * 100);
  const radius = 22, circ = 2 * Math.PI * radius;

  return (
    <div className="grid grid-cols-3 gap-3">
      <Card className="p-4 shadow-soft">
        <div className="text-xs text-muted-foreground">🔥 Streak</div>
        <div className={`text-2xl font-bold tabular-nums mt-1 ${streakColor}`}>{streak}</div>
        <div className="text-xs text-muted-foreground">kun</div>
      </Card>

      <Card className="p-4 shadow-soft flex items-center justify-between gap-2">
        <div>
          <div className="text-xs text-muted-foreground">🎯 Bugungi maqsad</div>
          <div className="text-lg font-bold tabular-nums mt-1">{goal.done}/{goal.target}</div>
          <div className="text-xs text-muted-foreground">dars</div>
        </div>
        <svg width="56" height="56" className="-rotate-90 shrink-0">
          <circle cx="28" cy="28" r={radius} fill="none" stroke="hsl(var(--muted))" strokeWidth="5" />
          <circle cx="28" cy="28" r={radius} fill="none" stroke="hsl(var(--primary))" strokeWidth="5"
            strokeDasharray={circ} strokeDashoffset={circ - (circ * goalPct) / 100} strokeLinecap="round" />
        </svg>
      </Card>

      <Link to="/badges" className="block">
        <Card className="p-4 shadow-soft hover:bg-muted/40 transition cursor-pointer h-full">
          <div className="text-xs text-muted-foreground">🏅 Nishonlar</div>
          <div className="text-2xl font-bold tabular-nums mt-1">{badgeStats.earned}<span className="text-muted-foreground text-base">/{badgeStats.total}</span></div>
          <div className="text-xs text-muted-foreground">olingan</div>
        </Card>
      </Link>
    </div>
  );
}
