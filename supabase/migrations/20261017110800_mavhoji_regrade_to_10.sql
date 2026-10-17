-- Owner request 2026-10-17: student @mavhoji (ЦЭЗАР 786, 4-GURUH) — M1V1 7 → 10 and M2V2 8 → 10.
--
--   M1V1 «PROYEKT TAYYORLASH»                       f579ccfa-1eca-49f4-b05e-423a8f09590b  7 → 10 (attempt 1)
--   M2V2 «7SABER brendi uchun rasmlar tayyorlash»    87149a4b-c5bd-478b-8a0c-c9c3ef492e5f  8 → 10 (attempt 7)
--
-- Written like a teacher's regrade (teacherApi.submitScore): score + scored_at, score_is_stale=false, scored_by kept
-- (Nigora graded both). The triggers then do the rest: xp_on_homework awards the +25 homework_high_score
-- (ref 'hw_score:<assignment>', idempotent), award_perfect_score_badge the perfect-score badge.
--
-- Her grade card: grade_card_notified_attempt is set back one step, so grade-card-reconcile (every 30 min, ≥5 min
-- after scored_at, never 22–08 Tashkent) sends the ordinary «Baholandi! 10/10 · +25» card for each task through
-- the shared sender — no hand-rolled Telegram call here.
--
-- M1V1's feedback explained the 7 ("M1V1 project task got the module-2 homework"); under a 10/10 card it would
-- contradict the grade, so it is cleared — the old score and feedback are kept in the admin_actions row.
--
-- Guarded on the exact current score, so a replay (or a teacher having changed it meanwhile) touches nothing.

do $$
declare
  _r record;
  _n int := 0;
begin
  for _r in
    select s.id, s.score, s.score_feedback, s.attempt_number, s.user_id
      from public.homework_submissions s
     where (s.id = 'f579ccfa-1eca-49f4-b05e-423a8f09590b' and s.score = 7)
        or (s.id = '87149a4b-c5bd-478b-8a0c-c9c3ef492e5f' and s.score = 8)
     for update
  loop
    update public.homework_submissions
       set score = 10,
           score_feedback = case when id = 'f579ccfa-1eca-49f4-b05e-423a8f09590b' then null else score_feedback end,
           scored_at = now(),
           score_is_stale = false,
           grade_card_notified_attempt = greatest(coalesce(attempt_number, 1) - 1, 0)
     where id = _r.id;

    insert into public.admin_actions (actor_user_id, action, target_user_id, target_resource_type, target_resource_id, details)
    values (null, 'homework_score_override', _r.user_id, 'homework_submission', _r.id,
            jsonb_build_object('migration', '20261017110800', 'requested_by', 'owner', 'old_score', _r.score,
                               'new_score', 10, 'attempt', _r.attempt_number, 'old_feedback', _r.score_feedback));
    _n := _n + 1;
  end loop;
  raise notice 'mavhoji regrade: % submission(s) set to 10', _n;
end $$;
