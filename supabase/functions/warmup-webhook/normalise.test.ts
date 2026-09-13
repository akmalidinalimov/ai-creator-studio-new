// SPEC §6.1's normalisation table, row by row, plus the silent-failure traps from CLAUDE.md and
// the anti-farming rules from §6.2. Pure — no database, no network, no permissions.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { normalise } from "./normalise.ts";
import { testPack } from "../_warmup/testing/pack-fixture.ts";
import type { CampaignPack } from "../_warmup/types.ts";

const pack = testPack();
const GROUP = -1002, CHANNEL = -1001, BOT = 999, ME = 111, PEER = 222;

const types = (u: Record<string, unknown>, p: CampaignPack | null = pack) =>
  normalise(u, p).map((e) => e.type);

const groupMsg = (extra: Record<string, unknown>) => ({
  update_id: 1,
  message: {
    message_id: 10, date: 1, chat: { id: GROUP, type: "supergroup" },
    from: { id: ME, is_bot: false, first_name: "A" }, ...extra,
  },
});
const dm = (extra: Record<string, unknown>) => ({
  update_id: 2,
  message: {
    message_id: 11, date: 1, chat: { id: ME, type: "private" },
    from: { id: ME, is_bot: false, first_name: "A" }, ...extra,
  },
});
const reaction = (extra: Record<string, unknown>) => ({
  update_id: 3,
  message_reaction: { chat: { id: CHANNEL }, message_id: 9, date: 1, old_reaction: [], ...extra },
});

// ─── SPEC §6.1, row by row ───────────────────────────────────────────────────

Deno.test("§6.1 group media + task hashtag → media.submitted AND task.completed", () => {
  assertEquals(
    types(groupMsg({ photo: [{ file_id: "f" }], caption: "here it is #task1" })),
    ["media.submitted", "task.completed"],
  );
});

Deno.test("§6.1 group media without a task hashtag → media.submitted only", () => {
  assertEquals(types(groupMsg({ photo: [{ file_id: "f" }], caption: "just a pic" })), ["media.submitted"]);
});

Deno.test("§6.1 group reply to a participant → reply.to_peer", () => {
  assertEquals(
    types(groupMsg({ text: "nice work", reply_to_message: { message_id: 5, from: { id: PEER, is_bot: false } } })),
    ["reply.to_peer"],
  );
});

Deno.test("§6.1 question tag or trailing '?' → message.is_question", () => {
  assertEquals(types(groupMsg({ text: "#question how do points work" })), ["message.is_question"]);
  assertEquals(types(groupMsg({ text: "how do points work?" })), ["message.is_question"]);
});

Deno.test("§6.1 other group text → message.posted", () => {
  assertEquals(types(groupMsg({ text: "just chatting here" })), ["message.posted"]);
});

Deno.test("§6.1 DM matching a code word → event.attended", () => {
  assertEquals(types(dm({ text: "apple" })), ["event.attended"]);
});

Deno.test("§6.1 DM command, slashed or bare alias → command.received", () => {
  assertEquals(types(dm({ text: "/points" })), ["command.received"]);
  assertEquals(types(dm({ text: "/points@warmupbot" })), ["command.received"]);
  assertEquals(types(dm({ text: "score" })), ["command.received"]);   // §6.6: no slash required
});

Deno.test("§6.1 message_reaction → reaction.added", () => {
  assertEquals(types(reaction({ user: { id: ME }, new_reaction: [{ type: "emoji", emoji: "🔥" }] })),
    ["reaction.added"]);
});

Deno.test("§6.1 my_chat_member → member in a private chat → participant.started_bot", () => {
  assertEquals(
    types({ update_id: 4, my_chat_member: {
      chat: { id: ME, type: "private" }, from: { id: ME }, new_chat_member: { status: "member" } } }),
    ["participant.started_bot"],
  );
});

Deno.test("§6.1 callback_query → event.committed or command.received", () => {
  const cb = (data: string) => ({ update_id: 5, callback_query: {
    id: "c", from: { id: ME }, data, message: { message_id: 1, chat: { id: GROUP } } } });
  assertEquals(types(cb("commit:live_d1")), ["event.committed"]);
  assertEquals(types(cb("menu:open")), ["command.received"]);
});

