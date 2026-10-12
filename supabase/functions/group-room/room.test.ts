import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CAPTION_MAX, captionLength, dayActions, type DayStats, imageUrl, isQuiet, renderEvening, renderMorning, runOnce, starName,
} from "./room.ts";
import { EVENING_OPENERS, QUIET_OPENERS } from "./texts.ts";

type Row = Record<string, any>;
const MORNING = Date.parse("2026-10-12T04:00:00Z"); // Monday 09:00 Tashkent
const EVENING = Date.parse("2026-10-12T16:00:00Z"); // Monday 21:00 Tashkent
const DAY = 86_400_000;
// 1-GURUH's real 2026-10-11
const BUSY: DayStats = {
  students: 56, lessons: 47, homework: 13, answered: 14, active: 31,
  stars: [{ name: "Dilnoza", last_name: "K", username: "dil_k", score: 9 }, { name: "A.", last_name: null, username: "ali_ai", score: 7 },
          { name: null, last_name: null, username: null, score: 5 }],
};

Deno.test("every caption fits Telegram's 1,024-character limit — every rotation, the longest names", () => {
  const long = "Muhammadabdulla".repeat(3);
  const worst: DayStats = { students: 99999, lessons: 99999, homework: 99999, answered: 99999, active: 99999,
    stars: [1, 2, 3].map(() => ({ name: long, last_name: long, username: long, score: 1 })) };
  for (let d = 0; d < 60; d++) {
    assert(captionLength(renderMorning(MORNING + d * DAY)) <= CAPTION_MAX, `morning +${d}`);
    assert(captionLength(renderEvening(worst, EVENING + d * DAY)) <= CAPTION_MAX, `evening +${d}`);
    assert(captionLength(renderEvening({ ...worst, active: 0, lessons: 0, homework: 0 }, EVENING + d * DAY)) <= CAPTION_MAX);
  }
});

Deno.test("morning: greeting, the weekday line, three different actions, a closing", () => {
  const t = renderMorning(MORNING);
  assertStringIncludes(t, "Yangi hafta muborak!");                 // Monday
  assertStringIncludes(t, "👇 <b>Bugun nima qilamiz?</b>");
  for (let d = 0; d < 30; d++) assertEquals(new Set(dayActions(20000 + d)).size, 3);
  assert(renderMorning(MORNING) !== renderMorning(MORNING + DAY), "two days in a row differ");
});

Deno.test("evening: the group's real day, zeros left out, the day's most active by first name or @username", () => {
  const t = renderEvening(BUSY, EVENING);
  assert(EVENING_OPENERS.some((o) => t.includes(o.head)));
  assertStringIncludes(t, "📚 <b>47</b> ta dars koʻrildi");
  assertStringIncludes(t, "📝 <b>13</b> ta uyga vazifa topshirildi");
  assertStringIncludes(t, "💬 <b>14</b> ta savolga javob berildi");
  assertStringIncludes(t, "🙌 <b>31</b> kishi faol boʻldi");
  assertStringIncludes(t, "🌟 Bugungi eng faollar: <b>Dilnoza</b>, <b>@ali_ai</b> — barakalla!"); // initials → @; nameless dropped
  const noAnswers = renderEvening({ ...BUSY, answered: 0 }, EVENING);
  assert(!noAnswers.includes("savolga javob"), "a zero is left out");
  assertEquals(starName({ name: "<b>x</b>Ali", last_name: null, username: null, score: 1 }), "&lt;b&gt;x&lt;/b&gt;Ali");
});

Deno.test("a quiet day is thanked and encouraged — never called spectacular", () => {
  const quiet: DayStats = { students: 3, lessons: 1, homework: 0, answered: 0, active: 1, stars: [] };
  assert(isQuiet(quiet));
  const t = renderEvening(quiet, EVENING);
  assert(QUIET_OPENERS.some((o) => t.includes(o.head)));
  assert(!t.includes("Bugun guruhimizda") && !t.includes("ajoyib kun"));
  assert(!isQuiet({ ...quiet, active: 5 }));
});

Deno.test("image URL: the weekday's picture for the kind", () => {
  assertEquals(imageUrl("https://www.aicreator.academy/group-room/", "morning", MORNING),
    "https://www.aicreator.academy/group-room/morning-1.jpg?v=1");
  assertEquals(imageUrl("https://x/group-room", "evening", EVENING + 6 * DAY), "https://x/group-room/evening-0.jpg?v=1");
});

