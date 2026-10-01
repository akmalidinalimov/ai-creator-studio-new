// Flow tests for the bot's daily-task I/O (Daily Tasks PR-4) over a fake service-role client and a recording
// Bot API sender — no network, no database. Run: deno test supabase/functions/telegram-bot-webhook/daily-tasks.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createDailyTasks, type SendFn } from "./daily-tasks.ts";
import type { SendResultOutcome } from "../_shared/telegram-send.ts";

const COURSE = "f502f631-2104-4834-b6c2-702cd3080e27";
const CHAT1 = -1004440955972; // 1-GURUH, daily topic 144
const TOPICS = [{ group_id: "g1", course_id: COURSE, chat_id: CHAT1, thread_id: 144, is_test: false }];
const ACTIVE = { active: true, enabled: true, auto_register: true, receipts: true };
const PAUSED = { active: false, enabled: false, auto_register: true, receipts: true };

type Call = { table: string; op: string; filters: unknown[][]; payload?: any; select?: string };
type Res = { data?: unknown; error?: { code?: string; message?: string } | null };

function fakeDb(h: { rpc?: Record<string, (args: any) => Res>; table?: (c: Call) => Res | undefined }) {
  const rpcCalls: { name: string; args: any }[] = [];
  const inserts: { table: string; row: any }[] = [];
  const reads: Call[] = [];
  const from = (table: string) => {
    const c: Call = { table, op: "select", filters: [] };
    const exec = () => {
      if (c.op === "insert") {
        inserts.push({ table, row: c.payload });
        return Promise.resolve({ data: null, error: null });
      }
      reads.push(c);
      const r = h.table?.(c) ?? {};
      return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
    };
    const f = (k: string) => (...a: unknown[]) => { c.filters.push([k, ...a]); return q; };
    const q: any = {
      select: (s: string) => { if (c.op === "select") c.select = s; return q; },
      insert: (row: any) => { c.op = "insert"; c.payload = row; return exec(); },
      update: (p: any) => { c.op = "update"; c.payload = p; return q; },
      eq: f("eq"), is: f("is"), not: f("not"), or: f("or"), ilike: f("ilike"), in: f("in"), gte: f("gte"),
      order: () => q, limit: f("limit"),
      maybeSingle: () => exec(),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => exec().then(res, rej),
    };
    return q;
  };
  const rpc = (name: string, args: any) => {
    rpcCalls.push({ name, args });
    const fn = h.rpc?.[name];
    const r = fn ? fn(args) : { error: { code: "PGRST202", message: "Could not find the function" } };
    return Promise.resolve({ data: r.data ?? null, error: r.error ?? null });
  };
  return { db: { rpc, from }, rpcCalls, inserts, reads };
}

function outcome(klass: SendResultOutcome["klass"] = "ok", extra: Partial<SendResultOutcome> = {}): SendResultOutcome {
  const ok = klass === "ok" || klass === "not_modified";
  return {
    ok, status: ok ? 200 : 400, error: ok ? null : klass, klass, retryAfterSec: null,
    terminal: ["recipient", "content", "topic_missing", "message_gone"].includes(klass),
    recipient: klass === "recipient", content: klass === "content", ...extra,
  };
}

function recorder(script: (method: string, payload: any) => { outcome: SendResultOutcome; result: any } = () => ({ outcome: outcome(), result: { message_id: 9001 } })) {
  const sent: { method: string; payload: any; opts: any }[] = [];
  const send: SendFn = (method, payload, opts) => {
    sent.push({ method, payload, opts });
    return Promise.resolve(script(method, payload));
  };
  return { send, sent };
}

function tasks(send: SendFn, extra: Partial<Parameters<typeof createDailyTasks>[0]> = {}) {
  const answers: { id: string; text?: string }[] = [];
  const reg: { calls: number } = { calls: 0 };
  const dt = createDailyTasks({
    send,
    answerCallback: (id, text) => { answers.push({ id, text }); return Promise.resolve(); },
    botUsername: () => "aicreatorsdarsliklari_bot",
    autoRegister: () => {
      reg.calls++;
      return Promise.resolve({ profile: { id: "new-user", name: "Nodira" }, created: true });
    },
    magicLink: () => Promise.resolve("https://aicreator.academy/auth/magic?t=tok"),
    ...extra,
  });
  return { dt, answers, reg };
}

