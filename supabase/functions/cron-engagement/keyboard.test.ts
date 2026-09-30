// Pins the reminder keyboards: with the student Mini App OFF they are byte-for-byte today's magic-link
// keyboards; with it ON the watch button is a Mini App web_app button to /continue/<course> (drip 14:
// /dashboard) and no magic link is created. Run: deno test supabase/functions/cron-engagement/
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dailyKeyboard, dripKeyboard, notTodayLabel, streakKeyboard } from "./core.ts";
import { watchButton, type WatchFlag } from "../_shared/miniapp-button.ts";
import { continuePath, type MiniAppSrc } from "../_shared/miniapp-links.ts";

const C = "0b6f4e1c-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
const NEXT = "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";
const MAGIC = "https://aicreator.academy/auth/magic?t=abc123";
const ON: WatchFlag = { on: true, watch: true };
const OFF: WatchFlag = { on: false, watch: false };

// The old inline code, verbatim (minus the magicLink insert, whose url is MAGIC).
function oldDaily(label: string | undefined, nextId: string | null, locale: "uz" | "ru" | "en") {
  const inline: any[][] = [];
  if (nextId && label) inline.push([{ text: label, url: MAGIC }]);
  inline.push([{ text: locale === "ru" ? "Не сегодня" : locale === "en" ? "Not today" : "Bugun emas", callback_data: "ack:not_today" }]);
  return { inline_keyboard: inline };
}
function oldStreak(label: string | undefined, nextId: string | null) {
  const inline: any[][] = [];
  if (nextId && label) inline.push([{ text: label, url: MAGIC }]);
  return inline.length ? { inline_keyboard: inline } : undefined;
}
function oldDrip(label: string | undefined) {
  return label ? { inline_keyboard: [[{ text: label, url: MAGIC }]] } : undefined;
}

// What index.ts does for one reminder (reminderWatch), with a fake magic link.
async function watch(flag: WatchFlag, label: string | undefined, nextId: string | null, miniPath: string, src: MiniAppSrc) {
  const magicCalls: string[] = [];
  if (!(nextId && label)) return { button: null, magicCalls };
  const r = await watchButton({
    chat: "private", text: label, flag, fn: "cron-engagement", miniPath, legacyPath: `/lesson/${C}/${nextId}`,
    track: { src }, magicLink: (p) => { magicCalls.push(p); return Promise.resolve(MAGIC); },
  });
  return { button: r.button, magicCalls };
}

Deno.test("flag OFF: daily keyboard equals today's shape exactly (every locale, with/without a next lesson)", async () => {
  for (const locale of ["uz", "ru", "en"] as const) {
    for (const [label, nextId] of [["▶️ Davom etish", NEXT], ["▶️ Davom etish", null], [undefined, NEXT]] as const) {
      const w = await watch(OFF, label, nextId, continuePath(C), "daily_reminder");
      assertEquals(dailyKeyboard(w.button, locale), oldDaily(label, nextId, locale));
      assertEquals(w.magicCalls, nextId && label ? [`/lesson/${C}/${NEXT}`] : []);
    }
  }
});

Deno.test("flag OFF: streak + drip keyboards equal today's shape exactly", async () => {
  for (const [label, nextId] of [["⚡ Davom", NEXT], ["⚡ Davom", null], [undefined, NEXT]] as const) {
    const w = await watch(OFF, label, nextId, continuePath(C), "streak_warning");
    assertEquals(streakKeyboard(w.button), oldStreak(label, nextId));
  }
  for (const label of ["Qaytish →", undefined]) {
    const w = await watch(OFF, label, NEXT, "/dashboard", "drip_14");
    assertEquals(dripKeyboard(w.button), oldDrip(label));
  }
});

Deno.test("flag ON: the daily button opens the Mini App at /continue/<course>; no magic link is made", async () => {
  const w = await watch(ON, "▶️ Davom etish", NEXT, continuePath(C), "daily_reminder");
  assertEquals(w.magicCalls, []);
  assertEquals(dailyKeyboard(w.button, "uz"), {
    inline_keyboard: [
      [{ text: "▶️ Davom etish", web_app: { url: `https://www.aicreator.academy/continue/${C}?src=daily_reminder` } }],
      [{ text: "Bugun emas", callback_data: "ack:not_today" }],
    ],
  });
});

Deno.test("flag ON: streak + drip", async () => {
  const s = await watch(ON, "⚡ Davom", NEXT, continuePath(C), "streak_warning");
  assertEquals(streakKeyboard(s.button), {
    inline_keyboard: [[{ text: "⚡ Davom", web_app: { url: `https://www.aicreator.academy/continue/${C}?src=streak_warning` } }]],
  });
  const d = await watch(ON, "Qaytish →", NEXT, "/dashboard", "drip_14");
  assertEquals(dripKeyboard(d.button), {
    inline_keyboard: [[{ text: "Qaytish →", web_app: { url: "https://www.aicreator.academy/dashboard?src=drip_14" } }]],
  });
  assertEquals(dripKeyboard(null), undefined);
});

Deno.test("notTodayLabel", () => {
  assertEquals([notTodayLabel("uz"), notTodayLabel("ru"), notTodayLabel("en")], ["Bugun emas", "Не сегодня", "Not today"]);
});
