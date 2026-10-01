// Pins the ☰ sweep: who it reaches (members only), what it sets (per role, per flag, per language), that it is
// bounded + rate-spaced + resumable + idempotent, that a refusal / 429 / read error never moves the cursor past
// an unprocessed member, and that every stop is DB-visible.
// Run: deno test supabase/functions/telegram-bot-webhook/menu-sweep.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BACKOFF_MS,
  decideRefusal,
  freshProgress,
  LEASE_MS,
  loadSweepTargets,
  nextStopRepeats,
  parseProgress,
  parseSweepSettings,
  passKey,
  planTick,
  PROGRESS_KEY,
  REPASS_MS,
  runMenuSweepTick,
  SPACING_MS,
  type Suspect,
} from "./menu-sweep.ts";
import { FakeDb, fakeTelegram, type Row } from "../_bot/testing/fake-db.ts";

const BASE = "https://www.aicreator.academy";
const P5 = "c0000000-0000-4000-8000-000000000005"; // published course
const P4 = "c0000000-0000-4000-8000-000000000004"; // unpublished (retired) course
const G5 = "g0000000-0000-4000-8000-000000000051";
const G4 = "g0000000-0000-4000-8000-000000000041";
const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function world(extra: { settings?: Row[]; progress?: Row } = {}) {
  const prof = (n: number, o: Row = {}): Row => ({
    id: id(n), telegram_id: 1000 + n, preferred_locale: "uz", status: "active", archived_at: null, group_id: G5, ...o,
  });
  return new FakeDb({
    platform_settings: extra.settings ?? [
      { key: "student_miniapp", value: { enabled: true } },
      { key: "teacher_miniapp", value: { enabled: true } },
    ],
    app_settings: extra.progress ? [{ key: PROGRESS_KEY, value: extra.progress }] : [],
    courses: [{ id: P5, published: true }, { id: P4, published: false }],
    groups: [{ id: G5, course_id: P5 }, { id: G4, course_id: P4 }],
    user_roles: [
      { user_id: id(6), role: "teacher" },
      { user_id: id(7), role: "admin" },
      { user_id: id(7), role: "teacher" },
    ],
    profiles: [
      prof(1),
      prof(2, { preferred_locale: "ru" }),
      prof(3, { preferred_locale: "en" }),
      prof(4),
      prof(5),
      prof(6, { group_id: null }), // teacher without a group
      prof(7, { group_id: null }), // admin (+ teacher role): admin wins
      prof(8, { group_id: G4 }), // retired cohort: not swept
      prof(9, { telegram_id: null }), // no Telegram: not swept
      prof(10, { status: "inactive" }), // deactivated: not swept
      prof(11, { archived_at: "2026-09-01T00:00:00Z" }), // archived: not swept
    ],
    admin_actions: [],
  });
}

const noSleep = () => {
  const naps: number[] = [];
  return { naps, sleep: (ms: number) => { naps.push(ms); return Promise.resolve(); } };
};

function clock(start = Date.parse("2026-10-01T06:00:00Z")) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const progress = (db: FakeDb) => parseProgress(db.rows("app_settings").find((r) => r.key === PROGRESS_KEY)?.value)!;
const menus = (calls: { method: string; payload: Row }[]) => calls.filter((c) => c.method === "setChatMenuButton");

Deno.test("parseSweepSettings mirrors the webhook's flag readers (student fail-closed, teacher absent=on)", () => {
  assertEquals(parseSweepSettings([]), { enabled: true, student: false, teacher: true, rerun: "" });
  assertEquals(parseSweepSettings([{ key: "student_miniapp", value: { enabled: "true" } }]).student, false);
  assertEquals(parseSweepSettings([{ key: "student_miniapp", value: { enabled: true } }]).student, true);
  assertEquals(parseSweepSettings([{ key: "teacher_miniapp", value: {} }]).teacher, false);
  assertEquals(parseSweepSettings([{ key: "menu_button_sweep", value: { enabled: false } }]).enabled, false);
  assertEquals(parseSweepSettings([{ key: "menu_button_sweep", value: { rerun: 2 } }]), { enabled: true, student: false, teacher: true, rerun: "2" });
});

