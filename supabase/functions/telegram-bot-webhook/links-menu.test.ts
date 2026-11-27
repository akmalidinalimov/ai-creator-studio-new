// Pins the 🎁 Bonus darslar / 📣 Kurs Telegrami builders (links-menu.ts): the trial lock, URL validation (only
// https://t.me/... — one bad URL makes Telegram reject the whole message), the title locale fallback, multi-course
// ordering (main first), the channel holding group never shown as a group, missing links skipped, empty → empty.
// Run: deno test supabase/functions/telegram-bot-webhook/links-menu.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BONUS_MAX_ITEMS, bonusLocked, bonusRows, bonusTitle, isTmeUrl, kanalEntries, kanalMissing, kanalRows,
  parseBonusCourses,
} from "./links-menu.ts";

Deno.test("trial lock: only a provisional account is locked", () => {
  assertEquals(bonusLocked("provisional"), true);
  assertEquals(bonusLocked("full"), false);
  assertEquals(bonusLocked(null), false);
  assertEquals(bonusLocked(undefined), false);
  assertEquals(bonusLocked("Provisional"), false);
});

Deno.test("URL validation: only https://t.me/...", () => {
  for (const ok of ["https://t.me/aicreators_smm", "https://t.me/+srXusW0zCM41NDg0", "https://t.me/c/123456/7"]) {
    assertEquals(isTmeUrl(ok), true, ok);
  }
  for (const bad of [
    "http://t.me/x", "https://t.me/", "https://t.me", "https://telegram.me/x", "https://t.me.evil.com/x",
    "https://t.me@evil.com/x", "https://evil.com/https://t.me/x", "javascript:alert(1)", "tg://resolve?domain=x",
    "https://t.me/x y", "https://t.me/x\n", "HTTPS://T.ME/x", "https://t.me/\"x", " https://t.me/x", "",
    "https://t.me/" + "a".repeat(600), null, undefined, 42, {},
  ]) {
    assertEquals(isTmeUrl(bad), false, String(bad));
  }
});

Deno.test("parseBonusCourses: valid items in order; bad url / no title dropped; trims the url", () => {
  const items = parseBonusCourses({
    items: [
      { title: "Video montaj", url: " https://t.me/montaj " },
      { title: "SMM", url: "http://t.me/smm" },
      { title: "YouTube", url: "javascript:alert(1)" },
      { title: "", url: "https://t.me/empty" },
      { title: { ru: "Ютуб" }, url: "https://t.me/yt" },
      { title: { uz: "  " }, url: "https://t.me/blank" },
      "junk",
      null,
      { url: "https://t.me/no-title" },
    ],
  });
  assertEquals(items, [
    { title: "Video montaj", url: "https://t.me/montaj" },
    { title: { ru: "Ютуб" }, url: "https://t.me/yt" },
  ]);
});

Deno.test("parseBonusCourses: missing / malformed = []", () => {
  for (const v of [null, undefined, "x", 1, [], {}, { items: "x" }, { items: {} }, { items: [] }]) {
    assertEquals(parseBonusCourses(v), [], JSON.stringify(v));
  }
});

Deno.test("parseBonusCourses: capped", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ title: `K${i}`, url: `https://t.me/k${i}` }));
  assertEquals(parseBonusCourses({ items: many }).length, BONUS_MAX_ITEMS);
});

Deno.test("bonus title: locale, else uz, else any", () => {
  assertEquals(bonusTitle("Video montaj", "ru"), "Video montaj");
  assertEquals(bonusTitle({ uz: "Montaj", ru: "Монтаж", en: "Editing" }, "ru"), "Монтаж");
  assertEquals(bonusTitle({ uz: "Montaj", ru: "Монтаж" }, "en"), "Montaj");
  assertEquals(bonusTitle({ ru: "Монтаж" }, "uz"), "Монтаж");
  assertEquals(bonusTitle({ en: "Editing" }, "uz"), "Editing");
});

Deno.test("bonusRows: one URL button per row, title clipped, no callback_data", () => {
  const rows = bonusRows([
    { title: { uz: "Video montaj", en: "Video editing" }, url: "https://t.me/montaj" },
    { title: "S".repeat(100), url: "https://t.me/smm" },
  ], "en");
  assertEquals(rows.length, 2);
  assertEquals(rows[0], [{ text: "🎁 Video editing", url: "https://t.me/montaj" }]);
  assertEquals(rows[1][0].text, "🎁 " + "S".repeat(48));
  assertEquals(rows.flat().some((b) => "callback_data" in b), false);
  assertEquals(bonusRows([], "uz"), []);
});

