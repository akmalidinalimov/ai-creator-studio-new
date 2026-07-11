-- Homework pipeline hardening — adversarial-review batch (2026-07-11).
-- Companion to the webhook/cron code fixes in the same commit. Items:
--   MED-3  both SQL backstops used score-is-null only, excluding stale-scored resubmissions
--          (the web/legacy resubmit mechanism keeps the score with score_is_stale=true) — the
--          bot's own pending rule is (score is null OR score_is_stale). Aligned here.
--   LOW-2  admin_retag_submission's merge deleted the source submission but left unsent
--          teacher-DM queue rows pointing at it → dead 🎯 buttons. Retarget them to the survivor.
--   W3/W4  detection for the two remaining silent-loss classes: an uncaptured media post
--          (webhook crashed mid-capture; Telegram never retries because we ack 200) and a group
--          whose capture has gone quiet (bot demoted/removed — the July-7 outage cause). Both
--          surface in hw_dm_health_stats → the GitHub morning verifier emails the owner.

-- ---------- MED-3a: reminder candidates include stale resubmissions ----------
create or replace function public.ungraded_reminder_candidates(p_cutoff timestamp with time zone, p_limit integer)
returns setof homework_submissions
language sql
stable
security definer
set search_path = public
as $$
  select hs.*
  from public.homework_submissions hs
  left join public.homework_ungraded_reminders r
    on r.submission_id = hs.id
   and r.cycle_submitted_at = hs.submitted_at
  where (hs.score is null or hs.score_is_stale)   -- pending = ungraded OR awaiting regrade
    and hs.submitted_at < p_cutoff
    and coalesce(r.reminders_sent, 0) < 3
    and (r.last_reminder_at is null or r.last_reminder_at < now() - interval '24 hours')
  order by hs.submitted_at asc
  limit greatest(p_limit, 1)
$$;

-- ---------- MED-3b: queue reconciler includes stale resubmissions + cycle-aware dedupe ----------
create or replace function public.reconcile_teacher_dm_queue()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  _n int := 0;
  _tash timestamptz := now() + interval '5 hours'; -- Tashkent, no DST
  _hour int := extract(hour from _tash)::int;
  _sched timestamptz;
begin
  if _hour >= 22 then
    _sched := date_trunc('day', _tash) + interval '1 day' + interval '8 hours' - interval '5 hours';
  elsif _hour < 8 then
    _sched := date_trunc('day', _tash) + interval '8 hours' - interval '5 hours';
  else
    _sched := now();
  end if;

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
    and (hs.score is null or hs.score_is_stale)          -- MED-3: stale resubmits need DMs too
    and hs.submitted_at > now() - interval '48 hours'
    and hs.submitted_at < now() - interval '10 minutes'
    and not exists (
      select 1 from homework_teacher_dm_queue q
      where q.submission_id = hs.id
        and (q.message_url = hs.telegram_message_url      -- same post already notified
             or q.created_at >= hs.submitted_at)          -- or ANY notification this cycle
    );
  get diagnostics _n = row_count;
  if _n > 0 then
    raise log 'reconcile_teacher_dm_queue resurrected % rows', _n;
  end if;
  return _n;
end;
$$;
revoke execute on function public.reconcile_teacher_dm_queue() from public, anon, authenticated;

