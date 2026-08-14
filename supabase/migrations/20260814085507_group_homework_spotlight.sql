-- Weekly homework spotlight — publicly celebrate every student who did EXCELLENT homework this week.
--
-- Complements the Monday XP leaderboard (which rewards activity/volume): this rewards QUALITY. Every
-- Saturday 12:00 Asia/Tashkent, post "🌟 Bu hafta eng zo'r ishlar" into each active group's
-- announcements topic, naming every student who scored >= min_score (default 9/10, the same threshold
-- as the homework_high_score badge) on homework graded in the last 7 days. Inclusive by design — being
-- named in front of the group is the strongest pull there is. Names only (first name + last initial),
-- no @mentions, no media repost (no privacy/consent surface).
--
-- Reuses the weekly-board machinery: reads the per-group announcements thread from
-- platform_settings.group_weekly_board.topics (single source of truth for "where announcements go";
-- thread 1 = General → message_thread_id omitted), posts via ops_net_post(...,'group-homework-spotlight')
-- so async failures are attributed + alerted by ops_http_failure_watchdog, HTML-escapes names,
-- advisory-lock + per-week admin_actions guard for idempotency. The ENTIRE per-group body is wrapped in
-- its own begin/exception so one bad group (e.g. a future non-numeric topics value) is skipped and
-- logged — it can never abort the whole run or roll back other groups' posts. All-SQL (delivers even
-- if the edge stack is down).
--
-- Config (live, no deploy) — platform_settings.group_homework_spotlight:
--   { "enabled": true, "min_score": 9, "exclude_group_ids": [ "<group_uuid>", ... ] }
-- Kill-switch: enabled=false, or unschedule the 'group-homework-spotlight' cron.

insert into platform_settings (key, value)
select 'group_homework_spotlight', '{"enabled": true, "min_score": 9, "exclude_group_ids": []}'::jsonb
where not exists (select 1 from platform_settings where key = 'group_homework_spotlight');

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
  if _cfg is null or not coalesce((_cfg->>'enabled')::boolean, true) then
    return 0;
  end if;
  _min := coalesce((_cfg->>'min_score')::int, 9);
  select coalesce(array_agg(v::uuid), '{}') into _excl
  from jsonb_array_elements_text(coalesce(_cfg->'exclude_group_ids', '[]'::jsonb)) v;

  -- Announcements thread per group lives in the weekly-board config (one source of truth).
  select coalesce(value->'topics', '{}'::jsonb) into _topics from platform_settings where key = 'group_weekly_board';
  _topics := coalesce(_topics, '{}'::jsonb);

  select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
  if _tok is null or _tok = '' then return 0; end if;

  _since := now() - interval '7 days';
  _week := to_char((now() at time zone 'Asia/Tashkent'), 'IYYY-IW');  -- ISO week key (idempotent all week)

  select coalesce(array_agg(details->>'group_id'), '{}') into _done
  from admin_actions
  where action = 'homework_spotlight_posted' and details->>'week' = _week;

  for _g in
    select g.id from groups g join courses c on c.id = g.course_id
    where c.published = true and not (g.id = any(_excl))
  loop
    -- Whole per-group body guarded: a bad row (e.g. non-numeric topics value) skips this group only.
    begin
      if _g.id::text = any(_done) then continue; end if;

      _thread := nullif(_topics->>(_g.id::text), '')::bigint;
      if _thread is null then _unconfigured := _unconfigured + 1; continue; end if;

      select telegram_chat_id into _chat from group_message_events
        where group_id = _g.id order by sent_at desc limit 1;
      if _chat is null then _no_chat := _no_chat + 1; continue; end if;

      -- Every student in this group with an excellent (>= min) homework graded in the window; named
      -- once with their best score, best-first. Names HTML-escaped.
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

      _body := jsonb_build_object('chat_id', _chat, 'text', _text,
                                  'parse_mode', 'HTML', 'disable_web_page_preview', true);
      if _thread > 1 then
        _body := _body || jsonb_build_object('message_thread_id', _thread);
      end if;

      _req := public.ops_net_post(
        'https://api.telegram.org/bot' || _tok || '/sendMessage',
        _body, jsonb_build_object('Content-Type', 'application/json'),
        'group-homework-spotlight', 8000);
      _posted := _posted + 1;
      insert into admin_actions (actor_user_id, action, details)
      values (null, 'homework_spotlight_posted',
              jsonb_build_object('group_id', _g.id, 'week', _week, 'chat_id', _chat,
                                 'thread', _thread, 'req_id', _req, 'at', now()));
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
revoke execute on function public.post_group_homework_spotlight() from public, anon, authenticated;

-- Saturday 12:00 Asia/Tashkent = 07:00 UTC.
do $$
begin
  begin
    if exists (select 1 from cron.job where jobname = 'group-homework-spotlight') then
      perform cron.unschedule('group-homework-spotlight');
    end if;
    perform cron.schedule('group-homework-spotlight', '0 7 * * 6', $cmd$ select public.post_group_homework_spotlight() $cmd$);
  exception when others then
    begin insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'homework_spotlight_cron_failed', jsonb_build_object('error', sqlerrm, 'at', now()));
    exception when others then null; end;
  end;
end $$;
