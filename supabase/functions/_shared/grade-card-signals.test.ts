// Tests for the grade-card skip signal. Run: deno test supabase/functions/_shared/grade-card-signals.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { GRADE_CARD_SKIP_WINDOW_DAYS, gradeCardOwed, recordGradeCardSkipped } from "./grade-card-signals.ts";

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
