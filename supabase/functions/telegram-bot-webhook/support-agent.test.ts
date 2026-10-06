import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleSupportAgentCallback } from "./support-agent.ts";
import type { SupportDeps } from "./support.ts";

type Row = Record<string, any>;
function world(o: { proposal: Row; apply?: Row; decide?: Row; claim?: boolean }) {
  const sent: Array<{ method: string; payload: Row }> = [];
  const ticketUpdates: Row[] = [];
  const actions: Row[] = [];
  const rpcCalls: string[] = [];
  const delivered: Row[] = [];
  const ticket = { id: 31, chat_id: 7001, locale: "uz", username: "ali", display_name: "Ali" };
  const from = (table: string) => {
    const q: Row = { op: "select", payload: null };
    const b: any = {
      select: () => b, eq: () => b,
      update: (p: Row) => { q.op = "update"; q.payload = p; if (table === "support_tickets") ticketUpdates.push(p); return b; },
      insert: (p: Row) => { if (table === "admin_actions") actions.push(p); return Promise.resolve({ error: null }); },
      maybeSingle: () => Promise.resolve({
        data: table === "support_fix_proposals" ? o.proposal : table === "support_tickets" ? ticket : null, error: null,
      }),
      then: (res: any) => res({ data: null, error: null }),
    };
    return b;
  };
  const admin = {
    from,
    rpc: (fn: string, args: Row) => {
      rpcCalls.push(fn);
      if (fn === "support_proposal_delivered") delivered.push(args);
      const data = fn === "support_apply_fix" ? o.apply : fn === "support_proposal_decide" ? o.decide
        : fn === "support_proposal_claim_delivery" ? (o.claim ?? true) : null;
      return Promise.resolve({ data, error: null });
    },
  };
  const deps: SupportDeps = {
    call: (method, payload) => { sent.push({ method, payload }); return Promise.resolve({ ok: true, result: { message_id: 1 }, error: null }); },
    isMenuButton: () => false,
  };
  return { admin, deps, sent, ticketUpdates, actions, rpcCalls, delivered };
}

const CARDS = [{ chat: 900, msg: 11 }, { chat: 901, msg: 12 }];
const DATA = { id: 77, ticket_id: 31, action: "assign_group", class: "data", status: "proposed", student_message: "Guruhingiz toʻgʻrilandi.", admin_messages: CARDS };
const REPLY = { ...DATA, action: null, class: "reply_only", student_message: "Botni bloklamang." };

Deno.test("✅ on a data fix asks once more on THIS copy; nothing runs yet", async () => {
  const w = world({ proposal: DATA });
  await handleSupportAgentCallback(w.admin, "sa:a:77", "a1", 900, 11, w.deps);
  assertEquals(w.rpcCalls, []);
  assertEquals(w.sent.length, 1);
  assertEquals(w.sent[0].method, "editMessageReplyMarkup");
  assertEquals(w.sent[0].payload.reply_markup.inline_keyboard[0][0].callback_data, "sa:c:77");
});

Deno.test("confirm → verified: the student gets the reply + 'solved', ticket answered, every admin copy closed", async () => {
  const w = world({ proposal: DATA, apply: { ok: true, status: "verified", action: "assign_group", ticket_id: 31 } });
  await handleSupportAgentCallback(w.admin, "sa:c:77", "a1", 900, 11, w.deps);
  const toStudent = w.sent.find((s) => s.payload.chat_id === 7001)!;
  assertStringIncludes(toStudent.payload.text, "Guruhingiz toʻgʻrilandi.");
  assertStringIncludes(toStudent.payload.text, "Muammongiz hal qilindi");
  assertEquals(w.ticketUpdates.length, 0);
  assertEquals(w.delivered, [{ _id: 77, _ok: true, _error: null, _admin: "a1" }]);
  assertEquals(w.sent.filter((s) => s.method === "editMessageReplyMarkup").length, 2);
  const lines = w.sent.filter((s) => s.method === "sendMessage" && s.payload.chat_id !== 7001);
  assertEquals(lines.length, 2);
  assertStringIncludes(lines[0].payload.text, "tekshirildi");
});

Deno.test("verify_failed: nothing goes to the student, the admins are told to check by hand", async () => {
  const w = world({ proposal: DATA, apply: { ok: true, status: "verify_failed", ticket_id: 31 } });
  await handleSupportAgentCallback(w.admin, "sa:c:77", "a1", 900, 11, w.deps);
  assert(!w.sent.some((s) => s.payload.chat_id === 7001));
  assertEquals(w.delivered.length, 0);
  assert(w.sent.some((s) => String(s.payload.text ?? "").includes("YUBORILMADI")));
});

Deno.test("superseded closes every copy; nothing sent to the student", async () => {
  const w = world({ proposal: DATA, apply: { ok: false, reason: "superseded", ticket_id: 31 } });
  await handleSupportAgentCallback(w.admin, "sa:c:77", "a1", 900, 11, w.deps);
  assert(!w.sent.some((s) => s.payload.chat_id === 7001));
  assertEquals(w.sent.filter((s) => s.method === "editMessageReplyMarkup").length, 2);
});

