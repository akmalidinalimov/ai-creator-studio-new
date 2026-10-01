// Pins the watch-button decision table (private / group × flag on / off × base valid / invalid), the fail-closed
// flag reader, and the rejection fallback. Run: deno test supabase/functions/_shared/miniapp-button.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _resetStudentMiniAppFlagCache,
  BUTTON_FAULT_ACTIONS,
  DEFAULT_MINIAPP_BASE,
  hasWebAppButton,
  isTeacherAppPath,
  isWatchContentRejection,
  loadStudentMiniAppFlag,
  newButtonTally,
  normMiniAppBase,
  parseStudentMiniAppFlag,
  sendWithWatchFallback,
  tallyButton,
  watchButton,
  webAppAudience,
  type WatchFlag,
} from "./miniapp-button.ts";

const C = "0b6f4e1c-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
const REF = "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";
const ON: WatchFlag = { on: true, watch: true };
const OFF: WatchFlag = { on: false, watch: false };
const WATCH_OFF: WatchFlag = { on: true, watch: false };

/** A fake service-role client that records admin_actions inserts (for the health signals). */
function fakeAdmin() {
  const inserts: Array<{ table: string; row: any }> = [];
  const admin = {
    inserts,
    from(table: string) {
      const q: any = {
        select: () => q, eq: () => q, gte: () => q, limit: () => Promise.resolve({ data: [], error: null }),
        insert: (row: any) => { inserts.push({ table, row }); return Promise.resolve({ error: null }); },
      };
      return q;
    },
  };
  return admin;
}

function magic() {
  const calls: string[] = [];
  const fn = (p: string) => { calls.push(p); return Promise.resolve({ url: `https://aicreator.academy/auth/magic?t=tok-${calls.length}`, token: `tok-${calls.length}` }); };
  return { calls, fn };
}

const priv = (flag: WatchFlag, extra: Record<string, unknown> = {}) => ({
  chat: "private" as const, text: "▶️ Davom", flag, fn: "test",
  miniPath: `/continue/${C}`, legacyPath: `/lesson/${C}/x`, track: { src: "daily_reminder" as const, ref: REF }, ...extra,
});

Deno.test("private + flag on → web_app to the Mini App path, tracked", async () => {
  const m = magic();
  const r = await watchButton({ ...priv(ON), magicLink: m.fn });
  assertEquals(r.mode, "web_app");
  assertEquals(r.reason, "ok");
  assertEquals(r.button, { text: "▶️ Davom", web_app: { url: `${DEFAULT_MINIAPP_BASE}/continue/${C}?src=daily_reminder&ref=${REF}` } });
  assertEquals(m.calls.length, 0); // no magic-link row is written on the web_app path
});

Deno.test("private + flag off → today's magic link, byte-identical, with its token", async () => {
  const m = magic();
  const r = await watchButton({ ...priv(OFF), magicLink: m.fn });
  assertEquals(r.mode, "magic_link");
  assertEquals(r.reason, "flag_off");
  assertEquals(r.button, { text: "▶️ Davom", url: "https://aicreator.academy/auth/magic?t=tok-1" });
  assertEquals(r.token, "tok-1");
  assertEquals(m.calls, [`/lesson/${C}/x`]);
});

Deno.test("private + watch_buttons off → magic link (reason watch_off)", async () => {
  const m = magic();
  const r = await watchButton({ ...priv(WATCH_OFF), magicLink: (p: string) => m.fn(p).then((x) => x.url) });
  assertEquals([r.mode, r.reason], ["magic_link", "watch_off"]);
  assertEquals(r.token, null);
});

Deno.test("private + bad base ('' and 'http://') → magic link + a bad_base health row", async () => {
  for (const base of ["", "http://www.aicreator.academy", "https://evil.com/path", "javascript:alert(1)"]) {
    const admin = fakeAdmin();
    const m = magic();
    const r = await watchButton({ ...priv(ON), base, admin, fn: `bb${base.length}`, magicLink: m.fn });
    assertEquals([r.mode, r.reason], ["magic_link", "bad_base"], base);
    assertEquals(m.calls.length, 1);
    const row = admin.inserts.find((i) => i.row.action === "miniapp_button_fallback");
    assert(row, `health row for ${JSON.stringify(base)}`);
    assertEquals(row!.row.details.dedupe_key, `bad_base:bb${base.length}`);
  }
});

Deno.test("private + flag off and no fallback → no button (teacher-nudge's today)", async () => {
  const r = await watchButton(priv(OFF));
  assertEquals([r.button, r.mode, r.reason], [null, "none", "flag_off"]);
});

