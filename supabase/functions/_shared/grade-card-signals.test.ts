// Tests for the grade-card skip signal. Run: deno test supabase/functions/_shared/grade-card-signals.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  appVoiceKey, botVoiceKey, GRADE_CARD_SKIP_WINDOW_DAYS, gradeCardOwed, recordGradeCardSkipped, recordGradeVoiceSkipped,
} from "./grade-card-signals.ts";

const DAY = 86_400_000;

// A service-role-client stub over an in-memory admin_actions table that honours logHealthOnce's exact
// filter chain (action, details->>dedupe_key, created_at >= since).
function fakeAdmin(seed: any[] = []) {
  const rows: any[] = [...seed];
  const admin = {
    from: (_t: string) => ({
      insert: (row: any) => { rows.push({ ...row, created_at: new Date().toISOString() }); return Promise.resolve({ error: null }); },
      select: (_c: string) => {
        const f: Record<string, string> = {};
        const q: any = {
          eq: (col: string, v: string) => { f[col] = v; return q; },
          gte: (_col: string, v: string) => { f.since = v; return q; },
          limit: (_n: number) => Promise.resolve({
            data: rows.filter((r) => r.action === f.action && r.details?.dedupe_key === f["details->>dedupe_key"] &&
              r.created_at >= f.since).slice(0, 1),
            error: null,
          }),
        };
        return q;
      },
    }),
  };
  return { admin, rows };
}

Deno.test("gradeCardOwed: a fresh score whose attempt has not been announced", () => {
  assertEquals(gradeCardOwed({ score: 8, score_is_stale: false, attempt_number: 1, grade_card_notified_attempt: null }), true);
  assertEquals(gradeCardOwed({ score: 0, score_is_stale: false, attempt_number: 1, grade_card_notified_attempt: null }), true);
  // Regrade of a resubmission: attempt 2, card for attempt 1 already sent.
  assertEquals(gradeCardOwed({ score: 9, score_is_stale: false, attempt_number: 2, grade_card_notified_attempt: 1 }), true);
  // attempt_number missing is treated as 1, like every sender does.
  assertEquals(gradeCardOwed({ score: 9, score_is_stale: false, attempt_number: null, grade_card_notified_attempt: null }), true);
});

Deno.test("gradeCardOwed: nothing owed without a score, for a stale score, or once announced", () => {
  assertEquals(gradeCardOwed({ score: null, score_is_stale: false, attempt_number: 1, grade_card_notified_attempt: null }), false);
  // The graded branch of start_homework_resubmission() keeps the score and flags it stale.
  assertEquals(gradeCardOwed({ score: 7, score_is_stale: true, attempt_number: 2, grade_card_notified_attempt: 1 }), false);
  // A plain feedback re-save of an already-announced attempt.
  assertEquals(gradeCardOwed({ score: 7, score_is_stale: false, attempt_number: 1, grade_card_notified_attempt: 1 }), false);
});

Deno.test("recordGradeCardSkipped: row shape and dedupe key", async () => {
  const { admin, rows } = fakeAdmin();
  const sub = crypto.randomUUID(), student = crypto.randomUUID(), teacher = crypto.randomUUID();
  assertEquals(await recordGradeCardSkipped(admin, {
    submissionId: sub, studentId: student, attempt: 1, source: "notify-grade-voice", actorUserId: teacher,
    details: { score: 8, voice_dropped: false },
  }), true);
  assertEquals(rows.length, 1);
  const r = rows[0];
  assertEquals(r.action, "grade_card_dm_skipped");
  assertEquals(r.actor_user_id, teacher);
  assertEquals(r.target_user_id, student);
  assertEquals(r.target_resource_type, "homework_submission");
  assertEquals(r.target_resource_id, sub);
  assertEquals(r.details, {
    reason: "no_telegram", submission_id: sub, attempt: 1, score: 8, voice_dropped: false,
    dedupe_key: `no_telegram:${sub}:1`, source: "notify-grade-voice",
  });
});

