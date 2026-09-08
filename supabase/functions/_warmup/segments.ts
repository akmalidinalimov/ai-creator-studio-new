// _warmup/segments.ts — S0–S5, recomputed nightly after the score freeze (SPEC §6.9).
//
// Returns Effect[] rather than writing. Segments are domain state, so they change the same way
// everything else does: through the applier. That also makes the whole computation a pure function
// of rows in, effects out — testable without a database.
//
// The definitions are engine rules, not campaign content: no pack value renames or re-thresholds
// them. What IS pack-driven is everything downstream — which segment gets which nudge, which proof,
// which sequence branch.

import type { CampaignPack, Effect } from "./types.ts";
import { zonedDateKey, zonedTimeToInstant } from "./pack.ts";

export type Segment = "S0" | "S1" | "S2" | "S3" | "S4" | "S5";

export const SEGMENT_MEANING: Record<Segment, string> = {
  S0: "never pressed Start — unreachable by DM",
  S1: "activated, no engagement yet",
  S2: "engaged — active within the last day",
  S3: "quiet — was active, then silent for a full day or more",
  S4: "committed to an event",
  S5: "champion — top of the leaderboard and still active",
};

/** How many top-ranked participants count as champions. Engine policy. */
export const CHAMPION_RANK_CUTOFF = 10;

export interface SegmentInput {
  telegramId: number;
  startedBot: boolean;
  lastActiveAt: string | null;
  committedEvents: string[];
  rank: number | null;
  totalPoints: number;
  currentSegment: string;
}

/**
 * Precedence, highest first: S5 → S4 → S3 → S2 → S1 → S0.
 *
 * Note that S3 (quiet) outranks S2 but sits BELOW S4 (committed), so a committed participant who
 * goes quiet still reads as S4. That is deliberate for labelling — but event reminders must gate on
 * `committed_events` directly, never on `segment === 'S4'`, or a committed participant who drifts
 * into another segment silently stops being reminded about the event they signed up for.
 */
export function computeSegment(p: SegmentInput, now: Date, tz: string): Segment {
  // S0 first and unconditionally: without a Start press there is no DM channel, so no nudge,
  // sequence or scorecard can reach them whatever else is true.
  if (!p.startedBot) return "S0";

  const quiet = isQuiet(p.lastActiveAt, now, tz);

  if (!quiet && p.rank !== null && p.rank > 0 && p.rank <= CHAMPION_RANK_CUTOFF && p.totalPoints > 0) return "S5";
  if (p.committedEvents.length > 0) return "S4";
  if (quiet && p.lastActiveAt) return "S3";
  if (p.lastActiveAt) return "S2";
  return "S1";
}

/** Silent for at least one full calendar day in the pack timezone. */
function isQuiet(lastActiveAt: string | null, now: Date, tz: string): boolean {
  if (!lastActiveAt) return false;              // never active is S1, not quiet
  const todayStart = zonedTimeToInstant(zonedDateKey(now, tz), "00:00", tz).getTime();
  return new Date(lastActiveAt).getTime() < todayStart;
}

/**
 * Recompute every participant's segment. Emits a setSegment effect ONLY where the label actually
 * changes — a no-op update per participant per night would be thousands of pointless writes.
 */
export async function recomputeSegments(
  admin: any,
  pack: CampaignPack,
  now: Date = new Date(),
): Promise<{ effects: Effect[]; scanned: number; changed: Record<string, number> }> {
  const wm = admin.schema("warmup");
  const tz = pack.manifest.timezone;

  const { data: participants, error } = await wm.from("participants")
    .select("telegram_id, started_bot, last_active_at, committed_events, segment");
  if (error) throw new Error(`segments: cannot read participants: ${error.message}`);

  const { data: ranks } = await wm.from("ranks").select("telegram_id, total_points, rank");
  const byId = new Map<number, { rank: number; total: number }>(
    ((ranks || []) as Record<string, unknown>[]).map((r) => [
      Number(r.telegram_id), { rank: Number(r.rank), total: Number(r.total_points) },
    ]),
  );

  const effects: Effect[] = [];
  const changed: Record<string, number> = {};

  for (const row of (participants || []) as Record<string, unknown>[]) {
    const telegramId = Number(row.telegram_id);
    const scored = byId.get(telegramId);
    const next = computeSegment({
      telegramId,
      startedBot: !!row.started_bot,
      lastActiveAt: (row.last_active_at ?? null) as string | null,
      committedEvents: ((row.committed_events ?? []) as string[]),
      rank: scored?.rank ?? null,
      totalPoints: scored?.total ?? 0,
      currentSegment: String(row.segment),
    }, now, tz);

    if (next !== row.segment) {
      effects.push({ kind: "setSegment", telegramId, segment: next });
      changed[next] = (changed[next] ?? 0) + 1;
    }
  }

  return { effects, scanned: (participants || []).length, changed };
}
