-- Challenge 6.0 — Phase 3: frozen weekly results + the group-vs-group team board.
--
-- WHAT THIS ADDS
--   0. challenge_weekly_results.details  — the numbers a frozen rank was computed from.
--   1. challenge_scope_group_ids()       — the CONFIGURED groups, independent of today's on/off state.
--   2. challenge_team_board()            — replaced: scope-at-time, deterministic order, member
--                                          predicate aligned with the freeze.
--   3. freeze_challenge_week()           — snapshots a finished week into challenge_weekly_results.
--   4. post_challenge_team_board()       — posts the standing into each scoped group's topic.
--   5. challenge_weekly_job()            — the Monday wrapper, each leg independently guarded.
--   6. challenge_xp_watchdog()           — replaced: also alarms when the Monday job goes silent.
--   7. challenge_health()                — the new DB-visible signals.
--
-- WHY A SEPARATE JOB, NOT AN EDIT TO post_group_weekly_boards()
--   That function posts the live 5.0 weekly board every Monday and works. Editing it to also carry the
--   challenge would put the running cohort's only weekly post one syntax error away from silence. This
--   runs 10 minutes later, in its own transaction, under its own cron entry.
--
-- THE BUG THIS DESIGN EXISTS TO AVOID (caught in review, worth keeping in the file)
--   The obvious gate — `if not challenge_active() then return` — asks "is the challenge running RIGHT
--   NOW". But a freeze always runs the Monday AFTER a week closes. So the moment the window ends, or
--   the owner flips `enabled` off because the challenge is over, the LAST week becomes impossible to
--   freeze: the early return fires, and `challenge_group_ids()` independently returns nothing because
--   it re-checks `challenge_active()` too. The grand-prize week is exactly the week that could never
--   be recorded. Everything here therefore gates on "was the challenge active DURING the week being
--   processed" — `challenge_active(_prev_mon)` — and resolves group scope from
--   `challenge_scope_group_ids()`, which reads the configured lists and does not consult the flag.
--   A manual call with an explicit _week_start skips the gate entirely: an admin asking for a specific
--   week has already made the decision, and the function is revoked from every client role.
--
-- FAIL-CLOSED ON DEPLOY: the flag is off and course_ids/group_ids are empty, so the scope is empty and
-- `challenge_active(anything)` is false. Nothing is written, nothing is sent. The self-test asserts it.
--
-- ACCEPTED LIMIT, LOUDLY (inherited from Phase 1, but Phase 3 turns it into a PRIZE record):
--   XP is not tagged with the group it was earned in. A student's week is attributed entirely to the
--   group they are in when the freeze runs. Moving a student between two challenge groups mid-week
--   moves 100% of that week's points with them, for both the individual and the team result. Do not
--   reorganize groups mid-challenge. There is NO audit row anywhere in this system for a group change
--   (checked: admin_actions has no such action), so challenge_health() derives the signal from the
--   snapshot itself — see `students_in_multiple_groups`.
--
-- Idempotent + replay-safe per the deploy-concurrency doctrine. NOTE: a replay writes a second
-- `challenge_phase3_selftest` audit row. That is two self-test RUNS, not two applications of effect —
-- the freeze and the post are both no-ops while inert.

-- ───────────────────────── 0. Make the snapshot self-explanatory ─────────────────────────
-- A team row is RANKED by average points per member but its `points` column holds the group TOTAL, so
-- the two cannot be reconciled from the row alone. Prizes are paid from this table weeks after the
-- fact; a record the owner cannot audit is not a record.
alter table public.challenge_weekly_results
  add column if not exists details jsonb not null default '{}'::jsonb;

-- ───────────────────────── 1. Scope, independent of the on/off flag ─────────────────────────
-- challenge_group_ids() answers "which groups are in scope RIGHT NOW" and correctly returns nothing
-- once the challenge closes — that is what the live reconciler wants, and it is left untouched.
-- This answers the different question a snapshot needs: "which groups does the config name at all".
create or replace function public.challenge_scope_group_ids()
returns setof uuid
language sql stable security definer set search_path = public
as $$
  select g.id
  from groups g
  where g.id::text in (select jsonb_array_elements_text(coalesce(public.challenge_config()->'group_ids', '[]'::jsonb)))
     or g.course_id::text in (select jsonb_array_elements_text(coalesce(public.challenge_config()->'course_ids', '[]'::jsonb)));
$$;
revoke execute on function public.challenge_scope_group_ids() from public, anon, authenticated;