Deno.test("recordGradeCardSkipped: another sender's row inside the window suppresses it; a new attempt does not", async () => {
  const sub = crypto.randomUUID();
  // Written by the bot, in another isolate, five days ago. This key was never used in this isolate, so
  // only the DB existence check can answer.
  const { admin, rows } = fakeAdmin([{
    action: "grade_card_dm_skipped", details: { dedupe_key: `no_telegram:${sub}:1` },
    created_at: new Date(Date.now() - 5 * DAY).toISOString(),
  }]);
  assertEquals(await recordGradeCardSkipped(admin, { submissionId: sub, studentId: null, attempt: 1, source: "grade-card-reconcile" }), false);
  assertEquals(rows.length, 1);
  assertEquals(await recordGradeCardSkipped(admin, { submissionId: sub, studentId: null, attempt: 2, source: "grade-card-reconcile" }), true);
  assertEquals(rows.length, 2);
});

Deno.test("recordGradeCardSkipped: a row older than the window no longer suppresses", async () => {
  const sub = crypto.randomUUID();
  const { admin, rows } = fakeAdmin([{
    action: "grade_card_dm_skipped", details: { dedupe_key: `no_telegram:${sub}:1` },
    created_at: new Date(Date.now() - (GRADE_CARD_SKIP_WINDOW_DAYS + 1) * DAY).toISOString(),
  }]);
  assertEquals(await recordGradeCardSkipped(admin, { submissionId: sub, studentId: null, attempt: 1, source: "grade-card-reconcile" }), true);
  assertEquals(rows.length, 2);
});

// ---- Voice notes (grade_voice_dm_skipped) ----

// The shape of a teacher's private voice message as webhook_inbox stores it (every one of the 339 private voice
// messages carries exactly these five voice keys). Ids here are synthetic.
function voiceMsg(fileUniqueId: string, messageId = 4101) {
  return {
    message_id: messageId,
    chat: { id: 700000001, type: "private" },
    from: { id: 700000001, is_bot: false, first_name: "Ustoz" },
    date: 1790000000,
    voice: { duration: 14, mime_type: "audio/ogg", file_id: "AwACAgIAAxkBAAI" + "x".repeat(59), file_unique_id: fileUniqueId, file_size: 51234 },
  };
}

Deno.test("botVoiceKey: keyed by the note's file_unique_id, not by the message or the attempt", () => {
  assertEquals(botVoiceKey(voiceMsg("AgADu1kAAk3eWEk")), "tg:AgADu1kAAk3eWEk");
  // The same note in a redelivered update (same payload) gives the same key; a new recording a new one.
  assertEquals(botVoiceKey(voiceMsg("AgADu1kAAk3eWEk", 4101)), botVoiceKey(voiceMsg("AgADu1kAAk3eWEk", 4101)));
  assertEquals(botVoiceKey(voiceMsg("AgADu1kAAk3eWEk")) === botVoiceKey(voiceMsg("AgADv2kAAk3eWEk", 4102)), false);
  // An audio file sent instead of a voice message (the grading handlers accept both).
  assertEquals(botVoiceKey({ message_id: 9, chat: { id: 5 }, audio: { file_unique_id: "AgADaudio" } }), "tg:AgADaudio");
  // No file_unique_id at all: fall back to the message's own identity.
  assertEquals(botVoiceKey({ message_id: 9, chat: { id: 5 }, voice: {} }), "tgmsg:5:9");
});

Deno.test("appVoiceKey: one key per grade write (scored_at), attempt only as a fallback", () => {
  assertEquals(appVoiceKey("2026-09-14T09:00:56.275+00:00", 1), "app:2026-09-14T09:00:56.275+00:00");
  assertEquals(appVoiceKey("2026-09-14T09:05:01.002+00:00", 1) === appVoiceKey("2026-09-14T09:00:56.275+00:00", 1), false);
  assertEquals(appVoiceKey(null, 2), "app:attempt2");
  assertEquals(appVoiceKey(undefined, 1), "app:attempt1");
});

