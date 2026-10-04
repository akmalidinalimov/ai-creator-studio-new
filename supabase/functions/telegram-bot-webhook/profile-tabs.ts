// 👤 Profil — ONE card whose tabs edit the same message (UX review 2026-09-30, quick win #9).
//
// BEFORE: every 📊 Statistika / 🏆 Yutuqlarim / 👥 Guruh reytingi tap posted a NEW message (971 Profil taps,
// 421 group-rating taps in 30 days — one student made 222), and "Profilni ochish" was a one-time website login
// link that opened a browser.
//
// NOW:
//   card       [📊 Statistika] [🏆 Yutuqlarim] / [👥 Guruh reytingi] [⚙️ Sozlamalar]
//              [🏆 To'liq reyting ↗] [👤 Profilni ochish ↗] / [✏️ Ismni o'zgartirish] [🌐 Til]
//   a tab      its content, then [👤 Profil] + the other two tabs / [🏆 To'liq reyting ↗] [👤 Profilni ochish ↗]
//   A tab tap (prof:stats|badges|group) and "back" (prof:home) EDIT the tapped message in place. prof:card —
//   the entry from other messages (the July broadcast's "👤 Profilim") — still posts a new card, as before.
//   ↗ = a Mini App web_app button to /leaderboard or /profile (the Reyting tab uses the same group_leaderboard
//   RPC as 👥 Guruh reytingi), built by the shared helper: with the student Mini App off they are today's
//   magic links, byte for byte. The language button moves in here too (the keyboard's 🌐 Til stays).
//
// Edit failures: "message is not modified" (a repeat tap on the tab that is already shown) is success — no
// alarm, no new message. A web_app button Telegram refuses is re-sent once with the magic links (the shared
// fallback, alarmed as miniapp_button_rejected). Any other edit failure (the message was deleted, or can no
// longer be edited) falls back to today's behaviour: a new message.
import { type BotWatch, sendStudentWatchMessage, studentWatchButton } from "./miniapp-buttons.ts";
import { type InlineButton, sendWithWatchFallback } from "../_shared/miniapp-button.ts";
import { sendTelegram, type SendOutcome } from "../_shared/telegram-send.ts";

export type Locale = "uz" | "ru" | "en";
export type ProfView = "card" | "stats" | "badges" | "group";

const BOT_TOKEN = (() => {
  try {
    return Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
  } catch {
    return "";
  }
})();

/** prof:<action> → the view and whether to edit the tapped message. null for actions handled elsewhere. */
export function parseProfAction(action: string): { view: ProfView; edit: boolean } | null {
  switch (action) {
    case "card":
      return { view: "card", edit: false };
    case "home":
      return { view: "card", edit: true };
    case "stats":
    case "badges":
    case "group":
      return { view: action, edit: true };
    default:
      return null;
  }
}

/** The labels (index.ts passes PROF_T / T strings, so the card keeps today's wording). */
export type ProfLabels = {
  card: string; // 👤 Profil
  stats: string; // 📊 Statistika
  badges: string; // 🏆 Yutuqlarim
  group: string; // 👥 Guruh reytingi
  settings: string; // ⚙️ Sozlamalar
  editName: string; // ✏️ Ismni o'zgartirish
  lang: string; // 🌐 Til
  instagram?: string; // 📸 Instagram (ig-handle.ts: ig:set) — the card only
};

/** New strings of this module. */
export const PROF_TAB_T: Record<Locale, { fullRating: string }> = {
  uz: { fullRating: "🏆 To'liq reyting" },
  ru: { fullRating: "🏆 Весь рейтинг" },
  en: { fullRating: "🏆 Full rating" },
};

type Cb = { text: string; callback_data: string };
export type Cell = BotWatch | Cb | InlineButton;

/** The keyboard of a view. `web` = [To'liq reyting, Profilni ochish] (web_app or magic link). Pure. */
export function profileRows(view: ProfView, l: ProfLabels, web: [Cell, Cell]): Cell[][] {
  const tab = (v: Exclude<ProfView, "card">): Cb => ({ text: l[v], callback_data: `prof:${v}` });
  const home: Cb = { text: l.card, callback_data: "prof:home" };
  if (view === "card") {
    return [
      [tab("stats"), tab("badges")],
      [tab("group"), { text: l.settings, callback_data: "prof:settings" }],
      [web[0], web[1]],
      [{ text: l.editName, callback_data: "name:edit" }, { text: l.lang, callback_data: "prof:lang" }],
      ...(l.instagram ? [[{ text: l.instagram, callback_data: "ig:set" }]] : []),
    ];
  }
  const others = (["stats", "badges", "group"] as const).filter((v) => v !== view).map(tab);
  return [[home, ...others], [web[0], web[1]]];
}

