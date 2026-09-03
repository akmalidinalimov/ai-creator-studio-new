-- Schedule grade-card-reconcile (the P0 backstop, #153 follow-up) every 30 min. It heals students who
-- were graded but never DM'd their grade card (the ~18 at detection) and catches any future transient
-- miss — the "reconciler re-derives from source-of-truth" leg behind the instant notify-grade-voice path.
-- Internal: x-internal-secret gated; invoked via ops_net_post so any failure is named in ops_http_failures.
-- p_timeout_ms 30s (it loops sendMessage over up to 60 submissions/run, beyond pg_net's 5s default).
-- Idempotent (unschedule + reschedule), exception-guarded so a scheduling error never aborts the migration.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'grade-card-reconcile') then
    perform cron.unschedule('grade-card-reconcile');
  end if;
  perform cron.schedule('grade-card-reconcile', '*/30 * * * *', $cmd$
    select public.ops_net_post(
      'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/grade-card-reconcile',
      '{}'::jsonb,
      jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', public.cron_service_key(),
        'Authorization', 'Bearer ' || public.cron_service_key(),
        'x-internal-secret', public.internal_fn_secret()),
      'grade-card-reconcile', 30000)
  $cmd$);
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_schedule_failed', jsonb_build_object('job', 'grade-card-reconcile', 'error', sqlerrm));
end $$;
