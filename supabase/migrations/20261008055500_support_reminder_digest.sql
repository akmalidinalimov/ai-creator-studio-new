-- Support tickets: one summary every 5 hours instead of re-sending every ticket every hour (owner, 2026-10-08: "new
-- ones arrive and after a couple of hours old ones are resubmitting — notify about handling the old ones every five
-- hours or so; it needs to be more structured").
--
-- The support-reminder edge function now sends the inbox summary (🆕 new · ⏳ older open · the oldest wait, with the
-- list buttons) — the admins open the tickets from there or from the new «🆘 Murojaatlar» admin button. A brand-new
-- ticket still reaches the admins at once (support.ts). The cron (every 10 min) already calls the function only when a
-- ticket has waited longer than every_min, so 300 here = at most one summary per ticket per 5 hours.
-- new_hours: what the inbox calls "new" (6 h). Both stay editable in platform_settings.support_reminders.

update public.platform_settings
   set value = value || jsonb_build_object('every_min', 300, 'new_hours', 6),
       updated_at = now()
 where key = 'support_reminders';
