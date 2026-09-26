-- SECURITY: admin_group_module_submissions let the CALLER name the identity it was authorised as.
--
-- THE BUG, one line:
--     v_caller uuid := COALESCE(p_caller_profile_id, auth.uid());
-- The function then role-checks `v_caller`. So whoever calls it decides who they are. Pass an admin's
-- or a group-owning teacher's uuid and you get that person's data — the role check passes, because it
-- is checking the uuid you supplied, not you.
--
-- EXPLOITABLE TODAY, by signed-in students, without anything exotic:
-- `homework_submissions.scored_by` holds the uuid of the teacher who graded you, and the RLS policy
-- "hws own select" deliberately lets a student read their own submission rows. 143 students have a
-- graded submission, so 143 students can read a group-owning teacher's uuid and then call this
-- function as them. It is also anon-executable, though anon additionally needs a uuid from somewhere
-- out of band (staff uuids were verified NOT anonymously harvestable).
-- Confirmed by execution with auth.uid() NULL: admin uuid -> 24 rows; group-owning teacher uuid ->
-- 8 rows. It returns per-group, per-module student counts and submission counts.
--
-- A PERMISSION CHANGE DOES NOT FIX THIS. Revoking anon leaves the 143 authenticated students. The
-- broken thing is the authorization primitive, so that is what changes here.
--
-- THE FIX — the pattern this codebase already established and documented in
-- 20260820100000_harden_per_user_rpcs.sql: "trust the caller-supplied id ONLY when the caller is
-- service_role, otherwise always use the caller's own auth.uid()".
--     v_caller := case when auth.role() = 'service_role'
--                      then coalesce(p_caller_profile_id, auth.uid())
--                      else auth.uid() end;
-- Note `auth.role() = 'service_role'` and NEVER `auth.uid() is null` — anon's uid is null too, which
-- is the trap recorded in the security-definer-anon-guard incident.
--
-- BOTH REAL CALLERS KEEP WORKING, verified at the call sites:
--   supabase/functions/telegram-bot-webhook/index.ts:3386 — /thomework, passes
--     { p_caller_profile_id: teacherId } on the SERVICE-ROLE client, so the parameter is still
--     honoured for it. This is the only reason the parameter exists.
--   src/pages/admin/GroupDetail.tsx:137 — passes { p_group_id: id } ONLY, on the browser client, so it
--     falls through to auth.uid() exactly as before.
--
-- CLASS FANNED OUT, and it is a single instance. Searched every SECURITY DEFINER function in public
-- for `coalesce(<caller-supplied param>, auth.uid())`: this is the only one lacking a service_role
-- gate. Its siblings (admin_group_engagement_stats, get_visible_student_ids and the rest of the
-- 20260820100000 set) were hardened with exactly this pattern already.
--
-- ALSO: anon loses EXECUTE. There is no anonymous caller — the web page is behind <RequireAuth> and
-- the bot is service_role. PUBLIC is named in the revoke because that is where the grant actually
-- lives; `revoke ... from anon` alone is a no-op against an inherited PUBLIC grant.
--
-- Body reproduced verbatim from pg_get_functiondef() apart from the v_caller line.
-- Idempotent + replay-safe: create-or-replace plus declarative grants. No data is touched.

