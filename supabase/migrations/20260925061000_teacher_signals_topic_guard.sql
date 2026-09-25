-- Teacher signals: an ordinary post in a forum topic is not a question directed at the teacher.
--
-- THE SAME BUG AS THE COMMUNITY-XP TOPIC GUARD, IN FIVE MORE PLACES. Telegram marks every message posted in a forum
-- topic as a reply to that topic's creation service message, so `group_message_events.reply_to_user_id`
-- named a person who was never replied to: the topic's creator. The community XP engine was fixed for
-- that; these five read the identical signal with the identical assumption and were not.
--
--   award_teacher_engagement_xp  pays +8 teacher_answer XP, UNCAPPED. The only one that mints.
--   teacher_daily_report         the 21:00 teacher/admin digest.
--   teacher_weekly_self          the teacher-facing "my week" RPC.
--   teacher_nudge_signals        the "a student is waiting" nudge DM.
--   admin_teacher_weekly         the admin teacher-stats dashboard.
--
-- Each carries `gme.reply_to_user_id = <that group's own teacher's telegram_id>` as one arm of an OR
-- meaning "a question directed at the teacher". So if a group's teacher ever created a topic in their
-- own group, every ordinary post a student made in it would read as a directed question -- inflating
-- the dashboards, firing false "student is waiting" nudges, and minting real uncapped XP whenever any
-- staff message followed in that thread within 6 hours.
--
-- CURRENT EXPOSURE IS ZERO, MEASURED, NOT ASSUMED. Only two accounts have ever created a topic here --
-- @alikhanova_admin (6542876935) and GroupAnonymousBot (1087968824) -- and neither is, or has ever
-- been, a primary teacher (groups.teacher_id) or a co-teacher (group_teachers). Of 111 stored replies
-- pointing at a group's own teacher, 111 are genuine explicit replies and 0 are implicit topic
-- replies. The 1,110 existing teacher_answer events (8,880 XP) therefore contain none of this, and
-- there is nothing to heal.
--
-- WHY FIX IT ANYWAY, AND WHY IN ITS OWN PR. A companion PR fixes the CAPTURE side, so the bot stops
-- writing the bad shape at all; combined with award_teacher_engagement_xp's 26-hour lookback, that
-- path self-cleans within a day of THAT deploy. NOTE THE ORDERING: this migration does not depend on
-- it and must not be read as assuming it has landed -- the guard here is applied at READ time, so it
-- neutralises the false positive for old and new rows alike whether or not the capture fix is live
-- yet. That is also why this is worth doing regardless: it covers the 61,911 rows already stored, and
-- removes the dependence on a fact about human behaviour ("nobody but the admin taps Create Topic")
-- that no code enforces. Split from the capture fix deliberately -- five live functions, one of which
-- pays XP, is too much blast radius to bolt onto that change.
--
-- HOW THIS FILE WAS BUILT: each function body was EXTRACTED verbatim from the migration that last
-- defined it and patched by script with a single asserted string replacement (exactly one match per
-- function, verified). Nothing was retyped, so there is no transcription risk on a live XP path.
-- Grants are deliberately NOT restated: CREATE OR REPLACE FUNCTION preserves existing privileges, and
-- restating them is how a previous migration nearly dropped a service_role grant.
--
-- Idempotent + replay-safe: create-or-replace only. The DDL awards nothing; the self-test below
-- exercises the minting function inside a forced rollback, so a replay cannot mint either.