-- ───────────────────────── 2. Team board, scope-at-time and deterministic ─────────────────────────
-- Three changes from Phase 1, all so the POSTED board and the FROZEN record can never disagree:
--   a. scope from challenge_scope_group_ids(), so a past week is still computable after the close.
--   b. `order by ... , g.id` — without a final key, two groups on an exact tie could be ranked one way
--      in the frozen insert and the other way in the posted message. Same week, two different answers.
--   c. membership predicate aligned with the freeze and with post_group_weekly_boards()
--      (`status = 'active' and archived_at is null`). It was `status <> 'archived'`, which let profiles
--      into the team AVERAGE denominator that the individual ranking did not count as members.
create or replace function public.challenge_team_board(_from timestamptz, _to timestamptz)
returns table(group_id uuid, group_name text, members int, total_points bigint, avg_points numeric)
language sql stable security definer set search_path = public
as $$
  with staff as (
    select distinct ur.user_id from user_roles ur
    where ur.role in ('teacher'::app_role, 'admin'::app_role, 'superadmin'::app_role)
  ),
  members as (
    select p.id as user_id, p.group_id
    from profiles p
    where p.group_id in (select public.challenge_scope_group_ids())
      and p.status = 'active' and p.archived_at is null
      and p.id not in (select user_id from staff)
  )
  select g.id, g.name,
         count(distinct m.user_id)::int as members,
         coalesce(sum(x.amount), 0)::bigint as total_points,
         round(coalesce(sum(x.amount), 0)::numeric / greatest(count(distinct m.user_id), 1), 1) as avg_points
  from groups g
  join members m on m.group_id = g.id
  left join xp_events x on x.user_id = m.user_id and x.created_at >= _from and x.created_at < _to
  group by g.id, g.name
  order by avg_points desc, total_points desc, g.id;
$$;
revoke execute on function public.challenge_team_board(timestamptz, timestamptz) from public, anon, authenticated;

-- ───────────────────────── 3. Freeze the finished week ─────────────────────────
-- Individual rows: the top 10 of each scoped group by the week's rating XP — the SAME measure the
-- posted board uses (user_group_rating_xp_since), so snapshot and board cannot disagree.
-- Team rows: challenge_team_board(), average points per member.
--
-- TWO MODES, deliberately different:
--   automatic (_week_start null)  — last week, gated on challenge_active(that week), ON CONFLICT DO
--                                   NOTHING. The first write for a week IS the record; a re-run of the
--                                   cron can never rewrite history.
--   manual (_week_start given)    — a deliberate correction. Ungated, and it DELETES that week's rows
--                                   first. Without the delete a re-freeze only ADDS: a student who now
--                                   qualifies is inserted while a student who should have dropped out
--                                   keeps their stale row, and the group ends up with eleven members of
--                                   its "top ten", stale and corrected data mixed with no way to tell
--                                   which is which.
create or replace function public.freeze_challenge_week(_week_start date default null)
returns table(individual int, team int)
language plpgsql
security definer
set search_path = public
as $$
declare
  _this_mon timestamptz; _prev_mon timestamptz; _week date; _manual boolean := (_week_start is not null);
  _ind int := 0; _team int := 0;
