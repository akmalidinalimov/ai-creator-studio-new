// warmup-webhook/normalise.ts — one Telegram update → zero or more warmup events (SPEC §6.1).
//
// Pure: no I/O, no clock, no database. Given the same update and pack it returns the same events,
// which is what makes the ingestion table replayable and this file testable without a bot.
//
// THE PACK IS OPTIONAL, and that is deliberate. Everything campaign-specific — the question tag,
// task hashtags, command names, event code words — lives in the pack, so with no pack loaded this
// falls back to the pack-independent subset (reactions, joins, plain messages, callbacks) rather
// than failing. Slice 0's acceptance test reacts to a channel post before any pack is activated;
// a normaliser that required one would make that test impossible and would drop real updates
// during any window where the pack is missing.

import type { CampaignPack, EventType } from "../_warmup/types.ts";

export interface NormalisedEvent {
  type: EventType;
  telegramId?: number;
  chatId?: number;
  messageId?: number;
  payload: Record<string, unknown>;
}

/** Lowercase, strip diacritics — SPEC §6.3 requires code words to match either way. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

const isGroup = (t?: string) => t === "group" || t === "supergroup";

function taskHashtags(pack: CampaignPack | null): { tag: string; day: number }[] {
  if (!pack) return [];
  return (pack.days || [])
    .filter((d) => typeof d.hashtag === "string" && d.hashtag)
    .map((d) => ({ tag: fold(d.hashtag as string), day: d.day }));
}

function questionTag(pack: CampaignPack | null): string | null {
  const tag = pack?.economy?.points?.question?.tag;
  return typeof tag === "string" && tag ? fold(tag) : null;
}

/** Match "/points", "/points@bot", or a bare alias — SPEC §6.6 accepts aliases without the slash. */
function matchCommand(pack: CampaignPack | null, text: string): { key: string } | null {
  const t = fold(text);
  const bare = t.split(/\s+/)[0].replace(/@[\w_]+$/, "");
  for (const c of pack?.commands || []) {
    if (fold(c.command) === bare) return { key: c.key };
    if ((c.aliases || []).some((a) => fold(a) === bare)) return { key: c.key };
  }
  return null;
}

/** A DM whose text is exactly a code word. Exact match, not substring: "the river is nice" is chat. */
function matchCodeWord(pack: CampaignPack | null, text: string): { eventId: string; word: string } | null {
  const t = fold(text);
  for (const ev of pack?.events || []) {
    for (const w of ev.code_words || []) {
      if (fold(w) === t) return { eventId: ev.id, word: fold(w) };
    }
  }
  return null;
}

function mediaKind(msg: Record<string, any>): string | null {
  if (Array.isArray(msg.photo) && msg.photo.length) return "photo";
  if (msg.video) return "video";
  if (msg.document) return "document";
  if (msg.voice) return "voice";
  if (msg.audio) return "audio";
  if (msg.video_note) return "video_note";
  return null;
}

