// Run: deno test supabase/functions/telegram-bot-webhook/voice-bridge.test.ts
// End to end on an in-memory bot_conversation_state: teacher-voice-request's parking (parkVoiceRequest + the
// prompt stamp) → the teacher's voice notes → the "who is this for?" buttons. Every scenario interleaves two
// requests (Aziza's card, then Bobur's) — the sequence that used to send Aziza's feedback to Bobur (audit FB-4).
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FakeConvDb } from "../_shared/conv-state-fake.ts";
import { normalizeVoiceState, parkVoiceRequest, stampVoicePromptIo, type VoiceRequest } from "../_shared/voice-requests.ts";
import { cancelVoiceRequests, onBridgeVoice, onVoicePick, pickButtonText, remainingLine, type VoiceBridgeDeps } from "./voice-bridge.ts";

const T0 = Date.parse("2026-10-01T09:00:00Z");
const MIN = 60_000;
const TEACHER = 777001;
const SUB_A = "aaaaaaaa-1111-4111-8111-111111111111";
const SUB_B = "bbbbbbbb-2222-4222-8222-222222222222";
const A = { submission_id: SUB_A, label: "5.0 · 1-GURUH PRE · M2 V1 — Prompt engineering", student: "Aziza Karimova" };
const B = { submission_id: SUB_B, label: "CH6 · AC CHALLENGE | 3-GURUH · M2 V1 — Prompt engineering", student: "Bobur Aliyev" };

type Sent = { chatId: number; text: string; markup?: any; mid: number };

function harness(db: FakeConvDb, nowMs: number) {
  const sent: Sent[] = [];
  const edits: { mid: number; text: string; markup?: any }[] = [];
  const answers: { id: string; text?: string }[] = [];
  const commits: { submission_id: string; file_id: string; remaining: number }[] = [];
  let mid = 500;
  let tok = 0;
  const deps: VoiceBridgeDeps = {
    admin: db,
    actorId: "teacher-profile",
    send: (chatId, text, markup) => {
      const m = ++mid;
      sent.push({ chatId, text, markup, mid: m });
      return Promise.resolve(m);
    },
    edit: (_c, m, text, markup) => {
      edits.push({ mid: m, text, markup });
      return Promise.resolve();
    },
    answer: (id, text) => {
      answers.push({ id, text });
      return Promise.resolve();
    },
    commit: (req: VoiceRequest, voice, remaining) => {
      commits.push({ submission_id: req.submission_id, file_id: voice.file_id, remaining });
      return Promise.resolve();
    },
    now: () => nowMs,
    newToken: () => `0000000${++tok}`.slice(-8),
  };
  return { deps, sent, edits, answers, commits };
}

/** teacher-voice-request, twice: Aziza at T0 (prompt 101), Bobur at T0+2min (prompt 102). */
async function parkBoth(db: FakeConvDb) {
  await parkVoiceRequest(db, TEACHER, A, { now: () => T0, rid: "aaaa0001" });
  await stampVoicePromptIo(db, TEACHER, "aaaa0001", 101, { now: () => T0 });
  await parkVoiceRequest(db, TEACHER, B, { now: () => T0 + 2 * MIN, rid: "bbbb0002" });
  await stampVoicePromptIo(db, TEACHER, "bbbb0002", 102, { now: () => T0 + 2 * MIN });
}

const voiceMsg = (fileId: string, opts: { replyTo?: number; at?: number; mid?: number } = {}) => ({
  message_id: opts.mid ?? 300,
  date: Math.floor((opts.at ?? T0 + 3 * MIN) / 1000),
  chat: { id: TEACHER, type: "private" },
  from: { id: TEACHER },
  voice: { file_id: fileId, file_unique_id: `u-${fileId}` },
  ...(opts.replyTo ? { reply_to_message: { message_id: opts.replyTo } } : {}),
});

const pending = (db: FakeConvDb) => {
  const row = db.row(TEACHER);
  return row ? normalizeVoiceState(row.context, row.updated_at, row.expires_at).reqs.map((r) => r.student) : [];
};

