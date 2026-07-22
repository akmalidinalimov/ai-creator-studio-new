-- Heal history for the emoji-name badge bug (2026-07-22). notify-badge-award now sanitizes the
-- student name before the Cloudinary text overlay (emoji/flags/symbols made the generated image
-- error out → Telegram "failed to get HTTP URL content" → the card never reached the student).
-- This re-queues the cards that failed with that Cloudinary-fetch error so they re-send with the
-- fixed image. One-time, ledgered — applies exactly once.
--
-- scheduled_for RESPECTS QUIET HOURS: the every-minute drainer does no time check at send time, so
-- the queue_badge_dm() trigger's 22:00–08:00 Tashkent guard is the only thing keeping badge DMs out
-- of the night — and a raw UPDATE bypasses it. We mirror that guard here (the autonomous-ops pipeline
-- can merge at any hour, incl. from-phone) so a night-time merge never pings 45 students at 3 AM. In
-- daytime we push +15 min purely as an extra safety margin (edge functions deploy before migrations
-- apply in the same pipeline job, so the fixed code is already live).
--
-- Note: cards that failed BEFORE the delivery-reliability fix (PR #36) were silently stamped "sent"
-- with no error, so they're indistinguishable from real sends and can't be healed here — the badge
-- itself is still on the student's profile, only the celebratory DM was missed. We deliberately do
-- NOT mass-re-send historical badges (that would spam students with stale "new achievement!" pings).
do $$
declare
  _n int;
  _h int := extract(hour from now() at time zone 'Asia/Tashkent')::int;
  _today date := (now() at time zone 'Asia/Tashkent')::date;
  _sched timestamptz;
begin
  if _h >= 22 then
    _sched := ((_today + 1) + time '08:00') at time zone 'Asia/Tashkent';
  elsif _h < 8 then
    _sched := (_today + time '08:00') at time zone 'Asia/Tashkent';
  else
    _sched := now() + interval '15 minutes';
  end if;

  with requeued as (
    update public.badge_award_queue
       set sent_at = null, error = null, attempts = 0, last_attempt_at = null, scheduled_for = _sched
     where sent_at is not null
       and error ilike '%failed to get%url content%'   -- Cloudinary-fetch failure (case/variant tolerant)
     returning 1
  )
  select count(*) into _n from requeued;

  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'badge_name_sanitize_backfill', jsonb_build_object('requeued', _n, 'scheduled_for', _sched, 'at', now()));
  exception when others then null;  -- audit is best-effort; never fail the backfill on a logging error
  end;
end $$;
