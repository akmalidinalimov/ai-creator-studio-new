// Tests for the deduped health signal. Run: deno test supabase/functions/_shared/edge.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { logHealth, logHealthOnce, recordGradeCardSkipped, tashkentDayStartIso } from "./edge.ts";

const realError = console.error;
function quiet<T>(fn: () => Promise<T>): Promise<T> {
  console.error = () => {};
  return fn().finally(() => { console.error = realError; });
}

// A service-role-client stub over an in-memory admin_actions table. It honours the exact filter chain
// logHealthOnce builds (action, details->>dedupe_key, created_at >= since), so a test that passes here
// passes because the dedupe logic is right, not because the stub ignores the filters.
function fakeAdmin(opts: { checkError?: boolean; checkThrows?: boolean; insertError?: boolean; seed?: any[] } = {}) {
  const rows: any[] = [...(opts.seed ?? [])];
  let checks = 0;
  const admin = {
    from: (_t: string) => ({
      insert: (row: any) => {
        if (opts.insertError) return Promise.resolve({ error: { message: "boom" } });
        rows.push({ ...row, created_at: new Date().toISOString() });
        return Promise.resolve({ error: null });
      },
      select: (_cols: string) => {
        checks++;
        if (opts.checkThrows) throw new Error("network down");
        const f: { action?: string; key?: string; since?: string } = {};
        const q: any = {
          eq: (col: string, v: string) => {
            if (col === "action") f.action = v;
            if (col === "details->>dedupe_key") f.key = v;
            return q;
          },
          gte: (_col: string, v: string) => { f.since = v; return q; },
          limit: (_n: number) => {
            if (opts.checkError) return Promise.resolve({ data: null, error: { message: "bad filter" } });
            const hit = rows.filter((r) => r.action === f.action && r.details?.dedupe_key === f.key &&
              (!f.since || r.created_at >= f.since));
            return Promise.resolve({ data: hit.slice(0, 1).map((r) => ({ id: "x" })), error: null });
          },
        };
        return q;
      },
    }),
  };
  return { admin, rows, checks: () => checks };
}

// Every test uses its own keys: the isolate memo is module state shared across tests in this file.
let n = 0;
const uniq = (s: string) => `${s}-${++n}-${crypto.randomUUID()}`;

Deno.test("tashkentDayStartIso: 19:00Z is already the NEXT Tashkent day (UTC+5)", () => {
  assertEquals(tashkentDayStartIso(new Date("2026-09-29T19:00:00Z")), "2026-09-29T19:00:00.000Z");
  assertEquals(tashkentDayStartIso(new Date("2026-09-29T18:59:59.999Z")), "2026-09-28T19:00:00.000Z");
  assertEquals(tashkentDayStartIso(new Date("2026-09-29T08:30:00Z")), "2026-09-28T19:00:00.000Z");
  // A day boundary falls on the same instant every day (no DST in Tashkent).
  assertEquals(tashkentDayStartIso(new Date("2026-03-29T12:00:00Z")), "2026-03-28T19:00:00.000Z");
});

Deno.test("logHealthOnce: first call writes one row carrying dedupe_key + source; repeat is skipped", async () => {
  const { admin, rows } = fakeAdmin();
  const key = uniq("k");
  const first = await logHealthOnce(admin, "hw_capture_skipped", key, { reason: "autoreg_off" }, { source: "telegram-bot-webhook" });
  const second = await logHealthOnce(admin, "hw_capture_skipped", key, { reason: "autoreg_off" }, { source: "telegram-bot-webhook" });
  assertEquals([first, second], [true, false]);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].action, "hw_capture_skipped");
  assertEquals(rows[0].details, { reason: "autoreg_off", dedupe_key: key, source: "telegram-bot-webhook" });
});

Deno.test("logHealthOnce: a burst on one isolate (album) writes ONE row even before any insert lands", async () => {
  const { admin, rows } = fakeAdmin();
  const key = uniq("album");
  const results = await Promise.all(Array.from({ length: 10 }, () => logHealthOnce(admin, "hw_capture_failed", key, {})));
  assertEquals(results.filter(Boolean).length, 1);
  assertEquals(rows.length, 1);
});

Deno.test("logHealthOnce: a row written by ANOTHER isolate today is honoured (DB check, not just memo)", async () => {
  const key = uniq("other-isolate");
  const { admin, rows } = fakeAdmin({
    seed: [{ action: "auto_register_failed", details: { dedupe_key: key }, created_at: new Date().toISOString() }],
  });
  assertEquals(await logHealthOnce(admin, "auto_register_failed", key, {}), false);
  assertEquals(rows.length, 1);
});