const baseRpc = (cfg: unknown) => ({
  challenge_task_topics: () => ({ data: TOPICS }),
  challenge_tasks_config: () => ({ data: cfg }),
});

function msg(over: Record<string, unknown> = {}) {
  return {
    message_id: 900, date: 1759640400, message_thread_id: 144,
    chat: { id: CHAT1, type: "supergroup" }, from: { id: 5001, is_bot: false, first_name: "Ali", username: "ali_uz" },
    photo: [{ file_id: "f", file_unique_id: "u" }], caption: "Mening ishim", ...over,
  };
}

function createdPayload(over: Record<string, unknown> = {}) {
  return {
    status: "ok", outcome: "created", user_id: "u1", resolved_via: "telegram_id",
    submission: { id: 41, status: "accepted", missing: [], points: 5, late_days: 0, attempts_left: 3, moved_count: 0,
      receipt_version: 1, task: { id: 7, date: "2026-10-05", type: "general" } },
    alternatives: [{ task_id: 6, date: "2026-10-04", rel: "yesterday" }],
    streak: { days: 1 }, reaction: "👍",
    receipt: { send: true, mode: "reply", carries_welcome: false, reply_to_message_id: 900, receipt_message_id: null, version: 1 },
    ...over,
  };
}

const profilesByName = (c: Call): Res | undefined =>
  c.table === "profiles" && c.select === "name" ? { data: { name: "Ali Valiyev" } } : undefined;

Deno.test("INERT: challenge_tasks.enabled=false → handled:false, no capture RPC, nothing sent", async () => {
  const f = fakeDb({ rpc: baseRpc(PAUSED) });
  const r = recorder();
  const { dt } = tasks(r.send);
  const out = await dt.onGroupMessage(f.db, msg());
  assertEquals(out.handled, false);
  assertEquals(f.rpcCalls.map((c) => c.name).sort(), ["challenge_task_topics", "challenge_tasks_config"]);
  assertEquals(r.sent.length, 0);
  assertEquals(f.inserts.length, 0); // a normal pause is not a failure signal
});

Deno.test("fail closed: the config RPC missing (PR-3 not applied) → handled:false + ONE capture_failed signal", async () => {
  const f = fakeDb({ rpc: { challenge_task_topics: () => ({ data: TOPICS }) } });
  const r = recorder();
  const { dt } = tasks(r.send);
  assertEquals((await dt.onGroupMessage(f.db, msg())).handled, false);
  assertEquals((await dt.onGroupMessage(f.db, msg({ message_id: 901 }))).handled, false);
  const rows = f.inserts.filter((i) => i.row.action === "challenge_task_capture_failed");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].row.details.reason, "config_unavailable");
  assertEquals(f.rpcCalls.some((c) => c.name === "challenge_task_capture"), false);
});

Deno.test("not a daily topic (same thread number, another chat / the homework topic) → handled:false, no capture", async () => {
  const f = fakeDb({ rpc: { ...baseRpc(ACTIVE), challenge_task_capture: () => ({ data: createdPayload() }) } });
  const r = recorder();
  const { dt } = tasks(r.send);
  assertEquals((await dt.onGroupMessage(f.db, msg({ chat: { id: -1004390902020, type: "supergroup" } }))).handled, false);
  assertEquals((await dt.onGroupMessage(f.db, msg({ message_thread_id: 3 }))).handled, false);
  assertEquals((await dt.onGroupMessage(f.db, msg({ message_thread_id: undefined }))).handled, false);
  assertEquals(f.rpcCalls.some((c) => c.name === "challenge_task_capture"), false);
});

