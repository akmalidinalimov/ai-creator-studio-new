-- XP throughput watchdog: compare like with like, never go silent, and stop diagnosing.
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
-- FIX, five parts:
--   1. Baseline = MEDIAN of the SAME rolling 24h window on the SAME weekday over the previous 3
--      weeks. Same day, same hours, and a median so one odd week (a holiday, an outage) cannot drag
--      it. This is the like-for-like comparison the old mean could never be.
--   2. Alert only after the breach repeats across CONSECUTIVE runs (6h apart). A one-student margin
--      can no longer page anyone; a genuine collapse still lands within ~6 hours.
--   3. A detector that CANNOT evaluate must say so rather than sit silent. With fewer than two
--      same-weekday windows carrying data (a young cohort, or a purge like 20260818140000 that
--      deletes lesson:/hw_submit: rows), the median collapses toward 0, the baseline drops under the
--      floor, and the breach test becomes permanently false -- the watchdog would quietly stop
--      watching. That state is now detected, held non-breaching, and recorded as a DB-visible
--      `xp_watchdog_low_history` row (edge-triggered, so it cannot spam).
--   4. TOTAL SILENCE always alarms. If nobody at all earned lesson/homework XP in 24h on a platform
--      that WAS active in the last 30 days, that is never "insufficient history" -- it is the loudest
--      possible signal, and both the old mean-based test (baseline 0 < floor 12) and part 3 above
--      would otherwise swallow it. The 30-day activity guard keeps a brand-new or dormant install
--      from paging anyone, and the confirm-streak still applies, so it takes ~12h of complete
--      silence to alert.
--   5. The message reports what was measured and what it was measured against, and stops guessing at
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
  _today int := 0; _baseline numeric := 0; _weeks int := 0;
  _state jsonb; _alerting boolean; _last_ms bigint; _streak int := 0; _prev_weeks int;
  _now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  _should_alert boolean := false; _recovered boolean := false; _breached boolean; _msg text;
  _low_history boolean := false; _ever_active boolean := false; _silence boolean := false;
  _min_baseline numeric := 12;   -- ignore low-traffic periods (avoids false alarms on quiet weeks)
  _drop_frac numeric := 0.5;     -- alarm only on a >50% collapse vs the same weekday's norm
  _confirm_runs int := 2;        -- the breach must repeat on consecutive runs before anyone is paged
  _min_weeks int := 2;           -- below this, the median is not a baseline -- it is an artefact
