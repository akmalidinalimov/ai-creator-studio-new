-- Take our cron burst off the top of the hour, and make the HTTP-fault alert say what was actually lost.
--
-- Evidence (2026-10-31 alert: "503 × 1" on eight callers). Every SUPABASE_EDGE_RUNTIME_SERVICE_DEGRADED on record falls
-- in the first seconds of an hour: 10-06 08:00 (3 calls), 10-06 12:00 (2), 10-18 15:00 (7), 10-31 16:00 (8). The edge logs
-- for 10-31 show those 8 refused with NO function id: nothing ran. Minute :00 carries 14 edge calls on average (19+ at
-- 16:00, when the 21:00 daily jobs join) against ~4 in an ordinary minute, and 43 of the last 47 unattributed 5 s
-- timeouts are at :00 as well. The code is undocumented, so the mechanism is inferred, not proven; the correlation is
-- 4 of 4. Staggering is cheap and every job below tolerates it, so the burst goes either way.
--
-- 1. Phase-shift the recurring edge jobs off :00/:15/:30/:45. Cadence is unchanged. Checked against each function:
--    only three read the minute at all, and all stay in window — cron-admin-digest (08:00 ±20 → 08:09),
--    cron-import-digest (18:00 ±20 → 18:12), cron-engagement (±30 windows → still ≥ 2 ticks each, so one lost tick is
--    still covered). engagement_run_watchdog tolerates 2 h of silence. The rest gate on the hour only.
-- 2. The weekly one-shots leave :00 too. They have no duplicate guard, so they get NO second fire.
-- 3. teacher-daily-digest gets the :20 retry group-room and teacher-room already have: it is the one one-shot with a
--    proven guard ("already_ran_today", now claimed by teacher_daily_report_start before the first DM), and it shared
--    that second with the 8 refused calls on 10-31 and only got a 200 by luck.
-- 4. bot-warmth-ping stays a GET (ops_net_post is POST-only) but records itself in ops_http_calls, so its failures stop
--    arriving as "unattributed", and it leaves :00.
-- 5. ops_http_failure_watchdog: a platform refusal is ONE line, not one per caller, and a failed job with no next tick
--    is named. The 10-31 alert listed eight faults and could not say that nothing was lost.
--
-- Deliberately left on :00: group-room, teacher-room and teacher-daily-digest (posted at 09:00 / 21:00 on purpose), and
-- the every-minute jobs (pg_cron has no sub-minute offset). Lint E12 keeps new edge jobs off :00.

do $$
declare
  _j record;
  _id bigint;
  _cur text;
  _moved text[] := array[]::text[];
  _bot_url constant text := 'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/telegram-bot-webhook';
  _cmd text;
begin
  for _j in
    select * from (values
      ('cron-engagement-every-30-min',      '*/30 * * * *',  '4,34 * * * *'),
      ('grade-card-reconcile',              '*/30 * * * *',  '8,38 * * * *'),
      ('cron-admin-digest-30min',           '*/30 * * * *',  '9,39 * * * *'),
      ('import-digest-30min',               '*/30 * * * *',  '12,42 * * * *'),
      ('bitrix-lead-sync',                  '*/15 * * * *',  '14,29,44,59 * * * *'),
      ('canary-15min',                      '*/15 * * * *',  '1,16,31,46 * * * *'),
      ('course-membership-check',           '*/15 * * * *',  '2,17,32,47 * * * *'),
      ('detect_and_nudge',                  '0 * * * *',     '18 * * * *'),
      ('teacher-engagement-nudge-hourly',   '0 * * * *',     '19 * * * *'),
      ('ungraded-homework-reminder-hourly', '0 * * * *',     '21 * * * *'),
      ('teacher-questions-reminder',        '*/5 * * * *',   '1-56/5 * * * *'),
      ('support-reminder',                  '*/10 * * * *',  '3-53/10 * * * *'),
      ('bot-warmth-ping',                   '*/4 * * * *',   '2-58/4 * * * *'),
      ('reputation-check-12h',              '0 4,15 * * *',  '5 4,15 * * *'),
      ('teacher-weekly-digest',             '0 4 * * 1',     '5 4 * * 1'),
      ('student-of-week',                   '0 4 * * 1',     '15 4 * * 1'),
      ('weekly_digest',                     '0 13 * * 0',    '5 13 * * 0'),
      ('weekly-admin-topic-check',          '0 14 * * 0',    '5 14 * * 0'),
      ('teacher-daily-digest',              '0 16 * * *',    '0,20 16 * * *')
    ) v(job, old_s, new_s)
  loop
    select jobid, schedule into _id, _cur from cron.job where jobname = _j.job;
    if _id is null then
      raise exception 'cron job % is gone — re-derive this migration', _j.job;
    end if;
    continue when _cur = _j.new_s;  -- replay
    if _cur <> _j.old_s then
      raise exception 'cron job % is on %, expected % — re-derive this migration', _j.job, _cur, _j.old_s;
    end if;
    perform cron.alter_job(job_id := _id, schedule := _j.new_s);
    _moved := _moved || _j.job;
  end loop;

  -- Attribution for the keep-alive. Its failures now carry a purpose, like every ops_net_post caller.
  select jobid, command into _id, _cmd from cron.job where jobname = 'bot-warmth-ping';
  if position('ops_http_calls' in _cmd) = 0 then
    if _cmd !~* 'net\.http_get' or position(_bot_url in _cmd) = 0 then
      raise exception 'bot-warmth-ping command changed — re-derive this migration';
    end if;
    perform cron.alter_job(job_id := _id, command := format(
      'insert into public.ops_http_calls (request_id, url, purpose) select net.http_get(url := %L), %L, %L on conflict (request_id) do nothing',  -- lint:allow E8: GET keep-alive; ops_net_post is POST-only, and this line records the attribution itself
      _bot_url, _bot_url, 'bot-warmth-ping'));
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_burst_staggered', jsonb_build_object('migration', '20261031170500', 'moved', to_jsonb(_moved)));
end $$;

