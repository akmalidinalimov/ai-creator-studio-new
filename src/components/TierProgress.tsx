import { useTranslation } from "react-i18next";

// Shape returned by the xp_tier_for(total) RPC.
export type TierInfo = {
  total: number;
  tier_index: number;
  tier_name: string;
  tier_emoji: string;
  tier_min: number;
  next_name: string | null;
  next_emoji: string | null;
  next_min: number | null;
  xp_to_next: number;
  progress: number; // 0..1 toward the next tier (1 when at max)
  is_max: boolean;
  tiers?: { name: string; emoji: string; min_xp: number }[]; // full ladder (asc by min_xp)
};

/** Current tier badge for an arbitrary total, from the ladder (asc by min_xp). */
export function tierBadge(total: number, tiers?: { name: string; emoji: string; min_xp: number }[]): { emoji: string; name: string } {
  if (!tiers?.length) return { emoji: "", name: "" };
  let cur = tiers[0];
  for (const t of tiers) if (t.min_xp <= total) cur = t;
  return { emoji: cur.emoji, name: cur.name };
}

/**
 * Prestige tier + "almost there" hook. Shown on the profile and dashboard.
 * Recognition-only: the tier badge + distance-to-next is the reward surface.
 */
export function TierProgress({ info, className = "" }: { info: TierInfo; className?: string }) {
  const { t } = useTranslation();
  const pct = Math.round(Math.min(Math.max(info.progress ?? 0, 0), 1) * 100);
  const nextLabel = `${info.next_emoji ?? ""} ${info.next_name ?? ""}`.trim();

  return (
    <div className={`rounded-xl border bg-card p-4 shadow-soft ${className}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-3xl leading-none" aria-hidden>{info.tier_emoji}</span>
          <div className="text-xl font-bold leading-tight truncate">{info.tier_name}</div>
        </div>
        <div className="text-right shrink-0">
          {info.is_max ? (
            <span className="text-sm font-semibold text-amber-500">{t("profile.tierMax")}</span>
          ) : (
            <span className="text-sm text-muted-foreground">
              {t("profile.tierToNext", { xp: info.xp_to_next, tier: nextLabel })}
            </span>
          )}
        </div>
      </div>
      <div className="mt-3 h-2 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-amber-400 to-amber-600 transition-all duration-500"
          style={{ width: `${info.is_max ? 100 : pct}%` }}
        />
      </div>
    </div>
  );
}
