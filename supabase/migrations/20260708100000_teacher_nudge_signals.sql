-- Teacher engagement nudges (2026-07-08) — Teacher Engagement, Phase 3.
-- Signals RPC for the two NEW teacher reminders (the ungraded-homework reminder already lives):
--   * "a student is waiting"  — a directed student question unanswered for >= p_q_hours
--   * "you've gone quiet"     — the teacher has had no activity for >= 24h AND work is waiting
--
-- Computes per teacher; the edge function (cron-teacher-engagement-nudge) applies quiet hours,
-- rate limits (via notifications_log) and picks at most ONE message per teacher per run, so we
-- never double-DM or nag. Read-only aggregation; service-role/definer only.
--
-- "Directed question" + "answered" mirror admin_teacher_weekly's proven logic. Activity/last-active
-- is the max across the same three sources used elsewhere (own/anon group messages, grading, logins).

create or replace function public.teacher_nudge_signals(p_q_hours int default 8, p_window_days int default 3)
returns table(
  teacher_id uuid, telegram_id bigint, preferred_locale text, notifications_enabled boolean,
  waiting_questions int, oldest_wait_hours numeric,
  pending_homework int, last_active timestamptz, offline_hours numeric
)
language sql stable security definer set search_path = public
as $$
  with teachers as (
    select p.id as tid, p.telegram_id, p.preferred_locale, p.notifications_enabled
    from profiles p
    join user_roles ur on ur.user_id = p.id and ur.role = 'teacher'::app_role
    where p.telegram_id is not null
  ),
  staff_ids as (
    select distinct ur.user_id as sid from user_roles ur
    where ur.role in ('teacher'::app_role, 'admin'::app_role, 'superadmin'::app_role)
  ),
  my_groups as (
    select g.id as gid, g.teacher_id as tid, t.telegram_id as t_tgid
    from groups g join teachers t on t.tid = g.teacher_id
  ),
  -- directed student questions in the window that are old enough to nudge
  dq as (
    select mg.tid, gme.telegram_chat_id as chat, gme.telegram_thread_id as thread, gme.sent_at as q_at
    from group_message_events gme
    join my_groups mg on mg.gid = gme.group_id
    where gme.sent_at >= now() - make_interval(days => p_window_days)
      and gme.sent_at <= now() - make_interval(hours => p_q_hours)
      and gme.profile_id is not null and gme.profile_id not in (select sid from staff_ids)
      and (gme.mentions_teacher or gme.has_ustoz
           or (gme.reply_to_user_id is not null and mg.t_tgid is not null and gme.reply_to_user_id = mg.t_tgid))
  ),
  -- ...that STILL have no staff reply after them in the same thread
  dq_open as (
    select dq.tid, dq.q_at
    from dq
    where not exists (
      select 1 from group_message_events a
      where a.telegram_chat_id = dq.chat and a.telegram_thread_id = dq.thread
        and a.sent_at > dq.q_at and a.profile_id in (select sid from staff_ids)
    )
  ),
  q_agg as (
    select tid, count(*)::int as waiting_questions,
      round((extract(epoch from (now() - min(q_at))) / 3600.0)::numeric, 1) as oldest_wait_hours
    from dq_open group by tid
  ),
  pend as (
    select g.teacher_id as tid, count(*)::int as pending_homework
    from homework_submissions hs
    join profiles pr on pr.id = hs.user_id
    join groups g on g.id = pr.group_id and g.teacher_id is not null
    where hs.score is null and hs.submitted_at is not null
    group by g.teacher_id
  ),
  lastact as (
    select t.tid,
      greatest(
        coalesce((select max(e.sent_at) from group_message_events e
                  join my_groups mg on mg.gid = e.group_id and mg.tid = t.tid
                  where (e.is_anon_admin or (t.telegram_id is not null and e.telegram_user_id = t.telegram_id))),
                 'epoch'::timestamptz),
        coalesce((select max(hs.scored_at) from homework_submissions hs where hs.scored_by = t.tid), 'epoch'::timestamptz),
        coalesce((select max(ae.created_at) from auth_events ae where ae.user_id = t.tid), 'epoch'::timestamptz)
      ) as last_active
    from teachers t
  )
  select t.tid, t.telegram_id, t.preferred_locale, t.notifications_enabled,
    coalesce(q.waiting_questions, 0), q.oldest_wait_hours,
    coalesce(pe.pending_homework, 0),
    nullif(la.last_active, 'epoch'::timestamptz),
    case when la.last_active > 'epoch'::timestamptz
         then round((extract(epoch from (now() - la.last_active)) / 3600.0)::numeric, 1)
         else null end
  from teachers t
  left join q_agg q on q.tid = t.tid
  left join pend pe on pe.tid = t.tid
  left join lastact la on la.tid = t.tid;
$$;
revoke execute on function public.teacher_nudge_signals(int, int) from public, anon, authenticated;
