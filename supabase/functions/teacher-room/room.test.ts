import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { curatorName, type GroupStat, renderEvening, renderMorning, runOnce, tashkentDate, tashkentMidnight } from "./room.ts";
import { EVENING_OPENERS, MORNING_OPENERS, pick, tashkentDayNumber } from "./texts.ts";

type Row = Record<string, any>;
const NOW = Date.parse("2026-10-11T16:00:00Z"); // Sunday 21:00 Tashkent
const g = (name: string, t: Partial<GroupStat["teachers"][number]>, x: Partial<GroupStat>): GroupStat => ({
  group_id: name, group_name: `AC CHALLENGE | ${name}`, teachers: [{ id: name, name: null, last_name: null, username: null, ...t }],
  graded: 0, submitted: 0, pending: 0, asked: 0, answered: 0, open: 0, oldest_min: 0, median_min: null, ...x,
});
// yesterday's real numbers (2026-10-10)
export const SAMPLE: GroupStat[] = [
  g("1-GURUH", { name: "Rano", username: "Rano_suvonqulovna" }, { graded: 21, submitted: 8, pending: 8, asked: 10, answered: 10, open: 0, median_min: 6.2 }),
  g("2-GURUH", { name: "Gulhayo", username: "gulhayoaxtamovna" }, { graded: 15, submitted: 9, pending: 1, asked: 2, answered: 1, open: 0, median_min: 14 }),
  g("3-GURUH", { name: "Feruza", username: "peluja_ai" }, { graded: 41, submitted: 15, pending: 12, asked: 11, answered: 5, open: 7, oldest_min: 190, median_min: 2.9 }),
  g("4-GURUH", { name: "Н.", username: "nigorakm" }, { graded: 10, submitted: 8, pending: 1, asked: 31, answered: 23, open: 8, oldest_min: 75, median_min: 4.1 }),
];

Deno.test("evening: per-curator numbers, team total, the day's star and the fastest answers; zeros are never singled out", () => {
  const t = renderEvening(SAMPLE, NOW);
  assertStringIncludes(t, "<b>Feruza</b> · 3-GURUH");
  assertStringIncludes(t, "✅ Baholandi: <b>41</b> ta vazifa");
  assertStringIncludes(t, "💬 Javob berildi: <b>5</b> ta savol (oʻrtacha 3 daqiqa)");
  assertStringIncludes(t, "⏳ Ertaga: 12 ta vazifa · 7 ta savol");
  assertStringIncludes(t, "🤝 Jamoa boʻlib bugun: <b>87</b> ta vazifa va <b>39</b> ta savol");
  assertStringIncludes(t, "🏆 Kun yulduzi: <b>Feruza</b> — 41 ta vazifa");
  assertStringIncludes(t, "🏅 <b>Kun qahramonlari</b>");
  assertStringIncludes(t, "⚡ Eng tez javoblar: <b>Feruza</b>");
  assertStringIncludes(t, "💬 Eng koʻp javob: <b>@nigorakm</b> — 23 ta savol");
  assertStringIncludes(t, "<b>@nigorakm</b> · 4-GURUH");          // initials only → the @username
  const quiet = renderEvening([g("5-GURUH", { name: "Ali" }, {})], NOW);
  assertStringIncludes(quiet, "✅ Baholandi: <b>0</b> ta vazifa");
  assert(!quiet.includes("Kun yulduzi") && !quiet.includes("Eng tez"));
  assert(t.length < 4096);
});

Deno.test("morning: greeting, yesterday's team result, today's queue per group, the longest wait", () => {
  const t = renderMorning(SAMPLE, NOW);
  assertStringIncludes(t, "Yakshanba");                              // a Sunday line
  assertStringIncludes(t, "📊 <b>Kechagi natija</b>\n✅ 87 ta vazifa baholandi\n💬 39 ta savolga javob berildi");
  assertStringIncludes(t, "• 3-GURUH · Feruza — 12 ta vazifa · 7 ta savol");
  assertStringIncludes(t, "⏳ Eng uzoq kutayotgan savol: <b>3 soat</b>");
  const empty = renderMorning([g("1-GURUH", { name: "Rano" }, {})], NOW);
  assertStringIncludes(empty, "Navbat boʻsh");
  assert(!empty.includes("Kechagi natija"));
});