Deno.test("planTick: first pass, continue, done, periodic re-pass, state change, backoff, lease, restart", () => {
  const now = Date.parse("2026-10-01T06:00:00Z");
  const k = "K";
  const p = (o: Partial<ReturnType<typeof freshProgress>>) => ({ ...freshProgress(k, now - 1000, 3), ...o });
  assertEquals(planTick(null, k, now), { run: true, fresh: true, reason: "first_pass" });
  assertEquals(planTick(p({}), k, now), { run: true, fresh: false, reason: "continue" });
  assertEquals(planTick(p({ done: true, finished_at: new Date(now - 3600_000).toISOString() }), k, now), { run: false, reason: "done" });
  assertEquals(planTick(p({ done: true, finished_at: new Date(now - REPASS_MS).toISOString() }), k, now).reason, "repass");
  assertEquals(planTick(p({ done: true, finished_at: new Date(now - 60_000).toISOString() }), "OTHER", now).reason, "state_changed");
  assertEquals(planTick(p({ retry_after: new Date(now + 60_000).toISOString() }), k, now), { run: false, reason: "backoff" });
  // a state change is not held back by a backoff…
  assertEquals(planTick(p({ retry_after: new Date(now + 60_000).toISOString() }), "OTHER", now).run, true);
  // …but nothing overrides a live lease, not even restart
  assertEquals(planTick(p({ lease_until: new Date(now + 1000).toISOString() }), "OTHER", now, true), { run: false, reason: "leased" });
  assertEquals(planTick(p({ lease_until: new Date(now - 1).toISOString() }), k, now).run, true);
  assertEquals(planTick(p({ done: true, finished_at: new Date(now).toISOString() }), k, now, true).reason, "restart");
});

Deno.test("loadSweepTargets: current members only, persona admin > teacher > student, id order", async () => {
  const { targets, error } = await loadSweepTargets(world());
  assertEquals(error, null);
  assertEquals(targets.map((t) => [t.id, t.chatId, t.role, t.locale]), [
    [id(1), 1001, "student", "uz"],
    [id(2), 1002, "student", "ru"],
    [id(3), 1003, "student", "en"],
    [id(4), 1004, "student", "uz"],
    [id(5), 1005, "student", "uz"],
    [id(6), 1006, "teacher", "uz"],
    [id(7), 1007, "admin", "uz"],
  ]);
});

Deno.test("a full pass: bounded batches, spaced calls, right menu per role/language, commands, pass row, then idle", async () => {
  const db = world();
  const tg = fakeTelegram();
  const z = noSleep();
  const c = clock();
  const opts = { base: BASE, call: tg.call, sleep: z.sleep, now: c.now, batch: 3 };

  const r1 = await runMenuSweepTick(db, opts);
  assertEquals([r1.ran, r1.reason, r1.processed, r1.done], [true, "first_pass", 3, false]);
  // the bot-wide student lists go first, once: uz (no language_code), ru, en — all private chats
  const globals = tg.calls.filter((x) => x.method === "setMyCommands" && (x.payload.scope as Row).type === "all_private_chats");
  assertEquals(globals.map((x) => x.payload.language_code ?? "uz"), ["uz", "ru", "en"]);
  assert((globals[0].payload.commands as Row[]).some((x) => x.command === "dars"), "/dars is in the student list");
  assertEquals(menus(tg.calls).map((x) => x.payload), [
    { chat_id: 1001, menu_button: { type: "web_app", text: "🚀 Ilovani ochish", web_app: { url: `${BASE}/dashboard` } } },
    { chat_id: 1002, menu_button: { type: "web_app", text: "🚀 Открыть приложение", web_app: { url: `${BASE}/dashboard` } } },
    { chat_id: 1003, menu_button: { type: "web_app", text: "🚀 Open the app", web_app: { url: `${BASE}/dashboard` } } },
  ]);
  // every Telegram call is followed by the spacing nap (≤ ~16 calls/s)
  assertEquals(z.naps.length, tg.calls.length - 2); // the 3 global calls share one nap
  assert(z.naps.every((n) => n === SPACING_MS));
  let p = progress(db);
  assertEquals([p.cursor, p.done, p.lease_until, p.totals.ok, p.totals.targets], [id(3), false, null, 3, 7]);

  c.advance(60_000);
  const r2 = await runMenuSweepTick(db, opts);
  assertEquals([r2.reason, r2.processed, r2.done], ["continue", 3, false]);
  c.advance(60_000);
  const r3 = await runMenuSweepTick(db, opts);
  assertEquals([r3.reason, r3.processed, r3.done], ["continue", 1, true]);

  // staff: 📝 Ustoz → /tg/teacher, plus their own "/" list in their own chat
  const m = menus(tg.calls);
  assertEquals(m.length, 7);
  assertEquals(m[5].payload, { chat_id: 1006, menu_button: { type: "web_app", text: "📝 Ustoz", web_app: { url: `${BASE}/tg/teacher` } } });
  const chatCmds = tg.calls.filter((x) => x.method === "setMyCommands" && (x.payload.scope as Row).type === "chat");
  assertEquals(chatCmds.map((x) => (x.payload.scope as Row).chat_id), [1006, 1007]);
  assert((chatCmds[0].payload.commands as Row[]).some((x) => x.command === "baholash"), "teacher list");
  assert((chatCmds[1].payload.commands as Row[]).some((x) => x.command === "analitika"), "admin list");
  // global lists were NOT re-sent by the continuing ticks
  assertEquals(tg.calls.filter((x) => x.method === "setMyCommands" && (x.payload.scope as Row).type === "all_private_chats").length, 3);

  p = progress(db);
  assertEquals([p.done, p.totals.processed, p.totals.ok, p.totals.commands_ok, p.totals.staff, p.totals.students], [true, 7, 7, 2, 2, 5]);
  const pass = db.actions("menu_button_sweep_pass");
  assertEquals(pass.length, 1);
  assertEquals(pass[0].details.totals.ok, 7);

  // idle until the periodic re-pass: no Telegram calls
  const before = tg.calls.length;
  c.advance(60_000);
  assertEquals((await runMenuSweepTick(db, opts)).reason, "done");
  assertEquals(tg.calls.length, before);
  c.advance(REPASS_MS);
  assertEquals((await runMenuSweepTick(db, opts)).reason, "repass");
});

