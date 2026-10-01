-- engagement_targeting: turn ON the three RECOMMENDED owner options from the #228 watch-button audit.
-- (Re-issue of the reserved slot 20260930180000, which was drafted, corrected before commit and never applied.)
--
-- ═══ WHAT ═══
-- One row, platform_settings.engagement_targeting, read (60 s cache, FAIL-CLOSED to today's behaviour: only a
-- JSON `true` enables a switch) by cron-engagement and detect-and-nudge — see
-- supabase/functions/_shared/engagement-targeting.ts. The owner flips each switch in Admin → «Faollik va
-- eslatmalar» → «🎯 Eslatmalar kimga boradi» (or with SQL); no deploy, effective within a minute.
--   skip_closed_courses           no daily reminder / streak warning / drip message (cron-engagement) and no smart
--                                 inactive nudge (detect-and-nudge) to a student who has NO published course. A
--                                 student whose group / first course is closed but who is also enrolled in a
--                                 published one is re-pointed at that course instead.
--   trial_to_course_page          a trial (account_type 'provisional') student's reminder button opens
--                                 /course/<c> — the trial card — instead of a lesson the account cannot open.
--   retire_smart_inactive_nudges  detect-and-nudge stops inactive_3d / inactive_7d; the cron-engagement drip
--                                 (day 3 / 7 / 14 / 30) and the module_complete celebration stay.
--
-- ═══ WHY — measured read-only on production, 2026-09-30 (7-day averages unless stated) ═══
--   * 572 students are eligible for reminders. 412 of them are AI CREATORS 4.0 graduates: their only course is
--     published = false (the bit RLS uses to hide lessons), no group, 1 enrollment, 0 in a published course.
--     In 30 days: 0 lesson progress, 0 homework, 0 Mini App opens; 19 lesson links into the closed 4.0 course
--     were opened by 18 of them — each one a locked page.
--   * Daily reminders to them: 2,723 in 7 days = 389 a day (410 in the last 24 h), of ~509 a day in total.
--     810 of those 2,723 (116 a day, to 124 students) were undeliverable: recipient errors (blocked, deleted,
--     never started). Streak warnings to them: 2 in 7 days; drip messages: 1.
--     → skip_closed_courses: ~390 fewer reminders a day.
--   * 7 trial students (5.0) get ~6 daily reminders a day whose button targets a lesson they cannot open (the
--     Mini App's /continue already lands them on the trial card; the magic-link fallback did not). Volume
--     unchanged; the destination becomes the course page on both paths.
--   * Smart inactive nudges: 19 inactive_3d + 10 inactive_7d in 7 days (~4 a day), all to 5.0 students. In 30
--     days 90 of 133 inactive_3d and 31 of 40 inactive_7d reached a student within 2 days of a drip day-3/7
--     message. → retire: ~4 fewer a day. module_complete (127 in 30 days, 33 clicked) is untouched.
--   Total, all automatic student reminders (daily + streak + drip + smart nudges): ~543 a day → ~149 a day.
--   Students of a published course lose only the duplicate smart nudges.
--
-- ═══ SAFETY ═══
--   * Insert-only, ON CONFLICT DO NOTHING: a value the owner already set (e.g. through the admin card, which goes
--     live with the edge/frontend deploy, before this migration) is never overwritten; a replay is a no-op.
--   * Nothing else is created or changed: no function, no grant, no cron job, no outbound HTTP.
--   * Audit once: admin_actions 'engagement_targeting_seeded' is written ONLY when this insert created the row.
--   * No new detector for the skip itself, by construction: it only drops a reminder for a student with no
--     published course, i.e. when every lesson link would open a page RLS hides. Students of published courses
--     stay covered by watch_button_watchdog's per-course coverage / silent_groups legs (which count only
--     published courses, unchanged). A switch that cannot be read keeps today's behaviour AND is loud:
--     cron-engagement records prefetch_failed 'engagement_targeting' (engagement_run_watchdog alarms on it),
--     detect-and-nudge writes admin_actions 'engagement_targeting_read_failed'. Every cron-engagement run reports
--     engagement_run_done.details.targeting {switches, closed_skipped{daily,streak,drip}, redirected,
--     trial_course_page}.
--   * Self-test: read-only — the row the senders read exists and is a JSON object.
--   * PGlite harness: supabase/functions/_testing/engagement-targeting-seed-check.ts (fresh, replay, owner value
--     kept, malformed row refused, the seeded JSON parsed by the edge reader).
--
-- KILL-SWITCH: flip a switch off in the admin card, or
--   update public.platform_settings set value = value || '{"skip_closed_courses": false}'::jsonb
--   where key = 'engagement_targeting';
-- (or delete the row: absent = every switch off = the behaviour before this change).

do $$
declare
  _n int;
begin
  insert into public.platform_settings (key, value)
  values ('engagement_targeting',
          '{"skip_closed_courses": true, "trial_to_course_page": true, "retire_smart_inactive_nudges": true}'::jsonb)
  on conflict (key) do nothing;
  get diagnostics _n = row_count;

  if _n = 1 then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'engagement_targeting_seeded', jsonb_build_object(
      'migration', '20260930180010',
      'value', (select value from public.platform_settings where key = 'engagement_targeting')));
  end if;
end $$;

-- Read-only self-test: the row the senders read exists and is a JSON object (anything else would read as
-- "every switch off" — safe, but not what this migration is for, so fail loudly instead).
do $$
begin
  if not exists (select 1 from public.platform_settings
                 where key = 'engagement_targeting' and jsonb_typeof(value) = 'object') then
    raise exception 'engagement_targeting row missing or not a JSON object after seeding';
  end if;
end $$;
