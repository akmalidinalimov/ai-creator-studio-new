import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runOnce, settingsOf } from "./reminder.ts";
import { isQuietHour } from "../_shared/support-reminder-card.ts";
import {
  ageText, bucketize, parseInboxCallback, renderInboxSummary, renderTicketList, type InboxTicket,
} from "../_shared/support-inbox.ts";
import { parseSupportCallback } from "../telegram-bot-webhook/support.ts";

type Row = Record<string, any>;
const NOW = Date.parse("2026-10-08T07:00:00Z"); // 12:00 Tashkent
const hAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const ticket = (id: number, hoursAgo: number, extra: Row = {}): Row => ({
  id, chat_id: 7000 + id, display_name: `S${id}`, username: `s${id}`, group_name: "4-GURUH", locale: "uz",
  created_at: hAgo(hoursAgo), status: "open", reminded_at: null, admin_messages: [],
  messages: [{ media: "photo", text: "", message_id: 1 }, { media: null, text: `muammo ${id}`, message_id: 2 }], ...extra,
});

function world(o: { tickets: Row[]; cfg?: Row; failSends?: boolean }) {
  const sent: Array<{ method: string; payload: Row }> = [];
  const actions: Row[] = [];
  const from = (table: string) => {
    const q: Row = { op: "select", patch: null, ids: null as number[] | null, cutoff: null as string | null };
    const b: any = {
      select: () => b, order: () => b, limit: () => b, eq: () => b, not: () => b, gte: () => b,
      lt: (_k: string, v: string) => { q.cutoff = v; return b; },
      or: () => b, in: (_k: string, v: number[]) => { q.ids = v; return b; },
      update: (p: Row) => { q.op = "update"; q.patch = p; return b; },
      insert: (p: Row) => { if (table === "admin_actions") actions.push(p); return Promise.resolve({ error: null }); },
      maybeSingle: () => Promise.resolve({ data: table === "platform_settings" ? (o.cfg ? { value: o.cfg } : null) : null, error: null }),
      then: (res: any) => {
        if (table === "user_roles") return res({ data: [{ user_id: "a1" }], error: null });
        if (table === "profiles") return res({ data: [{ telegram_id: 900 }], error: null });
        if (table === "support_tickets" && q.op === "update") {
          const hit = o.tickets.filter((t) => t.status === "open" && (q.ids ? q.ids.includes(t.id)
            : Date.parse(t.created_at) < Date.parse(q.cutoff!) && (!t.reminded_at || Date.parse(t.reminded_at) < Date.parse(q.cutoff!))));
          hit.forEach((t) => Object.assign(t, q.patch));
          return res({ data: hit.map((t) => ({ id: t.id })), error: null });
        }
        if (table === "support_tickets") return res({ data: o.tickets.filter((t) => t.status === "open"), error: null });
        if (table === "admin_actions") return res({ data: actions.filter((a) => a.action === "support_reminder_sent"), error: null });
        return res({ data: [], error: null });
      },
    };
    return b;
  };
  const send = (method: string, payload: Row) => {
    sent.push({ method, payload });
    return Promise.resolve(o.failSends ? { ok: false, result: null, error: "Forbidden" } : { ok: true, result: { message_id: 1 }, error: null });
  };
  return { admin: { from }, send, sent, actions, tickets: o.tickets };
}

Deno.test("every 5 h: ONE summary (new vs older open + the oldest wait), not one message per ticket", async () => {
  const w = world({ tickets: [ticket(1, 26), ticket(2, 9), ticket(3, 2)] });
  const out = await runOnce({ admin: w.admin, send: w.send, now: () => NOW });
  assertEquals(out.status, "ok");
  assertEquals(w.sent.length, 1);
  const m = w.sent[0].payload;
  assertStringIncludes(m.text, "3 ta ochiq");
  assertStringIncludes(m.text, "Yangi (6 soatgacha): <b>1</b>");
  assertStringIncludes(m.text, "Eskiroq ochiq: <b>2</b> · eng eskisi 26 soat");
  assertEquals(m.reply_markup.inline_keyboard[0].map((b: Row) => b.callback_data), ["sup:l:n:0", "sup:l:o:0"]);
  // only the tickets waiting longer than 5 h were due; a second run in the same window sends nothing
  assertEquals(w.tickets.filter((t) => t.reminded_at).map((t) => t.id).sort(), [1, 2]);
  assert(w.actions.some((a) => a.action === "support_reminder_sent"));
  // a strict cadence: another ticket becoming due within the 5 h still sends nothing until the window passes
  w.tickets.push(ticket(9, 6));
  assertEquals((await runOnce({ admin: w.admin, send: w.send, now: () => NOW })).status, "cadence");
  assertEquals(w.sent.length, 1);
});