Deno.test("a kill-switch flip starts a new pass at once and resets that role to Telegram's default menu", async () => {
  const db = world();
  const tg = fakeTelegram();
  const c = clock();
  const opts = { base: BASE, call: tg.call, sleep: noSleep().sleep, now: c.now, batch: 50 };
  assertEquals((await runMenuSweepTick(db, opts)).done, true);
  db.rows("platform_settings").find((r) => r.key === "student_miniapp")!.value = { enabled: false };
  tg.calls.length = 0;
  c.advance(60_000);
  const r = await runMenuSweepTick(db, opts);
  assertEquals([r.reason, r.done], ["state_changed", true]);
  const m = menus(tg.calls);
  assertEquals(m.slice(0, 5).map((x) => x.payload.menu_button), Array(5).fill({ type: "default" }));
  assertEquals((m[5].payload.menu_button as Row).type, "web_app"); // teachers keep theirs (their flag is on)
});

Deno.test("unreachable members are counted, never alarmed, and do not stop the pass", async () => {
  const db = world();
  const tg = fakeTelegram((m, p) => (m === "setChatMenuButton" && p.chat_id === 1002 ? { ok: false, error: "Bad Request: chat not found" } : { ok: true }));
  const r = await runMenuSweepTick(db, { base: BASE, call: tg.call, sleep: noSleep().sleep, now: clock().now, batch: 50 });
  assertEquals(r.done, true);
  assertEquals([r.totals!.ok, r.totals!.unreachable], [6, 1]);
  assertEquals(db.actions("miniapp_button_rejected").length, 0);
  assertEquals(db.actions("menu_button_sync_failed").length, 0);
});