Deno.test("created → one reply receipt in the thread (buttons, reply_parameters), recorded with Telegram's message_id", async () => {
  const f = fakeDb({
    rpc: {
      ...baseRpc(ACTIVE),
      challenge_task_capture: () => ({ data: createdPayload() }),
      challenge_task_receipt_record: () => ({ data: { ok: true } }),
    },
    table: profilesByName,
  });
  const r = recorder();
  const { dt } = tasks(r.send);
  const out = await dt.onGroupMessage(f.db, msg());
  assertEquals(out, { handled: true, outcome: "created" });
  const cap = f.rpcCalls.find((c) => c.name === "challenge_task_capture")!;
  assertEquals(cap.args._source, "topic");
  assertEquals(cap.args._msg.message_id, 900);
  assertEquals(r.sent.length, 1); // the reply IS the acknowledgement: no extra reaction call
  const s = r.sent[0];
  assertEquals(s.method, "sendMessage");
  assertEquals(s.payload.chat_id, CHAT1);
  assertEquals(s.payload.message_thread_id, 144);
  assertEquals(s.payload.reply_parameters, { message_id: 900, allow_sending_without_reply: true });
  assertEquals(s.payload.text, "✅ Bugungi vazifa qabul qilindi: +5 ball.");
  assertEquals(s.payload.reply_markup.inline_keyboard[0][0].callback_data, "dt:m:41:6");
  assertEquals(s.payload.reply_markup.inline_keyboard[1][0].callback_data, "dt:x:41");
  assertEquals(s.opts.topicMissingAction, "challenge_task_topic_missing");
  const rec = f.rpcCalls.find((c) => c.name === "challenge_task_receipt_record")!;
  assertEquals(rec.args, { _sub: 41, _version: 1, _chat_id: CHAT1, _message_id: 9001, _ok: true, _error: null, _token: null });
});

Deno.test("the engine paused between snapshot and capture ('disabled') → fall through to today's handler", async () => {
  const f = fakeDb({ rpc: { ...baseRpc(ACTIVE), challenge_task_capture: () => ({ data: { status: "ok", outcome: "disabled" } }) } });
  const r = recorder();
  const { dt } = tasks(r.send);
  assertEquals((await dt.onGroupMessage(f.db, msg())).handled, false);
  assertEquals(r.sent.length, 0);
});

Deno.test("capture RPC error → fall through + a DB-visible capture_failed row (deduped per 10 minutes)", async () => {
  const f = fakeDb({ rpc: { ...baseRpc(ACTIVE), challenge_task_capture: () => ({ error: { code: "57014", message: "canceling statement due to statement timeout" } }) } });
  const r = recorder();
  const { dt } = tasks(r.send, { now: () => 1_000_000 });
  assertEquals((await dt.onGroupMessage(f.db, msg())).handled, false);
  assertEquals((await dt.onGroupMessage(f.db, msg({ message_id: 901 }))).handled, false);
  const rows = f.inserts.filter((i) => i.row.action === "challenge_task_capture_failed");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].row.details.reason, "rpc_error");
  assertEquals(rows[0].row.details.code, "57014");
});

Deno.test("the engine refusing the message itself (status error) → fall through + an 'engine_error' signal", async () => {
  const f = fakeDb({ rpc: { ...baseRpc(ACTIVE), challenge_task_capture: () => ({ data: { status: "error", outcome: "error", reason: "bad_date" } }) } });
  const r = recorder();
  const out = await tasks(r.send).dt.onGroupMessage(f.db, msg({ date: undefined }));
  assertEquals(out, { handled: false, outcome: "error" });
  assertEquals(r.sent.length, 0);
  const row = f.inserts.find((i) => i.row.action === "challenge_task_capture_failed");
  assertEquals(row?.row.details.reason, "engine_error");
  assertEquals(row?.row.details.engine_reason, "bad_date");
});