-- ---------- LOW-2: retag merge retargets unsent queue rows to the surviving submission ----------
-- (Full function replacement; only the marked block is new.)
create or replace function public.admin_retag_submission(_submission uuid, _new_assignment uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  _sub record;
  _target record;
  _old uuid;
  _media jsonb;
  _survivor uuid;
  _status text;
begin
  select * into _sub from homework_submissions where id = _submission;
  if _sub.id is null then return jsonb_build_object('status', 'not_found'); end if;
  if _sub.score is not null then return jsonb_build_object('status', 'already_graded', 'submission_id', _sub.id); end if;
  _old := _sub.assignment_id;
  if _old = _new_assignment then return jsonb_build_object('status', 'same', 'submission_id', _sub.id); end if;
  if not exists (select 1 from homework_assignments where id = _new_assignment and is_active) then
    return jsonb_build_object('status', 'bad_assignment', 'submission_id', _sub.id);
  end if;

  select * into _target from homework_submissions
   where user_id = _sub.user_id and assignment_id = _new_assignment;

  if _target.id is not null then
    if _target.score is not null then
      return jsonb_build_object('status', 'target_graded', 'submission_id', _sub.id);
    end if;
    _media := coalesce(_target.media, '[]'::jsonb);
    select _media || coalesce(jsonb_agg(el), '[]'::jsonb) into _media
      from jsonb_array_elements(coalesce(_sub.media, '[]'::jsonb)) el
     where jsonb_array_length(_media) < 10;
    _media := (select coalesce(jsonb_agg(el), '[]'::jsonb) from (
                 select el from jsonb_array_elements(_media) el limit 10) s);
    update homework_submissions set
      media = _media,
      submitted_text = case
        when coalesce(_target.submitted_text, '') = '' then _sub.submitted_text
        when coalesce(_sub.submitted_text, '') = '' or _target.submitted_text like '%' || _sub.submitted_text || '%'
          then _target.submitted_text
        else left(_target.submitted_text || E'\n' || _sub.submitted_text, 4000) end,
      submitted_at = greatest(coalesce(_target.submitted_at, _sub.submitted_at), coalesce(_sub.submitted_at, _target.submitted_at)),
      attempt_number = greatest(coalesce(_target.attempt_number, 1), coalesce(_sub.attempt_number, 1)),
      telegram_chat_id = coalesce(_sub.telegram_chat_id, _target.telegram_chat_id),
      telegram_thread_id = coalesce(_sub.telegram_thread_id, _target.telegram_thread_id),
      telegram_message_id = coalesce(_sub.telegram_message_id, _target.telegram_message_id),
      telegram_message_url = coalesce(_sub.telegram_message_url, _target.telegram_message_url),
      telegram_file_id = coalesce(_sub.telegram_file_id, _target.telegram_file_id),
      telegram_file_kind = coalesce(_sub.telegram_file_kind, _target.telegram_file_kind)
    where id = _target.id;
    -- NEW (LOW-2): unsent DM rows for the deleted source would carry a dead 🎯 button —
    -- retarget them to the surviving submission before the delete.
    update homework_teacher_dm_queue set submission_id = _target.id
     where submission_id = _sub.id and sent_at is null;
    delete from homework_submissions where id = _sub.id;
    delete from xp_events where user_id = _sub.user_id and ref_key = 'hw_submit:' || _old::text;
    _survivor := _target.id; _status := 'merged';
  else
    update homework_submissions set assignment_id = _new_assignment where id = _sub.id;
    delete from xp_events where user_id = _sub.user_id and ref_key = 'hw_submit:' || _new_assignment::text;
    update xp_events set ref_key = 'hw_submit:' || _new_assignment::text
     where user_id = _sub.user_id and ref_key = 'hw_submit:' || _old::text;
    _survivor := _sub.id; _status := 'moved';
  end if;

  update homework_teacher_dm_queue q set
    assignment_id = _new_assignment,
    module_id = a.module_id,
    module_number = m.position + 1,
    task_number = coalesce(a.task_number, 1),
    assignment_title = a.title
  from homework_assignments a join modules m on m.id = a.module_id
  where a.id = _new_assignment and q.submission_id in (_submission, _survivor);

  insert into user_xp (user_id, total_xp, level, updated_at)
  select e.user_id, sum(e.amount)::int, public.xp_level_for(sum(e.amount)::int), now()
  from xp_events e where e.user_id = _sub.user_id
  group by e.user_id
  on conflict (user_id) do update
    set total_xp = excluded.total_xp, level = excluded.level, updated_at = now();

  begin
    insert into admin_actions (actor_user_id, action, target_user_id, target_resource_type, target_resource_id, details)
    values (auth.uid(), 'homework_retagged', _sub.user_id, 'homework_submission', _survivor,
            jsonb_build_object('from_assignment', _old, 'to_assignment', _new_assignment, 'result', _status));
  exception when others then null;
  end;

  return jsonb_build_object('status', _status, 'submission_id', _survivor);
end;
$$;
revoke execute on function public.admin_retag_submission(uuid, uuid) from public, anon, authenticated;

-- ---------- W3/W4: silent-loss detectors in the health stats ----------
create or replace function public.hw_dm_health_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  _unsent_overdue int;
  _drainer_age_sec int;
  _errors_24h int;
  _resurrected_24h int;
  _fallback_24h int;
  _uncaptured_24h int;
  _stalest_capture_days int;
begin
  select count(*) into _unsent_overdue from homework_teacher_dm_queue
   where sent_at is null and scheduled_for < now() - interval '15 minutes';

  select coalesce(extract(epoch from now() - max(r.start_time))::int, 999999) into _drainer_age_sec
  from cron.job_run_details r join cron.job j on j.jobid = r.jobid
  where j.jobname = 'notify-homework-submission-every-minute' and r.status = 'succeeded';

  select count(*) into _errors_24h from homework_teacher_dm_queue
   where error is not null
     and error not like 'teacher_no_longer%'
     and error not like 'notifications_disabled%'
     and error not like '%_e2e_test%'
     and coalesce(sent_at, created_at) > now() - interval '24 hours';

  select count(*) into _resurrected_24h from homework_teacher_dm_queue
   where assignment_title like '%(tiklandi)%' and created_at > now() - interval '24 hours';

  select count(*) into _fallback_24h from homework_teacher_dm_queue
   where error = 'sql_fallback_delivery' and sent_at > now() - interval '24 hours';

  -- W3: media posts by STUDENTS in a registered homework topic that produced NO reaction at all
  -- from the pipeline (webhook crashed mid-capture; we ack 200 so Telegram never retries).
  -- webhook_inbox keeps every raw update, so silent loss is detectable after the fact.
  -- A post counts as CAPTURED if it matches a pending/submission row exactly, OR if the student
  -- had ANY pipeline activity (pending row created / submission written) within −15m..+30m of the
  -- post — resubmission upserts REPLACE the media array, so exact-match-only over-counted
  -- superseded posts. 20-min grace lets the live pipeline finish first.
  select count(*) into _uncaptured_24h
  from webhook_inbox w
  join profiles p on p.telegram_id = w.from_user_id
  -- Poster must be a MEMBER of the group whose homework topic this is (also prevents the
  -- shared-chat double-join: 9-GURUH and PRE 5.0 share one chat).
  join groups g on p.group_id = g.id
               and g.homework_topic_id = w.message_thread_id
               and g.homework_topic_url ilike '%/c/' || regexp_replace(w.chat_id::text, '^-100', '') || '/%'
  where w.update_type = 'message'
    and w.received_at between now() - interval '24 hours' and now() - interval '20 minutes'
    and (w.raw_update->'message' ? 'photo' or w.raw_update->'message' ? 'video' or w.raw_update->'message' ? 'document')
    and not exists (select 1 from user_roles r where r.user_id = p.id and r.role in ('teacher','admin','superadmin'))
    and not exists (select 1 from hw_pending_posts hp
                     where hp.telegram_chat_id = w.chat_id
                       and (hp.first_message_id = w.message_id or hp.media::text like '%/' || w.message_id || '"%'))
    and not exists (select 1 from homework_submissions hs
                     where hs.user_id = p.id
                       and (hs.telegram_message_id = w.message_id or hs.media::text like '%/' || w.message_id || '"%'))
    -- Supersession forgiveness: appends don't bump submitted_at and later attempts REPLACE the
    -- media array, so exact matches vanish retroactively. Any pipeline activity for this student
    -- within −15m..+4h of the post counts as "captured" — a true crash-loss produces NOTHING.
    and not exists (select 1 from hw_pending_posts hp2
                     where hp2.user_id = p.id
                       and hp2.created_at between w.received_at - interval '15 minutes' and w.received_at + interval '4 hours')
    and not exists (select 1 from homework_submissions hs2
                     where hs2.user_id = p.id
                       and hs2.submitted_at between w.received_at - interval '15 minutes' and w.received_at + interval '4 hours');

  -- W4: a group whose homework capture has gone quiet (bot demoted/removed = the July-7 outage
  -- shape). Max days-since-last-capture across active-course groups that have EVER captured.
  select coalesce(max(days), 0)::int into _stalest_capture_days from (
    select extract(day from now() - max(hs.submitted_at))::int as days
    from groups g
    join courses c on c.id = g.course_id and c.published
    join profiles p on p.group_id = g.id
    join homework_submissions hs on hs.user_id = p.id and hs.source = 'telegram_topic'
    group by g.id
  ) t;

  return jsonb_build_object(
    'unsent_overdue', _unsent_overdue,
    'drainer_age_sec', _drainer_age_sec,
    'errors_24h', _errors_24h,
    'resurrected_24h', _resurrected_24h,
    'fallback_24h', _fallback_24h,
    'uncaptured_24h', _uncaptured_24h,
    'stalest_capture_days', _stalest_capture_days,
    'checked_at', now()
  );
end;
$$;
revoke execute on function public.hw_dm_health_stats() from public, anon, authenticated;