Deno.test("recordGradeVoiceSkipped: row shape and dedupe key", async () => {
  const { admin, rows } = fakeAdmin();
  const sub = crypto.randomUUID(), student = crypto.randomUUID(), teacher = crypto.randomUUID();
  const uid = `AgAD${crypto.randomUUID().slice(0, 12)}`;
  assertEquals(await recordGradeVoiceSkipped(admin, {
    submissionId: sub, studentId: student, voiceKey: botVoiceKey(voiceMsg(uid)), source: "miniapp_voice_bridge",
    actorUserId: teacher,
  }), true);
  assertEquals(rows.length, 1);
  const r = rows[0];
  assertEquals(r.action, "grade_voice_dm_skipped");
  assertEquals(r.actor_user_id, teacher);
  assertEquals(r.target_user_id, student);
  assertEquals(r.target_resource_type, "homework_submission");
  assertEquals(r.target_resource_id, sub);
  assertEquals(r.details, {
    reason: "no_telegram", submission_id: sub, dedupe_key: `no_telegram:${sub}:tg:${uid}`, source: "miniapp_voice_bridge",
  });
});

Deno.test("recordGradeVoiceSkipped: a second note on an attempt whose card row exists is still recorded", async () => {
  // The case the card row could not cover: bot grading of a no-telegram student, then a re-grade of the SAME
  // attempt with a new voice note. The card row dedupes on the attempt; each note must still leave a row.
  const { admin, rows } = fakeAdmin();
  const sub = crypto.randomUUID(), student = crypto.randomUUID();
  const first = `AgAD${crypto.randomUUID().slice(0, 12)}`, second = `AgAD${crypto.randomUUID().slice(0, 12)}`;
  const card = () => recordGradeCardSkipped(admin, { submissionId: sub, studentId: student, attempt: 1, source: "telegram-bot-webhook" });
  const voice = (u: string) => recordGradeVoiceSkipped(admin, {
    submissionId: sub, studentId: student, voiceKey: botVoiceKey(voiceMsg(u)), source: "telegram-bot-webhook",
  });
  assertEquals(await card(), true);
  assertEquals(await voice(first), true);
  assertEquals(await card(), false); // re-grade, same attempt: no second card row (unchanged #211 contract)
  assertEquals(await voice(second), true); // ...but the new note is counted
  assertEquals(await voice(second), false); // and the same note twice (redelivered update) is not
  assertEquals(rows.map((r) => r.action), ["grade_card_dm_skipped", "grade_voice_dm_skipped", "grade_voice_dm_skipped"]);
});

Deno.test("recordGradeVoiceSkipped: another isolate's row for the same note suppresses it (app path)", async () => {
  const sub = crypto.randomUUID();
  const key = appVoiceKey("2026-09-30T08:15:00.000+00:00", 1);
  // A client double-invoke of notify-grade-voice for one save, landing on another isolate: only the DB
  // existence check can answer, because this isolate never saw the key.
  const { admin, rows } = fakeAdmin([{
    action: "grade_voice_dm_skipped", details: { dedupe_key: `no_telegram:${sub}:${key}` },
    created_at: new Date(Date.now() - 60_000).toISOString(),
  }]);
  assertEquals(await recordGradeVoiceSkipped(admin, { submissionId: sub, studentId: null, voiceKey: key, source: "notify-grade-voice" }), false);
  assertEquals(rows.length, 1);
  // A card row with the same submission is a different action and never suppresses a voice row.
  const { admin: admin2, rows: rows2 } = fakeAdmin([{
    action: "grade_card_dm_skipped", details: { dedupe_key: `no_telegram:${sub}:1` },
    created_at: new Date(Date.now() - 60_000).toISOString(),
  }]);
  assertEquals(await recordGradeVoiceSkipped(admin2, {
    submissionId: sub, studentId: null, voiceKey: appVoiceKey("2026-09-30T08:00:00.000+00:00", 1), source: "notify-grade-voice",
  }), true);
  assertEquals(rows2.length, 2);
});

Deno.test("recordGradeVoiceSkipped: a failed insert returns false and never throws", async () => {
  const admin = {
    from: (_t: string) => ({
      insert: (_row: any) => Promise.resolve({ error: { message: "permission denied" } }),
      select: (_c: string) => {
        const q: any = { eq: () => q, gte: () => q, limit: () => Promise.resolve({ data: [], error: null }) };
        return q;
      },
    }),
  };
  assertEquals(await recordGradeVoiceSkipped(admin, {
    submissionId: crypto.randomUUID(), studentId: null, voiceKey: "tg:AgADfail", source: "telegram-bot-webhook",
  }), false);
});
