-- SECURITY (tranche 3): 28 SECURITY DEFINER functions closed to anon — 17 trigger functions plus
-- 11 callable RPCs with zero callers anywhere. Takes anon-executable SECURITY DEFINER functions in
-- schema public from 55 to 27.
--
-- Third and largest tranche. 20260925201000 closed 13 (77 → 64), 20260926101000 closed 8 (63 → 55),
-- and 20260926093000 stopped NEW functions being born anon-executable at all. This one clears
-- everything that needs no product decision, so the residue is exactly the set that does.
--
-- ── PART A: the 17 trigger functions. Hygiene, NOT a security fix — said plainly. ──
--
-- These return `trigger`, and PostgreSQL refuses a direct invocation of such a function with
-- "trigger functions can only be called as triggers" (SQLSTATE 0A000). So `anon` holding EXECUTE on
-- them was never exploitable. They carry the grant only because, until 20260926093000, EVERY function
-- created in schema public was born with the inherited PUBLIC EXECUTE from acldefault(). Revoking is
-- worth doing for two concrete reasons, neither of which is "closing a hole":
--   1. The residue becomes meaningful. "27 anon-executable SECURITY DEFINER functions" should mean 27
--      pieces of reachable surface, not 10 real ones padded with 17 unreachable trigger bodies.
--   2. The planned anon-execute watchdog alarms on any function appearing outside a ledgered
--      baseline. Baselining 55 would enshrine rows we intend to remove and make every later closure
--      look like drift. Clean first, baseline the stable 27 after.
--
-- WHY THIS IS SAFE — PROVEN FROM THIS DATABASE, NOT ASSERTED FROM MEMORY. The claim it rests on is
-- that EXECUTE on a trigger function is checked at CREATE TRIGGER time, not when the trigger fires.
-- That is a high-consequence assumption: this list includes `homework_submissions_guard`,
-- `lesson_progress_guard` and `validate_hw_submission`, so being wrong breaks every student homework
-- submission and lesson completion for ~694 students. Two live precedents, both with the EXACT ACL
-- shape this migration applies (`postgres=X/postgres | service_role=X/postgres`):
--
--   * BEFORE-timing, guard-shaped, the closest possible analogue:
--     `trg_enrollments_tier_from_group` → `enforce_enrollment_tier_from_group()` on `enrollments` is a
--     **BEFORE INSERT OR UPDATE guard that RAISEs to block bad writes** — structurally identical to the
--     three guards above. `authenticated` and `anon` have been unable to execute it since 2026-07-05
--     (20260705170000_tier_invariant_guarantee.sql), the trigger is enabled, and `enrollments` holds
--     668 rows with the most recent 3 days before this migration. Every student signup routes through
--     it via handle_new_user.
--   * Five months of continuous traffic on the hottest table:
--     `trg_lesson_progress_streak` → `update_streak_for_user()` on `lesson_progress` has had public,
--     anon and authenticated revoked since **2026-04-28** (20260428162429_105e6ed5…sql), whose own
--     comment already said "Trigger functions don't need any EXECUTE grants". `lesson_progress` took
--     39 updates in the 24h before this migration, the most recent minutes earlier.
--
-- Why the inference holds rather than merely fitting: the ACL check happens once, in CreateTrigger(),
-- against the role that ran CREATE TRIGGER; the firing path invokes the function by OID through fmgr
-- and never performs pg_proc_aclcheck. That is independent of BEFORE vs AFTER, ROW vs STATEMENT, and
-- whether the trigger is currently enabled — none of which affect WHEN the check happens. The BEFORE
-- precedent above is cited specifically because an earlier draft of this header cited only AFTER
-- triggers (the xp_on_* family), which left exactly that gap open while three of the 17 are BEFORE
-- guards. There are also no CONSTRAINT TRIGGERs anywhere in this codebase, so that variant cannot be
-- lurking.
--
-- ── PART B: the 11 callable RPCs with zero callers. ──
--
-- Every one also loses `authenticated`, because there is no caller to lose anything: a grep of src/
-- and supabase/functions/ for `rpc("<name>"` returns 0 sites for each, and pg_policy (polqual AND
-- polwithcheck), pg_depend, pg_views, pg_trigger and cron.job are all clean. Each already carries its
-- own admin/staff `has_role` guard, so this is defence in depth — it removes the ability to reach the
-- endpoint, on top of a guard that already refuses. Worth doing because the guard is the only thing
-- standing between the internet and, for example, a list of student emails.
--
--   * `admin_ungrouped_students()` — returns email + telegram_id + last_sign_in_at per student. The
--     highest-value payload in this tranche; admin-guarded, zero callers, no reason to be reachable.
--   * `admin_teacher_stats(integer, integer)` / `admin_teacher_groups(uuid, integer, integer)` /
--     `admin_teacher_unanswered(uuid, integer, integer)` / `admin_teacher_activity_daily(uuid, integer)`
--     — the teacher-analytics family. DEAD CODE: only `admin_teacher_weekly` is wired to a page, and
--     it keeps its grants because it has a real caller. Named individually rather than swept, because
--     "the admin_teacher_* family" would have silently included the one that is still in use.
--   * `staff_group_module_completion(uuid)` / `staff_group_recent_activity(uuid, integer)` /
--     `staff_top_students(integer)` — three of the staff_group_* family with no caller. Note their
--     siblings `staff_group_members` (6 sites) and `staff_group_overview` (3 sites) are LEFT ALONE:
--     same prefix, real callers. Another reason not to sweep by prefix.
--   * `can_see_group(uuid, uuid)` — the guard helper itself. Its only callers are the SECURITY
--     DEFINER staff_group_* functions, which run it AS OWNER, so they are unaffected. Leaving it
--     anon-callable let anyone probe "is user X a teacher of group Y" directly. (The two hits for it
--     in src/pages/teacher/ are CODE COMMENTS explaining that staff_group_members is gated by it, not
--     calls — the distinction that matters, since a name in a comment is not a caller.)
--   * `verify_rls_hws()` / `verify_stats_parity(integer)` — internal verification helpers.
--     verify_stats_parity is the notable one: it returns per-student score/rank rows AND calls
--     `recalc_leaderboard_v2()` as owner, so it is the bypass route around the revoke that
--     20260926101000 just applied. Its `IF NOT has_role(auth.uid(),'admin') THEN RAISE` does hold —
--     `has_role` is `SELECT EXISTS(...)` and EXISTS never returns NULL, so a NULL caller gets false,
--     not NULL, and the RAISE fires — but a guard is a worse boundary than an absent grant.
--
-- ── Why this self-test does NOT write an admin_actions row before raising ──
--
-- Review suggested copying tranche 1's pattern (20260925201000:172-186), which inserts a
-- `..._selftest_failed` row inside a swallowed-exception block before the raise, under the comment
-- "so the reason survives the rollback in the logs". **That comment is wrong, and the pattern is a
-- no-op.** The insert and the raise are in the SAME transaction — the pipeline POSTs each migration
-- file as one query string — so an uncaught raise aborts the transaction and takes the audit row with
-- it. Nothing survives. This is the identical mistake that made 20260926073000 uninformative and is
-- already written into CLAUDE.md: "a raise rolls the diagnostics back with everything else". Copying
-- it here would add code that cannot work. Deliberately NOT adopted; the failure signal is the red
-- deploy plus the un-ledgered migration, which is loud and correct. Recorded so the next reader does
-- not "fix" this file to match tranche 1, and so tranche 1's misleading comment is on the record —
-- migrations are append-only, so it cannot be corrected in place.
--
-- ── What is deliberately NOT here ──
--
-- The remaining 27 after this migration are: `has_role(uuid, app_role)` and `get_public_setting(text)`
-- which MUST keep anon (has_role backs 124 policy expressions across 63 tables and 151 pg_depend
-- entries; get_public_setting is deliberately public and field-whitelisted), plus 25 admin/staff RPCs
-- that DO have real callers. For those 25 the only open question is whether `authenticated` should
-- reach an admin endpoint at all — each already has its own in-body has_role guard, so today a
-- signed-in student gets "forbidden" rather than data. That is one product decision for the owner,
-- not 25 mechanical revokes, and it is left for them.
--
-- WHY `revoke ... from public` COMES FIRST IN EVERY STATEMENT: most of these carry BOTH an explicit
-- `anon` grant and an inherited PUBLIC grant, and `REVOKE ... FROM anon` alone is a NO-OP against the
-- PUBLIC grant while looking exactly like a fix. That trap is the origin of this whole incident class.
--
-- SELF-TEST FAILS LOUD (raise outside any handler → whole migration rolls back), matching
-- 20260925201000 and 20260926101000: declarative GRANT/REVOKE is free to roll back, and a revoke that
-- silently broke the app would be far worse than the hygiene it bought. It also asserts the two
-- deliberate anon functions still work, and that the 5 same-prefix siblings WITH real callers kept
-- their grants — the specific way a prefix sweep would have gone wrong.
--
-- Idempotent + replay-safe: GRANT/REVOKE are declarative. The audit INSERT on the SUCCESS path has no
-- dedupe key, so a pipeline retry appends a second identical row — harmless log noise.

