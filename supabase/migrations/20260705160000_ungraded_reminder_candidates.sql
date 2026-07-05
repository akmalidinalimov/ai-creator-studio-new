-- Fix (H): cron-ungraded-homework-reminder pulled the 500 OLDEST score-null
-- submissions and only then filtered out those that already got 3 reminders.
-- Once 500+ never-graded rows exhaust their reminders they permanently fill the
-- window and newer ungraded homework never gets a reminder. Do the anti-join in
-- SQL so exhausted rows are excluded BEFORE the limit. Cycle-aware: a resubmit
-- (new submitted_at) has no matching reminder row, so it becomes eligible again.
create or replace function public.ungraded_reminder_candidates(p_cutoff timestamptz, p_limit int)
returns setof public.homework_submissions
language sql
stable
security definer
set search_path to 'public'
as $$
  select hs.*
  from public.homework_submissions hs
  left join public.homework_ungraded_reminders r
    on r.submission_id = hs.id
   and r.cycle_submitted_at = hs.submitted_at
  where hs.score is null
    and hs.submitted_at < p_cutoff
    and coalesce(r.reminders_sent, 0) < 3
    and (r.last_reminder_at is null or r.last_reminder_at < now() - interval '24 hours')
  order by hs.submitted_at asc
  limit greatest(p_limit, 1)
$$;

revoke execute on function public.ungraded_reminder_candidates(timestamptz, int) from public, anon, authenticated;