Deno.test("unknown shaped sender → resolveGroupPoster → auto-register → capture again with {welcome:true} → welcome in the receipt", async () => {
  let n = 0;
  const f = fakeDb({
    rpc: {
      ...baseRpc(ACTIVE),
      challenge_task_capture: (a) => {
        n++;
        if (n === 1) return { data: { status: "ok", outcome: "unknown_sender", shaped: true, group_id: "g1" } };
        assertEquals(a._opts, { welcome: true });
        return { data: createdPayload({ user_id: "new-user", receipt: { send: true, mode: "reply", carries_welcome: true, reply_to_message_id: 900, version: 1 } }) };
      },
      challenge_task_receipt_record: () => ({ data: { ok: true } }),
    },
    table: (c) => {
      if (c.table === "profiles" && c.select === "name") return { data: { name: "Nodira" } };
      if (c.table === "profiles" && c.filters.some((x) => x[0] === "eq" && x[1] === "telegram_id")) return { data: null };
      if (c.table === "profiles") return { data: [] }; // no profile carries the username
      if (c.table === "groups") return { data: [{ id: "g1", course_id: COURSE, homework_topic_id: 3, daily_task_topic_id: 144 }] };
      return undefined;
    },
  });
  const r = recorder();
  const { dt, reg } = tasks(r.send);
  const out = await dt.onGroupMessage(f.db, msg({ from: { id: 7777, is_bot: false, first_name: "Nodira", username: "nodira" } }));
  assertEquals(out.handled, true);
  assertEquals(reg.calls, 1);
  assertEquals(n, 2);
  assert(r.sent[0].payload.text.startsWith("👋 <b>Nodira</b>, siz AI Creators platformasiga qo‘shildingiz"));
  assertEquals(r.sent[0].payload.reply_markup.inline_keyboard[1][1].url, "https://t.me/aicreatorsdarsliklari_bot?start=dt_7");
});

Deno.test("unknown sender whose post is NOT work-shaped → silent (no registration, no send)", async () => {
  const f = fakeDb({ rpc: { ...baseRpc(ACTIVE), challenge_task_capture: () => ({ data: { status: "ok", outcome: "unknown_sender", shaped: false } }) } });
  const r = recorder();
  const { dt, reg } = tasks(r.send);
  assertEquals((await dt.onGroupMessage(f.db, msg())).handled, true);
  assertEquals(reg.calls, 0);
  assertEquals(r.sent.length, 0);
});

Deno.test("held sender → the neutral once-a-day hint, NO button, no receipt", async () => {
  const f = fakeDb({
    rpc: { ...baseRpc(ACTIVE), challenge_task_capture: () => ({ data: { status: "ok", outcome: "no_group", user_id: "u1", hint: { kind: "held", url: null } } }) },
    table: profilesByName,
  });
  const r = recorder();
  const { dt } = tasks(r.send);
  assertEquals((await dt.onGroupMessage(f.db, msg())).handled, true);
  assertEquals(r.sent.length, 1);
  assert(r.sent[0].payload.text.startsWith("📌 Ali, ishingizni hisoblash uchun"));
  assertEquals(r.sent[0].payload.reply_markup, undefined);
  assertEquals(f.rpcCalls.some((c) => c.name === "challenge_task_receipt_record"), false);
});

Deno.test("comment / silent outcomes → nothing sent; an extra → only a 👍 reaction", async () => {
  const f = fakeDb({ rpc: { ...baseRpc(ACTIVE), challenge_task_capture: () => ({ data: { status: "ok", outcome: "comment", reason: "short_text" } }) } });
  const r = recorder();
  const { dt } = tasks(r.send);
  assertEquals((await dt.onGroupMessage(f.db, msg({ photo: undefined, text: "rahmat" }))).handled, true);
  assertEquals(r.sent.length, 0);
  const f2 = fakeDb({
    rpc: { ...baseRpc(ACTIVE), challenge_task_capture: () => ({ data: createdPayload({ outcome: "appended_extra", receipt: { send: false, mode: "none" } }) }) },
  });
  const r2 = recorder();
  await tasks(r2.send).dt.onGroupMessage(f2.db, msg());
  assertEquals(r2.sent.map((s) => s.method), ["setMessageReaction"]);
  assertEquals(r2.sent[0].payload.reaction, [{ type: "emoji", emoji: "👍" }]);
  assertEquals(r2.sent[0].opts.record, false);
});

Deno.test("rate-limited receipt → NOT recorded (stays 'sending' for the worker); topic missing → recorded failed", async () => {
  const mk = (klass: SendResultOutcome["klass"]) => {
    const f = fakeDb({
      rpc: { ...baseRpc(ACTIVE), challenge_task_capture: () => ({ data: createdPayload() }), challenge_task_receipt_record: () => ({ data: { ok: true } }) },
      table: profilesByName,
    });
    const r = recorder(() => ({ outcome: outcome(klass, klass === "rate_limited" ? { retryAfterSec: 9 } : {}), result: null }));
    return { f, r };
  };
  const a = mk("rate_limited");
  await tasks(a.r.send).dt.onGroupMessage(a.f.db, msg());
  assertEquals(a.f.rpcCalls.some((c) => c.name === "challenge_task_receipt_record"), false);
  const b = mk("topic_missing");
  await tasks(b.r.send).dt.onGroupMessage(b.f.db, msg());
  const rec = b.f.rpcCalls.find((c) => c.name === "challenge_task_receipt_record")!;
  assertEquals(rec.args._ok, false);
  assertEquals(rec.args._message_id, null);
  assert(String(rec.args._error).startsWith("topic_missing"));
});