-- ───── award_teacher_engagement_xp ─────
-- pays +8 teacher_answer XP, UNCAPPED. The only one of the five that mints.
-- Verbatim from 20260708120000_teacher_responsiveness_xp.sql, one predicate patched.
create or replace function public.award_teacher_engagement_xp(p_lookback_hours int default 26)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  _from timestamptz := now() - make_interval(hours => p_lookback_hours);
begin
  -- (A) Answered-question XP: +8 per directed question answered by staff within 6h.
  perform public.award_xp(a.tid, 8, 'teacher_answer',
      'tanswer:' || a.chat::text || ':' || ((extract(epoch from a.q_at) * 1000000)::bigint)::text)
  from (
    with staff_ids as (
      select distinct ur.user_id as sid from user_roles ur
      where ur.role in ('teacher'::app_role, 'admin'::app_role, 'superadmin'::app_role)
    ),
    tg as (
      select g.id as gid, g.teacher_id as tid, p.telegram_id as t_tgid
      from groups g join profiles p on p.id = g.teacher_id
      where g.teacher_id is not null
    ),
    dq as (
      select tg.tid, gme.telegram_chat_id as chat, gme.telegram_thread_id as thread, gme.sent_at as q_at
      from group_message_events gme
      join tg on tg.gid = gme.group_id
      where gme.sent_at >= _from
        and gme.profile_id is not null and gme.profile_id not in (select sid from staff_ids)
        and (gme.mentions_teacher or gme.has_ustoz
             or (gme.reply_to_user_id is not null and tg.t_tgid is not null and gme.reply_to_user_id = tg.t_tgid
                 and gme.reply_to_message_id is distinct from gme.telegram_thread_id))
    ),
    answered as (
      select dq.tid, dq.chat, dq.q_at,
        (select min(x.sent_at) from group_message_events x
         where x.telegram_chat_id = dq.chat and x.telegram_thread_id = dq.thread
           and x.sent_at > dq.q_at and x.profile_id in (select sid from staff_ids)) as a_at
      from dq
    )
    select tid, chat, q_at from answered
    where a_at is not null and (a_at - q_at) <= interval '6 hours'
  ) a;

  -- (B) Queue-clear XP: +20 once per Tashkent-day to teachers who graded today AND now have 0 backlog.
  perform public.award_xp(t.tid, 20, 'teacher_queue_clear',
      'tqueueclear:' || t.tid::text || ':' || ((now() at time zone 'Asia/Tashkent')::date)::text)
  from (
    select g.teacher_id as tid
    from groups g
    where g.teacher_id is not null
    group by g.teacher_id
    having exists (
        select 1 from homework_submissions hs
        where hs.scored_by = g.teacher_id
          and (hs.scored_at at time zone 'Asia/Tashkent')::date = (now() at time zone 'Asia/Tashkent')::date)
      and not exists (
        select 1 from homework_submissions hs2
        join profiles pr on pr.id = hs2.user_id
        join groups g2 on g2.id = pr.group_id
        where g2.teacher_id = g.teacher_id and hs2.score is null and hs2.submitted_at is not null)
  ) t;
end;
$$;

-- ───── teacher_daily_report ─────
-- the 21:00 teacher/admin digest (answered_today, open_questions, median_wait_min).
-- Verbatim from 20260810170000_teacher_daily_report.sql, one predicate patched.
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
           or (gme.reply_to_user_id is not null and gme.reply_to_user_id = tg.t_tgid
               and gme.reply_to_message_id is distinct from gme.telegram_thread_id))
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

-- ───── teacher_weekly_self ─────
-- the teacher-facing my-week RPC.
-- Verbatim from 20260820100000_harden_per_user_rpcs.sql, one predicate patched.
CREATE OR REPLACE FUNCTION public.teacher_weekly_self(uid uuid, p_days integer DEFAULT 7)
 RETURNS TABLE(graded integer, grading_med_min numeric, on_time_pct numeric, ungraded_backlog integer, oldest_pending_hours numeric, feedback_rate numeric, avg_score_pct numeric, questions integer, answered integer, answer_rate numeric, median_wait_min numeric, active_days integer, days_window integer, week_messages integer, last_active timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare
  _from timestamptz := now() - make_interval(days => p_days);
  _tgid bigint;
begin
  if not (auth.role() = 'service_role' or auth.uid() = uid
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
           or (gme.reply_to_user_id is not null and _tgid is not null and gme.reply_to_user_id = _tgid
               and gme.reply_to_message_id is distinct from gme.telegram_thread_id))
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
$function$;

-- ───── teacher_nudge_signals ─────
-- drives the student-is-waiting nudge DM to teachers.
-- Verbatim from 20260708100000_teacher_nudge_signals.sql, one predicate patched.
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
           or (gme.reply_to_user_id is not null and mg.t_tgid is not null and gme.reply_to_user_id = mg.t_tgid
               and gme.reply_to_message_id is distinct from gme.telegram_thread_id))
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

