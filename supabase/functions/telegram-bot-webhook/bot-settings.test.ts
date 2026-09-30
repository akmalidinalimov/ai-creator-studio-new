// Tests for /sozlamalar. Run: deno test supabase/functions/telegram-bot-webhook/bot-settings.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { reminderWindows } from "../cron-engagement/core.ts";
import {
  bellCallback,
  hourPickerKeyboard,
  parseBellTarget,
  parseReminderHour,
  parseTimezone,
  reminderHourRows,
  saveBotSetting,
  TIMEZONES,
  tzPickerKeyboard,
} from "./bot-settings.ts";

const bytes = (s: string) => new TextEncoder().encode(s).length;
const allButtons = (kb: { inline_keyboard: { text: string; callback_data: string }[][] }) => kb.inline_keyboard.flat();

Deno.test("hour picker offers exactly 08:00-22:00 (3 rows of 5) + back", () => {
  assertEquals(reminderHourRows(), [
    ["08", "09", "10", "11", "12"],
    ["13", "14", "15", "16", "17"],
    ["18", "19", "20", "21", "22"],
  ]);
  const kb = hourPickerKeyboard("← Orqaga");
  assertEquals(kb.inline_keyboard.length, 4);
  assertEquals(kb.inline_keyboard[3], [{ text: "← Orqaga", callback_data: "settings:back" }]);
});

Deno.test("every offered hour parses back as valid, and actually gets a daily reminder from cron-engagement", () => {
  for (const b of allButtons(hourPickerKeyboard("x")).filter((b) => b.callback_data.startsWith("settings:set_time:"))) {
    const hh = parseReminderHour(b.callback_data.slice("settings:set_time:".length));
    assert(hh, `${b.callback_data} must be accepted`);
    // The engine that sends reminders (not a copy of its rule): at HH:00 local the daily window is open.
    const at = new Date(`2026-09-30T${hh}:00:00+05:00`);
    const w = reminderWindows({ timezone: "Asia/Tashkent", reminder_time: `${hh}:00:00`, created_at: "2026-01-01T00:00:00Z" }, at);
    assertEquals(w.daily, true, `a ${hh}:00 reminder must fire`);
  }
});

Deno.test("old-keyboard / forged hours are refused (00-07 never fire, 23 is outside the offer)", () => {
  for (let h = 0; h < 8; h++) {
    const hh = String(h).padStart(2, "0");
    assertEquals(parseReminderHour(hh), null);
    // Why: the engine never sends these (hour < 8 is quiet; 00 even falls back to 20:00).
    const at = new Date(`2026-09-30T${hh}:00:00+05:00`);
    assertEquals(reminderWindows({ timezone: "Asia/Tashkent", reminder_time: `${hh}:00:00`, created_at: "2026-01-01T00:00:00Z" }, at).daily, false);
  }
  for (const bad of ["23", "8", "099", "ab", "", "22:00", "-1", "１０"]) assertEquals(parseReminderHour(bad), null, bad);
  assertEquals(parseReminderHour("08"), "08");
  assertEquals(parseReminderHour("22"), "22");
});

Deno.test("timezone: only the offered list, every button parses back", () => {
  for (const b of allButtons(tzPickerKeyboard("x")).filter((b) => b.callback_data.startsWith("settings:set_tz:"))) {
    assert(parseTimezone(b.callback_data.slice("settings:set_tz:".length)), b.callback_data);
  }
  assertEquals(allButtons(tzPickerKeyboard("x")).length, TIMEZONES.length + 1);
  for (const bad of ["Mars/Olympus", "", "asia/tashkent", "Asia/Tashkent ", "'; drop table profiles; --"]) {
    assertEquals(parseTimezone(bad), null, bad);
  }
});

Deno.test("bell button carries its target state; legacy toggle is not a target", () => {
  assertEquals(bellCallback(true), "settings:bell:off");
  assertEquals(bellCallback(false), "settings:bell:on");
  assertEquals(parseBellTarget(bellCallback(true).slice("settings:".length)), false);
  assertEquals(parseBellTarget(bellCallback(false).slice("settings:".length)), true);
  assertEquals(parseBellTarget("toggle_bell"), null);
  assertEquals(parseBellTarget("bell:maybe"), null);
});

Deno.test("every settings callback_data fits Telegram's 64-byte limit", () => {
  const all = [
    ...allButtons(hourPickerKeyboard("x")),
    ...allButtons(tzPickerKeyboard("x")),
    { text: "", callback_data: bellCallback(true) },
    { text: "", callback_data: bellCallback(false) },
    { text: "", callback_data: "prof:settings" },
  ];
  for (const b of all) assert(bytes(b.callback_data) <= 64, `${b.callback_data} is ${bytes(b.callback_data)} bytes`);
});

// ---- saveBotSetting: a fake supabase-js update().eq().select() + the admin_actions insert logHealth makes ----
function fakeDb(result: { data?: unknown; error?: unknown; throws?: boolean }) {
  const updates: { table: string; patch: unknown; eq: [string, unknown] | null }[] = [];
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  return {
    updates,
    inserts,
    from(table: string) {
      return {
        update(patch: unknown) {
          const u = { table, patch, eq: null as [string, unknown] | null };
          updates.push(u);
          return {
            eq(col: string, v: unknown) {
              u.eq = [col, v];
              return {
                select() {
                  if (result.throws) return Promise.reject(new Error("fetch failed"));
                  return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
                },
              };
            },
          };
        },
        insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

Deno.test("saveBotSetting: one row updated → true, nothing logged", async () => {
  const db = fakeDb({ data: [{ id: "u1" }] });
  assertEquals(await saveBotSetting(db, "u1", { reminder_time: "09:00:00" }), true);
  assertEquals(db.updates, [{ table: "profiles", patch: { reminder_time: "09:00:00" }, eq: ["id", "u1"] }]);
  assertEquals(db.inserts, []);
});

Deno.test("saveBotSetting: an error, 0 rows, or a throw → false + bot_settings_save_failed row", async () => {
  const cases = [
    { data: null, error: { code: "22007", message: "invalid input syntax for type time" } },
    { data: [] }, // 0 rows: the write reached nobody (e.g. the profile vanished) — not "saved"
    { throws: true },
  ];
  for (const c of cases) {
    const db = fakeDb(c);
    assertEquals(await saveBotSetting(db, "u9", { timezone: "UTC" }), false);
    const sig = db.inserts.find((i) => i.table === "admin_actions");
    assert(sig, "a failed settings save must be DB-visible");
    assertEquals(sig.row.action, "bot_settings_save_failed");
    assertEquals(sig.row.target_user_id, "u9");
    assertEquals((sig.row.details as Record<string, unknown>).fields, "timezone");
    assertEquals((sig.row.details as Record<string, unknown>).source, "telegram-bot-webhook");
  }
});
