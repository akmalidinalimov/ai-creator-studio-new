import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runOnce } from "./reminder.ts";
import {
  bucketizeTq, messageLink, parseTqCallback, renderTqDigest, renderTqList, renderTqSummary, tqCard, tqCardKeyboard,
  tqQuietHour, type TqRow, tqSettingsOf,
} from "../_shared/teacher-questions.ts";

type Row = Record<string, any>;
const NOW = Date.parse("2026-10-10T07:00:00Z"); // 12:00 Tashkent
const G1 = "11111111-1111-4111-8111-111111111111", G2 = "22222222-2222-4222-8222-222222222222";
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const q = (id: number, min: number, extra: Partial<TqRow> = {}): TqRow => ({
  id, group_id: G1, chat_id: -1004440955972, thread_id: 2, tg_user_id: 7000 + id, student_id: `s${id}`,
  student_name: `Talaba ${id}`, student_username: `t${id}`, first_message_id: 100 + id, message_ids: [100 + id],
  text: `savol ${id}?`, media: [], peer_reply_ids: [], asked_at: ago(min), status: "open", reminder_count: 0, ...extra,
});

function world(o: { due: TqRow[]; teachers?: Row[]; failSends?: boolean; cfg?: Row }) {
  const sent: Array<{ method: string; payload: Row }> = [];
  const actions: Row[] = [];
  const unclaimed: number[][] = [];
  const from = (table: string) => {
    const b: any = {
      select: () => b, eq: () => b, in: () => b, not: () => b, order: () => b, limit: () => b,
      insert: (p: Row) => { if (table === "admin_actions") actions.push(p); return Promise.resolve({ error: null }); },
      maybeSingle: () => Promise.resolve({ data: table === "platform_settings" ? (o.cfg ? { value: o.cfg } : null) : null, error: null }),
      then: (res: any) => {
        if (table === "groups") return res({ data: [{ id: G1, name: "AC CHALLENGE | 1-GURUH", teacher_id: "t1" }, { id: G2, name: "AC CHALLENGE | 2-GURUH", teacher_id: null }], error: null });
        if (table === "group_teachers") return res({ data: [], error: null });
        if (table === "profiles") return res({ data: o.teachers ?? [{ id: "t1", telegram_id: 901, telegram_write_access_at: "2026-10-01" }], error: null });
        if (table === "user_roles") return res({ data: [{ user_id: "a1" }], error: null });
        return res({ data: [], error: null });
      },
    };
    return b;
  };
  const rpc = (fn: string, args: Row) => {
    if (fn === "teacher_questions_claim_reminders") return Promise.resolve({ data: o.due, error: null });
    if (fn === "teacher_questions_unclaim_reminders") { unclaimed.push(args._ids); return Promise.resolve({ data: args._ids.length, error: null }); }
    return Promise.resolve({ data: null, error: null });
  };
  const send = (method: string, payload: Row) => {
    sent.push({ method, payload });
    return Promise.resolve(o.failSends ? { ok: false, result: null, error: "Forbidden" } : { ok: true, result: { message_id: 1 }, error: null });
  };
  return { admin: { from, rpc }, send, sent, actions, unclaimed };
}

Deno.test("one digest per teacher, a 📂 button per waiting question; recorded as sent", async () => {
  const w = world({ due: [q(1, 70), q(2, 200)] });
  const out = await runOnce({ admin: w.admin, send: w.send, now: () => NOW });
  assertEquals(out.status, "ok");
  assertEquals(w.sent.length, 1);
  assertEquals(w.sent[0].payload.chat_id, 901);
  assertStringIncludes(w.sent[0].payload.text, "2 ta savol javob kutmoqda");
  const cbs = w.sent[0].payload.reply_markup.inline_keyboard.flat().map((b: Row) => b.callback_data);
  assertEquals(cbs, ["tq:o:2", "tq:o:1", "tq:s"]);   // the longest wait first
  assert(w.actions.some((a) => a.action === "teacher_question_reminder_sent"));
  assertEquals(w.unclaimed.length, 0);
});