// ── runOnce with fakes ──────────────────────────────────────────────────────────────────────────────────────────
function world(o: { photoFails?: string[]; photoStatus?: number; claimed?: Record<string, boolean>; enabled?: boolean; now?: number } = {}) {
  const sent: Array<{ method: string; payload: Row }> = [];
  const updates: Row[] = [];
  const health: Row[] = [];
  const targets = [
    { group_id: "g1", group_name: "AC CHALLENGE | 1-GURUH", chat_id: -1004440955972, thread_id: 4, students: 56, ready: true },
    { group_id: "g2", group_name: "AC CHALLENGE | 2-GURUH", chat_id: -1004390902020, thread_id: 8, students: 50, ready: true },
    { group_id: "g5", group_name: "AC CHALLENGE | 5-GURUH", chat_id: -1004396568866, thread_id: null, students: 3, ready: false },
    { group_id: "g6", group_name: "AC CHALLENGE | 6-GURUH", chat_id: -1004423411304, thread_id: 10, students: 0, ready: true },
  ];
  const from = (table: string) => {
    let patch: Row | null = null;
    const b: any = {
      select: () => b, eq: () => b,
      update: (p: Row) => { patch = p; return b; },
      insert: (p: Row) => { if (table === "admin_actions") health.push(p); return Promise.resolve({ error: null }); },
      maybeSingle: () => Promise.resolve({ data: table === "platform_settings"
        ? { value: { enabled: o.enabled ?? true, image_base: "https://www.aicreator.academy/group-room" } } : null, error: null }),
      then: (res: any) => { if (patch) updates.push({ table, ...patch }); patch = null; return res({ data: [], error: null }); },
    };
    return b;
  };
  const rpc = (fn: string, args: Row) => {
    if (fn === "group_room_targets") return Promise.resolve({ data: targets, error: null });
    if (fn === "group_room_claim") return Promise.resolve({ data: o.claimed?.[args._group] ?? true, error: null });
    if (fn === "group_room_stats") return Promise.resolve({ data: BUSY, error: null });
    return Promise.resolve({ data: null, error: null });
  };
  const send = (method: string, payload: Row) => {
    sent.push({ method, payload });
    if (method === "sendPhoto" && o.photoFails?.includes(String(payload.chat_id))) {
      const status = o.photoStatus ?? 400;
      return Promise.resolve({ ok: false, result: null, status,
        error: status ? "Bad Request: wrong file identifier/HTTP URL specified" : "transport_error" });
    }
    return Promise.resolve({ ok: true, result: { message_id: 500 + sent.length }, error: null });
  };
  return { io: { admin: { from, rpc }, send, now: () => o.now ?? EVENING }, sent, updates, health };
}

Deno.test("runOnce: one image post per ready group in its NETWORKING topic; topic-less and empty groups skipped and recorded", async () => {
  const w = world();
  const out = await runOnce(w.io, "evening");
  assertEquals([out.status, out.sent], ["ok", 2]);
  assertEquals(w.sent.map((s) => [s.method, s.payload.chat_id, s.payload.message_thread_id]),
    [["sendPhoto", -1004440955972, 4], ["sendPhoto", -1004390902020, 8]]);
  assertEquals(w.sent[0].payload.photo, "https://www.aicreator.academy/group-room/evening-1.jpg?v=1");
  assertStringIncludes(String(w.sent[0].payload.caption), "📚 <b>47</b> ta dars koʻrildi");
  assertEquals((out.skipped as string[]).length, 2);
  const run = w.health.find((h) => h.action === "group_room_run");
  assert(run && JSON.stringify(run.details).includes("no NETWORKING topic"));
  assert(w.updates.every((u) => u.error === null && u.message_id && u.sent_at));
});

Deno.test("runOnce: a refused photo still delivers the words as text, logged; a claimed post is never sent twice", async () => {
  const w = world({ photoFails: ["-1004440955972"], claimed: { g2: false }, now: MORNING });
  const out = await runOnce(w.io, "morning");
  assertEquals([out.sent, out.as_text, out.already], [1, 1, 1]);
  assertEquals(w.sent.map((s) => s.method), ["sendPhoto", "sendMessage"]);
  assert(w.health.some((h) => h.action === "group_room_photo_fallback"));
  assert(w.updates.some((u) => u.as_text === true));
});

Deno.test("runOnce: the kill-switch stops everything", async () => {
  const w = world({ enabled: false });
  assertEquals((await runOnce(w.io, "morning")).status, "disabled");
  assertEquals(w.sent.length, 0);
});

Deno.test("runOnce: a transport error is ambiguous — no text fallback (no duplicate), the row keeps the error for the :20 retry", async () => {
  const w = world({ photoFails: ["-1004440955972"], photoStatus: 0 });
  const out = await runOnce(w.io, "evening");
  assertEquals([out.sent, out.as_text], [1, 0]);
  assertEquals(w.sent.filter((s) => s.method === "sendMessage").length, 0);
  assert(w.updates.some((u) => String(u.error ?? "").includes("transport_error") && !u.sent_at));
});

Deno.test("runOnce: only inside the post's own hour — a morning call at 21:00 posts nothing (unless forced)", async () => {
  const w = world();
  assertEquals((await runOnce(w.io, "morning")).status, "out_of_window");
  assertEquals(w.sent.length, 0);
  assert(w.health.some((h) => h.action === "group_room_out_of_window"));
  const f = world();
  assertEquals((await runOnce(f.io, "morning", { force: true })).sent, 2);
});
