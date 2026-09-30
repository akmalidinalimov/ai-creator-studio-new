// The bot's "/" command menu, per role and per language (UX review 2026-09-30, quick win #14).
//
// BEFORE: one setMyCommands call, inside the one-off July migration broadcast (last ran 2026-07-06), default
// scope only, Uzbek only, no /dars — and teachers saw the student list.
//
// NOW (applied by the ☰ sweep, menu-sweep.ts, once per pass; and for a staff chat also by the live menu sync):
//   scope all_private_chats                 the STUDENT list — uz (no language_code), ru, en
//   scope chat (each teacher's own chat)    the TEACHER list in that teacher's preferred language
//   scope chat (each admin's own chat)      the ADMIN list
// The default scope (which is also what group chats show) is left exactly as it is: nothing here changes a
// group. Every command listed here is one the bot already handles (index.ts handleCommand /
// handleTeacherCommand / handleAdminCommand); bot-commands.test.ts pins the names against Telegram's rules
// (1-32 chars of a-z, 0-9, _; description 1-256 chars).
//
// Bump COMMANDS_VERSION whenever a list changes: it is part of the sweep's pass key, so the next minute tick
// starts a fresh pass that re-applies the lists everywhere.
import { type SendOutcome } from "../_shared/telegram-send.ts";

export const COMMANDS_VERSION = 1;

export type Locale = "uz" | "ru" | "en";
export type CommandRole = "student" | "teacher" | "admin";
export type BotCommand = { command: string; description: string };
export type TgCall = (method: string, payload: Record<string, unknown>) => Promise<SendOutcome>;

type Row = [command: string, uz: string, ru: string, en: string];

const LANG = "🌐 Til / Язык / Language";

const STUDENT: Row[] = [
  ["start", "🏠 Boshlash va menyu", "🏠 Начало и меню", "🏠 Start and menu"],
  ["davom", "📚 Keyingi dars", "📚 Следующий урок", "📚 Next lesson"],
  ["dars", "📋 Kurs modullari", "📋 Модули курса", "📋 Course modules"],
  ["vazifalar", "📝 Mening vazifalarim", "📝 Мои задания", "📝 My homework"],
  ["profil", "👤 Profil va guruh reytingi", "👤 Профиль и рейтинг группы", "👤 Profile and group rating"],
  ["sozlamalar", "⚙️ Eslatma sozlamalari", "⚙️ Настройки напоминаний", "⚙️ Reminder settings"],
  ["til", LANG, LANG, LANG],
  ["yordam", "❓ Yordam", "❓ Помощь", "❓ Help"],
];

const TEACHER: Row[] = [
  ["start", "🏠 Boshlash va menyu", "🏠 Начало и меню", "🏠 Start and menu"],
  ["baholash", "📝 Baholash", "📝 Оценить", "📝 Grade"],
  ["profil", "👤 Ustoz profili", "👤 Профиль устоза", "👤 Teacher profile"],
  ["tstats", "📊 Guruh statistikasi", "📊 Статистика группы", "📊 Group stats"],
  ["modulvazifalar", "📚 Vazifalar (modullar bo'yicha)", "📚 Задания по модулям", "📚 Homework by module"],
  ["tstudents", "👥 Mening talabalarim", "👥 Мои студенты", "👥 My students"],
  ["tinactive", "😴 Faolsizlar", "😴 Неактивные", "😴 Inactive"],
  ["ttop", "🏆 TOP talabalar", "🏆 ТОП студенты", "🏆 Top students"],
  ["tbroadcast", "📣 Guruhga xabar", "📣 Сообщение группе", "📣 Message the group"],
  ["guruh", "🔄 Guruhni almashtirish", "🔄 Сменить группу", "🔄 Switch group"],
  ["sozlamalar", "⚙️ Sozlamalar", "⚙️ Настройки", "⚙️ Settings"],
  ["til", LANG, LANG, LANG],
];

const ADMIN: Row[] = [
  ["start", "🏠 Boshlash va menyu", "🏠 Начало и меню", "🏠 Start and menu"],
  ["analitika", "📊 Statistika", "📊 Статистика", "📊 Statistics"],
  ["yangilar", "🆕 Yangi talabalar", "🆕 Новые студенты", "🆕 New students"],
  ["baholash", "📝 Baholash", "📝 Оценить", "📝 Grade"],
  ["profil", "👤 Profil", "👤 Профиль", "👤 Profile"],
  ["asteacher", "👁 Ustoz sifatida ko'rish", "👁 Смотреть как устоз", "👁 View as a teacher"],
  ["aststudent", "👁 Talaba sifatida ko'rish", "👁 Смотреть как студент", "👁 View as a student"],
  ["admin", "↩️ Admin rejimiga qaytish", "↩️ Вернуться в режим админа", "↩️ Back to admin mode"],
  ["til", LANG, LANG, LANG],
];

const TABLE: Record<CommandRole, Row[]> = { student: STUDENT, teacher: TEACHER, admin: ADMIN };
const COL: Record<Locale, 1 | 2 | 3> = { uz: 1, ru: 2, en: 3 };

/** The command list for a role in a language. */
export function commandsFor(role: CommandRole, locale: Locale): BotCommand[] {
  const col = COL[locale] ?? 1;
  return TABLE[role].map((r) => ({ command: r[0], description: r[col] }));
}

/** The three bot-wide calls: the student list for every private chat, per language (uz is the fallback). */
export function globalCommandCalls(): Record<string, unknown>[] {
  return (["uz", "ru", "en"] as Locale[]).map((l) => ({
    commands: commandsFor("student", l),
    scope: { type: "all_private_chats" },
    ...(l === "uz" ? {} : { language_code: l }),
  }));
}

/** The one per-chat call for a teacher or an admin (null for a student: students use the bot-wide list). */
export function chatCommandCall(chatId: number, role: CommandRole, locale: Locale): Record<string, unknown> | null {
  if (role === "student" || !(Number(chatId) > 0)) return null;
  return { commands: commandsFor(role, locale), scope: { type: "chat", chat_id: chatId } };
}

export type CommandTally = { ok: number; failed: number; errors: string[] };

/** Apply the bot-wide lists. Never throws; returns what happened (the caller records it). */
export async function applyGlobalCommands(call: TgCall): Promise<CommandTally> {
  const t: CommandTally = { ok: 0, failed: 0, errors: [] };
  for (const p of globalCommandCalls()) {
    const o = await call("setMyCommands", p);
    if (o.ok) t.ok++;
    else {
      t.failed++;
      if (t.errors.length < 3) t.errors.push(String(o.error ?? `http_${o.status}`).slice(0, 120));
    }
  }
  return t;
}
