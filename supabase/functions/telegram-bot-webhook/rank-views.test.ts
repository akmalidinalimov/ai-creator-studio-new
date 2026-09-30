// DETECTOR: 📊 Statistika's group rank == 👥 Guruh reytingi's rank == the 👤 Profil card's 🏆 rank, for every
// member of a group, and nobody with 0 points is ranked or gets a medal.
//
// Before 2026-09-30 Statistika ranked by leaderboard_cache (30-day activity, global) and the other two by
// group_leaderboard (course points): 160 of 165 active 5.0 students saw two different ranks one tap apart.
// All three now render from one GroupRanking; this test renders each view for every member of real-shaped
// groups and fails if any two ever disagree.
// Run: deno test supabase/functions/telegram-bot-webhook/rank-views.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type GroupRanking, toRanking } from "../_shared/group-rank.ts";
import { boardLines, type BoardStrings, cardRankBit, statsRankLines, type StatsStrings } from "./rank-views.ts";

const BOARD: BoardStrings = {
  you: "Siz",
  toFirst: (xp) => `Birinchi o'ringa ${xp} XP qoldi ↑`,
  noPointsYet: "NO_POINTS_YET",
  meNoPoints: "ME_NO_POINTS",
};
const STATS: StatsStrings = {
  title: "🏆 <b>Guruh reytingi</b>",
  row: (l, n, s) => `${l} ${n} — ⚡${s}`,
  rowMe: (l, s) => `<b>${l} 👉 Siz — ⚡${s}</b>`,
  summary: (r, t, g) => `📊 Guruhdagi o'rningiz: <b>${r}/${t}</b>${g}`,
  gap: (n, g) => ` · ${n}-o'ringa ${g} XP qoldi`,
  star: (n) => `⭐ Hafta yulduzi: <b>${n}</b>`,
  starMe: "⭐ STAR_ME",
  noPointsYet: "NO_POINTS_YET",
  meNoPoints: "ME_NO_POINTS",
};

const MEDAL: Record<string, number> = { "🥇": 1, "🥈": 2, "🥉": 3 };
const labelRank = (label: string): number | null => MEDAL[label] ?? (/^(\d+)\.$/.test(label) ? Number(label.slice(0, -1)) : null);