const C70 = { id: "c70", title: "AI CREATORS CHALLENGE 7.0", telegram_channel_url: "https://t.me/+ch70", channel_group_id: "hold70" };
const CS = { id: "cs", title: "CLAUDE STUDIO", telegram_channel_url: "https://t.me/+chcs", channel_group_id: "holdcs" };
const C50 = { id: "c50", title: "AI CREATORS 5.0", telegram_channel_url: null, channel_group_id: null };
const C60 = { id: "c60", title: "AI CREATORS CHALLENGE 6.0", telegram_channel_url: null, channel_group_id: null };
const GROUPS = [
  { id: "g70", name: "7.0 | 2-GURUH", telegram_group_url: "https://t.me/+g70" },
  { id: "hold70", name: "7.0 | KANAL", telegram_group_url: "https://t.me/+should-never-show" },
  { id: "gcs", name: "CLAUDE STUDIO | 1", telegram_group_url: "https://t.me/+gcs" },
  { id: "g50", name: "5.0 | 3-GURUH", telegram_group_url: "https://t.me/+g50" },
  { id: "g60", name: "6.0 | 1-GURUH", telegram_group_url: null },
];
const COURSES = [C70, CS, C50, C60];

Deno.test("kanal: single course → channel then group", () => {
  const e = kanalEntries({ main: { group_id: "g70", course_id: "c70" }, secondary: [], courses: COURSES, groups: GROUPS });
  assertEquals(kanalRows(e, "uz"), [
    [{ text: "📣 AI CREATORS CHALLENGE 7.0 · Kanal", url: "https://t.me/+ch70" }],
    [{ text: "👥 7.0 | 2-GURUH · Guruh", url: "https://t.me/+g70" }],
  ]);
  assertEquals(kanalMissing(e), []);
});

Deno.test("kanal: multi-course → main course first, then secondary (deduped)", () => {
  const e = kanalEntries({
    main: { group_id: "gcs", course_id: "cs" },
    secondary: [{ group_id: "g70", course_id: "c70" }, { group_id: "g70", course_id: "c70" }],
    courses: COURSES, groups: GROUPS,
  });
  assertEquals(e.map((x) => x.course_id), ["cs", "c70"]);
  assertEquals(kanalRows(e, "en").map((r) => r[0].url), [
    "https://t.me/+chcs", "https://t.me/+gcs", "https://t.me/+ch70", "https://t.me/+g70",
  ]);
});

Deno.test("kanal: the channel holding group is never shown and never counted missing", () => {
  const e = kanalEntries({ main: { group_id: "hold70", course_id: "c70" }, secondary: [], courses: COURSES, groups: GROUPS });
  assertEquals(e[0].holding, true);
  assertEquals(e[0].group_url, null);
  assertEquals(kanalRows(e, "uz"), [[{ text: "📣 AI CREATORS CHALLENGE 7.0 · Kanal", url: "https://t.me/+ch70" }]]);
  assertEquals(kanalMissing(e), []);
});

Deno.test("kanal: missing links are skipped and reported", () => {
  // 5.0: group link but no channel; 6.0: neither.
  const e = kanalEntries({
    main: { group_id: "g50", course_id: "c50" }, secondary: [{ group_id: "g60", course_id: "c60" }],
    courses: COURSES, groups: GROUPS,
  });
  assertEquals(kanalRows(e, "uz"), [[{ text: "👥 5.0 | 3-GURUH · Guruh", url: "https://t.me/+g50" }]]);
  assertEquals(kanalMissing(e), [
    { course_id: "c50", group_id: "g50", channel_missing: true, group_missing: false },
    { course_id: "c60", group_id: "g60", channel_missing: true, group_missing: true },
  ]);
});

Deno.test("kanal: an invalid stored URL is dropped (never sent)", () => {
  const e = kanalEntries({
    main: { group_id: "gx", course_id: "cx" }, secondary: [],
    courses: [{ id: "cx", title: "X", telegram_channel_url: "http://t.me/x", channel_group_id: null }],
    groups: [{ id: "gx", name: "X | 1", telegram_group_url: "javascript:alert(1)" }],
  });
  assertEquals(kanalRows(e, "uz"), []);
  assertEquals(kanalMissing(e).length, 1);
});

Deno.test("kanal: empty → empty", () => {
  const e = kanalEntries({ main: null, secondary: [], courses: [], groups: [] });
  assertEquals(e, []);
  assertEquals(kanalRows(e, "uz"), []);
  assertEquals(kanalMissing(e), []);
});

Deno.test("kanal: a course-less main group shows only its group link", () => {
  const e = kanalEntries({ main: { group_id: "g50", course_id: null }, secondary: [], courses: COURSES, groups: GROUPS });
  assertEquals(kanalRows(e, "ru"), [[{ text: "👥 5.0 | 3-GURUH · Группа", url: "https://t.me/+g50" }]]);
  assertEquals(kanalMissing(e), []);
});
