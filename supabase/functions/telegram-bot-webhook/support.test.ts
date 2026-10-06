import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  adminCard, captureSupport, deliverReply, escapeCapped, markSolved, mediaKind, parseSupportCallback, startAdminReply,
  startSupport, SUPPORT_OPEN_STATE, SUPPORT_REPLY_STATE, SUPPORT_STATE, type SupportDeps,
} from "./support.ts";

// A stateful fake of the supabase-js chains support.ts uses: bot_conversation_state (keyed by telegram_id, with the
// atomic claim UPDATE … WHERE state=… AND expires_at > now RETURNING), support_tickets (+ the support_ticket_append
// rpc), user_roles + profiles (admin-recipients.ts: two queries), groups, admin_actions (logHealth).
type Row = Record<string, any>;
function world(o: { admins?: number[]; failTo?: number[]; rolesError?: boolean } = {}) {
  const state = new Map<number, Row>();
  const tickets: Row[] = [];
  const actions: Row[] = [];
  const sent: Array<{ method: string; payload: Record<string, any> }> = [];
  const adminTgs = o.admins ?? [900];
  let nextMsg = 1000;

  const builder = (table: string) => {
    const q: Row = { table, op: "select", filters: {} as Row, payload: null, single: false, contains: null, returning: false, gt: null };
    const run = () => Promise.resolve(exec(q));
    const b: any = {
      select: (_c?: string) => { if (q.op !== "select") q.returning = true; return b; },
      update: (p: any) => { q.op = "update"; q.payload = p; return b; },
      upsert: (p: any) => { q.op = "upsert"; q.payload = p; return run(); },
      insert: (p: any) => { q.op = "insert"; q.payload = p; return b; },
      delete: () => { q.op = "delete"; return b; },
      eq: (k: string, v: unknown) => { q.filters[k] = v; return b; },
      in: (k: string, v: unknown) => { q.filters[`in:${k}`] = v; return b; },
      not: () => b,
      gt: (k: string, v: string) => { q.gt = { k, v }; return b; },
      filter: (k: string, _op: string, v: string) => { q.contains = { k, v: JSON.parse(v) }; return b; },
      order: () => b,
      limit: () => b,
      single: () => { q.single = true; return run(); },
      maybeSingle: () => { q.single = true; return run(); },
      then: (res: any, rej: any) => run().then(res, rej),
    };
    return b;
  };

  function exec(q: Row): { data: any; error: any } {
    const one = (rows: Row[]) => (q.single ? rows[0] ?? null : rows);
    if (q.table === "bot_conversation_state") {
      const id = Number(q.filters.telegram_id ?? q.payload?.telegram_id);
      const cur = state.get(id);
      const match = !!cur && (!q.filters.state || cur.state === q.filters.state)
        && (!q.gt || new Date(cur[q.gt.k]).getTime() > new Date(q.gt.v).getTime());
      if (q.op === "upsert") { state.set(Number(q.payload.telegram_id), { ...q.payload }); return { data: null, error: null }; }
      if (q.op === "delete") { if (match) state.delete(id); return { data: null, error: null }; }
      if (q.op === "update") {
        if (!match) return { data: q.returning ? [] : null, error: null };
        Object.assign(cur!, q.payload);
        return { data: q.returning ? [{ ...cur }] : null, error: null };
      }
      return { data: one(cur ? [cur] : []), error: null };
    }
    if (q.table === "support_tickets") {
      if (q.op === "insert") {
        const row = { id: tickets.length + 1, admin_messages: [], ...q.payload };
        tickets.push(row);
        return { data: one([row]), error: null };
      }
      let rows = tickets.filter((t) => Object.entries(q.filters).every(([k, v]) => t[k] === v));
      if (q.contains) {
        const want = q.contains.v[0];
        rows = rows.filter((t) => (t[q.contains.k] ?? []).some((m: Row) => m.chat === want.chat && m.msg === want.msg));
      }
      if (q.op === "update") { rows.forEach((t) => Object.assign(t, q.payload)); return { data: q.returning ? rows.map((r) => ({ ...r })) : null, error: null }; }
      return { data: one([...rows].reverse()), error: null };
    }
    if (q.table === "user_roles") {
      if (o.rolesError) return { data: null, error: { message: "boom" } };
      return { data: adminTgs.map((tg) => ({ user_id: `admin-${tg}` })), error: null };
    }
    if (q.table === "profiles") return { data: adminTgs.map((tg) => ({ id: `admin-${tg}`, telegram_id: tg })), error: null };
    if (q.table === "groups") return { data: one([{ name: "AC CHALLENGE | 3-GURUH" }]), error: null };
    if (q.table === "admin_actions") { actions.push(q.payload); return { data: null, error: null }; }
    return { data: one([]), error: null };
  }

  const deps: SupportDeps = {
    call: (method, payload) => {
      sent.push({ method, payload: payload as Record<string, any> });
      const failed = (o.failTo ?? []).includes(Number((payload as any).chat_id));
      return Promise.resolve(failed
        ? { ok: false, result: null, error: "Forbidden: bot was blocked by the user" }
        : { ok: true, result: { message_id: ++nextMsg }, error: null });
    },
    isMenuButton: (t) => t === "❓ Yordam" || t === "📸 Instagram qo‘shish",
    sleep: () => Promise.resolve(),
  };
  const admin = {
    from: (t: string) => builder(t),
    rpc: (name: string, args: Row) => {
      if (name === "support_ticket_append") {
        const t = tickets.find((x) => x.id === args._id);
        if (t) { t.messages = [...(t.messages ?? []), ...args._messages]; t.admin_messages = [...(t.admin_messages ?? []), ...args._admin_messages]; }
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { admin, state, tickets, actions, sent, deps };
}

const STUDENT = { id: "stud-1", name: "Lawyer A.R", username: "lawyer_rahimov", groupId: "g3" };
const ADMIN = { id: "admin-900", name: "Admin", username: "akmalidiin", groupId: null };
let mid = 70;
const msgFrom = (tg: number, chat: number, extra: Row = {}) => ({ message_id: ++mid, from: { id: tg }, chat: { id: chat }, ...extra });

Deno.test("parseSupportCallback / escapeCapped / adminCard / mediaKind", () => {
  assertEquals(parseSupportCallback("sup:r:12"), { action: "reply", id: 12 });
  assertEquals(parseSupportCallback("sup:d:7"), { action: "done", id: 7 });
  assertEquals(parseSupportCallback("sup:x"), null);
  assertEquals(parseSupportCallback("sup:r:0"), null);
  assertEquals(parseSupportCallback("sup:r:12;drop"), null);
  // the escaped length is capped, and an entity is never cut in half
  const big = escapeCapped("<".repeat(5000), 3200);
  assert(big.length <= 3200 && big.endsWith("…") && !/&l?t?$/.test(big.slice(0, -1)));
  const c = adminCard({ id: 3, name: "A <b>", username: "u_1", group: "3-GURUH", locale: "uz", text: "<script>x</script>", media: "photo" });
  assertStringIncludes(c, "🆘 <b>Yordam soʻrovi #3</b>");
  assertStringIncludes(c, "&lt;script&gt;x&lt;/script&gt;");
  assertStringIncludes(c, "A &lt;b&gt; (@u_1) · 3-GURUH");
  assert(adminCard({ id: 1, name: "x", username: null, group: null, locale: "uz", text: "&".repeat(4000), media: null }).length < 4096);
  assertEquals(mediaKind({ photo: [{}] }), "photo");
  assertEquals(mediaKind({ text: "x" }), null);
});

Deno.test("the whole flow: ask → description → admins get the card → ✍️ answer → the student gets it, ticket answered", async () => {
  const w = world({ admins: [900, 901] });
  await startSupport(w.admin, 500, 500, STUDENT.id, "uz", w.deps);
  assertEquals(w.state.get(500)?.state, SUPPORT_STATE);
  assertStringIncludes(w.sent[0].payload.text, "Texnik muammoingizni yozing");
  assertEquals(w.sent[0].payload.reply_markup.inline_keyboard[0][0].callback_data, "sup:x");

  assert(await captureSupport(w.admin, msgFrom(500, 500, { text: "Video ochilmayapti, 3-dars" }), STUDENT, false, "uz", w.deps));
  assertEquals(w.state.get(500)?.state, SUPPORT_OPEN_STATE, "claimed, not waiting any more");
  assertEquals(w.tickets.length, 1);
  assertEquals(w.tickets[0].group_name, "AC CHALLENGE | 3-GURUH");
  const cards = w.sent.filter((s) => s.payload.chat_id === 900 || s.payload.chat_id === 901);
  assertEquals(cards.length, 2, "every admin gets the card");
  assertStringIncludes(cards[0].payload.text, "Video ochilmayapti, 3-dars");
  assertEquals(cards[0].payload.reply_markup.inline_keyboard[0].map((b: Row) => b.callback_data), ["sup:r:1", "sup:d:1"]);
  assertEquals(w.tickets[0].admin_messages.length, 2);
  assertStringIncludes(w.sent.at(-1)!.payload.text, "Murojaatingiz qabul qilindi (#1)");

  await startAdminReply(w.admin, 900, 900, 1, w.deps);
  assertEquals(w.state.get(900)?.state, SUPPORT_REPLY_STATE);
  const n = w.sent.length;
  assert(await captureSupport(w.admin, msgFrom(900, 900, { text: "Brauzerni yangilang, endi ishlaydi" }), ADMIN, true, "uz", w.deps));
  const toStudent = w.sent.slice(n).find((s) => s.payload.chat_id === 500)!;
  assertStringIncludes(toStudent.payload.text, "Yordam xizmati javobi</b> (#1)");
  assertStringIncludes(toStudent.payload.text, "Muammongiz hal qilindi");
  assertEquals(w.tickets[0].status, "answered");
  assertStringIncludes(w.sent.at(-1)!.payload.text, "✅ Javob yuborildi: <b>#1</b>");
});

Deno.test("an album (3 screenshots) is ONE ticket: the later parts are attached and copied, never the homework hint", async () => {
  const w = world();
  await startSupport(w.admin, 500, 500, STUDENT.id, "uz", w.deps);
  const part = (cap?: string) => msgFrom(500, 500, { photo: [{ file_id: "x" }], media_group_id: "AL1", ...(cap ? { caption: cap } : {}) });
  assert(await captureSupport(w.admin, part("Xato ekrani"), STUDENT, false, "uz", w.deps));
  assert(await captureSupport(w.admin, part(), STUDENT, false, "uz", w.deps));
  assert(await captureSupport(w.admin, part(), STUDENT, false, "uz", w.deps));
  assertEquals(w.tickets.length, 1);
  assertEquals(w.tickets[0].messages.length, 3);
  assertEquals(w.sent.filter((s) => s.method === "copyMessage" && s.payload.chat_id === 900).length, 3, "all three reach the admin");
  assertEquals(w.sent.filter((s) => s.payload.chat_id === 500 && /qabul qilindi/.test(s.payload.text ?? "")).length, 1, "one receipt");
  // a plain message after the album is not swallowed
  assertEquals(await captureSupport(w.admin, msgFrom(500, 500, { text: "salom" }), STUDENT, false, "uz", w.deps), false);
});

Deno.test("an admin can simply REPLY to the card, in the ticket's language", async () => {
  const w = world();
  await startSupport(w.admin, 500, 500, STUDENT.id, "ru", w.deps);
  await captureSupport(w.admin, msgFrom(500, 500, { photo: [{ file_id: "x" }], caption: "Ошибка" }), STUDENT, false, "ru", w.deps);
  const cardId = w.tickets[0].admin_messages[0].msg;
  const n = w.sent.length;
  assert(await captureSupport(w.admin, msgFrom(900, 900, { text: "Готово", reply_to_message: { message_id: cardId } }), ADMIN, true, "uz", w.deps));
  assertStringIncludes(w.sent.slice(n).find((s) => s.payload.chat_id === 500)!.payload.text, "Ответ службы поддержки");
  assertEquals(w.tickets[0].status, "answered");
});

Deno.test("a second «Yordam» while a ticket is open adds to it", async () => {
  const w = world();
  await startSupport(w.admin, 500, 500, STUDENT.id, "uz", w.deps);
  await captureSupport(w.admin, msgFrom(500, 500, { text: "Birinchi" }), STUDENT, false, "uz", w.deps);
  await startSupport(w.admin, 500, 500, STUDENT.id, "uz", w.deps);
  assertStringIncludes(w.sent.at(-1)!.payload.text, "#1</b> murojaatingiz koʻrib chiqilmoqda");
  await captureSupport(w.admin, msgFrom(500, 500, { text: "Qoʻshimcha" }), STUDENT, false, "uz", w.deps);
  assertEquals(w.tickets.length, 1);
  assertEquals(w.tickets[0].messages.length, 2);
  assertStringIncludes(w.sent.at(-1)!.payload.text, "qoʻshildi");
});

Deno.test("no admin reached → the student is told honestly, the ticket stays open, the failure is DB-visible", async () => {
  const w = world({ rolesError: true });
  await startSupport(w.admin, 500, 500, STUDENT.id, "uz", w.deps);
  await captureSupport(w.admin, msgFrom(500, 500, { text: "yordam" }), STUDENT, false, "uz", w.deps);
  assertEquals(w.tickets[0].status, "open");
  assert(w.actions.some((a) => a.action === "support_admins_lookup_failed"));
  assert(w.actions.some((a) => a.action === "support_ticket_undelivered"));
  assertStringIncludes(w.sent.at(-1)!.payload.text, "saqlandi (#1), lekin hozir adminga yetkazib boʻlmadi");
});

Deno.test("a menu button or a command while waiting is never a description; a non-admin reply is not an answer", async () => {
  const w = world();
  await startSupport(w.admin, 500, 500, STUDENT.id, "uz", w.deps);
  assertEquals(await captureSupport(w.admin, msgFrom(500, 500, { text: "📸 Instagram qo‘shish" }), STUDENT, false, "uz", w.deps), false);
  assertEquals(w.state.has(500), false);
  assertEquals(w.tickets.length, 0);
  await startSupport(w.admin, 500, 500, STUDENT.id, "uz", w.deps);
  assertEquals(await captureSupport(w.admin, msgFrom(500, 500, { text: "/start" }), STUDENT, false, "uz", w.deps), false);
  assertEquals(await captureSupport(w.admin, msgFrom(500, 500, { text: "hi", reply_to_message: { message_id: 1001 } }), STUDENT, false, "uz", w.deps), false);
});

Deno.test("✅ Hal boʻldi works once; an undeliverable answer keeps the ticket open and tells the admin", async () => {
  const ok = world();
  ok.tickets.push({ id: 2, chat_id: 501, locale: "en", status: "open", username: null, display_name: "T", admin_messages: [] });
  await markSolved(ok.admin, 2, ADMIN.id, 900, ok.deps);
  assertStringIncludes(ok.sent[0].payload.text, "The problem in your request <b>#2</b> is solved");
  assertEquals(ok.tickets[0].status, "answered");
  const n = ok.sent.length;
  await markSolved(ok.admin, 2, ADMIN.id, 900, ok.deps);                      // a second tap
  assertEquals(ok.sent.slice(n).filter((s) => s.payload.chat_id === 501).length, 0, "the student is not messaged twice");
  assertStringIncludes(ok.sent.at(-1)!.payload.text, "allaqachon yopilgan");

  const bad = world({ failTo: [500] });
  bad.tickets.push({ id: 1, chat_id: 500, locale: "uz", status: "open", username: "s", display_name: "S", admin_messages: [] });
  await deliverReply(bad.admin, 1, ADMIN.id, 900, msgFrom(900, 900, { text: "x" }), bad.deps);
  assertEquals(bad.tickets[0].status, "open");
  assertEquals(bad.actions.at(-1)?.action, "support_reply_undelivered");
  assertStringIncludes(bad.sent.at(-1)!.payload.text, "yetib bormadi");
  await markSolved(bad.admin, 1, ADMIN.id, 900, bad.deps);
  assertEquals(bad.tickets[0].status, "open", "a failed ✅ is reopened");
});