// ─── CLAUDE.md silent-failure traps ──────────────────────────────────────────

// Trap 3. An anonymous channel reaction has actor_chat and no user. There is nobody to award, and
// guessing would credit the wrong person.
Deno.test("TRAP: an anonymous channel reaction is dropped, never attributed", () => {
  assertEquals(
    types(reaction({ actor_chat: { id: CHANNEL, type: "channel" }, new_reaction: [{ type: "emoji", emoji: "🔥" }] })),
    [],
  );
});

Deno.test("removing a reaction awards nothing", () => {
  assertEquals(types({ update_id: 3, message_reaction: {
    chat: { id: CHANNEL }, message_id: 9, user: { id: ME },
    old_reaction: [{ type: "emoji", emoji: "🔥" }], new_reaction: [] } }), []);
});

// ─── anti-farming (§6.2) ─────────────────────────────────────────────────────

Deno.test("a reply to the BOT is not peer encouragement", () => {
  assertEquals(
    types(groupMsg({ text: "thanks", reply_to_message: { message_id: 5, from: { id: BOT, is_bot: true } } })),
    ["message.posted"],
  );
});

Deno.test("a reply to YOURSELF is not peer encouragement", () => {
  assertEquals(
    types(groupMsg({ text: "adding", reply_to_message: { message_id: 5, from: { id: ME, is_bot: false } } })),
    ["message.posted"],
  );
});

// Telegram models every post in a forum topic as a reply to the topic's root message. Without this
// guard, ordinary posting in a discussion topic would silently pay peer-encouragement points.
Deno.test("a forum topic's root message is not a peer reply", () => {
  assertEquals(
    types({ update_id: 6, message: {
      message_id: 10, message_thread_id: 5, chat: { id: GROUP, type: "supergroup" },
      from: { id: ME, is_bot: false }, text: "posting in the topic",
      reply_to_message: { message_id: 5, from: { id: PEER, is_bot: false } } } }),
    ["message.posted"],
  );
});

Deno.test("a bot's own message produces nothing", () => {
  assertEquals(normalise({ update_id: 7, message: {
    message_id: 1, chat: { id: GROUP, type: "supergroup" },
    from: { id: BOT, is_bot: true }, text: "hi" } }, pack), []);
});

Deno.test("a sticker-only group message is not a comment", () => {
  assertEquals(types(groupMsg({ sticker: { file_id: "s" } })), []);
});

// ─── code words (§6.3) ───────────────────────────────────────────────────────

Deno.test("code words match case- and diacritic-insensitively", () => {
  for (const variant of ["apple", "APPLE", " Apple ", "ápple"]) {
    assertEquals(types(dm({ text: variant })), ["event.attended"], variant);
  }
});

// "Pick ordinary, easy-to-spell words … never anything that appears in normal conversation" —
// exact matching is what keeps an ordinary sentence from paying out attendance points.
Deno.test("a code word inside a sentence does NOT count", () => {
  assertEquals(types(dm({ text: "the apple is red" })), ["message.posted"]);
});

// ─── no pack loaded ──────────────────────────────────────────────────────────

// Slice 0's acceptance test reacts to a channel post before any pack is activated, and updates must
// not be lost during any window where the pack is missing.
Deno.test("pack-independent classification still works with no pack", () => {
  assertEquals(types(reaction({ user: { id: ME }, new_reaction: [{ type: "emoji", emoji: "🔥" }] }), null),
    ["reaction.added"]);
  assertEquals(types(groupMsg({ text: "hello there" }), null), ["message.posted"]);
  assertEquals(types(groupMsg({ text: "is this on?" }), null), ["message.is_question"]);
  // The task hashtag needs the pack, so only the pack-independent half is emitted.
  assertEquals(types(groupMsg({ photo: [{ file_id: "f" }], caption: "x #task1" }), null), ["media.submitted"]);
});
