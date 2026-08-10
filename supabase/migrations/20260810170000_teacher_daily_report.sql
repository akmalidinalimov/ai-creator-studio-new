-- teacher_daily_report(): per-teacher daily stats for the 21:00-Tashkent teacher digest.
-- Reuses the proven heuristics from admin_teacher_weekly (20260716120000) but: (1) one row PER
-- TEACHER (aggregated across their groups), (2) a DAILY window, (3) service-role callable (the digest
-- edge fn + admins), and (4) FIXES the General-chat NULL-thread bug — the original answer-pairing used
-- `a.telegram_thread_id = dq.thread`, and NULL = NULL is not TRUE, so questions in the non-topic
-- General chat could never be marked answered. This uses `IS NOT DISTINCT FROM` (NULL-safe).
--
-- Windows (Asia/Tashkent): hours/grading = TODAY; directed-question lookback = 7 days (so a question
-- asked yesterday and answered today still counts, and "open" reflects the recent backlog);
-- ungraded-homework backlog = all-time open. All metrics are honest proxies — "hours" is active
-- POSTING time from message gaps (Telegram exposes no presence/read data); "questions" are the
-- directed subset (tag / "ustoz" / reply-to-teacher); "answered" = any later staff reply in-thread.
-- Validated read-only on prod 2026-08-10.