Deno.test("a refused web_app menu stops the tick BEFORE that member, alarms once, and backs off", async () => {
  const db = world();
  const tg = fakeTelegram((m, p) => (m === "setChatMenuButton" && p.chat_id === 1003 ? { ok: false, status: 400, error: "Bad Request: BUTTON_URL_INVALID" } : { ok: true }));
  const c = clock();
  const opts = { base: BASE, call: tg.call, sleep: noSleep().sleep, now: c.now, batch: 50 };
  const r = await runMenuSweepTick(db, opts);
  assertEquals([r.stop, r.done, r.cursor], ["rejected", false, id(2)]);
  const p = progress(db);
  assertEquals(p.last_stop, "rejected");
  assertEquals(Date.parse(p.retry_after!) - c.now(), BACKOFF_MS.rejected);
  const rej = db.actions("miniapp_button_rejected");
  assertEquals(rej.length, 1);
  assertEquals(rej[0].details.fn, "menu_button_sweep");
  assertEquals([p.suspect?.id, p.suspect?.phase, p.stop_repeats], [id(3), "backoff", 1]);
  c.advance(60_000);
  assertEquals((await runMenuSweepTick(db, opts)).reason, "backoff");

  // 2026-10-01: after the backoff the SAME member is refused again → probation (the cursor steps past them). The
  // only member with that menu (🚀 en) is them, so the pass ends undecided → ONE skip row, and the pass finishes
  // instead of stopping on member 3 every 30 minutes forever.
  c.advance(BACKOFF_MS.rejected);
  const r2 = await runMenuSweepTick(db, opts);
  assertEquals([r2.reason, r2.stop, r2.done], ["continue", null, true]);
  const skip = db.actions("menu_button_sweep_member_skipped");
  assertEquals(skip.length, 1);
  assertEquals(
    [skip[0].details.profile_id, skip[0].details.role, skip[0].details.status, skip[0].details.error, skip[0].details.decided_by, skip[0].details.refusals],
    [id(3), "student", 400, "Bad Request: BUTTON_URL_INVALID", "pass_end", 2],
  );
  const p2 = progress(db);
  assertEquals([p2.totals.skipped, p2.totals.processed, p2.suspect, p2.stop_repeats], [1, 7, null, 0]);
  assertEquals(db.actions("menu_button_sweep_pass").length, 1);
});

Deno.test("a 429 stops the tick without skipping anyone; the next tick after the backoff resumes there", async () => {
  const db = world();
  let limited = true;
  const tg = fakeTelegram((m, p) => (m === "setChatMenuButton" && p.chat_id === 1002 && limited ? { ok: false, status: 429, error: "Too Many Requests: retry after 5" } : { ok: true }));
  const c = clock();
  const opts = { base: BASE, call: tg.call, sleep: noSleep().sleep, now: c.now, batch: 50 };
  const r = await runMenuSweepTick(db, opts);
  assertEquals([r.stop, r.cursor], ["rate_limited", id(1)]);
  limited = false;
  c.advance(BACKOFF_MS.rate_limited + 1);
  const r2 = await runMenuSweepTick(db, opts);
  assertEquals([r2.reason, r2.done], ["continue", true]);
  assertEquals(menus(tg.calls).filter((x) => x.payload.chat_id === 1002).length, 2);
});

Deno.test("read errors never count as 'off': no Telegram call at all, and a DB-visible row", async () => {
  const db = world();
  db.failOn.add("platform_settings");
  const tg = fakeTelegram();
  const r = await runMenuSweepTick(db, { base: BASE, call: tg.call, sleep: noSleep().sleep, now: clock().now });
  assertEquals([r.ran, r.reason, tg.calls.length], [false, "settings_read_failed", 0]);
  assertEquals(db.actions("menu_button_sweep_failed").length, 1);

  const db2 = world();
  db2.failOn.add("user_roles");
  const r2 = await runMenuSweepTick(db2, { base: BASE, call: tg.call, sleep: noSleep().sleep, now: clock().now });
  assertEquals([r2.ran, r2.stop, tg.calls.length], [true, "targets_read_failed", 0]);
  assertEquals(progress(db2).cursor, null);
});

Deno.test("the sweep's own switch turns it off; a live lease blocks a second tick; a rerun token forces a pass", async () => {
  const off = world({ settings: [{ key: "menu_button_sweep", value: { enabled: false } }] });
  const tg = fakeTelegram();
  assertEquals((await runMenuSweepTick(off, { base: BASE, call: tg.call, sleep: noSleep().sleep })).reason, "disabled");
  assertEquals(tg.calls.length, 0);

  const c = clock();
  const leased = world({
    progress: { ...freshProgress("x", c.now(), 4), lease_until: new Date(c.now() + LEASE_MS).toISOString() },
  });
  assertEquals((await runMenuSweepTick(leased, { base: BASE, call: tg.call, sleep: noSleep().sleep, now: c.now })).reason, "leased");
  assertEquals(tg.calls.length, 0);

  const db = world();
  const opts = { base: BASE, call: tg.call, sleep: noSleep().sleep, now: c.now, batch: 50 };
  assertEquals((await runMenuSweepTick(db, opts)).done, true);
  db.rows("platform_settings").push({ key: "menu_button_sweep", value: { enabled: true, rerun: "2026-10-02" } });
  c.advance(60_000);
  assertEquals((await runMenuSweepTick(db, opts)).reason, "state_changed");
});

