import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type Due, probeAll, quietHour, runOnce, verdictOf } from "./check.ts";

Deno.test("verdictOf: only a clean left/kicked is 'not'; every error is 'error' (never locks)", () => {
  assertEquals(verdictOf({ ok: true, result: { status: "member" } }), "member");
  assertEquals(verdictOf({ ok: true, result: { status: "administrator" } }), "member");
  assertEquals(verdictOf({ ok: true, result: { status: "restricted", is_member: true } }), "member");
  assertEquals(verdictOf({ ok: true, result: { status: "restricted", is_member: false } }), "not");
  assertEquals(verdictOf({ ok: true, result: { status: "left" } }), "not");
  assertEquals(verdictOf({ ok: true, result: { status: "kicked" } }), "not");
  assertEquals(verdictOf({ ok: false, error_code: 429 }), "rate_limited");
  assertEquals(verdictOf({ ok: false, error_code: 400, description: "Bad Request: user not found" }), "error");
  assertEquals(verdictOf(null), "error");
});

Deno.test("probeAll: a member anywhere wins; one error among 'not's is unknown; no chats is unknown", async () => {
  const p = (m: Record<number, "member" | "not" | "error">) => (c: number) => Promise.resolve(m[c]);
  assertEquals(await probeAll([1, 2, 3], 9, p({ 1: "not", 2: "member", 3: "error" })), { state: "member", chat: 2 });
  assertEquals((await probeAll([1, 2], 9, p({ 1: "not", 2: "not" }))).state, "not");
  assertEquals((await probeAll([1, 2], 9, p({ 1: "not", 2: "error" }))).state, "unknown");
  assertEquals((await probeAll([], 9, p({}))).state, "unknown");
});

const NOON_TK = Date.parse("2026-11-02T07:00:00Z");   // 12:00 Tashkent
function world(rows: Partial<Due>[], verdicts: Record<number, "member" | "not" | "error" | "rate_limited">, recordResult: Record<string, unknown> = {}, now = NOON_TK) {
  const recorded: Record<string, unknown>[] = [];
  const warned: string[] = [];
  const sent: number[] = [];
  const health: Record<string, unknown>[] = [];
  const placed: Record<string, unknown>[] = [];
  const admin = {
    from: (t: string) => {
      const b: any = {
        select: () => b, eq: () => b, in: () => b,
        maybeSingle: () => Promise.resolve({ data: t === "platform_settings" ? { value: { grace_hours: 24, batch: 300 } } : null }),
        insert: (p: Record<string, unknown>) => { health.push(p); return Promise.resolve({ error: null }); },
        then: (res: any) => res({ data: t === "courses" ? [{ id: "c7", title: "AI CREATORS CHALLENGE 7.0", telegram_channel_url: "https://t.me/+x" }] : [], error: null }),
      };
      return b;
    },
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (fn === "course_membership_due") {
        return Promise.resolve({ data: rows.map((r, i) => ({ user_id: `u${i}`, course_id: "c7", telegram_id: 100 + i, chats: [-1, -2], member: null, ready: true, ...r })), error: null });
      }
      if (fn === "course_membership_record") {
        recorded.push(args);
        const base = args._member === false ? { state: "not_member", warned: false, locked: false } : { state: args._member ? "member" : "unknown" };
        return Promise.resolve({ data: { ...base, ...recordResult }, error: null });
      }
      if (fn === "course_membership_mark_warned") { warned.push(String(args._uid)); return Promise.resolve({ data: null, error: null }); }
      if (fn === "course_membership_place") { placed.push(args); return Promise.resolve({ data: "g2", error: null }); }
      return Promise.resolve({ data: null, error: null });
    },
  };
  const probe = (chat: number, tg: number) => Promise.resolve(verdicts[tg * 10 + Math.abs(chat)] ?? verdicts[tg] ?? "not");
  const send = (chatId: number) => { sent.push(chatId); return Promise.resolve(true); };
  return { io: { admin, probe, send, now: () => now }, recorded, warned, sent, health, placed };
}

Deno.test("runOnce: member / not / unknown are recorded as such; the absent one gets ONE warning DM", async () => {
  const w = world([{}, {}, {}], { 100: "member", 101: "not", 102: "error" });
  const out = await runOnce(w.io as any);
  assertEquals([out.member, out.not_member, out.unknown], [1, 1, 1]);
  assertEquals(w.recorded.map((r) => r._member), [true, false, null]);
  assertEquals(w.sent, [101]);
  assertEquals(w.warned, ["u1"]);
  assert(w.health.some((h) => h.action === "course_membership_check"));
});

Deno.test("runOnce: a course whose chats are not all known records NOTHING (nobody can be locked)", async () => {
  const w = world([{ ready: false }, { ready: false }], { 100: "not", 101: "not" });
  const out = await runOnce(w.io as any);
  assertEquals(out.not_ready, 2);
  assertEquals(w.recorded.length, 0);
  assertEquals(w.sent.length, 0);
});

Deno.test("runOnce: an absence already warned is not warned again", async () => {
  const w = world([{}], { 100: "not" }, { warned: true });
  await runOnce(w.io as any);
  assertEquals(w.sent.length, 0);
  assertEquals(w.warned.length, 0);
});

Deno.test("runOnce: a channel-registered student found in a real group is placed there; found only in the channel, not", async () => {
  // chats: group -2 first, channel -1 last (as the SQL orders them)
  const inGroup = world([{ chats: [-2, -1], channel_chat_id: -1, in_holding: true }], { 1002: "member" });
  await runOnce(inGroup.io as any);
  assertEquals(inGroup.placed.map((x) => x._chat_id), [-2]);
  const inChannel = world([{ chats: [-2, -1], channel_chat_id: -1, in_holding: true }], { 1002: "not", 1001: "member" });
  await runOnce(inChannel.io as any);
  assertEquals(inChannel.placed.length, 0);
  const alreadyPlaced = world([{ chats: [-2, -1], channel_chat_id: -1, in_holding: false }], { 1002: "member" });
  await runOnce(alreadyPlaced.io as any);
  assertEquals(alreadyPlaced.placed.length, 0);
});

Deno.test("quiet hours: no warning DM at night (warned_at stays unset, the 08:00 run sends it); state still recorded", async () => {
  assertEquals([quietHour(Date.parse("2026-11-02T18:00:00Z")), quietHour(Date.parse("2026-11-02T02:59:00Z")), quietHour(NOON_TK)], [true, true, false]);
  const w = world([{}], { 100: "not" }, {}, Date.parse("2026-11-02T18:30:00Z"));   // 23:30 Tashkent
  await runOnce(w.io as any);
  assertEquals(w.recorded.map((r) => r._member), [false]);
  assertEquals([w.sent.length, w.warned.length], [0, 0]);
});

Deno.test("a 429 stops the run and records nothing for that student (fail-open, next run continues)", async () => {
  const w = world([{}, {}], { 100: "rate_limited", 101: "not" });
  const out = await runOnce(w.io as any);
  assertEquals(out.stopped, "rate_limited");
  assertEquals(w.recorded.length, 0);
});
