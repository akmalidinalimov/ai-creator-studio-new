-- SECURITY: eight SECURITY DEFINER functions that `anon` should never have been able to call.
--
-- Second tranche after 20260925201000 (which closed 13, taking anon-executable SECURITY DEFINER
-- functions from 77 to 64). Unlike the default-privileges work in 20260926093000 — which is
-- PREVENTION for functions created in future — this one CURES existing objects, which is the only
-- thing that closes a live hole.
--
-- THE HEADLINE. `recalc_leaderboard_v2()` has NO guard of any kind: no has_role, no auth.uid()
-- check, nothing. It returns one row per active non-staff student — user_id, activity score,
-- lessons_30d, minutes_30d, current_streak, rank, homework average — which today is **685 students**.
-- It also CREATE TEMP TABLEs over profiles + lesson_progress + daily_watch_summary on every call, so
-- it doubles as an unauthenticated compute amplifier. ZERO callers in src/ or supabase/functions/.
-- 20260925201000 closed `leaderboard_top(int)` for exactly this reason and missed the v2 that
-- supersedes it — closing a function by name leaves its successor open.
-- Evidence bound, stated precisely: the ACL and the body establish that anon can call it and that
-- nothing inside stops it. It is VOLATILE, so PostgREST requires POST; a GET returns 405, which is
-- method-not-allowed, NOT a refusal, and a POST runs in a read-write transaction where the temp
-- table succeeds. We deliberately did NOT POST it as anon — doing so would mean pulling 685 real
-- students' records over an unauthenticated channel to prove a point the catalog already proves.
--
-- WHY EIGHT AND NOT FIVE — fixing the class, not the case. A first draft of this migration revoked
-- `challenge_config()` and claimed to close the challenge config/group-UUID leak. It did not. Two
-- SECURITY DEFINER WRAPPERS around it were still anon-executable and re-exposed the same data:
--   * `challenge_group_ids()`   — returns SETOF uuid taken from challenge_config()->'group_ids' and
--                                ->'course_ids'. The group-UUID leak would have SURVIVED the revoke.
--   * `challenge_active(timestamptz)` — reveals `enabled` and whether now() is inside the window.
-- They are only harmless today by accident of timing: `challenge_active()` is currently false, so
-- `challenge_group_ids()` returns 0 rows. The moment the challenge is switched on, anon can
-- enumerate the challenge group UUIDs again. Their siblings `challenge_scope_group_ids()` and
-- `reconcile_challenge_xp()` are ALREADY anon=false, so these two were inconsistent leftovers, and
-- the migration would have looked like a fix while leaving the hole open. Both have zero app
-- callers, zero RLS references, zero pg_depend dependents and zero cron references.
-- `grade_quiz_attempt(uuid, jsonb)` joins for the same reason: it WRITES to quiz_attempts and there
-- is no reason it should be reachable from the internet, even though its own
-- `IF uid IS NULL THEN RAISE 'unauthorized'` guard already refuses anon.
--
-- THE OTHER FUNCTIONS, with severity stated honestly rather than dramatically:
--
--   * `get_quiz_questions_for_module(uuid)` — a genuinely broken gate with ZERO exposure today. Its
--     only guard is `NOT is_module_tier_locked(auth.uid(), _module_id)`. For anon auth.uid() is NULL,
--     so is_module_tier_locked finds no enrollment, `_limit IS NULL`, it returns false, and
--     `NOT false` is true — the WHERE clause collapses to `q.module_id = _module_id` and every
--     question is returned. The documented "auth.uid() is null leaks to anon" class. BUT
--     `quiz_questions` currently holds 0 rows, so nothing leaks right now: it is a loaded gun, not an
--     active leak, and it fires the moment anyone adds quiz content. (It returns question + options
--     only, never correct_index or explanation.) KEEPS `authenticated` — real caller at
--     src/pages/QuizPage.tsx:39, with 273 recorded authenticated calls, so that grant is load-bearing.
--     STILL OPEN AFTER THIS PR, deliberately: the same NULL-tier logic means a signed-in student NOT
--     ENROLLED in the course is also "not tier locked". The correct gate is has_module_access(), not
--     is_module_tier_locked(). That is a behaviour change with its own blast radius, so it gets its
--     own PR; exposure is zero while the table is empty.
--
--   * `is_module_tier_locked(uuid, uuid)` — takes the target user as an ARGUMENT, so any caller can
--     ask about any user: the arbitrary-user oracle shape fixed in 20260926072000 (#179). Leaks only
--     a boolean, so severity is low, but it should not be callable from the internet. No app caller:
--     the only src/ hits are a generated type and a CODE COMMENT at src/pages/Lessons.tsx:326.
--     Its real callers are DB-internal — including `track_video_progress`, a hot path with
--     **1,031,693 recorded calls** — and every one is SECURITY DEFINER owned by postgres, so they
--     execute it AS OWNER and are unaffected. Each of these eight ACLs also carries an explicit
--     `postgres=X/postgres` entry, not merely the bare `=X` PUBLIC grant, so `revoke ... from public`
--     cannot strip the owner.
--
--   * `challenge_config()` — returns `platform_settings['challenge']` VERBATIM, unguarded. Today its
--     keys are caps, course_ids, enabled, group_ids, points, window and it holds NO secret, so this is
--     currently a config leak, not a credential leak. It matters because Instagram Phase 2 will put a
--     Meta token in that row, at which point this is `cron_service_key()` again. Contrast
--     get_public_setting(), which is deliberately anon-callable and safe precisely because it
--     ENUMERATES the fields it returns — a secret added to its settings row cannot widen it.
--     challenge_config() should eventually do the same, or the token should live in Vault.
--
--   * `weekly_digest_set_enabled(boolean)` — the ONE function of the 63 reachable via PUBLIC *alone*
--     (all others also carry an explicit anon grant), so closing it makes the remaining set uniform.
--     It has a real admin has_role guard, so an anon call already failed; this removes the reach.
--     KEEPS `authenticated` — real caller at src/components/admin/WeeklyDigestTile.tsx:21.
--
-- WHY `revoke ... from public` COMES FIRST IN EVERY STATEMENT. Most of these carry BOTH an explicit
-- `anon` grant and an inherited PUBLIC grant. `REVOKE ... FROM anon` alone is a NO-OP against the
-- PUBLIC grant and looks exactly like a fix — the trap this whole incident class turns on, and the
-- same shape as the video-source-column leak where a column-level REVOKE was a no-op against a
-- table-level GRANT. Naming `public` first is not decoration. (On
-- `get_quiz_questions_for_module(uuid)` there is no bare `=X` entry, so `from public` is a harmless
-- no-op there — included for uniformity.)
--
-- CALLER AUDIT — the method 20260925201000 established, plus two blind spots it did not cover:
--   * pg_policy.polqual/polwithcheck: 0 references. This matters more than a .rpc() grep — revoking
--     has_role() from anon once broke every RLS policy that called it (20260705110000), a failure no
--     .rpc() search would surface.
--   * pg_depend: 0 dependent objects for all eight, which rules out views, matviews, column
--     defaults, CHECK constraints, generated columns AND standard-conforming `BEGIN ATOMIC` function
--     bodies in one result. That last one is a real blind spot in a `prosrc` grep: a BEGIN ATOMIC
--     body lives in `pg_proc.prosqlbody` and `prosrc` is NULL, so such a caller is invisible to
--     `prosrc ILIKE`. Verified `prosqlbody IS NOT NULL` is false for every caller.
--   * pg_trigger, pg_event_trigger, pg_attrdef, pg_constraint, attgenerated, pg_description,
--     cron.job (command AND username), platform_settings values: 0 references across all.
--   * Edge tier: 30 sites build an anon-key `userClient` (which authenticates as `authenticated`, NOT
--     service_role, and so WOULD have broken) — none references any of the eight. All 66 deployed
--     edge-function slugs were diffed against supabase/functions/ with zero drift both ways, so the
--     repo IS authoritative for the edge tier here. The deployed `leaderboard-recalc` function looks
--     like a missed caller but invokes `recalc_leaderboard` (v1) on a service-role client.
--   * Live call counts over an 84-day pg_stat_statements window: no external anon caller for any of
--     the eight. The only anon rows are 2 calls to challenge_config and 3 to
--     get_quiz_questions_for_module, all attributable to this audit's own curl requests today.
--     (`pg_stat_user_functions` is useless here — `track_functions = none`, so it returns 0 rows.)
--
-- OPERATIONAL NOTE, so the next investigator does not misread it as a regression: `revoke ... from
-- public` also strips every role that held EXECUTE ONLY via PUBLIC, which includes
-- `supabase_read_only_user` — the read-only role the MCP audit tooling connects as. After this
-- migration, a read-only session calling e.g. `select public.challenge_config()` will get
-- `42501 permission denied`. That is the intended effect, not a fault.
--
-- SELF-TEST FAILS LOUD (raise outside any handler → the whole migration rolls back), unlike the
-- house catch-and-log pattern, matching 20260925201000. This migration is purely declarative
-- GRANT/REVOKE with no irreversible side effects, so rolling back is free, and a revoke that
-- silently broke the app would be far worse than the leak it closed. It also asserts the two
-- DELIBERATELY anon-callable functions still work, so this migration cannot regress them.
--
-- Idempotent + replay-safe: GRANT/REVOKE are declarative; re-running changes nothing. The audit
-- INSERT has no dedupe key, so a pipeline retry appends a second identical row — harmless log noise.

-- ── Fully internal: no app caller, service_role only ──
revoke execute on function public.recalc_leaderboard_v2()               from public, anon, authenticated;
grant  execute on function public.recalc_leaderboard_v2()               to service_role;

revoke execute on function public.challenge_config()                    from public, anon, authenticated;
grant  execute on function public.challenge_config()                    to service_role;

revoke execute on function public.challenge_group_ids()                 from public, anon, authenticated;
grant  execute on function public.challenge_group_ids()                 to service_role;

revoke execute on function public.challenge_active(timestamptz)         from public, anon, authenticated;
grant  execute on function public.challenge_active(timestamptz)         to service_role;

revoke execute on function public.is_module_tier_locked(uuid, uuid)     from public, anon, authenticated;
grant  execute on function public.is_module_tier_locked(uuid, uuid)     to service_role;

-- ── These KEEP `authenticated`: each has a real browser caller, cited in the header ──
revoke execute on function public.get_quiz_questions_for_module(uuid)   from public, anon;
grant  execute on function public.get_quiz_questions_for_module(uuid)   to authenticated, service_role;

revoke execute on function public.grade_quiz_attempt(uuid, jsonb)       from public, anon;
grant  execute on function public.grade_quiz_attempt(uuid, jsonb)       to authenticated, service_role;

revoke execute on function public.weekly_digest_set_enabled(boolean)    from public, anon;
grant  execute on function public.weekly_digest_set_enabled(boolean)    to authenticated, service_role;

do $$
declare
  _all text[] := array[
    'public.recalc_leaderboard_v2()',
    'public.challenge_config()',
    'public.challenge_group_ids()',
    'public.challenge_active(timestamptz)',
    'public.is_module_tier_locked(uuid, uuid)',
    'public.get_quiz_questions_for_module(uuid)',
    'public.grade_quiz_attempt(uuid, jsonb)',
    'public.weekly_digest_set_enabled(boolean)'];
  _keep_authed text[] := array[
    'public.get_quiz_questions_for_module(uuid)',
    'public.grade_quiz_attempt(uuid, jsonb)',
    'public.weekly_digest_set_enabled(boolean)'];
  _bad text;
  _remaining int;
begin
  -- 1. None of the eight may remain anon-callable.
  select string_agg(f, ', ' order by f) into _bad
  from unnest(_all) f where has_function_privilege('anon', f, 'EXECUTE');
  if _bad is not null then
    raise exception 'ABORT: still anon-executable after the revoke: %. A revoke naming only anon is '
                    'a no-op against an inherited PUBLIC grant — check the signature matched.', _bad;
  end if;

  -- 2. The three with real browser callers MUST keep `authenticated`, or the app breaks.
  select string_agg(f, ', ' order by f) into _bad
  from unnest(_keep_authed) f where not has_function_privilege('authenticated', f, 'EXECUTE');
  if _bad is not null then
    raise exception 'ABORT: lost authenticated EXECUTE on %, which has a real browser caller '
                    '(QuizPage.tsx:39 / QuizPage.tsx:57 / WeeklyDigestTile.tsx:21).', _bad;
  end if;

  -- 3. service_role must keep all eight (edge functions + cron).
  select string_agg(f, ', ' order by f) into _bad
  from unnest(_all) f where not has_function_privilege('service_role', f, 'EXECUTE');
  if _bad is not null then
    raise exception 'ABORT: service_role lost EXECUTE on %.', _bad;
  end if;

  -- 4. REGRESSION GUARD: the two deliberately anon-callable functions must still work.
  --    has_role is called by 124 distinct RLS policy expressions across 63 tables, 39 of which name
  --    no role and therefore apply to PUBLIC including anon; a policy expression is evaluated with
  --    the CALLER's privileges, so revoking anon makes every such policy raise instead of returning
  --    false. get_public_setting is read by src/pages/LessonPage.tsx on a page anon can reach.
  if not has_function_privilege('anon', 'public.has_role(uuid, public.app_role)', 'EXECUTE') then
    raise exception 'ABORT: anon lost EXECUTE on has_role() — this breaks every RLS policy that '
                    'calls it (see 20260705110000_grant_has_role_to_anon.sql).';
  end if;
  if not has_function_privilege('anon', 'public.get_public_setting(text)', 'EXECUTE') then
    raise exception 'ABORT: anon lost EXECUTE on get_public_setting() — deliberately public.';
  end if;

  -- 5. The owner must still be able to run them, or every DB-internal caller breaks — including
  --    track_video_progress (1,031,693 calls) which reaches is_module_tier_locked as owner.
  select string_agg(f, ', ' order by f) into _bad
  from unnest(_all) f where not has_function_privilege('postgres', f, 'EXECUTE');
  if _bad is not null then
    raise exception 'ABORT: owner postgres lost EXECUTE on % — DB-internal SECURITY DEFINER callers '
                    'would break.', _bad;
  end if;

  select count(*) into _remaining
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
    and has_function_privilege('anon', p.oid, 'EXECUTE');

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'anon_secdef_revoked_tranche_2',
          jsonb_build_object(
            'closed', to_jsonb(_all),
            'kept_authenticated', to_jsonb(_keep_authed),
            'anon_secdef_remaining', _remaining,
            'student_rows_no_longer_exposed_by_leaderboard_v2', 685,
            'at', now()));
end $$;
