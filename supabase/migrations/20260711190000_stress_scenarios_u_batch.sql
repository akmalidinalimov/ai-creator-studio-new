-- Stress-scenario batch U3/U13/U14 (2026-07-11 night).
--   U3  🔁-resubmit tapped but never followed by a post left the row "awaiting regrade" forever —
--       the teacher could regrade OLD work believing it was new. Auto-revert stale→firm after
--       7 days without a new post (daily cron).
--   U13 A new group missing homework_topic_url/homework_topic_id silently degrades capture —
--       surface misconfigured active-course groups in the health stats (GitHub verifier warns).
--   U14 Album read-modify-write races could drop media items — atomic jsonb appends in SQL close
--       the race for both the picker pending rows and intent-path submission appends.

-- ---------- U3: stale-without-repost timeout ----------
create or replace function public.expire_abandoned_stale()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare _n int;
begin
  update homework_submissions
     set score_is_stale = false
   where score is not null
     and score_is_stale
     and submitted_at < now() - interval '7 days';
  get diagnostics _n = row_count;
  if _n > 0 then raise log 'expire_abandoned_stale reverted % rows', _n; end if;
  return _n;
end;
$$;
revoke execute on function public.expire_abandoned_stale() from public, anon, authenticated;
do $$
begin
  if exists (select 1 from cron.job where jobname = 'expire-abandoned-stale') then
    perform cron.unschedule('expire-abandoned-stale');
  end if;
  perform cron.schedule('expire-abandoned-stale', '40 3 * * *', $cmd$ select public.expire_abandoned_stale() $cmd$);
end $$;

-- ---------- U14: atomic media appends ----------
create or replace function public.append_pending_media(_id uuid, _item jsonb, _caption text)
returns int -- new media count; -1 = capped; -2 = row not pending/absent
language plpgsql
security definer
set search_path = public
as $$
declare _n int;
begin
  update hw_pending_posts set
    media = media || jsonb_build_array(_item),
    submitted_text = case
      when coalesce(submitted_text, '') = '' then left(coalesce(_caption, ''), 4000)
      when coalesce(_caption, '') = '' or submitted_text like '%' || _caption || '%' then submitted_text
      else left(submitted_text || E'\n' || _caption, 4000) end
  where id = _id and state = 'pending' and jsonb_array_length(media) < 10
  returning jsonb_array_length(media) into _n;
  if _n is not null then return _n; end if;
  if exists (select 1 from hw_pending_posts where id = _id and state = 'pending') then return -1; end if;
  return -2;
end;
$$;
revoke execute on function public.append_pending_media(uuid, jsonb, text) from public, anon, authenticated;

create or replace function public.append_submission_media(_id uuid, _item jsonb, _caption text)
returns int -- new media count; -1 = capped; -2 = row not appendable (graded/stale/absent)
language plpgsql
security definer
set search_path = public
as $$
declare _n int;
begin
  update homework_submissions set
    media = coalesce(media, '[]'::jsonb) || jsonb_build_array(_item),
    submitted_text = case
      when coalesce(submitted_text, '') = '' then left(coalesce(_caption, ''), 4000)
      when coalesce(_caption, '') = '' or submitted_text like '%' || _caption || '%' then submitted_text
      else left(submitted_text || E'\n' || _caption, 4000) end
  where id = _id and score is null
    and jsonb_array_length(coalesce(media, '[]'::jsonb)) < 10
  returning jsonb_array_length(media) into _n;
  if _n is not null then return _n; end if;
  if exists (select 1 from homework_submissions where id = _id and score is null) then return -1; end if;
  return -2;
end;
$$;
revoke execute on function public.append_submission_media(uuid, jsonb, text) from public, anon, authenticated;

-- ---------- U13: misconfigured-group detector in the health stats ----------
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
  _misconfigured_groups int;
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

  select count(*) into _uncaptured_24h
  from webhook_inbox w
  join profiles p on p.telegram_id = w.from_user_id
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
    and not exists (select 1 from hw_pending_posts hp2
                     where hp2.user_id = p.id
                       and hp2.created_at between w.received_at - interval '15 minutes' and w.received_at + interval '4 hours')
    and not exists (select 1 from homework_submissions hs2
                     where hs2.user_id = p.id
                       and hs2.submitted_at between w.received_at - interval '15 minutes' and w.received_at + interval '4 hours');

  select coalesce(max(days), 0)::int into _stalest_capture_days from (
    select extract(day from now() - max(hs.submitted_at))::int as days
    from groups g
    join courses c on c.id = g.course_id and c.published
    join profiles p on p.group_id = g.id
    join homework_submissions hs on hs.user_id = p.id and hs.source = 'telegram_topic'
    group by g.id
  ) t;

  -- U13: active-course groups with real students but broken homework-topic wiring.
  select count(*) into _misconfigured_groups
  from groups g
  join courses c on c.id = g.course_id and c.published
  where (g.homework_topic_url is null or g.homework_topic_id is null)
    and (select count(*) from profiles p where p.group_id = g.id and p.archived_at is null and p.status = 'active') >= 3;

  return jsonb_build_object(
    'unsent_overdue', _unsent_overdue,
    'drainer_age_sec', _drainer_age_sec,
    'errors_24h', _errors_24h,
    'resurrected_24h', _resurrected_24h,
    'fallback_24h', _fallback_24h,
    'uncaptured_24h', _uncaptured_24h,
    'stalest_capture_days', _stalest_capture_days,
    'misconfigured_groups', _misconfigured_groups,
    'checked_at', now()
  );
end;
$$;
revoke execute on function public.hw_dm_health_stats() from public, anon, authenticated;
