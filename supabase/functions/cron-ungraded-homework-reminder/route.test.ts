// Tests for the ungraded-reminder routing + admin digest. Run: deno test supabase/functions/cron-ungraded-homework-reminder/route.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ADMIN_DIGEST_MAX_CHARS,
  ADMIN_DIGEST_MAX_LINES,
  type AdminItem,
  adminDigestText,
  itemLabel,
  routeReminder,
  teacherReminderKeyboard,
  teacherReminderText,
  TEACHER_URL,
  type TeacherProfile,
} from "./route.ts";

const prof = (id: string, tg: number | null, extra: Partial<TeacherProfile> = {}): [string, TeacherProfile] =>
  [id, { id, telegram_id: tg, notifications_enabled: true, preferred_locale: "uz", ...extra }];

Deno.test("route: primary-only group with a reachable primary -> that one teacher (unchanged behaviour)", () => {
  const r = routeReminder("g1", new Map([["g1", ["p"]]]), new Map([prof("p", 111)]));
  assertEquals(r, { kind: "teacher", recipients: [{ userId: "p", chatId: 111, locale: "uz" }] });
});

Deno.test("route: primary + co-teacher both reachable -> both, primary first", () => {
  const r = routeReminder("g1", new Map([["g1", ["p", "c"]]]), new Map([prof("p", 111), prof("c", 222, { preferred_locale: "ru" })]));
  assertEquals(r, {
    kind: "teacher",
    recipients: [{ userId: "p", chatId: 111, locale: "uz" }, { userId: "c", chatId: 222, locale: "ru" }],
  });
});

Deno.test("route: unreachable primary no longer falls to the admins when a co-teacher is reachable", () => {
  const r = routeReminder("g1", new Map([["g1", ["p", "c"]]]), new Map([prof("p", null), prof("c", 222)]));
  assertEquals(r, { kind: "teacher", recipients: [{ userId: "c", chatId: 222, locale: "uz" }] });
});

Deno.test("route: a group whose teachers are all co-teachers reaches them, not the admins", () => {
  const r = routeReminder("g1", new Map([["g1", ["c1", "c2"]]]), new Map([prof("c1", 1), prof("c2", 2)]));
  assertEquals(r.kind, "teacher");
  assertEquals(r.kind === "teacher" && r.recipients.map((x) => x.userId), ["c1", "c2"]);
});

Deno.test("route: notifications switched off counts as unreachable", () => {
  const r = routeReminder("g1", new Map([["g1", ["p"]]]), new Map([prof("p", 111, { notifications_enabled: false })]));
  assertEquals(r, { kind: "admin", reason: "unreachable_teacher" });
});

Deno.test("route: a teacher with no profile row counts as unreachable", () => {
  const r = routeReminder("g1", new Map([["g1", ["ghost"]]]), new Map());
  assertEquals(r, { kind: "admin", reason: "unreachable_teacher" });
});

Deno.test("route: no teacher at all / no group -> admins, with the reason", () => {
  assertEquals(routeReminder("g1", new Map([["g1", []]]), new Map()), { kind: "admin", reason: "no_teacher" });
  assertEquals(routeReminder("g1", new Map(), new Map()), { kind: "admin", reason: "no_teacher" });
  assertEquals(routeReminder(null, new Map(), new Map()), { kind: "admin", reason: "no_group" });
});

Deno.test("route: two profiles on one Telegram chat get one DM", () => {
  const r = routeReminder("g1", new Map([["g1", ["p", "c"]]]), new Map([prof("p", 111), prof("c", 111)]));
  assertEquals(r.kind === "teacher" && r.recipients.length, 1);
});

const item = (i: number, over: Partial<AdminItem> = {}): AdminItem => ({
  studentName: `Student ${i}`, taskTitle: `Modul 1 · Vazifa ${i}`, groupName: "AC CHALLENGE | 1-GURUH",
  hours: 30 + i, n: 1, reason: "no_teacher", ...over,
});

Deno.test("admin digest: one message lists every submission with its group and reason", () => {
  const t = adminDigestText([item(1), item(2, { reason: "unreachable_teacher", n: 2 }), item(3, { groupName: null, reason: "no_group" })], "en");
  assert(t.includes("<b>3</b>"));
  assert(t.includes("Student 1") && t.includes("Student 2") && t.includes("Student 3"));
  // No course known → the group name stays whole.
  assert(t.includes("«AC CHALLENGE | 1-GURUH — Modul 1 · Vazifa 1» · no teacher · 31 h (1/3)"));
  assert(t.includes("teacher unreachable on Telegram · 32 h (2/3)"));
  assert(t.includes("«Modul 1 · Vazifa 3» · no group · 33 h (1/3)"));
  assert(!t.includes("more"));
});

Deno.test("admin digest: each line carries the full label (course · group · M V — title)", () => {
  const t = adminDigestText([
    item(1, { courseTitle: "AI CREATORS CHALLENGE 6.0", moduleNumber: 2, step: 1, taskTitle: "2-MODUL ERKAKLAR KO'Z OYNAGI" }),
    item(2, { courseTitle: "AI CREATORS 5.0", groupName: "2-GURUH VIP 5.0", moduleNumber: 2, step: 1, taskTitle: "2-MODUL ERKAKLAR KO'Z OYNAGI" }),
  ], "uz");
  assert(t.includes("«CH6 · 1-GURUH · M2 V1 — 2-MODUL ERKAKLAR KO'Z OYNAGI» · o'qituvchi biriktirilmagan"));
  assert(t.includes("«5.0 · 2-GURUH VIP · M2 V1 — 2-MODUL ERKAKLAR KO'Z OYNAGI»"));
});

