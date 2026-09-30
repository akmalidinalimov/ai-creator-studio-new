/**
 * Shared rules for the student number screens (Home/Dashboard, Profil, Reyting — web and Mini App).
 *
 * 1. A FAILED profile_stats read is a failure, never zeros. profile_stats(uid) is SECURITY DEFINER with
 *    its caller gate in a WHERE clause, so a failed gate returns HTTP 200 with an EMPTY array, while a
 *    passing gate always returns exactly one row. An error (timeout, grant regression) or an empty
 *    array used to render "0 XP, level 1, Bronza" as if true, and it also wrote that as the
 *    celebration baseline, so the next good load fired a FALSE level-up + tier-up.
 *
 * 2. No rank without points. When every member of a group is at 0 (every Challenge 6.0 group on day
 *    1), group_leaderboard / profile_stats still number them 1..N by streak and then by uuid — an
 *    arbitrary "#17" or a 🥈 next to 0. A rank or a medal is shown only for a score of at least 1.
 */

export interface DbErrorLike {
  code?: string | null;
  message?: string | null;
}

export type StatsRead<T> = { ok: true; row: T } | { ok: false; code: string };

/** Read one row from an RPC result, treating an error OR an empty result as a failure. */
export function readStatsRow<T = Record<string, unknown>>(res: { data: unknown; error: DbErrorLike | null }): StatsRead<T> {
  if (res.error) return { ok: false, code: String(res.error.code || res.error.message || "error") };
  const row = Array.isArray(res.data) ? res.data[0] : res.data;
  if (row == null || typeof row !== "object") return { ok: false, code: "empty" };
  return { ok: true, row: row as T };
}

/** The rank to show, or null ("—") when the student has no points yet or there is no rank. */
export function displayRank(rank: number | null | undefined, score: number | null | undefined): number | null {
  if (rank == null || !Number.isFinite(rank) || rank < 1) return null;
  if (score == null || !Number.isFinite(score) || score <= 0) return null;
  return rank;
}

/** The podium: the top three, but only members who actually have points (no medal for 0). */
export function podiumRows<T extends { total_xp: number }>(ranked: T[]): T[] {
  return ranked.slice(0, 3).filter((r) => r.total_xp > 0);
}
