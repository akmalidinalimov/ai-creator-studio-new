-- XP throughput watchdog: compare like with like, and stop diagnosing.
--
-- WHY (2026-09-15): the watchdog DM'd admins "XP faolligi keskin tushdi: ... atigi 7 ta (odatdagi
-- kunlik oʻrtacha ~16)" for a rolling window that covered a SUNDAY. Its baseline was the MEAN of the
-- last 7 CALENDAR days -- weekdays and weekend days averaged together -- so on a platform whose
-- weekends are quieter, an ordinary weekend sits below `mean * 0.5` by construction. The breach was
-- 7 against a trigger of 8: a single student. A detector that fires most weekends teaches its
-- readers to ignore it, which costs far more than the noise itself.
--
-- The message also asserted a cause it had never checked ("Mini App da video/vazifa hisobga
-- olinmayotgan boʻlishi mumkin"), sending whoever read it to hunt one specific ghost.
--
-- FIX, three parts:
--   1. Baseline = MEDIAN of the SAME rolling 24h window on the SAME weekday over the previous 3
--      weeks. Same day, same hours, and a median so one odd week (a holiday, an outage) cannot drag
--      it. This is the like-for-like comparison the old mean could never be.
--   2. Alert only after the breach repeats across CONSECUTIVE runs (6h apart). A one-student margin
--      can no longer page anyone; a genuine collapse still lands within ~6 hours.
--   3. The message reports what was measured and what it was measured against, and stops guessing at
--      the cause.
--
-- Deliberately unchanged: the >50% drop fraction, the min-baseline floor, the 12h re-alert throttle,
-- the admin fan-out, and the */6h cron. Idempotent + replay-safe (create-or-replace only), per the
-- deploy-concurrency doctrine.

create or replace function public.xp_throughput_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _tok text; _admin record;
  _today int := 0; _baseline numeric := 0; _samples int := 0;
  _state jsonb; _alerting boolean; _last_ms bigint; _streak int := 0;
  _now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  _should_alert boolean := false; _recovered boolean := false; _breached boolean; _msg text;
  _min_baseline numeric := 12;   -- ignore low-traffic periods (avoids false alarms on quiet weeks)
  _drop_frac numeric := 0.5;     -- alarm only on a >50% collapse vs the same weekday's norm
  _confirm_runs int := 2;        -- the breach must repeat on consecutive runs before anyone is paged
begin
  -- Distinct students earning a CORE action (lesson completion / homework submission) in the last 24h.
  select count(distinct user_id) into _today
  from public.xp_events
  where created_at > now() - interval '24 hours'
    and (ref_key like 'lesson:%' or ref_key like 'hw_submit:%');

  -- Baseline: the SAME 24h window on the same weekday, 1/2/3 weeks back. A week with no activity
  -- legitimately contributes 0 (left join), so a genuinely dead stretch still lowers the bar rather
  -- than hiding behind missing rows.
  select coalesce((percentile_cont(0.5) within group (order by cnt::double precision))::numeric, 0),
         count(*)
    into _baseline, _samples
  from (
    select w.k, count(distinct e.user_id) as cnt
    from generate_series(1, 3) as w(k)
    left join public.xp_events e
      on  e.created_at >  now() - (w.k * interval '7 days') - interval '24 hours'
      and e.created_at <= now() - (w.k * interval '7 days')
      and (e.ref_key like 'lesson:%' or e.ref_key like 'hw_submit:%')
    group by w.k
  ) t;

  _breached := (_baseline >= _min_baseline) and (_today < _baseline * _drop_frac);

  select value into _state from public.app_settings where key = 'xp_throughput_watchdog_state';
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  _last_ms  := coalesce((_state->>'last_alert_ms')::bigint, 0);
  _streak   := coalesce((_state->>'breach_streak')::int, 0);

  if _breached then
    _streak := _streak + 1;
    if _streak >= _confirm_runs and ((not _alerting) or (_now_ms - _last_ms > 43200000)) then
      _should_alert := true;   -- re-alert at most every 12h while it stays broken
    end if;
  else
    _streak := 0;
    if _alerting then _recovered := true; end if;
  end if;

  if _should_alert or _recovered then
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if _tok is not null and _tok <> '' then
      _msg := case
        when _recovered then
          '✅ XP faolligi normallashdi: soʻnggi 24 soatda dars/vazifadan XP olgan talaba '
          || _today || ' ta (shu hafta kuni uchun odatdagisi ~' || round(_baseline)::text || ' ta).'
        else
          '⚠️ XP faolligi past: soʻnggi 24 soatda dars/vazifadan XP olgan talaba ' || _today || ' ta. '
          || 'Shu hafta kuni uchun oxirgi ' || _samples || ' haftadagi odatdagi koʻrsatkich ~'
          || round(_baseline)::text || ' ta. Bu holat ketma-ket ' || _streak
          || ' ta tekshiruvda takrorlandi -- sababini tekshirish kerak.'
      end;
      for _admin in
        select distinct p.telegram_id from public.profiles p
        join public.user_roles r on r.user_id = p.id and r.role in ('admin','superadmin')
        where p.telegram_id is not null limit 3
      loop
        begin
          perform net.http_post(
            url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            headers := jsonb_build_object('Content-Type','application/json'),
            body := jsonb_build_object('chat_id', _admin.telegram_id, 'text', _msg));
        exception when others then null;
        end;
      end loop;
    end if;
  end if;

  insert into public.app_settings (key, value) values ('xp_throughput_watchdog_state', jsonb_build_object(
    'alerting', (_breached and _streak >= _confirm_runs),
    'last_alert_ms', case when _should_alert then _now_ms else _last_ms end,
    'breach_streak', _streak,
    'today_earners', _today, 'baseline', round(_baseline, 1),
    'baseline_basis', 'same weekday, same 24h window, median of previous ' || _samples || ' weeks',
    'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('today', _today, 'baseline', round(_baseline, 1), 'samples', _samples,
    'breach_streak', _streak, 'breached', _breached, 'alerted', _should_alert, 'recovered', _recovered);
end;
$function$;

revoke execute on function public.xp_throughput_watchdog() from public, anon, authenticated;
grant execute on function public.xp_throughput_watchdog() to service_role;

-- Deploy-time self-test: proves the rewritten body actually runs against real data (this repo has no
-- local Postgres, so this is its first real execution). It cannot page anyone on this run -- the
-- stored state carries no breach_streak yet, so the streak starts at 1 while the confirm gate is 2.
-- A failure is recorded, never raised: a broken watchdog must not abort a deploy.
do $$
begin
  perform public.xp_throughput_watchdog();
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'xp_throughput_watchdog_selftest_failed', jsonb_build_object('error', sqlerrm));
end $$;