-- ── PART A: 17 trigger functions (never invocable directly; match the precedents cited above) ──
revoke execute on function public.app_settings_audit()                 from public, anon, authenticated;
grant  execute on function public.app_settings_audit()                 to service_role;
revoke execute on function public.award_first_homework()               from public, anon, authenticated;
grant  execute on function public.award_first_homework()               to service_role;
revoke execute on function public.enforce_role_exclusivity()           from public, anon, authenticated;
grant  execute on function public.enforce_role_exclusivity()           to service_role;
revoke execute on function public.enforce_sap_inherits_parent()        from public, anon, authenticated;
grant  execute on function public.enforce_sap_inherits_parent()        to service_role;
revoke execute on function public.evaluate_lesson_badges()             from public, anon, authenticated;
grant  execute on function public.evaluate_lesson_badges()             to service_role;
revoke execute on function public.evaluate_streak_badges()             from public, anon, authenticated;
grant  execute on function public.evaluate_streak_badges()             to service_role;
revoke execute on function public.homework_submissions_guard()         from public, anon, authenticated;
grant  execute on function public.homework_submissions_guard()         to service_role;
revoke execute on function public.lesson_progress_guard()              from public, anon, authenticated;
grant  execute on function public.lesson_progress_guard()              to service_role;
revoke execute on function public.queue_badge_dm()                     from public, anon, authenticated;
grant  execute on function public.queue_badge_dm()                     to service_role;
revoke execute on function public.re_engagement_mark_activation()      from public, anon, authenticated;
grant  execute on function public.re_engagement_mark_activation()      to service_role;
revoke execute on function public.redact_hw_dm_queue_error()           from public, anon, authenticated;
grant  execute on function public.redact_hw_dm_queue_error()           to service_role;
revoke execute on function public.redact_platform_error_log()          from public, anon, authenticated;
grant  execute on function public.redact_platform_error_log()          to service_role;
revoke execute on function public.streak_on_group_activity()           from public, anon, authenticated;
grant  execute on function public.streak_on_group_activity()           to service_role;
revoke execute on function public.streak_on_homework_submit()          from public, anon, authenticated;
grant  execute on function public.streak_on_homework_submit()          to service_role;
revoke execute on function public.sync_primary_group_teacher()         from public, anon, authenticated;
grant  execute on function public.sync_primary_group_teacher()         to service_role;
revoke execute on function public.trg_enqueue_module_complete_nudge()  from public, anon, authenticated;
grant  execute on function public.trg_enqueue_module_complete_nudge()  to service_role;
revoke execute on function public.validate_hw_submission()             from public, anon, authenticated;
grant  execute on function public.validate_hw_submission()             to service_role;

