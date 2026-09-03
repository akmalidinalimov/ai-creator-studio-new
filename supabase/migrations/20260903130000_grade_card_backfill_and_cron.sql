-- grade-card-reconcile (#154): ONE migration so the backfill provably runs BEFORE the cron is scheduled.
-- (Two separate migrations risked a */30 tick firing the reconciler in the gap after the schedule applied
--  but before the backfill closed the "every pre-existing row reads NULL" window → a burst of duplicate
--  cards. Ordering them in a single file removes that race entirely.)
--
-- STEP 1 — one-time backfill. grade_card_notified_attempt (20260903100000) is new, so EVERY pre-existing
-- scored row reads NULL — including BOT-graded rows already DM'd in real time (the bot only began stamping
-- the column in the accompanying webhook change). Without this the reconciler's first run would re-DM every
-- recently-bot-graded student a DUPLICATE card. Fix: mark as notified every scored row in the 14-day window
-- that was scored BEFORE the last successful grade-card delivery (app_settings.grade_card_dm_heartbeat) —
-- the period when delivery was healthy — leaving NULL only the app-silent rows scored AFTER the silence
-- began (the ~20 the reconciler should heal). No heartbeat → the coalesce makes the predicate empty (mark
-- nothing) rather than mass-marking. Bounded to 14 days + still-NULL rows (row-level locks only, no rewrite);
-- idempotent (re-run touches only still-NULL rows; the SET value is deterministic).
--
-- Precision note (accepted): the heartbeat cutoff is a global "some send succeeded after this" proxy, not a
-- per-row delivery fact — a row whose OWN card failed but was scored before a later unrelated success would
-- be marked delivered. Verified on prod this window: 0 grade_card_dm_failed rows exist (nothing to
-- mis-mark), and failed sends (telegram_send_failed) carry no submission id, so no per-row exclusion can be
-- built. Practical risk nil; the reconciler's < attempt_number path still heals any future regrade miss.
update public.homework_submissions hs
   set grade_card_notified_attempt = hs.attempt_number
 where hs.score is not null
   and hs.grade_card_notified_attempt is null
   and hs.scored_at > now() - interval '14 days'
   and hs.scored_at < coalesce(
         (select (value->>'last_sent_at')::timestamptz from public.app_settings where key = 'grade_card_dm_heartbeat'),
         now() - interval '14 days'
       );

-- STEP 2 — schedule grade-card-reconcile every 30 min (runs strictly after STEP 1 committed above). It heals
-- students graded but never DM'd their grade card and catches any future transient/regrade miss — the
-- "reconciler re-derives from source-of-truth" leg behind the instant notify-grade-voice path. Internal:
-- x-internal-secret gated; invoked via ops_net_post so any failure is named in ops_http_failures. p_timeout
-- 30s (it loops sendMessage over up to 60 submissions/run). Idempotent (unschedule + reschedule),
-- exception-guarded so a scheduling error never aborts the migration (the backfill above is already committed).
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