Deno.test("private: a failing fallback is 'no_fallback', never a throw", async () => {
  const r = await watchButton({ ...priv(OFF), magicLink: () => Promise.reject(new Error("insert failed")) });
  assertEquals([r.button, r.mode, r.reason], [null, "none", "no_fallback"]);
});

Deno.test("group + flag on → the named Mini App direct link with a start_param", async () => {
  const r = await watchButton({
    chat: "group", text: "📺 Bugungi dars", flag: ON, fn: "daily-tasks",
    start: { courseId: C }, track: { src: "daily_task" },
  });
  assertEquals(r.mode, "startapp");
  assertEquals(r.button, { text: "📺 Bugungi dars", url: `https://t.me/aicreatorsdarsliklari_bot/app?startapp=c_${C}__daily_task` });
});

Deno.test("group + flag off → none, and a magic link is NEVER called", async () => {
  let called = 0;
  const opts = {
    chat: "group", text: "x", flag: OFF, fn: "t", start: "continue", track: { src: "daily_task" },
    magicLink: () => { called++; return Promise.resolve("https://aicreator.academy/auth/magic?t=LEAK"); },
    legacyPath: "/dashboard",
  };
  // deno-lint-ignore no-explicit-any
  const r = await watchButton(opts as any); // the types forbid magicLink for a group; a JS caller cannot sneak one in
  assertEquals([r.button, r.mode, r.reason], [null, "none", "group_flag_off"]);
  assertEquals(called, 0);
  // …and with the flag ON it is a startapp link, still never the magic link.
  // deno-lint-ignore no-explicit-any
  const r2 = await watchButton({ ...opts, flag: ON } as any);
  assertEquals(r2.mode, "startapp");
  assertEquals(called, 0);
});

Deno.test("group + malformed direct link → none + bad_base", async () => {
  const admin = fakeAdmin();
  const r = await watchButton({ chat: "group", text: "x", flag: ON, fn: "g", admin, start: "continue", track: { src: "daily_task" }, direct: "https://evil.com/app" });
  assertEquals([r.button, r.mode, r.reason], [null, "none", "bad_base"]);
  assertEquals(admin.inserts.length, 1);
});

Deno.test("normMiniAppBase", () => {
  assertEquals(normMiniAppBase("https://www.aicreator.academy/"), "https://www.aicreator.academy");
  assertEquals(normMiniAppBase(""), null);
  assertEquals(normMiniAppBase("http://www.aicreator.academy"), null);
  assertEquals(normMiniAppBase("https://www.aicreator.academy/x"), null);
});

Deno.test("flag parser: only a literal enabled:true; watch_buttons absent = on", () => {
  assertEquals(parseStudentMiniAppFlag({ enabled: true }), { on: true, watch: true });
  assertEquals(parseStudentMiniAppFlag({ enabled: true, watch_buttons: false }), { on: true, watch: false });
  assertEquals(parseStudentMiniAppFlag({ enabled: true, watch_buttons: "false" }), { on: true, watch: true });
  assertEquals(parseStudentMiniAppFlag({ enabled: "true" }), OFF);
  assertEquals(parseStudentMiniAppFlag({ enabled: false, watch_buttons: true }), OFF);
  assertEquals(parseStudentMiniAppFlag(null), OFF);
  assertEquals(parseStudentMiniAppFlag("true"), OFF);
});

function flagAdmin(result: { data?: unknown; error?: unknown; throws?: boolean }) {
  let reads = 0;
  return {
    get reads() { return reads; },
    from() {
      const q: any = {
        select: () => q, eq: () => q,
        maybeSingle: () => { reads++; if (result.throws) throw new Error("boom"); return Promise.resolve({ data: result.data ?? null, error: result.error ?? null }); },
      };
      return q;
    },
  };
}

Deno.test("flag reader: absent row, {enabled:'true'} and a read error are all OFF (fail-closed)", async () => {
  _resetStudentMiniAppFlagCache();
  assertEquals(await loadStudentMiniAppFlag(flagAdmin({ data: null }), 1_000), OFF);
  _resetStudentMiniAppFlagCache();
  assertEquals(await loadStudentMiniAppFlag(flagAdmin({ data: { value: { enabled: "true" } } }), 1_000), OFF);
  _resetStudentMiniAppFlagCache();
  assertEquals(await loadStudentMiniAppFlag(flagAdmin({ error: { message: "db down" } }), 1_000), OFF);
  _resetStudentMiniAppFlagCache();
  assertEquals(await loadStudentMiniAppFlag(flagAdmin({ throws: true }), 1_000), OFF);
  _resetStudentMiniAppFlagCache();
});

