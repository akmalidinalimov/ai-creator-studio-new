import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { captureTqAnswer, deliverTqAnswer, handleTqCallback, TQ_ALBUM_STATE, TQ_ANSWER_STATE } from "./teacher-questions-bot.ts";

type Row = Record<string, any>;
const G1 = "11111111-1111-4111-8111-111111111111";
const Q: Row = {
  id: 12, group_id: G1, chat_id: -1004440955972, thread_id: 2, tg_user_id: 777, student_id: "stu", student_name: "Ali",
  student_username: "ali", first_message_id: 345, message_ids: [345, 346], text: "Sunoni alohida olish kerakmi?",
  media: [{ message_id: 346, kind: "photo" }], peer_reply_ids: [], asked_at: new Date(Date.now() - 90 * 60_000).toISOString(),
  status: "open", reminder_count: 1,
};

function world(o: { teacherOf?: string[]; state?: Row | null; studentDm?: boolean; failPost?: boolean } = {}) {
  const calls: Array<{ method: string; payload: Row }> = [];
  const updates: Array<{ table: string; patch: Row; filters: Row }> = [];
  const actions: Row[] = [];
  const deleted: Row[] = [];
  const from = (table: string) => {
    const f: Row = {};
    let op = "select"; let patch: Row | null = null;
    const b: any = {
      select: () => b, order: () => b, limit: () => b, in: () => b, not: () => b,
      eq: (k: string, v: unknown) => { f[k] = v; return b; },
      update: (p: Row) => { op = "update"; patch = p; return b; },
      delete: () => { op = "delete"; return b; },
      upsert: (p: Row) => { updates.push({ table, patch: p, filters: {} }); return Promise.resolve({ error: null }); },
      insert: (p: Row) => { if (table === "admin_actions") actions.push(p); return Promise.resolve({ error: null }); },
      maybeSingle: () => {
        if (table === "teacher_questions") return Promise.resolve({ data: { ...Q }, error: null });
        if (table === "profiles") return Promise.resolve({ data: { telegram_id: 777, telegram_write_access_at: o.studentDm === false ? null : "2026-10-01" }, error: null });
        if (table === "bot_conversation_state") return Promise.resolve({ data: o.state ?? null, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then: (res: any) => {
        if (op === "update") { updates.push({ table, patch: patch!, filters: { ...f } }); return res({ data: [{ id: f.id }], error: null }); }
        if (op === "delete") { deleted.push({ table, ...f }); return res({ data: [{ telegram_id: f.telegram_id }], error: null }); }
        if (table === "groups" && "teacher_id" in f) return res({ data: (o.teacherOf ?? [G1]).map((id) => ({ id })), error: null });
        if (table === "group_teachers") return res({ data: [], error: null });
        if (table === "groups") return res({ data: (o.teacherOf ?? [G1]).map((id) => ({ id, name: "AC CHALLENGE | 1-GURUH" })), error: null });
        return res({ data: [], error: null });
      },
    };
    return b;
  };
  const deps = {
    call: (method: string, payload: Row) => {
      calls.push({ method, payload });
      if (o.failPost && payload.chat_id === Q.chat_id) return Promise.resolve({ ok: false, result: null, error: "Bad Request: not enough rights" });
      return Promise.resolve({ ok: true, result: { message_id: 999 }, error: null });
    },
    isMenuButton: (t: string) => t === "❓ Savollar",
  };
  return { admin: { from }, deps, calls, updates, actions, deleted };
}

const teacher = { id: "t1", isAdmin: false };
const textMsg = (text: string) => ({ message_id: 50, chat: { id: 901 }, from: { id: 901 }, text });

Deno.test("✍️ answer: posted in the topic as a reply to the question, the student gets it in a DM, the question closes", async () => {
  const w = world();
  await deliverTqAnswer(w.admin, 12, teacher, textMsg("Ha, Higgsfield ichida yoʻq — alohida olasiz."), w.deps);
  const post = w.calls.find((c) => c.payload.chat_id === Q.chat_id)!;
  assertEquals(post.method, "sendMessage");
  assertEquals(post.payload.message_thread_id, 2);
  assertEquals(post.payload.reply_parameters.message_id, 345);
  assertStringIncludes(post.payload.text, "Kurator javobi");
  assertStringIncludes(post.payload.text, "alohida olasiz");
  const closed = w.updates.find((u) => u.table === "teacher_questions")!;
  assertEquals(closed.patch.status, "answered");
  assertEquals(closed.patch.answered_via, "bot");
  assertEquals(closed.patch.answer_message_id, 999);
  assertEquals(closed.filters.status, "open");
  const dm = w.calls.find((c) => c.payload.chat_id === 777)!;
  assertStringIncludes(dm.payload.text, "Savolingizga javob keldi");
  assertStringIncludes(dm.payload.text, "https://t.me/c/4440955972/2/999");
  assertStringIncludes(w.calls.at(-1)!.payload.text, "oʻquvchiga botda ham yetkazildi");
});

Deno.test("a voice / photo answer is copied with the header as its caption", async () => {
  const w = world();
  await deliverTqAnswer(w.admin, 12, teacher, { message_id: 51, chat: { id: 901 }, from: { id: 901 }, voice: { file_id: "v" } }, w.deps);
  const post = w.calls.find((c) => c.payload.chat_id === Q.chat_id)!;
  assertEquals(post.method, "copyMessage");
  assertEquals(post.payload.from_chat_id, 901);
  assertStringIncludes(post.payload.caption, "Kurator javobi");
});

Deno.test("the group refuses the post: the question stays open, the teacher can retry, and it is DB-visible", async () => {
  const w = world({ failPost: true });
  await deliverTqAnswer(w.admin, 12, teacher, textMsg("javob"), w.deps);
  assertEquals(w.updates.filter((u) => u.table === "teacher_questions").length, 0);
  assert(w.actions.some((a) => a.action === "teacher_question_answer_failed"));
  assertEquals(w.calls.at(-1)!.payload.reply_markup.inline_keyboard[0][0].callback_data, "tq:r:12");
  assert(!w.calls.some((c) => c.payload.chat_id === 777));
});

Deno.test("a student the bot cannot write to: answered in the group only, and the teacher is told so", async () => {
  const w = world({ studentDm: false });
  await deliverTqAnswer(w.admin, 12, teacher, textMsg("javob"), w.deps);
  assert(!w.calls.some((c) => c.payload.chat_id === 777));
  assertStringIncludes(w.calls.at(-1)!.payload.text, "u guruhda koʻradi");
});

Deno.test("another group's question is refused (callback data is client-supplied)", async () => {
  const w = world({ teacherOf: ["99999999-9999-4999-8999-999999999999"] });
  await deliverTqAnswer(w.admin, 12, teacher, textMsg("javob"), w.deps);
  assert(!w.calls.some((c) => c.payload.chat_id === Q.chat_id));
  assertStringIncludes(w.calls.at(-1)!.payload.text, "⛔");
  const v = world({ teacherOf: ["99999999-9999-4999-8999-999999999999"] });
  await handleTqCallback(v.admin, { kind: "done", id: 12 }, { chatId: 901, messageId: null, viewer: teacher, tgId: 901 }, v.deps);
  assertEquals(v.updates.filter((u) => u.table === "teacher_questions").length, 0);
});

Deno.test("while waiting for the answer, a menu button or a /command ends the wait and is not taken as the answer", async () => {
  const live = { state: TQ_ANSWER_STATE, context: { question_id: 12 }, expires_at: new Date(Date.now() + 60_000).toISOString() };
  const w = world({ state: live });
  assertEquals(await captureTqAnswer(w.admin, textMsg("❓ Savollar"), teacher, w.deps), false);
  assert(w.deleted.some((d) => d.table === "bot_conversation_state"));
  assert(!w.calls.some((c) => c.payload.chat_id === Q.chat_id));
  const x = world({ state: live });
  assertEquals(await captureTqAnswer(x.admin, textMsg("Ha, alohida olasiz"), teacher, x.deps), true);
  assert(x.calls.some((c) => c.payload.chat_id === Q.chat_id));
  const none = world({ state: null });
  assertEquals(await captureTqAnswer(none.admin, textMsg("salom"), teacher, none.deps), false);
});

Deno.test("✅ closes an open question once, with ↩️ undo", async () => {
  const w = world();
  await handleTqCallback(w.admin, { kind: "done", id: 12 }, { chatId: 901, messageId: null, viewer: teacher, tgId: 901 }, w.deps);
  const u = w.updates.find((x) => x.table === "teacher_questions")!;
  assertEquals(u.patch.answered_via, "manual");
  assertEquals(u.filters.status, "open");
  assertEquals(w.calls.at(-1)!.payload.reply_markup.inline_keyboard[0][0].callback_data, "tq:u:12");
});

Deno.test("an album answer: the first part claims the wait and gets the heading, the other parts follow under it", async () => {
  const live = { state: TQ_ANSWER_STATE, context: { question_id: 12 }, expires_at: new Date(Date.now() + 60_000).toISOString() };
  const w = world({ state: live });
  const part = (id: number) => ({ message_id: id, chat: { id: 901 }, from: { id: 901 }, media_group_id: "alb1", photo: [{}] });
  assertEquals(await captureTqAnswer(w.admin, part(60), teacher, w.deps), true);
  const claim = w.updates.find((u) => u.table === "bot_conversation_state")!;
  assertEquals(claim.patch.state, TQ_ALBUM_STATE);
  assertEquals(claim.patch.context.media_group_id, "alb1");
  assertStringIncludes(w.calls.find((c) => c.payload.chat_id === Q.chat_id)!.payload.caption, "Kurator javobi");

  const albumState = { state: TQ_ALBUM_STATE, context: { question_id: 12, media_group_id: "alb1" }, expires_at: new Date(Date.now() + 60_000).toISOString() };
  const x = world({ state: albumState });
  assertEquals(await captureTqAnswer(x.admin, part(61), teacher, x.deps), true);
  const sib = x.calls.find((c) => c.payload.chat_id === Q.chat_id)!;
  assertEquals(sib.method, "copyMessage");
  assertEquals(sib.payload.reply_parameters.message_id, 345);
  assertEquals(sib.payload.caption, undefined);
  // a later, unrelated message after the album is NOT posted
  const y = world({ state: albumState });
  assertEquals(await captureTqAnswer(y.admin, textMsg("boshqa narsa"), teacher, y.deps), false);
  assert(!y.calls.some((c) => c.payload.chat_id === Q.chat_id));
});

Deno.test("a sticker answer gets the heading as its own reply first (stickers take no caption)", async () => {
  const w = world();
  await deliverTqAnswer(w.admin, 12, teacher, { message_id: 52, chat: { id: 901 }, from: { id: 901 }, sticker: { file_id: "s" } }, w.deps);
  const posts = w.calls.filter((c) => c.payload.chat_id === Q.chat_id);
  assertEquals(posts.map((p) => p.method), ["sendMessage", "copyMessage"]);
  assertStringIncludes(posts[0].payload.text, "Kurator javobi");
  assertEquals(posts[1].payload.caption, undefined);
});