Deno.test("a tick whose progress row moved between its read and its claim runs nothing (another isolate won)", async () => {
  const db = world();
  const tg = fakeTelegram();
  const c = clock();
  const opts = { base: BASE, call: tg.call, sleep: noSleep().sleep, now: c.now, batch: 2 };
  await runMenuSweepTick(db, opts); // creates the row
  c.advance(60_000);
  const callsBefore = tg.calls.length;
  let bumped = false;
  // The racer: right before our claim's UPDATE lands, someone else bumps rev.
  const racy = {
    from: (t: string) => {
      const q = db.from(t);
      if (t === "app_settings" && !bumped) {
        // deno-lint-ignore no-explicit-any
        const qq = q as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        const up = qq.update.bind(qq);
        qq.update = (patch: Row) => {
          bumped = true;
          const row = db.rows("app_settings")[0];
          row.value = { ...row.value, rev: row.value.rev + 1 };
          return up(patch);
        };
      }
      return q;
    },
  };
  const r = await runMenuSweepTick(racy, opts);
  assertEquals([r.ran, r.reason], [false, "lost_race"]);
  assertEquals(tg.calls.length, callsBefore);
});

Deno.test("passKey changes with every input that changes what members get", () => {
  const s = parseSweepSettings([{ key: "student_miniapp", value: { enabled: true } }]);
  const k = passKey(s, BASE);
  assert(k !== passKey({ ...s, student: false }, BASE));
  assert(k !== passKey({ ...s, teacher: false }, BASE));
  assert(k !== passKey(s, "https://other.example"));
  assert(k !== passKey({ ...s, rerun: "x" }, BASE));
});

// ═══════════════════ incident 2026-10-01: one member can never freeze a pass ═══════════════════

// The LIVE progress row at 2026-10-01 04:22 UTC (app_settings 'menu_button_sweep'), verbatim: the pass stopped on
// member 96 of 166 ("Bad Request: user not found" read as a refusal of our button) and re-hit them every 30 min.
const LIVE_BASE = "https://aicreator.academy";
const LIVE_CURSOR = "83d961a5-34a3-4f2d-9bb6-c7734ded29f3";
const LIVE_ROW = {
  rev: 6, done: false, ticks: 3, cursor: LIVE_CURSOR,
  totals: {
    ok: 92, staff: 9, failed: 0, targets: 166, rejected: 1, students: 157, processed: 95, commands_ok: 4, unreachable: 3,
    commands_failed: 0, global_commands_ok: 3, global_commands_failed: 0,
  },
  version: 1, pass_key: "v1|c1|s1|t1|https://aicreator.academy|", last_stop: "rejected", finished_at: null, lease_until: null,
  retry_after: "2026-10-01T04:32:05.001Z", last_tick_at: "2026-10-01T04:02:02.189Z", pass_started_at: "2026-10-01T04:00:09.620Z",
  global_commands_sent: true,
};
// The stuck member's profile id starts 859ddad6 (provisional, last seen 2026-08-08); the rest is not reproduced here.
const STUCK = "859ddad6-0000-4000-8000-000000000000";

/** 166 members like production: 95 up to and including the live cursor, then the stuck one and 70 more (4 staff). */
function liveWorld() {
  const hex = (n: number) => n.toString(16).padStart(4, "0");
  const before = Array.from({ length: 94 }, (_, i) => `1000${hex(i)}-0000-4000-8000-000000000000`).concat(LIVE_CURSOR);
  const after = [STUCK].concat(Array.from({ length: 70 }, (_, i) => `9000${hex(i)}-0000-4000-8000-000000000000`));
  const staffIds = [...before.slice(0, 5), ...after.slice(1, 5)];
  let tg = 50_000;
  const prof = (pid: string): Row => ({ id: pid, telegram_id: ++tg, preferred_locale: "uz", status: "active", archived_at: null, group_id: G5 });
  return {
    stuckChat: 50_000 + before.length + 1,
    db: new FakeDb({
      platform_settings: [{ key: "student_miniapp", value: { enabled: true } }, { key: "teacher_miniapp", value: { enabled: true } }],
      app_settings: [{ key: PROGRESS_KEY, value: structuredClone(LIVE_ROW) }],
      courses: [{ id: P5, published: true }],
      groups: [{ id: G5, course_id: P5 }],
      user_roles: staffIds.map((u) => ({ user_id: u, role: "teacher" })),
      profiles: [...before, ...after].map(prof),
      admin_actions: [],
    }),
  };
}

