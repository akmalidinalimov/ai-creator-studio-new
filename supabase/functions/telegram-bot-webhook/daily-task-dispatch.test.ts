// Tests for the daily-task decision layer (Daily Tasks PR-4).
// Run: deno test supabase/functions/telegram-bot-webhook/daily-task-dispatch.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  botStatusDetails, buildSnapshot, createDailyTopicsCache, type DailyCacheResult, type DailyLoadResult, parseDailyConfig,
  parseTopics, planCapture, routeDaily,
} from "./daily-task-dispatch.ts";

// The live daily topics on 2026-09-30 (prod, read-only): 5-GURUH and 6-GURUH BOTH use thread 10, in different chats.
const COURSE = "f502f631-2104-4834-b6c2-702cd3080e27";
const TOPICS = [
  { group_id: "g1", course_id: COURSE, chat_id: -1004440955972, thread_id: 144, is_test: false },
  { group_id: "g2", course_id: COURSE, chat_id: -1004390902020, thread_id: 99, is_test: false },
  { group_id: "g3", course_id: COURSE, chat_id: -1003714608284, thread_id: 38, is_test: false },
  { group_id: "g4", course_id: COURSE, chat_id: -1004463424516, thread_id: 12, is_test: false },
  { group_id: "g5", course_id: COURSE, chat_id: -1004396568866, thread_id: 10, is_test: false },
  { group_id: "g6", course_id: COURSE, chat_id: -1004423411304, thread_id: 10, is_test: false },
];
const ACTIVE = { active: true, auto_register: true, receipts: true, max_moves_per_submission: 5, max_attempts_per_task: 3, ig: { tag_handle: "aicreators.students" } };
const SEED = { enabled: false, active: false, auto_register: true };

function ok(load: Partial<DailyLoadResult>): DailyCacheResult {
  return { ok: true, snap: buildSnapshot({ topics: TOPICS, topicsError: null, config: ACTIVE, configError: null, ...load }, 0) };
}

Deno.test("routeDaily: (chat, thread) — thread 10 is a daily topic in 5- AND 6-GURUH chats only, never by number alone", () => {
  const res = ok({});
  const r5 = routeDaily(res, -1004396568866, 10);
  const r6 = routeDaily(res, -1004423411304, 10);
  assertEquals(r5.kind === "capture" && r5.topic.group_id, "g5");
  assertEquals(r6.kind === "capture" && r6.topic.group_id, "g6");
  assertEquals(routeDaily(res, -1004440955972, 10).kind, "not_daily"); // 1-GURUH's thread 10 is not its daily topic
  assertEquals(routeDaily(res, -1004463424516, 7).kind, "not_daily");  // 4-GURUH homework topic
  assertEquals(routeDaily(res, -1004440955972, 1).kind, "not_daily");  // General
  assertEquals(routeDaily(res, -1004440955972, null).kind, "not_daily");
  assertEquals(routeDaily(res, "x", 144).kind, "not_daily");
});

Deno.test("routeDaily: INERT — enabled=false (the PR-1 seed) or a missing/failed config RPC is 'inactive'; failed topics 'unavailable'", () => {
  const seeded = routeDaily(ok({ config: SEED }), -1004440955972, 144);
  assertEquals(seeded.kind, "inactive");
  assertEquals(seeded.kind === "inactive" && seeded.reason, "disabled");
  const missing = routeDaily(ok({ config: null, configError: "PGRST202: Could not find the function" }), -1004440955972, 144);
  assertEquals(missing.kind, "inactive");
  assertEquals(missing.kind === "inactive" && missing.reason.startsWith("PGRST202"), true);
  assertEquals(routeDaily({ ok: false, error: "boom" }, -1004440955972, 144).kind, "unavailable");
  // unavailable never matters for a message that has no thread (General / DMs)
  assertEquals(routeDaily({ ok: false, error: "boom" }, -1004440955972, null).kind, "not_daily");
});