begin
  if _manual and extract(dow from _week_start) <> 1 then
    raise exception 'week_start must be a Monday (got % = %)', _week_start, to_char(_week_start, 'Day');
  end if;

  -- Week boundaries in Tashkent, matching post_group_weekly_boards() exactly.
  _this_mon := (date_trunc('week', (now() at time zone 'Asia/Tashkent')) at time zone 'Asia/Tashkent');
  _prev_mon := _this_mon - interval '7 days';
  _week     := coalesce(_week_start, _prev_mon::date);
  if _manual then
    _prev_mon := (_week_start::timestamp at time zone 'Asia/Tashkent');
    _this_mon := _prev_mon + interval '7 days';
  end if;

  -- Was the challenge running during the week being frozen? (Not: is it running right now.)
  if not _manual and not public.challenge_active(_prev_mon) then
    return query select 0, 0; return;
  end if;

  perform pg_advisory_xact_lock(hashtext('freeze_challenge_week'));

  if _manual then
    delete from challenge_weekly_results where week_start = _week;
  end if;

  with staff as (
    select distinct ur.user_id from user_roles ur
    where ur.role in ('teacher'::app_role, 'admin'::app_role, 'superadmin'::app_role)
  ),
  scored as (
    select p.id as user_id, p.group_id,
           ( public.user_group_rating_xp_since(p.id, g.course_id, _prev_mon)
           - public.user_group_rating_xp_since(p.id, g.course_id, _this_mon) ) as pts
    from profiles p
    join groups g on g.id = p.group_id
    where p.group_id in (select public.challenge_scope_group_ids())
      and p.status = 'active' and p.archived_at is null
      and p.id not in (select user_id from staff)
  ),
  ranked as (
    select user_id, group_id, pts,
           row_number() over (partition by group_id order by pts desc, user_id) as rnk
    from scored where pts > 0
  )
  insert into challenge_weekly_results (week_start, kind, group_id, user_id, points, rank, details)
  select _week, 'individual', r.group_id, r.user_id, r.pts::int, r.rnk::int,
         jsonb_build_object('week_points', r.pts, 'frozen_at', now(), 'manual', _manual)
  from ranked r where r.rnk <= 10
  on conflict on constraint uq_challenge_weekly do nothing;
  get diagnostics _ind = row_count;

  insert into challenge_weekly_results (week_start, kind, group_id, user_id, points, rank, details)
  select _week, 'team', t.group_id, null, t.total_points::int,
         (row_number() over (order by t.avg_points desc, t.total_points desc, t.group_id))::int,
         jsonb_build_object('members', t.members, 'total_points', t.total_points,
                            'avg_points', t.avg_points, 'ranked_by', 'avg_points',
                            'frozen_at', now(), 'manual', _manual)
  from public.challenge_team_board(_prev_mon, _this_mon) t
  on conflict on constraint uq_challenge_weekly do nothing;
  get diagnostics _team = row_count;

  begin
    insert into admin_actions (actor_user_id, action, details)
    values (null, 'challenge_week_frozen',
            jsonb_build_object('week', _week, 'individual', _ind, 'team', _team,
                               'manual', _manual, 'at', now()));
  exception when others then null; end;

  return query select _ind, _team;
end;
$$;
revoke execute on function public.freeze_challenge_week(date) from public, anon, authenticated;

-- ───────────────────────── 4. The team board post ─────────────────────────
-- Reuses the group_weekly_board.topics map so no second per-group configuration exists to drift.
-- A scoped group with no topic configured is COUNTED and logged, never silently skipped — a board
-- nobody receives must not look like a board that was sent.
create or replace function public.post_challenge_team_board()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  _cfg jsonb; _topics jsonb; _tok text;
  _this_mon timestamptz; _prev_mon timestamptz; _week date;
  _done text[]; _lines text; _text text; _body jsonb; _req bigint;
  _g record; _thread bigint; _chat bigint; _groups int := 0; _shown int := 0;
  _posted int := 0; _unconfigured int := 0; _no_chat int := 0; _errors int := 0;
  _max_rows int := 20;   -- Telegram caps a message at 4096 chars; ~20 lines is far inside it.
