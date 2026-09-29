// Tests for the homework-capture drop signals. Run: deno test supabase/functions/telegram-bot-webhook/capture-signals.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isRegisteredHomeworkTopic, pendingAppendDrop, recordAutoRegisterFailed, recordCaptureFailed, recordCaptureSkipped,
  recordPendingAppendDrop,
} from "./capture-signals.ts";

// Service-role client stub: an in-memory admin_actions table honouring logHealthOnce's filter chain, plus
// canned groups / group_module_topics reads that record the filters they were given.
function fakeAdmin(opts: { groups?: any[]; gmt?: any[]; throwOn?: string } = {}) {
  const rows: any[] = [];
  const seen: { orFilter?: string; gmtGroupIds?: string[]; gmtTopic?: number } = {};
  const admin = {
    from: (table: string) => {
      if (opts.throwOn === table) throw new Error("db down");
      if (table === "groups") {
        return { select: (_c: string) => ({ or: (f: string) => { seen.orFilter = f; return Promise.resolve({ data: opts.groups ?? [], error: null }); } }) };
      }
      if (table === "group_module_topics") {
        const q: any = {
          in: (_c: string, ids: string[]) => { seen.gmtGroupIds = ids; return q; },
          eq: (_c: string, v: number) => { seen.gmtTopic = v; return q; },
          limit: (_n: number) => Promise.resolve({
            data: (opts.gmt ?? []).filter((r) => seen.gmtGroupIds!.includes(r.group_id) && r.telegram_topic_id === seen.gmtTopic),
            error: null,
          }),
        };
        return { select: (_c: string) => q };
      }
      // admin_actions
      return {
        insert: (row: any) => { rows.push({ ...row, created_at: new Date().toISOString() }); return Promise.resolve({ error: null }); },
        select: (_c: string) => {
          const f: any = {};
          const q: any = {
            eq: (col: string, v: string) => { f[col] = v; return q; },
            gte: (_c: string, v: string) => { f.since = v; return q; },
            limit: (_n: number) => Promise.resolve({
              data: rows.filter((r) => r.action === f.action && r.details?.dedupe_key === f["details->>dedupe_key"] && r.created_at >= f.since),
              error: null,
            }),
          };
          return q;
        },
      };
    },
  };
  return { admin, rows, seen };
}

// Chat ids are unique per test: the isolate-local dedupe memo in logHealthOnce is shared module state.
let nextChat = -1004000000000;
const chat = () => --nextChat;

Deno.test("recordCapture*: one row, stable action/key/details, sender as target", async () => {
  const { admin, rows } = fakeAdmin();
  const chatId = chat();
  await recordCaptureFailed(admin, "submission_upsert_failed", {
    chatId, threadId: 7, messageId: 55, fromId: 111, userId: "u-1", assignment_id: "a-1",
  });
  assertEquals(rows.length, 1);
  assertEquals(rows[0].action, "hw_capture_failed");
  assertEquals(rows[0].target_user_id, "u-1");
  assertEquals(rows[0].details, {
    reason: "submission_upsert_failed", chat_id: chatId, thread_id: 7, message_id: 55, telegram_id: 111,
    assignment_id: "a-1", dedupe_key: `submission_upsert_failed:${chatId}:111`, source: "telegram-bot-webhook",
  });
});

Deno.test("recordCapture*: a 10-photo album from one sender is ONE row for the day", async () => {
  const { admin, rows } = fakeAdmin();
  const chatId = chat();
  await Promise.all(Array.from({ length: 10 }, (_, i) =>
    recordCaptureSkipped(admin, "album_item_after_finalize", { chatId, threadId: 7, messageId: 100 + i, fromId: 222 })));
  assertEquals(rows.length, 1);
  assertEquals(rows[0].action, "hw_capture_skipped");
});

Deno.test("recordCapture*: different senders / reasons in one chat are separate rows", async () => {
  const { admin, rows } = fakeAdmin();
  const chatId = chat();
  await recordCaptureSkipped(admin, "chat_admin", { chatId, fromId: 1 });
  await recordCaptureSkipped(admin, "chat_admin", { chatId, fromId: 2 });
  await recordCaptureSkipped(admin, "tier_locked", { chatId, fromId: 1 });
  assertEquals(rows.length, 3);
});

Deno.test("recordCapture*: no Telegram id → keyed by profile id, telegram_id null", async () => {
  const { admin, rows } = fakeAdmin();
  const chatId = chat();
  await recordCaptureFailed(admin, "pending_insert_failed", { chatId, fromId: null, userId: "u-9" });
  assertEquals(rows[0].details.dedupe_key, `pending_insert_failed:${chatId}:u-9`);
  assertEquals(rows[0].details.telegram_id, null);
});