Deno.test("nothing waiting long enough → no message; quiet hours wait; nobody reached → un-claimed + DB-visible", async () => {
  assertEquals((await runOnce({ admin: world({ tickets: [ticket(1, 2)] }).admin, send: () => Promise.reject(), now: () => NOW })).status, "idle");
  const night = Date.parse("2026-10-07T20:00:00Z"); // 01:00 Tashkent
  assertEquals((await runOnce({ admin: world({ tickets: [ticket(1, 26)] }).admin, send: () => Promise.reject(), now: () => night })).status, "quiet_hours");
  const fail = world({ tickets: [ticket(1, 26)], failSends: true });
  assertEquals((await runOnce({ admin: fail.admin, send: fail.send, now: () => NOW })).status, "undelivered");
  assertEquals(fail.tickets[0].reminded_at, null);
  assert(fail.actions.some((a) => a.action === "support_reminder_undelivered"));
  assertEquals(isQuietHour(Date.parse("2026-10-08T03:00:00Z"), 23, 8), false);
});

Deno.test("inbox: new first (newest on top), older by the longest wait; pages of 8; callbacks fit and parse", () => {
  const rows = [ticket(1, 30), ticket(2, 7), ticket(3, 1), ticket(4, 0.2)] as unknown as InboxTicket[];
  const b = bucketize(rows, NOW, 6);
  assertEquals(b.fresh.map((t) => t.id), [4, 3]);
  assertEquals(b.old.map((t) => t.id), [1, 2]);
  const list = renderTicketList("o", b.old, 0, NOW);
  assertStringIncludes(list.text, "<b>#1</b>");
  assertStringIncludes(list.text, "«muammo 1» 📎1");
  assertEquals(list.keyboard.inline_keyboard[0][0].callback_data, "sup:o:1");
  const many = Array.from({ length: 19 }, (_, i) => ticket(i + 1, 10 + i)) as unknown as InboxTicket[];
  const p2 = renderTicketList("o", many, 1, NOW);
  assertStringIncludes(p2.text, "2/3-sahifa");
  assertEquals(p2.keyboard.inline_keyboard.at(-1)!.map((x) => x.callback_data), ["sup:l:o:0", "sup:i", "sup:l:o:2"]);
  for (const row of [...p2.keyboard.inline_keyboard, ...renderInboxSummary(b, NOW, 6).keyboard.inline_keyboard]) {
    for (const btn of row) assert(new TextEncoder().encode(btn.callback_data).length <= 64);
  }
  assertEquals(parseInboxCallback("sup:l:n:3"), { kind: "list", bucket: "n", page: 3 });
  assertEquals(parseInboxCallback("sup:o:12"), { kind: "open", id: 12 });
  assertEquals(parseInboxCallback("sup:i"), { kind: "summary" });
  // the ticket buttons (✍️ / ✅) are a different family — never mistaken for the inbox
  assertEquals(parseInboxCallback("sup:r:12"), null);
  assertEquals(parseSupportCallback("sup:o:12"), null);
  assertEquals(ageText(90 * 60_000), "1 soat");
  assertEquals(ageText(3 * 24 * 3_600_000), "3 kun");
});

Deno.test("empty inbox says so; settings default to every 5 h and 6 h for 'new'", () => {
  assertStringIncludes(renderInboxSummary({ fresh: [], old: [] }, NOW, 6).text, "ochiq murojaat yoʻq");
  assertEquals(settingsOf(null).every_min, 300);
  assertEquals(settingsOf({ new_hours: 12 }).new_hours, 12);
  assertEquals(settingsOf({ new_hours: 0 }).new_hours, 6);
});