/** The rank each surface prints for the viewer; null = no rank shown. */
function printedRanks(r: GroupRanking) {
  const card = cardRankBit(r);
  const cardRank = card ? Number(/^🏆 #(\d+)\/(\d+)$/.exec(card)![1]) : null;
  const cardSize = card ? Number(/^🏆 #(\d+)\/(\d+)$/.exec(card)![2]) : null;

  const stats = statsRankLines(r, STATS, null);
  const summary = stats.find((l) => l.startsWith("📊 Guruhdagi o'rningiz"));
  const statsRank = summary ? Number(/<b>(\d+)\/(\d+)<\/b>/.exec(summary)![1]) : null;
  const statsSize = summary ? Number(/<b>(\d+)\/(\d+)<\/b>/.exec(summary)![2]) : null;
  const meRow = stats.find((l) => l.includes("👉 Siz"));
  const statsRowRank = meRow ? labelRank(/^<b>(\S+) 👉/.exec(meRow)![1]) : null;

  const board = boardLines(r, BOARD);
  const boardMe = board.find((l) => l.includes(`(${BOARD.you})`));
  const boardRank = boardMe ? labelRank(boardMe.split(" ")[0]) : null;
  return { cardRank, cardSize, statsRank, statsSize, statsRowRank, boardRank, stats, board };
}

// A live-shaped group (1-GURUH VIP 5.0 on 2026-09-30: 73 members, top 2700, 3 at 0 points, 63 below the top 10),
// scaled down: 24 members, ties on points broken by streak, 3 with no points.
function vipLikeGroup() {
  const pts = [2700, 2582, 2034, 1900, 1900, 1900, 1500, 1200, 1200, 900, 880, 700, 650, 600, 420, 300, 300, 150, 90, 40, 12, 0, 0, 0];
  const streaks = [49, 30, 12, 9, 4, 0, 7, 3, 3, 2, 0, 1, 0, 5, 0, 2, 0, 0, 1, 0, 0, 3, 0, 0];
  return pts.map((p, i) => ({
    rank: i + 1, user_id: `u${String(i + 1).padStart(2, "0")}`, first_name: `Ism${i + 1}`, last_initial: "F",
    total_xp: p, level: 1, current_streak: streaks[i], is_me: false,
  }));
}

Deno.test("DETECTOR: card, 📊 Statistika and 👥 Guruh reytingi print the same rank for every member", () => {
  const rows = vipLikeGroup();
  for (const me of rows) {
    const r = toRanking(rows, me.user_id);
    const p = printedRanks(r);
    if (me.total_xp > 0) {
      assertEquals(p.cardRank, me.rank, `card rank for ${me.user_id}`);
      assertEquals(p.statsRank, me.rank, `Statistika summary rank for ${me.user_id}`);
      assertEquals(p.statsRowRank, me.rank, `Statistika window row for ${me.user_id}`);
      assertEquals(p.boardRank, me.rank, `Guruh reytingi rank for ${me.user_id}`);
      assertEquals([p.cardSize, p.statsSize], [rows.length, rows.length]);
    } else {
      // 0 points: the order among them is streak-then-uuid, so no surface may print a rank or a medal.
      assertEquals([p.cardRank, p.statsRank, p.statsRowRank], [null, null, null], `0-point ${me.user_id} must not be ranked`);
      assertEquals(p.stats, [STATS.title, STATS.meNoPoints]);
      assert(p.board.includes(BOARD.meNoPoints));
      assert(p.boardRank === null, "a 0-point viewer's board row carries no rank");
    }
  }
});

Deno.test("👥 board: top 10, then '…' and the viewer's own ranked row when they are below it", () => {
  const rows = vipLikeGroup();
  const inTop = boardLines(toRanking(rows, "u03"), BOARD);
  assertEquals(inTop.filter((l) => l.startsWith("🥇") || l.startsWith("🥈") || l.startsWith("🥉")).length, 3);
  assert(!inTop.includes("…"));
  const below = boardLines(toRanking(rows, "u15"), BOARD);
  assertEquals(below.slice(10, 12), ["…", "15. <b>Ism15 (Siz)</b> — ⚡420"]);
  assertEquals(below.at(-1), BOARD.toFirst(2700 - 420));
  // #1 gets no "to reach #1" line.
  assert(!boardLines(toRanking(rows, "u01"), BOARD).some((l) => l.includes("Birinchi o'ringa")));
});

Deno.test("👥 board and 📊: a 0-point member in the visible rows is '–', never a medal", () => {
  // Only two members have points: the third row is 0 points and must not read 🥉.
  const rows = [
    { rank: 1, user_id: "a", first_name: "A", last_initial: "", total_xp: 5, level: 1, current_streak: 0 },
    { rank: 2, user_id: "b", first_name: "B", last_initial: "", total_xp: 3, level: 1, current_streak: 0 },
    { rank: 3, user_id: "c", first_name: "C", last_initial: "", total_xp: 0, level: 1, current_streak: 6 },
  ];
  const board = boardLines(toRanking(rows, "a"), BOARD);
  assertEquals(board.slice(0, 3), ["🥇 <b>A (Siz)</b> — ⚡5", "🥈 B — ⚡3", "– C — ⚡0 · 6🔥"]);
  const stats = statsRankLines(toRanking(rows, "b"), STATS, null);
  assertEquals(stats.slice(1, 4), ["🥇 A — ⚡5", "<b>🥈 👉 Siz — ⚡3</b>", "– C — ⚡0"]);
  assertEquals(stats.at(-1), "📊 Guruhdagi o'rningiz: <b>2/3</b> · 1-o'ringa 2 XP qoldi");
});

Deno.test("all-zero group (6.0 day 1): no rank, no medal, no star anywhere", () => {
  const rows = ["a", "b", "c", "d"].map((id, i) => ({
    rank: i + 1, user_id: id, first_name: id.toUpperCase(), last_initial: "", total_xp: 0, level: 1, current_streak: 4 - i,
  }));
  for (const me of rows) {
    const r = toRanking(rows, me.user_id);
    assertEquals(cardRankBit(r), null);
    assertEquals(boardLines(r, BOARD), [BOARD.noPointsYet]);
    assertEquals(statsRankLines(r, STATS, { user_id: "a", score: 0 }), [STATS.title, STATS.noPointsYet]);
    assertEquals(statsRankLines(r, STATS, { user_id: "a", score: 55 }), [STATS.title, STATS.noPointsYet]);
  }
});

Deno.test("📊 star line: shown for a positive-score star with points, hidden otherwise", () => {
  const rows = vipLikeGroup();
  const r = toRanking(rows, "u05");
  assertEquals(statsRankLines(r, STATS, { user_id: "u02", score: 64 }).at(-1), "⭐ Hafta yulduzi: <b>Ism2 F.</b>");
  assertEquals(statsRankLines(r, STATS, { user_id: "u05", score: 64 }).at(-1), STATS.starMe);
  assert(!statsRankLines(r, STATS, { user_id: "u02", score: 0 }).some((l) => l.includes("⭐")));
  assert(!statsRankLines(r, STATS, { user_id: "u23", score: 40 }).some((l) => l.includes("⭐"))); // 0 points
});

Deno.test("names are HTML-escaped in every view", () => {
  const rows = [
    { rank: 1, user_id: "a", first_name: "<b>x</b>", last_initial: "&", total_xp: 9, level: 1, current_streak: 0 },
    { rank: 2, user_id: "b", first_name: "B", last_initial: "", total_xp: 1, level: 1, current_streak: 0 },
  ];
  const r = toRanking(rows, "b");
  assert(boardLines(r, BOARD)[0].includes("&lt;b&gt;x&lt;/b&gt; &amp;."));
  assert(statsRankLines(r, STATS, null)[1].includes("&lt;b&gt;x&lt;/b&gt; &amp;."));
});