-- ── PART B: 11 callable RPCs with zero callers ──
revoke execute on function public.admin_teacher_activity_daily(uuid, integer)        from public, anon, authenticated;
grant  execute on function public.admin_teacher_activity_daily(uuid, integer)        to service_role;
revoke execute on function public.admin_teacher_groups(uuid, integer, integer)       from public, anon, authenticated;
grant  execute on function public.admin_teacher_groups(uuid, integer, integer)       to service_role;
revoke execute on function public.admin_teacher_stats(integer, integer)              from public, anon, authenticated;
grant  execute on function public.admin_teacher_stats(integer, integer)              to service_role;
revoke execute on function public.admin_teacher_unanswered(uuid, integer, integer)   from public, anon, authenticated;
grant  execute on function public.admin_teacher_unanswered(uuid, integer, integer)   to service_role;
revoke execute on function public.admin_ungrouped_students()                         from public, anon, authenticated;
grant  execute on function public.admin_ungrouped_students()                         to service_role;
revoke execute on function public.can_see_group(uuid, uuid)                          from public, anon, authenticated;
grant  execute on function public.can_see_group(uuid, uuid)                          to service_role;
revoke execute on function public.staff_group_module_completion(uuid)                from public, anon, authenticated;
grant  execute on function public.staff_group_module_completion(uuid)                to service_role;
revoke execute on function public.staff_group_recent_activity(uuid, integer)         from public, anon, authenticated;
grant  execute on function public.staff_group_recent_activity(uuid, integer)         to service_role;
revoke execute on function public.staff_top_students(integer)                        from public, anon, authenticated;
grant  execute on function public.staff_top_students(integer)                        to service_role;
revoke execute on function public.verify_rls_hws()                                   from public, anon, authenticated;
grant  execute on function public.verify_rls_hws()                                   to service_role;
revoke execute on function public.verify_stats_parity(integer)                       from public, anon, authenticated;
grant  execute on function public.verify_stats_parity(integer)                       to service_role;