Deno.test("recordAutoRegisterFailed: details.source is the PATH (mirrors auto_registered_provisional)", async () => {
  const { admin, rows } = fakeAdmin();
  const from = { id: 900000000 + Math.floor(Math.random() * 1e6), username: "someone" };
  await recordAutoRegisterFailed(admin, "profile_not_linked", from, { id: "g-1" }, "homework_topic_post", { engine_status: "already_in_group" });
  await recordAutoRegisterFailed(admin, "profile_not_linked", from, { id: "g-1" }, "homework_topic_post", { engine_status: "already_in_group" });
  await recordAutoRegisterFailed(admin, "profile_not_linked", from, { id: "g-1" }, "dm_start_member");
  assertEquals(rows.length, 2); // same user+reason on two paths = two rows; the repeat is deduped
  assertEquals(rows[0].action, "auto_register_failed");
  assertEquals(rows[0].details, {
    reason: "profile_not_linked", telegram_id: from.id, telegram_username: "someone", group_id: "g-1",
    engine_status: "already_in_group", dedupe_key: `profile_not_linked:homework_topic_post:${from.id}`,
    source: "homework_topic_post",
  });
  assertEquals(rows[1].details.source, "dm_start_member");
});

Deno.test("isRegisteredHomeworkTopic: the shared homework topic of a group in this chat", async () => {
  const { admin, seen } = fakeAdmin({ groups: [{ id: "g-1", homework_topic_id: 7 }] });
  assertEquals(await isRegisteredHomeworkTopic(admin, -1004310467008, 7), true);
  // -100 prefix stripped: t.me/c/<internal id>/<thread> is how the group URLs are stored.
  assertEquals(seen.orFilter, "homework_topic_url.ilike.%/c/4310467008/%,telegram_group_url.ilike.%/c/4310467008/%");
});

Deno.test("isRegisteredHomeworkTopic: a per-module topic (group_module_topics) counts", async () => {
  const { admin } = fakeAdmin({
    groups: [{ id: "g-1", homework_topic_id: 7 }],
    gmt: [{ group_id: "g-1", telegram_topic_id: 42 }],
  });
  assertEquals(await isRegisteredHomeworkTopic(admin, -1004310467008, 42), true);
});

Deno.test("isRegisteredHomeworkTopic: general chat topic / unregistered chat / db error → false (stay silent)", async () => {
  assertEquals(await isRegisteredHomeworkTopic(fakeAdmin({ groups: [{ id: "g-1", homework_topic_id: 7 }] }).admin, -1004310467008, 3), false);
  assertEquals(await isRegisteredHomeworkTopic(fakeAdmin({ groups: [] }).admin, -1009999, 7), false);
  assertEquals(await isRegisteredHomeworkTopic(fakeAdmin({ throwOn: "groups" }).admin, -1004310467008, 7), false);
});

Deno.test("pendingAppendDrop: maps every append_pending_media outcome", () => {
  assertEquals(pendingAppendDrop(0), null);
  assertEquals(pendingAppendDrop(3), null);
  assertEquals(pendingAppendDrop(-1), { kind: "skipped", reason: "media_cap_reached" });
  assertEquals(pendingAppendDrop(-2), { kind: "skipped", reason: "album_item_after_finalize" });
  // supabase-js yields data=null when the RPC errors; anything else unexpected is a failure too.
  assertEquals(pendingAppendDrop(null), { kind: "failed", reason: "pending_append_failed" });
  assertEquals(pendingAppendDrop(undefined), { kind: "failed", reason: "pending_append_failed" });
  assertEquals(pendingAppendDrop(-3), { kind: "failed", reason: "pending_append_failed" });
});

Deno.test("recordPendingAppendDrop: a successful append writes nothing; each drop writes its own action", async () => {
  const { admin, rows } = fakeAdmin();
  const chatId = chat();
  const d = { chatId, threadId: 7, messageId: 9, fromId: 333, userId: "u-3", pending_id: "p-1" };
  await recordPendingAppendDrop(admin, 4, d);
  assertEquals(rows.length, 0);
  await recordPendingAppendDrop(admin, -1, d);
  await recordPendingAppendDrop(admin, null, d);
  assertEquals(rows.map((r) => [r.action, r.details.reason]), [
    ["hw_capture_skipped", "media_cap_reached"],
    ["hw_capture_failed", "pending_append_failed"],
  ]);
  assertEquals(rows[0].details.pending_id, "p-1");
  assertEquals(rows[0].target_user_id, "u-3");
});
