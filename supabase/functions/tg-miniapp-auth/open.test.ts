// Pins the Mini App open signal: the open mode never links or mints, resolves by telegram_id only, and stamps
// clicked_at only on the ref row of the OWNING profile. Run: deno test supabase/functions/tg-miniapp-auth/
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clickTableFor, handleOpen, openActionFor, parseOpen, recordOpen } from "./open.ts";
import { MINIAPP_SRCS, startParamToPath, TEACHER_MINIAPP_SRCS } from "../_shared/miniapp-links.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NUDGE = "33333333-3333-4333-8333-333333333333";
const DELIV = "44444444-4444-4444-8444-444444444444";

type Row = Record<string, any>;

/**
 * A tiny in-memory PostgREST: profiles / nudge_log / re_engagement_deliveries / admin_actions. update() honours
 * eq()/is() filters exactly, so a missing profile_id filter would stamp the wrong row and fail the test. Any
 * other method (auth.admin.*, rpc, …) is absent: calling it throws — the open mode must not need one.
 */
function fakeDb(tables: Record<string, Row[]>) {
  const calls: string[] = [];
  return {
    tables,
    calls,
    from(table: string) {
      calls.push(`from:${table}`);
      const rows = (tables[table] ??= []);
      const filters: Array<(r: Row) => boolean> = [];
      let patch: Row | null = null;
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
        is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return q; },
        update: (p: Row) => { patch = p; return q; },
        insert: (r: Row) => { rows.push(r); calls.push(`insert:${table}`); return Promise.resolve({ error: null }); },
        maybeSingle: () => Promise.resolve({ data: rows.find((r) => filters.every((f) => f(r))) ?? null, error: null }),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
          const hit = rows.filter((r) => filters.every((f) => f(r)));
          if (patch) for (const r of hit) Object.assign(r, patch);
          if (patch) calls.push(`update:${table}:${hit.length}`);
          return Promise.resolve({ data: hit.map((r) => ({ id: r.id })), error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
}

const db = () => fakeDb({
  profiles: [{ id: OWNER, telegram_id: 7 }, { id: OTHER, telegram_id: 8 }],
  nudge_log: [{ id: NUDGE, profile_id: OWNER, clicked_at: null }],
  re_engagement_deliveries: [{ id: DELIV, profile_id: OWNER, clicked_at: null }],
  admin_actions: [],
});

Deno.test("parseOpen validates src / ref / path", () => {
  assertEquals(parseOpen({ src: "nudge_3d", ref: NUDGE.toUpperCase(), path: "/continue" }), { src: "nudge_3d", ref: NUDGE, path: "/continue" });
  assertEquals(parseOpen({ src: "evil" }), null);
  assertEquals(parseOpen(null), null);
  assertEquals(parseOpen({ src: "daily_reminder", ref: "x'; drop", path: "https://evil" }), { src: "daily_reminder", ref: null, path: null });
  assertEquals(parseOpen({ src: "daily_reminder", path: "//evil.com" }), { src: "daily_reminder", ref: null, path: null });
});

Deno.test("clickTableFor", () => {
  assertEquals(clickTableFor("nudge_3d"), "nudge_log");
  assertEquals(clickTableFor("nudge_module"), "nudge_log");
  assertEquals(clickTableFor("reengagement"), "re_engagement_deliveries");
  assertEquals(clickTableFor("daily_reminder"), null);
});

Deno.test("open mode: resolves by telegram_id, never mints or links, writes miniapp_open, stamps the owner's nudge", async () => {
  const d = db();
  const r = await handleOpen(d, 7, { mode: "open", src: "nudge_3d", ref: NUDGE, path: "/continue" });
  assertEquals(r, { ok: true, stamped: true });
  assertEquals(d.tables.nudge_log[0].clicked_at !== null, true);
  const row = d.tables.admin_actions.find((a) => a.action === "miniapp_open")!;
  assertEquals(row.details.profile_id, OWNER);
  assertEquals(row.details.src, "nudge_3d");
  assertEquals(row.details.ref, NUDGE);
  assertEquals(row.details.cold, false);
  // Only these touches: the profile lookup, the stamp and the audit row. No auth / session / link path.
  assertEquals(d.calls.filter((c) => c.startsWith("from:")).sort(), ["from:admin_actions", "from:nudge_log", "from:profiles"]);
  assertEquals(d.calls.some((c) => c.startsWith("update:profiles")), false);
});

Deno.test("open mode: someone else's ref (a forwarded button) stamps nothing", async () => {
  const d = db();
  const r = await handleOpen(d, 8, { src: "nudge_3d", ref: NUDGE });
  assertEquals(r, { ok: true, stamped: false });
  assertEquals(d.tables.nudge_log[0].clicked_at, null);
  assertEquals(d.tables.admin_actions[0].details.profile_id, OTHER); // the open is still counted, for its opener
});

Deno.test("open mode: an already-clicked nudge keeps its first click time", async () => {
  const d = db();
  d.tables.nudge_log[0].clicked_at = "2026-09-29T10:00:00Z";
  const r = await handleOpen(d, 7, { src: "nudge_7d", ref: NUDGE });
  assertEquals(r.stamped, false);
  assertEquals(d.tables.nudge_log[0].clicked_at, "2026-09-29T10:00:00Z");
});

Deno.test("open mode: re-engagement stamps its delivery row", async () => {
  const d = db();
  assertEquals((await handleOpen(d, 7, { src: "reengagement", ref: DELIV })).stamped, true);
  assertEquals(d.tables.re_engagement_deliveries[0].clicked_at !== null, true);
});

Deno.test("open mode: an unknown telegram user is not_linked, and nothing is written", async () => {
  const d = db();
  assertEquals(await handleOpen(d, 999, { src: "daily_reminder" }), { ok: false, error: "not_linked" });
  assertEquals(d.tables.admin_actions.length, 0);
});

Deno.test("open mode: a bad src is refused before any lookup", async () => {
  const d = db();
  assertEquals(await handleOpen(d, 7, { src: "../../x" }), { ok: false, error: "bad_open" });
  assertEquals(d.calls.length, 0);
});

Deno.test("a fresh sign-in's open is recorded cold:true", async () => {
  const d = db();
  await recordOpen(d, OWNER, parseOpen({ src: "daily_reminder", path: "/continue" })!, true);
  assertEquals(d.tables.admin_actions[0].details.cold, true);
});

// The teacher Mini App buttons (_shared/teacher-miniapp.ts, 2026-09-30) report their taps through this same open
// signal. NOTE: a _shared/ change alone does not redeploy this function (the pipeline deploys changed function
// DIRS) — this test lives here so the new sources ship with it.
//
// They are recorded as 'teacher_miniapp_open', NEVER 'miniapp_open': watch_button_health() counts every
// 'miniapp_open' row (any src) as proof the STUDENT watch buttons work — opens_missing fires only when there are
// zero in 48 h — so a single teacher tap on 🎯 Baholash would mask a broken student sign-in.
Deno.test("teacher sources: accepted and counted as teacher_miniapp_open — never a student open, never a stamp", async () => {
  for (const src of TEACHER_MINIAPP_SRCS) {
    assertEquals(clickTableFor(src), null);
    const d = db();
    // The Mini App reports the PATH only (the ?sub= query is not part of it); ref is the submission id.
    const r = await handleOpen(d, 7, { mode: "open", src, ref: NUDGE, path: "/tg/teacher/grade" });
    assertEquals(r, { ok: true, stamped: false });
    assertEquals(d.tables.admin_actions.length, 1);
    const row = d.tables.admin_actions[0];
    assertEquals(row.action, "teacher_miniapp_open", src);
    assertEquals([row.details.src, row.details.ref, row.details.path], [src, NUDGE, "/tg/teacher/grade"]);
    assertEquals(d.tables.nudge_log[0].clicked_at, null);
    // The cold (fresh sign-in) path uses the same action.
    const c = db();
    await recordOpen(c, OWNER, parseOpen({ src, path: "/tg/teacher" })!, true);
    assertEquals([c.tables.admin_actions[0].action, c.tables.admin_actions[0].details.cold], ["teacher_miniapp_open", true]);
  }
});

Deno.test("openActionFor: exactly the four teacher sources are teacher opens; 'teacher_nudge' is a STUDENT open", () => {
  const teacher = MINIAPP_SRCS.filter((s) => openActionFor(s) === "teacher_miniapp_open");
  assertEquals([...teacher].sort(), ["teacher_card", "teacher_hw_dm", "teacher_hw_reminder", "teacher_report"]);
  // A teacher's nudge is a button the STUDENT opens (teacher-nudge-student) — it must keep feeding the student detector.
  assertEquals(openActionFor("teacher_nudge"), "miniapp_open");
  for (const s of ["daily_reminder", "streak_warning", "nudge_3d", "reengagement", "bot_dars", "broadcast", "daily_task"] as const) {
    assertEquals(openActionFor(s), "miniapp_open", s);
  }
});

Deno.test("targetPath grammar: every existing start_param is unchanged", () => {
  const target = (p: string | undefined, staff: boolean) => startParamToPath(p)?.path ?? (staff ? "/tg/teacher" : "/dashboard");
  assertEquals(target("hw", false), "/homework");
  assertEquals(target("homework", true), "/homework");
  assertEquals(target("leaderboard", false), "/leaderboard");
  assertEquals(target("profile", false), "/profile");
  assertEquals(target(undefined, false), "/dashboard");
  assertEquals(target(undefined, true), "/tg/teacher");
  assertEquals(target("unknown", true), "/tg/teacher");
  assertEquals(target(`c_${OWNER}__daily_task`, false), `/continue/${OWNER}`);
});