Deno.test("logHealthOnce: a row from before the window does not suppress a new one", async () => {
  const key = uniq("yesterday");
  const { admin, rows } = fakeAdmin({
    seed: [{ action: "hw_capture_skipped", details: { dedupe_key: key }, created_at: "2020-01-01T00:00:00.000Z" }],
  });
  assertEquals(await logHealthOnce(admin, "hw_capture_skipped", key, {}), true);
  assertEquals(rows.length, 2);
});

Deno.test("logHealthOnce: sinceIso widens the window (grade card: one row per attempt across senders)", async () => {
  const key = uniq("no_telegram:sub:1");
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const { admin, rows } = fakeAdmin({
    seed: [{ action: "grade_card_dm_skipped", details: { dedupe_key: key }, created_at: threeDaysAgo }],
  });
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  assertEquals(await logHealthOnce(admin, "grade_card_dm_skipped", key, {}, { sinceIso: since }), false);
  assertEquals(rows.length, 1);
});

Deno.test("logHealthOnce: same key under a different action is a different signal", async () => {
  const { admin, rows } = fakeAdmin();
  const key = uniq("shared");
  assertEquals(await logHealthOnce(admin, "hw_capture_skipped", key, {}), true);
  assertEquals(await logHealthOnce(admin, "hw_capture_failed", key, {}), true);
  assertEquals(rows.length, 2);
});

Deno.test("logHealthOnce: a failed existence check still records (loud over silent)", async () => {
  const { admin, rows } = fakeAdmin({ checkError: true });
  assertEquals(await quiet(() => logHealthOnce(admin, "hw_capture_failed", uniq("chk"), {})), true);
  assertEquals(rows.length, 1);
});

Deno.test("logHealthOnce: a throwing client never throws into the caller", async () => {
  const { admin } = fakeAdmin({ checkThrows: true, insertError: true });
  assertEquals(await quiet(() => logHealthOnce(admin, "hw_capture_failed", uniq("throw"), {})), false);
});

Deno.test("logHealthOnce: a failed insert releases the memo so a later call can retry", async () => {
  const key = uniq("retry");
  const broken = fakeAdmin({ insertError: true });
  assertEquals(await quiet(() => logHealthOnce(broken.admin, "hw_capture_failed", key, {})), false);
  const healthy = fakeAdmin();
  assertEquals(await logHealthOnce(healthy.admin, "hw_capture_failed", key, {}), true);
  assertEquals(healthy.rows.length, 1);
});

Deno.test("recordGradeCardSkipped: one row per graded attempt whichever sender sees it first", async () => {
  const student = crypto.randomUUID();
  // Row shape, from the first sender to see the attempt.
  const sub1 = crypto.randomUUID();
  const bot = fakeAdmin();
  assertEquals(await recordGradeCardSkipped(bot.admin, { submissionId: sub1, studentId: student, attempt: 1, source: "telegram-bot-webhook" }), true);
  const row = bot.rows[0];
  assertEquals(row.action, "grade_card_dm_skipped");
  assertEquals(row.target_user_id, student);
  assertEquals(row.target_resource_type, "homework_submission");
  assertEquals(row.target_resource_id, sub1);
  assertEquals(row.details.reason, "no_telegram");
  assertEquals(row.details.dedupe_key, `no_telegram:${sub1}:1`);
  assertEquals(row.details.source, "telegram-bot-webhook");

  // Another sender, in another isolate, days later: the DB row (not the memo) suppresses it. The key
  // below was never used in this isolate, so only the existence check can answer.
  const sub2 = crypto.randomUUID();
  const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const reconciler = fakeAdmin({
    seed: [{ action: "grade_card_dm_skipped", details: { dedupe_key: `no_telegram:${sub2}:1` }, created_at: fiveDaysAgo }],
  });
  assertEquals(await recordGradeCardSkipped(reconciler.admin, { submissionId: sub2, studentId: student, attempt: 1, source: "grade-card-reconcile" }), false);
  assertEquals(reconciler.rows.length, 1);
  // A resubmission is a new attempt: its card is owed again, so it is a new row.
  assertEquals(await recordGradeCardSkipped(reconciler.admin, { submissionId: sub2, studentId: student, attempt: 2, source: "grade-card-reconcile" }), true);
  assertEquals(reconciler.rows.length, 2);
});

Deno.test("logHealth: resolves true on insert, false on an insert error (never throws)", async () => {
  assertEquals(await logHealth(fakeAdmin().admin, "x", {}), true);
  assertEquals(await quiet(() => logHealth(fakeAdmin({ insertError: true }).admin, "x", {})), false);
});