Deno.test("flag reader caches 60 s; a read error is not cached", async () => {
  _resetStudentMiniAppFlagCache();
  const a = flagAdmin({ data: { value: { enabled: true } } });
  assertEquals(await loadStudentMiniAppFlag(a, 10_000), ON);
  assertEquals(await loadStudentMiniAppFlag(a, 69_000), ON);
  assertEquals(a.reads, 1);
  assertEquals(await loadStudentMiniAppFlag(a, 70_001), ON);
  assertEquals(a.reads, 2);
  _resetStudentMiniAppFlagCache();
  const bad = flagAdmin({ error: { message: "x" } });
  await loadStudentMiniAppFlag(bad, 1);
  await loadStudentMiniAppFlag(bad, 2);
  assertEquals(bad.reads, 2);
  _resetStudentMiniAppFlagCache();
});

Deno.test("tally counts modes and non-ok reasons", () => {
  const t = newButtonTally();
  tallyButton(t, { mode: "web_app", reason: "ok" });
  tallyButton(t, { mode: "magic_link", reason: "flag_off" });
  tallyButton(t, { mode: "magic_link", reason: "flag_off" });
  assertEquals(t.web_app, 1);
  assertEquals(t.magic_link, 2);
  assertEquals(t.reasons, { flag_off: 2 });
});

// ─────────────────────────── sendWithWatchFallback ───────────────────────────
const webAppPayload = { chat_id: 1, text: "hi", reply_markup: { inline_keyboard: [[{ text: "a", web_app: { url: "https://www.aicreator.academy/continue" } }]] } };
const magicPayload = { chat_id: 1, text: "hi", reply_markup: { inline_keyboard: [[{ text: "a", url: "https://aicreator.academy/auth/magic?t=x" }]] } };

function sender(outcomes: Array<{ ok: boolean; status: number; error: string | null }>) {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    send: (p: Record<string, unknown>) => { sent.push(p); return Promise.resolve(outcomes[sent.length - 1]); },
  };
}

Deno.test("a content rejection of a web_app button resends ONCE with the rebuilt payload + alarms", async () => {
  const admin = fakeAdmin();
  const s = sender([
    { ok: false, status: 400, error: "Bad Request: BUTTON_TYPE_INVALID" },
    { ok: true, status: 200, error: null },
  ]);
  const { result, retried } = await sendWithWatchFallback(s.send, webAppPayload, () => Promise.resolve(magicPayload), { fn: "t1", admin });
  assertEquals(retried, true);
  assertEquals(result.ok, true);
  assertEquals(s.sent, [webAppPayload, magicPayload]);
  assertEquals(admin.inserts.filter((i) => i.row.action === "miniapp_button_rejected").length, 1);
});

Deno.test("a recipient error is NOT resent (blocked / never started)", async () => {
  for (const error of ["Forbidden: bot was blocked by the user", "Bad Request: chat not found"]) {
    const s = sender([{ ok: false, status: error.startsWith("Forbidden") ? 403 : 400, error }]);
    const { retried } = await sendWithWatchFallback(s.send, webAppPayload, () => Promise.resolve(magicPayload), { fn: "t2" });
    assertEquals(retried, false, error);
    assertEquals(s.sent.length, 1);
  }
});

Deno.test("transient errors and payloads without a web_app button are not resent", async () => {
  const s1 = sender([{ ok: false, status: 429, error: "Too Many Requests: retry after 3" }]);
  assertEquals((await sendWithWatchFallback(s1.send, webAppPayload, () => Promise.resolve(magicPayload), { fn: "t3" })).retried, false);
  const s2 = sender([{ ok: false, status: 400, error: "Bad Request: can't parse entities" }]);
  assertEquals((await sendWithWatchFallback(s2.send, magicPayload, () => Promise.resolve(magicPayload), { fn: "t4" })).retried, false);
  const s3 = sender([{ ok: false, status: 400, error: "Bad Request: BUTTON_TYPE_INVALID" }]);
  assertEquals((await sendWithWatchFallback(s3.send, webAppPayload, () => Promise.resolve(null), { fn: "t5" })).retried, false);
  assertEquals(s3.sent.length, 1);
});

Deno.test("hasWebAppButton / isWatchContentRejection", () => {
  assertEquals(hasWebAppButton(webAppPayload.reply_markup), true);
  assertEquals(hasWebAppButton(magicPayload.reply_markup), false);
  assertEquals(hasWebAppButton(undefined), false);
  assertEquals(isWatchContentRejection({ ok: false, status: 400, error: "Bad Request: BUTTON_URL_INVALID" }), true);
  assertEquals(isWatchContentRejection({ ok: false, status: 400, error: "Bad Request: chat not found" }), false);
  assertEquals(isWatchContentRejection({ ok: false, status: 0, error: "transport_error" }), false);
  assertEquals(isWatchContentRejection({ ok: true, status: 200, error: null }), false);
});

