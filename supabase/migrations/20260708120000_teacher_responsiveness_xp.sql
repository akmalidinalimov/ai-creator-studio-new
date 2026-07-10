-- Teacher responsiveness XP (2026-07-08) — Teacher Engagement, Phase 1c.
-- Two more controllable-behavior rewards, both via a scheduled idempotent awarder (windowed
-- computation, so triggers don't fit). Reuses the generic award_xp (which maintains user_xp).
--
--   +8   a directed student question in the teacher's group was answered by staff within 6h
--   +20  once/day: the teacher graded today AND has zero ungraded backlog left (a real "inbox zero")
--
-- Attribution for answers = the group's teacher (anon-admin posts in a group are typically the
-- teacher). Idempotent ref_keys make overlapping runs safe. pg_cron calls the function directly
-- (no HTTP), so scheduling it here is environment-independent.

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
             or (gme.reply_to_user_id is not null and tg.t_tgid is not null and gme.reply_to_user_id = tg.t_tgid))
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
revoke execute on function public.award_teacher_engagement_xp(int) from public, anon, authenticated;

-- Backfill answered-question XP over the last 30 days (idempotent).
select public.award_teacher_engagement_xp(720);

-- Schedule it every 4 hours (direct pg call — no URL, safe across environments).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'teacher-engagement-xp-awarder') then
    perform cron.unschedule('teacher-engagement-xp-awarder');
  end if;
  perform cron.schedule('teacher-engagement-xp-awarder', '7 */4 * * *',
    $cmd$ select public.award_teacher_engagement_xp(26) $cmd$);
end $$;