Deno.test("two days in a row never open the same way; names and group names are escaped", () => {
  const d = tashkentDayNumber(NOW);
  for (let i = 0; i < 30; i++) {
    assert(pick(MORNING_OPENERS, d + i).head + pick(MORNING_OPENERS, d + i).body !== pick(MORNING_OPENERS, d + i + 1).head + pick(MORNING_OPENERS, d + i + 1).body);
    assert(pick(EVENING_OPENERS, d + i).body !== pick(EVENING_OPENERS, d + i + 1).body);
  }
  assertEquals(curatorName(g("x", { name: "<b>Ali</b>" }, {})), "&lt;b&gt;Ali&lt;/b&gt;");
  assertEquals(curatorName(g("x", { name: null, username: null }, {})), "Ustoz");
  assertEquals(tashkentDate(Date.parse("2026-10-11T19:30:00Z")), "2026-10-12");              // 00:30 Tashkent
  assertEquals(tashkentMidnight(NOW).toISOString(), "2026-10-10T19:00:00.000Z");
  assertEquals(tashkentMidnight(NOW, -1).toISOString(), "2026-10-09T19:00:00.000Z");
});

function world(o: { claimed?: boolean; cfg?: Row | null; failSend?: boolean } = {}) {
  const sent: Row[] = [];
  const updates: Row[] = [];
  const actions: Row[] = [];
  const rpcs: Row[] = [];
  const from = (table: string) => {
    let patch: Row | null = null;
    const b: any = {
      select: () => b, eq: () => b,
      update: (p: Row) => { patch = p; return b; },
      insert: (p: Row) => { if (table === "admin_actions") actions.push(p); return Promise.resolve({ error: null }); },
      maybeSingle: () => Promise.resolve({ data: o.cfg === null ? null : { value: o.cfg ?? { enabled: true, chat_id: -1004449580466 } }, error: null }),
      then: (res: any) => { if (patch) updates.push({ table, patch }); return res({ error: null }); },
    };
    return b;
  };
  const rpc = (fn: string, args: Row) => {
    rpcs.push({ fn, args });
    if (fn === "teacher_room_claim") return Promise.resolve({ data: o.claimed ?? true, error: null });
    if (fn === "teacher_room_stats") return Promise.resolve({ data: SAMPLE, error: null });
    return Promise.resolve({ data: null, error: null });
  };
  const send = (_m: string, p: Row) => {
    sent.push(p);
    return Promise.resolve(o.failSend ? { ok: false, result: null, error: "Forbidden: bot was kicked" } : { ok: true, result: { message_id: 77 }, error: null });
  };
  return { admin: { from, rpc }, send, sent, updates, actions, rpcs };
}

Deno.test("runOnce: claims the day once, uses the right window, records the message", async () => {
  const w = world();
  const out = await runOnce({ admin: w.admin, send: w.send, now: () => NOW }, "evening");
  assertEquals(out.status, "ok");
  assertEquals(w.sent[0].chat_id, -1004449580466);
  assertEquals(w.sent[0].parse_mode, "HTML");
  const stats = w.rpcs.find((r) => r.fn === "teacher_room_stats")!;
  assertEquals(stats.args._from, "2026-10-10T19:00:00.000Z");            // today 00:00 Tashkent
  assertEquals(w.updates.at(-1)!.patch.message_id, 77);

  const m = world();
  await runOnce({ admin: m.admin, send: m.send, now: () => NOW }, "morning");
  const ms = m.rpcs.find((r) => r.fn === "teacher_room_stats")!;
  assertEquals([ms.args._from, ms.args._to], ["2026-10-09T19:00:00.000Z", "2026-10-10T19:00:00.000Z"]);   // yesterday
});

Deno.test("runOnce: already sent today → nothing; switched off → nothing; a failed send is recorded and DB-visible", async () => {
  const a = world({ claimed: false });
  assertEquals((await runOnce({ admin: a.admin, send: a.send, now: () => NOW }, "morning")).status, "already");
  assertEquals(a.sent.length, 0);
  const off = world({ cfg: { enabled: false, chat_id: -1 } });
  assertEquals((await runOnce({ admin: off.admin, send: off.send, now: () => NOW }, "morning")).status, "disabled");
  const f = world({ failSend: true });
  assertEquals((await runOnce({ admin: f.admin, send: f.send, now: () => NOW }, "evening")).status, "send_failed");
  assertStringIncludes(f.updates.at(-1)!.patch.error, "kicked");
  assert(f.actions.some((x) => x.action === "teacher_room_post_failed"));
});
