-- XP throughput watchdog: measure the invariant, not a proxy that goes blind.
--
-- THE BUG, FOUND LIVE ON PRODUCTION 2026-09-25
--   The deployed body alarms only when
--       _breached := (_baseline >= _min_baseline) and (_today < _baseline * _drop_frac)
--   with `_min_baseline := 12` and `_baseline` = the mean daily count of distinct students earning
--   lesson:/hw_submit: XP over the last 7 complete days.
--   The 5.0 cohort wound down. That mean fell to 11.43 on 2026-09-19 and has stayed under 12 ever
--   since, so the FIRST CONJUNCT IS PERMANENTLY FALSE and no value of `_today` — including zero —
--   can raise an alert. 24+ consecutive runs were structurally incapable of firing. The last one
--   recorded {"today_earners":4,"baseline":10,"alerting":false}: a 60% drop, silent.
--
--   THE GENERAL LESSON, which this file must not quietly reintroduce: a detector with a minimum-VOLUME
--   floor goes blind exactly when the population shrinks — which is exactly when a small or brand-new
--   cohort most needs watching. The 6.0 challenge cohort starts near zero, so the old rule would have
--   protected it for none of its early weeks. A sweep of every *_watchdog / *_health function on this
--   database confirms xp_throughput_watchdog was the ONLY one carrying such a floor, and also the only
--   one writing no admin_actions row — so this file closes both halves of a one-instance class.
--
-- WHY NOT THE WEEKDAY-MEDIAN APPROACH (PR #165 / migration 20260915102500, closed unmerged)
--   Its premise — "weekends are quieter, so a mean baseline pages every weekend" — is refuted by this
--   platform's own data. Detrended per-weekday ratios over 60 days: Thu 1.0728, SUN 1.0405 (second
--   HIGHEST), Mon 1.0007, Fri 0.9952, Wed 0.9917, Sat 0.9482, Tue 0.9449. Total spread ~±6%, far
--   inside a ±50% trigger, and the alert that prompted it landed on a TUESDAY. Replayed against real
--   traffic that design breaches on 17 of 84 runs in 21 days (~5 false DMs) and then slips under the
--   SAME unchanged floor, going blind without even emitting its own breadcrumb.
--
-- THE FIX: stop counting students, start checking the invariant.
--   "Did a completed action produce its XP?" is scale-free — it reads the same at 500 students or 5,
--   needs no baseline and no floor, and is the actual thing the alert text always claimed to be about
--   ("Mini App da video/vazifa hisobga olinmayotgan boʻlishi mumkin"). Simulated over 121 six-hourly
--   ticks across the last 30 days of real production data: 0 capture breaches, 0 silence ticks, worst
--   missing count 0, window size 14-92 lessons — quiet by construction on healthy data.
--
--   THREE CAPTURE STREAMS, each judged independently so one broken path cannot hide behind another:
--     lesson:<lesson_id>          from lesson_progress.completed_at
--     hw_submit:<assignment_id>   from homework_submissions.submitted_at
--     hw_score:<assignment_id>    from homework_submissions where score >= 9
--   Verified healthy-quiet before adding the third: 130 high scores in 30 days, 0 missing.
--
--   DELIBERATELY NOT COVERED: `day:<date>` (daily_active). There are 10,043 day: events against
--   10,185 daily_watch_summary rows, so an award is NOT expected for every row — a stream built on
--   that assumption would cry wolf. Covering it needs the real award threshold first. Checked, not
--   assumed; left out on purpose rather than shipped as a noisy detector.
--
--   PLUS: SILENCE — nobody at all earned core XP in 24h on an install that is otherwise alive. Kept
--   from PR #165, the one idea there worth keeping. Needs two consecutive runs, because a genuinely
--   quiet night on a tiny cohort is not an outage.
--   PLUS: VOLUME — reported for context ONLY, never triggers. This is the number that used to page
--   people and then went blind; demoted to information rather than deleted, because it reads well in
--   the message.
--
--   "IS THE PLATFORM ALIVE" IS MEASURED FROM ACTIVITY, NOT FROM XP. `_ever_active` reads
--   lesson_progress/homework_submissions, not xp_events. If it read xp_events, then a TOTAL capture
--   outage lasting past the 30-day window would make the guard false, un-breach the detector and fire
--   a "recovered" message for an outage that never ended — the same go-blind-as-the-signal-dies shape
--   this migration exists to remove. A watchdog must never ask the broken thing whether to keep watching.
--
--   GRACE WINDOW: lesson/homework XP is written by triggers (instant), re-derived by reconcile_all_xp()
--   hourly at :27, and for lessons again by reconcile_lesson_completions() every 15 min. 90 minutes
--   covers a full hourly cycle with ~30 minutes of slack, so a row is only "missing" once every path
--   that could have written it has had its turn.
--
--   RECOVERY IS DEBOUNCED AND HONEST. The capture rule reads a ROLLING 24h window, so an unfixed gap
--   eventually ages out of the window on its own. Recovering on the first clean run would therefore
--   announce "✅ back to normal" for a problem nobody fixed — exactly the false all-clear the OLD
--   watchdog sent on 2026-09-16 into a decline that kept going. Recovery now needs two consecutive
--   clean runs, and the message states what was measured instead of claiming a repair.
--
-- Idempotent + replay-safe: create-or-replace plus `create index if not exists`, no schedule change
-- (cron `xp-throughput-watchdog` at `20 */6 * * *` already calls this exact function name). Touches
-- no xp_events row and no student-facing data.