Deno.test("a group without a reachable teacher goes to the admins; a failed send is un-claimed and DB-visible", async () => {
  const w = world({ due: [q(3, 90, { group_id: G2 })], teachers: [{ id: "a1", telegram_id: 555, telegram_write_access_at: "x" }] });
  const out = await runOnce({ admin: w.admin, send: w.send, now: () => NOW });
  assertEquals(out.status, "ok");
  assertEquals(w.sent[0].payload.chat_id, 555);

  const f = world({ due: [q(4, 90)], failSends: true });
  assertEquals((await runOnce({ admin: f.admin, send: f.send, now: () => NOW })).status, "undelivered");
  assertEquals(f.unclaimed, [[4]]);
  assert(f.actions.some((a) => a.action === "teacher_question_reminder_undelivered"));
});

Deno.test("quiet hours (23–08 Tashkent) and the kill-switch send nothing", async () => {
  const night = Date.parse("2026-10-09T20:00:00Z"); // 01:00 Tashkent
  assertEquals((await runOnce({ admin: world({ due: [q(1, 90)] }).admin, send: () => Promise.reject(), now: () => night })).status, "quiet_hours");
  assertEquals((await runOnce({ admin: world({ due: [q(1, 90)], cfg: { enabled: false } }).admin, send: () => Promise.reject(), now: () => NOW })).status, "disabled");
  assertEquals((await runOnce({ admin: world({ due: [] }).admin, send: () => Promise.reject(), now: () => NOW })).status, "idle");
  assertEquals(tqQuietHour(Date.parse("2026-10-10T03:30:00Z"), 23, 8), false);   // 08:30 Tashkent
  assertEquals(tqSettingsOf({ remind_after_min: 0 }).remind_after_min, 60);
});

Deno.test("inbox: new vs waiting, group filter, pages; every callback fits 64 bytes and parses back", () => {
  const rows = [q(1, 10), q(2, 30, { group_id: G2 }), q(3, 300), q(4, 61, { media: [{ message_id: 9, kind: "photo" }], peer_reply_ids: [5, 6] })];
  const b = bucketizeTq(rows, NOW, 60);
  assertEquals(b.fresh.map((r) => r.id), [1, 2]);
  assertEquals(b.old.map((r) => r.id), [3, 4]);
  const groups = [{ id: G1, name: "AC CHALLENGE | 1-GURUH", open: 3 }, { id: G2, name: "AC CHALLENGE | 2-GURUH", open: 1 }];
  const sum = renderTqSummary(b, NOW, { new_min: 60 }, groups, null);
  assertStringIncludes(sum.text, "Yangi (60 daqiqagacha): <b>2</b>");
  assertStringIncludes(sum.text, "eng uzoq kutgani 5 soat");
  const names = { [G1]: "AC CHALLENGE | 1-GURUH", [G2]: "AC CHALLENGE | 2-GURUH" };
  const list = renderTqList("o", b.old, 0, NOW, names, G1);
  assertStringIncludes(list.text, "💬2");
  assertStringIncludes(list.text, "📎1");
  const card = tqCard(rows[3], NOW, names[G1]);
  assertStringIncludes(card, "Savol #4");
  assertStringIncludes(card, "1-GURUH");
  const kb = tqCardKeyboard(rows[3]);
  assertEquals(kb.inline_keyboard[1][0].url, "https://t.me/c/4440955972/2/104");
  const all = [...sum.keyboard.inline_keyboard, ...list.keyboard.inline_keyboard, ...kb.inline_keyboard,
    ...renderTqDigest(rows, NOW, names).keyboard.inline_keyboard].flat().filter((x) => x.callback_data);
  for (const btn of all) {
    assert(new TextEncoder().encode(btn.callback_data!).length <= 64, btn.callback_data);
    assert(parseTqCallback(btn.callback_data!) !== null, btn.callback_data);
  }
  assertEquals(parseTqCallback(`tq:l:o:3:${G2}`), { kind: "list", bucket: "o", page: 3, gid: G2 });
  assertEquals(parseTqCallback("tq:r:12"), { kind: "reply", id: 12 });
  assertEquals(parseTqCallback("tq:x:1"), null);
  assertEquals(parseTqCallback("tq:s:not-a-uuid"), null);
  assertEquals(messageLink(-123, 2, 5), null);
});

Deno.test("HTML is escaped everywhere a student's words appear", () => {
  const evil = q(7, 90, { text: "<b>hack</b> & <a href=x>", student_name: "<i>Ali</i>" });
  for (const t of [tqCard(evil, NOW, "G"), renderTqDigest([evil], NOW, {}).text, renderTqList("o", [evil], 0, NOW, {}, null).text]) {
    assert(!t.includes("<b>hack") && !t.includes("<i>Ali") && !t.includes("<a href=x>"), t);
  }
});
