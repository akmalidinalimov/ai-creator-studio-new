// Pins where a course-linked reminder button opens (reminderPaths) with engagement_targeting.trial_to_course_page
// off (today's targets, byte for byte) and on (a trial student → the course page, on the Mini App AND the
// magic-link path). The closed-course rule itself is pinned in _shared/engagement-targeting.test.ts.
// Run: deno test supabase/functions/cron-engagement/
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dailyKeyboard, reminderPaths } from "./core.ts";
import { watchButton, type WatchFlag } from "../_shared/miniapp-button.ts";

const C = "0b6f4e1c-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
const NEXT = "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";
const ON: WatchFlag = { on: true, watch: true };
const OFF: WatchFlag = { on: false, watch: false };

Deno.test("switch off: exactly the old targets (daily / streak / drip)", () => {
  // (old) miniPath continuePath(c), legacy /lesson/<c>/<next>
  assertEquals(reminderPaths(C, NEXT, false), { miniPath: `/continue/${C}`, legacyPath: `/lesson/${C}/${NEXT}`, trial: false });
  // (old drip) no next lesson → the magic link keeps /dashboard, the Mini App still /continue/<c>
  assertEquals(reminderPaths(C, null, false), { miniPath: `/continue/${C}`, legacyPath: "/dashboard", trial: false });
});

Deno.test("trial + switch on: the course page (the trial card) on both paths, whatever the next lesson", () => {
  const want = { miniPath: `/course/${C}`, legacyPath: `/course/${C}`, trial: true };
  assertEquals(reminderPaths(C, NEXT, true), want);
  assertEquals(reminderPaths(C, null, true), want);
});

async function build(flag: WatchFlag, trial: boolean) {
  const p = reminderPaths(C, NEXT, trial);
  const magic: string[] = [];
  const r = await watchButton({
    chat: "private", text: "Davom etish →", flag, fn: "cron-engagement", miniPath: p.miniPath, legacyPath: p.legacyPath,
    track: { src: "daily_reminder" },
    magicLink: (path) => {
      magic.push(path);
      return Promise.resolve("https://aicreator.academy/auth/magic?t=abc");
    },
    base: "https://www.aicreator.academy",
  });
  return { r, magic };
}

Deno.test("trial daily reminder, Mini App on: a web_app button to /course/<c>, no magic link", async () => {
  const { r, magic } = await build(ON, true);
  assertEquals(r.button, { text: "Davom etish →", web_app: { url: `https://www.aicreator.academy/course/${C}?src=daily_reminder` } });
  assertEquals(magic, []);
  // "Bugun emas" is untouched.
  assertEquals(dailyKeyboard(r.button, "uz").inline_keyboard[1], [{ text: "Bugun emas", callback_data: "ack:not_today" }]);
});

Deno.test("trial daily reminder, Mini App off: the magic link goes to /course/<c>, never a locked lesson", async () => {
  const { r, magic } = await build(OFF, true);
  assertEquals(magic, [`/course/${C}`]);
  assertEquals(r.mode, "magic_link");
});

Deno.test("paid student, switch on or off: unchanged (/continue/<c>; magic link to the lesson)", async () => {
  const on = await build(ON, false);
  assertEquals(on.r.button, { text: "Davom etish →", web_app: { url: `https://www.aicreator.academy/continue/${C}?src=daily_reminder` } });
  const off = await build(OFF, false);
  assertEquals(off.magic, [`/lesson/${C}/${NEXT}`]);
});
