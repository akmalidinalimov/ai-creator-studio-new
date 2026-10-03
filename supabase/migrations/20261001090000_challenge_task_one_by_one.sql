-- Daily Tasks: approve or rewrite ONE task from the bot (owner's request, 2026-10-01).
--
-- WHAT THE OWNER ASKED FOR
--   The weekly ask has one ✅ for the whole week. They want to walk the week task by task: each task as
--   its own message with [✅ Tasdiqlash] and [✏️ O'zgartirish]; ✅ approves that task, ✏️ lets them send
--   the new text as a plain reply and replaces the task's body.
--
-- THREE FUNCTIONS, all SECURITY DEFINER, service_role + authenticated only (never anon)
--   1. challenge_task_card(_task_id)        read-only: everything one task card renders.
--   2. challenge_tasks_approve_task(...)    approves THAT task through trg_challenge_tasks_guard.
--   3. challenge_tasks_set_task_body(...)   replaces the task's body text.
--
-- THE RULES THEY INHERIT (deliberately identical to challenge_tasks_approve_week, 20260930200010)
--   * Who: service_role must name a verified admin in _actor (the bot passes the REAL clicker, which
--     the webhook has already checked); authenticated is auth.uid() and must be an admin; anything else
--     is refused. The body never makes anyone an admin.
--   * approved_by is the real admin: the guard stamps auth.uid(), so the service-role path sets
--     request.jwt.claims (and the legacy claim.sub that auth.uid() prefers) LOCALLY for the one
--     statement and restores them after.
--   * PAST DAYS ARE NEVER APPROVED (d8 of PR-9, a reviewed finding): PR-5's tick never posts a past
--     task date, and challenge_task_streak_current walks every approved date, so a day approved after
--     the fact would never be posted and would become a miss for every student. A past task returns
--     {ok:false, reason:'past_day'} and stays a draft.
--   * The guard is still the last word on an approval (scope, window, requires, post length) and
--     trg_challenge_tasks_zz_lock is still the last word on an edit (a task that has been posted or
--     has live submissions is refused). Both raise, both are caught, and the caller gets the reason
--     instead of an exception.
--
-- WHY A BODY EDIT NEEDS ITS OWN LENGTH CHECK
--   trg_challenge_tasks_guard measures the rendered post only when a row IS or BECOMES approved. A
--   DRAFT can therefore be edited into something too long for one Telegram message (> 4000 UTF-16
--   units) and would only fail later, at approval, from a different screen. So the edit renders the
--   candidate row itself with the same two functions the guard uses and refuses up front.
--
-- NOT CHANGED HERE: the title, type, points, requires and accepts. The bot's prompt says so, and the
--   calendar (Admin → Kunlik vazifalar) stays the place to change those.

create or replace function public.challenge_task_card(_task_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- One task as the bot renders it. Read-only. NULL task -> {ok:false, reason:'not_found'}.
declare
  _cfg jsonb := public.challenge_tasks_config();
  _today date := public.challenge_task_local_date(now());
  _t public.challenge_tasks;
  _posted boolean;
begin
  if coalesce(auth.role(), '') not in ('service_role', 'authenticated') then
    raise exception using errcode = '42501', message = 'challenge_task_card: not allowed';
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

create or replace function public.challenge_tasks_approve_task(_task_id bigint, _actor uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- Approves ONE draft through trg_challenge_tasks_guard. Never raises for an expected refusal: the
-- caller gets {ok:false, reason, error} and nothing changed. See the file header for the rules.
declare
  _role text := coalesce(auth.role(), '');
  _uid uuid := auth.uid();
  _today date := public.challenge_task_local_date(now());
  _who uuid;
  _via text;
  _t public.challenge_tasks;
  _old_claims text;
  _old_sub text;
  _err text;
  _res jsonb;
begin
  if _role = 'service_role' then
    if _actor is null then
      raise exception using errcode = '42501', message = 'challenge_tasks_approve_task: _actor is required';
    end if;
    _who := _actor; _via := 'telegram';
  elsif _role = 'authenticated' then
    if _uid is null or (_actor is not null and _actor <> _uid) then
      raise exception using errcode = '42501', message = 'challenge_tasks_approve_task: not allowed';
    end if;
    _who := _uid; _via := 'web';
  else
    raise exception using errcode = '42501', message = 'challenge_tasks_approve_task: not allowed';
  end if;
  if not public.has_role(_who, 'admin'::public.app_role) then
    raise exception using errcode = '42501', message = 'Faqat admin vazifani tasdiqlay oladi';
  end if;

  -- one approval of a task at a time: a double tap, or two admins, find it already approved
  perform pg_advisory_xact_lock(hashtext('challenge_tasks_approve_task:' || _task_id::text));
  select * into _t from public.challenge_tasks where id = _task_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if _t.status = 'approved' then
    return jsonb_build_object('ok', true, 'already', true, 'task_id', _t.id, 'date', _t.task_date,
                              'title', _t.title, 'card', public.challenge_task_card(_t.id));
  end if;
  if _t.status <> 'draft' then
    return jsonb_build_object('ok', false, 'reason', 'not_draft', 'status', _t.status, 'task_id', _t.id);
  end if;
  if _t.task_date < _today then
    return jsonb_build_object('ok', false, 'reason', 'past_day', 'task_id', _t.id, 'date', _t.task_date,
                              'message', 'O‘tgan kun — kerak bo‘lsa, kalendarda alohida (retro) tasdiqlang');
  end if;

  _old_claims := current_setting('request.jwt.claims', true);
  _old_sub := current_setting('request.jwt.claim.sub', true);
  if _via = 'telegram' then
    perform set_config('request.jwt.claims', jsonb_build_object('sub', _who, 'role', 'service_role')::text, true);
    perform set_config('request.jwt.claim.sub', _who::text, true);
  end if;
  begin
    update public.challenge_tasks set status = 'approved' where id = _task_id and status = 'draft';
  exception when others then
    _err := left(sqlerrm, 300);
  end;
  if _via = 'telegram' then
    perform set_config('request.jwt.claims', coalesce(_old_claims, ''), true);
    perform set_config('request.jwt.claim.sub', coalesce(_old_sub, ''), true);
  end if;

  if _err is not null then
    insert into public.admin_actions (actor_user_id, action, details)
    values (_who, 'challenge_task_approve_failed', jsonb_build_object(
      'task_id', _task_id, 'date', _t.task_date, 'title', _t.title, 'via', _via, 'error', _err, 'at', now()));
    return jsonb_build_object('ok', false, 'reason', 'guard_refused', 'error', _err, 'task_id', _t.id,
                              'date', _t.task_date, 'title', _t.title);
  end if;

  _res := jsonb_build_object('ok', true, 'task_id', _t.id, 'date', _t.task_date, 'title', _t.title,
                             'via', _via, 'actor', _who, 'card', public.challenge_task_card(_t.id));
  insert into public.admin_actions (actor_user_id, action, details)
  values (_who, 'challenge_task_approved_one', jsonb_build_object(
    'task_id', _t.id, 'date', _t.task_date, 'title', _t.title, 'via', _via, 'at', now()));
  return _res;
end
$fn$;

create or replace function public.challenge_tasks_set_task_body(_task_id bigint, _body text, _actor uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- Replaces ONE task's body text (the instructions students read). Title, type, points, requires and
-- accepts are untouched. Refuses up front anything the approval guard would later reject for length,
-- and lets trg_challenge_tasks_zz_lock refuse a task that has already been posted.
declare
  _role text := coalesce(auth.role(), '');
  _uid uuid := auth.uid();
  _who uuid;
  _via text;
  _t public.challenge_tasks;
  _cand public.challenge_tasks;
  _text text := btrim(coalesce(_body, ''), E' \t\r\n');
  _len int;
  _old_claims text;
  _old_sub text;
  _err text;
begin
  if _role = 'service_role' then
    if _actor is null then
      raise exception using errcode = '42501', message = 'challenge_tasks_set_task_body: _actor is required';
    end if;
    _who := _actor; _via := 'telegram';
  elsif _role = 'authenticated' then
    if _uid is null or (_actor is not null and _actor <> _uid) then
      raise exception using errcode = '42501', message = 'challenge_tasks_set_task_body: not allowed';
    end if;
    _who := _uid; _via := 'web';
  else
    raise exception using errcode = '42501', message = 'challenge_tasks_set_task_body: not allowed';
  end if;
  if not public.has_role(_who, 'admin'::public.app_role) then
    raise exception using errcode = '42501', message = 'Faqat admin vazifani o‘zgartira oladi';
  end if;

  if _text = '' then
    return jsonb_build_object('ok', false, 'reason', 'empty');
  end if;
  if length(_text) > 3500 then
    return jsonb_build_object('ok', false, 'reason', 'too_long', 'length', length(_text), 'max', 3500);
  end if;

  perform pg_advisory_xact_lock(hashtext('challenge_tasks_set_task_body:' || _task_id::text));
  select * into _t from public.challenge_tasks where id = _task_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if _t.status = 'cancelled' then
    return jsonb_build_object('ok', false, 'reason', 'cancelled', 'task_id', _t.id);
  end if;
  if _t.body = _text then
    return jsonb_build_object('ok', true, 'unchanged', true, 'task_id', _t.id, 'card', public.challenge_task_card(_t.id));
  end if;

  -- the same measurement the approval guard makes, BEFORE the write (a draft is not measured by the
  -- guard, so without this an edit could make the task un-approvable from somewhere else entirely)
  _cand := _t;
  _cand.body := _text;
  _len := public.challenge_task_post_length(public.challenge_task_render_post(_cand));
  if _len > 4000 then
    return jsonb_build_object('ok', false, 'reason', 'post_too_long', 'post_length', _len, 'max', 4000);
  end if;

  _old_claims := current_setting('request.jwt.claims', true);
  _old_sub := current_setting('request.jwt.claim.sub', true);
  if _via = 'telegram' then
    perform set_config('request.jwt.claims', jsonb_build_object('sub', _who, 'role', 'service_role')::text, true);
    perform set_config('request.jwt.claim.sub', _who::text, true);
  end if;
  begin
    update public.challenge_tasks set body = _text where id = _task_id;
  exception when others then
    _err := left(sqlerrm, 300);
  end;
  if _via = 'telegram' then
    perform set_config('request.jwt.claims', coalesce(_old_claims, ''), true);
    perform set_config('request.jwt.claim.sub', coalesce(_old_sub, ''), true);
  end if;

  if _err is not null then
    insert into public.admin_actions (actor_user_id, action, details)
    values (_who, 'challenge_task_edit_failed', jsonb_build_object(
      'task_id', _task_id, 'date', _t.task_date, 'via', _via, 'error', _err, 'at', now()));
    return jsonb_build_object('ok', false, 'reason', 'refused', 'error', _err, 'task_id', _t.id);
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  values (_who, 'challenge_task_body_edited', jsonb_build_object(
    'task_id', _t.id, 'date', _t.task_date, 'title', _t.title, 'via', _via, 'status', _t.status,
    'old_length', length(_t.body), 'new_length', length(_text), 'post_length', _len, 'at', now()));
  return jsonb_build_object('ok', true, 'task_id', _t.id, 'date', _t.task_date, 'title', _t.title,
                            'status', _t.status, 'card', public.challenge_task_card(_t.id));
end
$fn$;

revoke execute on function public.challenge_task_card(bigint) from public, anon, authenticated;
revoke execute on function public.challenge_tasks_approve_task(bigint, uuid) from public, anon, authenticated;
revoke execute on function public.challenge_tasks_set_task_body(bigint, text, uuid) from public, anon, authenticated;
grant execute on function public.challenge_task_card(bigint) to service_role, authenticated;
grant execute on function public.challenge_tasks_approve_task(bigint, uuid) to service_role, authenticated;
grant execute on function public.challenge_tasks_set_task_body(bigint, text, uuid) to service_role, authenticated;

-- Read-only self-test: the three functions exist with the shape the bot calls, they are SECURITY
-- DEFINER with a pinned search_path, and anon can reach none of them. It calls NONE of them: two of
-- the three write, and challenge_task_card's own guard needs a JWT role that a migration does not
-- have (a self-test that needed one would raise on every single deploy).
do $$
declare
  _fn text;
  _oid oid;
  _acl text;
begin
  foreach _fn in array array[
    'public.challenge_task_card(bigint)',
    'public.challenge_tasks_approve_task(bigint, uuid)',
    'public.challenge_tasks_set_task_body(bigint, text, uuid)'
  ] loop
    _oid := to_regprocedure(_fn);
    if _oid is null then
      raise exception 'ABORT: % was not created', _fn;
    end if;
    if not (select prosecdef from pg_proc where oid = _oid) then
      raise exception 'ABORT: % is not SECURITY DEFINER', _fn;
    end if;
    if not exists (select 1 from pg_proc, unnest(coalesce(proconfig, '{}')) c
                    where oid = _oid and c = 'search_path=public') then
      raise exception 'ABORT: % has no pinned search_path', _fn;
    end if;
    -- PUBLIC is the proacl entry with an EMPTY grantee; 'anon=X' would be anon's own grant
    _acl := coalesce((select array_to_string(proacl, ',') from pg_proc where oid = _oid), '');
    if _acl like '%=X%' and _acl ~ '(^|,)=X' then
      raise exception 'ABORT: % is executable by PUBLIC', _fn;
    end if;
    if _acl like '%anon=X%' then
      raise exception 'ABORT: % is executable by anon', _fn;
    end if;
  end loop;

  if not exists (select 1 from public.admin_actions where action = 'challenge_task_one_by_one_installed') then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_task_one_by_one_installed', jsonb_build_object(
      'at', now(),
      'migration', '20261001090000',
      'functions', jsonb_build_array('challenge_task_card(bigint)',
                                     'challenge_tasks_approve_task(bigint, uuid)',
                                     'challenge_tasks_set_task_body(bigint, text, uuid)'),
      'why', 'the owner walks the week task by task in the bot: ✅ approves one task, ✏️ replaces its text by replying'));
  end if;
end $$;
