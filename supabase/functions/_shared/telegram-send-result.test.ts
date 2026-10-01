// Tests for sendTelegramWithResult (Daily Tasks PR-4, spec G7).
// Run: deno test supabase/functions/_shared/telegram-send-result.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sendTelegramWithResult } from "./telegram-send.ts";

const TOKEN = "SECRET_TOKEN_do_not_leak_456";
const realFetch = globalThis.fetch;

// A service-role-client stub: records admin_actions inserts and answers logHealthOnce's existence check
// (from().select().eq().eq().gte().limit()) with "no row yet".
function fakeAdmin() {
  const rows: any[] = [];
  const chain: any = {
    select: () => chain, eq: () => chain, gte: () => chain,
    limit: () => Promise.resolve({ data: [], error: null }),
    insert: (row: any) => { rows.push(row); return Promise.resolve({ error: null }); },
  };
  return { admin: { from: (_t: string) => chain }, rows };
}

function stubFetch(body: unknown, status: number) {
  const calls: any[] = [];
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as typeof fetch;
  return calls;
}

function assertNoToken(...values: unknown[]) {
  for (const v of values) assertEquals(JSON.stringify(v).includes(TOKEN), false);
}

Deno.test("sendTelegramWithResult: accepted → ok + Telegram's result (message_id), nothing recorded", async () => {
  const calls = stubFetch({ ok: true, result: { message_id: 777, chat: { id: -100 } } }, 200);
  const { admin, rows } = fakeAdmin();
  try {
    const r = await sendTelegramWithResult(TOKEN, "sendMessage", { chat_id: -100, text: "x" }, { admin });
    assertEquals(r.outcome.ok, true);
    assertEquals(r.outcome.klass, "ok");
    assertEquals(r.result.message_id, 777);
    assertEquals(rows.length, 0);
    assertEquals(calls[0].text, "x");
    assertNoToken(r);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("sendTelegramWithResult: 'message is not modified' → success, no failure row", async () => {
  stubFetch({ ok: false, description: "Bad Request: message is not modified: specified new message content and reply markup are exactly the same" }, 400);
  const { admin, rows } = fakeAdmin();
  try {
    const r = await sendTelegramWithResult(TOKEN, "editMessageText", { chat_id: -100, message_id: 5, text: "same" }, { admin });
    assertEquals(r.outcome.ok, true);
    assertEquals(r.outcome.klass, "not_modified");
    assertEquals(r.outcome.error, "Bad Request: message is not modified: specified new message content and reply markup are exactly the same");
    assertEquals(rows.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("sendTelegramWithResult: 429 → ONE telegram_rate_limited row (never telegram_send_failed), retry_after carried", async () => {
  stubFetch({ ok: false, description: "Too Many Requests: retry after 12", parameters: { retry_after: 12 } }, 429);
  const { admin, rows } = fakeAdmin();
  try {
    const r = await sendTelegramWithResult(TOKEN, "sendMessage", { chat_id: -1001, text: "x" }, { admin, purpose: "challenge_task_receipt" });
    assertEquals(r.outcome.ok, false);
    assertEquals(r.outcome.terminal, false);
    assertEquals(r.outcome.klass, "rate_limited");
    assertEquals(r.outcome.retryAfterSec, 12);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].action, "telegram_rate_limited");
    assertEquals(rows[0].details.retry_after, 12);
    assertEquals(rows.some((x) => x.action === "telegram_send_failed"), false);
    assertNoToken(r, rows);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("sendTelegramWithResult: topic missing + topicMissingAction → that action, terminal, not telegram_send_failed", async () => {
  stubFetch({ ok: false, description: "Bad Request: message thread not found" }, 400);
  const { admin, rows } = fakeAdmin();
  try {
    const r = await sendTelegramWithResult(TOKEN, "sendMessage", { chat_id: -1002, message_thread_id: 144, text: "x" }, {
      admin, topicMissingAction: "challenge_task_topic_missing",
    });
    assertEquals(r.outcome.klass, "topic_missing");
    assertEquals(r.outcome.terminal, true);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].action, "challenge_task_topic_missing");
    assertEquals(rows[0].details.thread_id, 144);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("sendTelegramWithResult: topic missing WITHOUT an action → telegram_send_failed as before", async () => {
  stubFetch({ ok: false, description: "Bad Request: TOPIC_CLOSED" }, 400);
  const { admin, rows } = fakeAdmin();
  try {
    const r = await sendTelegramWithResult(TOKEN, "sendMessage", { chat_id: -1003, text: "x" }, { admin });
    assertEquals(r.outcome.terminal, true);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].action, "telegram_send_failed");
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("sendTelegramWithResult: recipient error → telegram_send_failed (sendTelegram's recording); record:false → nothing", async () => {
  stubFetch({ ok: false, description: "Forbidden: bot was blocked by the user" }, 403);
  const a = fakeAdmin();
  const b = fakeAdmin();
  try {
    const r = await sendTelegramWithResult(TOKEN, "sendMessage", { chat_id: 42, text: "x" }, { admin: a.admin });
    assertEquals(r.outcome.recipient, true);
    assertEquals(a.rows.length, 1);
    assertEquals(a.rows[0].action, "telegram_send_failed");
    assertEquals(a.rows[0].details.recipient_error, true);
    await sendTelegramWithResult(TOKEN, "sendMessage", { chat_id: 42, text: "x" }, { admin: b.admin, record: false });
    assertEquals(b.rows.length, 0);
    assertNoToken(r, a.rows);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("sendTelegramWithResult: transport error → transient, recorded, never throws, token safe", async () => {
  globalThis.fetch = (() => Promise.reject(new Error(`network down for https://api.telegram.org/bot${TOKEN}/x`))) as unknown as typeof fetch;
  const { admin, rows } = fakeAdmin();
  try {
    const r = await sendTelegramWithResult(TOKEN, "sendMessage", { chat_id: 7 }, { admin });
    assertEquals(r.outcome.ok, false);
    assertEquals(r.outcome.klass, "transient");
    assertEquals(r.result, null);
    assertEquals(rows.length, 1);
    assertNoToken(r, rows);
  } finally {
    globalThis.fetch = realFetch;
  }
});
