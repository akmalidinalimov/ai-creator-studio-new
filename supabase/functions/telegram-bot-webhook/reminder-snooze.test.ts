// Pins "🌙 Bugun emas": a tap really skips TONIGHT's streak warning (checked against cron-engagement's own
// reminderWindows, not a copy of its rule), edits the reminder and removes its buttons, is DB-visible once a
// day, and never claims success when the save failed.
// Run: deno test supabase/functions/telegram-bot-webhook/reminder-snooze.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleNotToday, SNOOZE_T } from "./reminder-snooze.ts";
import { reminderWindows, type WindowUser } from "../cron-engagement/core.ts";
import { FakeDb, fakeTelegram, type Row } from "../_bot/testing/fake-db.ts";

const UID = "a0000000-0000-4000-8000-000000000001";
// Asia/Tashkent is UTC+5 all year.
const tashkent = (day: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.parse(`${day}T00:00:00Z`) + ((h - 5) * 60 + m) * 60_000);
};

function setup(profile: Row | null = { id: UID, preferred_locale: "uz" }) {
  const db = new FakeDb({
    profiles: profile ? [{ ...profile, timezone: "Asia/Tashkent", last_streak_warning_at: null }] : [],
    admin_actions: [],
  });
  const tg = fakeTelegram();
  const toasts: string[] = [];
  const deps = (now: Date) => ({
    call: tg.call,
    findProfile: (_: number) => Promise.resolve(profile as { id: string; preferred_locale: string } | null),
    answer: (t: string) => { toasts.push(t); return Promise.resolve(); },
    now: () => now,
  });
  const cq = { id: "q1", from: { id: 4242 }, message: { message_id: 77, chat: { id: 4242 }, date: 1_759_330_800 } };
  return { db, tg, toasts, deps, cq };
}

Deno.test("a tap at 20:05 skips tonight's 21:00 streak warning (cron-engagement's own rule), not tomorrow's", async () => {
  const { db, tg, toasts, deps, cq } = setup();
  const tap = tashkent("2026-10-01", "20:05");
  assertEquals(await handleNotToday(db, cq, deps(tap)), "snoozed");
  const stamped = db.rows("profiles")[0].last_streak_warning_at;
  assertEquals(stamped, tap.toISOString());

  const u = (): WindowUser => ({ timezone: "Asia/Tashkent", reminder_time: "20:00:00", created_at: "2026-01-01T00:00:00Z", last_streak_warning_at: stamped });
  assertEquals(reminderWindows(u(), tashkent("2026-10-01", "21:00")).streak, false);
  assertEquals(reminderWindows(u(), tashkent("2026-10-02", "21:00")).streak, true);
  // without the tap the warning would have gone out tonight
  assertEquals(reminderWindows({ ...u(), last_streak_warning_at: null }, tashkent("2026-10-01", "21:00")).streak, true);

  assertEquals(toasts, [SNOOZE_T.uz.toast]);
  assertEquals(tg.calls, [{ method: "editMessageText", payload: { chat_id: 4242, message_id: 77, text: SNOOZE_T.uz.done } }]);
  const logged = db.actions("reminder_snoozed");
  assertEquals(logged.length, 1);
  assertEquals(logged[0].target_user_id, UID);
});

Deno.test("a second tap the same day (a race before the buttons vanish) is harmless and logged once", async () => {
  // (a distinct profile id per test: logHealthOnce also dedupes in memory, per process and day)
  const { db, deps, cq } = setup({ id: "a0000000-0000-4000-8000-000000000002", preferred_locale: "uz" });
  const tap = tashkent("2026-10-01", "20:05");
  await handleNotToday(db, cq, deps(tap));
  await handleNotToday(db, cq, deps(new Date(tap.getTime() + 2000)));
  assertEquals(db.actions("reminder_snoozed").length, 1);
});

Deno.test("a failed save: honest toast, message untouched, DB-visible, never 'done'", async () => {
  const { db, tg, toasts, deps, cq } = setup({ id: "a0000000-0000-4000-8000-00000000dead", preferred_locale: "ru" });
  db.rows("profiles").length = 0; // the update matches 0 rows
  assertEquals(await handleNotToday(db, cq, deps(new Date())), "save_failed");
  assertEquals(toasts, [SNOOZE_T.ru.failed]);
  assertEquals(tg.calls.length, 0);
  assertEquals(db.actions("reminder_snooze_save_failed").length, 1);
  assertEquals(db.actions("reminder_snoozed").length, 0);
});

Deno.test("an edit that fails for a real reason is recorded; 'not modified' is not", async () => {
  const s = setup();
  const notModified = fakeTelegram(() => ({ ok: false, status: 400, error: "Bad Request: message is not modified" }));
  await handleNotToday(s.db, s.cq, { ...s.deps(new Date()), call: notModified.call });
  assertEquals(s.db.actions("reminder_snooze_edit_failed").length, 0);
  const gone = fakeTelegram(() => ({ ok: false, status: 400, error: "Bad Request: message to edit not found" }));
  await handleNotToday(s.db, s.cq, { ...s.deps(new Date()), call: gone.call });
  assertEquals(s.db.actions("reminder_snooze_edit_failed").length, 1);
});

Deno.test("no profile (unreachable behind the webhook gate): today's plain OK, nothing written", async () => {
  const { db, tg, toasts, deps, cq } = setup(null);
  assertEquals(await handleNotToday(db, cq, deps(new Date())), "no_profile");
  assertEquals(toasts, ["OK 👍"]);
  assertEquals(tg.calls.length, 0);
  assertEquals(db.writes.length, 0);
});
