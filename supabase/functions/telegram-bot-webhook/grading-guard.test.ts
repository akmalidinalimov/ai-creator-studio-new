// Run: deno test supabase/functions/telegram-bot-webhook/grading-guard.test.ts
// One grading target at a time in the bot (audit BOT-4): the replace warning, the reply binding and the strict
// score. Scenarios interleave two students — Aziza (5.0) opened first, Bobur (Challenge) opened second.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  messageIdOf, notANumberText, parseStrictScore, replacedSessionNotice, replyElsewhereText, replyMidOf, replyPointsElsewhere,
} from "./grading-guard.ts";

const T0 = Date.parse("2026-10-01T09:00:00Z");
const MIN = 60_000;
const SUB_A = "aaaaaaaa-1111-4111-8111-111111111111";
const SUB_B = "bbbbbbbb-2222-4222-8222-222222222222";
const live = new Date(T0 + 10 * MIN).toISOString();

const azizaScore = {
  state: "grade_score",
  context: { submission_id: SUB_A, student_name: "Aziza Karimova", who_tag: "5.0 · 1-GURUH PRE · M2 V1", anchor_mid: 400 },
  expires_at: live,
};

Deno.test("strict score: only a plain whole number; the audit's real free-text inputs are refused", () => {
  assertEquals(parseStrictScore("8", 10), { ok: true, score: 8 });
  assertEquals(parseStrictScore("  10 ", 10), { ok: true, score: 10 });
  assertEquals(parseStrictScore("0", 10), { ok: true, score: 0 });
  // webhook_inbox, 2026: these were saved as 1 / 6 / 9 by parseInt.
  assertEquals(parseStrictScore("1 vazifa topilmadi", 10), { ok: false, reason: "not_a_number" });
  assertEquals(parseStrictScore("6  toʻgri promt yoxi", 10), { ok: false, reason: "not_a_number" });
  assertEquals(parseStrictScore("9 yaxshi chiqan", 10), { ok: false, reason: "not_a_number" });
  for (const bad of ["", "8.5", "-1", "+8", "8/10", "٨", "1e1", "0x8", "📝 Baholash"]) {
    assertEquals(parseStrictScore(bad, 10).ok, false, bad);
  }
  assertEquals(parseStrictScore("11", 10), { ok: false, reason: "out_of_range" });
  assertEquals(parseStrictScore("99999999999999999999", 10), { ok: false, reason: "out_of_range" });
});

Deno.test("reply binding: a reply to an OLDER message (the previous student's screen) is refused", () => {
  assertEquals(replyPointsElsewhere(null, 400), false); // plain typing — accepted
  assertEquals(replyPointsElsewhere(400, 400), false); // the header itself
  assertEquals(replyPointsElsewhere(403, 400), false); // this session's prompt / media
  assertEquals(replyPointsElsewhere(390, 400), true); // Aziza's prompt, above Bobur's header
  assertEquals(replyPointsElsewhere(390, undefined), false); // old session without an anchor binds nothing
  assertEquals(replyPointsElsewhere(390, "400"), false);
});

Deno.test("replyMidOf: a real reply's id; the forum-topic implicit reply is not a reply", () => {
  assertEquals(replyMidOf({ reply_to_message: { message_id: 7 } }), 7);
  assertEquals(replyMidOf({ reply_to_message: { message_id: 7, forum_topic_created: {} } }), null);
  assertEquals(replyMidOf({}), null);
});

Deno.test("replace notice: opening Bobur while Aziza's grade is unfinished says Aziza's was cancelled", () => {
  const n = replacedSessionNotice(azizaScore, [SUB_B], T0, "uz");
  assert(n);
  assertStringIncludes(n.text, "Tugallanmagan baholash bekor qilindi");
  assertStringIncludes(n.text, "<b>Aziza Karimova</b> · 5.0 · 1-GURUH PRE · M2 V1");
  assertEquals(n.details, { from_state: "grade_score", from_submission_id: SUB_A, had_score: false, voice_requests: 0, held_voices: 0 });
});