Deno.test("parseTopics / parseDailyConfig: malformed rows never widen the match; config defaults", () => {
  assertEquals(parseTopics([{ group_id: "g", chat_id: 5, thread_id: 10 }, { group_id: "", chat_id: -1, thread_id: 10 },
    { group_id: "g", chat_id: -100, thread_id: 1 }, null, "x"]).length, 0);
  assertEquals(parseTopics(TOPICS).length, 6);
  assertEquals(parseDailyConfig(null), null);
  assertEquals(parseDailyConfig([]), null);
  assertEquals(parseDailyConfig({}), { active: false, autoRegister: true, receipts: true, maxMoves: 5, maxAttempts: 3, tagHandle: "aicreators.students" });
  assertEquals(parseDailyConfig({ active: "true", auto_register: false, max_moves_per_submission: -1 })!.active, false);
  assertEquals(parseDailyConfig({ active: true, auto_register: false })!.autoRegister, false);
});

Deno.test("cache: one load per 60 s, shared in-flight, short error TTL, never throws", async () => {
  let t = 0;
  let loads = 0;
  let fail = false;
  const cache = createDailyTopicsCache(async () => {
    loads++;
    await Promise.resolve();
    if (fail) return { topics: null, topicsError: "42501: permission denied", config: null, configError: null };
    return { topics: TOPICS, topicsError: null, config: ACTIVE, configError: null };
  }, { now: () => t });
  const [a, b] = await Promise.all([cache.get(), cache.get()]);
  assertEquals(loads, 1); // concurrent callers share the in-flight load
  assert(a.ok && b.ok);
  t = 59_999;
  await cache.get();
  assertEquals(loads, 1);
  t = 60_000;
  fail = true;
  const e = await cache.get();
  assertEquals(loads, 2);
  assertEquals(e.ok, false);
  t = 65_000;
  await cache.get(); // within the 10 s error TTL: no hammering
  assertEquals(loads, 2);
  t = 70_001;
  fail = false;
  assert((await cache.get()).ok);
  assertEquals(loads, 3);
  const throwing = createDailyTopicsCache(() => Promise.reject(new Error("net")), { now: () => 0 });
  const r = await throwing.get();
  assertEquals(r.ok, false);
});

Deno.test("planCapture: paused / not a topic / engine error → fall through to today's behaviour", () => {
  for (const o of ["disabled", "not_task_topic", "error"]) assertEquals(planCapture({ status: "ok", outcome: o }).fallThrough, true, o);
  assertEquals(planCapture({ status: "error", outcome: "error", reason: "bad_message" }).fallThrough, true);
  assertEquals(planCapture(null).fallThrough, true);
});

Deno.test("planCapture: unknown_sender — identity only for a work-shaped post, and only once", () => {
  assertEquals(planCapture({ status: "ok", outcome: "unknown_sender", shaped: true }).needsIdentity, true);
  assertEquals(planCapture({ status: "ok", outcome: "unknown_sender", shaped: false }).needsIdentity, false);
  assertEquals(planCapture({ status: "ok", outcome: "unknown_sender", shaped: true }, { identityTried: true }).needsIdentity, false);
  assertEquals(planCapture({ status: "ok", outcome: "unknown_sender", shaped: true }).fallThrough, false);
});

Deno.test("planCapture: a created submission → reply receipt (no reaction: the reply IS the acknowledgement)", () => {
  const p = planCapture({
    status: "ok", outcome: "created", submission: { id: 41 }, reaction: "👍",
    receipt: { send: true, mode: "reply", carries_welcome: true, reply_to_message_id: 900, receipt_message_id: null, version: 2 },
  });
  assertEquals(p.receipt, "reply");
  assertEquals(p.submissionId, 41);
  assertEquals(p.receiptVersion, 2);
  assertEquals(p.replyTo, 900);
  assertEquals(p.welcome, true);
  assertEquals(p.reactWith, null);
});