// ─────────────────────────── whose button (teacher faults stay out of the student alarm) ───────────────────────────
// watch_button_health() sums every 'miniapp_button_fallback' / 'miniapp_button_rejected' row, for ANY fn, into the
// STUDENT watch-button alarm. A button into the teacher Mini App (/tg/teacher…) must file its faults elsewhere —
// derived from the button's own path, so no sender can forget to say so.
const teacherPayload = { chat_id: 1, text: "hi", reply_markup: { inline_keyboard: [
  [{ text: "🎯", web_app: { url: `${DEFAULT_MINIAPP_BASE}/tg/teacher/grade?sub=${REF}&src=teacher_hw_dm&ref=${REF}` } }],
  [{ text: "🎤", callback_data: `grade:open:${REF}` }],
  [{ text: "📌", url: "https://t.me/c/1/2" }],
] } };

Deno.test("isTeacherAppPath: the teacher Mini App and nothing that merely starts like it", () => {
  for (const p of ["/tg/teacher", "/tg/teacher/grade", `/tg/teacher/grade?sub=${REF}`, "/tg/teacher?src=teacher_card"]) {
    assertEquals(isTeacherAppPath(p), true, p);
  }
  for (const p of ["/tg/teachers", "/tg/teacherx/grade", "/tg", "/continue", "/dashboard", "", null, undefined, "tg/teacher"]) {
    assertEquals(isTeacherAppPath(p), false, String(p));
  }
});

Deno.test("webAppAudience: teacher only when EVERY web_app button opens /tg/teacher; doubt is student", () => {
  assertEquals(webAppAudience(teacherPayload.reply_markup), "teacher");
  assertEquals(webAppAudience(webAppPayload.reply_markup), "student");
  const mixed = { inline_keyboard: [...teacherPayload.reply_markup.inline_keyboard, ...webAppPayload.reply_markup.inline_keyboard] };
  assertEquals(webAppAudience(mixed), "student"); // a mixed keyboard still raises the student alarm
  assertEquals(webAppAudience({ inline_keyboard: [[{ text: "x", web_app: { url: "not a url" } }]] }), "student");
  assertEquals(webAppAudience({ inline_keyboard: [[{ text: "x", web_app: { url: `${DEFAULT_MINIAPP_BASE}/tg/teachers` } }]] }), "student");
  assertEquals(webAppAudience(magicPayload.reply_markup), "student");
  assertEquals(webAppAudience(undefined), "student");
});

Deno.test("a rejected TEACHER web_app button → teacher_miniapp_button_rejected, never the student alarm's row", async () => {
  const admin = fakeAdmin();
  const s = sender([{ ok: false, status: 400, error: "Bad Request: BUTTON_TYPE_INVALID" }, { ok: true, status: 200, error: null }]);
  const { retried } = await sendWithWatchFallback(s.send, teacherPayload, () => Promise.resolve(magicPayload), { fn: "telegram-bot-webhook", admin });
  assertEquals(retried, true);
  assertEquals(admin.inserts.map((i) => i.row.action), [BUTTON_FAULT_ACTIONS.teacher.rejected]);
  assertEquals(BUTTON_FAULT_ACTIONS.teacher.rejected, "teacher_miniapp_button_rejected");
  // …and a STUDENT rejection in the same function the same day still writes its own row (separate dedupe space).
  const s2 = sender([{ ok: false, status: 400, error: "Bad Request: BUTTON_TYPE_INVALID" }, { ok: true, status: 200, error: null }]);
  await sendWithWatchFallback(s2.send, webAppPayload, () => Promise.resolve(magicPayload), { fn: "telegram-bot-webhook", admin });
  assertEquals(admin.inserts.map((i) => i.row.action), ["teacher_miniapp_button_rejected", "miniapp_button_rejected"]);
});

Deno.test("a bad base on a TEACHER path → teacher_miniapp_button_fallback; a student path keeps miniapp_button_fallback", async () => {
  const t = fakeAdmin();
  const r = await watchButton({ ...priv(ON), miniPath: "/tg/teacher/grade", legacyPath: "/tg/teacher/grade", base: "", admin: t, fn: "bbt" });
  assertEquals([r.button, r.reason], [null, "bad_base"]);
  assertEquals(t.inserts.map((i) => i.row.action), ["teacher_miniapp_button_fallback"]);
  const s = fakeAdmin();
  await watchButton({ ...priv(ON), base: "", admin: s, fn: "bbs" });
  assertEquals(s.inserts.map((i) => i.row.action), ["miniapp_button_fallback"]);
});