export function normalise(update: Record<string, any>, pack: CampaignPack | null): NormalisedEvent[] {
  const out: NormalisedEvent[] = [];

  // ── message_reaction ───────────────────────────────────────────────────────
  // CLAUDE.md silent-failure trap 3: an anonymous channel reaction arrives with actor_chat and no
  // user. There is no one to award, and guessing would credit the wrong person — so it is dropped.
  if (update.message_reaction) {
    const r = update.message_reaction;
    if (!r.user?.id) return out;
    const emojis = (r.new_reaction || [])
      .map((x: any) => x?.emoji).filter((x: unknown): x is string => typeof x === "string");
    if (!emojis.length) return out;                     // reaction REMOVED — never award
    out.push({
      type: "reaction.added",
      telegramId: r.user.id,
      chatId: r.chat?.id,
      messageId: r.message_id,
      payload: { emojis, username: r.user.username ?? null, firstName: r.user.first_name ?? null },
    });
    return out;
  }

  // ── my_chat_member: the bot's own status changed ───────────────────────────
  if (update.my_chat_member) {
    const m = update.my_chat_member;
    const status = m.new_chat_member?.status;
    // In a private chat this is the Start press — the moment the participant becomes DM-reachable.
    if (m.chat?.type === "private" && (status === "member" || status === "creator")) {
      out.push({
        type: "participant.started_bot",
        telegramId: m.from?.id,
        chatId: m.chat?.id,
        payload: { username: m.from?.username ?? null, firstName: m.from?.first_name ?? null },
      });
    }
    return out;
  }

  // ── chat_member: someone else joined or left ───────────────────────────────
  if (update.chat_member) {
    const m = update.chat_member;
    const status = m.new_chat_member?.status;
    const user = m.new_chat_member?.user;
    if (!user?.id || user.is_bot) return out;
    if (status === "member" || status === "creator" || status === "administrator") {
      out.push({
        type: "participant.joined", telegramId: user.id, chatId: m.chat?.id,
        payload: { username: user.username ?? null, firstName: user.first_name ?? null, chatType: m.chat?.type },
      });
    } else if (status === "left" || status === "kicked") {
      out.push({ type: "participant.left", telegramId: user.id, chatId: m.chat?.id, payload: { status } });
    }
    return out;
  }

  // ── callback_query ─────────────────────────────────────────────────────────
  if (update.callback_query) {
    const cb = update.callback_query;
    const data = String(cb.data ?? "");
    const base = {
      telegramId: cb.from?.id,
      chatId: cb.message?.chat?.id,
      messageId: cb.message?.message_id,
      payload: { data, callbackQueryId: cb.id },
    };
    out.push(data.startsWith("commit:")
      ? { type: "event.committed", ...base, payload: { ...base.payload, eventId: data.slice("commit:".length) } }
      : { type: "command.received", ...base });
    return out;
  }

  // ── channel_post ───────────────────────────────────────────────────────────
  // Recorded so a later reaction can be tied back to the post it was on. No participant to credit.
  if (update.channel_post) {
    const m = update.channel_post;
    out.push({
      type: "message.posted", chatId: m.chat?.id, messageId: m.message_id,
      payload: { channelPost: true, text: m.text ?? m.caption ?? "" },
    });
    return out;
  }

  const msg = update.message ?? update.edited_message;
  if (!msg) return out;

  const from = msg.from;
  if (!from?.id || from.is_bot) return out;             // never award a bot, including ourselves
  const text: string = msg.text ?? msg.caption ?? "";
  const chatType: string = msg.chat?.type;
  const base = { telegramId: from.id, chatId: msg.chat?.id, messageId: msg.message_id };
  const who = { username: from.username ?? null, firstName: from.first_name ?? null };

  // ── DM ─────────────────────────────────────────────────────────────────────
  if (chatType === "private") {
    const cmd = matchCommand(pack, text);
    if (cmd) {
      out.push({ type: "command.received", ...base, payload: { ...who, command: cmd.key, text } });
      return out;
    }
    const code = matchCodeWord(pack, text);
    if (code) {
      out.push({
        type: "event.attended", ...base,
        payload: { ...who, eventId: code.eventId, codeWord: code.word },
      });
      return out;
    }
    out.push({ type: "message.posted", ...base, payload: { ...who, text, surface: "dm" } });
    return out;
  }

  if (!isGroup(chatType)) return out;

  // ── group message ──────────────────────────────────────────────────────────
  // A command in the group is still a command: §6.6 answers privately and deletes the message.
  const cmd = matchCommand(pack, text);
  if (cmd) {
    out.push({ type: "command.received", ...base, payload: { ...who, command: cmd.key, text, surface: "group" } });
    return out;
  }

  // Media first — a task submission is the most valuable thing a group message can be, and it
  // should not be reclassified as a reply just because it was posted in a thread.
  const kind = mediaKind(msg);
  if (kind) {
    const folded = fold(text);
    const hit = taskHashtags(pack).find((h) => folded.includes(h.tag));
    out.push({
      type: "media.submitted", ...base,
      payload: { ...who, mediaKind: kind, text, taskDay: hit?.day ?? null },
    });
    if (hit) {
      out.push({
        type: "task.completed", ...base,
        payload: { ...who, taskDay: hit.day, hashtag: hit.tag, mediaKind: kind },
      });
    }
    return out;
  }

  // A reply to another human. Replies to the bot are NOT peer encouragement, and neither is
  // replying to yourself — both would be trivially farmable for points.
  const parent = msg.reply_to_message;
  const parentFrom = parent?.from;
  const isThreadRoot = parent && parent.message_id === msg.message_thread_id;
  if (parentFrom?.id && !parentFrom.is_bot && parentFrom.id !== from.id && !isThreadRoot) {
    out.push({
      type: "reply.to_peer", ...base,
      payload: { ...who, text, peerTelegramId: parentFrom.id, replyToMessageId: parent.message_id },
    });
    return out;
  }

  if (!text.trim()) return out;                         // a sticker or a poll vote is not a comment

  const qTag = questionTag(pack);
  const folded = fold(text);
  if ((qTag && folded.startsWith(qTag)) || text.trim().endsWith("?")) {
    out.push({ type: "message.is_question", ...base, payload: { ...who, text } });
    return out;
  }

  out.push({ type: "message.posted", ...base, payload: { ...who, text, surface: "group" } });
  return out;
}
