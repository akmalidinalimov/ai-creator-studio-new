// ONE group ranking for every rank a student sees in Telegram: the bot's 👤 Profil card ("🏆 #r/n"),
// 📊 Statistika, 👥 Guruh reytingi, and the Sunday weekly digest. All of them read public.group_leaderboard,
// the SAME primitive as the web / Mini App Reyting tab, ordered the same way as profile_stats.group_rank
// (Dashboard / Profile): user_group_rating_xp(member, the group's course) desc, streak desc, id.
//
// Why this module exists: until 2026-09-30 📊 Statistika ranked by leaderboard_cache, a 30-day activity index
// normalised across every cohort and blind to challenge points, under the same "Guruh reytingi" title as the
// 👥 button one tap away. 160 of 165 active 5.0 students saw two different ranks. A second rank source is the
// bug class, so every renderer takes a GroupRanking built here and nothing else.
//
// Zero points: a member with no points is ordered by streak and then by uuid, so their "rank" means nothing
// (a whole 6.0 group on day 1 would get ranks like #17/40 and medals next to ⚡0). A rank and a medal are shown
// only for a member with at least 1 point. myRank() is null otherwise, and an all-zero group shows no rank.
//
// A failed read never blocks the screen. The caller shows a "try again later" line instead of a rank, and the
// failure is DB-visible (graceful is not silent): one `group_rank_load_failed` admin_actions row per part and
// user per Tashkent day (logHealthOnce).
import { logHealthOnce } from "./edge.ts";

// A service-role Supabase client (typed loosely, like the rest of the codebase).
// deno-lint-ignore no-explicit-any
type Db = any;

/** One public.group_leaderboard row. total_xp is the member's course-scoped rating, not global XP. */
export type GroupBoardRow = {
  rank: number;
  user_id: string;
  first_name: string;
  last_initial: string;
  total_xp: number;
  level: number;
  current_streak: number;
};

export type GroupRanking = {
  /** The whole group in rank order (1..size). */
  rows: GroupBoardRow[];
  /** The member this ranking was built for; null when they are not an active member of the group. */
  me: GroupBoardRow | null;
  size: number;
  /** The best score in the group (0 when nobody has points yet). */
  topPoints: number;
};

/** group_leaderboard's _limit. Far above any group (the largest has 73); the RPC ranks the whole group anyway. */
export const GROUP_RANK_LIMIT = 5000;

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Pure: group_leaderboard rows → a GroupRanking for `meId`. Tolerates null / junk input (→ empty ranking). */
export function toRanking(raw: unknown, meId: string | null): GroupRanking {
  const rows: GroupBoardRow[] = (Array.isArray(raw) ? raw : [])
    // deno-lint-ignore no-explicit-any
    .filter((r: any) => r && typeof r.user_id === "string" && num(r.rank) > 0)
    // deno-lint-ignore no-explicit-any
    .map((r: any) => ({
      rank: num(r.rank),
      user_id: r.user_id,
      first_name: typeof r.first_name === "string" && r.first_name ? r.first_name : "Talaba",
      last_initial: typeof r.last_initial === "string" ? r.last_initial : "",
      total_xp: num(r.total_xp),
      level: num(r.level) || 1,
      current_streak: num(r.current_streak),
    }))
    .sort((a, b) => a.rank - b.rank);
  const me = meId ? rows.find((r) => r.user_id === meId) ?? null : null;
  return { rows, me, size: rows.length, topPoints: rows.reduce((m, r) => Math.max(m, r.total_xp), 0) };
}

/** A member has a meaningful rank only with at least 1 point. */
export const hasPoints = (row: GroupBoardRow | null | undefined): boolean => !!row && row.total_xp > 0;

/** `userId`'s rank in the group, or null when they are not in it or have no points yet. */
export function rankOf(r: GroupRanking, userId: string): { rank: number; size: number; points: number } | null {
  const row = r.rows.find((x) => x.user_id === userId);
  return row && hasPoints(row) ? { rank: row.rank, size: r.size, points: row.total_xp } : null;
}

/** The viewer's own rank (see rankOf). The card, 📊 Statistika and 👥 Guruh reytingi all print this number. */
export function myRank(r: GroupRanking): { rank: number; size: number; points: number } | null {
  return r.me ? rankOf(r, r.me.user_id) : null;
}