create or replace function public.teacher_daily_report()
returns table(
  teacher_id uuid, name text, telegram_id bigint,
  active_minutes int, messages int,
  answered_today int, open_questions int, median_wait_min numeric,
  graded_today int, grading_med_min numeric, avg_score_pct numeric,
  ungraded_backlog int, oldest_pending_hours numeric,
  last_active timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  _today    date        := (now() at time zone 'Asia/Tashkent')::date;
  _daystart timestamptz := ((now() at time zone 'Asia/Tashkent')::date::timestamp) at time zone 'Asia/Tashkent';
  _qfrom    timestamptz := now() - interval '7 days';
begin
  -- service role (cron/edge fn, auth.uid() is null) or an admin/superadmin only.
  if not (auth.uid() is null
          or has_role(auth.uid(), 'admin'::app_role)
          or has_role(auth.uid(), 'superadmin'::app_role)) then
    raise exception 'not authorized';
  end if;

  return query
  with teachers as (
    select distinct ur.user_id as tid from user_roles ur where ur.role = 'teacher'::app_role
  ),
  staff_ids as (
    select distinct ur.user_id as sid from user_roles ur
    where ur.role in ('teacher'::app_role, 'admin'::app_role, 'superadmin'::app_role)
  ),
  tg as (
    select g.id as gid, g.teacher_id as tid, p.telegram_id as t_tgid
    from groups g
    join teachers t on t.tid = g.teacher_id
    join profiles p on p.id = g.teacher_id
    where exists (select 1 from group_message_events e where e.group_id = g.id)
  ),
  -- Active minutes TODAY: gap-session heuristic over the teacher's own messages (named or anon-admin).
  pair_msgs as (
    select tg.tid,
      e.sent_at - lag(e.sent_at) over (partition by tg.tid, tg.gid order by e.sent_at) as gap
    from group_message_events e
    join tg on tg.gid = e.group_id
    where (e.sent_at at time zone 'Asia/Tashkent')::date = _today
      and (e.is_anon_admin or (tg.t_tgid is not null and e.telegram_user_id = tg.t_tgid))
  ),
  active as (
    select tid,
      round(sum(
        (case when gap is not null and gap <= interval '10 minutes' then extract(epoch from gap) else 0 end
         + case when gap is null or gap > interval '10 minutes' then 60 else 0 end)) / 60.0)::int as active_minutes,
      count(*)::int as messages
    from pair_msgs group by tid
  ),
  -- Directed student questions in the last 7 days (tag / "ustoz" / reply to the teacher).
  dq as (
    select tg.tid, gme.telegram_chat_id as chat, gme.telegram_thread_id as thread, gme.sent_at as q_at
    from group_message_events gme
    join tg on tg.gid = gme.group_id
    where gme.sent_at >= _qfrom
      and gme.profile_id is not null
      and gme.profile_id not in (select sid from staff_ids)
      and (gme.mentions_teacher or gme.has_ustoz
           or (gme.reply_to_user_id is not null and gme.reply_to_user_id = tg.t_tgid))
  ),
  dq_ans as (
    select dq.tid, dq.q_at,
      (select min(a.sent_at) from group_message_events a
       where a.telegram_chat_id = dq.chat
         and a.telegram_thread_id is not distinct from dq.thread   -- NULL-safe (General-chat fix)
         and a.sent_at > dq.q_at
         and a.profile_id in (select sid from staff_ids)) as a_at
    from dq
  ),
  q_agg as (
    select tid,
      count(*) filter (where a_at is not null
                         and (a_at at time zone 'Asia/Tashkent')::date = _today)::int as answered_today,
      count(*) filter (where a_at is null)::int as open_questions,
      round(percentile_cont(0.5) within group (order by extract(epoch from (a_at - q_at)) / 60.0)
            filter (where a_at is not null
                     and (a_at at time zone 'Asia/Tashkent')::date = _today)::numeric, 1) as median_wait_min
    from dq_ans group by tid
  ),
  -- Homework graded TODAY (Tashkent).
  grading as (
    select g.teacher_id as tid, count(*)::int as graded_today,
      round(percentile_cont(0.5) within group (
        order by extract(epoch from (hs.scored_at - hs.submitted_at)) / 60.0)::numeric, 1) as grading_med_min,
      round(avg(100.0 * hs.score / nullif(ha.max_score, 0))::numeric, 0) as avg_score_pct
    from homework_submissions hs
    join homework_assignments ha on ha.id = hs.assignment_id
    join profiles pr on pr.id = hs.user_id
    join groups g on g.id = pr.group_id and g.teacher_id is not null
    where hs.scored_at >= _daystart and hs.submitted_at is not null and hs.score is not null
    group by g.teacher_id
  ),
  -- All-time ungraded backlog (work waiting on the teacher).
  backlog as (
    select g.teacher_id as tid, count(*)::int as ungraded,
      round((extract(epoch from (now() - min(hs.submitted_at))) / 3600.0)::numeric, 1) as oldest_pending_hours
    from homework_submissions hs
    join profiles pr on pr.id = hs.user_id
    join groups g on g.id = pr.group_id and g.teacher_id is not null
    where hs.score is null and hs.submitted_at is not null
    group by g.teacher_id
  ),
  lastact as (
    select tg.tid,
      max((select max(e.sent_at) from group_message_events e
           where e.group_id = tg.gid
             and (e.is_anon_admin or (tg.t_tgid is not null and e.telegram_user_id = tg.t_tgid)))) as last_active
    from tg group by tg.tid
  )
  select t.tid,
    (coalesce(nullif(trim(concat(p.name, ' ', coalesce(p.last_name, ''))), ''), p.email))::text,
    p.telegram_id::bigint,
    coalesce(a.active_minutes, 0)::int, coalesce(a.messages, 0)::int,
    coalesce(q.answered_today, 0)::int, coalesce(q.open_questions, 0)::int, q.median_wait_min::numeric,
    coalesce(gr.graded_today, 0)::int, gr.grading_med_min::numeric, gr.avg_score_pct::numeric,
    coalesce(bl.ungraded, 0)::int, bl.oldest_pending_hours::numeric,
    la.last_active::timestamptz
  from teachers t
  join profiles p on p.id = t.tid
  left join active  a  on a.tid  = t.tid
  left join q_agg   q  on q.tid  = t.tid
  left join grading gr on gr.tid = t.tid
  left join backlog bl on bl.tid = t.tid
  left join lastact la on la.tid = t.tid
  order by 2;
end;
$$;

revoke execute on function public.teacher_daily_report() from public, anon;
grant execute on function public.teacher_daily_report() to authenticated, service_role;
