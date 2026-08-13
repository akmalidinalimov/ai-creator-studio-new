-- Weekly group leaderboard — post last week's Top-10 INTO each student group.
--
-- The group-visible reward that reaches the ~70% of students the bot can't DM (they never pressed
-- Start). Every Monday 09:00 Asia/Tashkent the bot posts a "🏆 Haftalik Reyting — Top 10" into each
-- active group's announcements area, celebrating the students who earned the most XP the week that
-- just ended. Names only (first name + last initial) — no @mentions, no pings, no privacy surface.
-- A positive, low-noise, weekly ritual — NOT policing (member-forgiveness preserved).
--
-- Timing subtlety: group_student_leaderboard's "weekly" board counts XP since THIS Monday, so on
-- Monday morning it would be ~empty. We want the RECAP of the week that just closed, so we compute the
-- window [last Monday, this Monday) as the difference of two user_group_rating_xp_since() calls — the
-- same tested rating primitive the leaderboard/board use (daily+streak+community XP all included,
-- other-course content excluded). Numbers therefore match the account/leaderboard everywhere.
--
-- Delivery + observability: sends via public.ops_net_post(..., 'group-weekly-board') — the attributed
-- wrapper around net.http_post (pg_net is fire-and-forget, so the Telegram result lands asynchronously
-- in net._http_response). ops_http_failure_sweep()/ops_http_failure_watchdog() therefore surface any
-- failed send (bad thread_id, bot kicked, closed topic) as an ATTRIBUTED, alertable signal instead of
-- a silent skip. We mark a group's week done once the send is ENQUEUED (idempotency); a delivery
-- failure is not auto-retried but IS alerted, so an admin fixes the config and re-runs. This is the
-- same async contract every other net.http_post send in the platform uses. All-SQL by design so it
-- keeps delivering even if the edge stack is down.
--
-- Config (live, no deploy) — platform_settings.group_weekly_board:
--   { "enabled": true,
--     "topics": { "<group_uuid>": <thread_id>, ... },       -- REQUIRED per group; 1 = General topic
--     "exclude_group_ids": [ "<group_uuid>", ... ] }        -- optional opt-out
-- topics value = Telegram message_thread_id. Use 1 for the General topic (the post then omits
-- message_thread_id and lands in the group's main/General view — which for these groups is the
-- renamed "Muhim e'lonlar" announcements topic). A value > 1 targets that specific forum topic.
-- A group with NO configured thread is SKIPPED (we never post to an unintended topic).
-- Kill-switch: set enabled=false, or unschedule the 'group-weekly-board' cron.

insert into platform_settings (key, value)
select 'group_weekly_board',
       jsonb_build_object(
         'enabled', true,
         'exclude_group_ids', '[]'::jsonb,
         'topics', jsonb_build_object(
           '35f246e4-edd5-4fc3-9a81-cbef3cb2b0b9', 1,   -- 1-GURUH PRE 5.0  (General)
           '6eea7030-6b68-4f00-8e0f-9d07b193e0dd', 1,   -- 1-GURUH VIP 5.0  (General)
           '49d44eeb-0258-4fb0-8820-082a015f3a69', 1))  -- 2-GURUH VIP 5.0  (General)
where not exists (select 1 from platform_settings where key = 'group_weekly_board');

create or replace function public.post_group_weekly_boards()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  _cfg jsonb; _topics jsonb; _excl uuid[]; _tok text;
  _this_mon timestamptz; _prev_mon timestamptz; _week date;
  _done text[];
  _g record; _thread bigint; _chat bigint; _lines text; _text text; _body jsonb; _req bigint;
  _posted int := 0; _no_xp int := 0; _unconfigured int := 0; _no_chat int := 0;