/** The rank cell: 🥇🥈🥉 for the top three, "N." below, and "–" for anyone with no points (no fake rank). */
export function rankLabel(row: GroupBoardRow): string {
  if (!hasPoints(row)) return "–";
  return row.rank === 1 ? "🥇" : row.rank === 2 ? "🥈" : row.rank === 3 ? "🥉" : `${row.rank}.`;
}

/** The rows within `around` places of the viewer (📊 Statistika's window). Empty without a ranked viewer. */
export function rankWindow(r: GroupRanking, around = 2): GroupBoardRow[] {
  const me = myRank(r);
  if (!me) return [];
  return r.rows.filter((x) => x.rank >= me.rank - around && x.rank <= me.rank + around);
}

/** Points the viewer needs to reach the place above them; null at #1 or without a ranked viewer. */
export function gapAbove(r: GroupRanking): { rank: number; gap: number } | null {
  const me = myRank(r);
  if (!me || me.rank <= 1) return null;
  const above = r.rows.find((x) => x.rank === me.rank - 1);
  return above ? { rank: above.rank, gap: Math.max(0, above.total_xp - me.points) } : null;
}

/** Monday of the current Tashkent week as YYYY-MM-DD: date_trunc('week', now() at time zone 'Asia/Tashkent'). */
export function tashkentWeekStart(now: Date = new Date()): string {
  const d = new Date(now.getTime() + 5 * 3_600_000); // UTC+5, no DST
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * The weekly star to show beside the ranking, or null. weekly_group_star is picked by the 30-day ACTIVITY score
 * (pick_weekly_group_stars), so it is shown only when the pick had a positive score AND the star still has at least
 * 1 point in this ranking: never a 0-score "star", never one in an all-zero group, never someone who left.
 */
export function starToShow(
  r: GroupRanking,
  star: { user_id: string; score: number | null } | null,
): { row: GroupBoardRow; isMe: boolean } | null {
  if (!star || !(num(star.score) > 0)) return null;
  const row = r.rows.find((x) => x.user_id === star.user_id);
  if (!row || !hasPoints(row)) return null;
  return { row, isMe: !!r.me && r.me.user_id === row.user_id };
}

async function signalFailure(admin: Db, part: string, userId: string, message: string, source: string) {
  await logHealthOnce(admin, "group_rank_load_failed", `${part}:${userId}`, { part, error: message.slice(0, 300) }, {
    targetUserId: userId,
    source,
  });
}

/**
 * The group ranking as `userId` sees it (their group, their course). `failed` is true when the RPC errored: the
 * caller must then say "try again" rather than "you are not in a group". Never throws.
 */
export async function loadGroupRanking(
  admin: Db,
  userId: string,
  source = "edge",
): Promise<{ ranking: GroupRanking; failed: boolean }> {
  try {
    const { data, error } = await admin.rpc("group_leaderboard", { uid: userId, _limit: GROUP_RANK_LIMIT });
    if (error) {
      await signalFailure(admin, "ranking", userId, String(error.message || error.code || "error"), source);
      return { ranking: toRanking([], userId), failed: true };
    }
    return { ranking: toRanking(data, userId), failed: false };
  } catch (e) {
    await signalFailure(admin, "ranking", userId, String((e as Error)?.message || e), source);
    return { ranking: toRanking([], userId), failed: true };
  }
}

/** This week's weekly_group_star row for a group (user_id + activity score), or null. Never throws. */
export async function loadWeeklyStar(
  admin: Db,
  groupId: string,
  userId: string,
  source = "edge",
  now: Date = new Date(),
): Promise<{ user_id: string; score: number | null } | null> {
  try {
    const { data, error } = await admin.from("weekly_group_star").select("user_id, score")
      .eq("group_id", groupId).eq("week_start", tashkentWeekStart(now)).maybeSingle();
    if (error) {
      await signalFailure(admin, "star", userId, String(error.message || error.code || "error"), source);
      return null;
    }
    return data && typeof data.user_id === "string" ? { user_id: data.user_id, score: data.score ?? null } : null;
  } catch (e) {
    await signalFailure(admin, "star", userId, String((e as Error)?.message || e), source);
    return null;
  }
}