begin
  -- Distinct students earning a CORE action (lesson completion / homework submission) in the last 24h.
  select count(distinct user_id) into _today
  from public.xp_events
  where created_at > now() - interval '24 hours'
    and (ref_key like 'lesson:%' or ref_key like 'hw_submit:%');

  -- Has this install earned ANY core XP in the last 30 days? Guards the total-silence rule below so a
  -- brand-new or deliberately dormant install never pages anyone.
  select exists (
    select 1 from public.xp_events
    where created_at > now() - interval '30 days'
      and (ref_key like 'lesson:%' or ref_key like 'hw_submit:%')
  ) into _ever_active;

  -- Baseline: the SAME 24h window on the same weekday, 1/2/3 weeks back. `_weeks` counts the windows
  -- that actually carried data -- NOT the number of windows examined, which is always 3 and would
  -- happily report "3 weeks" for a table holding one day of history.
  select coalesce((percentile_cont(0.5) within group (order by cnt::double precision))::numeric, 0),
         count(*) filter (where cnt > 0)
    into _baseline, _weeks
  from (
    select w.k, count(distinct e.user_id) as cnt
    from generate_series(1, 3) as w(k)
    left join public.xp_events e
      on  e.created_at >  now() - (w.k * interval '7 days') - interval '24 hours'
      and e.created_at <= now() - (w.k * interval '7 days')
      and (e.ref_key like 'lesson:%' or e.ref_key like 'hw_submit:%')
    group by w.k
  ) t;

  select value into _state from public.app_settings where key = 'xp_throughput_watchdog_state';
  _alerting   := coalesce((_state->>'alerting')::boolean, false);
  _last_ms    := coalesce((_state->>'last_alert_ms')::bigint, 0);
  _streak     := coalesce((_state->>'breach_streak')::int, 0);
  _prev_weeks := coalesce((_state->>'weeks_with_data')::int, 99);

  _low_history := (_weeks < _min_weeks);
  _silence     := (_today = 0 and _ever_active);

  if _silence then
    -- Nobody at all, on a platform that was alive this month. Never explained away as thin history.
    _breached := true;
  elsif _low_history then
    -- Not enough comparable history to judge: refuse to claim a breach, and make the blind spot
    -- DB-visible instead of silently never firing again. Edge-triggered (only on the transition into
    -- low-history) so a long-lived gap cannot flood admin_actions every 6 hours.
    _breached := false;
    if _prev_weeks >= _min_weeks then
      begin
        insert into public.admin_actions (actor_user_id, action, details)
        values (null, 'xp_watchdog_low_history', jsonb_build_object(
          'weeks_with_data', _weeks, 'today_earners', _today,
          'note', 'same-weekday baseline unavailable; breach detection paused'));
      exception when others then null;
      end;
    end if;
  else
    _breached := (_baseline >= _min_baseline) and (_today < _baseline * _drop_frac);
  end if;

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
        when _silence then
          '🚨 Soʻnggi 24 soatda dars/vazifadan XP olgan talaba umuman boʻlmadi. '
          || 'Shu hafta kuni uchun odatdagi koʻrsatkich ~' || round(_baseline)::text || ' ta. '
          || 'Bu holat ketma-ket ' || _streak || ' ta tekshiruvda takrorlandi.'
        else
          '⚠️ XP faolligi past: soʻnggi 24 soatda dars/vazifadan XP olgan talaba ' || _today || ' ta. '
          || 'Shu hafta kuni uchun oxirgi ' || _weeks || ' haftadagi odatdagi koʻrsatkich ~'
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
    'weeks_with_data', _weeks, 'low_history', _low_history, 'total_silence', _silence,
    'baseline_basis', 'median of the same 24h window on the same weekday, previous 3 weeks',
    'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('today', _today, 'baseline', round(_baseline, 1),
    'weeks_with_data', _weeks, 'low_history', _low_history, 'total_silence', _silence,
    'breach_streak', _streak, 'breached', _breached, 'alerted', _should_alert,
    'recovered', _recovered);
end;
$function$;

revoke execute on function public.xp_throughput_watchdog() from public, anon, authenticated;
grant execute on function public.xp_throughput_watchdog() to service_role;

-- Reset the stored state BEFORE the self-test runs, for two reasons.
-- (1) `alerting` changes meaning here: it now means "breached AND confirmed across runs", which the
--     old flag never did, so carrying the old value forward would be a lie.
-- (2) Without this, a stored `alerting = true` (entirely plausible right now -- the incident that
--     prompted this migration is hours old) makes the very first run take the RECOVERY path, which
--     has no confirm gate, and DM every admin an unsolicited "back to normal" message mid-migration.
-- `public.app_settings.value || ...` inside ON CONFLICT reads the EXISTING row, so unrelated keys
-- survive. A genuine ongoing collapse is not hidden: the next two cron runs re-confirm within ~12h.
insert into public.app_settings (key, value)
values ('xp_throughput_watchdog_state', jsonb_build_object(
  'alerting', false, 'breach_streak', 0, 'last_alert_ms', 0,
  'note', 'reset by 20260915102500 -- alerting now means breached AND confirmed'))
on conflict (key) do update set value = public.app_settings.value
  || jsonb_build_object('alerting', false, 'breach_streak', 0);

-- Deploy-time self-test: proves the rewritten body actually runs against real data (this repo has no
-- local Postgres, so this is its first real execution). With the state reset above, neither
-- notification path can fire on this run: the breach path needs a streak of 2, and the recovery path
-- needs a stored `alerting = true`. A failure is recorded, never raised -- a broken watchdog must not
-- abort a deploy.
do $$
begin
  perform public.xp_throughput_watchdog();
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'xp_throughput_watchdog_selftest_failed', jsonb_build_object('error', sqlerrm));
end $$;
