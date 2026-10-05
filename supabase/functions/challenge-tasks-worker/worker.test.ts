// Unit tests for challenge-tasks-worker/worker.ts over a scripted fake Supabase client and a recording sender (no
// network, no database, no permissions — CI's plain `deno test supabase/functions/`). The same run() against the REAL
// SQL engine is covered by the PGlite harness (_challenge/testing/daily-tasks-worker-check.ts).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SendResultOutcome } from "../_shared/telegram-send.ts";
import type { SendFn } from "./registrar.ts";
import { createPacer, roundRobin, runWorker, type WorkerEnv, type WorkerIO } from "./worker.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const ENV: WorkerEnv = { botToken: "t", botUsername: "aicreatorsdarsliklari_bot", supabaseUrl: "https://x.test", serviceKey: "k" };
const ACTIVE = { active: true, post: true, receipts: true, dm: true, auto_register: true, max_moves_per_submission: 5,
                 max_attempts_per_task: 3, ig: { tag_handle: "aicreators.students" } };

function out(klass: SendResultOutcome["klass"] = "ok", extra: Partial<SendResultOutcome> = {}): SendResultOutcome {
  const good = klass === "ok" || klass === "not_modified";
  return { ok: good, status: good ? 200 : 400, error: good ? null : klass, klass, retryAfterSec: null,
           terminal: ["recipient", "content", "topic_missing", "message_gone"].includes(klass), recipient: klass === "recipient",
           content: klass === "content", ...extra };
}

