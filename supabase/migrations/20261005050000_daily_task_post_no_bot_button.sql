-- No «📲 Vazifani botda ochish» button under the daily task post (owner request, 2026-10-05).
--
-- WHY: students submit daily tasks IN the group's «KUNLIK VAZIFALAR» topic. A button under the post that opens the
-- task in the bot pulls them out of the topic and confuses where to submit. The worker stops adding it in the same PR
-- (challenge-tasks-worker/worker.ts). This migration does the rest:
--   1. challenge_tasks_tick(): the SQL fallback poster (it posts the task itself when the worker is down) built the
--      same button. Pinned rewrite of the LIVE text: md5 7e39fa98… verified, the button expression asserted to occur
--      exactly once before and zero times after; owner / ACL / SECURITY DEFINER asserted unchanged.
--   2. Today's (2026-10-05, Tashkent) six task posts already carry the button: editMessageReplyMarkup with an empty
--      keyboard, through ops_net_post (attributed: purpose 'challenge_task_post_unbutton'). The post text is untouched;
--      only the button goes. Done once (audit row).

do $$
declare
  _oid oid := to_regprocedure('public.challenge_tasks_tick()');
  _src text;
  _def text;
  _new text;
  _acl text;
  _owner oid;
  _secdef boolean;
  _old_expr constant text := E'                -- the worker''s post button (challenge-tasks-worker/render.ts POST_BUTTON_TEXT; the harness asserts equality)\n'
    || E'                ''reply_markup'', case when coalesce(_bot, '''') ~ ''^[A-Za-z0-9_]{3,64}$'' then\n'
    || E'                  jsonb_build_object(''inline_keyboard'', jsonb_build_array(jsonb_build_array(jsonb_build_object(\n'
    || E'                    ''text'', ''📲 Vazifani botda ochish'', ''url'', ''https://t.me/'' || _bot || ''?start=dt_'' || _r.task_id::text)))) end)),';
  _new_expr constant text := E'                -- no button under a group post (owner, 2026-10-05; 20261005050000): students submit in the topic\n'
    || E'                ''reply_markup'', null::jsonb)),';
  _n int;
begin
  if _oid is null then
    raise exception 'ABORT: public.challenge_tasks_tick() is missing';
  end if;
  select prosrc, array_to_string(proacl, ','), proowner, prosecdef into _src, _acl, _owner, _secdef from pg_proc where oid = _oid;

  if position('no button under a group post' in _src) > 0 then
    raise notice 'challenge_tasks_tick already without the post button';
  else
    if md5(replace(_src, E'\r', '')) <> '7e39fa98f564daa287960c045fac7fdb' then
      raise exception 'ABORT: challenge_tasks_tick() is not the reviewed live text';
    end if;
    _def := replace(pg_get_functiondef(_oid), E'\r', '');
    _n := (length(_def) - length(replace(_def, _old_expr, ''))) / length(_old_expr);
    if _n <> 1 then
      raise exception 'ABORT: the post-button expression occurs % times, expected exactly 1', _n;
    end if;
    _new := replace(_def, _old_expr, _new_expr);
    execute _new;
    select prosrc into _src from pg_proc where oid = _oid;
    if position('Vazifani botda ochish' in _src) > 0 or position('no button under a group post' in _src) = 0 then
      raise exception 'ABORT: challenge_tasks_tick() was not rewritten cleanly';
    end if;
    if (select array_to_string(proacl, ',') from pg_proc where oid = _oid) is distinct from _acl
       or (select proowner from pg_proc where oid = _oid) <> _owner
       or (select prosecdef from pg_proc where oid = _oid) is distinct from _secdef then
      raise exception 'ABORT: challenge_tasks_tick() changed its owner, ACL or SECURITY DEFINER';
    end if;
  end if;
end $$;

-- 2. take the button off today's posts (once)
do $$
declare
  _tok text;
  _r record;
  _n int := 0;
begin
  if exists (select 1 from public.admin_actions where action = 'challenge_task_post_unbuttoned' and details->>'day' = '2026-10-05') then
    raise notice 'today''s posts were already unbuttoned';
    return;
  end if;
  select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
  if coalesce(_tok, '') = '' then
    raise notice 'no bot token, nothing edited';
    return;
  end if;
  for _r in
    select p.chat_id, p.message_id, p.task_id, p.group_id
      from public.challenge_task_posts p
      join public.challenge_tasks t on t.id = p.task_id
     where t.task_date = date '2026-10-05' and p.kind = 'task'
       and p.state in ('sent', 'sent_via_sql') and p.message_id is not null and p.chat_id is not null
  loop
    perform public.ops_net_post(
      p_url        := 'https://api.telegram.org/bot' || _tok || '/editMessageReplyMarkup',
      p_body       := jsonb_build_object('chat_id', _r.chat_id, 'message_id', _r.message_id,
                                         'reply_markup', jsonb_build_object('inline_keyboard', '[]'::jsonb)),
      p_headers    := jsonb_build_object('Content-Type', 'application/json'),
      p_purpose    := 'challenge_task_post_unbutton',
      p_timeout_ms := 10000);
    _n := _n + 1;
  end loop;
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'challenge_task_post_unbuttoned', jsonb_build_object('day', '2026-10-05', 'posts', _n,
          'migration', '20261005050000', 'at', now()));
end $$;