do $$
declare
  _closed text[] := array[
    'public.app_settings_audit()','public.award_first_homework()','public.enforce_role_exclusivity()',
    'public.enforce_sap_inherits_parent()','public.evaluate_lesson_badges()',
    'public.evaluate_streak_badges()','public.homework_submissions_guard()',
    'public.lesson_progress_guard()','public.queue_badge_dm()',
    'public.re_engagement_mark_activation()','public.redact_hw_dm_queue_error()',
    'public.redact_platform_error_log()','public.streak_on_group_activity()',
    'public.streak_on_homework_submit()','public.sync_primary_group_teacher()',
    'public.trg_enqueue_module_complete_nudge()','public.validate_hw_submission()',
    'public.admin_teacher_activity_daily(uuid, integer)',
    'public.admin_teacher_groups(uuid, integer, integer)',
    'public.admin_teacher_stats(integer, integer)',
    'public.admin_teacher_unanswered(uuid, integer, integer)',
    'public.admin_ungrouped_students()','public.can_see_group(uuid, uuid)',
    'public.staff_group_module_completion(uuid)','public.staff_group_recent_activity(uuid, integer)',
    'public.staff_top_students(integer)','public.verify_rls_hws()',
    'public.verify_stats_parity(integer)'];
  -- Same-prefix siblings that HAVE real callers. A prefix sweep would have taken these too.
  -- All five verified to hold `authenticated` BEFORE this migration, so this cannot self-abort.
  _must_keep_authed text[] := array[
    'public.admin_teacher_weekly(integer, uuid)',
    'public.staff_group_members(uuid)',
    'public.staff_group_overview(uuid)',
    'public.staff_list_students()',
    'public.staff_recent_lesson_progress(timestamp with time zone)'];
  _bad text;
  _remaining int;
begin
  -- 1. None of the 28 may remain anon-callable.
  select string_agg(f, ', ' order by f) into _bad
  from unnest(_closed) f where has_function_privilege('anon', f, 'EXECUTE');
  if _bad is not null then
    raise exception 'ABORT: still anon-executable after the revoke: %. A revoke naming only anon is '
                    'a no-op against an inherited PUBLIC grant — check the signature matched.', _bad;
  end if;

  -- 2. The owner must keep EXECUTE, or the trigger bodies and DB-internal callers break.
  select string_agg(f, ', ' order by f) into _bad
  from unnest(_closed) f where not has_function_privilege('postgres', f, 'EXECUTE');
  if _bad is not null then
    raise exception 'ABORT: owner postgres lost EXECUTE on %.', _bad;
  end if;

  -- 3. service_role must keep all 28 (matches the two working precedents cited in the header).
  select string_agg(f, ', ' order by f) into _bad
  from unnest(_closed) f where not has_function_privilege('service_role', f, 'EXECUTE');
  if _bad is not null then
    raise exception 'ABORT: service_role lost EXECUTE on %.', _bad;
  end if;

  -- 4. REGRESSION GUARD A: the same-prefix siblings WITH real callers must be untouched. This is the
  --    assertion that would have caught a sweep by prefix rather than by caller audit.
  select string_agg(f, ', ' order by f) into _bad
  from unnest(_must_keep_authed) f where not has_function_privilege('authenticated', f, 'EXECUTE');
  if _bad is not null then
    raise exception 'ABORT: % lost authenticated EXECUTE but has real callers — a same-prefix '
                    'sibling was swept up by mistake.', _bad;
  end if;

  -- 5. REGRESSION GUARD B: the two deliberately anon-callable functions must still work.
  if not has_function_privilege('anon', 'public.has_role(uuid, public.app_role)', 'EXECUTE') then
    raise exception 'ABORT: anon lost EXECUTE on has_role() — breaks every RLS policy that calls it '
                    '(124 policy expressions across 63 tables; see 20260705110000).';
  end if;
  if not has_function_privilege('anon', 'public.get_public_setting(text)', 'EXECUTE') then
    raise exception 'ABORT: anon lost EXECUTE on get_public_setting() — deliberately public.';
  end if;

  select count(*) into _remaining
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
    and has_function_privilege('anon', p.oid, 'EXECUTE');

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'anon_secdef_revoked_tranche_3',
          jsonb_build_object(
            'closed_count', array_length(_closed, 1),
            'trigger_functions', 17,
            'zero_caller_rpcs', 11,
            'anon_secdef_remaining', _remaining,
            'siblings_deliberately_kept', to_jsonb(_must_keep_authed),
            'at', now()));

  -- The residue should now be 27: has_role + get_public_setting + 25 admin/staff RPCs with real
  -- callers. Recorded, not asserted — live traffic could legitimately change the denominator, and a
  -- hard equality here would make the migration fail for a reason unrelated to its own correctness.
  raise notice 'tranche 3 complete: % closed, % anon-executable SECURITY DEFINER functions remain',
    array_length(_closed, 1), _remaining;
end $$;