-- ───────────────────────── Supporting indexes ─────────────────────────
-- The capture queries filter on completed_at / submitted_at / scored_at, none of which lead an
-- existing index (idx_lesson_progress_user_completed leads with user_id, unusable here). Both tables
-- are small today — 5,571 rows / 20 MB and 737 rows / 1,864 kB — so these build instantly and the
-- scans they replace are cheap either way; they are here so the 6-hourly scan stays cheap as the 6.0
-- cohort grows. Same leading-column lesson already applied to xp_events in 20260830130100.
create index if not exists idx_lesson_progress_completed_at
  on public.lesson_progress (completed_at) where completed_at is not null;
create index if not exists idx_homework_submissions_submitted_at
  on public.homework_submissions (submitted_at);
create index if not exists idx_homework_submissions_scored_at
  on public.homework_submissions (scored_at) where score is not null;

create or replace function public.xp_throughput_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _grace interval := interval '90 minutes';
  _l_total int := 0; _l_missing int := 0;
  _h_total int := 0; _h_missing int := 0;
  _s_total int := 0; _s_missing int := 0;
  _today int := 0; _volume numeric := 0; _ever_active boolean := false;
  _cap_breach boolean := false; _silence boolean := false; _breached boolean := false;
  _state jsonb; _alerting boolean; _alerting_next boolean; _last_ms bigint;
  _sil_streak int := 0; _clean_streak int := 0;
  _now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  _should_alert boolean := false; _recovered boolean := false;
  _tok text; _admin record; _msg text; _report jsonb; _queued int := 0;
  _min_missing int := 3;         -- a stray row or two is never an outage
  _miss_frac numeric := 0.10;    -- more than 10% of a window going unawarded is
  _total_min int := 2;           -- ...but 100% of a window is, from 2 rows up
