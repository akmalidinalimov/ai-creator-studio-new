// Tests for the ungraded-reminder routing + admin digest. Run: deno test supabase/functions/cron-ungraded-homework-reminder/route.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ADMIN_DIGEST_MAX_CHARS,
  ADMIN_DIGEST_MAX_LINES,
  type AdminItem,
  adminDigestText,
  routeReminder,
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
  assert(t.includes("AC CHALLENGE | 1-GURUH · no teacher · 31 h (1/3)"));
  assert(t.includes("teacher unreachable on Telegram · 32 h (2/3)"));
  assert(t.includes("«Modul 1 · Vazifa 3» · no group · 33 h (1/3)"));
  assert(!t.includes("more"));
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
