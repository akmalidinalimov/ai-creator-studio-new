-- Teacher self-scorecard (2026-07-08) — Teacher Engagement, Phase 0.
-- A TEACHER-scoped view of a teacher's OWN weekly KPIs, framed as competence / impact
-- feedback ("your week"), NOT admin surveillance. This is the foundation the XP engine,
-- badges, nudges and leaderboard all read from.
--
-- Mirrors the metric formulas already proven in admin_teacher_weekly, but:
--   (a) scoped to ONE teacher and aggregated across their groups into a single summary row,
--   (b) guarded self-or-staff — a teacher may read their OWN row; admin/superadmin/service-role
--       (auth.uid() is null, bot webhook) may read anyone's,
--   (c) adds on_time_pct (% of homework graded within 24h) for the responsiveness/SLA surface.
--
-- Additive only. admin_teacher_weekly is deliberately left untouched (no regression risk).
--
-- Attribution model (consistent with existing teacher RPCs):
--   * grading metrics  = homework YOU graded (scored_by = uid) — credits the actual grader.
--   * backlog          = ungraded submissions in groups YOU own (groups.teacher_id = uid) —
--                        "waiting on you", regardless of who eventually grades.
--   * responsiveness   = directed student questions in your groups, answered by any staff
--                        (mirrors admin_teacher_weekly's directed-question logic).
--   * activity/online  = your Telegram messages in your groups (anon-admin posts OR your own
--                        named account via profiles.telegram_id).

create or replace function public.teacher_weekly_self(uid uuid, p_days int default 7)
returns table(
  graded int, grading_med_min numeric, on_time_pct numeric,
  ungraded_backlog int, oldest_pending_hours numeric,
  feedback_rate numeric, avg_score_pct numeric,
  questions int, answered int, answer_rate numeric, median_wait_min numeric,
  active_days int, days_window int, week_messages int,
  last_active timestamptz
)
language plpgsql stable security definer set search_path = public
as $$
#variable_conflict use_column
declare
  _from timestamptz := now() - make_interval(days => p_days);
  _tgid bigint;
begin
  if not (auth.uid() is null or auth.uid() = uid
          or has_role(auth.uid(), 'admin'::app_role)
          or has_role(auth.uid(), 'superadmin'::app_role)) then
    raise exception 'not allowed';
  end if;

  select p.telegram_id into _tgid from profiles p where p.id = uid;

  return query
  with
  staff_ids as (
    select distinct ur.user_id as sid from user_roles ur
    where ur.role in ('teacher'::app_role, 'admin'::app_role, 'superadmin'::app_role)
  ),
  my_groups as (
    select g.id as gid from groups g where g.teacher_id = uid
  ),
  -- grading YOU did in the window + turnaround / on-time / quality signals
  grading as (
    select
      count(*)::int as graded,
      round(percentile_cont(0.5) within group (
        order by extract(epoch from (hs.scored_at - hs.submitted_at)) / 60.0)::numeric, 1) as grading_med_min,
      round((100.0 * count(*) filter (
        where hs.scored_at - hs.submitted_at <= interval '24 hours') / nullif(count(*), 0))::numeric, 0) as on_time_pct,
      round((100.0 * count(*) filter (
        where btrim(coalesce(hs.score_feedback, '')) <> '') / nullif(count(*), 0))::numeric, 0) as feedback_rate,
      round(avg(100.0 * hs.score / nullif(ha.max_score, 0))::numeric, 0) as avg_score_pct
    from homework_submissions hs
    join homework_assignments ha on ha.id = hs.assignment_id
    where hs.scored_by = uid and hs.scored_at >= _from
      and hs.submitted_at is not null and hs.score is not null
  ),
  -- current backlog waiting on this teacher's groups
  backlog as (
    select count(*)::int as ungraded_backlog,
      round((extract(epoch from (now() - min(hs.submitted_at))) / 3600.0)::numeric, 1) as oldest_pending_hours
    from homework_submissions hs
    join profiles pr on pr.id = hs.user_id
    join my_groups mg on mg.gid = pr.group_id
    where hs.score is null and hs.submitted_at is not null
  ),
  -- directed student questions in this teacher's groups
  dq as (
    select gme.telegram_chat_id as chat, gme.telegram_thread_id as thread, gme.sent_at as q_at
    from group_message_events gme
    join my_groups mg on mg.gid = gme.group_id
    where gme.sent_at >= _from
      and gme.profile_id is not null and gme.profile_id not in (select sid from staff_ids)
      and (gme.mentions_teacher or gme.has_ustoz
           or (gme.reply_to_user_id is not null and _tgid is not null and gme.reply_to_user_id = _tgid))
  ),
  dq_ans as (
    select dq.q_at,
      (select min(a.sent_at) from group_message_events a
        where a.telegram_chat_id = dq.chat and a.telegram_thread_id = dq.thread
          and a.sent_at > dq.q_at and a.profile_id in (select sid from staff_ids)) as a_at
    from dq
  ),
  q_agg as (
    select count(*)::int as questions,
      count(*) filter (where a_at is not null)::int as answered,
      round(percentile_cont(0.5) within group (order by extract(epoch from (a_at - q_at)) / 60.0)
            filter (where a_at is not null)::numeric, 1) as median_wait_min
    from dq_ans
  ),
  -- this teacher's own messages in their groups (anon-admin OR own named account)
  acts as (
    select (e.sent_at at time zone 'Asia/Tashkent')::date as d, e.sent_at
    from group_message_events e
    join my_groups mg on mg.gid = e.group_id
    where e.sent_at >= _from
      and (e.is_anon_admin or (_tgid is not null and e.telegram_user_id = _tgid))
  ),
  act_agg as (
    select count(distinct d)::int as active_days, count(*)::int as week_messages from acts
  ),
  lastact as (select max(sent_at) as last_active from acts)
  select
    coalesce(g.graded, 0)::int, g.grading_med_min, g.on_time_pct,
    coalesce(b.ungraded_backlog, 0)::int, b.oldest_pending_hours,
    g.feedback_rate, g.avg_score_pct,
    coalesce(q.questions, 0)::int, coalesce(q.answered, 0)::int,
    (case when coalesce(q.questions, 0) > 0 then round(100.0 * q.answered / q.questions, 0) else null end)::numeric,
    q.median_wait_min,
    coalesce(a.active_days, 0)::int, p_days::int, coalesce(a.week_messages, 0)::int,
    la.last_active
  from grading g
  cross join backlog b
  cross join q_agg q
  cross join act_agg a
  cross join lastact la;
end;
$$;
grant execute on function public.teacher_weekly_self(uuid, int) to authenticated;