/** A fake service-role client: rpc handlers by name (each call recorded), table rows for from() reads, inserts recorded. */
function fake(rpc: Record<string, (args: Row, n: number) => Row | null>, tables: Record<string, Row[]> = {}, failing: string[] = []) {
  const calls: { name: string; args: Row }[] = [];
  const inserts: { table: string; row: Row }[] = [];
  const counts = new Map<string, number>();
  const admin = {
    rpc(name: string, args: Row = {}) {
      calls.push({ name, args });
      const n = (counts.get(name) ?? 0) + 1;
      counts.set(name, n);
      const h = rpc[name];
      return Promise.resolve(h ? (h(args, n) ?? { data: null, error: null }) : { data: null, error: null });
    },
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const b: Row = {
        select: () => b,
        eq: (c: string, v: unknown) => { if (!c.includes("->>")) filters.push((r) => String(r[c]) === String(v)); return b; },
        in: (c: string, v: unknown[]) => { filters.push((r) => v.map(String).includes(String(r[c]))); return b; },
        gte: () => b, limit: () => b, is: () => b, order: () => b,
        update: () => b,
        insert: (row: Row) => { inserts.push({ table, row }); return Promise.resolve({ data: null, error: null }); },
        maybeSingle: () => Promise.resolve(failing.includes(table)
          ? { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }
          : { data: rows()[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve({ data: rows(), error: null }).then(res, rej),
      };
      return b;
    },
  };
  return { admin, calls, inserts, named: (n: string) => calls.filter((c) => c.name === n) };
}

function io(admin: unknown, send: SendFn, extra: Partial<WorkerIO> = {}) {
  let t = 1_000_000;
  const slept: number[] = [];
  const x: WorkerIO = {
    admin, send, fetchFn: (() => Promise.reject(new Error("no network in unit tests"))) as unknown as typeof fetch,
    now: () => t, sleep: (ms) => { slept.push(ms); t += ms; return Promise.resolve(); }, ...extra,
  };
  return { io: x, slept, advance: (ms: number) => { t += ms; } };
}

function recorder(script?: (method: string, payload: Row) => { outcome: SendResultOutcome; result: unknown } | null) {
  const sent: { method: string; payload: Row; opts: Row }[] = [];
  let mid = 500;
  const send: SendFn = (method, payload, opts) => {
    sent.push({ method, payload, opts: opts ?? {} });
    return Promise.resolve(script?.(method, payload) ?? { outcome: out(), result: method === "sendMessage" ? { message_id: mid++ } : true });
  };
  return { send, sent };
}

const cfgOnly = (cfg: Row) => ({ challenge_tasks_config: () => ({ data: cfg, error: null }) });
const once = (items: Row[]) => (_a: Row, n: number) => ({ data: { ok: true, items: n === 1 ? items : [] }, error: null });

Deno.test("roundRobin interleaves keys, stable within a key", () => {
  const r = roundRobin([{ c: "a", i: 1 }, { c: "a", i: 2 }, { c: "b", i: 3 }, { c: "a", i: 4 }, { c: "c", i: 5 }], (x) => x.c);
  assertEquals(r.map((x) => x.i), [1, 3, 5, 2, 4]);
});

Deno.test("createPacer: spaces one key, blocks for retry_after, refuses a slot past the budget", async () => {
  const { io: x, slept, advance } = io(null, recorder().send);
  const p = createPacer(x, 3_100);
  assert(await p.wait("chat", () => 45_000));
  assert(await p.wait("chat", () => 45_000));
  assertEquals(slept, [3_100]);
  assert(await p.wait("other", () => 45_000));
  assertEquals(slept.length, 1, "another chat never waits for this one");
  assertEquals(await p.wait("chat", () => 2_500), false, "a slot beyond the remaining budget is left for the next run");
  p.block("chat", 7);
  assert(p.blocked("chat"));
  advance(7_001);
  assertEquals(p.blocked("chat"), false);
});

Deno.test("inactive: claims nothing, sends nothing; a DB-visible run row", async () => {
  const f = fake(cfgOnly({ active: false }));
  const r = recorder();
  const res = await runWorker(ENV, io(f.admin, r.send).io, { mode: "run" });
  assertEquals(res.body.status, "inactive");
  assertEquals(f.calls.map((c) => c.name), ["challenge_tasks_config"]);
  assertEquals(r.sent.length, 0);
  assertEquals(f.inserts.filter((i) => i.row.action === "challenge_task_worker_run").length, 1);
});

Deno.test("no bot token: nothing is claimed (a claim would burn an attempt)", async () => {
  const f = fake(cfgOnly(ACTIVE));
  const res = await runWorker({ ...ENV, botToken: "" }, io(f.admin, recorder().send).io, {});
  assertEquals(res.body.status, "no_bot_token");
  assertEquals(f.calls.map((c) => c.name), ["challenge_tasks_config"]);
  assertEquals(f.inserts[0]?.row.action, "challenge_task_worker_no_bot_token");
});

Deno.test("config RPC failing → 'crashed' (the watchdog's worker_errors alarm reads it), 500", async () => {
  const f = fake({ challenge_tasks_config: () => ({ data: null, error: { code: "42883", message: "missing" } }) });
  const res = await runWorker(ENV, io(f.admin, recorder().send).io, {});
  assertEquals(res.httpStatus, 500);
  assertEquals(f.inserts[0]?.row.details.status, "crashed");
});

Deno.test("posts: a task with image_url goes out as ONE photo with the task as its caption; the summary stays text", async () => {
  const items = [
    { task_id: 7, group_id: "g1", kind: "task", token: "t1", chat_id: -1001, thread_id: 144, text: "📅 <b>2-KUN VAZIFASI</b>\n<b>Vazifa</b>" },
    { task_id: 7, group_id: "g2", kind: "summary", token: "t2", chat_id: -1002, thread_id: 10, summary: { done: 1, on_time: 1 } },
  ];
  const f = fake({ ...cfgOnly(ACTIVE), challenge_task_post_claim: once(items), challenge_task_post_record: () => ({ data: { ok: true }, error: null }) },
    { challenge_tasks: [{ id: 7, image_url: "https://www.aicreator.academy/challenge/days/day-2.jpg" }] });
  const r = recorder((m) => m === "sendPhoto" ? { outcome: out(), result: { message_id: 900 } } : null);
  await runWorker(ENV, io(f.admin, r.send).io, {});
  assertEquals(r.sent[0].method, "sendPhoto");
  assertEquals(r.sent[0].payload.photo, "https://www.aicreator.academy/challenge/days/day-2.jpg");
  assertEquals(r.sent[0].payload.caption, "📅 <b>2-KUN VAZIFASI</b>\n<b>Vazifa</b>");
  assertEquals(r.sent[0].payload.parse_mode, "HTML");
  assertEquals(r.sent[0].payload.message_thread_id, 144);
  assertEquals(r.sent[0].payload.reply_markup, undefined);
  assertEquals(r.sent[1].method, "sendMessage", "the 20:00 summary is never a photo");
  assertEquals(f.named("challenge_task_post_record")[0].args._message_id, 900);
});

Deno.test("posts: a photo Telegram refuses falls back to the text post in the same run, DB-visibly", async () => {
  const items = [{ task_id: 7, group_id: "g1", kind: "task", token: "t1", chat_id: -1001, thread_id: 144, text: "<b>Vazifa</b>" }];
  const f = fake({ ...cfgOnly(ACTIVE), challenge_task_post_claim: once(items), challenge_task_post_record: () => ({ data: { ok: true }, error: null }) },
    { challenge_tasks: [{ id: 7, image_url: "https://www.aicreator.academy/challenge/days/day-2.jpg" }] });
  const r = recorder((m) => m === "sendPhoto" ? { outcome: out("content"), result: null } : null);
  await runWorker(ENV, io(f.admin, r.send).io, {});
  assertEquals(r.sent.map((s) => s.method), ["sendPhoto", "sendMessage"]);
  assertEquals(r.sent[1].payload.text, "<b>Vazifa</b>");
  assert(f.inserts.some((i) => i.row.action === "challenge_task_post_photo_failed"));
  assertEquals(f.named("challenge_task_post_record")[0].args._error, null);
});

Deno.test("posts: a caption over 1024 visible characters is posted as text, DB-visibly; rate limit on the photo is not retried as text", async () => {
  const long = "<b>Vazifa</b>\n" + "x".repeat(1100);
  const items = [
    { task_id: 7, group_id: "g1", kind: "task", token: "t1", chat_id: -1001, thread_id: 144, text: long },
    { task_id: 8, group_id: "g2", kind: "task", token: "t2", chat_id: -1002, thread_id: 99, text: "<b>Qisqa</b>" },
  ];
  const f = fake({ ...cfgOnly(ACTIVE), challenge_task_post_claim: once(items), challenge_task_post_record: () => ({ data: { ok: true }, error: null }) },
    { challenge_tasks: [{ id: 7, image_url: "https://www.aicreator.academy/challenge/days/day-2.jpg" },
                        { id: 8, image_url: "https://www.aicreator.academy/challenge/days/day-3.jpg" }] });
  const r = recorder((m, p) => m === "sendPhoto" && p.chat_id === -1002 ? { outcome: out("rate_limited", { retryAfterSec: 5 }), result: null } : null);
  await runWorker(ENV, io(f.admin, r.send).io, {});
  assertEquals(r.sent.filter((s) => s.payload.chat_id === -1001).map((s) => s.method), ["sendMessage"]);
  assert(f.inserts.some((i) => i.row.action === "challenge_task_post_caption_too_long"));
  assertEquals(r.sent.filter((s) => s.payload.chat_id === -1002).map((s) => s.method), ["sendPhoto"], "429 waits for the next run");
});

Deno.test("posts: sent → recorded with the message id; 429 → left leased (no record); refused → recorded with the class", async () => {
  const items = [
    { task_id: 1, group_id: "g1", kind: "task", token: "t1", chat_id: -1001, thread_id: 144, text: "<b>Vazifa</b>" },
    { task_id: 1, group_id: "g2", kind: "task", token: "t2", chat_id: -1002, thread_id: 99, text: "<b>Vazifa</b>" },
    { task_id: 1, group_id: "g3", kind: "summary", token: "t3", chat_id: -1003, thread_id: 10, summary: { done: 1, on_time: 1 } },
  ];
  const f = fake({ ...cfgOnly(ACTIVE), challenge_task_post_claim: once(items), challenge_task_post_record: () => ({ data: { ok: true }, error: null }) });
  const r = recorder((_m, p) => p.chat_id === -1002 ? { outcome: out("rate_limited", { retryAfterSec: 9 }), result: null }
    : p.chat_id === -1003 ? { outcome: out("topic_missing"), result: null } : null);
  const res = await runWorker(ENV, io(f.admin, r.send).io, {});
  assertEquals(r.sent.length, 3);
  assertEquals(r.sent[0].payload.message_thread_id, 144);
  // no «open in the bot» button under a group post: students submit in the topic (owner, 2026-10-05)
  assertEquals(r.sent[0].payload.reply_markup, undefined);
  assertEquals(r.sent[2].payload.reply_markup, undefined);
  assertEquals(r.sent[0].opts.topicMissingAction, "challenge_task_topic_missing");
  assert(String(r.sent[2].payload.text).startsWith("📊 <b>Bugungi vazifa natijasi</b>"), "a summary item is rendered here");
  const rec = f.named("challenge_task_post_record").map((c) => c.args);
  assertEquals(rec.length, 2, "the rate-limited post is NOT recorded (its lease expires; the next run retries)");
  assertEquals(rec[0], { _task_id: 1, _group_id: "g1", _kind: "task", _token: "t1", _message_id: 500, _error: null });
  assertEquals(rec[1]._message_id, null);
  assertEquals(rec[1]._error, "topic_missing: topic_missing");
  assertEquals(res.body.posts, { sent: 1, deferred: 1, failed: 1 });
  assertEquals(f.named("challenge_task_post_claim").length, 1, "posts: ONE claim per run (a failed post is never retried in a loop)");
});

Deno.test("receipts: reply in the topic under the work; edit; message_gone → a fresh reply; transient young → deferred", async () => {
  const sub = (id: number, extra: Row) => ({
    status: "ok", outcome: "receipt", user_id: "u1", group_id: "g1", token: `r${id}`,
    submission: { id, status: "accepted", points: 5, late_days: 0, task: { id: 1, date: "2026-10-05" } },
    ...extra,
  });
  const items = [
    sub(1, { receipt: { chat_id: -1001, reply_to_message_id: 77, receipt_message_id: null, version: 1, mode: "reply", carries_welcome: true } }),
    sub(2, { receipt: { chat_id: -1002, reply_to_message_id: 78, receipt_message_id: 900, version: 2, mode: "edit" } }),
    sub(3, { receipt: { chat_id: -1003, reply_to_message_id: 79, receipt_message_id: 901, version: 3, mode: "edit" } }),
    sub(4, { receipt: { chat_id: -1004, reply_to_message_id: 80, receipt_message_id: null, version: 1, mode: "reply" } }),
  ];
  const f = fake({
    ...cfgOnly(ACTIVE),
    challenge_task_topics: () => ({ data: [{ group_id: "g1", chat_id: -1001, thread_id: 144 }], error: null }),
    challenge_task_receipt_claim: once(items),
    challenge_task_receipt_record: () => ({ data: { ok: true }, error: null }),
  }, {
    profiles: [{ id: "u1", name: "Dilnoza Karimova", preferred_locale: "uz" }],
    challenge_task_messages: [{ chat_id: -1004, message_id: 80, thread_id: 12 }],
    challenge_task_submissions: [{ id: 4, updated_at: new Date(1_000_000 - 5 * 60_000).toISOString() }],
  });
  const r = recorder((m, p) => m === "editMessageText" && p.chat_id === -1003 ? { outcome: out("message_gone"), result: null }
    : m === "sendMessage" && p.chat_id === -1004 ? { outcome: out("transient"), result: null } : null);
  const res = await runWorker(ENV, io(f.admin, r.send).io, {});
  const [a, b, c1, c2, d] = r.sent;
  assertEquals([a.method, a.payload.chat_id, a.payload.message_thread_id, a.payload.reply_parameters?.message_id], ["sendMessage", -1001, 144, 77]);
  assert(String(a.payload.text).startsWith("👋 <b>Dilnoza</b>"), "the welcome is folded into the receipt (G7)");
  assertEquals([b.method, b.payload.message_id], ["editMessageText", 900]);
  assertEquals([c1.method, c2.method, c2.payload.reply_parameters?.message_id], ["editMessageText", "sendMessage", 79]);
  assertEquals([d.method, d.payload.message_thread_id], ["sendMessage", 12], "the thread comes from the ledger when the group is not a topic");
  const rec = f.named("challenge_task_receipt_record").map((x) => x.args);
  assertEquals(rec.map((x) => [x._sub, x._ok, x._message_id]), [[1, true, 500], [2, true, 900], [3, true, 501]]);
  assertEquals(rec[0]._token, "r1");
  assertEquals(res.body.receipts, { sent: 3, reposted: 1, deferred: 1 });
});

Deno.test("receipts: a transient failure for over an hour is recorded failed (DB-visible), not retried forever", async () => {
  const items = [{ status: "ok", user_id: "u1", group_id: "g1", token: "r9",
    submission: { id: 9, status: "accepted", task: { id: 1, date: "2026-10-05" } },
    receipt: { chat_id: -1001, reply_to_message_id: 7, version: 4, mode: "reply" } }];
  const f = fake({ ...cfgOnly(ACTIVE), challenge_task_receipt_claim: once(items), challenge_task_receipt_record: () => ({ data: { ok: true }, error: null }) },
    { challenge_task_submissions: [{ id: 9, updated_at: new Date(1_000_000 - 3 * 3_600_000).toISOString() }] });
  const r = recorder(() => ({ outcome: out("transient"), result: null }));
  await runWorker(ENV, io(f.admin, r.send).io, {});
  const rec = f.named("challenge_task_receipt_record").map((x) => x.args);
  assertEquals(rec.length, 1);
  assertEquals([rec[0]._ok, rec[0]._version, rec[0]._token], [false, 4, "r9"]);
});

Deno.test("DMs: sent / blocked → skipped (terminal) / expired → dropped / 429 → stop the DM loop", async () => {
  const items = [
    { id: 1, token: "o1", user_id: "u1", telegram_id: 11, kind: "morning", task_id: 5, payload: { task_id: 5, title: "T", points: 5 } },
    { id: 2, token: "o2", user_id: "u2", telegram_id: 22, kind: "morning", task_id: 5, payload: { task_id: 5, title: "T", points: 5 } },
    { id: 3, token: "o3", user_id: "u3", telegram_id: 33, kind: "evening", payload: { expires_at: new Date(999_000).toISOString(), pending: [{ task_id: 5 }] } },
    { id: 6, token: "o6", user_id: "u6", telegram_id: null, kind: "morning", payload: {} },
    { id: 4, token: "o4", user_id: "u4", telegram_id: 44, kind: "backfill_summary", payload: { submissions: 2, points: 10 } },
    { id: 5, token: "o5", user_id: "u5", telegram_id: 55, kind: "backfill_summary", payload: { submissions: 2, points: 10 } },
  ];
  const f = fake({ ...cfgOnly(ACTIVE), challenge_task_outbox_claim: once(items), challenge_task_outbox_record: () => ({ data: { ok: true }, error: null }) },
    { profiles: [{ id: "u1", name: "Aziz", preferred_locale: "ru" }] });
  const r = recorder((_m, p) => p.chat_id === 22 ? { outcome: out("recipient"), result: null }
    : p.chat_id === 44 ? { outcome: out("rate_limited", { retryAfterSec: 3 }), result: null } : null);
  const res = await runWorker(ENV, io(f.admin, r.send).io, {});
  assert(String(r.sent[0].payload.text).startsWith("☀️ Aziz, доброе утро!"), "the student's locale");
  assertEquals(r.sent.map((s) => s.payload.chat_id), [11, 22, 44], "after the 429 no further DM is sent this run");
  const rec = f.named("challenge_task_outbox_record").map((x) => x.args);
  assertEquals(rec.map((x) => [x._id, x._ok, x._terminal]), [[1, true, false], [2, false, true], [3, false, true], [6, false, true], [4, false, false]]);
  assertEquals(rec[2]._error, "expired");
  assertEquals(rec[3]._error, "no_telegram_id");
  assert(String(rec[4]._error).startsWith("rate_limited"), "a 429 DM is re-queued (+10 min), not terminal");
  assertEquals(res.body.dms, { sent: 1, skipped: 2, expired: 1, deferred: 2 }, "the item after the 429 waits for its lease to expire");
});

Deno.test("result DM: rendered from the CURRENT state; a read failure is retried (failed, not skipped); a moved one is skipped", async () => {
  const items = [
    { id: 7, token: "o7", user_id: "u1", telegram_id: 11, kind: "result", submission_id: 70, payload: { decision: "accepted" } },
    { id: 8, token: "o8", user_id: "u1", telegram_id: 11, kind: "result", submission_id: 80, payload: { decision: "rejected" } },
  ];
  const tables = {
    challenge_task_submissions: [
      { id: 70, status: "accepted", points_awarded: 3, late_days: 1, task_id: 5, group_id: "g1" },
      { id: 80, status: "withdrawn", reason: null, points_awarded: 0, late_days: 0, task_id: 5, group_id: "g1" },
    ],
    challenge_tasks: [{ id: 5, title: "Prompt <1>", task_date: "2026-10-05" }],
    groups: [{ id: "g1", daily_task_topic_url: "https://t.me/c/4440955972/144" }],
  };
  const rpc = { ...cfgOnly(ACTIVE), challenge_task_outbox_claim: once(items), challenge_task_outbox_record: () => ({ data: { ok: true }, error: null }) };
  const f = fake(rpc, tables);
  const r = recorder();
  await runWorker(ENV, io(f.admin, r.send).io, {});
  assertEquals(r.sent.length, 1);
  assertEquals(r.sent[0].payload.text, "✅ «Prompt &lt;1&gt;» (5-oktabr) qabul qilindi: +3 ball (kechikkan — yarim ball).");
  assertEquals(r.sent[0].opts.purpose, "challenge_task_dm_result");
  const rec = f.named("challenge_task_outbox_record").map((x) => x.args);
  assertEquals(rec.map((x) => [x._id, x._ok, x._terminal, x._error]), [[7, true, false, null], [8, false, true, "nothing_to_send"]],
    "a submission withdrawn since the verdict: the group receipt says it; no DM");

  const g = fake(rpc, tables, ["challenge_task_submissions"]);
  const r2 = recorder();
  const res = await runWorker(ENV, io(g.admin, r2.send).io, {});
  assertEquals(r2.sent.length, 0);
  const rec2 = g.named("challenge_task_outbox_record").map((x) => x.args);
  assertEquals(rec2.map((x) => [x._id, x._ok, x._terminal]), [[7, false, false], [8, false, false]]);
  assert(String(rec2[0]._error).startsWith("render_error: "));
  assertEquals(res.body.status, "partial", "the read failure is in the run row");
});

Deno.test("identity sweep: every candidate through the resolver; linked / registered / unresolved tallied; 'attempted' recorded", async () => {
  const cands = [
    { kind: "unknown", tg_user_id: 1, chat_id: -1001, thread_id: 144, message_id: 5, group_id: "g1", course_id: "c6", from: { id: 1, first_name: "A" } },
    { kind: "username_match", tg_user_id: 2, user_id: "p2", chat_id: -1001, thread_id: 144, message_id: 6, group_id: "g1", course_id: "c6", from: { id: 2, username: "b" } },
    { kind: "unknown", tg_user_id: 3, chat_id: -1001, thread_id: 144, message_id: 7, group_id: "g1", course_id: "c6", from: { id: 3 } },
  ];
  const f = fake({ ...cfgOnly(ACTIVE), challenge_task_identity_candidates: () => ({ data: { mode: "regular", candidates: cands }, error: null }) });
  const seen: Row[] = [];
  const resolvePoster = (async (_a: unknown, input: Row, opts: Row = {}) => {
    seen.push({ tg: input.from.id, canRegister: typeof opts.autoRegister === "function", kinds: input.topicKinds, source: input.source });
    if (input.from.id === 1) return { profile: await opts.autoRegister(), via: "auto_register", reason: "auto_register" };
    if (input.from.id === 2) return { profile: { id: "p2" }, via: "username_link", reason: "username_link" };
    return { profile: null, via: null, reason: "auto_register_declined" };
  }) as unknown as WorkerIO["resolvePoster"];
  const registered: Row[] = [];
  const register = (inp: Row) => { registered.push(inp); return Promise.resolve({ id: "new" }); };
  const res = await runWorker(ENV, io(f.admin, recorder().send, { resolvePoster, register: register as WorkerIO["register"] }).io, {});
  assertEquals(seen.map((s) => [s.tg, s.canRegister]), [[1, true], [2, false], [3, true]], "a username match is linked, never registered");
  assert(seen.every((s) => JSON.stringify(s.kinds) === '["daily_task"]' && s.source === "daily_task_post"));
  assertEquals(registered[0].groupId, "g1");
  assertEquals(registered[0].courseId, "c6");
  assertEquals(res.body.identity, { registered: 1, linked: 1, unresolved: 1 });
  const row = f.inserts.find((i) => i.row.action === "challenge_task_identity_sweep")?.row.details;
  assertEquals(row?.attempted, [1, 2, 3]);
  assertEquals(row?.unresolved_senders, [{ tg_user_id: 3, reason: "auto_register_declined" }]);
  assertEquals(row?.mode, "regular");
});

Deno.test("identity sweep: auto_register=false → the gated username link only; window mode validates its window", async () => {
  const cands = [{ kind: "unknown", tg_user_id: 1, chat_id: -1001, thread_id: 144, group_id: "g1", course_id: "c6", from: { id: 1 } }];
  const f = fake({ ...cfgOnly({ ...ACTIVE, auto_register: false }),
    challenge_task_identity_candidates: (a) => ({ data: { candidates: a._exclude.length ? [] : cands }, error: null }) });
  let canRegister = true;
  const resolvePoster = ((_a: unknown, _i: Row, opts: Row = {}) => {
    canRegister = typeof opts.autoRegister === "function";
    return Promise.resolve({ profile: null, via: null, reason: "no_account" });
  }) as unknown as WorkerIO["resolvePoster"];
  const res = await runWorker(ENV, io(f.admin, recorder().send, { resolvePoster }).io, { mode: "identity_sweep", since: "2026-10-01T00:00:00+05:00" });
  assertEquals(canRegister, false);
  assertEquals(res.httpStatus, 200);
  assertEquals(f.named("challenge_task_identity_candidates")[0].args._since, "2026-10-01T00:00:00+05:00");
  assertEquals(f.named("challenge_task_identity_candidates").length, 2, "the window mode pages until the input is empty");
  const bad = await runWorker(ENV, io(fake(cfgOnly(ACTIVE)).admin, recorder().send).io, { mode: "identity_sweep", since: "yesterday" });
  assertEquals(bad.httpStatus, 400);
});