/** The two ↗ buttons, through the shared watch helper (web_app when the student Mini App is on). */
export async function profileWebCells(admin: unknown, o: {
  chatId: number;
  locale: Locale;
  openLabel: string;
  webhookOn: boolean;
  magicLink: (legacyPath: string) => Promise<string>;
}): Promise<[BotWatch, BotWatch]> {
  const mk = (text: string, path: string) =>
    studentWatchButton(admin, {
      chatId: o.chatId, text, miniPath: path, legacyPath: path, src: "bot_profile", webhookOn: o.webhookOn,
      magicLink: o.magicLink,
    });
  const rating = await mk(PROF_TAB_T[o.locale]?.fullRating ?? PROF_TAB_T.uz.fullRating, "/leaderboard");
  const open = await mk(o.openLabel, "/profile");
  return [rating, open];
}

/** The /til chooser (the same three buttons /til sends). */
export function langChooserKeyboard(): { inline_keyboard: Cb[][] } {
  return {
    inline_keyboard: [[
      { text: "🇺🇿 O'zbek", callback_data: "setlang:uz" },
      { text: "🇷🇺 Русский", callback_data: "setlang:ru" },
      { text: "🇬🇧 English", callback_data: "setlang:en" },
    ]],
  };
}

const isWatch = (c: Cell): c is BotWatch => typeof (c as BotWatch).legacy === "function";

export const isNotModified = (o: Pick<SendOutcome, "error">): boolean => /message is not modified/i.test(String(o.error ?? ""));

/** The tapped message cannot be edited any more (deleted, too old, not a text message). */
export const isEditTargetGone = (o: Pick<SendOutcome, "error">): boolean =>
  /message to edit not found|message can't be edited|message_id_invalid|no text in the message to edit/i.test(String(o.error ?? ""));

type Edit = (payload: Record<string, unknown>) => Promise<SendOutcome>;
const botEdit: Edit = (p) => sendTelegram(BOT_TOKEN, "editMessageText", p, { record: false });

export type ShowResult = "edited" | "unchanged" | "sent" | "failed";

/**
 * Show a profile view: edit the tapped message in place (`edit` + a message id), else send a new one. See the
 * header for the failure handling. Never throws.
 */
export async function showProfileView(admin: unknown, o: {
  chatId: number;
  messageId: number | null | undefined;
  edit: boolean;
  text: string;
  rows: Cell[][];
  editFn?: Edit;
  sendFn?: (admin: unknown, chatId: number, text: string, rows: Cell[][]) => Promise<SendOutcome>;
}): Promise<ShowResult> {
  const send = o.sendFn ?? ((a, c, t, r) => sendStudentWatchMessage(a, c, t, r as never));
  try {
    if (o.edit && o.messageId) {
      const payload = (kb: Record<string, unknown>[][]) => ({
        chat_id: o.chatId,
        message_id: o.messageId,
        text: o.text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: kb },
      });
      let unchanged = false;
      const edit = o.editFn ?? botEdit;
      const guarded: Edit = async (p) => {
        const r = await edit(p);
        if (!r.ok && isNotModified(r)) {
          unchanged = true;
          return { ...r, ok: true };
        }
        // A gone/uneditable message is a 400 too, but it says nothing about our web_app buttons: take it out of
        // the shared rejection rule (status 400 only) so it neither alarms nor re-sends magic links — the new
        // message below carries the buttons instead.
        if (!r.ok && isEditTargetGone(r)) return { ...r, status: 410 };
        return r;
      };
      const first = o.rows.map((row) => row.map((c) => (isWatch(c) ? c.button : c) as Record<string, unknown>));
      const { result } = await sendWithWatchFallback(guarded, payload(first), async () => {
        const kb: Record<string, unknown>[][] = [];
        for (const row of o.rows) {
          const out: Record<string, unknown>[] = [];
          for (const c of row) {
            if (!isWatch(c)) { out.push(c as Record<string, unknown>); continue; }
            const lg = await c.legacy();
            if (!lg) return null;
            out.push(lg as Record<string, unknown>);
          }
          kb.push(out);
        }
        return payload(kb);
      }, { fn: "telegram-bot-webhook", admin });
      if (result.ok) return unchanged ? "unchanged" : "edited";
      // Deleted / no longer editable → today's behaviour: a new message.
    }
    const r = await send(admin, o.chatId, o.text, o.rows);
    return r.ok ? "sent" : "failed";
  } catch (e) {
    console.error("profile-tabs: show failed", String((e as Error)?.message ?? e));
    return "failed";
  }
}
