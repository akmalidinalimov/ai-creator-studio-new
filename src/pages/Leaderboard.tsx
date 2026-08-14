import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Trophy } from "lucide-react";
import { TierProgress, tierBadge, type TierInfo } from "@/components/TierProgress";

/* Group-only rating: each student sees ONLY their own group, ranked by XP.
   No cross-group / whole-course mixing (owner decision, 2026-07-06). */

interface Row {
  rank: number; user_id: string; first_name: string; last_initial: string;
  total_xp: number; level: number; current_streak: number; is_me: boolean;
}

export default function Leaderboard() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[]>([]);
  const [tierInfo, setTierInfo] = useState<TierInfo | null>(null);
  const [groupName, setGroupName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const [boardRes, pubRes] = await Promise.all([
          supabase.rpc("group_leaderboard" as any, { uid: user.id, _limit: 50 }),
          supabase.rpc("public_profile" as any, { _uid: user.id }),
        ]);
        if (boardRes.error) throw boardRes.error;
        if (cancelled) return;
        const board = ((boardRes.data as any) || []) as Row[];
        setRows(board);
        const pub: any = Array.isArray(pubRes.data) ? pubRes.data[0] : pubRes.data;
        setGroupName(pub?.group_name || null);
        // Tier ladder (from my total) → my "almost there" hook + per-row badges.
        const myXp = board.find((r) => r.is_me)?.total_xp ?? 0;
        supabase.rpc("xp_tier_for" as any, { _total: myXp }).then(({ data: ti }) => {
          if (!cancelled && ti) setTierInfo(ti as TierInfo);
        });
      } catch (e) {
        if (cancelled) return;
        console.error("[Leaderboard] load failed", e);
        setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user, reloadKey]);

  const me = rows.find((r) => r.is_me);
  const top = rows[0];
  const xpToTop = me && top && !top.is_me ? Math.max(top.total_xp - me.total_xp, 0) : 0;

  return (
    <PageShell>
      <div className="max-w-3xl space-y-6">
        <div className="flex items-center gap-3">
          <Trophy className="h-7 w-7 text-yellow-500" />
          <h1 className="text-3xl font-semibold tracking-tight">
            🏆 {groupName ? `${groupName} — ${t("profile.groupRating")}` : t("profile.groupRating")}
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">{t("profile.groupDesc")}</p>

        {tierInfo && <TierProgress info={tierInfo} />}

        <Card className="overflow-hidden shadow-soft">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium w-12">#</th>
                <th className="text-left px-4 py-2.5 font-medium">{t("profile.student")}</th>
                <th className="text-right px-4 py-2.5 font-medium">XP</th>
                <th className="text-right px-4 py-2.5 font-medium">{t("profile.statLevel")}</th>
                <th className="text-right px-4 py-2.5 font-medium">🔥</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">{t("common.loading")}</td></tr>}
              {!loading && error && (
                <tr><td colSpan={5} className="px-4 py-6 text-center">
                  <button
                    type="button"
                    onClick={() => setReloadKey((k) => k + 1)}
                    className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  >
                    {t("common.retry")}
                  </button>
                </td></tr>
              )}
              {!loading && !error && rows.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">{t("profile.noGroup")}</td></tr>
              )}
              {!error && rows.map((r) => {
                const tb = tierBadge(r.total_xp, tierInfo?.tiers);
                return (
                <tr key={r.user_id} className={`border-t ${r.is_me ? "bg-primary/5 font-semibold" : ""}`}>
                  <td className="px-4 py-2.5 tabular-nums">
                    {r.rank === 1 ? "🥇" : r.rank === 2 ? "🥈" : r.rank === 3 ? "🥉" : r.rank}
                  </td>
                  <td className="px-4 py-2.5">
                    {tb.emoji && <span title={tb.name} className="mr-1" aria-label={tb.name}>{tb.emoji}</span>}
                    {r.first_name} {r.last_initial ? r.last_initial + "." : ""}{r.is_me ? ` (${t("profile.you")})` : ""}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-primary font-semibold">{r.total_xp}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">L{r.level}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{r.current_streak || ""}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </Card>

        {xpToTop > 0 && (
          <Card className="p-4 text-sm tabular-nums">{t("profile.toFirst", { xp: xpToTop })} ↑</Card>
        )}
      </div>
    </PageShell>
  );
}
