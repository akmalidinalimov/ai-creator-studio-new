// The three places the bot prints a student's group rank, rendered from ONE GroupRanking
// (_shared/group-rank.ts → public.group_leaderboard):
//   👤 Profil card      "🏆 #r/n"
//   👥 Guruh reytingi   the top 10, plus the viewer's own row when they are below it
//   📊 Statistika       the ±2 window around the viewer, "Guruhdagi o'rningiz: r/n", the weekly star
// rank-views.test.ts renders all three for every member of a real-shaped group and asserts they print the SAME
// rank (and that nobody with 0 points gets a rank or a medal). Pure: strings come from the caller's locale table.
import {
  gapAbove,
  type GroupBoardRow,
  type GroupRanking,
  hasPoints,
  myRank,
  rankLabel,
  rankWindow,
  starToShow,
} from "../_shared/group-rank.ts";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** "Ali V." — first name plus the last-name initial, HTML-escaped. */
export const displayName = (row: GroupBoardRow): string =>
  esc(`${row.first_name}${row.last_initial ? " " + row.last_initial + "." : ""}`);

/** The lines shown instead of a rank. Shared by the board and 📊 Statistika. */
export type NoRankStrings = {
  noPointsYet: string; // the whole group is at 0 points
  meNoPoints: string; // others have points, the viewer has none
};

/** 👤 Profil card: "🏆 #r/n", or null when the viewer has no points (or no group). */
export function cardRankBit(r: GroupRanking): string | null {
  const m = myRank(r);
  return m ? `🏆 #${m.rank}/${m.size}` : null;
}

export type BoardStrings = NoRankStrings & {
  you: string;
  toFirst: (xp: number) => string;
};

/** 👥 Guruh reytingi: body lines under the title. The caller handles "no group" and a failed load. */
export function boardLines(r: GroupRanking, s: BoardStrings, limit = 10): string[] {
  if (r.topPoints <= 0) return [s.noPointsYet];
  const row = (x: GroupBoardRow) => {
    const isMe = !!r.me && x.user_id === r.me.user_id;
    const nm = isMe ? `<b>${esc(x.first_name)} (${s.you})</b>` : displayName(x);
    return `${rankLabel(x)} ${nm} — ⚡${x.total_xp}${x.current_streak > 0 ? ` · ${x.current_streak}🔥` : ""}`;
  };
  const top = r.rows.slice(0, limit);
  const lines = top.map(row);
  const me = r.me;
  if (me && hasPoints(me) && !top.some((x) => x.user_id === me.user_id)) lines.push("…", row(me));
  if (me && !hasPoints(me)) lines.push("", s.meNoPoints);
  const m = myRank(r);
  if (m && m.rank > 1) lines.push("", s.toFirst(Math.max(r.topPoints - m.points, 0)));
  return lines;
}

export type StatsStrings = NoRankStrings & {
  title: string;
  row: (rankLabel: string, name: string, score: number) => string;
  rowMe: (rankLabel: string, score: number) => string;
  summary: (rank: number, total: number, gap: string) => string;
  gap: (nextRank: number, gap: number) => string;
  star: (name: string) => string;
  starMe: string;
};

/** 📊 Statistika: the group block (title first). `star` is this week's weekly_group_star row, if any. */
export function statsRankLines(
  r: GroupRanking,
  s: StatsStrings,
  star: { user_id: string; score: number | null } | null,
): string[] {
  if (r.topPoints <= 0) return [s.title, s.noPointsYet];
  const m = myRank(r);
  if (!m) return [s.title, s.meNoPoints];
  const lines = [s.title];
  for (const x of rankWindow(r)) {
    if (x.user_id === r.me!.user_id) lines.push(s.rowMe(rankLabel(x), x.total_xp));
    else lines.push(s.row(rankLabel(x), displayName(x), x.total_xp));
  }
  const g = gapAbove(r);
  lines.push("", s.summary(m.rank, m.size, g ? s.gap(g.rank, g.gap) : ""));
  const st = starToShow(r, star);
  if (st) lines.push(st.isMe ? s.starMe : s.star(displayName(st.row)));
  return lines;
}
