-- Reconciler v3: cycle-aware ONLY dedupe + reopen-or-insert (2026-07-11 late).
-- Student report (@the_irda): 8 resubmission cycles never notified the teacher. Root causes:
--   1. URL-based dedupe treated an OLD queue row (same post URL — append/RPC resubmit cycles
--      keep it) as proof of notification for the NEW cycle. Now the ONLY evidence that a cycle
--      was notified is a queue row created at/after this cycle's submitted_at.
--   2. The unique (submission, teacher, message_url) index forbids inserting a second row for a
--      same-URL cycle — those rows are RE-OPENED (sent_at cleared, rescheduled) instead; new-URL
--      cycles are inserted. The minute drainer redelivers either way.
-- A one-off 14-day backfill was run alongside this migration: 12 buried notifications queued
-- (5 within 48h + 7 older), all delivering at the next 08:00 Tashkent flush.
CREATE OR REPLACE FUNCTION public.reconcile_teacher_dm_queue()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  _n1 int := 0; _n2 int := 0;
  _tash timestamptz := now() + interval '5 hours';
  _hour int := extract(hour from _tash)::int;
  _sched timestamptz;
begin
  if _hour >= 22 then _sched := date_trunc('day', _tash) + interval '1 day' + interval '8 hours' - interval '5 hours';
  elsif _hour < 8 then _sched := date_trunc('day', _tash) + interval '8 hours' - interval '5 hours';
  else _sched := now(); end if;

  -- CYCLE RULE: a submission cycle counts as notified only if a queue row was created at/after
  -- this cycle's submitted_at. URL match is NOT sufficient (append/RPC resubmit cycles keep the
  -- old URL — that blindness hid 8 of one student's resubmissions).

  -- Pass 1: RE-OPEN the existing row when the same (submission, teacher, url) row exists but
  -- predates the cycle (unique index forbids a duplicate insert). The drainer redelivers it.
  update homework_teacher_dm_queue q set
    sent_at = null, error = null, retry_count = 0,
    scheduled_for = _sched, queued_for_quiet_hours = (_hour >= 22 or _hour < 8),
    created_at = now(),
    assignment_title = case when q.assignment_title like '%(tiklandi)%' then q.assignment_title
                            else q.assignment_title || ' (tiklandi)' end
  from homework_submissions hs
  join profiles p on p.id = hs.user_id
  join groups g on g.id = p.group_id and g.teacher_id is not null
  where q.submission_id = hs.id and q.teacher_id = g.teacher_id
    and q.message_url = hs.telegram_message_url
    and hs.source = 'telegram_topic'
    and (hs.score is null or hs.score_is_stale)
    and hs.submitted_at > now() - interval '48 hours'
    and hs.submitted_at < now() - interval '10 minutes'
    and not exists (select 1 from homework_teacher_dm_queue q2
                     where q2.submission_id = hs.id and q2.created_at >= hs.submitted_at - interval '2 minutes');
  get diagnostics _n1 = row_count;

  -- Pass 2: INSERT for cycles whose URL is new (no matching row exists).
  insert into homework_teacher_dm_queue
    (submission_id, teacher_id, student_id, group_id, module_id, assignment_id,
     module_number, task_number, assignment_title, student_name, message_url,
     scheduled_for, queued_for_quiet_hours)
  select hs.id, g.teacher_id, hs.user_id, g.id, a.module_id, a.id,
         m.position + 1, coalesce(a.task_number, 1),
         a.title || ' (tiklandi)',
         (coalesce(nullif(trim(coalesce(p.name,'') || ' ' || coalesce(p.last_name,'')), ''), '—')
           || case when coalesce(p.telegram_username,'') <> '' then ' (@' || replace(p.telegram_username,'@','') || ')' else '' end),
         hs.telegram_message_url,
         _sched, (_hour >= 22 or _hour < 8)
  from homework_submissions hs
  join profiles p on p.id = hs.user_id
  join groups g on g.id = p.group_id and g.teacher_id is not null
  join homework_assignments a on a.id = hs.assignment_id
  join modules m on m.id = a.module_id
  where hs.source = 'telegram_topic'
    and hs.telegram_message_url is not null
    and (hs.score is null or hs.score_is_stale)
    and hs.submitted_at > now() - interval '48 hours'
    and hs.submitted_at < now() - interval '10 minutes'
    and not exists (select 1 from homework_teacher_dm_queue q2
                     where q2.submission_id = hs.id and q2.created_at >= hs.submitted_at - interval '2 minutes')
    and not exists (select 1 from homework_teacher_dm_queue q3
                     where q3.submission_id = hs.id and q3.teacher_id = g.teacher_id and q3.message_url = hs.telegram_message_url)
  on conflict do nothing;
  get diagnostics _n2 = row_count;

  if (_n1 + _n2) > 0 then raise log 'reconcile_teacher_dm_queue: reopened %, inserted %', _n1, _n2; end if;
  return _n1 + _n2;
end;
$function$
;
revoke execute on function public.reconcile_teacher_dm_queue() from public, anon, authenticated;