Deno.test("teacher reminder: the label names the course and group, so 5.0 and its Challenge copy differ", () => {
  const parts = { taskTitle: "1- MODUL: PROMPT ENGINEERING", moduleNumber: 1, step: 1 };
  const a = teacherReminderText("uz", "Aziza", itemLabel({ ...parts, courseTitle: "AI CREATORS 5.0", groupName: "1-GURUH VIP 5.0" }), 26, 1);
  const b = teacherReminderText("uz", "Aziza", itemLabel({ ...parts, courseTitle: "AI CREATORS CHALLENGE 6.0", groupName: "AC CHALLENGE | 1-GURUH" }), 26, 1);
  assertEquals(a, "⏳ <b>Aziza</b>ning «5.0 · 1-GURUH VIP · M1 V1 — 1- MODUL: PROMPT ENGINEERING» topshirig'i 26 soatdan beri baholanmagan. Iltimos, baholang. (eslatma 1/3)");
  assertEquals(b, "⏳ <b>Aziza</b>ning «CH6 · 1-GURUH · M1 V1 — 1- MODUL: PROMPT ENGINEERING» topshirig'i 26 soatdan beri baholanmagan. Iltimos, baholang. (eslatma 1/3)");
});

Deno.test("teacher reminder: user text escaped; an empty label reads as —", () => {
  const t = teacherReminderText("en", "<i>x</i>", "a<b", 30, 2);
  assert(t.includes("&lt;i&gt;x&lt;/i&gt;") && t.includes("«a&lt;b»"));
  assert(teacherReminderText("ru", "", "", 30, 3).includes("«—» от <b>—</b>"));
});

Deno.test("teacher reminder: 🎯 opens THIS submission (gs:open:<id>, ≤ 64 bytes); the web link stays second", () => {
  const id = "0b7c2d4e-9f10-4a2b-8c3d-5e6f7a8b9c0d";
  for (const loc of ["uz", "ru", "en"] as const) {
    const kb = teacherReminderKeyboard(loc, id);
    const cb = (kb.inline_keyboard[0][0] as { callback_data: string }).callback_data;
    assertEquals(cb, `gs:open:${id}`);
    assert(new TextEncoder().encode(cb).length <= 64, `${cb.length} bytes`);
    assertEquals((kb.inline_keyboard[1][0] as { url: string }).url, TEACHER_URL);
  }
});

Deno.test("teacher reminder: teacher Mini App off → the keyboard is exactly today's (no app button argument = null)", () => {
  const id = "0b7c2d4e-9f10-4a2b-8c3d-5e6f7a8b9c0d";
  const today = {
    inline_keyboard: [
      [{ text: "🎯 Baholash", callback_data: `gs:open:${id}` }],
      [{ text: "🌐 Saytda ochish", url: TEACHER_URL }],
    ],
  };
  assertEquals(teacherReminderKeyboard("uz", id), today);
  assertEquals(teacherReminderKeyboard("uz", id, null, "🎤 Chatda (ovoz bilan)"), today);
});

Deno.test("teacher reminder: Mini App on → 🎯 opens the app first; in-chat flow + web page share the second row", () => {
  const id = "0b7c2d4e-9f10-4a2b-8c3d-5e6f7a8b9c0d";
  const app = { text: "🎯 Оценить", web_app: { url: `https://www.aicreator.academy/tg/teacher/grade?sub=${id}&src=teacher_hw_reminder&ref=${id}` } };
  assertEquals(teacherReminderKeyboard("ru", id, app, "🎤 В чате (голосом)"), {
    inline_keyboard: [
      [app],
      [{ text: "🎤 В чате (голосом)", callback_data: `gs:open:${id}` }, { text: "🌐 Открыть на сайте", url: TEACHER_URL }],
    ],
  });
});

Deno.test("admin digest: user text is HTML-escaped (a raw < would make Telegram reject the whole message)", () => {
  const t = adminDigestText([item(1, { studentName: "<b>x</b> & y", taskTitle: "a<b", groupName: "g>1" })], "uz");
  assert(t.includes("&lt;b&gt;x&lt;/b&gt; &amp; y"));
  assert(t.includes("a&lt;b"));
  assert(t.includes("g&gt;1"));
});

Deno.test("admin digest: a large batch is capped by lines, with a count of the rest", () => {
  const items = Array.from({ length: 150 }, (_, i) => item(i));
  const t = adminDigestText(items, "ru");
  assert(t.includes("<b>150</b>"));
  const lines = t.split("\n").filter((l) => l.startsWith("• "));
  assertEquals(lines.length, ADMIN_DIGEST_MAX_LINES);
  assert(t.includes(`… и ещё ${150 - ADMIN_DIGEST_MAX_LINES}`));
  assert(t.length <= ADMIN_DIGEST_MAX_CHARS);
});

Deno.test("admin digest: long names are clipped and the message stays under Telegram's limit", () => {
  const long = "&".repeat(500); // worst case: every char escapes to 5
  const items = Array.from({ length: 40 }, (_, i) => item(i, { studentName: long, taskTitle: long, groupName: long }));
  for (const loc of ["uz", "ru", "en"] as const) {
    const t = adminDigestText(items, loc);
    assert(t.length <= ADMIN_DIGEST_MAX_CHARS, `${loc}: ${t.length}`);
    assert(t.split("\n").some((l) => l.startsWith("… ")));
  }
});

Deno.test("admin digest: clipping never splits an emoji into a lone surrogate", () => {
  const face = "\u{1F600}";
  const t = adminDigestText([item(1, { studentName: face.repeat(60) })], "en");
  assert(t.includes(face.repeat(39) + "…"));
  assert(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(t));
});
