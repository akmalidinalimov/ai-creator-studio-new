-- grade-card-reconcile (#154): ONE migration so the backfill provably runs BEFORE the cron is scheduled.
-- (Two separate migrations risked a */30 tick firing the reconciler in the gap after the schedule applied
--  but before the backfill closed the "every pre-existing row reads NULL" window → a burst of duplicate
--  cards. Ordering them in a single file removes that race entirely — Supabase applies one file as one
--  implicit transaction, so STEP 1 commits before STEP 2's cron can ever tick.)
--
-- STEP 1 — one-time backfill. grade_card_notified_attempt (20260903100000) is new, so EVERY pre-existing
-- scored row reads NULL — including BOT-graded rows already DM'd in real time (the bot only began stamping
-- the column in the accompanying webhook change). Without this the reconciler's first run would re-DM every
-- recently-bot-graded student a DUPLICATE card. Fix: mark as notified every scored row in the reconciler's
-- 14-day window that was scored BEFORE the last healthy grade-card delivery, leaving NULL only the
-- silence-era rows scored after delivery broke (the ~20 the reconciler should heal). Bounded to 14 days +
-- still-NULL rows (row-level locks only, no rewrite); the SET value is deterministic (attempt_number).
--
-- The cutoff is a FROZEN LITERAL, not the live heartbeat. Reading app_settings.grade_card_dm_heartbeat at
-- run time would be unsafe: that value drifts forward with every successful send anywhere on the platform
-- (bot, notify-grade-voice, and this migration's own cron once scheduled). Under the deploy-concurrency
-- "a migration's SQL can execute >1x" quirk (ledger written after the SQL; a re-run of a failed job replays
-- this file), a later re-evaluation would compare against a much-later cutoff and sweep the still-unhealed
-- silence-era rows into "notified" WITHOUT sending — silently reopening the exact gap this feature closes,
-- invisibly to the heartbeat watchdog. The literal below is the heartbeat's last_sent_at at authoring time
-- (the last healthy delivery before the silence), verified on prod to yield the split the reconciler was
-- validated against (~86 pre-silence rows marked, ~20 silence-era rows left NULL to heal). Because it is a
-- constant, every replay evaluates the identical predicate and only ever touches the same still-NULL rows
-- (a no-op after the first run) — never the healable set (scored at/after the cutoff).
--
-- Precision note (accepted): a global-cutoff backfill can't tell a row whose OWN card failed before some
-- later unrelated success from a genuinely-delivered one. Verified on prod this window: 0 grade_card_dm_failed
-- rows exist (nothing to mis-mark), and failed sends (telegram_send_failed) carry no submission id, so no
-- per-row exclusion can be built. Practical risk nil; the reconciler's < attempt_number path heals any
-- future regrade miss regardless.
update public.homework_submissions hs
   set grade_card_notified_attempt = hs.attempt_number
 where hs.score is not null
   and hs.grade_card_notified_attempt is null
   and hs.scored_at > now() - interval '14 days'
   and hs.scored_at < '2026-09-01T03:29:19.154+00'::timestamptz;

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