Deno.test("edit mode → editMessageText on the recorded receipt (a reaction on the new item), recorded", async () => {
  const f = fakeDb({
    rpc: {
      ...baseRpc(ACTIVE),
      challenge_task_capture: () => ({ data: createdPayload({ outcome: "appended", reaction: "👀",
        submission: { id: 41, status: "checking", missing: [], late_days: 0, receipt_version: 3, task: { id: 7, date: "2026-10-05" } },
        receipt: { send: true, mode: "edit", receipt_message_id: 555, version: 3 } }) }),
      challenge_task_receipt_record: () => ({ data: { ok: true } }),
    },
    table: profilesByName,
  });
  const r = recorder(() => ({ outcome: outcome("not_modified"), result: null }));
  await tasks(r.send).dt.onGroupMessage(f.db, msg({ message_id: 901 }));
  assertEquals(r.sent.map((s) => s.method), ["editMessageText", "setMessageReaction"]);
  assertEquals(r.sent[0].payload.message_id, 555);
  const rec = f.rpcCalls.find((c) => c.name === "challenge_task_receipt_record")!;
  assertEquals([rec.args._ok, rec.args._message_id, rec.args._version], [true, 555, 3]); // not_modified = success
});

Deno.test("dt: callback — not the owner → a friendly toast only; withdraw ok → the receipt shows undo, recorded", async () => {
  const f1 = fakeDb({ rpc: { challenge_task_withdraw_by_tg: () => ({ data: { ok: false, reason: "not_owner" } }) } });
  const r1 = recorder();
  const t1 = tasks(r1.send);
  await t1.dt.onCallback(f1.db, { id: "cb1", data: "dt:x:41", from: { id: 6006 }, message: { message_id: 9001, chat: { id: CHAT1 } } });
  assertEquals(t1.answers, [{ id: "cb1", text: "Bu boshqa o‘quvchining ishi 🙂" }]);
  assertEquals(r1.sent.length, 0);
  assertEquals(f1.rpcCalls[0].args, { _tg_user: 6006, _sub: 41 });

  const f2 = fakeDb({
    rpc: {
      ...baseRpc(ACTIVE),
      challenge_task_withdraw_by_tg: () => ({ data: { ok: true, outcome: "withdrawn", user_id: "u1",
        submission: { id: 41, status: "withdrawn", receipt_version: 2, task: { id: 7, date: "2026-10-05" } } } }),
      challenge_task_receipt_record: () => ({ data: { ok: true } }),
    },
    table: (c) => c.table === "challenge_task_submissions" ? { data: { receipt_carries_welcome: false, receipt_chat_id: CHAT1, receipt_message_id: 9001 } } : profilesByName(c),
  });
  const r2 = recorder();
  const t2 = tasks(r2.send);
  await t2.dt.onCallback(f2.db, { id: "cb2", data: "dt:x:41", from: { id: 5001 }, message: { message_id: 9001, chat: { id: CHAT1 } } });
  assertEquals(t2.answers[0].text, "❌ Hisobdan chiqarildi. Qaytarish uchun «↩️ Qaytarish».");
  assertEquals(r2.sent[0].method, "editMessageText");
  assertEquals(r2.sent[0].payload.reply_markup, { inline_keyboard: [[{ text: "↩️ Qaytarish", callback_data: "dt:r:41" }]] });
  const rec = f2.rpcCalls.find((c) => c.name === "challenge_task_receipt_record")!;
  assertEquals([rec.args._sub, rec.args._version, rec.args._message_id], [41, 2, 9001]);
});

