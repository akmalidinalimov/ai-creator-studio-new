// Tests for the multipart senders with the finer classes (Daily Tasks PR-7): sendMediaGroupMultipart and
// sendTelegramMultipartWithResult. Run: deno test supabase/functions/_shared/telegram-media-group.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mediaGroupProblem, sendMediaGroupMultipart, sendTelegramMultipartWithResult, type MediaGroupItem } from "./telegram-send.ts";

const TOKEN = "SECRET_TOKEN_media_group_789";
const realFetch = globalThis.fetch;

function fakeAdmin() {
  const rows: any[] = [];
  const chain: any = {
    select: () => chain, eq: () => chain, gte: () => chain,
    limit: () => Promise.resolve({ data: [], error: null }),
    insert: (row: any) => { rows.push(row); return Promise.resolve({ error: null }); },
  };
  return { admin: { from: (_t: string) => chain }, rows };
}

type Seen = { url: string; form: FormData };
function stubFetch(body: unknown, status: number) {
  const calls: Seen[] = [];
  globalThis.fetch = ((url: string, init: RequestInit) => {
    calls.push({ url, form: init.body as FormData });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as unknown as typeof fetch;
  return calls;
}

const item = (type: MediaGroupItem["type"], caption?: string): MediaGroupItem =>
  ({ type, blob: new Blob([type]), filename: `${type}.bin`, ...(caption ? { caption } : {}) });

Deno.test("mediaGroupProblem: 2..10 items, photo+video together or documents only", () => {
  assertEquals(mediaGroupProblem([item("photo"), item("video")]), null);
  assertEquals(mediaGroupProblem([item("document"), item("document")]), null);
  assertEquals(mediaGroupProblem([item("photo")]), "media_group_size");
  assertEquals(mediaGroupProblem(Array.from({ length: 11 }, () => item("photo"))), "media_group_size");
  assertEquals(mediaGroupProblem([item("photo"), item("document")]), "media_group_mixed_types");
});

Deno.test("sendMediaGroupMultipart: one multipart request, attach://fileN, caption on the first item, the Messages back", async () => {
  const calls = stubFetch({ ok: true, result: [{ message_id: 11 }, { message_id: 12 }] }, 200);
  const { admin, rows } = fakeAdmin();
  try {
    const r = await sendMediaGroupMultipart(TOKEN, { chat_id: -100123, message_thread_id: 144 }, [item("photo", "📱 Ali"), item("video")], { admin });
    assertEquals(r.outcome.ok, true);
    assertEquals(r.result?.map((m) => m.message_id), [11, 12]);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url.endsWith("/sendMediaGroup"), true);
    const f = calls[0].form;
    assertEquals(f.get("chat_id"), "-100123");
    assertEquals(f.get("message_thread_id"), "144");
    assertEquals(JSON.parse(String(f.get("media"))), [
      { type: "photo", media: "attach://file0", caption: "📱 Ali" },
      { type: "video", media: "attach://file1", supports_streaming: true },
    ]);
    assertEquals(f.get("file0") instanceof Blob, true);
    assertEquals(f.get("file1") instanceof Blob, true);
    assertEquals(f.has("parse_mode"), false); // plain caption: student-supplied text is never markup
    assertEquals(rows.length, 0);
    assertEquals(JSON.stringify(r).includes(TOKEN), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("sendMediaGroupMultipart: a malformed album never reaches Telegram and is recorded as a content failure", async () => {
  const calls = stubFetch({ ok: true, result: [] }, 200);
  const { admin, rows } = fakeAdmin();
  try {
    const r = await sendMediaGroupMultipart(TOKEN, { chat_id: -100 }, [item("photo"), item("document")], { admin });
    assertEquals(r.outcome.ok, false);
    assertEquals(r.outcome.klass, "content");
    assertEquals(r.result, null);
    assertEquals(calls.length, 0);
    assertEquals(rows.map((x) => x.action), ["telegram_send_failed"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("sendMediaGroupMultipart: 429 is flow control — one telegram_rate_limited row with retry_after, never telegram_send_failed", async () => {
  stubFetch({ ok: false, description: "Too Many Requests: retry after 17", parameters: { retry_after: 17 } }, 429);
  const { admin, rows } = fakeAdmin();
  try {
    const r = await sendMediaGroupMultipart(TOKEN, { chat_id: -100, message_thread_id: 5 }, [item("photo"), item("photo")], { admin });
    assertEquals(r.outcome.klass, "rate_limited");
    assertEquals(r.outcome.retryAfterSec, 17);
    assertEquals(r.outcome.terminal, false);
    assertEquals(rows.map((x) => x.action), ["telegram_rate_limited"]);
    assertEquals(rows[0].details.retry_after, 17);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("sendTelegramMultipartWithResult: a closed topic goes to the caller's topicMissingAction with chat + thread", async () => {
  stubFetch({ ok: false, description: "Bad Request: TOPIC_CLOSED" }, 400);
  const { admin, rows } = fakeAdmin();
  try {
    const r = await sendTelegramMultipartWithResult(TOKEN, "sendPhoto", { chat_id: -100, message_thread_id: 144, caption: "x" },
      [{ field: "photo", blob: new Blob(["p"]), filename: "a.jpg" }], { admin, topicMissingAction: "challenge_task_topic_missing" });
    assertEquals(r.outcome.klass, "topic_missing");
    assertEquals(r.outcome.terminal, true);
    assertEquals(rows.map((x) => x.action), ["challenge_task_topic_missing"]);
    assertEquals(rows[0].details.chat_id, -100);
    assertEquals(rows[0].details.thread_id, 144);
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("sendTelegramMultipartWithResult: success returns the Message; the file travels as a multipart field", async () => {
  const calls = stubFetch({ ok: true, result: { message_id: 77, photo: [{ file_unique_id: "u" }] } }, 200);
  const { admin, rows } = fakeAdmin();
  try {
    const r = await sendTelegramMultipartWithResult(TOKEN, "sendDocument", { chat_id: -100 },
      [{ field: "document", blob: new Blob(["d"]), filename: "s.heic" }], { admin });
    assertEquals(r.outcome.ok, true);
    assertEquals(r.result.message_id, 77);
    assertEquals(calls[0].url.endsWith("/sendDocument"), true);
    assertEquals((calls[0].form.get("document") as File).name, "s.heic");
    assertEquals(rows.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