Deno.test("planCapture: edit / degraded reaction / extras / album / queued welcome", () => {
  const edit = planCapture({ status: "ok", outcome: "appended", submission: { id: 41 }, reaction: "👀",
    receipt: { send: true, mode: "edit", receipt_message_id: 555, version: 3 } });
  assertEquals([edit.receipt, edit.receiptMessageId, edit.reactWith], ["edit", 555, "👀"]);
  const degraded = planCapture({ status: "ok", outcome: "created", submission: { id: 41 }, reaction: "👍", receipt: { send: false, mode: "reaction" } });
  assertEquals([degraded.receipt, degraded.reactWith], [null, "👍"]);
  const extra = planCapture({ status: "ok", outcome: "appended_extra", submission: { id: 41 }, reaction: "👍", receipt: { send: false, mode: "none" } });
  assertEquals([extra.receipt, extra.reactWith], [null, "👍"]);
  const album = planCapture({ status: "ok", outcome: "appended_album", submission: { id: 41 }, reaction: null, receipt: { mode: "none" } });
  assertEquals([album.receipt, album.reactWith], [null, null]);
  const queued = planCapture({ status: "ok", outcome: "created", submission: { id: 41 }, reaction: "👀", receipt: { send: false, mode: "queued" } });
  assertEquals(queued.receipt, null);
  // an 'edit' with no message id is not actionable
  assertEquals(planCapture({ status: "ok", outcome: "appended", submission: { id: 41 }, receipt: { mode: "edit", receipt_message_id: null } }).receipt, null);
});

Deno.test("planCapture: silent rows, held hints, duplicates, wrong group, username match", () => {
  for (const o of ["comment", "ignored_kind", "forward_other", "staff", "anonymous", "bot", "outside_window", "voided_sender", "daily_cap"]) {
    const p = planCapture({ status: "ok", outcome: o });
    assertEquals([p.fallThrough, p.receipt, p.reactWith, p.hint], [false, null, null, null], o);
  }
  const held = planCapture({ status: "ok", outcome: "no_group", user_id: "u", hint: { kind: "held", url: null } });
  assertEquals([held.hint, held.receipt], ["held", null]);
  assertEquals(planCapture({ status: "ok", outcome: "sender_out_of_scope", hint: null }).hint, null); // not the first today
  const dup = planCapture({ status: "ok", outcome: "duplicate", submission: { id: 41 }, reaction: "👍", receipt: { send: false, mode: "none" } });
  assertEquals([dup.receipt, dup.reactWith], [null, null]); // a replay never re-sends or re-reacts
  const wg = planCapture({ status: "ok", outcome: "wrong_group", hint: { kind: "wrong_group", url: "https://t.me/c/1/2" } });
  assertEquals(wg.hint, "wrong_group");
  const ns = planCapture({ status: "ok", outcome: "no_slot", reason: "before_open", hint: { kind: "no_slot_before_open", url: null } });
  assertEquals(ns.hint, "no_slot_before_open");
  assertEquals(planCapture({ status: "ok", outcome: "created", resolved_via: "username_match", submission: { id: 1 } }).linkUsername, true);
});

Deno.test("botStatusDetails: the my_chat_member shape (live sample 2026-09-30, 6-GURUH)", () => {
  const d = botStatusDetails({
    chat: { id: -1004423411304, type: "supergroup" }, from: { id: 111 }, date: 1759232498,
    old_chat_member: { status: "left" },
    new_chat_member: { status: "administrator", can_delete_messages: false, can_manage_topics: true },
  });
  assertEquals(d, { chat: -1004423411304, old_status: "left", new_status: "administrator", can_delete_messages: false,
    can_manage_topics: true, changed_by: 111, at_unix: 1759232498 });
  assertEquals(botStatusDetails({ chat: { id: 1 } }), null);
  assertEquals(botStatusDetails(null), null);
});