Deno.test("dt: callback — a move that MERGES: the tapped receipt reads 'merged' (no buttons), the target receipt is refreshed", async () => {
  const f = fakeDb({
    rpc: {
      ...baseRpc(ACTIVE),
      challenge_task_move_by_tg: (a) => {
        assertEquals(a, { _tg_user: 5001, _sub: 41, _target_task: 6 });
        return { data: { ok: true, outcome: "moved", user_id: "u1", from_submission_id: 41,
          submission: { id: 40, status: "accepted", points: 3, late_days: 1, receipt_version: 5, task: { id: 6, date: "2026-10-04" } } } };
      },
      challenge_task_receipt_record: () => ({ data: { ok: true } }),
    },
    table: (c) => {
      if (c.table === "challenge_task_submissions") {
        const id = c.filters.find((x) => x[0] === "eq" && x[1] === "id")?.[2];
        return { data: id === 40 ? { receipt_carries_welcome: false, receipt_chat_id: CHAT1, receipt_message_id: 7000 } : { receipt_chat_id: CHAT1, receipt_message_id: 9001 } };
      }
      return profilesByName(c);
    },
  });
  const r = recorder();
  const t = tasks(r.send);
  await t.dt.onCallback(f.db, { id: "cb3", data: "dt:m:41:6", from: { id: 5001 }, message: { message_id: 9001, chat: { id: CHAT1 } } });
  assertEquals(t.answers[0].text, "✅ Ko‘chirildi");
  assertEquals(r.sent.map((s) => [s.method, s.payload.message_id]), [["editMessageText", 9001], ["editMessageText", 7000]]);
  assertEquals(r.sent[0].payload.reply_markup, { inline_keyboard: [] });
  assert(r.sent[1].payload.text.startsWith("✅ Kechagi vazifa (4-oktabr) uchun qabul qilindi"));
  const recs = f.rpcCalls.filter((c) => c.name === "challenge_task_receipt_record");
  assertEquals(recs.map((c) => [c.args._sub, c.args._message_id]), [[40, 7000]]);
});

Deno.test("dt: callback — forged data is answered and ignored; an RPC error is a friendly toast + a signal", async () => {
  const f = fakeDb({});
  const r = recorder();
  const t = tasks(r.send);
  await t.dt.onCallback(f.db, { id: "cb4", data: "dt:x:abc", from: { id: 1 } });
  assertEquals(t.answers, [{ id: "cb4", text: undefined }]);
  assertEquals(f.rpcCalls.length, 0);
  await t.dt.onCallback(f.db, { id: "cb5", data: "dt:r:41", from: { id: 1 } });
  assertEquals(t.answers[1].text, "Hozircha bo‘lmadi — birozdan so‘ng qayta urinib ko‘ring.");
  assertEquals(f.inserts[0].row.details.reason, "callback_rpc_missing");
});

Deno.test("edited_message: item_edited re-judges; the receipt is refreshed only when one exists; inert when paused", async () => {
  const f = fakeDb({
    rpc: {
      ...baseRpc(ACTIVE),
      challenge_task_item_edited: () => ({ data: { status: "ok", outcome: "edited", user_id: "u1",
        submission: { id: 41, status: "needs_more", missing: ["text"], receipt_message_id: 555, receipt_version: 4, task: { id: 7, date: "2026-10-05" } } } }),
      challenge_task_receipt_record: () => ({ data: { ok: true } }),
    },
    table: (c) => c.table === "challenge_task_submissions" ? { data: { receipt_carries_welcome: false, receipt_chat_id: CHAT1, receipt_message_id: 555 } } : profilesByName(c),
  });
  const r = recorder();
  await tasks(r.send).dt.onEdited(f.db, msg());
  assertEquals(r.sent.map((s) => [s.method, s.payload.message_id]), [["editMessageText", 555]]);
  const paused = fakeDb({ rpc: baseRpc(PAUSED) });
  const r2 = recorder();
  await tasks(r2.send).dt.onEdited(paused.db, msg());
  assertEquals(paused.rpcCalls.some((c) => c.name === "challenge_task_item_edited"), false);
  assertEquals(r2.sent.length, 0);
});

