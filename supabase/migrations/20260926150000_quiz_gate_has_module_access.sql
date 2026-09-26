-- SECURITY (correctness): the quiz gate asks "is this module tier-locked?" when it means
-- "does this user have access to this module?". Those differ for a user with NO enrollment.
--
-- 20260926101000 closed the ANON half of this by revoking EXECUTE. This closes the other half, which
-- that PR deliberately left open and named as its own follow-up.
--
-- THE BUG. Both quiz functions gate on `is_module_tier_locked(uid, _module_id)`, whose contract is
-- narrower than the name suggests. Its own body says so:
--     -- Caller's tier cap for the module's course. No tiered enrollment (NULL tier, unlimited
--     -- tier, OR NOT ENROLLED) → NULL → not locked.
--     if _limit is null then return false; end if;
-- So a signed-in student with no enrollment row for that course gets `_limit = NULL`, the function
-- returns FALSE, and `NOT false` passes the gate. The tier clamp was only ever meant to stop a TIERED
-- student reaching past their cap; it was never an access check, and it silently answers "not locked"
-- for everyone it knows nothing about.
--
-- WHAT LEAKED, per function — the second is worse than the one that prompted this:
--   * get_quiz_questions_for_module(uuid) returns question text and options for any module, to any
--     signed-in user, enrolled or not.
--   * grade_quiz_attempt(uuid, jsonb) returns `correct_index` AND `explanation` for every question in
--     the module — the ANSWERS — and writes a quiz_attempts row for a course the caller is not
--     enrolled in. Its `IF uid IS NULL THEN RAISE 'unauthorized'` correctly stops anon, which is
--     exactly why the weaker gate underneath went unnoticed.
--
-- EXPOSURE TODAY IS ZERO, and that is why this is the right moment: `quiz_questions` holds 0 rows and
-- `quiz_attempts` holds 5 (historical). Nothing is leaking right now. It is a loaded gun that fires
-- the day someone adds quiz content — so it is cheaper and safer to fix while the blast radius is
-- empty than to discover it live.
--
-- THE FIX: gate on `has_module_access(uid, _module_id)`, which is the access check this always wanted
-- and is already the house gate — `student_assignable_homework()` uses it for exactly this purpose
-- ("tier clamp ... has_module_access returns true unconditionally for NULL-tier students"). It checks,
-- in order: staff bypass (admin/superadmin/teacher → true); the module's course must be PUBLISHED;
-- the caller must have an enrollment row for that course; then the tier rank vs module_limit. So it
-- subsumes the tier clamp rather than replacing it, and adds the two conditions that were missing.
--
-- BEHAVIOUR CHANGES, stated explicitly because this is a gate and gates lock people out:
--   1. A signed-in student NOT ENROLLED in the course can no longer read or grade its quiz. Intended.
--   2. A student whose course has been UNPUBLISHED (deactivated) loses quiz access. This is already
--      true of their homework via student_assignable_homework() and of their lessons, so the quiz was
--      the outlier; this makes the surfaces agree.
--   3. Staff are unaffected (has_module_access returns true for admin/superadmin/teacher).
--   4. An enrolled student with a NULL-tier enrollment — the common case — is unaffected: enrollment
--      exists, `module_limit IS NULL`, returns true.
-- `is_module_tier_locked` itself is NOT changed and NOT dropped: `track_video_progress` still uses it
-- deliberately, and its comment documents the non-enrolled pass-through as intended there ("NULL-tier
-- / non-enrolled / staff → false → unchanged for the 489"). That function only ever records a user's
-- OWN watch time, and it is a 1,031,693-call hot path; changing its gate is a separate decision with a
-- much larger blast radius, so it is left alone on purpose.
--
-- Idempotent + replay-safe: two CREATE OR REPLACE statements, declarative GRANT/REVOKE, and a
-- read-only self-test. Replay changes nothing.

create or replace function public.get_quiz_questions_for_module(_module_id uuid)
returns table(id uuid, module_id uuid, question text, options jsonb, "position" integer)
language sql
stable
security definer
set search_path to 'public'
as $function$
  SELECT q.id, q.module_id, q.question, q.options, q."position"
  FROM public.quiz_questions q
  WHERE q.module_id = _module_id
    -- was: AND NOT public.is_module_tier_locked(auth.uid(), _module_id)
    -- which returned false (i.e. "allowed") for a caller with no enrollment at all.
    AND public.has_module_access(auth.uid(), _module_id)
  ORDER BY q."position";
$function$;

create or replace function public.grade_quiz_attempt(_module_id uuid, _answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  total int := 0;
  correct int := 0;
  pq jsonb := '[]'::jsonb;
  r record;
  uid uuid := auth.uid();
  ans int;
  is_correct boolean;
  pct int;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'unauthorized'; END IF;
  -- was: IF public.is_module_tier_locked(uid, _module_id) THEN RAISE 'module_locked'
  -- which let a signed-in but NOT-ENROLLED caller through, and this function returns
  -- correct_index and explanation for every question — the answers.
  IF NOT public.has_module_access(uid, _module_id) THEN RAISE EXCEPTION 'module_locked'; END IF;

  FOR r IN SELECT id, correct_index, explanation FROM public.quiz_questions WHERE module_id = _module_id LOOP
    total := total + 1;
    ans := NULLIF(_answers->>(r.id::text), '')::int;
    is_correct := ans IS NOT NULL AND ans = r.correct_index;
    IF is_correct THEN correct := correct + 1; END IF;
    pq := pq || jsonb_build_object(
      'id', r.id,
      'correct_index', r.correct_index,
      'explanation', r.explanation,
      'is_correct', is_correct
    );
  END LOOP;
  pct := CASE WHEN total > 0 THEN round(correct::numeric * 100 / total) ELSE 0 END;
  INSERT INTO public.quiz_attempts(user_id, module_id, score, answers) VALUES (uid, _module_id, pct, _answers);
  RETURN jsonb_build_object('score', pct, 'total', total, 'correct', correct, 'questions', pq);
END;
$function$;

-- CREATE OR REPLACE preserves the existing ACL, so these are belt-and-braces: they restate the state
-- 20260926101000 established, keep the file self-describing, and satisfy the author-time lint added in
-- scripts/check-migration-grants.mjs. PUBLIC is named first — a revoke naming only anon is a no-op
-- against an inherited PUBLIC grant.
revoke execute on function public.get_quiz_questions_for_module(uuid) from public, anon;
grant  execute on function public.get_quiz_questions_for_module(uuid) to authenticated, service_role;
revoke execute on function public.grade_quiz_attempt(uuid, jsonb)     from public, anon;
grant  execute on function public.grade_quiz_attempt(uuid, jsonb)     to authenticated, service_role;

do $$
declare
  _mod uuid;
  _rows int;
  _bad text := '';
begin
  -- The property the whole fix rests on: has_module_access refuses a NULL caller. auth.uid() is NULL
  -- inside a migration, so this is the anon/unauthenticated path, evaluated for real.
  select id into _mod from public.modules order by created_at limit 1;

  if _mod is null then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'quiz_gate_selftest_skipped',
            jsonb_build_object('reason', 'no modules exist to test against', 'at', now()));
  else
    if public.has_module_access(null, _mod) then
      _bad := _bad || 'has_module_access(NULL, module) returned TRUE — the fix would not gate anyone; ';
    end if;

    -- get_quiz_questions_for_module is STABLE and read-only, so calling it here is safe. With
    -- auth.uid() NULL it must return nothing. (quiz_questions is empty today, so this also cannot
    -- leak content into the audit row.)
    select count(*) into _rows from public.get_quiz_questions_for_module(_mod);
    if _rows <> 0 then
      _bad := _bad || 'get_quiz_questions_for_module returned ' || _rows || ' row(s) to a NULL caller; ';
    end if;
  end if;

  -- grade_quiz_attempt is deliberately NOT called: it WRITES a quiz_attempts row, and its guard needs
  -- a JWT, so calling it here would either mutate real data or raise on every single deploy — the
  -- permanent-false-alarm pattern this project has already been bitten by.

  if not has_function_privilege('authenticated', 'public.get_quiz_questions_for_module(uuid)', 'EXECUTE') then
    _bad := _bad || 'authenticated LOST get_quiz_questions_for_module (breaks QuizPage.tsx:39); ';
  end if;
  if not has_function_privilege('authenticated', 'public.grade_quiz_attempt(uuid, jsonb)', 'EXECUTE') then
    _bad := _bad || 'authenticated LOST grade_quiz_attempt (breaks QuizPage.tsx:57); ';
  end if;
  if has_function_privilege('anon', 'public.get_quiz_questions_for_module(uuid)', 'EXECUTE') then
    _bad := _bad || 'anon can STILL execute get_quiz_questions_for_module; ';
  end if;
  if has_function_privilege('anon', 'public.grade_quiz_attempt(uuid, jsonb)', 'EXECUTE') then
    _bad := _bad || 'anon can STILL execute grade_quiz_attempt; ';
  end if;

  if _bad <> '' then
    raise exception 'quiz gate self-test failed, rolling back: %', _bad;
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'quiz_gate_tightened',
          jsonb_build_object(
            'functions', jsonb_build_array('get_quiz_questions_for_module(uuid)', 'grade_quiz_attempt(uuid,jsonb)'),
            'old_gate', 'NOT is_module_tier_locked(auth.uid(), module) — passed for a caller with NO enrollment',
            'new_gate', 'has_module_access(auth.uid(), module) — staff bypass, course published, enrolled, tier rank',
            'quiz_questions_rows_at_fix', (select count(*) from public.quiz_questions),
            'is_module_tier_locked_left_alone_for', 'track_video_progress (deliberate non-enrolled pass-through, hot path)',
            'at', now()));
end $$;
