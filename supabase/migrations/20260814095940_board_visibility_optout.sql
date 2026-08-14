-- Per-student opt-out from the PUBLIC group boards (weekly XP leaderboard + homework spotlight), plus
-- a defensive hardening of the weekly board's per-group loop.
--
-- (1) profiles.hide_from_group_boards — when true, the student is excluded from BOTH group-posted
--     public boards (they still count in XP, the /leaderboard page, and the teacher/admin daily digest;
--     this only removes their NAME from the messages posted into the group chat). Set via
--     set_board_visibility() — callable by the student on themselves OR an admin/superadmin on anyone.
-- (2) post_group_weekly_boards() rewrite: adds the exclusion AND wraps the whole per-group body in
--     begin/exception (matching post_group_homework_spotlight) so a future bad config value can't abort
--     the run — the gap the migration-safety review flagged.
-- (3) post_group_homework_spotlight() rewrite: adds the same exclusion.

alter table public.profiles add column if not exists hide_from_group_boards boolean not null default false;

create or replace function public.set_board_visibility(_student uuid, _hidden boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A student may hide/show ONLY themselves; admins/superadmins may set anyone.
  -- (_student is null short-circuits so the NULL three-valued IF can't skip the raise.)
  if _student is null
     or not (auth.uid() = _student
             or has_role(auth.uid(), 'admin'::app_role)
             or has_role(auth.uid(), 'superadmin'::app_role)) then
    raise exception 'not authorized';
  end if;
  update public.profiles set hide_from_group_boards = coalesce(_hidden, false) where id = _student;
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (auth.uid(), 'board_visibility_set',
            jsonb_build_object('student', _student, 'hidden', coalesce(_hidden, false), 'at', now()));
  exception when others then null; end;
  return coalesce(_hidden, false);
end;
$$;
revoke execute on function public.set_board_visibility(uuid, boolean) from public, anon;
grant execute on function public.set_board_visibility(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- Weekly XP board — add the hidden-student exclusion + wrap the whole per-group body in begin/exception.
create or replace function public.post_group_weekly_boards()
returns integer
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  _cfg jsonb; _topics jsonb; _excl uuid[]; _tok text;
  _this_mon timestamptz; _prev_mon timestamptz; _week date;
  _done text[];
  _g record; _thread bigint; _chat bigint; _lines text; _text text; _body jsonb; _req bigint;
  _posted int := 0; _no_xp int := 0; _unconfigured int := 0; _no_chat int := 0; _errors int := 0;
begin
  perform pg_advisory_xact_lock(hashtext('post_group_weekly_boards'));

  select value into _cfg from platform_settings where key = 'group_weekly_board';
  if _cfg is null or not coalesce((_cfg->>'enabled')::boolean, true) then return 0; end if;
  _topics := coalesce(_cfg->'topics', '{}'::jsonb);
  select coalesce(array_agg(v::uuid), '{}') into _excl
  from jsonb_array_elements_text(coalesce(_cfg->'exclude_group_ids', '[]'::jsonb)) v;

  select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
  if _tok is null or _tok = '' then return 0; end if;

  _this_mon := (date_trunc('week', (now() at time zone 'Asia/Tashkent')) at time zone 'Asia/Tashkent');
  _prev_mon := _this_mon - interval '7 days';
  _week := _prev_mon::date;

  select coalesce(array_agg(details->>'group_id'), '{}') into _done
  from admin_actions
  where action = 'group_weekly_board_posted' and details->>'week' = _week::text;

  for _g in
    select g.id, g.course_id from groups g join courses c on c.id = g.course_id
    where c.published = true and not (g.id = any(_excl))
  loop
    begin
      if _g.id::text = any(_done) then continue; end if;

      _thread := nullif(_topics->>(_g.id::text), '')::bigint;
      if _thread is null then _unconfigured := _unconfigured + 1; continue; end if;

      select telegram_chat_id into _chat from group_message_events
        where group_id = _g.id order by sent_at desc limit 1;
      if _chat is null then _no_chat := _no_chat + 1; continue; end if;

      select string_agg(
               (case r.rnk when 1 then '🥇' when 2 then '🥈' when 3 then '🥉' else r.rnk::text || '.' end)
               || ' ' || r.d || ' — <b>' || r.wk || ' XP</b>', E'\n' order by r.rnk)
        into _lines
      from (
        select row_number() over (order by d.wk desc, d.id) as rnk, d.d, d.wk
        from (
          select s.id, s.wk,
                 replace(replace(replace(coalesce(nullif(s.name, ''), 'Talaba'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
                 || case when nullif(s.last_name, '') is not null
                      then ' ' || replace(replace(replace(left(s.last_name, 1), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '.'
                      else '' end as d
          from (
            select p.id, p.name, p.last_name,
                   ( public.user_group_rating_xp_since(p.id, _g.course_id, _prev_mon)
                   - public.user_group_rating_xp_since(p.id, _g.course_id, _this_mon) ) as wk
            from profiles p
            where p.group_id = _g.id and p.status = 'active' and p.archived_at is null
              and not coalesce(p.hide_from_group_boards, false)
          ) s
          where s.wk > 0
        ) d
      ) r
      where r.rnk <= 10;

      if _lines is null then
        _no_xp := _no_xp + 1;
        insert into admin_actions (actor_user_id, action, details)
        values (null, 'group_weekly_board_posted',
                jsonb_build_object('group_id', _g.id, 'week', _week, 'count', 0, 'skipped', 'no_xp', 'at', now()));
        continue;
      end if;

      _text := '🏆 <b>HAFTALIK REYTING — TOP 10</b>' || E'\n'
            || '<i>O''tgan hafta eng ko''p XP to''plaganlar</i>' || E'\n\n'
            || _lines || E'\n\n'
            || '👏 Tabriklaymiz! Yangi hafta — yangi imkoniyat. Davom etamiz! 💪';

      _body := jsonb_build_object('chat_id', _chat, 'text', _text, 'parse_mode', 'HTML', 'disable_web_page_preview', true);
      if _thread > 1 then _body := _body || jsonb_build_object('message_thread_id', _thread); end if;

      _req := public.ops_net_post(
        'https://api.telegram.org/bot' || _tok || '/sendMessage',
        _body, jsonb_build_object('Content-Type', 'application/json'), 'group-weekly-board', 8000);
      _posted := _posted + 1;
      insert into admin_actions (actor_user_id, action, details)
      values (null, 'group_weekly_board_posted',
              jsonb_build_object('group_id', _g.id, 'week', _week, 'chat_id', _chat, 'thread', _thread, 'req_id', _req, 'at', now()));
    exception when others then
      _errors := _errors + 1;
      begin
        insert into admin_actions (actor_user_id, action, details)
        values (null, 'group_weekly_board_failed',
                jsonb_build_object('group_id', _g.id, 'week', _week, 'error', sqlerrm, 'at', now()));
      exception when others then null; end;
    end;
  end loop;

  begin
    insert into admin_actions (actor_user_id, action, details)
    values (null, 'group_weekly_board_run',
            jsonb_build_object('posted', _posted, 'no_xp', _no_xp, 'unconfigured', _unconfigured,
                               'no_chat', _no_chat, 'errors', _errors, 'week', _week, 'at', now()));
  exception when others then null; end;

  return _posted;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- Homework spotlight — add the same hidden-student exclusion (already per-group guarded).
create or replace function public.post_group_homework_spotlight()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  _cfg jsonb; _topics jsonb; _excl uuid[]; _tok text; _min int;
  _since timestamptz; _week text; _done text[];
  _g record; _thread bigint; _chat bigint; _lines text; _text text; _body jsonb; _req bigint;
  _posted int := 0; _none int := 0; _unconfigured int := 0; _no_chat int := 0; _errors int := 0;
begin
  perform pg_advisory_xact_lock(hashtext('post_group_homework_spotlight'));

  select value into _cfg from platform_settings where key = 'group_homework_spotlight';
  if _cfg is null or not coalesce((_cfg->>'enabled')::boolean, true) then return 0; end if;
  _min := coalesce((_cfg->>'min_score')::int, 9);
  select coalesce(array_agg(v::uuid), '{}') into _excl
  from jsonb_array_elements_text(coalesce(_cfg->'exclude_group_ids', '[]'::jsonb)) v;

  select coalesce(value->'topics', '{}'::jsonb) into _topics from platform_settings where key = 'group_weekly_board';
  _topics := coalesce(_topics, '{}'::jsonb);

  select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
  if _tok is null or _tok = '' then return 0; end if;

  _since := now() - interval '7 days';
  _week := to_char((now() at time zone 'Asia/Tashkent'), 'IYYY-IW');

  select coalesce(array_agg(details->>'group_id'), '{}') into _done
  from admin_actions
  where action = 'homework_spotlight_posted' and details->>'week' = _week;

  for _g in
    select g.id from groups g join courses c on c.id = g.course_id
    where c.published = true and not (g.id = any(_excl))
  loop
    begin
      if _g.id::text = any(_done) then continue; end if;

      _thread := nullif(_topics->>(_g.id::text), '')::bigint;
      if _thread is null then _unconfigured := _unconfigured + 1; continue; end if;

      select telegram_chat_id into _chat from group_message_events
        where group_id = _g.id order by sent_at desc limit 1;
      if _chat is null then _no_chat := _no_chat + 1; continue; end if;

      select string_agg('⭐ ' || r.d || ' — <b>' || r.best || '</b>', E'\n' order by r.best desc, r.nm)
        into _lines
      from (
        select p.id,
               coalesce(nullif(p.name, ''), 'Talaba') as nm,
               replace(replace(replace(coalesce(nullif(p.name, ''), 'Talaba'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
                 || case when nullif(p.last_name, '') is not null
                      then ' ' || replace(replace(replace(left(p.last_name, 1), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '.'
                      else '' end as d,
               max(hs.score) as best
        from homework_submissions hs
        join profiles p on p.id = hs.user_id
          and p.group_id = _g.id and p.status = 'active' and p.archived_at is null
          and not coalesce(p.hide_from_group_boards, false)
        where hs.score is not null and hs.score >= _min
          and coalesce(hs.scored_at, hs.submitted_at) >= _since
        group by p.id, p.name, p.last_name
      ) r;

      if _lines is null then
        _none := _none + 1;
        insert into admin_actions (actor_user_id, action, details)
        values (null, 'homework_spotlight_posted',
                jsonb_build_object('group_id', _g.id, 'week', _week, 'count', 0, 'skipped', 'no_qualifiers', 'at', now()));
        continue;
      end if;

      _text := '🌟 <b>BU HAFTA ENG ZO''R ISHLAR</b>' || E'\n'
            || '<i>Uy vazifasida a''lo baho olganlar (' || _min || '+)</i>' || E'\n\n'
            || _lines || E'\n\n'
            || 'Zo''r ishladingiz, davom eting! 👏';

      _body := jsonb_build_object('chat_id', _chat, 'text', _text, 'parse_mode', 'HTML', 'disable_web_page_preview', true);
      if _thread > 1 then _body := _body || jsonb_build_object('message_thread_id', _thread); end if;

      _req := public.ops_net_post(
        'https://api.telegram.org/bot' || _tok || '/sendMessage',
        _body, jsonb_build_object('Content-Type', 'application/json'), 'group-homework-spotlight', 8000);
      _posted := _posted + 1;
      insert into admin_actions (actor_user_id, action, details)
      values (null, 'homework_spotlight_posted',
              jsonb_build_object('group_id', _g.id, 'week', _week, 'chat_id', _chat, 'thread', _thread, 'req_id', _req, 'at', now()));
    exception when others then
      _errors := _errors + 1;
      begin
        insert into admin_actions (actor_user_id, action, details)
        values (null, 'homework_spotlight_failed',
                jsonb_build_object('group_id', _g.id, 'week', _week, 'error', sqlerrm, 'at', now()));
      exception when others then null; end;
    end;
  end loop;

  begin
    insert into admin_actions (actor_user_id, action, details)
    values (null, 'homework_spotlight_run',
            jsonb_build_object('posted', _posted, 'no_qualifiers', _none, 'unconfigured', _unconfigured,
                               'no_chat', _no_chat, 'errors', _errors, 'week', _week, 'at', now()));
  exception when others then null; end;

  return _posted;
end;
$$;