Deno.test("REPLAY of the live state: the next tick steps past the 'user not found' member and the pass finishes (166/166)", async () => {
  const { db, stuckChat } = liveWorld();
  // the deploy continues the SAME pass (no restart): the live pass key is what this code computes for live settings
  assertEquals(passKey(parseSweepSettings([{ key: "student_miniapp", value: { enabled: true } }, { key: "teacher_miniapp", value: { enabled: true } }]), LIVE_BASE), LIVE_ROW.pass_key);
  // a row written before this fix parses with the new fields at their defaults
  const before = parseProgress(LIVE_ROW)!;
  assertEquals([before.suspect, before.last_progress_at, before.stop_cursor, before.stop_repeats, before.totals.skipped], [null, null, null, 0, 0]);

  const tg = fakeTelegram((m, p) => (m === "setChatMenuButton" && p.chat_id === stuckChat ? { ok: false, status: 400, error: "Bad Request: user not found" } : { ok: true }));
  const c = clock(Date.parse("2026-10-01T04:33:00Z")); // the first tick after retry_after
  const opts = { base: LIVE_BASE, call: tg.call, sleep: noSleep().sleep, now: c.now };

  const r1 = await runMenuSweepTick(db, opts);
  assertEquals([r1.reason, r1.stop, r1.done, r1.processed], ["continue", null, false, 40]);
  assertEquals(menus(tg.calls)[0].payload.chat_id, stuckChat, "the tick starts at the member it used to stop on");
  let p = progress(db);
  assert(p.cursor! > STUCK, "the cursor moved past the stuck member");
  assertEquals([p.last_progress_at, p.stop_repeats, p.suspect], [new Date(c.now()).toISOString(), 0, null]);

  c.advance(60_000);
  const r2 = await runMenuSweepTick(db, opts);
  assertEquals([r2.reason, r2.stop, r2.done, r2.processed], ["continue", null, true, 31]);
  p = progress(db);
  assertEquals([p.totals.processed, p.totals.targets, p.totals.ok, p.totals.unreachable, p.totals.rejected, p.totals.skipped],
    [166, 166, 92 + 70, 3 + 1, 1, 0]); // rejected 1 = the historical false refusal; no new one
  assertEquals(p.totals.commands_ok, 4 + 4, "the 4 staff queued behind the stuck member got their '/' list");
  // nothing new raised the student watch-button alarm; the finished pass is recorded
  assertEquals(db.actions("miniapp_button_rejected").length, 0);
  assertEquals(db.actions("menu_button_sweep_member_skipped").length, 0);
  const pass = db.actions("menu_button_sweep_pass");
  assertEquals(pass.length, 1);
  assertEquals([pass[0].details.totals.processed, pass[0].details.totals.targets], [166, 166]);
  // and the 6-hour re-pass is reachable again
  c.advance(REPASS_MS);
  assertEquals((await runMenuSweepTick(db, opts)).reason, "repass");
});

