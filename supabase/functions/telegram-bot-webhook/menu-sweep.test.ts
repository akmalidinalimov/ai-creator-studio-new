// Pins the ☰ sweep: who it reaches (members only), what it sets (per role, per flag, per language), that it is
// bounded + rate-spaced + resumable + idempotent, that a refusal / 429 / read error never moves the cursor past
// an unprocessed member, and that every stop is DB-visible.
// Run: deno test supabase/functions/telegram-bot-webhook/menu-sweep.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BACKOFF_MS,
  freshProgress,
  LEASE_MS,
  loadSweepTargets,
  parseProgress,
  parseSweepSettings,
  passKey,
  planTick,
  PROGRESS_KEY,
  REPASS_MS,
  runMenuSweepTick,
  SPACING_MS,
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

Deno.test("planTick: first pass, continue, done, daily re-pass, state change, backoff, lease, restart", () => {
  const now = Date.parse("2026-10-01T06:00:00Z");
  const k = "K";
  const p = (o: Partial<ReturnType<typeof freshProgress>>) => ({ ...freshProgress(k, now - 1000, 3), ...o });
  assertEquals(planTick(null, k, now), { run: true, fresh: true, reason: "first_pass" });
  assertEquals(planTick(p({}), k, now), { run: true, fresh: false, reason: "continue" });
  assertEquals(planTick(p({ done: true, finished_at: new Date(now - 3600_000).toISOString() }), k, now), { run: false, reason: "done" });
  assertEquals(planTick(p({ done: true, finished_at: new Date(now - REPASS_MS).toISOString() }), k, now).reason, "daily_repass");
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

  // idle until the daily re-pass: no Telegram calls
  const before = tg.calls.length;
  c.advance(60_000);
  assertEquals((await runMenuSweepTick(db, opts)).reason, "done");
  assertEquals(tg.calls.length, before);
  c.advance(REPASS_MS);
  assertEquals((await runMenuSweepTick(db, opts)).reason, "daily_repass");
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
  c.advance(60_000);
  assertEquals((await runMenuSweepTick(db, opts)).reason, "backoff");
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
        const qq = q as any;
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
