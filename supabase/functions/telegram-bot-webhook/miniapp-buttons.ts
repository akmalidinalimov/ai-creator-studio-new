// The bot's student watch buttons (📚 Davom etish, /dars, the first-login welcome) — a thin, bot-specific wrapper
// around _shared/miniapp-button.ts, kept OUT of index.ts so that file only changes at its call sites.
//
//   studentWatchButton(...)      → a Mini App web_app button (flag on) or today's magic link (flag off), plus
//                                  a legacy() that rebuilds the magic link
//   sendStudentWatchMessage(...) → sends it like the bot's sendMessage (HTML, no preview) through sendTelegram
//                                  (a non-delivery is DB-visible) and, if Telegram rejects a web_app button,
//                                  resends ONCE with the magic links (alarmed as miniapp_button_rejected).
//
// PRIVATE CHATS ONLY: a magic link logs whoever taps it into this student's account, so it must never reach a
// group. Every caller is a private-chat handler (group updates return early in index.ts); the helper also
// checks the chat id (private chat ids are positive) and refuses anything else without a magic link.
import {
  type InlineButton,
  legacyWatchButton,
  loadStudentMiniAppFlag,
  type PrivateWatchOpts,
  sendWithWatchFallback,
  watchButton,
  type WatchMode,
} from "../_shared/miniapp-button.ts";
import { type MiniAppSrc } from "../_shared/miniapp-links.ts";
import { sendTelegram, type SendOutcome } from "../_shared/telegram-send.ts";
import { logHealthOnce } from "../_shared/edge.ts";

export { continuePath, coursePath, lessonPath } from "../_shared/miniapp-links.ts";

const BOT_TOKEN = (() => {
  try {
    return Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  } catch {
    return "";
  }
})();

export type BotWatch = {
  button: InlineButton;
  mode: WatchMode;
  /** Today's magic-link button, for the rejection fallback. */
  legacy: () => Promise<InlineButton | null>;
};

/**
 * The watch button for a private-chat bot reply. `webhookOn` is the webhook's own student_miniapp state
 * (__studentMiniAppEnabled?.on === true) — the same row the shared reader re-reads for the watch_buttons
 * sub-key; either off → today's magic link. Throws only when even the magic link cannot be made, which is
 * exactly when the old createMagicLink() threw.
 */
export async function studentWatchButton(admin: any, opts: {
  chatId: number;
  text: string;
  miniPath: string;
  legacyPath: string;
  src: MiniAppSrc;
  webhookOn: boolean;
  magicLink: (legacyPath: string) => Promise<string>;
}): Promise<BotWatch> {
  if (!(Number(opts.chatId) > 0)) {
    // Not a private chat: never a magic link. (Unreachable today — see the header.)
    await logHealthOnce(admin, "miniapp_button_fallback", `not_private:${opts.src}`, { fn: "telegram-bot-webhook", src: opts.src });
    throw new Error("studentWatchButton: private chats only");
  }
  const shared = await loadStudentMiniAppFlag(admin);
  const flag = opts.webhookOn ? shared : { on: false, watch: false };
  const w: PrivateWatchOpts = {
    chat: "private", text: opts.text, flag, fn: "telegram-bot-webhook", admin,
    miniPath: opts.miniPath, legacyPath: opts.legacyPath, track: { src: opts.src },
    magicLink: opts.magicLink,
  };
  const r = await watchButton(w);
  if (!r.button) throw new Error(`studentWatchButton: no button (${r.reason})`);
  return { button: r.button, mode: r.mode, legacy: async () => (await legacyWatchButton(w, "ok")).button };
}

type Cell = BotWatch | Record<string, unknown>;
const isWatch = (c: Cell): c is BotWatch => typeof (c as BotWatch).legacy === "function";

/** Send `text` with rows of watch buttons (and plain buttons, e.g. the support link) — the bot's sendMessage shape. */
export async function sendStudentWatchMessage(admin: any, chatId: number, text: string, rows: Cell[][]): Promise<SendOutcome> {
  const body = (kb: Record<string, unknown>[][]) => ({
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(kb.length ? { reply_markup: { inline_keyboard: kb } } : {}),
  });
  const first = rows.map((row) => row.map((c) => (isWatch(c) ? c.button as Record<string, unknown> : c)));
  const { result } = await sendWithWatchFallback(
    (p) => sendTelegram(BOT_TOKEN, "sendMessage", p, { admin, purpose: "bot_watch_button", recipientId: chatId }),
    body(first),
    async () => {
      const kb: Record<string, unknown>[][] = [];
      for (const row of rows) {
        const out: Record<string, unknown>[] = [];
        for (const c of row) {
          if (!isWatch(c)) { out.push(c); continue; }
          const lg = await c.legacy();
          if (!lg) return null;
          out.push(lg as Record<string, unknown>);
        }
        kb.push(out);
      }
      return body(kb);
    },
    { fn: "telegram-bot-webhook", admin },
  );
  return result;
}
