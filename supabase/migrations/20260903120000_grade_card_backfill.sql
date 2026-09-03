-- One-time backfill for the grade-card-reconcile backstop (#154). The reconciler heals submissions whose
-- grade_card_notified_attempt IS NULL. That column is new (20260903100000), so EVERY pre-existing scored
-- row reads as NULL — including BOT-graded rows that were ALREADY DM'd in real time (the bot flow only
-- began stamping the column in the accompanying webhook change). Without this, the reconciler's first run
-- would re-DM every recently-bot-graded student a DUPLICATE card.
--
-- Fix: mark as notified every scored row in the reconciler's 14-day window that was scored BEFORE the last
-- successful grade-card delivery (app_settings.grade_card_dm_heartbeat) — the period when delivery was
-- healthy — leaving NULL only the app-silent rows scored AFTER the silence began (the ~18 the reconciler
-- should actually heal). No heartbeat → the coalesce makes the predicate empty (mark nothing) rather than
-- mass-marking. Bounded to 14 days + still-NULL rows (row-level locks only, no table rewrite); idempotent.
update public.homework_submissions hs
   set grade_card_notified_attempt = hs.attempt_number
 where hs.score is not null
   and hs.grade_card_notified_attempt is null
   and hs.scored_at > now() - interval '14 days'
   and hs.scored_at < coalesce(
         (select (value->>'last_sent_at')::timestamptz from public.app_settings where key = 'grade_card_dm_heartbeat'),
         now() - interval '14 days'
       );
