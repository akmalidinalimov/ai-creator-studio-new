-- Open the BONUS module (AI bilan multfilm tayyorlash) to every Challenge 6.0 student WITHOUT opening modules 4 and 5
-- (owner, 2026-10-14: "open the bonus lesson on the Mini App"; chose "only the bonus").
--
-- Access was "the first module_limit modules by position" only, and the bonus is 6th, so no limit could open it alone.
-- New: modules.always_open — a module every enrolled student of a published course may open, whatever the tier limit.
-- The rule lives in the database functions every access path reads:
--   has_module_access      (lesson-video-url, quizzes, the homework picker student_assignable_homework, support facts)
--   is_module_tier_locked  (legacy lock check)
--   profile_stats          (the progress % counts the bonus lessons once they are open)
-- and the client / bot / reminder clamps were changed in the same PR to read the same column.
-- Each live function is rewritten from its md5-pinned live text (CLAUDE.md); a different live body refuses the
-- migration (all-or-nothing — the app code in this PR depends on all three).

alter table public.modules add column if not exists always_open boolean not null default false;
comment on column public.modules.always_open is
  'Open to every enrolled student of the (published) course, whatever course_tiers.module_limit says (e.g. a bonus).';

do $mig$
declare
  _def text;
  _old text;
  _new text;
begin
  -- 1. has_module_access: after the enrolment + "unlimited tier" checks, an always-open module is open.
  _def := pg_get_functiondef('public.has_module_access(uuid, uuid)'::regprocedure);
  if position('always_open' in _def) = 0 then
    if md5(_def) <> '2860f4493b32cc7d32a9acb8c0a09444' then
      raise exception 'has_module_access differs from the verified body (md5 %) — refusing', md5(_def);
    end if;
    _old := 'if _limit is null then return true; end if;';
    if (length(_def) - length(replace(_def, _old, ''))) / length(_old) <> 1 then
      raise exception 'has_module_access: anchor not found exactly once';
    end if;
    _new := _old || E'\n\n  -- an always-open module (e.g. a bonus) is open to every enrolled student, whatever the tier limit\n'
            || '  if exists (select 1 from public.modules where id = _module_id and always_open) then return true; end if;';
    execute replace(_def, _old, _new);
  end if;

  -- 2. is_module_tier_locked: an always-open module is never tier-locked.
  _def := pg_get_functiondef('public.is_module_tier_locked(uuid, uuid)'::regprocedure);
  if position('always_open' in _def) = 0 then
    if md5(_def) <> '465d9c77d6c9f17fa25bc08d0e6de8e1' then
      raise exception 'is_module_tier_locked differs from the verified body (md5 %) — refusing', md5(_def);
    end if;
    _old := 'IF _limit IS NULL THEN RETURN false; END IF;';
    if (length(_def) - length(replace(_def, _old, ''))) / length(_old) <> 1 then
      raise exception 'is_module_tier_locked: anchor not found exactly once';
    end if;
    _new := _old || E'\n  IF EXISTS (SELECT 1 FROM public.modules WHERE id = _module_id AND always_open) THEN RETURN false; END IF;';
    execute replace(_def, _old, _new);
  end if;

  -- 3. profile_stats: the tier's modules include the always-open ones.
  _def := pg_get_functiondef('public.profile_stats(uuid)'::regprocedure);
  if position('always_open' in _def) = 0 then
    if md5(_def) <> '85b9c2b00ae68cbf3b3b317f3965a303' then
      raise exception 'profile_stats differs from the verified body (md5 %) — refusing', md5(_def);
    end if;
    _old := 'or rnk <= (select module_limit from my_limit)';
    if (length(_def) - length(replace(_def, _old, ''))) / length(_old) <> 1 then
      raise exception 'profile_stats: anchor not found exactly once';
    end if;
    _new := _old || E'\n       or id in (select x.id from modules x where x.always_open)';
    execute replace(_def, _old, _new);
  end if;
end
$mig$;

-- The 6.0 bonus module.
update public.modules set always_open = true
 where id = 'ff3dcb2a-b328-4719-a53c-95d1c80113d4'
   and course_id = 'f502f631-2104-4834-b6c2-702cd3080e27'
   and not always_open;

insert into public.admin_actions (actor_user_id, action, details)
select null, 'module_always_open_set', jsonb_build_object(
  'module_id', 'ff3dcb2a-b328-4719-a53c-95d1c80113d4', 'module', 'BONUS: AI BILAN MULTFILM TAYYORLASH',
  'course_id', 'f502f631-2104-4834-b6c2-702cd3080e27', 'migration', '20261014191200')
where not exists (select 1 from public.admin_actions where action = 'module_always_open_set'
                    and details->>'migration' = '20261014191200');

-- self-test (read-only): the three functions now carry the rule
do $test$
begin
  if position('always_open' in pg_get_functiondef('public.has_module_access(uuid, uuid)'::regprocedure)) = 0
     or position('always_open' in pg_get_functiondef('public.is_module_tier_locked(uuid, uuid)'::regprocedure)) = 0
     or position('always_open' in pg_get_functiondef('public.profile_stats(uuid)'::regprocedure)) = 0 then
    raise exception 'selftest: always_open rule missing from an access function';
  end if;
end
$test$;