Deno.test("replace notice: a score already typed for Aziza is named as NOT saved", () => {
  const n = replacedSessionNotice({ ...azizaScore, state: "grade_comment", context: { ...azizaScore.context, score: 8 } }, [SUB_B], T0, "en");
  assert(n);
  assertStringIncludes(n.text, "(the score you entered, 8, was not saved)");
  assertEquals(n.details.had_score, true);
});

Deno.test("replace notice: re-opening the SAME homework is silent unless a typed score is discarded", () => {
  assertEquals(replacedSessionNotice(azizaScore, [SUB_A], T0, "uz"), null);
  const n = replacedSessionNotice({ ...azizaScore, state: "grade_comment", context: { ...azizaScore.context, score: 7 } }, [SUB_A], T0, "uz");
  assertStringIncludes(n!.text, "(7)");
  // The retag path passes both the old and the surviving id.
  assertEquals(replacedSessionNotice(azizaScore, [SUB_B, SUB_A], T0, "uz"), null);
});

Deno.test("replace notice: nothing to lose → null (expired, no row, other states)", () => {
  assertEquals(replacedSessionNotice(null, [SUB_B], T0, "uz"), null);
  assertEquals(replacedSessionNotice({ ...azizaScore, expires_at: new Date(T0 - 1).toISOString() }, [SUB_B], T0, "uz"), null);
  assertEquals(replacedSessionNotice({ state: "nm_cache", context: {}, expires_at: live }, [SUB_B], T0, "uz"), null);
  assertEquals(replacedSessionNotice({ state: "awaiting_name", context: {}, expires_at: live }, [SUB_B], T0, "uz"), null);
});

Deno.test("replace notice: pending Mini App voice requests are named when a bot grading session drops them", () => {
  const exp = new Date(T0 + 10 * MIN).toISOString();
  const row = {
    state: "grade_voice",
    context: {
      v: 2, cas: "c",
      reqs: [
        { rid: "aaaa0001", submission_id: SUB_A, label: null, student: "Aziza Karimova", mids: [101], at: exp, exp },
        { rid: "bbbb0002", submission_id: SUB_B, label: null, student: "Bobur <Aliyev>", mids: [102], at: exp, exp },
      ],
      held: [{ tok: "0a1b2c3d", file_id: "V", key: null, mid: 1, at: exp, exp }],
    },
    updated_at: new Date(T0).toISOString(),
    expires_at: exp,
  };
  const n = replacedSessionNotice(row, ["cccccccc-3333-4333-8333-333333333333"], T0, "uz");
  assert(n);
  assertStringIncludes(n.text, "2 ta ovozli izoh so'rovi bekor qilindi: <b>Aziza Karimova</b>, <b>Bobur &lt;Aliyev&gt;</b>");
  assertStringIncludes(n.text, "1 ta ovoz saqlanmadi");
  assertEquals(n.details.voice_requests, 2);
  // Only a held note left (both requests answered): no "0 ta … so'rov" line.
  const heldOnly = replacedSessionNotice({ ...row, context: { ...row.context, reqs: [] } }, [SUB_A], T0, "uz");
  assert(heldOnly && !heldOnly.text.includes("0 ta"));
  // The legacy one-request row counts as one request with no name.
  const legacy = replacedSessionNotice({ state: "grade_voice", context: { submission_id: SUB_A }, updated_at: row.updated_at, expires_at: exp }, [SUB_B], T0, "uz");
  assertStringIncludes(legacy!.text, "1 ta ovozli");
});

Deno.test("refusal texts name the student the session is waiting for", () => {
  assertStringIncludes(notANumberText("uz", 10), "faqat raqam");
  const r = replyElsewhereText("uz", "Bobur Aliyev", "CH6 · AC CHALLENGE | 3-GURUH · M2 V1");
  assertStringIncludes(r, "Hozir baholanayotgan: 👤 <b>Bobur Aliyev</b>");
  assert(!replyElsewhereText("ru", undefined, undefined).includes("Сейчас проверяется"));
});

Deno.test("messageIdOf reads a sendMessage response, and never throws", async () => {
  assertEquals(await messageIdOf(new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }))), 42);
  assertEquals(await messageIdOf(new Response("not json")), null);
  assertEquals(await messageIdOf(null), null);
});