Deno.test("a per-member button refusal: refused again after the backoff, the next member with the SAME menu decides → skipped once", async () => {
  const db = world();
  const tg = fakeTelegram((m, p) => (m === "setChatMenuButton" && p.chat_id === 1001 ? { ok: false, status: 400, error: "Bad Request: BUTTON_URL_INVALID" } : { ok: true }));
  const c = clock();
  const opts = { base: BASE, call: tg.call, sleep: noSleep().sleep, now: c.now, batch: 50 };

  const r1 = await runMenuSweepTick(db, opts); // 1st refusal: stop BEFORE member 1
  assertEquals([r1.stop, r1.cursor, r1.processed], ["rejected", null, 0]);
  c.advance(BACKOFF_MS.rejected + 1);
  const r2 = await runMenuSweepTick(db, opts); // refused again → probation → member 4 (🚀 uz, same menu) accepted
  assertEquals([r2.stop, r2.done], [null, true]);

  const skip = db.actions("menu_button_sweep_member_skipped");
  assertEquals(skip.length, 1);
  const d = skip[0].details;
  assertEquals([d.profile_id, d.role, d.method, d.status, d.error, d.decided_by, d.refusals],
    [id(1), "student", "setChatMenuButton", 400, "Bad Request: BUTTON_URL_INVALID", "same_menu_accepted", 2]);
  // DB-visible with Telegram's description and an internal profile id only: never a token, never a telegram id
  assertEquals(Object.keys(d).sort(), ["decided_by", "dedupe_key", "error", "first_refused_at", "fn", "method", "pass_key", "profile_id", "refusals", "role", "source", "status"]);
  const p = progress(db);
  assertEquals([p.totals.processed, p.totals.ok, p.totals.rejected, p.totals.skipped, p.suspect, p.stop_repeats], [7, 6, 2, 1, null, 0]);
});

Deno.test("a GLOBAL refusal (our URL refused for everyone) still stops, rewinds and backs off — and counts its repeats", async () => {
  const db = world();
  const tg = fakeTelegram((m, p) =>
    m === "setChatMenuButton" && String((p.menu_button as Row)?.web_app?.url ?? "").endsWith("/dashboard")
      ? { ok: false, status: 400, error: "Bad Request: WEBAPP_URL_INVALID" }
      : { ok: true }
  );
  const c = clock();
  const opts = { base: BASE, call: tg.call, sleep: noSleep().sleep, now: c.now, batch: 50 };

  await runMenuSweepTick(db, opts); // member 1 refused → stop before them
  assertEquals(progress(db).stop_repeats, 1);
  c.advance(BACKOFF_MS.rejected + 1);
  const r2 = await runMenuSweepTick(db, opts); // member 1 again → probation; member 2 refused too → GLOBAL
  assertEquals([r2.stop, r2.cursor, r2.done], ["rejected", null, false]);
  let p = progress(db);
  assertEquals([p.cursor, p.totals.processed, p.suspect?.id, p.suspect?.phase, p.stop_cursor, p.stop_repeats, p.last_progress_at],
    [null, 0, id(1), "backoff", null, 2, null]);
  assertEquals(Date.parse(p.retry_after!) - c.now(), BACKOFF_MS.rejected);
  assertEquals(db.actions("menu_button_sweep_member_skipped").length, 0, "a global refusal never marks members as skipped");
  const g = db.actions("menu_button_sweep_failed").filter((r) => r.details.dedupe_key === "global_refusal");
  assertEquals(g.length, 1);
  assertEquals([g[0].details.suspect_profile_id, g[0].details.second_profile_id], [id(1), id(2)]);

  c.advance(BACKOFF_MS.rejected + 1);
  await runMenuSweepTick(db, opts);
  p = progress(db);
  assertEquals([p.cursor, p.stop_repeats, p.done], [null, 3, false]);
  // the staff (another menu, /tg/teacher) are never walked through while our student button is refused
  assertEquals(menus(tg.calls).filter((x) => [1006, 1007].includes(Number(x.payload.chat_id))).length, 0);

  // the kill-switch still converges: student_miniapp off → a new pass resets everyone's ☰ to Telegram's default
  db.rows("platform_settings").find((r) => r.key === "student_miniapp")!.value = { enabled: false };
  c.advance(60_000);
  const r4 = await runMenuSweepTick(db, opts);
  assertEquals([r4.reason, r4.done], ["state_changed", true]);
  assertEquals([progress(db).suspect, progress(db).stop_repeats], [null, 0]);
});

Deno.test("a bot-wide failure (401 Unauthorized) stops the pass on the first member instead of walking everyone", async () => {
  const db = world();
  const tg = fakeTelegram(() => ({ ok: false, status: 401, error: "Unauthorized" }));
  const c = clock();
  const opts = { base: BASE, call: tg.call, sleep: noSleep().sleep, now: c.now, batch: 50 };
  const r = await runMenuSweepTick(db, opts);
  assertEquals([r.stop, r.cursor, r.processed], ["global", null, 0]);
  assertEquals(menus(tg.calls).length, 1);
  const p = progress(db);
  assertEquals([p.stop_repeats, p.totals.failed, p.totals.rejected], [1, 0, 0]);
  assertEquals(Date.parse(p.retry_after!) - c.now(), BACKOFF_MS.global);
  assertEquals(db.actions("menu_button_sweep_failed").filter((x) => x.details.dedupe_key === "bot_unreachable").length, 1);
  assertEquals(db.actions("miniapp_button_rejected").length, 0);
  c.advance(BACKOFF_MS.global + 1);
  await runMenuSweepTick(db, opts);
  assertEquals(progress(db).stop_repeats, 2);
});