Deno.test("a second tap (already applied AND delivered) only answers the clicker — no second reply", async () => {
  const w = world({ proposal: { ...DATA, status: "verified" }, apply: { ok: true, already: true, status: "verified", ticket_id: 31 }, claim: false });
  await handleSupportAgentCallback(w.admin, "sa:c:77", "a2", 901, 12, w.deps);
  assertEquals(w.sent.length, 1);
  assertEquals(w.sent[0].payload.chat_id, 901);
  assertStringIncludes(w.sent[0].payload.text, "allaqachon");
});

Deno.test("agent switched off: the tap is refused to the clicker only, cards keep their buttons", async () => {
  const w = world({ proposal: REPLY, apply: { ok: false, reason: "disabled" } });
  await handleSupportAgentCallback(w.admin, "sa:a:77", "a1", 900, 11, w.deps);
  assertEquals(w.sent.length, 1);
  assertStringIncludes(w.sent[0].payload.text, "oʻchirilgan");
});

Deno.test("a reply-only proposal sends on one tap; a code-bug reply keeps the ticket open (no 'solved')", async () => {
  const w = world({ proposal: { ...REPLY, class: "code_bug", student_message: "Oʻrganilmoqda." }, apply: { ok: true, status: "sent", ticket_id: 31 } });
  await handleSupportAgentCallback(w.admin, "sa:a:77", "a1", 900, 11, w.deps);
  const toStudent = w.sent.find((s) => s.payload.chat_id === 7001)!;
  assertStringIncludes(toStudent.payload.text, "Oʻrganilmoqda.");
  assert(!toStudent.payload.text.includes("hal qilindi"));
  assertEquals(w.ticketUpdates.length, 0);
  assertEquals(w.delivered[0]._ok, true);   // SQL keeps a code_bug ticket open
});

Deno.test("❌ rejects through SQL and closes every copy; nothing reaches the student", async () => {
  const w = world({ proposal: DATA, decide: { ok: true, status: "rejected", ticket_id: 31 } });
  await handleSupportAgentCallback(w.admin, "sa:r:77", "a1", 900, 11, w.deps);
  assertEquals(w.rpcCalls, ["support_proposal_decide"]);
  assert(!w.sent.some((s) => s.payload.chat_id === 7001));
  assertEquals(w.sent.filter((s) => s.method === "editMessageReplyMarkup").length, 2);
});

Deno.test("a tap on a closed proposal strips that copy's buttons and says why", async () => {
  const w = world({ proposal: { ...DATA, status: "rejected" } });
  await handleSupportAgentCallback(w.admin, "sa:a:77", "a1", 900, 11, w.deps);
  assertEquals(w.rpcCalls, []);
  assert(w.sent.some((s) => s.method === "editMessageReplyMarkup" && s.payload.message_id === 11));
});

Deno.test("a fix whose reply never went out (crash) is delivered by the next tap, once", async () => {
  const w = world({ proposal: { ...DATA, status: "verified" }, apply: { ok: true, already: true, status: "verified", ticket_id: 31 } });
  await handleSupportAgentCallback(w.admin, "sa:a:77", "a2", 901, 12, w.deps);
  assertEquals(w.sent.filter((s) => s.payload.chat_id === 7001).length, 1);
  assertEquals(w.delivered.length, 1);
  assertEquals(w.sent.filter((s) => s.method === "editMessageReplyMarkup").length, 2);
});

Deno.test("the ticket was answered by hand meanwhile: the proposal closes, nothing is sent twice", async () => {
  const w = world({ proposal: DATA, apply: { ok: false, reason: "ticket_closed", ticket_id: 31 } });
  await handleSupportAgentCallback(w.admin, "sa:c:77", "a1", 900, 11, w.deps);
  assert(!w.sent.some((s) => s.payload.chat_id === 7001));
  assertEquals(w.sent.filter((s) => s.method === "editMessageReplyMarkup").length, 2);
  assert(w.sent.some((s) => String(s.payload.text ?? "").includes("allaqachon javob berilgan")));
});

Deno.test("an undeliverable reply is recorded as such (released for a later try), the admins are told", async () => {
  const w = world({ proposal: REPLY, apply: { ok: true, status: "sent", ticket_id: 31 } });
  w.deps.call = (method, payload) => {
    w.sent.push({ method, payload });
    return Promise.resolve(payload.chat_id === 7001
      ? { ok: false, result: null, error: "Forbidden: bot was blocked by the user" }
      : { ok: true, result: { message_id: 1 }, error: null });
  };
  await handleSupportAgentCallback(w.admin, "sa:a:77", "a1", 900, 11, w.deps);
  assertEquals(w.delivered[0]._ok, false);
  assert(w.sent.some((s) => String(s.payload.text ?? "").includes("yetib bormadi")));
});

Deno.test("reject on a proposal someone else closed: friendly line, this copy's stale buttons removed", async () => {
  const w = world({ proposal: DATA, decide: { ok: false, reason: "not_open" } });
  await handleSupportAgentCallback(w.admin, "sa:r:77", "a1", 900, 11, w.deps);
  assert(!w.sent.some((s) => String(s.payload.text ?? "").includes("not_open")));
  assert(w.sent.some((s) => s.method === "editMessageReplyMarkup" && s.payload.message_id === 11));
});