Deno.test("FB-4 replay: two pending, a recording WITHOUT reply is held and the bot asks — Aziza's note never reaches Bobur", async () => {
  const db = new FakeConvDb();
  await parkBoth(db);
  const h = harness(db, T0 + 3 * MIN);
  await onBridgeVoice(h.deps, voiceMsg("VOICE-FOR-AZIZA"), "uz");
  assertEquals(h.commits, []); // nothing saved, nothing sent to a student
  assertEquals(h.sent.length, 1);
  assertStringIncludes(h.sent[0].text, "kim uchun");
  const kb = h.sent[0].markup.inline_keyboard as { text: string; callback_data: string }[][];
  assertEquals(kb.length, 3); // Aziza, Bobur, "don't save"
  assertStringIncludes(kb[0][0].text, "Aziza Karimova · 5.0 · 1-GURUH PRE · M2 V1");
  assertStringIncludes(kb[1][0].text, "Bobur Aliyev · CH6");
  for (const row of kb) assert(new TextEncoder().encode(row[0].callback_data).length <= 64);
  assertEquals(db.actionNames(), ["grade_voice_target_asked"]);

  // She taps Aziza → that recording goes to Aziza; Bobur's request stays pending.
  await onVoicePick(h.deps, { id: "cq1", data: kb[0][0].callback_data, from: { id: TEACHER }, message: { message_id: h.sent[0].mid, chat: { id: TEACHER } } }, "uz");
  assertEquals(h.commits, [{ submission_id: SUB_A, file_id: "VOICE-FOR-AZIZA", remaining: 1 }]);
  assertEquals(pending(db), ["Bobur Aliyev"]);
  assertStringIncludes(h.edits[0].text, "Aziza Karimova");

  // Her next recording (no reply) now has exactly one candidate, requested before it → Bobur.
  await onBridgeVoice(h.deps, voiceMsg("VOICE-FOR-BOBUR", { mid: 301 }), "uz");
  assertEquals(h.commits[1], { submission_id: SUB_B, file_id: "VOICE-FOR-BOBUR", remaining: 0 });
  assertEquals(db.row(TEACHER), null); // nothing left pending
});

Deno.test("a recording that REPLIES to Aziza's prompt goes to Aziza even though Bobur was requested later", async () => {
  const db = new FakeConvDb();
  await parkBoth(db);
  const h = harness(db, T0 + 3 * MIN);
  await onBridgeVoice(h.deps, voiceMsg("V-A", { replyTo: 101 }), "uz");
  assertEquals(h.commits, [{ submission_id: SUB_A, file_id: "V-A", remaining: 1 }]);
  await onBridgeVoice(h.deps, voiceMsg("V-B", { replyTo: 102, mid: 301 }), "uz");
  assertEquals(h.commits[1], { submission_id: SUB_B, file_id: "V-B", remaining: 0 });
  assertEquals(h.sent, []); // no questions needed
});

Deno.test("a reply to a prompt that was already answered is not re-routed to the other student", async () => {
  const db = new FakeConvDb();
  await parkBoth(db);
  const h = harness(db, T0 + 3 * MIN);
  await onBridgeVoice(h.deps, voiceMsg("V-A", { replyTo: 101 }), "uz");
  // A second take for Aziza, replying to her (now answered) prompt: Bobur is the only request left, but the
  // reply names Aziza → ask, never "the only one".
  await onBridgeVoice(h.deps, voiceMsg("V-A2", { replyTo: 101, mid: 301 }), "uz");
  assertEquals(h.commits.length, 1);
  assertStringIncludes(h.sent[0].text, "kutilayotgan so'rov emas");
});

Deno.test("stale buttons: a pick for a request answered meanwhile re-asks among who is still pending", async () => {
  const db = new FakeConvDb();
  await parkBoth(db);
  const h = harness(db, T0 + 3 * MIN);
  await onBridgeVoice(h.deps, voiceMsg("V1", { mid: 301 }), "uz"); // held, question #1
  await onBridgeVoice(h.deps, voiceMsg("V2", { mid: 302 }), "uz"); // held, question #2
  const q1 = h.sent[0].markup.inline_keyboard;
  const q2 = h.sent[1].markup.inline_keyboard;
  await onVoicePick(h.deps, { id: "c1", data: q1[0][0].callback_data, from: { id: TEACHER }, message: { message_id: h.sent[0].mid, chat: { id: TEACHER } } }, "uz");
  assertEquals(h.commits.map((c) => [c.submission_id, c.file_id]), [[SUB_A, "V1"]]);
  // Question #2 still offers Aziza — tapping her now must NOT save V2 anywhere; the question is re-drawn.
  await onVoicePick(h.deps, { id: "c2", data: q2[0][0].callback_data, from: { id: TEACHER }, message: { message_id: h.sent[1].mid, chat: { id: TEACHER } } }, "uz");
  assertEquals(h.commits.length, 1);
  const redrawn = h.edits.at(-1)!;
  assertEquals(redrawn.markup.inline_keyboard.length, 2); // Bobur + "don't save"
  assertStringIncludes(redrawn.markup.inline_keyboard[0][0].text, "Bobur");
  await onVoicePick(h.deps, { id: "c3", data: redrawn.markup.inline_keyboard[0][0].callback_data, from: { id: TEACHER }, message: { message_id: h.sent[1].mid, chat: { id: TEACHER } } }, "uz");
  assertEquals(h.commits.map((c) => [c.submission_id, c.file_id]), [[SUB_A, "V1"], [SUB_B, "V2"]]);
});

