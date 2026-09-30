// Tests for the one group ranking. Run: deno test supabase/functions/_shared/group-rank.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  gapAbove,
  GROUP_RANK_LIMIT,
  hasPoints,
  loadGroupRanking,
  loadWeeklyStar,
  myRank,
  rankLabel,
  rankOf,
  rankWindow,
  starToShow,
  tashkentWeekStart,
  toRanking,
} from "./group-rank.ts";

// group_leaderboard rows exactly as PostgREST returns them (live shape, 2026-09-30): rank int, total_xp is the
// member's course-scoped rating, ties already broken by streak then id.
const row = (rank: number, id: string, xp: number, streak = 0, extra: Record<string, unknown> = {}) => ({
  rank, user_id: id, first_name: `N${rank}`, last_initial: "", total_xp: xp, level: 1, current_streak: streak, is_me: false,
  ...extra,
});

Deno.test("toRanking: ordered rows, me by user_id (not is_me), size, top points", () => {
  const raw = [row(2, "b", 50), row(1, "a", 90, 3), row(3, "c", 0)];
  const r = toRanking(raw, "b");
  assertEquals(r.rows.map((x) => x.user_id), ["a", "b", "c"]);
  assertEquals(r.me?.user_id, "b");
  assertEquals(r.size, 3);
  assertEquals(r.topPoints, 90);
  // is_me in the payload is ignored: the weekly digest reads one member's board for everyone in the group.
  assertEquals(toRanking([row(1, "a", 5, 0, { is_me: true })], "zzz").me, null);
});

Deno.test("toRanking: tolerates null / junk / string numbers", () => {
  assertEquals(toRanking(null, "a"), { rows: [], me: null, size: 0, topPoints: 0 });
  assertEquals(toRanking({ nope: 1 }, "a").size, 0);
  const r = toRanking([{ rank: "1", user_id: "a", total_xp: "12", first_name: null }, { rank: 0, user_id: "x" }, null], "a");
  assertEquals(r.size, 1);
  assertEquals(r.rows[0].total_xp, 12);
  assertEquals(r.rows[0].first_name, "Talaba");
});

Deno.test("no rank for 0 points: myRank / rankOf are null, the label is '–'", () => {
  const r = toRanking([row(1, "a", 10), row(2, "b", 0, 5), row(3, "c", 0)], "b");
  assertEquals(myRank(r), null);
  assertEquals(rankOf(r, "c"), null);
  assertEquals(rankOf(r, "a"), { rank: 1, size: 3, points: 10 });
  assertEquals(rankOf(r, "nobody"), null);
  assertEquals(rankLabel(r.rows[1]), "–"); // #2 by streak tie-break, but 0 points: no 🥈
  assertEquals(hasPoints(r.rows[0]), true);
  assertEquals(hasPoints(null), false);
});

Deno.test("all-zero group (Challenge 6.0 on day 1): nobody is ranked, no medals", () => {
  const r = toRanking([row(1, "a", 0, 4), row(2, "b", 0), row(3, "c", 0)], "a");
  assertEquals(r.topPoints, 0);
  assertEquals(r.rows.map((x) => rankOf(r, x.user_id)), [null, null, null]);
  assertEquals(r.rows.map(rankLabel), ["–", "–", "–"]);
  assertEquals(rankWindow(r), []);
  assertEquals(gapAbove(r), null);
});

Deno.test("rankLabel: medals only for the top three with points", () => {
  const r = toRanking([row(1, "a", 30), row(2, "b", 20), row(3, "c", 10), row(4, "d", 5)], "a");
  assertEquals(r.rows.map(rankLabel), ["🥇", "🥈", "🥉", "4."]);
});

Deno.test("rankWindow: ±2 around the viewer, clipped at the edges", () => {
  const rows = Array.from({ length: 8 }, (_, i) => row(i + 1, `u${i + 1}`, 100 - i));
  assertEquals(rankWindow(toRanking(rows, "u1")).map((x) => x.rank), [1, 2, 3]);
  assertEquals(rankWindow(toRanking(rows, "u5")).map((x) => x.rank), [3, 4, 5, 6, 7]);
  assertEquals(rankWindow(toRanking(rows, "u8")).map((x) => x.rank), [6, 7, 8]);
  assertEquals(rankWindow(toRanking(rows, "u5"), 1).map((x) => x.rank), [4, 5, 6]);
});

Deno.test("gapAbove: points to the next place, 0 on a tie, null at #1", () => {
  const r = toRanking([row(1, "a", 120), row(2, "b", 80, 5), row(3, "c", 80, 1)], "c");
  assertEquals(gapAbove(r), { rank: 2, gap: 0 }); // tied on points, behind on streak
  assertEquals(gapAbove(toRanking(r.rows, "b")), { rank: 1, gap: 40 });
  assertEquals(gapAbove(toRanking(r.rows, "a")), null);
});

