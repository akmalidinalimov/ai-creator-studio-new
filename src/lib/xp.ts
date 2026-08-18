// XP / tier helper — spec §7 ladder (0/300/600/1000/1500 → Bronze/Silver/Gold/Platinum/Diamond).
// Client-side, static ladder for the redesigned Mini App UI (ui-kit TierBadge/TierBar/Celebrate
// consume this). Distinct from the DB-backed, tunable `xp_tier_for` RPC used by the pre-redesign
// TierProgress/EngagementTiles/Leaderboard/Profile — see task-1.5-report.md for the note.

export type TierKey = "bronze" | "silver" | "gold" | "platinum" | "diamond";

export interface TierInfo {
  key: TierKey;
  name: string;
  min: number;
  next: number | null;
}

const TIERS = [
  { key: "bronze", name: "Bronza", min: 0 },
  { key: "silver", name: "Kumush", min: 300 },
  { key: "gold", name: "Oltin", min: 600 },
  { key: "platinum", name: "Platina", min: 1000 },
  { key: "diamond", name: "Olmos", min: 1500 },
] as const;

export function tierFor(totalXp: number): TierInfo {
  let i = 0;
  for (let k = 0; k < TIERS.length; k++) if (totalXp >= TIERS[k].min) i = k;
  const next = TIERS[i + 1]?.min ?? null;
  return { ...TIERS[i], next };
}

export function xpToNextTier(totalXp: number): number | null {
  const n = tierFor(totalXp).next;
  return n === null ? null : n - totalXp;
}

export function formatXp(n: number, locale: string): string {
  return new Intl.NumberFormat(locale === "en" ? "en-US" : locale === "ru" ? "ru-RU" : "uz-UZ").format(n);
}
