-- XP-award integrity watchdog (owner's core ask): monitor EVERY point awarded, verify it was given
-- correctly, and confirm "all correct" when there is no error. DETECT-ONLY — it never changes points.
--
-- Design lesson from the data: a naive "award with no current source row = orphan" check flags ~2,800
-- HISTORICAL awards that are actually legitimate — backfilled teacher XP that never had a celebration
-- row, homework whose source moved on a retag, lessons from purged courses, or a submission that is
-- mid-resubmission (score/scored_by nulled while awaiting regrade — the XP was earned at grade time).
-- Alarming on those would be pure noise. What is genuinely meaningful:
--   * HARD signals (any occurrence = real ledger corruption): a wrong fixed amount, or user_xp.total_xp
--     not equal to the ledger sum. (Both are currently 0.)
--   * RECENT awards (last 14 days) with no live source AND not in a legitimate pending-regrade /
--     un-labeled state — a NEW mis-award (the watch-gate class). (~8 now, all normal churn.)
-- The all-time source-existence breakdown is computed for transparency but does NOT drive alarms.
-- Intentionally-un-labeled lesson awards (unlabeled_completions_log) and pending-regrade homework are
-- grandfathered out of the alarm math.
--
-- Robustness: the detection block is wrapped so a malformed ref_key cast can never SILENTLY kill the
-- daily run (it would surface a DB-visible 'xp_integrity_watchdog_crashed' row instead), and the
-- migration self-tests the function once at deploy so any landmine in real prod data surfaces now, not
-- at 04:50 UTC tomorrow. Modeled on enrollment_watchdog / homework_attribution_watchdog.

create or replace function public.xp_award_integrity_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _h_lesson int; _h_hw_submit int; _h_hw_score int; _h_daily int; _h_tgrade int; _h_timpact int;
  _r_lesson int; _r_hw_submit int; _r_hw_score int; _r_daily int; _r_tgrade int; _r_timpact int; _recent int;
  _amount_mismatch int; _drift int; _total_events bigint; _grandfathered int;
  _report jsonb; _tok text; _admin record; _msg text;
  _state jsonb; _alerting boolean; _last_ms bigint; _alarm boolean;
  _now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  _should_alert boolean := false; _recovered boolean := false;
  _recent_threshold int := 15;
  _since timestamptz := now() - interval '14 days';
begin
  -- ---- DETECTION (guarded: a bad ref_key cast surfaces a crash row, never a silent daily failure) ----
  begin
    select count(*) into _total_events from public.xp_events;
    select count(*) into _grandfathered from public.unlabeled_completions_log;

    -- lesson_complete: no completed lesson AND not grandfathered (intentionally un-labeled).
    select count(*) into _h_lesson from public.xp_events e where e.reason='lesson_complete'
      and not exists (select 1 from public.lesson_progress lp where lp.user_id=e.user_id
          and lp.lesson_id=nullif(split_part(e.ref_key,':',2),'')::uuid and lp.completed_at is not null)
      and not exists (select 1 from public.unlabeled_completions_log g where g.user_id=e.user_id
          and g.lesson_id=nullif(split_part(e.ref_key,':',2),'')::uuid);
    select count(*) into _r_lesson from public.xp_events e where e.reason='lesson_complete' and e.created_at > _since
      and not exists (select 1 from public.lesson_progress lp where lp.user_id=e.user_id
          and lp.lesson_id=nullif(split_part(e.ref_key,':',2),'')::uuid and lp.completed_at is not null)
      and not exists (select 1 from public.unlabeled_completions_log g where g.user_id=e.user_id
          and g.lesson_id=nullif(split_part(e.ref_key,':',2),'')::uuid);

    select count(*) into _h_hw_submit from public.xp_events e where e.reason='homework_submit'
      and not exists (select 1 from public.homework_submissions hs where hs.user_id=e.user_id and hs.assignment_id=nullif(split_part(e.ref_key,':',2),'')::uuid);
    select count(*) into _r_hw_submit from public.xp_events e where e.reason='homework_submit' and e.created_at > _since
      and not exists (select 1 from public.homework_submissions hs where hs.user_id=e.user_id and hs.assignment_id=nullif(split_part(e.ref_key,':',2),'')::uuid);

    -- homework_high_score: current score>=9 OR a legitimate pending-regrade (score nulled but was >=9).
    select count(*) into _h_hw_score from public.xp_events e where e.reason='homework_high_score'
      and not exists (select 1 from public.homework_submissions hs where hs.user_id=e.user_id and hs.assignment_id=nullif(split_part(e.ref_key,':',2),'')::uuid
          and (hs.score>=9 or coalesce(hs.score_is_stale,false) or coalesce(hs.previous_score,0)>=9));
    select count(*) into _r_hw_score from public.xp_events e where e.reason='homework_high_score' and e.created_at > _since
      and not exists (select 1 from public.homework_submissions hs where hs.user_id=e.user_id and hs.assignment_id=nullif(split_part(e.ref_key,':',2),'')::uuid
          and (hs.score>=9 or coalesce(hs.score_is_stale,false) or coalesce(hs.previous_score,0)>=9));

    select count(*) into _h_daily from public.xp_events e where e.reason='daily_active'
      and not exists (select 1 from public.daily_watch_summary d where d.user_id=e.user_id and d.watch_date=nullif(split_part(e.ref_key,':',2),'')::date);
    select count(*) into _r_daily from public.xp_events e where e.reason='daily_active' and e.created_at > _since
      and not exists (select 1 from public.daily_watch_summary d where d.user_id=e.user_id and d.watch_date=nullif(split_part(e.ref_key,':',2),'')::date);

    -- teacher_grade: currently graded by this teacher OR a legitimate pending-regrade (was graded).
    select count(*) into _h_tgrade from public.xp_events e where e.reason='teacher_grade'
      and not exists (select 1 from public.homework_submissions hs where hs.id=nullif(split_part(e.ref_key,':',2),'')::uuid
          and ((hs.score is not null and hs.scored_by=e.user_id) or coalesce(hs.score_is_stale,false) or hs.previous_score is not null));
    select count(*) into _r_tgrade from public.xp_events e where e.reason='teacher_grade' and e.created_at > _since
      and not exists (select 1 from public.homework_submissions hs where hs.id=nullif(split_part(e.ref_key,':',2),'')::uuid
          and ((hs.score is not null and hs.scored_by=e.user_id) or coalesce(hs.score_is_stale,false) or hs.previous_score is not null));

    select count(*) into _h_timpact from public.xp_events e where e.reason='teacher_impact'
      and not exists (select 1 from public.nudge_module_celebrations n where n.profile_id=nullif(split_part(e.ref_key,':',3),'')::uuid and n.module_id=nullif(split_part(e.ref_key,':',4),'')::uuid);
    select count(*) into _r_timpact from public.xp_events e where e.reason='teacher_impact' and e.created_at > _since
      and not exists (select 1 from public.nudge_module_celebrations n where n.profile_id=nullif(split_part(e.ref_key,':',3),'')::uuid and n.module_id=nullif(split_part(e.ref_key,':',4),'')::uuid);

    -- HARD checks over the WHOLE ledger.
    select count(*) into _amount_mismatch from public.xp_events e
    where e.reason in ('lesson_complete','homework_submit','homework_high_score','daily_active','streak_7','streak_30',
                       'teacher_grade','teacher_grade_ontime','teacher_active_day','teacher_impact','teacher_answer','teacher_queue_clear')
      and e.amount <> case e.reason
        when 'lesson_complete' then 20 when 'homework_submit' then 15 when 'homework_high_score' then 25
        when 'daily_active' then 5 when 'streak_7' then 50 when 'streak_30' then 200
        when 'teacher_grade' then 10 when 'teacher_grade_ontime' then 15 when 'teacher_active_day' then 5
        when 'teacher_impact' then 25 when 'teacher_answer' then 8 when 'teacher_queue_clear' then 20 end;

    select count(*) into _drift from public.user_xp x
    where x.total_xp <> coalesce((select sum(amount) from public.xp_events e where e.user_id=x.user_id), 0);
  exception when others then
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'xp_integrity_watchdog_crashed', jsonb_build_object('error', sqlerrm, 'at', now()));
    exception when others then null; end;
    return jsonb_build_object('crashed', true, 'error', sqlerrm, 'checked_at', now());
  end;

  _recent := _r_lesson + _r_hw_submit + _r_hw_score + _r_daily + _r_tgrade + _r_timpact;
  _alarm := (_amount_mismatch > 0) or (_drift > 0) or (_recent > _recent_threshold);

  _report := jsonb_build_object(
    'total_events', _total_events, 'grandfathered_unlabeled', _grandfathered,
    'amount_mismatch', _amount_mismatch, 'aggregate_drift', _drift,
    'recent_unjustified_14d', jsonb_build_object('total', _recent, 'lesson_complete', _r_lesson,
      'homework_submit', _r_hw_submit, 'homework_high_score', _r_hw_score, 'daily_active', _r_daily,
      'teacher_grade', _r_tgrade, 'teacher_impact', _r_timpact, 'threshold', _recent_threshold),
    'historical_source_moved', jsonb_build_object('note', 'informational only; mostly backfill/retag/purge/pending-regrade',
      'lesson_complete', _h_lesson, 'homework_submit', _h_hw_submit, 'homework_high_score', _h_hw_score,
      'daily_active', _h_daily, 'teacher_grade', _h_tgrade, 'teacher_impact', _h_timpact),
    'unverifiable_by_design', jsonb_build_array('streak_7','streak_30','teacher_answer','teacher_queue_clear','teacher_grade_ontime','teacher_active_day','community_help','community_question'),
    'alarm', _alarm, 'checked_at', now());

  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'xp_integrity_report', _report);
  exception when others then null;
  end;

  select value into _state from app_settings where key = 'xp_integrity_watchdog_state';
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  _last_ms  := coalesce((_state->>'last_alert_ms')::bigint, 0);
  if _alarm then
    if (not _alerting) or (_now_ms - _last_ms > 86400000) then _should_alert := true; end if;
  elsif _alerting then
    _recovered := true;
  end if;

  if _should_alert or _recovered then
    select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
    if _tok is not null and _tok <> '' then
      _msg := case when _recovered
        then '✅ XP butunligi normallashdi: har bir ball toʻgʻri va asosli berilgan.'
        else '⚠️ XP butunligi: ' ||
             case when _drift > 0 then _drift || ' ta foydalanuvchi jamlanmasi nomuvofiq; ' else '' end ||
             case when _amount_mismatch > 0 then _amount_mismatch || ' ta notoʻgʻri miqdor; ' else '' end ||
             case when _recent > _recent_threshold then _recent || ' ta oxirgi ball asossiz; ' else '' end ||
             'admin_actions dagi "xp_integrity_report" ni koʻring.'
      end;
      for _admin in
        select distinct p.telegram_id from profiles p
        join user_roles r on r.user_id = p.id and r.role in ('admin','superadmin')
        where p.telegram_id is not null limit 3
      loop
        begin
          perform net.http_post(url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            headers := jsonb_build_object('Content-Type','application/json'),
            body := jsonb_build_object('chat_id', _admin.telegram_id, 'text', _msg));
        exception when others then null;
        end;
      end loop;
    end if;
  end if;

  insert into app_settings (key, value) values ('xp_integrity_watchdog_state', jsonb_build_object(
    'alerting', _alarm, 'last_alert_ms', case when _should_alert then _now_ms else _last_ms end,
    'recent_unjustified', _recent, 'amount_mismatch', _amount_mismatch, 'drift', _drift, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return _report;
end;
$function$;

revoke execute on function public.xp_award_integrity_watchdog() from public, anon, authenticated;
grant execute on function public.xp_award_integrity_watchdog() to service_role;

-- Deploy-time self-test: run once now so any ref_key landmine in real prod data surfaces at deploy
-- (DB-visible), not silently at the first 04:50 cron run. Seeds the baseline state; no alert on a clean
-- ledger (alarm is false at ~8 recent orphans < 15, amount_mismatch 0, drift 0).
do $$
begin
  perform public.xp_award_integrity_watchdog();
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'xp_integrity_watchdog_selftest_failed', jsonb_build_object('error', sqlerrm));
end $$;

-- Daily at 04:50 UTC, after verify-student-stats-integrity (04:40). Idempotent; failure surfaced durably.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'xp-award-integrity-watchdog') then
    perform cron.unschedule('xp-award-integrity-watchdog');
  end if;
  perform cron.schedule('xp-award-integrity-watchdog', '50 4 * * *', 'select public.xp_award_integrity_watchdog()');
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_schedule_failed', jsonb_build_object('job', 'xp-award-integrity-watchdog', 'error', sqlerrm));
end $$;