Deno.test("my_chat_member: recorded only for a chat that holds a daily topic", async () => {
  const mcm = { chat: { id: CHAT1, type: "supergroup" }, from: { id: 1 }, date: 1,
    old_chat_member: { status: "administrator" }, new_chat_member: { status: "member", can_manage_topics: false } };
  const f = fakeDb({ table: (c) => c.table === "groups" ? { data: [{ id: "g1" }] } : undefined });
  await tasks(recorder().send).dt.onMyChatMember(f.db, mcm);
  assertEquals(f.inserts.length, 1);
  assertEquals(f.inserts[0].row.action, "challenge_bot_status_changed");
  assertEquals(f.inserts[0].row.details.chat, CHAT1);
  assertEquals(f.inserts[0].row.details.new_status, "member");
  const g = fakeDb({ table: (c) => c.table === "groups" ? { data: [] } : undefined });
  await tasks(recorder().send).dt.onMyChatMember(g.db, { ...mcm, chat: { id: 123, type: "private" } });
  assertEquals(g.inserts.length, 0);
});

Deno.test("/start dt_<id>: the card in DM with the topic button; an RPC failure is friendly + signalled; /start ig", async () => {
  const f = fakeDb({ rpc: { challenge_task_card: (a) => {
    assertEquals(a, { _task_id: 7, _tg_user: 5001 });
    return { data: { ok: true, enabled: true, text: "📅 <b>1-kun vazifasi</b>", topic_url: "https://t.me/c/4440955972/144", closed: false } };
  } } });
  const r = recorder();
  const t = tasks(r.send);
  const dm = msg({ chat: { id: 5001, type: "private" }, message_thread_id: undefined });
  assertEquals(await t.dt.onStart(f.db, dm, "dt_7", "uz", { id: "u1" }), true);
  assertEquals(r.sent[0].payload.chat_id, 5001);
  assertEquals(r.sent[0].payload.reply_markup.inline_keyboard[0][0].url, "https://t.me/c/4440955972/144");
  const bad = fakeDb({});
  const r2 = recorder();
  assertEquals(await tasks(r2.send).dt.onStart(bad.db, dm, "dt_7", "uz", { id: "u1" }), true);
  assertEquals(r2.sent[0].payload.text, "Hozircha ochib bo‘lmadi — birozdan so‘ng qayta urinib ko‘ring.");
  assertEquals(bad.inserts[0].row.details.reason, "card_rpc_missing");
  const ig = fakeDb({ table: (c) => c.table === "profiles" ? { data: { instagram_username: "ali_uz" } } : undefined });
  const r3 = recorder();
  assertEquals(await tasks(r3.send).dt.onStart(ig.db, dm, "ig", "uz", { id: "u1" }), true);
  assert(r3.sent[0].payload.text.includes("@ali_uz"));
  assertEquals(r3.sent[0].payload.reply_markup.inline_keyboard[0][0].url, "https://aicreator.academy/auth/magic?t=tok");
  assertEquals(await tasks(recorder().send).dt.onStart(f.db, dm, "login_x", "uz", { id: "u1" }), false);
});

Deno.test("U1 daily-topic link and the misplaced-homework counter: only while active and only for scope groups", async () => {
  const f = fakeDb({ rpc: baseRpc(ACTIVE), table: (c) => c.table === "groups" ? { data: { daily_task_topic_url: "https://t.me/c/4440955972/144" } } : undefined });
  const t = tasks(recorder().send).dt;
  assertEquals(await t.dailyTopicUrlFor(f.db, "g1"), "https://t.me/c/4440955972/144");
  assertEquals(await t.dailyTopicUrlFor(f.db, "other"), null);
  await t.noteMisplacedHomework(f.db, { id: "p1", group_id: "g1", user_id: "u1", telegram_chat_id: CHAT1, telegram_thread_id: 3, first_message_id: 10 }, "created");
  await t.noteMisplacedHomework(f.db, { id: "p2", group_id: "other" }, "created");
  assertEquals(f.inserts.map((i) => i.row.action), ["challenge_task_misplaced_homework"]);
  const p = fakeDb({ rpc: baseRpc(PAUSED) });
  const tp = tasks(recorder().send).dt;
  assertEquals(await tp.dailyTopicUrlFor(p.db, "g1"), null);
  await tp.noteMisplacedHomework(p.db, { id: "p1", group_id: "g1" }, "created");
  assertEquals(p.inserts.length, 0);
});
