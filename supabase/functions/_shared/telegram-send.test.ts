// Tests for the shared Telegram sender. Run: deno test supabase/functions/_shared/telegram-send.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sendTelegram } from "./telegram-send.ts";

const realFetch = globalThis.fetch;

// A service-role-client stub that records admin_actions inserts.
function fakeAdmin() {
  const rows: any[] = [];
  const admin = {
    from: (_t: string) => ({
      insert: (row: any) => {
        rows.push(row);
        return Promise.resolve({ error: null });
      },
    }),
  };
  return { admin, rows };
}

function stubFetch(fn: () => Promise<Response>) {
  globalThis.fetch = (() => fn()) as unknown as typeof fetch;
}

Deno.test("sendTelegram: accepted → ok, no health row", async () => {
  stubFetch(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })));
  const { admin, rows } = fakeAdmin();
  try {
    const out = await sendTelegram("TOK", "sendMessage", { chat_id: 1, text: "x" }, { admin, purpose: "grade" });
    assertEquals(out.ok, true);
    assertEquals(out.terminal, false);
    assertEquals(rows.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("sendTelegram: blocked recipient → terminal+recorded, token never leaked", async () => {
  stubFetch(() =>
    Promise.resolve(new Response(JSON.stringify({ ok: false, description: "Forbidden: bot was blocked by the user" }), { status: 403 }))
  );
  const { admin, rows } = fakeAdmin();
  try {
    const out = await sendTelegram("SECRET_TOKEN", "sendMessage", { chat_id: 2, text: "y" }, { admin, purpose: "grade", recipient: 2 });
    assertEquals(out.ok, false);
    assertEquals(out.terminal, true);
    assertEquals(out.recipient, true);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].action, "telegram_send_failed");
    assertEquals(JSON.stringify(rows[0]).includes("SECRET_TOKEN"), false); // bot token must never be recorded
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("sendTelegram: transport error → transient, recorded, never throws", async () => {
  stubFetch(() => Promise.reject(new Error("network down")));
  const { admin, rows } = fakeAdmin();
  try {
    const out = await sendTelegram("TOK", "sendMessage", { chat_id: 3 }, { admin });
    assertEquals(out.ok, false);
    assertEquals(out.terminal, false); // transport_error is neither a recipient nor a content error
    assertEquals(rows.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("sendTelegram: record:false → classify only, no health row", async () => {
  stubFetch(() => Promise.resolve(new Response(JSON.stringify({ ok: false, description: "bot was blocked" }), { status: 403 })));
  const { admin, rows } = fakeAdmin();
  try {
    const out = await sendTelegram("TOK", "sendMessage", { chat_id: 4 }, { admin, record: false });
    assertEquals(out.ok, false);
    assertEquals(rows.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
