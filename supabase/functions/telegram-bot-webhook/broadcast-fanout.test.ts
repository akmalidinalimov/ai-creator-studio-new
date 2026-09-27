// Tests for the teacher /tbroadcast delivery count. Run: deno test supabase/functions/telegram-bot-webhook/broadcast-fanout.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fanOutBroadcast, MAX_ERROR_KEYS } from "./broadcast-fanout.ts";
import { sendTelegram, type SendOutcome } from "../_shared/telegram-send.ts";

type Rcpt = { id: string; telegram_id: number };
const rcpts = (n: number): Rcpt[] => Array.from({ length: n }, (_, i) => ({ id: `u${i}`, telegram_id: 1000 + i }));

const outcome = (o: Partial<SendOutcome>): SendOutcome => ({
  ok: false, status: 400, error: null, terminal: false, recipient: false, content: false, ...o,
});
const ok = outcome({ ok: true, status: 200 });
const blocked = outcome({ status: 403, error: "Forbidden: bot was blocked by the user", terminal: true, recipient: true });
const notFound = outcome({ error: "Bad Request: chat not found", terminal: true, recipient: true });
const flood = outcome({ status: 429, error: "Too Many Requests: retry after 5" });

// Records every side effect the fan-out makes.
function sinks() {
  const delivered: string[] = [];
  const faults: { id: string; error: string | null }[] = [];
  return {
    delivered,
    faults,
    onDelivered: (r: Rcpt) => {
      delivered.push(r.id);
      return Promise.resolve();
    },
    onFault: (r: Rcpt, o: SendOutcome) => {
      faults.push({ id: r.id, error: o.error });
      return Promise.resolve();
    },
  };
}

Deno.test("fanOutBroadcast: every accepted send counts as sent; ledger written per delivery", async () => {
  const s = sinks();
  const t = await fanOutBroadcast(rcpts(3), () => Promise.resolve(ok), s.onDelivered, s.onFault);
  assertEquals(t, { sent: 3, failed: 0, total: 3, unreachable: 0, other_failed: 0, errors: {} });
  assertEquals(s.delivered, ["u0", "u1", "u2"]);
  assertEquals(s.faults, []);
});

Deno.test("fanOutBroadcast: {ok:false} does NOT count as sent (the #93 bug, bot path)", async () => {
  const outcomes = [ok, blocked, notFound, flood, ok];
  let i = 0;
  const s = sinks();
  const t = await fanOutBroadcast(rcpts(5), () => Promise.resolve(outcomes[i++]), s.onDelivered, s.onFault);
  assertEquals(t.sent, 2);
  assertEquals(t.failed, 3);
  assertEquals(t.total, 5);
  assertEquals(t.unreachable, 2); // blocked + never pressed Start: expected member reach, not a fault
  assertEquals(t.other_failed, 1); // flood control: a real fault
  assertEquals(t.errors, {
    "Forbidden: bot was blocked by the user": 1,
    "Bad Request: chat not found": 1,
    "Too Many Requests: retry after 5": 1,
  });
  assertEquals(s.delivered, ["u0", "u4"]); // ledger rows only for DMs Telegram accepted
  // Member-forgiveness: only the real fault is signalled; the two expected misses produce nothing.
  assertEquals(s.faults, [{ id: "u3", error: "Too Many Requests: retry after 5" }]);
});

Deno.test("fanOutBroadcast: a throwing sender / ledger / signal never aborts the fan-out", async () => {
  let i = 0;
  const faults: string[] = [];
  const t = await fanOutBroadcast(
    rcpts(3),
    () => (i++ === 1 ? Promise.reject(new Error("boom")) : Promise.resolve(ok)),
    () => Promise.reject(new Error("ledger down")),
    (r) => {
      faults.push(r.id);
      return Promise.reject(new Error("health insert down"));
    },
  );
  assertEquals(t.sent, 2); // the ledger failing does not un-deliver a DM
  assertEquals(t.failed, 1);
  assertEquals(t.other_failed, 1); // an exception is a real fault, never an "unreachable" member
  assertEquals(t.errors, { exception: 1 });
  assertEquals(faults, ["u1"]);
});

Deno.test("fanOutBroadcast: distinct error keys are capped, overflow lands in 'other'", async () => {
  let i = 0;
  const n = MAX_ERROR_KEYS + 5;
  const s = sinks();
  const t = await fanOutBroadcast(
    rcpts(n),
    () => Promise.resolve(outcome({ status: 429, error: `Too Many Requests: retry after ${i++}` })),
    s.onDelivered,
    s.onFault,
  );
  assertEquals(t.failed, n);
  assertEquals(Object.keys(t.errors).length, MAX_ERROR_KEYS + 1);
  assertEquals(t.errors.other, 5);
});

Deno.test("fanOutBroadcast + real sendTelegram: HTTP 403/400 {ok:false} is counted as not delivered", async () => {
  const realFetch = globalThis.fetch;
  const replies = [
    { status: 200, j: { ok: true, result: { message_id: 1 } } },
    { status: 403, j: { ok: false, description: "Forbidden: bot was blocked by the user" } },
    { status: 400, j: { ok: false, description: "Bad Request: chat not found" } },
    { status: 502, j: { ok: false, description: "Bad Gateway" } },
  ];
  let i = 0;
  globalThis.fetch = (() => {
    const b = replies[i++];
    return Promise.resolve(new Response(JSON.stringify(b.j), { status: b.status }));
  }) as unknown as typeof fetch;
  const s = sinks();
  try {
    const t = await fanOutBroadcast(
      rcpts(4),
      (r) => sendTelegram("TEST_TOKEN", "sendMessage", { chat_id: r.telegram_id, text: "x" }, { record: false }),
      s.onDelivered,
      s.onFault,
    );
    assertEquals(t.sent, 1);
    assertEquals(t.failed, 3);
    assertEquals(t.unreachable, 2);
    assertEquals(t.other_failed, 1);
    assertEquals(s.faults, [{ id: "u3", error: "Bad Gateway" }]);
    assertEquals(JSON.stringify([t, s.faults]).includes("TEST_TOKEN"), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
