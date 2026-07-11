-- Read-only health stats for the OUT-OF-BAND morning verifier (2026-07-11).
-- Consumed by the hw-dm-health edge function -> GitHub Actions daily workflow (08:25 Tashkent).
-- The external leg exists because all in-Supabase legs (drainer/reconciler/fallback/watchdog)
-- share pg_cron + pg_net — if that infra dies, they die silently TOGETHER. GitHub asserts from
-- the outside; "endpoint unreachable" fails the workflow too, which is exactly the point.
create or replace function public.hw_dm_health_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  _unsent_overdue int;
  _drainer_age_sec int;
  _errors_24h int;
  _resurrected_24h int;
  _fallback_24h int;
begin
  select count(*) into _unsent_overdue from homework_teacher_dm_queue
   where sent_at is null and scheduled_for < now() - interval '15 minutes';

  select coalesce(extract(epoch from now() - max(r.start_time))::int, 999999) into _drainer_age_sec
  from cron.job_run_details r join cron.job j on j.jobid = r.jobid
  where j.jobname = 'notify-homework-submission-every-minute' and r.status = 'succeeded';

  select count(*) into _errors_24h from homework_teacher_dm_queue
   where error is not null
     and error not like 'teacher_no_longer%'
     and error not like 'notifications_disabled%'
     and error not like '%_e2e_test%'
     and coalesce(sent_at, created_at) > now() - interval '24 hours';

  select count(*) into _resurrected_24h from homework_teacher_dm_queue
   where assignment_title like '%(tiklandi)%' and created_at > now() - interval '24 hours';

  select count(*) into _fallback_24h from homework_teacher_dm_queue
   where error = 'sql_fallback_delivery' and sent_at > now() - interval '24 hours';

  return jsonb_build_object(
    'unsent_overdue', _unsent_overdue,
    'drainer_age_sec', _drainer_age_sec,
    'errors_24h', _errors_24h,
    'resurrected_24h', _resurrected_24h,
    'fallback_24h', _fallback_24h,
    'checked_at', now()
  );
end;
$$;
revoke execute on function public.hw_dm_health_stats() from public, anon, authenticated;