-- ───── admin_teacher_weekly ─────
-- the admin teacher-stats dashboard.
-- Verbatim from 20260716120000_teacher_weekly_course_filter.sql, one predicate patched.
CREATE OR REPLACE FUNCTION public.admin_teacher_weekly(p_days int DEFAULT 7, p_course_id uuid DEFAULT NULL)
RETURNS TABLE(
  teacher_id uuid, name text, telegram_username text,
  group_id uuid, group_name text,
  active_days int, days_window int,
  active_min_by_day int[], week_active_min int,
  messages_by_day int[], week_messages int,
  questions int, answered int, answer_rate numeric, median_wait_min numeric,
  graded int, grading_med_min numeric, ungraded_backlog int,
  avg_score_pct numeric, pct_top numeric, feedback_rate numeric,
  resubmit_rate numeric, oldest_pending_hours numeric,
  last_active timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  _today date := (now() AT TIME ZONE 'Asia/Tashkent')::date;
  _from  timestamptz := now() - make_interval(days => p_days);
BEGIN
  IF NOT has_role(auth.uid(), 'admin'::app_role) THEN RAISE EXCEPTION 'admin only'; END IF;
  RETURN QUERY
  WITH teachers AS (
    SELECT DISTINCT ur.user_id AS tid FROM user_roles ur WHERE ur.role = 'teacher'::app_role
  ),
  staff_ids AS (
    SELECT DISTINCT ur.user_id AS sid FROM user_roles ur
    WHERE ur.role IN ('teacher'::app_role, 'admin'::app_role, 'superadmin'::app_role)
  ),
  -- one (teacher, group) unit per group a teacher is assigned to that has ANY chat history (skips
  -- empty placeholder groups). t_tgid = the teacher's own telegram account (for named teachers).
  -- p_course_id (when given) restricts to that course's groups → teachers OF that course only.
  tg AS (
    SELECT g.id AS gid, g.name AS gname, g.teacher_id AS tid, p.telegram_id AS t_tgid
    FROM groups g
    JOIN teachers t ON t.tid = g.teacher_id
    JOIN profiles p ON p.id = g.teacher_id
    WHERE EXISTS (SELECT 1 FROM group_message_events e WHERE e.group_id = g.id)
      AND (p_course_id IS NULL OR g.course_id = p_course_id)
  ),
  days AS (SELECT gs::date AS d FROM generate_series(_today - (p_days - 1), _today, interval '1 day') gs),
  pair_msgs AS (
    SELECT tg.tid, tg.gid,
      (e.sent_at AT TIME ZONE 'Asia/Tashkent')::date AS d,
      e.sent_at - lag(e.sent_at) OVER (PARTITION BY tg.tid, tg.gid ORDER BY e.sent_at) AS gap
    FROM group_message_events e
    JOIN tg ON tg.gid = e.group_id
    WHERE (e.sent_at AT TIME ZONE 'Asia/Tashkent')::date BETWEEN _today - (p_days - 1) AND _today
      AND (e.is_anon_admin OR (tg.t_tgid IS NOT NULL AND e.telegram_user_id = tg.t_tgid))
  ),
  pair_contrib AS (
    SELECT tid, gid, d,
      (CASE WHEN gap IS NOT NULL AND gap <= interval '10 minutes' THEN extract(epoch FROM gap) ELSE 0 END
       + CASE WHEN gap IS NULL OR gap > interval '10 minutes' THEN 60 ELSE 0 END) AS secs
    FROM pair_msgs
  ),
  pair_day AS (
    SELECT tid, gid, d, count(*)::int AS mc, round(sum(secs) / 60.0)::int AS am
    FROM pair_contrib GROUP BY tid, gid, d
  ),
  pair_grid AS (
    SELECT tg.gid, tg.tid, d.d, COALESCE(pd.am, 0) AS am, COALESCE(pd.mc, 0) AS mc
    FROM tg CROSS JOIN days d
    LEFT JOIN pair_day pd ON pd.tid = tg.tid AND pd.gid = tg.gid AND pd.d = d.d
  ),
  hours_agg AS (
    SELECT gid, tid,
      array_agg(am ORDER BY d) AS active_min_by_day,
      array_agg(mc ORDER BY d) AS messages_by_day,
      sum(am)::int AS week_active_min,
      sum(mc)::int AS week_messages,
      count(*) FILTER (WHERE mc > 0)::int AS active_days
    FROM pair_grid GROUP BY gid, tid
  ),
  dq AS (
    SELECT tg.tid, tg.gid, gme.telegram_chat_id AS chat, gme.telegram_thread_id AS thread, gme.sent_at AS q_at
    FROM group_message_events gme
    JOIN tg ON tg.gid = gme.group_id
    WHERE gme.sent_at >= _from
      AND gme.profile_id IS NOT NULL AND gme.profile_id NOT IN (SELECT sid FROM staff_ids)
      AND (gme.mentions_teacher OR gme.has_ustoz
           OR (gme.reply_to_user_id IS NOT NULL AND gme.reply_to_user_id = tg.t_tgid
               AND gme.reply_to_message_id IS DISTINCT FROM gme.telegram_thread_id))
  ),
  dq_ans AS (
    SELECT dq.tid, dq.gid, dq.q_at,
      (SELECT min(a.sent_at) FROM group_message_events a
       WHERE a.telegram_chat_id = dq.chat AND a.telegram_thread_id = dq.thread
         AND a.sent_at > dq.q_at AND a.profile_id IN (SELECT sid FROM staff_ids)) AS a_at
    FROM dq
  ),
  q_agg AS (
    SELECT tid, gid, count(*)::int AS questions,
      count(*) FILTER (WHERE a_at IS NOT NULL)::int AS answered,
      round(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (a_at - q_at)) / 60.0)
            FILTER (WHERE a_at IS NOT NULL)::numeric, 1) AS median_wait_min
    FROM dq_ans GROUP BY tid, gid
  ),
  grading AS (
    SELECT g.teacher_id AS tid, g.id AS gid, count(*)::int AS graded,
      round(percentile_cont(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (hs.scored_at - hs.submitted_at)) / 60.0)::numeric, 1) AS grading_med_min,
      round(avg(100.0 * hs.score / NULLIF(ha.max_score, 0))::numeric, 0) AS avg_score_pct,
      round((100.0 * count(*) FILTER (WHERE hs.score = ha.max_score) / NULLIF(count(*), 0))::numeric, 0) AS pct_top,
      round((100.0 * count(*) FILTER (WHERE btrim(COALESCE(hs.score_feedback, '')) <> '') / NULLIF(count(*), 0))::numeric, 0) AS feedback_rate
    FROM homework_submissions hs
    JOIN homework_assignments ha ON ha.id = hs.assignment_id
    JOIN profiles pr ON pr.id = hs.user_id
    JOIN groups g ON g.id = pr.group_id AND g.teacher_id IS NOT NULL
    WHERE hs.scored_at >= _from AND hs.submitted_at IS NOT NULL AND hs.score IS NOT NULL
    GROUP BY g.teacher_id, g.id
  ),
  backlog AS (
    SELECT g.teacher_id AS tid, g.id AS gid, count(*)::int AS ungraded,
      round((EXTRACT(EPOCH FROM (now() - min(hs.submitted_at))) / 3600.0)::numeric, 1) AS oldest_pending_hours
    FROM homework_submissions hs
    JOIN profiles pr ON pr.id = hs.user_id
    JOIN groups g ON g.id = pr.group_id AND g.teacher_id IS NOT NULL
    WHERE hs.score IS NULL AND hs.submitted_at IS NOT NULL
    GROUP BY g.teacher_id, g.id
  ),
  resub AS (
    SELECT g.teacher_id AS tid, g.id AS gid,
      round((100.0 * count(*) FILTER (
        WHERE COALESCE(hs.attempt_number, 1) > 1
           OR jsonb_array_length(COALESCE(hs.previous_attempts, '[]'::jsonb)) > 0
      ) / NULLIF(count(*), 0))::numeric, 0) AS resubmit_rate
    FROM homework_submissions hs
    JOIN profiles pr ON pr.id = hs.user_id
    JOIN groups g ON g.id = pr.group_id AND g.teacher_id IS NOT NULL
    WHERE hs.submitted_at >= _from
    GROUP BY g.teacher_id, g.id
  ),
  lastact AS (
    SELECT tg.tid, tg.gid,
      (SELECT max(e.sent_at) FROM group_message_events e
       WHERE e.group_id = tg.gid
         AND (e.is_anon_admin OR (tg.t_tgid IS NOT NULL AND e.telegram_user_id = tg.t_tgid))) AS last_active
    FROM tg
  )
  SELECT tg.tid::uuid,
    (COALESCE(NULLIF(TRIM(CONCAT(p.name, ' ', COALESCE(p.last_name, ''))), ''), p.email))::text,
    p.telegram_username::text,
    tg.gid::uuid, tg.gname::text,
    COALESCE(h.active_days, 0)::int, p_days::int,
    COALESCE(h.active_min_by_day, ARRAY[]::int[]), COALESCE(h.week_active_min, 0)::int,
    COALESCE(h.messages_by_day, ARRAY[]::int[]), COALESCE(h.week_messages, 0)::int,
    COALESCE(q.questions, 0)::int, COALESCE(q.answered, 0)::int,
    (CASE WHEN COALESCE(q.questions, 0) > 0 THEN round(100.0 * q.answered / q.questions, 0) ELSE NULL END)::numeric,
    q.median_wait_min::numeric,
    COALESCE(gr.graded, 0)::int, gr.grading_med_min::numeric, COALESCE(bl.ungraded, 0)::int,
    gr.avg_score_pct::numeric, gr.pct_top::numeric, gr.feedback_rate::numeric,
    rs.resubmit_rate::numeric, bl.oldest_pending_hours::numeric,
    la.last_active::timestamptz
  FROM tg JOIN profiles p ON p.id = tg.tid
  LEFT JOIN hours_agg h ON h.gid = tg.gid AND h.tid = tg.tid
  LEFT JOIN q_agg q ON q.gid = tg.gid AND q.tid = tg.tid
  LEFT JOIN grading gr ON gr.gid = tg.gid AND gr.tid = tg.tid
  LEFT JOIN backlog bl ON bl.gid = tg.gid AND bl.tid = tg.tid
  LEFT JOIN resub rs ON rs.gid = tg.gid AND rs.tid = tg.tid
  LEFT JOIN lastact la ON la.gid = tg.gid AND la.tid = tg.tid
  ORDER BY 2, 5;