Deno.test("a tap on the same button twice, or 'don't save', never saves a note twice", async () => {
  const db = new FakeConvDb();
  await parkBoth(db);
  const h = harness(db, T0 + 3 * MIN);
  await onBridgeVoice(h.deps, voiceMsg("V1"), "uz");
  const kb = h.sent[0].markup.inline_keyboard;
  const tap = (data: string, id: string) =>
    onVoicePick(h.deps, { id, data, from: { id: TEACHER }, message: { message_id: h.sent[0].mid, chat: { id: TEACHER } } }, "uz");
  await tap(kb[1][0].callback_data, "c1");
  await tap(kb[1][0].callback_data, "c2");
  assertEquals(h.commits.length, 1);
  await onBridgeVoice(h.deps, voiceMsg("V2", { replyTo: 999, mid: 302 }), "uz"); // reply to a non-prompt → ask
  const kb2 = h.sent[1].markup.inline_keyboard;
  await tap(kb2.at(-1)[0].callback_data, "c3"); // "don't save"
  assertEquals(h.commits.length, 1);
  assertEquals(pending(db), ["Aziza Karimova"]); // Aziza's request untouched by the discard
  assert(db.actionNames().includes("grade_voice_unrouted"));
});

Deno.test("only the teacher's own private chat can answer (a tap from another chat is ignored)", async () => {
  const db = new FakeConvDb();
  await parkBoth(db);
  const h = harness(db, T0 + 3 * MIN);
  await onBridgeVoice(h.deps, voiceMsg("V1"), "uz");
  const data = h.sent[0].markup.inline_keyboard[0][0].callback_data;
  await onVoicePick(h.deps, { id: "c1", data, from: { id: TEACHER }, message: { message_id: 1, chat: { id: -100123 } } }, "uz");
  await onVoicePick(h.deps, { id: "c2", data, from: { id: 999 }, message: { message_id: 1, chat: { id: 999 } } }, "uz");
  assertEquals(h.commits, []);
});

Deno.test("two recordings racing for the ONE pending request: exactly one is saved, the other is told it was not", async () => {
  const db = new FakeConvDb();
  await parkVoiceRequest(db, TEACHER, A, { now: () => T0, rid: "aaaa0001" });
  const h = harness(db, T0 + MIN);
  // Recording #2 claims the request between recording #1's read and its write.
  db.raceOnce(() => {
    const row = db.row(TEACHER)!;
    db.rows.delete(row.telegram_id); // #2 took the only request → row deleted
  });
  await onBridgeVoice(h.deps, voiceMsg("V1"), "uz");
  assertEquals(h.commits, []); // #1 lost the race and saved nothing…
  assertStringIncludes(h.sent[0].text, "saqlanmadi"); // …and says so
  assert(db.actionNames().includes("grade_voice_unrouted"));
});

Deno.test("no pending request at all: the recording is NOT silently dropped into the keyboard hint", async () => {
  const db = new FakeConvDb();
  const h = harness(db, T0);
  await onBridgeVoice(h.deps, voiceMsg("V1"), "ru");
  assertEquals(h.commits, []);
  assertStringIncludes(h.sent[0].text, "не сохранено");
  assertEquals(db.actions[0].action, "grade_voice_unrouted");
  assertEquals((db.actions[0].details as any).reason, "no_request");
});

Deno.test("a recording for an expired request says so and names who it was for", async () => {
  const db = new FakeConvDb();
  await parkBoth(db);
  const h = harness(db, T0 + 16 * MIN); // Aziza's request expired at T0+15, Bobur's lives to T0+17
  await onBridgeVoice(h.deps, voiceMsg("V-A", { replyTo: 101, at: T0 + 16 * MIN }), "en");
  assertEquals(h.commits, []);
  assertStringIncludes(h.sent[0].text, "Aziza Karimova");
  assertStringIncludes(h.sent[0].text, "expired");
  assertEquals(pending(db), ["Bobur Aliyev"]);
});

Deno.test("/cancel withdraws every pending request and names them", async () => {
  const db = new FakeConvDb();
  await parkBoth(db);
  const h = harness(db, T0 + 3 * MIN);
  const txt = await cancelVoiceRequests(h.deps, TEACHER, "uz");
  assertStringIncludes(txt, "2 ta");
  assertStringIncludes(txt, "Aziza Karimova");
  assertEquals(db.row(TEACHER), null);
});

Deno.test("pick button text and the remaining line", () => {
  const r = { rid: "aaaa0001", submission_id: SUB_A, label: A.label, student: A.student, mids: [], at: "", exp: "" };
  assertEquals(pickButtonText(r), "Aziza Karimova · 5.0 · 1-GURUH PRE · M2 V1");
  assert(pickButtonText({ ...r, student: "X".repeat(80) }).length <= 60);
  assertEquals(remainingLine(0, "uz"), "");
  assertStringIncludes(remainingLine(2, "uz"), "2 ta");
});
