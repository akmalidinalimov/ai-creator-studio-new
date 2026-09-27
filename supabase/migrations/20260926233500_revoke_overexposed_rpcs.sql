-- SECURITY: five SECURITY DEFINER RPCs that anyone (two of them) or any signed-in student (the other
-- three) could call, with nothing in the body checking who the caller is.
--
-- SUPERSEDES 20260926233000 (never merged or applied): its header listed
-- enforce_enrollment_tier_from_group as a caller of has_module_access; the live catalog shows it is not
-- (the four real callers are listed below). It also gains a deploy-time pin: the hand-copied
-- recalc_leaderboard body is replaced only if the live one still matches the md5 verified today.
--
-- ── WHAT WAS WRONG (verified read-only against production 2026-09-26) ──
--
--   recalc_leaderboard()            EXECUTE: PUBLIC, anon, authenticated. No caller check.
--   has_module_access(uuid, uuid)   EXECUTE: PUBLIC, anon, authenticated. No caller check.
--   get_setting(text)               EXECUTE: authenticated. Returns ANY app_settings row verbatim.
--   nudge_cron_status()             EXECUTE: authenticated. Reads cron.job.
--   weekly_digest_status()          EXECUTE: authenticated. Reads cron.job.
--
-- recalc_leaderboard() is worse than "anyone can make the server do work". It DELETEs and rebuilds
-- all 685 rows of leaderboard_cache, and each student's homework component comes from
-- user_homework_avg10_effective(), whose live guard only answers for service_role, a NULL role (cron),
-- the student themself, or an admin. So when a STUDENT (or anon) triggers the rebuild, that helper
-- returns NULL for every other student, the CASE falls to the "no homework" branch for all of them,
-- and the whole leaderboard is recomputed WITHOUT homework until the next */15 cron run repairs it.
-- (Reproduced locally on a Postgres 16 fixture with the live bodies: a student-triggered rebuild moved
-- another student's score 64 → 57.) A function that is only correct in some caller contexts must
-- refuse the others. Reachability is not theoretical: edge logs show GET /rest/v1/rpc/recalc_leaderboard
-- as anon on 2026-09-26 05:03 (a curl probe) — it failed only because GET runs read-only (25006); a
-- POST would have run it.
--
-- has_module_access(user_id, module_id) let anyone ask "does user X have access to module Y" for any
-- X — a probe of any student's enrollment/tier.
--
-- A CONFIDENT SENTENCE THAT WAS WRONG (the expensive bug class in CLAUDE.md). The header of
-- 20260926140000_anon_execute_watchdog.sql says the 25 non-deliberate entries in its anon baseline
-- are "admin/staff RPCs WITH real callers, each already guarded in-body by has_role". Checked against
-- the live bodies, 23 of them reference auth.uid()/auth.role(); these two reference NEITHER. Their
-- has_role() calls test a PARAMETER (has_module_access: `has_role(_user_id, ...)`) or a ROW
-- (recalc_leaderboard: `has_role(p.id, ...)`), never the caller. A text search for "has_role" cannot
-- tell those apart, which is how they got baselined as guarded.
--
-- ── EVERY CALLER, FOUND BEFORE CHANGING ANYTHING ──
--
-- Sources checked: src/ (`.rpc("<name>"`), supabase/functions/, pg_policy (polqual AND polwithcheck),
-- every function body in every non-system schema, views, triggers, cron.job, and edge logs for
-- /rest/v1/rpc/<name> by key type over 2026-09-23..26.
--
--   recalc_leaderboard()
--     * pg_cron job `recalc-leaderboard` (*/15, runs as postgres; auth.role() is NULL there).
--     * supabase/functions/leaderboard-recalc — service-role client, behind x-internal-secret.
--     * supabase/functions/telegram-bot-webhook — service-role client, best-effort refresh.
--     * NO frontend caller (src/lib/impersonationGuard.ts only lists the name in a block-list).
--     * NO other function body (verify_stats_parity matched only as recalc_leaderboard_v2).
--     * NO RLS policy, view or trigger.
--     → no authenticated caller: REVOKE from public, anon, authenticated; GRANT service_role.
--       PLUS an in-body caller guard (below), because this database has a documented history of
--       grants drifting back outside version control (20260926140000's header: nudge_cron_status and
--       others regained an explicit anon=X their own migrations had revoked). The guard allows
--       exactly the contexts in which the function computes correctly — the same four that
--       user_homework_avg10_effective() answers for — so a future re-grant cannot corrupt the board.
--
--   has_module_access(uuid, uuid)
--     * Edge functions lesson-video-url and study-assistant — service-role clients. Edge logs: every
--       call over 2026-09-23..26 (~265) used the service key and returned 200; none from a browser.
--     * Function bodies — read from the LIVE catalog (pg_proc.prosrc), 2026-09-27, not from the repo:
--       get_quiz_questions_for_module, grade_quiz_attempt, is_module_tier_locked and
--       student_assignable_homework. ALL four are
--       SECURITY DEFINER and owned by postgres, so their nested call is privilege-checked as
--       postgres, not as the student — the quiz gate (20260926150000) keeps working. (SECURITY
--       DEFINER SQL functions are never inlined, so get_quiz_questions_for_module, a LANGUAGE sql
--       caller, is covered too.)
--     * NO frontend caller (the four hits in src/pages are comments), NO RLS policy, view or cron job.
--       This is the check that matters: a policy that calls a function runs it with the CALLER's
--       privileges, which is how revoking has_role once broke every policy (20260705110000).
--     → REVOKE from public, anon, authenticated; GRANT service_role. Body unchanged.
--
--   get_setting(text)
--     * src/pages/admin/AdminHomework.tsx via src/lib/settings.ts getSetting() — route is
--       RequireAuth adminOnly (admin/superadmin). On error getSetting() falls back to its defaults.
--     * Edge functions detect-and-nudge, re-engagement-send — service-role clients (both also fall
--       back to a default on error).
--     * NO function body, policy, view or cron caller.
--   nudge_cron_status()
--     * src/pages/admin/AdminNudges.tsx (NudgesPanel, rendered by AdminEngagement: adminOnly route).
--   weekly_digest_status()
--     * src/components/admin/WeeklyDigestTile.tsx, rendered by AdminDashboard only when !isTeacher.
--     → these three HAVE an authenticated (admin) caller, so `authenticated` keeps EXECUTE and the
--       body gets the guard: auth.role() IS NULL (cron / nested / owner SQL) OR service_role OR
--       has_role(auth.uid(), admin|superadmin), else RAISE 'forbidden' (42501). Their paired
--       setters (nudge_cron_set_enabled, weekly_digest_set_enabled) were already admin-guarded;
--       the getters were not.
--     Note app_settings itself is admin-only under RLS; get_setting() is SECURITY DEFINER and so
--     bypassed that. It holds config and every watchdog's state row (no secrets today), but "no
--     secrets today" is not a boundary — challenge_config() was revoked for the same reason.
--
-- WHY `auth.role() IS NULL` IS SAFE TO ALLOW: auth.role() reads request.jwt.claim(s), which only
-- PostgREST sets, and it sets it on every request (anon requests carry role 'anon'; the API gateway
-- mints a service_role JWT for the service key). NULL therefore means pg_cron, direct SQL by the
-- owner, or a nested call with no request context — never the internet. Same reasoning, same
-- predicate as 20260820100000 (user_homework_avg10_effective).
--
-- ── DETECTOR: the anon-execute watchdog is armed for these two ──
--
-- recalc_leaderboard() and has_module_access(uuid,uuid) are REMOVED from the ledgered baseline
-- `anon_execute_watchdog_baseline` (its own note: "Removing one is always safe"). Left in, closing
-- them would show as `closed_since_baseline` (verified in the live watchdog body: _closed =
-- baseline − live, never an alarm) — but a later re-grant to anon would ALSO be silent, because they
-- would still be "approved". Out of the baseline, any re-exposure to anon alarms admins within the
-- hour (unexpected ⇒ Telegram DM). Re-exposure to `authenticated` is neutralised in
-- recalc_leaderboard by the body guard; for has_module_access it would reopen a boolean probe only.
-- A failing recalc cron is itself DB-visible (cron.job_run_details status='failed', which
-- ops_health_router routes and recent_cron_failures()/canary count).
--
-- ── SELF-TEST (fails loud; reads the catalog only — calls NONE of these functions) ──
-- recalc_leaderboard mutates and the three getters need a JWT to take the admin branch, so the test
-- asserts ACLs, bodies, callers and the baseline instead of invoking anything (CLAUDE.md: a deploy
-- self-test must not mutate what it checks, and must never need a JWT). The success audit row is
-- written AFTER every assertion passed; on failure the raise rolls the whole migration back.
--
-- Idempotent + replay-safe: CREATE OR REPLACE (grants preserved, then restated), declarative
-- GRANT/REVOKE, and the baseline UPDATE only matches while an entry is still present. A pipeline
-- retry appends a second identical audit row — harmless.
--
-- Bodies below are the LIVE definitions (pg_get_functiondef, 2026-09-26), not the repo copies.
-- recalc_leaderboard is copied verbatim; verified by md5 of the live prosrc (CR stripped) against
-- this file's body with the marked guard block removed.

-- ═══════════════════════ 1. recalc_leaderboard(): revoke + caller guard ═══════════════════════
-- The body below was copied from the LIVE definition on 2026-09-26. Replace it only if the live body
-- still matches that copy (md5, CR stripped): otherwise a change made since would be silently undone.
-- Already guarded (a replay) → nothing to check.
do $pin$
declare _src text := (select prosrc from pg_proc where oid = to_regprocedure('public.recalc_leaderboard()'));
begin
  if _src is null then
    raise exception 'ABORT: public.recalc_leaderboard() does not exist';
  end if;
  if _src !~ '>>> caller guard' and md5(replace(_src, E'\r', '')) <> '3b2222d43a3d005e498f38f3694c821d' then
    raise exception 'ABORT: recalc_leaderboard changed since it was copied into this migration (md5 %); regenerate it from the live definition', md5(replace(_src, E'\r', ''));
  end if;
end $pin$;

CREATE OR REPLACE FUNCTION public.recalc_leaderboard()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  max_lessons int; max_minutes int; weights jsonb;
  w_lessons numeric; w_homework numeric; w_streak numeric; w_minutes numeric; w_no_hw_total numeric;
BEGIN
  -- >>> caller guard (20260926233500): only contexts where user_homework_avg10_effective() answers
  -- for EVERY student; any other caller would rebuild the whole board without homework.
  IF NOT (auth.role() IS NULL OR auth.role() = 'service_role'
          OR public.has_role(auth.uid(), 'admin'::app_role)
          OR public.has_role(auth.uid(), 'superadmin'::app_role)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  -- <<< caller guard
  SELECT value INTO weights FROM app_settings WHERE key = 'engagement.activity_score_weights';
  w_lessons  := COALESCE(NULLIF((weights->>'lessons'),'')::numeric, 0.4);
  w_homework := COALESCE(NULLIF((weights->>'homework'),'')::numeric, 0.3);
  w_streak   := COALESCE(NULLIF((weights->>'streak'),'')::numeric, 0.2);
  w_minutes  := COALESCE(NULLIF((weights->>'minutes'),'')::numeric, 0.1);
  w_no_hw_total := w_lessons + w_streak + w_minutes;
  IF w_no_hw_total <= 0 THEN w_no_hw_total := 0.7; END IF;

  CREATE TEMP TABLE tmp_lb ON COMMIT DROP AS
  SELECT p.id AS user_id,
    COALESCE((SELECT COUNT(*)::int FROM lesson_progress lp WHERE lp.user_id = p.id AND lp.completed_at >= now() - interval '30 days'), 0) AS lessons_30d,
    COALESCE((SELECT (SUM(total_seconds)/60)::int FROM daily_watch_summary d WHERE d.user_id = p.id AND d.watch_date >= (now() AT TIME ZONE 'Asia/Tashkent')::date - 30), 0) AS minutes_30d,
    COALESCE((SELECT current_streak FROM streaks s WHERE s.user_id = p.id), 0) AS current_streak,
    public.user_homework_avg10_effective(p.id, 30) AS avg_hw
  FROM profiles p
  WHERE p.status = 'active' AND p.archived_at IS NULL
    AND NOT has_role(p.id, 'admin'::app_role) AND NOT has_role(p.id, 'teacher'::app_role);

  SELECT GREATEST(MAX(lessons_30d), 1), GREATEST(MAX(minutes_30d), 1) INTO max_lessons, max_minutes FROM tmp_lb;

  DELETE FROM leaderboard_cache;
  INSERT INTO leaderboard_cache (user_id, score, lessons_30d, minutes_30d, current_streak, rank, computed_at)
  SELECT user_id,
    LEAST(100, GREATEST(0, ROUND(
      CASE WHEN avg_hw IS NULL THEN
        ((w_lessons * (lessons_30d::numeric / max_lessons)) + (w_streak * (LEAST(current_streak,30)::numeric / 30)) + (w_minutes * (minutes_30d::numeric / max_minutes))) / w_no_hw_total * 100
      ELSE
        ((w_lessons * (lessons_30d::numeric / max_lessons)) + (w_homework * (avg_hw / 10)) + (w_streak * (LEAST(current_streak,30)::numeric / 30)) + (w_minutes * (minutes_30d::numeric / max_minutes))) * 100
      END)::int)) AS score,
    lessons_30d, minutes_30d, current_streak, NULL::int, now()
  FROM tmp_lb;

  WITH ranked AS (
    SELECT user_id, ROW_NUMBER() OVER (ORDER BY score DESC, lessons_30d DESC, current_streak DESC) AS r FROM leaderboard_cache
  )
  UPDATE leaderboard_cache lc SET rank = ranked.r FROM ranked WHERE ranked.user_id = lc.user_id;
END;
$function$;

revoke execute on function public.recalc_leaderboard() from public, anon, authenticated;
grant  execute on function public.recalc_leaderboard() to service_role;

-- ═══════════════════════ 2. has_module_access(uuid, uuid): revoke only ═══════════════════════
-- Body unchanged. Every DB-side caller is SECURITY DEFINER owned by postgres (asserted below).
revoke execute on function public.has_module_access(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.has_module_access(uuid, uuid) to service_role;

-- ═══════════════════════ 3. Admin-UI getters: keep authenticated, add the guard ═══════════════════════
-- Converted LANGUAGE sql → plpgsql so they can RAISE; signatures, return types, volatility and
-- search_path are unchanged. nudge_cron_status's RETURNS TABLE columns become PL/pgSQL variables, so
-- every column reference in its query is qualified (j.) to avoid "column reference is ambiguous".
CREATE OR REPLACE FUNCTION public.get_setting(_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (auth.role() IS NULL OR auth.role() = 'service_role'
          OR public.has_role(auth.uid(), 'admin'::app_role)
          OR public.has_role(auth.uid(), 'superadmin'::app_role)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN (SELECT s.value FROM public.app_settings s WHERE s.key = _key);
END;
$function$;

CREATE OR REPLACE FUNCTION public.nudge_cron_status()
 RETURNS TABLE(jobname text, active boolean, schedule text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'cron'
AS $function$
BEGIN
  IF NOT (auth.role() IS NULL OR auth.role() = 'service_role'
          OR public.has_role(auth.uid(), 'admin'::app_role)
          OR public.has_role(auth.uid(), 'superadmin'::app_role)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT j.jobname::text, j.active, j.schedule::text FROM cron.job j WHERE j.jobname = 'detect_and_nudge';
END;
$function$;

CREATE OR REPLACE FUNCTION public.weekly_digest_status()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'cron'
AS $function$
BEGIN
  IF NOT (auth.role() IS NULL OR auth.role() = 'service_role'
          OR public.has_role(auth.uid(), 'admin'::app_role)
          OR public.has_role(auth.uid(), 'superadmin'::app_role)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((SELECT j.active FROM cron.job j WHERE j.jobname = 'weekly_digest'), false);
END;
$function$;

-- PUBLIC first: a revoke naming only anon is a no-op against an inherited PUBLIC grant.
revoke execute on function public.get_setting(text)      from public, anon;
grant  execute on function public.get_setting(text)      to authenticated, service_role;
revoke execute on function public.nudge_cron_status()    from public, anon;
grant  execute on function public.nudge_cron_status()    to authenticated, service_role;
revoke execute on function public.weekly_digest_status() from public, anon;
grant  execute on function public.weekly_digest_status() to authenticated, service_role;

-- ═══════════════════════ 4. Arm the detector: shrink the anon baseline ═══════════════════════
-- Only matches while at least one of the two is still listed, so a replay is a no-op. Other entries
-- and keys are preserved; the order of `approved` is normalised (the watchdog sorts anyway).
update public.app_settings s
set value = jsonb_set(
      s.value, '{approved}',
      coalesce((select jsonb_agg(x order by x)
                from jsonb_array_elements_text(s.value->'approved') x
                where x not in ('recalc_leaderboard()', 'has_module_access(uuid,uuid)')),
               '[]'::jsonb))
    || jsonb_build_object('amended_by_20260926233500',
         'removed recalc_leaderboard() and has_module_access(uuid,uuid): anon EXECUTE revoked, so any re-grant now alarms')
where s.key = 'anon_execute_watchdog_baseline'
  and (s.value->'approved') ?| array['recalc_leaderboard()', 'has_module_access(uuid,uuid)'];

-- ═══════════════════════ 5. Self-test ═══════════════════════
do $$
declare
  _locked  text[] := array['public.recalc_leaderboard()', 'public.has_module_access(uuid, uuid)'];
  _guarded text[] := array['public.get_setting(text)', 'public.nudge_cron_status()',
                           'public.weekly_digest_status()'];
  _all     text[];
  _bad     text;
  _remaining int;
  _baseline_n int;
begin
  _all := _locked || _guarded;

  -- 1. The two locked functions: nobody but the owner and service_role.
  select string_agg(f || ' → ' || r, ', ') into _bad
  from unnest(_locked) f, unnest(array['public', 'anon', 'authenticated']) r
  where has_function_privilege(r, f, 'EXECUTE');
  if _bad is not null then
    raise exception 'ABORT: still executable after the revoke: %. Check the signature matched and '
                    'that PUBLIC was named.', _bad;
  end if;

  -- 2. The three getters: never anon/PUBLIC, but authenticated KEEPS them — the admin UI calls them
  --    (AdminHomework.tsx via settings.ts, AdminNudges.tsx, WeeklyDigestTile.tsx).
  select string_agg(f || ' → ' || r, ', ') into _bad
  from unnest(_guarded) f, unnest(array['public', 'anon']) r
  where has_function_privilege(r, f, 'EXECUTE');
  if _bad is not null then
    raise exception 'ABORT: anon/PUBLIC can still execute %.', _bad;
  end if;
  select string_agg(f, ', ') into _bad
  from unnest(_guarded) f where not has_function_privilege('authenticated', f, 'EXECUTE');
  if _bad is not null then
    raise exception 'ABORT: authenticated LOST % — breaks the admin UI.', _bad;
  end if;

  -- 3. service_role (edge functions) and the owner keep all five.
  select string_agg(f || ' → ' || r, ', ') into _bad
  from unnest(_all) f, unnest(array['service_role', 'postgres']) r
  where not has_function_privilege(r, f, 'EXECUTE');
  if _bad is not null then
    raise exception 'ABORT: lost EXECUTE: %.', _bad;
  end if;

  -- 4. The guard landed in every body that is meant to carry it (a positive match on text this very
  --    file just wrote: it proves the CREATE OR REPLACE took effect, nothing more).
  select string_agg(f, ', ') into _bad
  from unnest(array['public.recalc_leaderboard()'] || _guarded) f
  join pg_proc p on p.oid = f::regprocedure
  where p.prosrc !~* 'raise exception ''forbidden'''
     or p.prosrc !~* 'auth\.role\(\) is null or auth\.role\(\) = ''service_role''';
  if _bad is not null then
    raise exception 'ABORT: caller guard missing from %.', _bad;
  end if;

  -- 5. No RLS policy and no view may call any of the five. A policy runs its functions with the
  --    CALLER's privileges, so a policy calling a locked function would start raising for students
  --    (the has_role incident, 20260705110000).
  select string_agg(c.relname || '.' || pol.polname, ', ') into _bad
  from pg_policy pol join pg_class c on c.oid = pol.polrelid
  where (coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' ||
         coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), ''))
        ~* '\m(recalc_leaderboard|has_module_access|get_setting|nudge_cron_status|weekly_digest_status)\s*\(';
  if _bad is not null then
    raise exception 'ABORT: RLS policies call a hardened function: %.', _bad;
  end if;
  select string_agg(n.nspname || '.' || c.relname, ', ') into _bad
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('v', 'm') and n.nspname not in ('pg_catalog', 'information_schema')
    and pg_get_viewdef(c.oid)
        ~* '\m(recalc_leaderboard|has_module_access|get_setting|nudge_cron_status|weekly_digest_status)\s*\(';
  if _bad is not null then
    raise exception 'ABORT: views call a hardened function: %.', _bad;
  end if;

  -- 6. Every routine that calls one of the two LOCKED functions must be SECURITY DEFINER with an
  --    owner that can execute it — otherwise it now fails for whoever calls it (e.g. the quiz gate).
  --    `\s*\(` right after the name keeps recalc_leaderboard_v2( out of the match.
  select string_agg(p.oid::regprocedure::text, ', ') into _bad
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not in ('pg_catalog', 'information_schema')
    and p.oid not in ('public.recalc_leaderboard()'::regprocedure,
                      'public.has_module_access(uuid, uuid)'::regprocedure)
    and (   (coalesce(p.prosrc, '') || ' ' || coalesce(pg_get_function_sqlbody(p.oid), ''))
              ~* '\mrecalc_leaderboard\s*\('
            and (not p.prosecdef or not has_function_privilege(p.proowner, 'public.recalc_leaderboard()', 'EXECUTE'))
         or (coalesce(p.prosrc, '') || ' ' || coalesce(pg_get_function_sqlbody(p.oid), ''))
              ~* '\mhas_module_access\s*\('
            and (not p.prosecdef or not has_function_privilege(p.proowner, 'public.has_module_access(uuid, uuid)', 'EXECUTE')));
  if _bad is not null then
    raise exception 'ABORT: % call(s) a locked function but is SECURITY INVOKER or its owner cannot '
                    'execute it — it would break for its callers.', _bad;
  end if;

  -- 7. Every pg_cron job that calls one of the five runs as a role that can still execute it
  --    (today: `recalc-leaderboard`, as postgres).
  select string_agg(j.jobname || ' (' || j.username || ')', ', ') into _bad
  from cron.job j, unnest(_all) f
  where j.command ~* ('\m' || split_part(replace(f, 'public.', ''), '(', 1) || '\s*\(')
    and not has_function_privilege(j.username, f, 'EXECUTE');
  if _bad is not null then
    raise exception 'ABORT: cron job(s) % can no longer execute what they call.', _bad;
  end if;

  -- 8. The detector is armed: neither locked function is still "approved" for anon.
  if exists (select 1 from public.app_settings
             where key = 'anon_execute_watchdog_baseline'
               and (value->'approved') ?| array['recalc_leaderboard()', 'has_module_access(uuid,uuid)']) then
    raise exception 'ABORT: anon_execute_watchdog_baseline still approves a locked function.';
  end if;

  select count(*) into _remaining
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and p.prokind in ('f', 'p')
    and has_function_privilege('anon', p.oid, 'EXECUTE');
  select jsonb_array_length(value->'approved') into _baseline_n
  from public.app_settings where key = 'anon_execute_watchdog_baseline';

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'rpc_exposure_hardened',
          jsonb_build_object(
            'migration', '20260926233500',
            'locked_to_service_role', to_jsonb(_locked),
            'guarded_admin_only', to_jsonb(_guarded),
            'anon_secdef_remaining', _remaining,
            'anon_baseline_count', _baseline_n,
            'at', now()));

  raise notice 'rpc exposure hardened: % locked, % guarded; % anon-executable SECURITY DEFINER '
               'routines remain, baseline %', array_length(_locked, 1), array_length(_guarded, 1),
               _remaining, _baseline_n;
end $$;