END;
$$;

-- ───────────────────────── Deploy self-test (guarded) ─────────────────────────
-- Exercises all five rewritten functions against real data so a bad predicate surfaces here rather
-- than at the next cron tick.
--
-- THE MINTER IS RUN AS AN EXPLICIT DRY RUN, and this is the important part. An earlier draft called
-- `award_teacher_engagement_xp(0)` and claimed that left "no row to award". That was WRONG about half
-- the function: `p_lookback_hours` feeds `_from`, which gates section (A) (teacher_answer) only.
-- Section (B) (teacher_queue_clear, +20/day) is not gated by it at all -- it awards to any teacher who
-- graded today and currently has zero backlog, evaluated against live present-moment data whatever the
-- argument is. So that call would have minted real XP during a migration, at deploy timing, from a
-- block described as read-only. Ref-key dedup would have stopped a double-pay, but not the surprise.
--
-- It now runs inside a sub-block that raises a sentinel immediately afterwards. PL/pgSQL takes an
-- implicit savepoint at a block's BEGIN and rolls back to it when the block catches, so every write
-- the call made -- xp_events and the user_xp rebuild inside award_xp -- is unconditionally reverted on
-- the SUCCESS path, not only on failure. The function still gets fully exercised. (Safe here because
-- award_teacher_engagement_xp takes no advisory lock; an advisory lock would NOT be released by a
-- savepoint rollback.)
--
-- The other four are STABLE and write nothing.
do $selftest$
declare _n int; _t uuid; _report jsonb := '{}'::jsonb;
begin
  -- (1) The minter: exercise, then force a rollback so nothing it wrote can survive.
  begin
    perform public.award_teacher_engagement_xp(0);
    raise exception using errcode = 'XXTST', message = 'dry_run_rollback';
  exception when sqlstate 'XXTST' then
    _report := _report || jsonb_build_object('award_fn', 'exercised_rolled_back');
  end;

  select count(*) into _n from public.teacher_daily_report();
  _report := _report || jsonb_build_object('daily_report_rows', _n);

  select count(*) into _n from public.teacher_nudge_signals(24, 7);
  _report := _report || jsonb_build_object('nudge_rows', _n);

  select count(*) into _n from public.admin_teacher_weekly(7, null);
  _report := _report || jsonb_build_object('admin_weekly_rows', _n);

  -- (2) teacher_weekly_self needs a real teacher id, so it was previously skipped entirely -- meaning
  -- a typo in ITS predicate would have surfaced only when a teacher opened the Mini App. Exercised
  -- here against a real teacher, tolerantly: it is an auth-aware RPC, so a refusal is recorded rather
  -- than failing the whole self-test.
  select g.teacher_id into _t from groups g where g.teacher_id is not null limit 1;
  if _t is not null then
    begin
      select count(*) into _n from public.teacher_weekly_self(_t, 7);
      _report := _report || jsonb_build_object('weekly_self_rows', _n);
    exception when others then
      _report := _report || jsonb_build_object('weekly_self_note', sqlerrm);
    end;
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'teacher_signals_topic_guard_selftest', _report || jsonb_build_object('at', now()));
exception when others then
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'teacher_signals_topic_guard_selftest_failed',
            jsonb_build_object('error', sqlerrm, 'partial', _report, 'at', now()));
  exception when others then null; end;
end $selftest$;