begin
  _this_mon := (date_trunc('week', (now() at time zone 'Asia/Tashkent')) at time zone 'Asia/Tashkent');
  _prev_mon := _this_mon - interval '7 days';
  _week     := _prev_mon::date;

  -- Was the challenge running during the week being reported? This is what lets the FINAL week's
  -- board go out on the Monday after the challenge closes.
  if not public.challenge_active(_prev_mon) then return 0; end if;

  perform pg_advisory_xact_lock(hashtext('post_challenge_team_board'));

  select count(*) into _groups from public.challenge_scope_group_ids();
  if _groups < 2 then
    -- "Group vs group" with one group is a scoreboard of one. Say so instead of posting it.
    begin
      insert into admin_actions (actor_user_id, action, details)
      values (null, 'challenge_team_board_skipped',
              jsonb_build_object('reason', 'fewer_than_two_groups', 'groups', _groups, 'at', now()));
    exception when others then null; end;
    return 0;
  end if;

  select value into _cfg from platform_settings where key = 'group_weekly_board';
  _topics := coalesce(_cfg->'topics', '{}'::jsonb);

  select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
  if _tok is null or _tok = '' then return 0; end if;

  select coalesce(array_agg(details->>'group_id'), '{}') into _done
  from admin_actions
  where action = 'challenge_team_board_posted' and details->>'week' = _week::text;

  -- One standing, computed once, sent to every scoped group. Group names are HTML-escaped: they are
  -- admin-entered free text and this message is parse_mode=HTML. Capped at _max_rows so a large
  -- challenge cannot silently produce a message Telegram rejects for length.
  select string_agg(
           (case t.rnk when 1 then '🥇' when 2 then '🥈' when 3 then '🥉' else t.rnk::text || '.' end)
           || ' ' || t.nm || ' — <b>' || t.avg_points || '</b> ball/a''zo'
           || ' <i>(' || t.members || ' ishtirokchi)</i>', E'\n' order by t.rnk),
         count(*)
    into _lines, _shown
  from (
    select row_number() over (order by b.avg_points desc, b.total_points desc, b.group_id) as rnk,
           replace(replace(replace(coalesce(nullif(b.group_name, ''), 'Guruh'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') as nm,
           b.avg_points, b.members
    from public.challenge_team_board(_prev_mon, _this_mon) b
  ) t
  where t.rnk <= _max_rows;

  if _lines is null then
    begin
      insert into admin_actions (actor_user_id, action, details)
      values (null, 'challenge_team_board_skipped',
              jsonb_build_object('reason', 'no_rows', 'week', _week, 'at', now()));
    exception when others then null; end;
    return 0;
  end if;

  _text := '🏁 <b>GURUHLAR BELLASHUVI — HAFTA YAKUNI</b>' || E'\n'
        || '<i>Har bir ishtirokchiga to''g''ri kelgan o''rtacha ball</i>' || E'\n\n'
        || _lines
        || case when _groups > _shown
                then E'\n<i>…va yana ' || (_groups - _shown) || ' ta guruh</i>' else '' end
        || E'\n\n'
        || '💪 Har bir faollik — guruhingizga ball. Yangi hafta boshlandi!';

  for _g in select g.id from groups g where g.id in (select public.challenge_scope_group_ids())
  loop
    begin
      if _g.id::text = any(_done) then continue; end if;

      _thread := nullif(_topics->>(_g.id::text), '')::bigint;
      if _thread is null then _unconfigured := _unconfigured + 1; continue; end if;

      select telegram_chat_id into _chat from group_message_events
        where group_id = _g.id order by sent_at desc limit 1;
      if _chat is null then _no_chat := _no_chat + 1; continue; end if;

      _body := jsonb_build_object('chat_id', _chat, 'text', _text,
                                  'parse_mode', 'HTML', 'disable_web_page_preview', true);
      if _thread > 1 then _body := _body || jsonb_build_object('message_thread_id', _thread); end if;

      -- ops_net_post records every failed call in ops_http_failures under this purpose tag, so a
      -- rejected send (closed topic, bot removed, message too long) is alertable, not silent.
      _req := public.ops_net_post(
        'https://api.telegram.org/bot' || _tok || '/sendMessage',
        _body, jsonb_build_object('Content-Type', 'application/json'), 'challenge-team-board', 8000);
      _posted := _posted + 1;
      insert into admin_actions (actor_user_id, action, details)
      values (null, 'challenge_team_board_posted',
              jsonb_build_object('group_id', _g.id, 'week', _week, 'chat_id', _chat,
                                 'thread', _thread, 'req_id', _req, 'at', now()));
    exception when others then
      _errors := _errors + 1;
      begin
        insert into admin_actions (actor_user_id, action, details)
        values (null, 'challenge_team_board_failed',
                jsonb_build_object('group_id', _g.id, 'week', _week, 'error', sqlerrm, 'at', now()));
      exception when others then null; end;
    end;
  end loop;

  begin
    insert into admin_actions (actor_user_id, action, details)
    values (null, 'challenge_team_board_run',
            jsonb_build_object('posted', _posted, 'unconfigured', _unconfigured, 'no_chat', _no_chat,
                               'errors', _errors, 'shown', _shown, 'week', _week, 'at', now()));
  exception when others then null; end;

  return _posted;
end;
$$;
revoke execute on function public.post_challenge_team_board() from public, anon, authenticated;

-- ───────────────────────── 5. The Monday wrapper ─────────────────────────
-- Freeze FIRST: the snapshot is what prizes are paid from, so it must survive a Telegram outage that
-- takes the post down. Each leg is independently guarded — one failing never cancels the other.
create or replace function public.challenge_weekly_job()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare _ind int := 0; _team int := 0; _posted int := 0; _err text := null;
begin
  begin
    select f.individual, f.team into _ind, _team from public.freeze_challenge_week() f;
  exception when others then
    _err := 'freeze: ' || sqlerrm;
    begin
      insert into admin_actions (actor_user_id, action, details)
      values (null, 'challenge_weekly_job_failed',
              jsonb_build_object('leg', 'freeze', 'error', sqlerrm, 'at', now()));
    exception when others then null; end;
  end;

  begin
    _posted := public.post_challenge_team_board();
  exception when others then
    _err := coalesce(_err || '; ', '') || 'post: ' || sqlerrm;
    begin
      insert into admin_actions (actor_user_id, action, details)
      values (null, 'challenge_weekly_job_failed',
              jsonb_build_object('leg', 'post', 'error', sqlerrm, 'at', now()));
    exception when others then null; end;
  end;

  return jsonb_build_object('individual', _ind, 'team', _team, 'posted', _posted,
                            'error', _err, 'at', now());
end;
$$;
revoke execute on function public.challenge_weekly_job() from public, anon, authenticated;

-- ───────────────────────── 6. Watchdog: the reconciler AND the Monday job ─────────────────────────
-- Phase 1 watched the 10-minute reconciler. The Monday job decides who gets paid a prize, and until
-- now nothing alarmed if it silently stopped running — the failure would surface when the owner went
-- looking for results that were never recorded.
--
-- The week-1 false alarm is avoided by asking how long the challenge has actually been ACTIVE: the
-- reconciler heartbeats on every tick and stamps `active` in its details, so the first heartbeat with
-- active=true is the real start. No freeze is expected until a Monday has passed since then.
--
-- Both legs now send through ops_net_post() rather than a raw net.http_post, so a failed admin DM is
-- recorded in ops_http_failures instead of vanishing — a watchdog whose own alert can disappear
-- silently is not a watchdog.
create or replace function public.challenge_xp_watchdog()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  _last timestamptz; _lastw timestamptz; _active_since timestamptz;
  _tok text; _admin record; _sent int := 0;
  _stale_reconcile boolean := false; _stale_weekly boolean := false; _msg text;
begin
  if not public.challenge_active() then
    return 0;
  end if;

  select max(created_at) into _last from admin_actions where action = 'challenge_xp_reconciled';
  _stale_reconcile := (_last is null or _last <= now() - interval '1 hour');

  -- When did the challenge actually start running?
  select min(created_at) into _active_since
  from admin_actions
  where action = 'challenge_xp_reconciled' and details->>'active' = 'true';

  select max(created_at) into _lastw from admin_actions where action = 'challenge_week_frozen';
  _stale_weekly := (_active_since is not null
                    and _active_since < now() - interval '8 days'
                    and (_lastw is null or _lastw < now() - interval '8 days'));

  if not _stale_reconcile and not _stale_weekly then
    return 0;
  end if;

  select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
  if _tok is not null and _tok <> '' then
    _msg := case
      when _stale_reconcile and _stale_weekly then
        E'⚠️ Challenge: ballar hisoblanmayapti (oxirgi: ' || coalesce(_last::text, 'hech qachon') ||
        E') VA haftalik natijalar saqlanmayapti (oxirgi: ' || coalesce(_lastw::text, 'hech qachon') || E').'
      when _stale_reconcile then
        E'⚠️ challenge-xp-reconcile ishlamayapti — oxirgi yurish: ' ||
        coalesce(_last::text, 'hech qachon') ||
        E'.\nChallenge yoqilgan, lekin ballar hisoblanmayapti.'
      else
        E'⚠️ challenge-weekly ishlamayapti — oxirgi haftalik natija: ' ||
        coalesce(_lastw::text, 'hech qachon') ||
        E'.\nSovrinlar shu jadvaldan toʻlanadi — tekshiring.'
    end;
    for _admin in
      select distinct p.telegram_id from profiles p
      join user_roles r on r.user_id = p.id and r.role in ('admin','superadmin')
      where p.telegram_id is not null limit 3
    loop
      begin
        perform public.ops_net_post(
          'https://api.telegram.org/bot' || _tok || '/sendMessage',
          jsonb_build_object('chat_id', _admin.telegram_id, 'text', _msg),
          jsonb_build_object('Content-Type', 'application/json'), 'challenge-xp-watchdog', 8000);
        _sent := _sent + 1;
      exception when others then null; end;
    end loop;
  end if;

  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_xp_watchdog_alert',
            jsonb_build_object('last_run', _last, 'last_freeze', _lastw,
                               'stale_reconcile', _stale_reconcile, 'stale_weekly', _stale_weekly,
                               'active_since', _active_since, 'sent', _sent, 'at', now()));
  exception when others then null; end;
  return _sent;
end;
$$;
revoke execute on function public.challenge_xp_watchdog() from public, anon, authenticated;

-- ───────────────────────── 7. Cron (10 min after the 5.0 board) ─────────────────────────
do $$
begin
  begin
    if exists (select 1 from cron.job where jobname = 'challenge-weekly') then
      perform cron.unschedule('challenge-weekly');
    end if;
  exception when others then null; end;

  begin
    perform cron.schedule('challenge-weekly', '10 4 * * 1', $cron$ select public.challenge_weekly_job() $cron$);
  exception when others then
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'challenge_cron_failed',
              jsonb_build_object('job','weekly','error',sqlerrm,'at',now()));
    exception when others then null; end;
  end;
end $$;

-- ───────────────────────── 8. Health: the new signals ─────────────────────────
-- A scoped group with no board topic configured receives NOTHING, and that is invisible in the posted
-- output (the post simply never arrives), so it is surfaced here.
--
-- `students_in_multiple_groups` is the one signal that catches a silently corrupted prize record. A
-- student moved between challenge groups has their whole week credited to whichever group they were
-- in on Monday. There is no admin_actions row for a group change anywhere in this codebase — verified,
-- not assumed — so the only honest place to read the fact from is the snapshot: a student whose frozen
-- results name more than one group HAS moved. Counting audit rows that are never written would have
-- produced a metric that reads "0 problems" because it can never be anything else.
create or replace function public.challenge_health()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'active',          public.challenge_active(),
    'groups_in_scope', (select count(*) from public.challenge_scope_group_ids()),
    'groups_missing_homework_topic',
      (select count(*) from groups g
       where g.id in (select public.challenge_scope_group_ids()) and g.homework_topic_id is null),
    'groups_missing_board_topic',
      (select count(*) from groups g
       where g.id in (select public.challenge_scope_group_ids())
         and nullif(coalesce((select value->'topics' from platform_settings where key = 'group_weekly_board'),
                             '{}'::jsonb) ->> (g.id::text), '') is null),
    'students_in_multiple_groups',
      (select count(*) from (
         select user_id from challenge_weekly_results
         where kind = 'individual' and user_id is not null
         group by user_id having count(distinct group_id) > 1) t),
    'handles',         (select count(*) from profiles where instagram_username is not null),
    'media_points',    (select count(*) from xp_events where reason = 'challenge_group_media'),
    'question_points', (select count(*) from xp_events where reason = 'challenge_question'),
    'ig_points',       (select count(*) from xp_events where reason = 'challenge_instagram'),
    'students',        (select count(distinct user_id) from xp_events where reason like 'challenge\_%'),
    'xp_total',        (select coalesce(sum(amount), 0) from xp_events where reason like 'challenge\_%'),
    'weeks_frozen',    (select count(distinct week_start) from challenge_weekly_results),
    'last_freeze',     (select max(created_at) from admin_actions where action = 'challenge_week_frozen'),
    'last_board_post', (select max(created_at) from admin_actions where action = 'challenge_team_board_run'),
    'last_run',        (select max(created_at) from admin_actions where action = 'challenge_xp_reconciled'),
    'checked_at',      now()
  );
$$;
revoke execute on function public.challenge_health() from public, anon, authenticated;

-- ───────────────────────── 9. Deploy self-test (guarded) ─────────────────────────
-- Proves the new functions parse, run, and stay inert while the flag is off. A failure is recorded,
-- never raised: a broken self-test must not roll back a migration that already applied.
do $$
declare _ind int; _team int; _posted int; _h jsonb; _scope int;
begin
  select f.individual, f.team into _ind, _team from public.freeze_challenge_week() f;
  _posted := public.post_challenge_team_board();
  _h      := public.challenge_health();
  select count(*) into _scope from public.challenge_scope_group_ids();

  if public.challenge_active() = false and (_ind <> 0 or _team <> 0 or _posted <> 0) then
    raise exception 'challenge phase 3 is not inert while disabled: ind=% team=% posted=%',
      _ind, _team, _posted;
  end if;
  if _scope <> 0 then
    raise exception 'challenge scope is not empty on deploy: % groups configured', _scope;
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'challenge_phase3_selftest',
          jsonb_build_object('individual', _ind, 'team', _team, 'posted', _posted,
                             'scope_groups', _scope, 'health', _h, 'at', now()));
exception when others then
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_selftest_failed',
            jsonb_build_object('phase', 3, 'error', sqlerrm, 'at', now()));
  exception when others then null; end;
end $$;