Deno.test("tashkentWeekStart = date_trunc('week', now() at time zone 'Asia/Tashkent')", () => {
  // Sunday 2026-10-04 18:59 UTC = 23:59 Tashkent Sunday → week of Monday 09-28.
  assertEquals(tashkentWeekStart(new Date("2026-10-04T18:59:00Z")), "2026-09-28");
  // Sunday 19:00 UTC = Monday 00:00 Tashkent → the new week.
  assertEquals(tashkentWeekStart(new Date("2026-10-04T19:00:00Z")), "2026-10-05");
  assertEquals(tashkentWeekStart(new Date("2026-09-30T12:00:00Z")), "2026-09-28");
  assertEquals(tashkentWeekStart(new Date("2026-10-05T04:00:00Z")), "2026-10-05"); // student-of-week cron time
});

Deno.test("starToShow: never a 0-score star, a 0-point star, or a star who left the group", () => {
  const r = toRanking([row(1, "a", 90), row(2, "b", 40), row(3, "c", 0)], "b");
  assertEquals(starToShow(r, { user_id: "a", score: 64 })?.row.user_id, "a");
  assertEquals(starToShow(r, { user_id: "a", score: 64 })?.isMe, false);
  assertEquals(starToShow(r, { user_id: "b", score: 12 })?.isMe, true);
  assertEquals(starToShow(r, { user_id: "a", score: 0 }), null); // picked when nobody was active
  assertEquals(starToShow(r, { user_id: "a", score: null }), null);
  assertEquals(starToShow(r, { user_id: "c", score: 30 }), null); // activity but no points in this ranking
  assertEquals(starToShow(r, { user_id: "gone", score: 30 }), null);
  assertEquals(starToShow(r, null), null);
});

// ---- loaders: a fake supabase-js with just rpc() / from() and the admin_actions insert logHealthOnce makes ----
type Inserted = { table: string; row: Record<string, unknown> };
function fakeDb(opts: {
  rpc?: { data?: unknown; error?: unknown; throws?: boolean };
  star?: { data?: unknown; error?: unknown };
}) {
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  const inserts: Inserted[] = [];
  const eqs: [string, unknown][] = [];
  const db = {
    rpcCalls,
    inserts,
    eqs,
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      if (opts.rpc?.throws) return Promise.reject(new Error("fetch failed"));
      return Promise.resolve({ data: opts.rpc?.data ?? null, error: opts.rpc?.error ?? null });
    },
    from(table: string) {
      const chain = {
        select() { return chain; },
        eq(col: string, v: unknown) { eqs.push([col, v]); return chain; },
        gte() { return chain; },
        limit() { return Promise.resolve({ data: [], error: null }); },
        maybeSingle() { return Promise.resolve({ data: opts.star?.data ?? null, error: opts.star?.error ?? null }); },
        insert(row: Record<string, unknown>) { inserts.push({ table, row }); return Promise.resolve({ error: null }); },
      };
      return chain;
    },
  };
  return db;
}

Deno.test("loadGroupRanking reads group_leaderboard for the viewer, the whole group", async () => {
  const db = fakeDb({ rpc: { data: [row(1, "a", 9), row(2, "me", 3)] } });
  const { ranking, failed } = await loadGroupRanking(db, "me", "test");
  assertEquals(failed, false);
  assertEquals(db.rpcCalls, [{ fn: "group_leaderboard", args: { uid: "me", _limit: GROUP_RANK_LIMIT } }]);
  assert(GROUP_RANK_LIMIT >= 1000, "the limit must cover a whole group, or ranks past it disappear");
  assertEquals(myRank(ranking), { rank: 2, size: 2, points: 3 });
  assertEquals(db.inserts.length, 0);
});

Deno.test("loadGroupRanking: an RPC error or a throw is failed:true and DB-visible, never a throw", async () => {
  // Distinct users: logHealthOnce dedupes per (action, part:user) per Tashkent day, in-isolate too.
  const cases = [{ uid: "fail-err", rpc: { error: { message: "permission denied", code: "42501" } } }, {
    uid: "fail-throw",
    rpc: { throws: true },
  }];
  for (const { uid, rpc } of cases) {
    const db = fakeDb({ rpc });
    const { ranking, failed } = await loadGroupRanking(db, uid, "test");
    assertEquals(failed, true);
    assertEquals(ranking.size, 0);
    const sig = db.inserts.find((i) => i.table === "admin_actions");
    assert(sig, "a failed ranking read must leave an admin_actions row");
    assertEquals(sig.row.action, "group_rank_load_failed");
    assertEquals(sig.row.target_user_id, uid);
    assertEquals((sig.row.details as Record<string, unknown>).part, "ranking");
  }
});

Deno.test("loadWeeklyStar: this Tashkent week's row; an error is null + DB-visible", async () => {
  const now = new Date("2026-09-30T12:00:00Z");
  const ok = fakeDb({ star: { data: { user_id: "a", score: 64 } } });
  assertEquals(await loadWeeklyStar(ok, "g1", "me", "test", now), { user_id: "a", score: 64 });
  assertEquals(ok.eqs, [["group_id", "g1"], ["week_start", "2026-09-28"]]);

  assertEquals(await loadWeeklyStar(fakeDb({}), "g1", "me", "test", now), null);

  const bad = fakeDb({ star: { error: { message: "boom" } } });
  assertEquals(await loadWeeklyStar(bad, "g1", "me2", "test", now), null);
  const sig = bad.inserts.find((i) => i.table === "admin_actions");
  assertEquals(sig?.row.action, "group_rank_load_failed");
  assertEquals((sig?.row.details as Record<string, unknown>).part, "star");
});