Deno.test("an unlisted per-member 400 on a web_app menu is 'failed': counted, recorded, and the pass goes on", async () => {
  const db = world();
  const tg = fakeTelegram((m, p) => (m === "setChatMenuButton" && p.chat_id === 1004 ? { ok: false, status: 400, error: "Bad Request: some new per-user thing" } : { ok: true }));
  const r = await runMenuSweepTick(db, { base: BASE, call: tg.call, sleep: noSleep().sleep, now: clock().now, batch: 50 });
  assertEquals([r.stop, r.done, r.totals!.failed, r.totals!.ok, r.totals!.rejected], [null, true, 1, 6, 0]);
  assertEquals(db.actions("menu_button_sync_failed").length, 1);
});

Deno.test("decideRefusal: first → stop; same member again → probe; another member while probing → global (rewind)", () => {
  const now = Date.parse("2026-10-01T06:00:00Z");
  const t = (n: number) => ({ id: id(n), role: "student" as const });
  const o = { status: 400, error: "Bad Request: BUTTON_URL_INVALID" };
  const first = decideRefusal(null, t(3), "M", o, id(2), now);
  assertEquals(first.action, "stop_first");
  assertEquals([first.suspect.id, first.suspect.phase, first.suspect.prev_cursor, first.suspect.refusals], [id(3), "backoff", id(2), 1]);
  const again = decideRefusal(first.suspect, t(3), "M", o, id(2), now + 1);
  assertEquals([again.action, again.suspect.phase, again.suspect.refusals], ["probe", "probe", 2]);
  const other = decideRefusal(again.suspect, t(4), "M", o, id(3), now + 2);
  assertEquals(other.action, "global");
  if (other.action === "global") assertEquals([other.rewindTo, other.suspect.id, other.suspect.phase], [id(2), id(3), "backoff"]);
  // a suspect still in backoff does not make a DIFFERENT member's refusal global: that one is a first refusal
  const fresh = decideRefusal(first.suspect, t(5), "M", o, id(4), now);
  assertEquals([fresh.action, fresh.suspect.id], ["stop_first", id(5)]);
});

Deno.test("nextStopRepeats: consecutive HARD stops at one cursor; a 429 neither counts nor resets; progress resets", () => {
  const z = { stop_cursor: null, stop_repeats: 0 };
  const a = nextStopRepeats(z, "rejected", id(2), false);
  assertEquals(a, { stop_cursor: id(2), stop_repeats: 1 });
  const b = nextStopRepeats(a, "rejected", id(2), false);
  assertEquals(b, { stop_cursor: id(2), stop_repeats: 2 });
  assertEquals(nextStopRepeats(b, "global", id(3), true), { stop_cursor: id(3), stop_repeats: 1 }, "another cursor starts over");
  assertEquals(nextStopRepeats(b, "rate_limited", id(2), false), b, "a 429 without progress keeps the count");
  assertEquals(nextStopRepeats(b, "rate_limited", id(4), true), z, "progress resets it");
  assertEquals(nextStopRepeats(b, null, id(2), false), z, "a clean tick resets it");
  assertEquals(nextStopRepeats(nextStopRepeats(z, "rejected", null, false), "rejected", null, false).stop_repeats, 2, "null cursor (first member) counts too");
});

Deno.test("parseProgress: a malformed suspect is dropped, never trusted", () => {
  const p = parseProgress({ ...freshProgress("K", 0, 1), suspect: { id: 5, phase: "probe" } });
  assertEquals(p!.suspect, null);
  const s: Suspect = { id: id(1), role: "teacher", menu: "M", status: 400, error: "x", phase: "probe", prev_cursor: null, first_at: "t", refusals: 2 };
  assertEquals(parseProgress({ ...freshProgress("K", 0, 1), suspect: s })!.suspect, s);
});