create or replace function public.admin_group_module_submissions(p_caller_profile_id uuid default null::uuid, p_group_id uuid default null::uuid)
returns table(group_id uuid, module_id uuid, module_position integer, module_title text, total_students integer, submitted_count integer)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
DECLARE
  -- THE FIX. A caller-supplied identity is honoured ONLY for service_role (the Telegram bot's
  -- /thomework path). Everyone else is themselves, whatever they pass.
  v_caller uuid := CASE WHEN auth.role() = 'service_role'
                        THEN COALESCE(p_caller_profile_id, auth.uid())
                        ELSE auth.uid()
                   END;
  v_is_admin boolean := false;
  v_is_teacher boolean := false;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'auth required'; END IF;
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = v_caller AND role = 'admin') INTO v_is_admin;
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = v_caller AND role = 'teacher') INTO v_is_teacher;
  IF NOT (v_is_admin OR v_is_teacher) THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN QUERY
  WITH allowed_groups AS (
    SELECT g.id, g.course_id FROM public.groups g
    WHERE (v_is_admin OR g.teacher_id = v_caller)
      AND (p_group_id IS NULL OR g.id = p_group_id)
  ),
  group_totals AS (
    SELECT p.group_id, COUNT(*)::int AS total_students
    FROM public.profiles p
    WHERE p.group_id IN (SELECT id FROM allowed_groups) AND p.archived_at IS NULL
    GROUP BY p.group_id
  ),
  group_modules AS (
    SELECT ag.id AS group_id, m.id AS module_id, m.position AS module_position, m.title AS module_title
    FROM allowed_groups ag JOIN public.modules m ON m.course_id = ag.course_id
  )
  SELECT gm.group_id, gm.module_id, gm.module_position, gm.module_title,
    COALESCE(gt.total_students, 0)::int AS total_students,
    (
      SELECT COUNT(DISTINCT p.id)::int FROM public.profiles p
      WHERE p.group_id = gm.group_id AND p.archived_at IS NULL
        AND EXISTS (
          SELECT 1 FROM public.homework_submissions hs
          JOIN public.homework_assignments ha ON ha.id = hs.assignment_id
          WHERE hs.user_id = p.id AND ha.module_id = gm.module_id AND ha.is_active = true
        )
    ) AS submitted_count
  FROM group_modules gm
  LEFT JOIN group_totals gt ON gt.group_id = gm.group_id
  ORDER BY gm.group_id, gm.module_position;
END;
$function$;

revoke execute on function public.admin_group_module_submissions(uuid, uuid) from public, anon;
grant  execute on function public.admin_group_module_submissions(uuid, uuid) to authenticated, service_role;

-- ───────────────────────── Deploy self-test (fails loud) ─────────────────────────
-- This one PROVES the bypass is closed rather than asserting it. A migration runs with auth.role()
-- NULL and auth.uid() NULL, i.e. exactly "not service_role". Under the OLD code, passing a real
-- admin uuid returned that admin's rows. Under the new code the parameter is ignored, v_caller falls
-- back to NULL, and it must raise 'auth required'. If it returns rows instead, the bypass is still
-- open and this migration rolls itself back.
do $selftest$
declare _n int; _raised boolean := false; _admin_uuid uuid; _bad text := '';
begin
  select ur.user_id into _admin_uuid from user_roles ur where ur.role = 'admin'::app_role limit 1;

  if _admin_uuid is null then
    _bad := 'no admin uuid available to test with; ';
  else
    begin
      select count(*) into _n
      from public.admin_group_module_submissions(_admin_uuid, null);
    exception when others then
      _raised := true;   -- expected: 'auth required'
    end;
    if not _raised then
      _bad := _bad || 'BYPASS STILL OPEN: caller-supplied uuid was honoured and returned '
                   || coalesce(_n, -1) || ' rows; ';
    end if;
  end if;

  if has_function_privilege('anon', 'public.admin_group_module_submissions(uuid, uuid)', 'EXECUTE') then
    _bad := _bad || 'anon still has EXECUTE; ';
  end if;
  if not has_function_privilege('authenticated', 'public.admin_group_module_submissions(uuid, uuid)', 'EXECUTE') then
    _bad := _bad || 'authenticated LOST EXECUTE (breaks GroupDetail.tsx); ';
  end if;
  if not has_function_privilege('service_role', 'public.admin_group_module_submissions(uuid, uuid)', 'EXECUTE') then
    _bad := _bad || 'service_role LOST EXECUTE (breaks the bot /thomework); ';
  end if;

  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, case when _bad = '' then 'caller_identity_bypass_fixed'
                       else 'caller_identity_bypass_fix_failed' end,
            jsonb_build_object('failures', nullif(_bad, ''),
                               'rejected_caller_supplied_uuid', _raised,
                               'at', now()));
  exception when others then null; end;

  if _bad <> '' then
    raise exception 'caller identity bypass self-test failed, rolling back: %', _bad;
  end if;
end $selftest$;
