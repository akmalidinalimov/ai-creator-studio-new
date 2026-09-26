-- DETECTOR for the "cron-engagement was killed mid-run" class (prevention hierarchy layer 5).
--
-- WHY. cron-engagement (every 30 min, pg_cron job `cron-engagement-every-30-min`) sends the daily
-- reminder, the 21:00 streak warning and the 12:00 re-engagement drip. In the Tashkent 19:30-21:30
-- window the platform killed it — "CPU Time exceeded" 5x on 2026-09-25 and 3x on 2026-09-26, plus one
-- 150 s wall-clock shutdown at 15:30 UTC on 09-26 — and 74 eligible students got NO daily reminder on
-- 09-26. Nothing alarmed: a killed edge function leaves only a line in the function logs, which no
-- watchdog reads. The function fix (same PR) makes it cheap and budgeted; this makes the class LOUD:
-- the function now writes `engagement_run_started` when a run begins and `engagement_run_done` (with
-- processed / sent per kind / skipped / deferred / partial / errors / requests / duration_ms) when it
-- ends, both to admin_actions, paired by details.run_id. A start with no done = a killed run.
--
-- WHAT ALARMS (DM to up to 3 admins via public.ops_net_post, re-alert every 6 h while it persists,
-- one "recovered" message when it clears). Looking at the last 2 hours:
--   unfinished — a run started more than 3 minutes ago has no matching done row (killed: CPU,
--                wall clock, crash). Runs are budgeted to ~100 s, so 3 minutes is generous.
--   partial    — a run hit its wall-time or request budget and deferred students to the next tick.
--                Not lost (the next tick is still inside the ±30-min window), but it means the load no
--                longer fits one tick, which is exactly the early warning that was missing.
--   errored    — a run ended with a run-level error (e.g. the profiles read failed, bot token missing)
--                or with per-user exceptions. Baseline measured before this change: 0 "user loop error"
--                lines on 09-25 and 09-26, so this is silent when healthy.
--   silent     — runs WERE seen, but none has started for 2 hours (cron job disabled, pg_net dead, the
--                internal-secret check 403-ing every call, the function failing to boot).
--   never_started — the watchdog has existed for 2 hours and has never seen a run at all (the new
--                function version never deployed).
--
-- ABSENCE BEFORE THE FIRST RUN DOES NOT ALARM. Today there are zero engagement_run_* rows (verified).
-- unfinished/partial/errored count rows that exist, so they are 0. `silent` needs `ever_seen_run`, which
-- only becomes true once a started row has been seen (it is then sticky in the state row, so a silence
-- longer than the 7-day lookback cannot quietly "recover"). `never_started` waits 2 hours from the moment
-- this migration seeds the state row — the function deploys before migrations in the pipeline and runs
-- every 30 minutes, so a healthy deploy produces its first row long before that.
--
-- DESIGNED-OUT, from this project's own past watchdog failures:
--   * The metric nothing writes: every signal is a row the function itself writes on every run, and the
--     "silent" leg alarms precisely when those rows stop coming.
--   * NULL-as-verdict: counts come from count(*) (never NULL), sums are coalesced, casts of untrusted
--     jsonb text are regex-guarded or wrapped, and the watchdog treats an unreadable verdict AS an alarm.
--   * A future `last_alert_ms` (clock skew, hand edit) would suppress every re-alert: clamped to now.
--   * Telegram's 4096-char limit: the message is truncated to 3900.
--   * The DM goes through ops_net_post, not a raw net.http_post: a non-delivery lands in
--     ops_http_failures (alarmed by ops_http_failure_watchdog) and the bot token is scrubbed from the
--     recorded URL. Content-Type is passed explicitly (ops_net_post's p_headers defaults to {}).
--   * Liveness: the state row is named `engagement_run_watchdog_state`, so hw_dm_health_stats()'s
--     `%_watchdog_state` scan (and through it the out-of-band GitHub verifier) flags this watchdog if it
--     stops running for 25 h. The row exists from the moment this migration lands (seeded below).
--
-- DEPLOY SELF-TEST: calls ONLY engagement_run_health(), which is read-only (STABLE, no writes, no DM,
-- no advisory lock, no auth.uid()/JWT). It cannot mutate what it checks. It asserts the verdict is
-- non-NULL — not that it is "false", because a genuinely killed run just before deploy must not fail
-- the migration. If it throws, the state row is seeded with checked_at = 'epoch', which the liveness
-- scan reports on its next pass instead of hiding a detector that cannot run.
--
-- KILL-SWITCH: select cron.unschedule('engagement-run-watchdog');
-- Idempotent + replay-safe: CREATE OR REPLACE; unschedule before schedule; the state seed is
-- ON CONFLICT DO NOTHING so a replay never resets first_checked_at / ever_seen_run.

create or replace function public.engagement_run_health()
returns jsonb
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  _grace   constant interval := interval '3 minutes';
  _window  constant interval := interval '2 hours';
  _silence constant interval := interval '2 hours';
  _state jsonb;
  _first_checked timestamptz;
  _last_started timestamptz;
  _ever boolean;
  _unfinished int;
  _unfinished_oldest timestamptz;
  _done int;
  _partial int;
  _deferred bigint;
  _errored int;
  _error_sample text;
  _user_errors bigint;
  _prefetch_failed int;
  _silent boolean;
  _never_started boolean;
  _alarm boolean;
  _last_done jsonb;
begin
  select value into _state from public.app_settings where key = 'engagement_run_watchdog_state';
  begin
    _first_checked := (_state->>'first_checked_at')::timestamptz;
  exception when others then
    _first_checked := null;
  end;

  -- Latest run start. Bounded to 7 days so it rides the created_at index; "has a run EVER been seen"
  -- is the sticky ever_seen_run flag in the state row.
  select max(created_at) into _last_started
  from public.admin_actions
  where action = 'engagement_run_started' and created_at > now() - interval '7 days';

  _ever := coalesce(_state->>'ever_seen_run', '') = 'true' or _last_started is not null;

  -- Started more than _grace ago, and no done row carries the same run_id: killed.
  select count(*), min(s.created_at) into _unfinished, _unfinished_oldest
  from public.admin_actions s
  where s.action = 'engagement_run_started'
    and s.created_at > now() - _window
    and s.created_at <= now() - _grace
    and not exists (
      select 1 from public.admin_actions d
      where d.action = 'engagement_run_done'
        and d.created_at >= s.created_at
        and d.details->>'run_id' = s.details->>'run_id');

  select count(*),
         count(*) filter (where d.details->>'partial' = 'true'),
         coalesce(sum(case when d.details->>'partial' = 'true' and coalesce(d.details->>'deferred', '') ~ '^[0-9]{1,9}$'
                           then (d.details->>'deferred')::bigint else 0 end), 0),
         count(*) filter (where coalesce(d.details->>'error', '') <> ''),
         (array_agg(d.details->>'error' order by d.created_at desc)
            filter (where coalesce(d.details->>'error', '') <> ''))[1],
         coalesce(sum(case when coalesce(d.details->>'errors', '') ~ '^[0-9]{1,9}$'
                           then (d.details->>'errors')::bigint else 0 end), 0),
         -- CASE, not AND: SQL does not promise left-to-right evaluation, and jsonb_array_length raises
         -- on a non-array.
         count(*) filter (where case when jsonb_typeof(d.details->'prefetch_failed') = 'array'
                                     then jsonb_array_length(d.details->'prefetch_failed') > 0
                                     else false end)
    into _done, _partial, _deferred, _errored, _error_sample, _user_errors, _prefetch_failed
  from public.admin_actions d
  where d.action = 'engagement_run_done' and d.created_at > now() - _window;

  select d.details into _last_done
  from public.admin_actions d
  where d.action = 'engagement_run_done' and d.created_at > now() - interval '1 day'
  order by d.created_at desc limit 1;

  _silent := _ever and (_last_started is null or _last_started < now() - _silence);
  _never_started := (not _ever) and _first_checked is not null and _first_checked < now() - _silence;

  _alarm := coalesce(_unfinished, 0) > 0
         or coalesce(_partial, 0) > 0
         or coalesce(_errored, 0) > 0
         or coalesce(_user_errors, 0) > 0
         or coalesce(_silent, false)
         or coalesce(_never_started, false);

  return jsonb_build_object(
    'alarm', _alarm,
    'ever_seen_run', _ever,
    'last_started', _last_started,
    'last_started_tashkent', to_char(_last_started at time zone 'Asia/Tashkent', 'DD.MM HH24:MI'),
    'unfinished_runs', coalesce(_unfinished, 0),
    'unfinished_oldest', _unfinished_oldest,
    'done_runs', coalesce(_done, 0),
    'partial_runs', coalesce(_partial, 0),
    'deferred_students', coalesce(_deferred, 0),
    'errored_runs', coalesce(_errored, 0),
    'error_sample', left(_error_sample, 200),
    'user_errors', coalesce(_user_errors, 0),
    'prefetch_failed_runs', coalesce(_prefetch_failed, 0),
    'silent', coalesce(_silent, false),
    'never_started', coalesce(_never_started, false),
    'window', '2 hours',
    'last_done', _last_done,
    'checked_at', now());
end;
$function$;

create or replace function public.engagement_run_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _r jsonb;
  _alarm boolean;
  _state jsonb;
  _alerting boolean;
  _last_ms bigint;
  _should_alert boolean := false;
  _recovered boolean := false;
  _now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  _tok text;
  _admin record;
  _msg text := '';
  _req bigint;
  _dm int := 0;
begin
  select value into _state from public.app_settings where key = 'engagement_run_watchdog_state';
  _r := public.engagement_run_health();
  -- A verdict we cannot read is itself an alarm, never a quiet "false".
  _alarm := coalesce(_r->>'alarm' = 'true', true);

  _alerting := coalesce(_state->>'alerting', '') = 'true';
  _last_ms := least(
    coalesce(case when coalesce(_state->>'last_alert_ms', '') ~ '^[0-9]{1,15}$'
                  then (_state->>'last_alert_ms')::bigint end, 0),
    _now_ms);

  if _alarm then
    if (not _alerting) or (_now_ms - _last_ms > 21600000) then _should_alert := true; end if; -- 6 h
  elsif _alerting then
    _recovered := true;
  end if;

  if _should_alert or _recovered then
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if coalesce(_tok, '') <> '' then
      if _should_alert then
        if coalesce((_r->>'unfinished_runs')::int, 0) > 0 then
          _msg := _msg || '🚨 cron-engagement: soʻnggi 2 soatda ' || (_r->>'unfinished_runs')
               || ' ta yugurish boshlandi, lekin TUGAMADI (platforma CPU/vaqt limiti bilan toʻxtatgan boʻlishi mumkin). '
               || 'Kunlik eslatma / streak / drip bir qism talabalarga yetmagan boʻlishi mumkin.' || E'\n';
        end if;
        if coalesce((_r->>'partial_runs')::int, 0) > 0 then
          _msg := _msg || '⚠️ cron-engagement: ' || (_r->>'partial_runs') || ' ta yugurish byudjetga yetdi va '
               || (_r->>'deferred_students') || ' ta talabani keyingi yugurishga qoldirdi. '
               || 'Tez-tez takrorlansa — yuklama bitta yugurishga sigʻmayapti.' || E'\n';
        end if;
        if coalesce((_r->>'errored_runs')::int, 0) > 0 or coalesce((_r->>'user_errors')::bigint, 0) > 0 then
          _msg := _msg || '⚠️ cron-engagement xatolar bilan tugadi: ' || (_r->>'errored_runs') || ' ta yugurish xatosi, '
               || (_r->>'user_errors') || ' ta talaba xatosi'
               || coalesce(' — ' || (_r->>'error_sample'), '') || '.' || E'\n';
        end if;
        if coalesce(_r->>'silent', '') = 'true' then
          _msg := _msg || '🚨 cron-engagement 2 soatdan beri ishga tushmayapti (oxirgi: '
               || coalesce(_r->>'last_started_tashkent', '7 kundan oldin') || ' Toshkent) — eslatmalar yuborilmayapti. '
               || 'cron.job "cron-engagement-every-30-min" va funksiya loglarini tekshiring.' || E'\n';
        end if;
        if coalesce(_r->>'never_started', '') = 'true' then
          _msg := _msg || '🚨 engagement watchdog 2 soatdan beri ishlaydi, lekin cron-engagement birorta ham yugurishni qayd etmadi — '
               || 'funksiyaning yangi versiyasi deploy boʻlmagan yoki cron ishlamayapti.' || E'\n';
        end if;
        if _msg = '' then
          _msg := '⚠️ cron-engagement watchdog holatni oʻqiy olmadi: ' || coalesce(_r::text, 'NULL') || E'\n';
        end if;
        _msg := _msg || 'admin_actions: "engagement_run_started" / "engagement_run_done".';
      else
        _msg := '✅ cron-engagement normallashdi: soʻnggi 2 soatdagi yugurishlar toʻliq va xatosiz tugadi.';
      end if;

      for _admin in
        select distinct p.telegram_id from public.profiles p
        join public.user_roles r on r.user_id = p.id and r.role in ('admin', 'superadmin')
        where p.telegram_id is not null limit 3
      loop
        begin
          _req := public.ops_net_post(
            p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            p_body       := jsonb_build_object('chat_id', _admin.telegram_id, 'text', left(_msg, 3900)),
            p_headers    := jsonb_build_object('Content-Type', 'application/json'),
            p_purpose    := 'engagement_run_watchdog',
            p_timeout_ms := 5000);
          _dm := _dm + 1;
        exception when others then null; end;
      end loop;
    end if;

    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null,
              case when _should_alert then 'engagement_run_watchdog_ALARM' else 'engagement_run_watchdog_recovered' end,
              _r || jsonb_build_object('dm_attempted', _dm));
    exception when others then null; end;
  end if;

  insert into public.app_settings (key, value)
  values ('engagement_run_watchdog_state', jsonb_build_object(
    'alerting', _alarm,
    -- Only a send that was actually attempted starts the 6 h cooldown; otherwise the next run retries.
    'last_alert_ms', case when _should_alert and _dm > 0 then _now_ms else _last_ms end,
    'ever_seen_run', coalesce(_r->>'ever_seen_run', '') = 'true',
    'first_checked_at', coalesce(_state->'first_checked_at', to_jsonb(now())),
    'dm_attempted_last_run', _dm,
    'last_report', _r,
    'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return _r;
end;
$function$;

-- House pattern: PUBLIC first, then the roles; only service_role (and the owner) may run them.
revoke execute on function public.engagement_run_health() from public, anon, authenticated;
grant  execute on function public.engagement_run_health() to service_role;
revoke execute on function public.engagement_run_watchdog() from public, anon, authenticated;
grant  execute on function public.engagement_run_watchdog() to service_role;

-- Every 30 minutes at :10 and :40 — 10 minutes after each cron-engagement tick (:00/:30), well past the
-- 3-minute grace, and off the busy minute boundaries.
do $$
begin
  perform cron.unschedule('engagement-run-watchdog');
exception when others then null;
end $$;

do $$
begin
  perform cron.schedule('engagement-run-watchdog', '10,40 * * * *',
                        $cmd$ select public.engagement_run_watchdog() $cmd$);
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_schedule_failed',
          jsonb_build_object('job', 'engagement-run-watchdog', 'error', sqlerrm));
end $$;

-- Deploy self-test (read-only) + state seed. See the header.
do $$
declare
  _r jsonb;
begin
  _r := public.engagement_run_health();
  if _r is null or (_r->>'alarm') is null then
    raise exception 'engagement_run_health() returned no verdict: %', coalesce(_r::text, 'NULL');
  end if;
  insert into public.app_settings (key, value)
  values ('engagement_run_watchdog_state', jsonb_build_object(
    'alerting', false,
    'last_alert_ms', 0,
    'ever_seen_run', coalesce(_r->>'ever_seen_run', '') = 'true',
    'first_checked_at', now(),
    'seeded_by', '20260926232000',
    'last_report', _r,
    'checked_at', now()))
  on conflict (key) do nothing;
exception when others then
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'engagement_run_watchdog_selftest_failed', jsonb_build_object('error', sqlerrm));
  exception when others then null; end;
  begin
    insert into public.app_settings (key, value)
    values ('engagement_run_watchdog_state', jsonb_build_object(
      'alerting', true,
      'selftest_failed', sqlerrm,
      'last_alert_ms', 0,
      'checked_at', 'epoch'::timestamptz))
    on conflict (key) do update set value = excluded.value;
  exception when others then null; end;
end $$;