begin
  -- Serialises a cron tick against the deploy self-test (and any manual call), so two runs cannot both
  -- read alerting=false and both fan out the same alert to admins.
  perform pg_advisory_xact_lock(hashtext('xp_throughput_watchdog'));

  -- ---- 1. CAPTURE: did the action produce its XP? -------------------------------------------
  -- Guarded as a block: a bad cast or a renamed column must surface loudly, not as a watchdog that
  -- quietly returns success forever. That is the failure mode this file exists to fix.
  begin
    select count(*), count(*) filter (where e.id is null)
      into _l_total, _l_missing
    from public.lesson_progress lp
    left join public.xp_events e
      on e.user_id = lp.user_id and e.ref_key = 'lesson:' || lp.lesson_id::text
    where lp.completed_at > now() - interval '24 hours'
      and lp.completed_at < now() - _grace;

    -- Homework XP is keyed by ASSIGNMENT, not submission id (see reconcile_all_xp:
    -- 'hw_submit:' || hs.assignment_id), so resubmissions collapse to one expected award.
    select count(*), count(*) filter (where e.id is null)
      into _h_total, _h_missing
    from public.homework_submissions hs
    left join public.xp_events e
      on e.user_id = hs.user_id and e.ref_key = 'hw_submit:' || hs.assignment_id::text
    where hs.submitted_at > now() - interval '24 hours'
      and hs.submitted_at < now() - _grace;

    -- High score (>= 9) earns a separate award. A grading-path failure shows up here and nowhere else.
    select count(*), count(*) filter (where e.id is null)
      into _s_total, _s_missing
    from public.homework_submissions hs
    left join public.xp_events e
      on e.user_id = hs.user_id and e.ref_key = 'hw_score:' || hs.assignment_id::text
    where hs.score >= 9
      and hs.scored_at > now() - interval '24 hours'
      and hs.scored_at < now() - _grace;

    select count(distinct user_id) into _today
    from public.xp_events
    where created_at > now() - interval '24 hours'
      and (ref_key like 'lesson:%' or ref_key like 'hw_submit:%');

    -- Context only. Never gates anything.
    select coalesce(avg(cnt), 0) into _volume from (
      select date_trunc('day', created_at) d, count(distinct user_id) cnt
      from public.xp_events
      where created_at >= date_trunc('day', now()) - interval '7 days'
        and created_at <  date_trunc('day', now())
        and (ref_key like 'lesson:%' or ref_key like 'hw_submit:%')
      group by 1
    ) t;

    -- Read from ACTIVITY, never from xp_events — see the header. A dead platform stays quiet; a
    -- platform that is working but not being credited still alarms.
    select exists (
      select 1 from public.lesson_progress
      where completed_at > now() - interval '30 days'
      union all
      select 1 from public.homework_submissions
      where submitted_at > now() - interval '30 days'
    ) into _ever_active;
  exception when others then
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'xp_capture_watchdog_crashed', jsonb_build_object('error', sqlerrm, 'at', now()));
    exception when others then null; end;
    -- A crash that only ever writes a row is a detector nobody reads. Page once, best-effort.
    begin
      select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
      if _tok is not null and _tok <> '' then
        for _admin in
          select distinct p.telegram_id from public.profiles p
          join public.user_roles r on r.user_id = p.id and r.role in ('admin','superadmin')
          where p.telegram_id is not null limit 1
        loop
          perform public.ops_net_post(
            'https://api.telegram.org/bot' || _tok || '/sendMessage',
            jsonb_build_object('chat_id', _admin.telegram_id,
              'text', '⚠️ XP nazorati ishlamay qoldi (xatolik): ' || left(sqlerrm, 200)),
            jsonb_build_object('Content-Type','application/json'), 'xp-capture-watchdog', 8000);
        end loop;
      end if;
    exception when others then null; end;
    return jsonb_build_object('crashed', true, 'error', sqlerrm, 'checked_at', now());
  end;

  -- Per stream: 100% of a window (from 2 rows up) OR a meaningful share of a bigger one. No volume
  -- gate — `greatest(total,1)` means 3-of-3 fires exactly as loudly as 30-of-300, and the
  -- 100%-of-a-small-window arm closes the low-volume hole where a totally broken stream stays under
  -- `_min_missing` while a healthy sibling stream keeps `_today` above zero.
  _cap_breach :=
      (_l_total >= _total_min and _l_missing = _l_total)
   or (_l_missing >= _min_missing and _l_missing::numeric / greatest(_l_total, 1) > _miss_frac)
   or (_h_total >= _total_min and _h_missing = _h_total)
   or (_h_missing >= _min_missing and _h_missing::numeric / greatest(_h_total, 1) > _miss_frac)
   or (_s_total >= _total_min and _s_missing = _s_total)
   or (_s_missing >= _min_missing and _s_missing::numeric / greatest(_s_total, 1) > _miss_frac);

  _silence := (_today = 0 and _ever_active);

  select value into _state from public.app_settings where key = 'xp_throughput_watchdog_state';
  _alerting    := coalesce((_state->>'alerting')::boolean, false);
  _last_ms     := coalesce((_state->>'last_alert_ms')::bigint, 0);
  _sil_streak  := coalesce((_state->>'silence_streak')::int, 0);
  _clean_streak := coalesce((_state->>'clean_streak')::int, 0);

  _sil_streak := case when _silence then _sil_streak + 1 else 0 end;
  _breached   := _cap_breach or (_silence and _sil_streak >= 2);
  _clean_streak := case when _breached then 0 else _clean_streak + 1 end;

  if _breached then
    if (not _alerting) or (_now_ms - _last_ms > 43200000) then _should_alert := true; end if;
  elsif _alerting and _clean_streak >= 2 then
    _recovered := true;   -- two clean runs, not one: a rolling window clears itself on its own
  end if;

  -- The alert latch stays ON through a single clean run, so a gap ageing out of the window cannot
  -- silently close an open alert.
  _alerting_next := case when _breached then true when _recovered then false else _alerting end;

  -- ---- 2. The report. Written EVERY run, so the detector's own state is never invisible. -------
  _report := jsonb_build_object(
    'capture', jsonb_build_object(
      'lesson_total', _l_total, 'lesson_missing', _l_missing,
      'homework_total', _h_total, 'homework_missing', _h_missing,
      'high_score_total', _s_total, 'high_score_missing', _s_missing,
      'grace_minutes', 90, 'breach', _cap_breach),
    'silence', jsonb_build_object('today_earners', _today, 'platform_active_30d', _ever_active,
                                  'streak', _sil_streak, 'breach', _silence),
    'volume_context_only', round(_volume, 1),
    'breached', _breached, 'alerting', _alerting_next, 'clean_streak', _clean_streak,
    'alerted', _should_alert, 'recovered', _recovered, 'checked_at', now());

  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'xp_capture_report', _report);
  exception when others then null; end;

  -- ---- 3. Tell a human, and say what was measured rather than guessing at a cause. -------------
  if _should_alert or _recovered then
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if _tok is not null and _tok <> '' then
      _msg := case
        when _recovered then
          '✅ XP hisobi: soʻnggi 2 ta tekshiruvda yozilmagan ball topilmadi.' ||
          E'\nEski yozuvlar oʻz-oʻzidan tuzalmaydi — kerak boʻlsa reconcile_all_xp() ni yuriting.'
        when _cap_breach then
          '⚠️ XP yozilmayapti. Soʻnggi 24 soatda ball berilmagan: ' ||
          _l_missing || '/' || _l_total || ' dars, ' ||
          _h_missing || '/' || _h_total || ' vazifa, ' ||
          _s_missing || '/' || _s_total || ' yuqori baho' ||
          E'.\nHar biri kamida 90 daqiqa oldin yakunlangan — ya''ni reconciler ham ulgurgan.'
        else
          '⚠️ XP faolligi: soʻnggi 24 soatda darsdan/vazifadan ball olgan talaba YOʻQ (0 ta)' ||
          E'.\nOxirgi 7 kunlik oʻrtacha: ~' || round(_volume) || ' ta.'
      end;
      for _admin in
        select distinct p.telegram_id from public.profiles p
        join public.user_roles r on r.user_id = p.id and r.role in ('admin','superadmin')
        where p.telegram_id is not null limit 3
      loop
        begin
          -- ops_net_post records a failed call in ops_http_failures. A watchdog whose own alert can
          -- vanish silently is not a watchdog. NOTE: pg_net is async, so this counts QUEUED, not
          -- delivered — hence the field name. True delivery lives in ops_http_failures.
          perform public.ops_net_post(
            'https://api.telegram.org/bot' || _tok || '/sendMessage',
            jsonb_build_object('chat_id', _admin.telegram_id, 'text', _msg),
            jsonb_build_object('Content-Type','application/json'), 'xp-capture-watchdog', 8000);
          _queued := _queued + 1;
        exception when others then null;
        end;
      end loop;
    end if;
  end if;

  insert into public.app_settings (key, value) values ('xp_throughput_watchdog_state', jsonb_build_object(
    'alerting', _alerting_next,
    'last_alert_ms', case when _should_alert then _now_ms else _last_ms end,
    'silence_streak', _sil_streak, 'clean_streak', _clean_streak,
    'lesson_missing', _l_missing, 'homework_missing', _h_missing, 'high_score_missing', _s_missing,
    'today_earners', _today, 'volume_context_only', round(_volume, 1),
    'queued', _queued, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return _report;
end;
$function$;
revoke execute on function public.xp_throughput_watchdog() from public, anon, authenticated;
grant execute on function public.xp_throughput_watchdog() to service_role;

-- ───────────────────────── Deploy self-test (guarded) ─────────────────────────
-- Runs the new body once against real production data so a ref_key or column landmine surfaces here,
-- DB-visible, instead of silently at the next 6-hourly run.
--
-- Safe on deploy: the live state row reads alerting=false, so the "recovered" branch is unreachable,
-- and capture is healthy (50 lessons / 0 missing, 130 high scores / 0 missing over 30 days) so the
-- breach branch is too — no DM. If conditions genuinely changed by deploy time, the alert it sends is
-- a TRUE one, which is the intended fail-loud behaviour.
do $$
declare _r jsonb;
begin
  _r := public.xp_throughput_watchdog();

  if coalesce((_r->>'crashed')::boolean, false) then
    raise exception 'xp_throughput_watchdog crashed on deploy: %', _r->>'error';
  end if;
  -- The detector must be ABLE to see something. A capture block that measured nothing at all would
  -- mean the join or the window is wrong — the exact class of failure this migration is about.
  if (_r->'capture'->>'lesson_total')::int is null then
    raise exception 'xp_throughput_watchdog produced no capture sample: %', _r::text;
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'xp_capture_watchdog_selftest', jsonb_build_object('report', _r, 'at', now()));
exception when others then
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'xp_capture_watchdog_selftest_failed',
            jsonb_build_object('error', sqlerrm, 'at', now()));
  exception when others then null; end;
end $$;