do $pin$
declare _def text := pg_get_functiondef('public.ops_http_failure_watchdog()'::regprocedure);
begin
  if position('platform-503' in _def) = 0 and md5(_def) <> 'b02addb91fb39f49f9451971b790147d' then
    raise exception 'ops_http_failure_watchdog changed since 2026-10-31 — re-derive this rewrite from the live definition';
  end if;
end $pin$;

CREATE OR REPLACE FUNCTION public.ops_http_failure_watchdog()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  _cfg jsonb; _cooldown interval; _window interval; _timeout_threshold int;
  _state jsonb; _new_state jsonb; _lines text := ''; _sig text; _last timestamptz;
  _now timestamptz := now(); _tok text; _admin record; _rec record; _timeouts int; _sent int := 0;
  _deg_n int; _deg_mins int; _deg_at timestamptz;
begin
  select value into _cfg from platform_settings where key = 'ops_http_watchdog';
  if not coalesce((_cfg->>'enabled')::bool, true) then
    return jsonb_build_object('skipped', 'disabled');
  end if;
  _cooldown          := make_interval(hours => coalesce((_cfg->>'cooldown_hours')::int, 3));
  _window            := make_interval(mins  => coalesce((_cfg->>'window_min')::int, 45));
  _timeout_threshold := coalesce((_cfg->>'timeout_threshold')::int, 20);
  _state             := coalesce(_cfg->'alert_state', '{}'::jsonb);
  _new_state         := _state;

  -- platform refusals: the edge runtime answered before any function started, so all the callers of that second
  -- are one event, not one fault each. One line here; the per-caller loop below skips them.
  select count(*), count(distinct date_trunc('minute', occurred_at)), max(occurred_at)
    into _deg_n, _deg_mins, _deg_at
    from public.ops_http_failures
    where classification = 'real' and occurred_at > _now - _window
      and coalesce(content_snip, '') like '%SUPABASE_EDGE_RUNTIME_SERVICE_DEGRADED%';
  if _deg_n > 0 then
    _sig  := 'platform-503';
    _last := nullif(_new_state->>_sig, '')::timestamptz;
    if _last is null or _last < _now - _cooldown then
      _lines     := _lines || E'\n• 🟡 Supabase edge runtime refused ' || _deg_n || ' call(s)'
                            || case when _deg_mins > 1 then ' across ' || _deg_mins || ' separate minutes, last at '
                                    else ' at ' end
                            || to_char(_deg_at at time zone 'UTC', 'HH24:MI') || ' UTC. No function ran; '
                            || 'recurring jobs catch up on their next tick.';
      _new_state := jsonb_set(_new_state, array[_sig], to_jsonb(_now::text), true);
    end if;
  end if;

  -- real faults grouped by signature (attributed caller + status)
  for _rec in
    select coalesce(purpose, url, 'unattributed') as who, status_code, count(*) as n
    from public.ops_http_failures
    where classification = 'real' and occurred_at > _now - _window
      and coalesce(content_snip, '') not like '%SUPABASE_EDGE_RUNTIME_SERVICE_DEGRADED%'
    group by 1, 2
  loop
    _sig  := 'real:' || _rec.who || ':' || coalesce(_rec.status_code::text, 'ERR');
    _last := nullif(_new_state->>_sig, '')::timestamptz;
    if _last is null or _last < _now - _cooldown then
      _lines     := _lines || E'\n• ' || coalesce(_rec.status_code::text, 'ERR') || ' × ' || _rec.n
                            || '  ' || left(_rec.who, 60);
      _new_state := jsonb_set(_new_state, array[_sig], to_jsonb(_now::text), true);
    end if;
  end loop;

  -- a job that fires once a day or week has no next tick: name it, whatever the fault was. Only one fixed minute of
  -- one fixed hour counts: group-room's 0,20 has its retry, and reputation-check's 4,15 has the next run.
  for _rec in
    select j.jobname as who
    from public.ops_http_failures f
    join cron.job j on j.jobname = f.purpose
    where f.classification = 'real' and f.occurred_at > _now - _window and j.active
      and split_part(j.schedule, ' ', 2) ~ '^[0-9]+$'
      and split_part(j.schedule, ' ', 1) ~ '^[0-9]+$'
    group by 1
  loop
    _sig  := 'oneshot:' || _rec.who;
    _last := nullif(_new_state->>_sig, '')::timestamptz;
    if _last is null or _last < _now - _cooldown then
      _lines     := _lines || E'\n• ❗ NOT retried: ' || left(_rec.who, 60) || ' failed and has no next tick. Run it by hand.';
      _new_state := jsonb_set(_new_state, array[_sig], to_jsonb(_now::text), true);
    end if;
  end loop;

  -- timeout burst (rate-based, one signature)
  select count(*) into _timeouts
    from public.ops_http_failures
    where classification = 'timeout' and occurred_at > _now - _window;
  if _timeouts > _timeout_threshold then
    _sig  := 'timeout-burst';
    _last := nullif(_new_state->>_sig, '')::timestamptz;
    if _last is null or _last < _now - _cooldown then
      _lines     := _lines || E'\n• ⏱ Slow edge responses (over the wait limit): ' || _timeouts || ' in '
                            || coalesce(_cfg->>'window_min', '45') || 'm'
                            -- which callers: top 5 purposes in the window ('unattributed' = no ops_http_calls row)
                            || coalesce(' — ' || (
                                 select string_agg(case when t.rn <= 5 then left(t.who, 40) || ' ×' || t.n end, ', ' order by t.rn)
                                        || case when count(*) > 5 then ', +' || (count(*) - 5) || ' more' else '' end
                                   from (select coalesce(purpose, 'unattributed') as who, count(*) as n,
                                                row_number() over (order by count(*) desc, coalesce(purpose, 'unattributed')) as rn
                                           from public.ops_http_failures
                                          where classification = 'timeout' and occurred_at > _now - _window
                                          group by 1) t), '');
      _new_state := jsonb_set(_new_state, array[_sig], to_jsonb(_now::text), true);
    end if;
  end if;

  update platform_settings
     set value = jsonb_set(value, '{alert_state}', _new_state), updated_at = now()
   where key = 'ops_http_watchdog';

  if _lines = '' then
    return jsonb_build_object('alerted', 0, 'timeouts_window', _timeouts);
  end if;

  select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
  if _tok is null or _tok = '' then
    return jsonb_build_object('alerted', 0, 'note', 'no_token');
  end if;

  for _admin in
    select distinct p.telegram_id from profiles p
    join user_roles r on r.user_id = p.id and r.role in ('admin', 'superadmin')
    where p.telegram_id is not null
    limit 3
  loop
    begin
      -- send via ops_net_post so the alert channel itself is observed on the next sweep
      perform public.ops_net_post(
        'https://api.telegram.org/bot' || _tok || '/sendMessage',
        jsonb_build_object('chat_id', _admin.telegram_id,
          'text', '⚠️ HTTP faults (last ' || coalesce(_cfg->>'window_min', '45') || 'm):' || _lines
                  || E'\n\nRunbook: RUNBOOK.md · detail: ops_http_failures order by occurred_at desc'),
        jsonb_build_object('Content-Type', 'application/json'),
        'ops-http-alert'
      );
      _sent := _sent + 1;
    exception when others then null; end;
  end loop;

  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'ops_http_watchdog_alert', jsonb_build_object('lines', _lines, 'sent', _sent, 'at', _now));
  exception when others then null; end;

  return jsonb_build_object('alerted', _sent, 'lines', _lines);
end
$function$;

-- ACL exactly as live (service_role only)
revoke execute on function public.ops_http_failure_watchdog() from public, anon, authenticated;
grant execute on function public.ops_http_failure_watchdog() to service_role;

-- self-test (read-only; the watchdog itself is never called here: it writes state and sends): the only edge jobs
-- still on minute :00 are the every-minute ones and the three posted on the clock.
do $test$
declare _left text;
begin
  select string_agg(j.jobname, ', ') into _left
    from cron.job j
   where j.active
     and j.command ~ 'functions/v1/'
     and split_part(j.schedule, ' ', 1) <> '*'
     and (split_part(j.schedule, ' ', 1) ~ '^(0|0,.*|\*/[0-9]+)$')
     and j.jobname not in ('group-room-morning', 'group-room-evening', 'teacher-room-morning', 'teacher-room-evening',
                           'teacher-daily-digest');
  if _left is not null then
    raise exception 'self-test: edge jobs still on :00: %', _left;
  end if;
end $test$;
