-- FIX: #253 created a same-named overload of an existing function (found 2026-10-03, my own bug).
--
-- WHAT HAPPENED
--   Migration 20261001090000 (#253, "walk a week task by task") created
--     public.challenge_task_card(_task_id bigint)
--   but the Daily Tasks engine (PR-3) already had
--     public.challenge_task_card(_task_id bigint, _tg_user bigint DEFAULT NULL)   (live md5 817c8cf8...)
--   Because the old one's second argument has a DEFAULT, any call that passes ONLY _task_id matches both,
--   and PostgreSQL refuses to choose ("function challenge_task_card(bigint) is not unique"; PostgREST
--   PGRST203). I created a new function without first checking that its name was free.
--
-- WHO WAS HIT (verified against every caller in src/ and supabase/functions/)
--   * Students: NOT affected. Both student-facing callers pass _tg_user explicitly, so the call is
--     unambiguous: submit-daily-task/core.ts:377 ({_task_id, _tg_user: null}) and the bot's
--     /start dt_<id> card, telegram-bot-webhook/daily-tasks.ts:425 ({_task_id, _tg_user}).
--   * The owner's NEW task-by-task feature: broken, failing safe. The bot's card lookup
--     ({_task_id} only) errors and shows "task not found"; challenge_tasks_approve_task and
--     challenge_tasks_set_task_body call challenge_task_card(_t.id) positionally, so they raise and
--     roll back their own work — nothing could be approved or rewritten by mistake. Unused so far:
--     week 1 was approved on the website at 02:59 UTC, one minute before #253 deployed at 03:00.
--
-- THE FIX
--   1. The admin card gets its own, unshared name: challenge_task_admin_card(bigint). Same body.
--   2. challenge_tasks_approve_task and challenge_tasks_set_task_body are repointed to it — pinned
--      rewrites of the LIVE text (md5 6c898a72... and 8fc91f9a...), each asserted to contain exactly
--      2 references before the replace and 0 after.
--   3. ONLY my overload, challenge_task_card(bigint), is dropped. The engine's
--      challenge_task_card(bigint, bigint) is asserted to still exist with its body byte-identical
--      (md5 817c8cf8...), so the student flows cannot be touched by this migration.
--   The bot is repointed in the same PR (telegram-bot-webhook/index.ts).
--
-- REPLAY: a second run finds the rewrites already applied (their bodies reference
--   challenge_task_admin_card) and the overload already gone, and changes nothing.

create or replace function public.challenge_task_admin_card(_task_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- One task as the admins' task-by-task view renders it. Read-only. NULL task -> {ok:false, reason:'not_found'}.
-- Named apart from the engine's challenge_task_card(bigint, bigint DEFAULT NULL) on purpose: a same-named
-- one-argument overload makes every call that passes only _task_id ambiguous (20261003040000).
declare
  _cfg jsonb := public.challenge_tasks_config();
  _today date := public.challenge_task_local_date(now());
  _t public.challenge_tasks;
  _posted boolean;
begin
  if coalesce(auth.role(), '') not in ('service_role', 'authenticated') then
    raise exception using errcode = '42501', message = 'challenge_task_admin_card: not allowed';
  end if;
  select * into _t from public.challenge_tasks where id = _task_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  _posted := exists (select 1 from public.challenge_task_posts p where p.task_id = _t.id and p.state in ('sent', 'sent_via_sql'));
  return jsonb_build_object(
    'ok', true,
    'task_id', _t.id,
    'date', _t.task_date,
    'weekday', extract(isodow from _t.task_date)::int,
    'title', _t.title,
    'body', _t.body,
    'learn_line', _t.learn_line,
    'submit_hint', _t.submit_hint,
    'type', _t.type,
    'points', coalesce(_t.points, case when _t.type = 'instagram'
                                       then (_cfg->'points'->>'instagram')::int
                                       else (_cfg->'points'->>'general')::int end),
    'minutes', _t.minutes,
    'status', _t.status,
    'past', _t.task_date < _today,
    'today', _today,
    'posted', _posted,
    'approved_at', _t.approved_at,
    'post_length', public.challenge_task_post_length(public.challenge_task_render_post(_t)));
end
$fn$;

revoke execute on function public.challenge_task_admin_card(bigint) from public, anon, authenticated;
grant execute on function public.challenge_task_admin_card(bigint) to service_role, authenticated;

do $$
declare
  _fn text;
  _pin text;
  _oid oid;
  _src text;
  _def text;
  _new text;
  _acl_before text;
  _acl_after text;
  _owner_before oid;
  _secdef_before boolean;
  _n int;
  _needle constant text := 'public.challenge_task_card(';
  _repl constant text := 'public.challenge_task_admin_card(';
  _engine_md5 constant text := '817c8cf8dfd0b13ccb24d0ea6db31fd2';
  _rewritten int := 0;
begin
  -- the engine's card must exist, untouched, before AND after: the student flows depend on it
  if to_regprocedure('public.challenge_task_card(bigint, bigint)') is null then
    raise exception 'ABORT: the engine''s challenge_task_card(bigint, bigint) is missing';
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
       where oid = 'public.challenge_task_card(bigint, bigint)'::regprocedure) <> _engine_md5 then
    raise exception 'ABORT: the engine''s challenge_task_card(bigint, bigint) is not the verified body (md5 %)', _engine_md5;
  end if;

  foreach _fn in array array['public.challenge_tasks_approve_task(bigint, uuid)', 'public.challenge_tasks_set_task_body(bigint, text, uuid)'] loop
    _pin := case _fn when 'public.challenge_tasks_approve_task(bigint, uuid)' then '6c898a72af2765672ccde6abefb584f9'
                     else '8fc91f9a19a19c54bf0b1a1db9cea8a0' end;
    _oid := to_regprocedure(_fn);
    if _oid is null then
      raise exception 'ABORT: % is missing', _fn;
    end if;
    select prosrc, pg_get_functiondef(oid), array_to_string(proacl, ','), proowner, prosecdef
      into _src, _def, _acl_before, _owner_before, _secdef_before
      from pg_proc where oid = _oid;

    if position(_needle in _src) = 0 and position(_repl in _src) > 0 then
      continue;   -- replay: already repointed
    end if;
    if md5(replace(_src, E'\r', '')) <> _pin then
      raise exception 'ABORT: % is not the verified live body (md5 % expected)', _fn, _pin;
    end if;
    _n := (length(_def) - length(replace(_def, _needle, ''))) / length(_needle);
    if _n <> 2 then
      raise exception 'ABORT: % references challenge_task_card % time(s), expected exactly 2', _fn, _n;
    end if;

    _new := replace(_def, _needle, _repl);
    execute _new;

    select prosrc into _src from pg_proc where oid = _oid;
    if position(_needle in _src) > 0 or (length(_src) - length(replace(_src, _repl, ''))) / length(_repl) <> 2 then
      raise exception 'ABORT: % was not repointed cleanly', _fn;
    end if;
    select array_to_string(proacl, ',') into _acl_after from pg_proc where oid = _oid;
    if _acl_after is distinct from _acl_before
       or (select proowner from pg_proc where oid = _oid) <> _owner_before
       or (select prosecdef from pg_proc where oid = _oid) is distinct from _secdef_before then
      raise exception 'ABORT: % changed its owner, ACL or SECURITY DEFINER', _fn;
    end if;
    _rewritten := _rewritten + 1;
  end loop;

  -- Only now, with nothing left referencing it, drop MY overload. Never the engine's.
  if to_regprocedure('public.challenge_task_card(bigint)') is not null then
    drop function public.challenge_task_card(bigint);
  end if;

  -- the end state: exactly one challenge_task_card, the engine's, byte-identical; the admin card exists
  select count(*) into _n from pg_proc where pronamespace = 'public'::regnamespace and proname = 'challenge_task_card';
  if _n <> 1 then
    raise exception 'ABORT: expected exactly one challenge_task_card after the fix, found %', _n;
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc
       where oid = 'public.challenge_task_card(bigint, bigint)'::regprocedure) <> _engine_md5 then
    raise exception 'ABORT: the engine''s challenge_task_card changed';
  end if;
  if to_regprocedure('public.challenge_task_admin_card(bigint)') is null then
    raise exception 'ABORT: challenge_task_admin_card(bigint) was not created';
  end if;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
              and proname in ('challenge_tasks_approve_task', 'challenge_tasks_set_task_body')
              and position(_needle in prosrc) > 0) then
    raise exception 'ABORT: an RPC still calls the ambiguous challenge_task_card';
  end if;

  if not exists (select 1 from public.admin_actions where action = 'challenge_task_card_overload_fixed') then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_task_card_overload_fixed', jsonb_build_object(
      'at', now(),
      'migration', '20261003040000',
      'rewritten', _rewritten,
      'dropped', 'public.challenge_task_card(bigint)',
      'kept', 'public.challenge_task_card(bigint, bigint) md5 ' || _engine_md5,
      'why', '#253 created a one-argument overload of the engine''s challenge_task_card(bigint, bigint DEFAULT NULL), making every _task_id-only call ambiguous'));
  end if;
end $$;
