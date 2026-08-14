-- Activate the teacher engagement nudge — schedule the cron that was never wired.
--
-- The `cron-teacher-engagement-nudge` edge function has been deployed since 2026-07-08 (Phase 3) but
-- has NO cron invoking it, so its two teacher DMs have never fired (notifications_log teacher_waiting =
-- 0 all-time). This closes the loop on the questions students now earn XP for asking:
--   * "N ta talaba javob kutmoqda" — a directed student question unanswered >= 8h (teacher_nudge_signals)
--   * "you've gone quiet" — no teacher activity >= 24h AND homework waiting
-- The function self-guards: quiet hours 22:00-08:00 Tashkent, per-type cooldowns (8h waiting / 47h
-- offline) via notifications_log, at most ONE DM per teacher per run, and respects notifications_enabled.
-- So an hourly schedule only ever sends when genuinely useful (mirrors ungraded-homework-reminder-hourly
-- and detect_and_nudge, which run hourly against the same self-guarding pattern). Kill-switch: unschedule
-- this job, or a teacher toggles notifications_enabled.
--
-- Uses public.ops_net_post(..., 'teacher-engagement-nudge', 30000) — the attributed wrapper (parity with
-- the teacher-daily-digest cron) so a failed invocation is captured by ops_http_failure_watchdog, and a
-- 30s timeout accommodates the function's per-teacher sequential sendMessage loop (raw net.http_post's
-- 5s default would emit spurious timeout rows).

do $$
begin
  begin
    if exists (select 1 from cron.job where jobname = 'teacher-engagement-nudge-hourly') then
      perform cron.unschedule('teacher-engagement-nudge-hourly');
    end if;
    perform cron.schedule(
      'teacher-engagement-nudge-hourly',
      '0 * * * *',
      $cmd$
        select public.ops_net_post(
          'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/cron-teacher-engagement-nudge',
          '{}'::jsonb,
          jsonb_build_object(
            'Content-Type', 'application/json',
            'apikey', public.cron_service_key(),
            'Authorization', 'Bearer ' || public.cron_service_key(),
            'x-internal-secret', public.internal_fn_secret()),
          'teacher-engagement-nudge',
          30000)
      $cmd$);
  exception when others then
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'teacher_nudge_cron_failed', jsonb_build_object('error', sqlerrm, 'at', now()));
    exception when others then null; end;
  end;
end $$;
