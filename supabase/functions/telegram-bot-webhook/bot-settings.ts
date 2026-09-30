// /sozlamalar (⚙️ Sozlamalar): daily-reminder on/off, reminder hour, timezone.
//
// Reminder hour: cron-engagement never sends a daily reminder before 08:00 (core.ts reminderWindows: an hour
// below 8 is quiet, and 00 falls back to 20:00 via `rh || 20`; core.test.ts pins both on purpose). The picker
// used to offer 00:00–23:00, so 00:00–07:00 silently meant "no reminder". It now offers 08:00–22:00 only, and a
// tap on an old keyboard's hour outside that range is refused with a friendly message instead of being saved.
//
// Saves: each write is checked (error AND row count). A failed save answers an honest "not saved" toast and
// leaves one `bot_settings_save_failed` admin_actions row (graceful is not silent); it never says "saved".
//
// The pickers and the parsers live side by side so bot-settings.test.ts can prove every offered button parses
// back as valid and fits Telegram's 64-byte callback_data limit.
import { logHealth } from "../_shared/edge.ts";

// A service-role Supabase client (typed loosely, like the rest of the codebase).
// deno-lint-ignore no-explicit-any
type Db = any;

export const REMINDER_FIRST_HOUR = 8;
export const REMINDER_LAST_HOUR = 22;

/** The timezones the settings panel offers (and the only ones a set_tz tap may store). */
export const TIMEZONES: readonly string[] = [
  "Asia/Tashkent",
  "Asia/Almaty",
  "Asia/Bishkek",
  "Asia/Dushanbe",
  "Asia/Ashgabat",
  "Europe/Moscow",
  "Europe/Kiev",
  "Europe/Istanbul",
  "UTC",
];

type Button = { text: string; callback_data: string };

/** "08".."22" in rows of `perRow` (3 rows of 5 by default). */
export function reminderHourRows(perRow = 5): string[][] {
  const hours: string[] = [];
  for (let h = REMINDER_FIRST_HOUR; h <= REMINDER_LAST_HOUR; h++) hours.push(String(h).padStart(2, "0"));
  const rows: string[][] = [];
  for (let i = 0; i < hours.length; i += perRow) rows.push(hours.slice(i, i + perRow));
  return rows;
}

/** The hour picker: 08:00–22:00, then a back button. */
export function hourPickerKeyboard(backText: string): { inline_keyboard: Button[][] } {
  const rows: Button[][] = reminderHourRows().map((hs) =>
    hs.map((hh) => ({ text: `${hh}:00`, callback_data: `settings:set_time:${hh}` }))
  );
  rows.push([{ text: backText, callback_data: "settings:back" }]);
  return { inline_keyboard: rows };
}

/** The timezone picker, then a back button. */
export function tzPickerKeyboard(backText: string): { inline_keyboard: Button[][] } {
  const rows: Button[][] = TIMEZONES.map((tz) => [{ text: tz, callback_data: `settings:set_tz:${tz}` }]);
  rows.push([{ text: backText, callback_data: "settings:back" }]);
  return { inline_keyboard: rows };
}

/**
 * The bell button's callback: it carries the TARGET state, not "toggle", so a double tap or a stale keyboard sets
 * what the student saw instead of flipping a read-modify-write.
 */
export const bellCallback = (enabledNow: boolean): string => (enabledNow ? "settings:bell:off" : "settings:bell:on");

/** `bell:on|off` (the part after "settings:") → the value to store; null for anything else. */
export function parseBellTarget(action: string): boolean | null {
  return action === "bell:on" ? true : action === "bell:off" ? false : null;
}

/** A `set_time:<hh>` suffix → "HH" when it is an offered hour, else null (old keyboard / forged). */
export function parseReminderHour(raw: string): string | null {
  if (!/^\d{2}$/.test(raw)) return null;
  const h = Number(raw);
  return h >= REMINDER_FIRST_HOUR && h <= REMINDER_LAST_HOUR ? raw : null;
}

/** A `set_tz:<tz>` suffix → the timezone when it is one we offer, else null. */
export function parseTimezone(raw: string): string | null {
  return TIMEZONES.includes(raw) ? raw : null;
}

export type SettingsPatch = { notifications_enabled?: boolean; reminder_time?: string; timezone?: string };

/**
 * One checked profiles write for a settings tap. true only when exactly the student's row was updated. On failure
 * it records `bot_settings_save_failed` (fields + error, never a secret) and returns false. Never throws.
 */
export async function saveBotSetting(admin: Db, userId: string, patch: SettingsPatch): Promise<boolean> {
  const fields = Object.keys(patch).sort().join(",");
  let problem: { code: string | null; message: string } | null = null;
  try {
    const { data, error } = await admin.from("profiles").update(patch).eq("id", userId).select("id");
    if (error) problem = { code: error.code ?? null, message: String(error.message || "error") };
    else if (!Array.isArray(data) || data.length !== 1) {
      problem = { code: null, message: `${Array.isArray(data) ? data.length : 0} rows updated` };
    }
  } catch (e) {
    problem = { code: null, message: String((e as Error)?.message || e) };
  }
  if (!problem) return true;
  await logHealth(admin, "bot_settings_save_failed", { fields, code: problem.code, error: problem.message.slice(0, 300) }, {
    targetUserId: userId,
    source: "telegram-bot-webhook",
  });
  return false;
}
