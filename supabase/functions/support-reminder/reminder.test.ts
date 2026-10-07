import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runOnce, settingsOf } from "./reminder.ts";
import { isQuietHour, reminderCard, ticketKeyboard } from "../_shared/support-reminder-card.ts";
import { parseSupportCallback } from "../telegram-bot-webhook/support.ts";

type Row = Record<string, any>;
const NOW = Date.parse("2026-10-07T07:00:00Z"); // 12:00 Tashkent

const T1 = {
  id: 1, chat_id: 7001, display_name: "Robiya", username: "robiya", group_name: "4-GURUH", locale: "uz",
  created_at: "2026-10-06T21:31:52Z", status: "open", reminded_at: null as string | null,
  messages: [{ media: "photo", text: "", message_id: 101 }, { media: null, text: "Shu dars nima haqida tushunmadim", message_id: 102 },
             { media: "photo", text: "", message_id: 103 }],
};

function world(o: { tickets: Row[]; cfg?: Row; admins?: number[]; failSends?: boolean }) {
  const sent: Array<{ method: string; payload: Row }> = [];
  const appended: Row[] = [];
  const actions: Row[] = [];
  let mid = 5000;
  const from = (table: string) => {
    const q: Row = { op: "select", patch: null, filters: {} as Row };
    const b: any = {
      select: () => b, order: () => b, limit: () => b, not: () => b, lt: () => b, or: () => b, in: () => b,
      eq: (k: string, v: unknown) => { q.filters[k] = v; return b; },
      update: (p: Row) => { q.op = "update"; q.patch = p; return b; },
      insert: (p: Row) => { if (table === "admin_actions") actions.push(p); return Promise.resolve({ error: null }); },
      maybeSingle: () => Promise.resolve({ data: table === "platform_settings" ? (o.cfg ? { value: o.cfg } : null) : null, error: null }),
      then: (res: any) => {
        if (table === "user_roles") return res({ data: [{ user_id: "a1" }], error: null });
        if (table === "profiles") return res({ data: (o.admins ?? [900]).map((id) => ({ telegram_id: id })), error: null });
        if (table === "support_tickets" && q.op === "update") {
          const t = o.tickets.find((x) => x.id === q.filters.id);
          if (!t || t.status !== "open") return res({ data: [], error: null });
          Object.assign(t, q.patch);
          return res({ data: [{ id: t.id }], error: null });
        }
        if (table === "support_tickets") return res({ data: o.tickets.filter((t) => t.status === "open"), error: null });
        return res({ data: [], error: null });
      },
    };
    return b;
  };
  const admin = {
    from,
    rpc: (fn: string, args: Row) => { if (fn === "support_ticket_append") appended.push(args); return Promise.resolve({ data: null, error: null }); },
  };
  const send = (method: string, payload: Row) => {
    sent.push({ method, payload });
    return Promise.resolve(o.failSends ? { ok: false, result: null, error: "Forbidden" } : { ok: true, result: { message_id: ++mid }, error: null });
  };
  return { admin, send, sent, appended, actions, tickets: o.tickets };
}

Deno.test("the reminder re-sends the whole ticket: card with the words + every screenshot copied under it + the same buttons", async () => {
  const w = world({ tickets: [{ ...T1 }] });
  const out = await runOnce({ admin: w.admin, send: w.send, now: () => NOW });
  assertEquals(out.status, "ok");
  const card = w.sent.find((s) => s.method === "sendMessage")!;
  assertStringIncludes(card.payload.text, "Eslatma: #1");
  assertStringIncludes(card.payload.text, "9 soatdan beri javobsiz");
  assertStringIncludes(card.payload.text, "Shu dars nima haqida tushunmadim");
  assertStringIncludes(card.payload.text, "2 ta (skrinshot)");
  assertEquals(card.payload.reply_markup, ticketKeyboard(1));
  const copies = w.sent.filter((s) => s.method === "copyMessage");
  assertEquals(copies.map((c) => c.payload.message_id), [101, 103]);
  const cardId = w.appended[0]._admin_messages[0].msg;
  assert(copies.every((c) => c.payload.from_chat_id === 7001 && c.payload.reply_parameters.message_id === cardId));
  // the reminder card and its copies are recorded: a Reply on them answers the ticket
  assertEquals(w.appended[0]._admin_messages.length, 3);
  assert(w.tickets[0].reminded_at);
});

Deno.test("the buttons are the ones the bot understands", () => {
  const kb = ticketKeyboard(42).inline_keyboard[0];
  assertEquals(parseSupportCallback(kb[0].callback_data), { action: "reply", id: 42 });
  assertEquals(parseSupportCallback(kb[1].callback_data), { action: "done", id: 42 });
});

Deno.test("quiet hours (23:00–08:00 Tashkent) wait; disabled does nothing", async () => {
  const night = Date.parse("2026-10-07T20:00:00Z"); // 01:00 Tashkent
  const w = world({ tickets: [{ ...T1 }] });
  assertEquals((await runOnce({ admin: w.admin, send: w.send, now: () => night })).status, "quiet_hours");
  assertEquals((await runOnce({ admin: w.admin, send: w.send, now: () => NOW })).status, "ok");
  const off = world({ tickets: [{ ...T1 }], cfg: { enabled: false } });
  assertEquals((await runOnce({ admin: off.admin, send: off.send, now: () => NOW })).status, "disabled");
  assertEquals(isQuietHour(Date.parse("2026-10-07T02:59:00Z"), 23, 8), true);   // 07:59
  assertEquals(isQuietHour(Date.parse("2026-10-07T03:00:00Z"), 23, 8), false);  // 08:00
});

Deno.test("a ticket answered meanwhile is not reminded; nobody reached → un-claimed and DB-visible", async () => {
  const answered = world({ tickets: [{ ...T1, status: "answered" }] });
  assertEquals((await runOnce({ admin: answered.admin, send: answered.send, now: () => NOW })).status, "idle");
  const fail = world({ tickets: [{ ...T1 }], failSends: true });
  await runOnce({ admin: fail.admin, send: fail.send, now: () => NOW });
  assertEquals(fail.tickets[0].reminded_at, null);
  assert(fail.actions.some((a) => a.action === "support_reminder_undelivered"));
});

Deno.test("settings are validated; the card stays short whatever the ticket holds", () => {
  assertEquals(settingsOf({ every_min: 5 }).every_min, 60);       // below 15 min → default
  assertEquals(settingsOf({ every_min: 120 }).every_min, 120);
  assertEquals(settingsOf(null).enabled, true);
  const huge = reminderCard({ ...T1, display_name: "&".repeat(500), messages: [{ text: "<".repeat(9000) }] }, NOW);
  assert(huge.length < 3600, String(huge.length));
});
