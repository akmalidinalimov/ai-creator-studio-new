-- Grade-orphan watchdog — detects the "score set but scored_by/scored_at NULL" corruption class.
--
-- Failure class (preventive; 0 rows in prod at write time). A teacher-grade "undo" that ran
--   update homework_submissions set score=null, scored_by=null, scored_at=null  -- WITHOUT bumping attempt_number
-- is silently corrupting: homework_submissions_guard (20260509085603) protects ONLY the score column, so it
-- reverts NEW.score := OLD.score but leaves scored_by/scored_at NULL. The row ends up with a score but no
-- grader → it VANISHES from every grading queue (queues filter `score is null or score_is_stale`) AND keeps
-- its high-score XP forever (reconcile_all_xp is INSERT-ONLY on hw_score: ref-keys, never deletes). Supabase
-- returns {ok:true} so the UI thinks the undo worked. The corrupting sites were fixed in the frontend
-- (Mini App #88 TeacherGrade.tsx + TeacherProfile.tsx here) — this is the doctrine's step-5 detector that
-- fires BEFORE the next complaint if any code path ever regresses (e.g. an edge fn null-clear).
--
-- Mirrors the enrollment_watchdog count/state/daily-re-alert/recovery + admin-DM pattern
-- (20260805100000_enrollment_watchdog_drop_tiered_default_alarm.sql) and the tier_config_watchdog
-- health-signal + guarded-cron/prime structure (20260810150000_tier_config_watchdog.sql). Fully idempotent
-- (create or replace + guarded cron), safe to re-apply.

-- 1. Pure detector: how many rows are grade-orphaned right now.
create or replace function public.grade_orphan_count()
returns int
language sql
stable
security definer
set search_path = public
as $fn$
  select count(*)::int
  from public.homework_submissions
  where score is not null and scored_by is null and scored_at is null;
$fn$;
revoke execute on function public.grade_orphan_count() from public, anon, authenticated;
grant execute on function public.grade_orphan_count() to service_role;

-- 2. DB-visible health signal (per the incident doctrine — errors must be visible below the edge stack).
--    Surfaceable by the daily digest / external verifier; carries a small sample of offending ids.
create or replace function public.grade_orphan_health()
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select jsonb_build_object(
    'orphans', public.grade_orphan_count(),
    'checked_at', now(),
    'sample', (
      select coalesce(jsonb_agg(jsonb_build_object('id', id, 'user_id', user_id, 'score', score)), '[]'::jsonb)
      from (
        select id, user_id, score
        from public.homework_submissions
        where score is not null and scored_by is null and scored_at is null
        order by updated_at desc nulls last
        limit 20
      ) s
    )
  );
$fn$;
revoke execute on function public.grade_orphan_health() from public, anon, authenticated;
grant execute on function public.grade_orphan_health() to service_role;

-- 3. Watchdog: DM admins while orphans exist (daily re-alert), send a recovery note when it clears.
--    State + dedup in app_settings, exactly like enrollment_watchdog.
create or replace function public.grade_orphan_watchdog()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  _tok text; _admin record; _n int; _sent int := 0;
  _state jsonb; _alerting boolean; _last_ms bigint;
  _now_ms bigint := (extract(epoch from now())*1000)::bigint;
  _should_alert boolean := false; _recovered boolean := false; _msg text;
begin
  _n := public.grade_orphan_count();

  select value into _state from app_settings where key = 'grade_orphan_watchdog_state';
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  _last_ms  := coalesce((_state->>'last_alert_ms')::bigint, 0);

  if _n > 0 then
    if (not _alerting) or (_now_ms - _last_ms > 86400000) then _should_alert := true; end if;  -- daily re-alert
  elsif _alerting then _recovered := true; end if;

  if _should_alert or _recovered then
    select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
    if _tok is not null and _tok <> '' then
      _msg := case
        when _recovered then '✅ Baholar "yetim" holatidan chiqdi (0 ta orphan).'
        else '🚨 ' || _n || ' ta baho "yetim" (score bor, lekin scored_by/scored_at NULL). Bu satrlar '
             || 'hech qaysi baholash navbatida ko''rinmaydi va XP''ni ushlab qoladi. Sabab: attempt_number '
             || 'oshirmasdan score→null qilingan undo. Tekshiring: homework_submissions.'
      end;
      for _admin in
        select distinct p.telegram_id from profiles p
        join user_roles r on r.user_id = p.id and r.role in ('admin','superadmin')
        where p.telegram_id is not null limit 3
      loop
        begin
          perform net.http_post(
            url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            headers := jsonb_build_object('Content-Type','application/json'),
            body := jsonb_build_object('chat_id', _admin.telegram_id, 'text', _msg));
          _sent := _sent + 1;
        exception when others then null;
        end;
      end loop;
    end if;

    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'grade_orphan_watchdog_alert',
              jsonb_build_object('n', _n, 'sent', _sent, 'recovered', _recovered, 'at', now()));
    exception when others then null; end;
  end if;

  insert into app_settings (key, value) values ('grade_orphan_watchdog_state', jsonb_build_object(
    'alerting', (_n > 0), 'last_alert_ms', case when _should_alert then _now_ms else _last_ms end,
    'orphans', _n, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('orphans', _n, 'alerted', _should_alert, 'recovered', _recovered, 'sent', _sent);
end;
$fn$;
revoke execute on function public.grade_orphan_watchdog() from public, anon, authenticated;
grant execute on function public.grade_orphan_watchdog() to service_role;

-- 4. Schedule daily (06:20 UTC, offset from the enrollment 05:50 / tier-config watchdogs). The whole block
--    is guarded so a cron/prime failure can never roll back the function definitions above, and any failure
--    is recorded in admin_actions (do-blocks otherwise swallow errors — teacher-engagement-nudge lesson).
do $$
begin
  begin
    if exists (select 1 from cron.job where jobname = 'grade-orphan-watchdog') then
      perform cron.unschedule('grade-orphan-watchdog');
    end if;
    perform cron.schedule('grade-orphan-watchdog', '20 6 * * *', $cmd$ select public.grade_orphan_watchdog() $cmd$);
  exception when others then
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'grade_orphan_cron_failed', jsonb_build_object('error', sqlerrm, 'at', now()));
    exception when others then null; end;
  end;

  -- Prime once (silent on the current clean 0-orphan state; establishes the state row).
  begin
    perform public.grade_orphan_watchdog();
  exception when others then
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'grade_orphan_watchdog_prime_failed', jsonb_build_object('error', sqlerrm, 'at', now()));
    exception when others then null; end;
  end;
end $$;
