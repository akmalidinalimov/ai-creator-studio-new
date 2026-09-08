// _warmup/tg.ts — the warm-up bot's Telegram surface.
//
// A WRAPPER, not a reimplementation. _shared/telegram-send.ts already classifies every outcome
// (accepted / recipient / content / transient) and is shared with the live LMS bot, so it is
// imported and never edited. This file adds only what is specific to the warm-up bot:
//
//   • its own token (WARMUP_BOT_TOKEN) — a second bot, never the LMS one;
//   • the kill switch, checked before anything leaves;
//   • setWebhook with allowed_updates, because message_reaction is NOT delivered by default and
//     its absence fails silently — reactions simply never arrive and nothing logs.
//
// record:false is passed to sendTelegram throughout: it would write a health row to
// public.admin_actions, and warm-up code must not write to the public schema. Outcomes are
// recorded on the warmup.outbox row instead, by the drainer.

import { sendTelegram, type SendOutcome } from "../_shared/telegram-send.ts";

export const WARMUP_BOT_TOKEN = Deno.env.get("WARMUP_BOT_TOKEN") || "";

/**
 * Every update type the engine needs. message_reaction is the one that matters: Telegram omits it
 * from the default allowed_updates, so a webhook registered without this list receives no
 * reactions at all — no error, no log, just an economy that never awards its cheapest action.
 * The bot must also be a channel admin for reactions to arrive.
 */
export const ALLOWED_UPDATES = [
  "message", "edited_message", "channel_post", "message_reaction",
  "callback_query", "chat_member", "my_chat_member",
] as const;

/**
 * Kill switch: public.platform_settings key 'warmup'.
 *
 * Absent row means ENABLED — only an explicit {"enabled": false} stops sends. This differs from
 * broadcast-core's killSwitchOn(), which treats a missing row as OFF; warm-up cannot seed its row
 * because writing to the public schema is forbidden here, so fail-closed-on-absent would mean the
 * bot could never send at all.
 *
 * A read ERROR is still treated as disabled. "I could not determine whether I am allowed to send"
 * must never resolve to "send".
 */
export async function warmupEnabled(admin: any): Promise<boolean> {
  try {
    const { data, error } = await admin
      .from("platform_settings").select("value").eq("key", "warmup").maybeSingle();
    if (error) {
      console.error("warmup: kill-switch unreadable, treating as DISABLED", error.message);
      return false;
    }
    if (!data) return true;                      // no row configured → enabled
    return (data.value as { enabled?: boolean })?.enabled !== false;
  } catch (e) {
    console.error("warmup: kill-switch threw, treating as DISABLED", String(e));
    return false;
  }
}

/** Send through the shared primitive with the warm-up bot's token. Never throws. */
export function send(method: string, payload: Record<string, unknown>): Promise<SendOutcome> {
  return sendTelegram(WARMUP_BOT_TOKEN, method, payload, { record: false });
}

/**
 * A reaction on a message. setMessageReaction has no dedicated helper in _shared, but it is still
 * a Telegram Bot API method, so it goes through the same classifier as everything else.
 */
export function react(chatId: number, messageId: number, emoji: string): Promise<SendOutcome> {
  return send("setMessageReaction", {
    chat_id: chatId, message_id: messageId,
    reaction: [{ type: "emoji", emoji }], is_big: false,
  });
}

/** Delete a message — SPEC §6.6 removes a command from the group after answering privately. */
export function deleteMessage(chatId: number, messageId: number): Promise<SendOutcome> {
  return send("deleteMessage", { chat_id: chatId, message_id: messageId });
}

/**
 * Point the warm-up bot's webhook at `url` with the full allowed_updates list.
 * `secretToken` becomes Telegram's X-Telegram-Bot-Api-Secret-Token header, which is what lets a
 * verify_jwt=false endpoint tell a real Telegram delivery from anyone who found the URL.
 */
export async function setWebhook(url: string, secretToken?: string): Promise<SendOutcome> {
  return await send("setWebhook", {
    url,
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: false,
    ...(secretToken ? { secret_token: secretToken } : {}),
  });
}

/** Current webhook registration — used to verify allowed_updates actually took. */
export async function getWebhookInfo(): Promise<unknown> {
  const resp = await fetch(`https://api.telegram.org/bot${WARMUP_BOT_TOKEN}/getWebhookInfo`);
  return await resp.json();
}