begin
  -- Serialize invocations (weekly cron vs. a manual re-run) so the check-then-act "already posted"
  -- guard below can't double-post a group. Released automatically at commit.
  perform pg_advisory_xact_lock(hashtext('post_group_weekly_boards'));

  select value into _cfg from platform_settings where key = 'group_weekly_board';
  if _cfg is null or not coalesce((_cfg->>'enabled')::boolean, true) then
    return 0;
  end if;
  _topics := coalesce(_cfg->'topics', '{}'::jsonb);
  select coalesce(array_agg(v::uuid), '{}')
    into _excl
  from jsonb_array_elements_text(coalesce(_cfg->'exclude_group_ids', '[]'::jsonb)) v;

  select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
  if _tok is null or _tok = '' then
    return 0;
  end if;

  -- Monday 00:00 Tashkent (this week) and the previous Monday, as timestamptz boundaries.
  _this_mon := (date_trunc('week', (now() at time zone 'Asia/Tashkent')) at time zone 'Asia/Tashkent');
  _prev_mon := _this_mon - interval '7 days';
  _week := _prev_mon::date;   -- the week being recapped (idempotency key)

  -- Groups already handled for this week (one scan, not one query per group).
  select coalesce(array_agg(details->>'group_id'), '{}')
    into _done
  from admin_actions
  where action = 'group_weekly_board_posted' and details->>'week' = _week::text;

  for _g in
    select g.id, g.course_id
    from groups g
    join courses c on c.id = g.course_id
    where c.published = true
      and not (g.id = any(_excl))
  loop
    if _g.id::text = any(_done) then
      continue;   -- already handled this week (idempotent)
    end if;

    -- Announcements thread configured for this group? (else never post — skip.)
    _thread := nullif(_topics->>(_g.id::text), '')::bigint;
    if _thread is null then
      _unconfigured := _unconfigured + 1;
      continue;
    end if;

    -- Current chat_id for this group, from the latest captured message.
    select telegram_chat_id into _chat
    from group_message_events where group_id = _g.id
    order by sent_at desc limit 1;
    if _chat is null then
      _no_chat := _no_chat + 1;   -- surfaced in the summary row below
      continue;
    end if;

    -- Build last-week Top-10, names only (first name + last initial), HTML-escaped (Telegram display
    -- names are free text and may contain & < > which would otherwise break the whole HTML message).
    -- Window = [prev_mon, this_mon).
    select string_agg(
             (case r.rnk when 1 then '🥇' when 2 then '🥈' when 3 then '🥉' else r.rnk::text || '.' end)
             || ' ' || r.d || ' — <b>' || r.wk || ' XP</b>',
             E'\n' order by r.rnk)
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
        ) s
        where s.wk > 0
      ) d
    ) r
    where r.rnk <= 10;

    if _lines is null then
      -- Nobody earned XP last week → no empty-board spam. Mark handled (window is immutable).
      _no_xp := _no_xp + 1;
      begin
        insert into admin_actions (actor_user_id, action, details)
        values (null, 'group_weekly_board_posted',
                jsonb_build_object('group_id', _g.id, 'week', _week, 'count', 0, 'skipped', 'no_xp', 'at', now()));
      exception when others then null; end;
      continue;
    end if;

    _text := '🏆 <b>HAFTALIK REYTING — TOP 10</b>' || E'\n'
          || '<i>O''tgan hafta eng ko''p XP to''plaganlar</i>' || E'\n\n'
          || _lines || E'\n\n'
          || '👏 Tabriklaymiz! Yangi hafta — yangi imkoniyat. Davom etamiz! 💪';

    -- General topic (thread 1) → omit message_thread_id (posts to the main/General view). A real
    -- forum topic (>1) → target it explicitly.
    _body := jsonb_build_object('chat_id', _chat, 'text', _text,
                                'parse_mode', 'HTML', 'disable_web_page_preview', true);
    if _thread > 1 then
      _body := _body || jsonb_build_object('message_thread_id', _thread);
    end if;

    begin
      -- Attributed send: failures land in ops_http_failures (purpose='group-weekly-board') and are
      -- alerted by ops_http_failure_watchdog. (Enqueue only — delivery is async, see header.)
      _req := public.ops_net_post(
        'https://api.telegram.org/bot' || _tok || '/sendMessage',
        _body,
        jsonb_build_object('Content-Type', 'application/json'),
        'group-weekly-board',
        8000);
      _posted := _posted + 1;
      insert into admin_actions (actor_user_id, action, details)
      values (null, 'group_weekly_board_posted',
              jsonb_build_object('group_id', _g.id, 'week', _week, 'chat_id', _chat,
                                 'thread', _thread, 'req_id', _req, 'at', now()));
    exception when others then
      -- Synchronous enqueue error → do NOT mark posted, so the next run retries this group/week.
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
                               'no_chat', _no_chat, 'week', _week, 'at', now()));
  exception when others then null; end;

  return _posted;
end;
$$;
revoke execute on function public.post_group_weekly_boards() from public, anon, authenticated;

-- Monday 09:00 Asia/Tashkent = 04:00 UTC.
do $$
begin
  begin
    if exists (select 1 from cron.job where jobname = 'group-weekly-board') then
      perform cron.unschedule('group-weekly-board');
    end if;
    perform cron.schedule('group-weekly-board', '0 4 * * 1', $cmd$ select public.post_group_weekly_boards() $cmd$);
  exception when others then
    begin insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'group_weekly_board_cron_failed', jsonb_build_object('error', sqlerrm, 'at', now()));
    exception when others then null; end;
  end;
end $$;
