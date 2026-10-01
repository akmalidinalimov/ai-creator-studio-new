-- CO-TEACHERS COUNTED EVERYWHERE: every function that decides "which groups does this teacher teach" uses
-- primary ∪ group_teachers, and grading/answer credit goes to the person who did the work.
-- (Teacher audit 2026-09-30, PR-7a: findings F4, BOT-5, BOT-6, TUI-5.)
--
-- ═══ THE BUG (verified read-only against production, 2026-09-30) ═══
-- "The teachers of a group" are groups.teacher_id (the primary) ∪ group_teachers (co-teachers): that is what
-- is_group_teacher() / teacher_group_ids(), every RLS policy, the grading queue and both submission-DM paths
-- use. 22 live public functions read groups.teacher_id with none of those helpers. 17 of them decide a
-- teacher's scope or credit, so a co-teacher was invisible to them:
--   * teacher_daily_report (21:00 digest): "✍️ Bugun baholadingiz" counted by the student's group's PRIMARY,
--     never by hs.scored_by -- 13 of the 358 grades of the last 60 days were made by someone other than the
--     primary (the PRE co-teacher) and went into the primary's number. Backlog, questions, activity: primary
--     groups only. A group with only co-teachers dropped out entirely.
--   * teacher_nudge_signals (hourly nudge), teacher_weekly_self (web profile / bot card / weekly digest),
--     admin_teacher_weekly, admin_teacher_stats, admin_teacher_groups, admin_teacher_unanswered,
--     analytics_teacher_quality: primary groups only.
--   * admin_group_module_submissions (bot /thomework, GroupDetail): "—" for a co-taught group.
--     teacher_group_top (Top-5): empty. admin_export_group_csv: "forbidden". admin_dashboard_students,
--     staff_recent_auth_events, staff_recent_lesson_progress, staff_top_students: co-taught students missing.
--   * award_teacher_engagement_xp: (A) +8 teacher_answer always paid to the PRIMARY, whoever answered -- over
--     the last ~32 days 2 answers by the co-teacher were paid to the primary, and 6 student replies addressed
--     to the co-teacher in PRE (answered within 6 h) never counted as questions at all; (B) +20
--     teacher_queue_clear only for primaries. Its ref key 'tanswer:<chat>:<question time>' is per PERSON, so a change of payee
--     pays a question twice: it happened once (a July question paid to Dono, then 16 h later to Feruza,
--     after the group's primary changed inside the 26-hour lookback).
--   * xp_on_student_module_impact (trigger): +25 teacher_impact to the primary only.
-- Live exposure today: 1 co-teacher pair (Rano on 1-GURUH PRE 5.0, 41 students; primary Feruza). The six
-- Challenge 6.0 groups have no teacher yet: whoever the owner adds as an extra teacher lands here.
-- A sibling in the same CTEs: teacher_nudge_signals, teacher_weekly_self, admin_teacher_weekly and the answer
-- XP matched "a staff reply after the question" with `thread = thread`, which is never true in the General
-- chat (thread NULL): an answered General-chat question read as unanswered forever and was never paid (3
-- General-chat questions answered within 6 h in the last ~32 days got no XP). teacher_daily_report already
-- had the NULL-safe form.
--
-- ═══ THE FIX ═══
-- 1. teacher_group_pairs(): the (group, teacher, is_primary) set once, for every teacher -- the same set
--    as is_group_teacher(). is_primary comes from groups.teacher_id. service_role only.
-- 2. teacher_group_signals(p_q_hours, p_window_days): the per-(teacher, group) engine -- pending homework
--    (the rule both old functions used: ungraded, submitted, by a student whose CURRENT group it is) and
--    waiting questions (teacher_nudge_signals' rule, NULL-safe). teacher_daily_report's backlog and
--    teacher_nudge_signals' totals are now SUMS of its rows, and the digest/nudge edge functions print the
--    same rows one line per group with the course ("5.0 · 1-GURUH PRE — 3"), so a total and its lines
--    cannot disagree. service_role only.
-- 3. teacher_engagement_xp_candidates(p_lookback_hours): WHO is paid, read-only (so it can be self-tested):
--    answer XP to the teacher of the group who sent the first staff message after the question (else the
--    primary, as before), once per question across all people (an already-paid ref key is never paid
--    again); queue-clear XP to every teacher of any group who graded today (hs.scored_by) with nothing
--    waiting in ANY group they teach. award_teacher_engagement_xp now only mints what it returns.
-- 4. The 17 functions are rewritten from their LIVE text (below): scope via teacher_group_ids() /
--    is_group_teacher() / teacher_group_pairs(), graded_today and admin_teacher_weekly's "graded" by
--    hs.scored_by, a backlog belongs to every teacher of the group, anonymous-admin posts (the bot stamps
--    them with the group's primary) count as the primary's activity only, NULL-safe thread matching,
--    xp_on_student_module_impact pays every teacher of the student's group (once each).
-- What changes on production at deploy (read-only dry run, 2026-09-30): the co-teacher gains PRE in every
-- view above; backlog numbers are unchanged today (PRE has 0 waiting); the nudge's "waiting" stays 1 for
-- Feruza (an unanswered "ustoz" question in PRE's General chat, 29 h old) and becomes 2 for Rano (the same
-- question + a reply addressed to her in PRE, 44 h old; before: 0); no answer XP is due (the 4 questions
-- answered in the last 26 h are already paid, to the same people); PRE's module completions
-- (19 in the last 30 days) now also pay its co-teacher +25 each (~475 XP/30 days at that rate).
--
-- ═══ UNCHANGED, ON PURPOSE ═══
-- public_profile, admin_course_group_stats, admin_homework_health, nudge_candidates_inactive: they NAME "the
-- teacher" of a group, which is the primary. admin_teacher_activity_daily: takes a teacher id, no group scope.
-- Scope stays "the student's CURRENT group" (course-scoped statistics and per-submission groups are PR-7b /
-- PR-8 / PR-9). The bot's group_message_events.mentions_teacher still flags an @mention of the primary only
-- (1 message in 30 days mentioned the co-teacher); it feeds community-question XP too, so it changes in a
-- bot PR of its own. No history is healed: the 2 answers paid to the primary and the 1 question paid twice
-- (8 XP each, July/September) are left as they are; the new rules apply from deploy, with no back-pay.
--
-- ═══ HOW, and why it is safe (the pinned-rewrite pattern) ═══
-- Each function is edited FROM ITS LIVE pg_get_functiondef, only if md5(replace(prosrc, CR, '')) equals the
-- value read on 2026-09-30 (anything else aborts with "regenerate"), with 38 replace() edits that must each
-- match exactly once, in order. Edits in the 10 bodies created from the dashboard (CRLF line ends) are single
-- lines, so they match whether or not the stored text has CRs. After CREATE OR REPLACE (body validation on)
-- the stored definition must equal the executed text, and owner, ACL and SECURITY DEFINER must be unchanged
-- (CREATE OR REPLACE keeps them). Every rewritten body must carry the marker "(20260930183000)" and none may
-- still contain its primary-only fragment (e.g. 'g.teacher_id'). The three new functions are revoked from
-- public, anon, authenticated and granted to service_role (callers are SECURITY DEFINER or the edge).
-- SELF-TESTS, read-only calls only (no JWT, nothing minted, nothing sent): T1 teacher_group_pairs() equals
-- primary ∪ group_teachers and is_primary matches groups.teacher_id; T2 teacher_daily_report()'s backlog
-- equals an independent count over every group each teacher teaches and graded_today equals an independent
-- count by hs.scored_by; T3 teacher_nudge_signals()'s totals equal the sums of teacher_group_signals();
-- T4 teacher_engagement_xp_candidates() pays no ref key twice, no already-paid question, only teachers of a
-- group, only 8/20. award_teacher_engagement_xp itself is NOT called (it mints; the cron at :07 every 4 h
-- does). DRY RUN, read-only against production on 2026-09-30: all 17 pins matched, all 38 edits matched
-- exactly once in the live text, no primary-only fragment left; the new functions' queries were run inline
-- against production (numbers above). PGlite harness supabase/functions/_teachers/testing/coteachers-check.ts:
-- the live bodies (md5-asserted) + this file: the defects reproduce before, 138 checks pass after, a changed
-- body or a non-matching edit aborts the whole file.
-- REPLAY-SAFE: a function carrying the marker is skipped; the helpers are CREATE OR REPLACE of the same text;
-- the static checks and self-tests run either way; the audit row is written once.
-- ROLLBACK: revert = a new migration restoring the 17 bodies from their pinned texts (in the repo migrations
-- named in the harness fixture) and dropping the three helpers.

-- ═══ 1. THE ONE DEFINITION: every (group, teacher) pair ═══
-- The same set is_group_teacher() / teacher_group_ids() authorise, for every teacher at once. is_primary is
-- read from groups.teacher_id (the authority); group_teachers.is_primary is only its mirror.
create or replace function public.teacher_group_pairs()
returns table(group_id uuid, teacher_id uuid, is_primary boolean)
language sql
stable
security definer
set search_path = public
as $$
  -- (20260930183000) primary ∪ co-teachers, one row per (group, teacher)
  select x.group_id, x.teacher_id, bool_or(x.is_primary)
  from (
    select g.id, g.teacher_id, true from public.groups g where g.teacher_id is not null
    union all
    select gt.group_id, gt.teacher_id, false from public.group_teachers gt
  ) as x(group_id, teacher_id, is_primary)
  group by x.group_id, x.teacher_id;
$$;
revoke execute on function public.teacher_group_pairs() from public, anon, authenticated;
grant execute on function public.teacher_group_pairs() to service_role;

-- ═══ 2. THE PER-GROUP ENGINE the digest and the nudge print one line per group from ═══
-- One row per (teacher, group) pair. pending_homework: ungraded, submitted work of students whose CURRENT
-- group it is (the rule teacher_daily_report and teacher_nudge_signals always used). waiting_questions:
-- teacher_nudge_signals' rule (a mention, "ustoz"/#savol, or a genuine reply to THIS teacher; asked between
-- p_window_days ago and p_q_hours ago; no staff message after it in the same thread), NULL-safe for the
-- General chat. teacher_daily_report's backlog and teacher_nudge_signals' totals are SUMS of these rows.
create or replace function public.teacher_group_signals(p_q_hours integer default 8, p_window_days integer default 3)
returns table(teacher_id uuid, group_id uuid, is_primary boolean, group_name text, course_id uuid, course_title text,
              pending_homework integer, oldest_pending_hours numeric, waiting_questions integer, oldest_wait_hours numeric)
language sql
stable
security definer
set search_path = public
as $$
  with tp as (
    select pr.group_id as gid, pr.teacher_id as tid, pr.is_primary, p.telegram_id as t_tgid
    from public.teacher_group_pairs() pr
    join public.profiles p on p.id = pr.teacher_id
  ),
  staff_ids as (
    select distinct ur.user_id as sid from public.user_roles ur
    where ur.role in ('teacher'::app_role, 'admin'::app_role, 'superadmin'::app_role)
  ),
  pend as (
    select pr.group_id as gid, count(*)::int as n,
      round((extract(epoch from (now() - min(hs.submitted_at))) / 3600.0)::numeric, 1) as oldest
    from public.homework_submissions hs
    join public.profiles pr on pr.id = hs.user_id
    where hs.score is null and hs.submitted_at is not null
      and pr.group_id in (select tp.gid from tp)
    group by pr.group_id
  ),
  dq as (
    select tp.tid, tp.gid, gme.telegram_chat_id as chat, gme.telegram_thread_id as thread, gme.sent_at as q_at
    from public.group_message_events gme
    join tp on tp.gid = gme.group_id
    where gme.sent_at >= now() - make_interval(days => p_window_days)
      and gme.sent_at <= now() - make_interval(hours => p_q_hours)
      and gme.profile_id is not null and gme.profile_id not in (select sid from staff_ids)
      and (gme.mentions_teacher or gme.has_ustoz
           or (gme.reply_to_user_id is not null and tp.t_tgid is not null and gme.reply_to_user_id = tp.t_tgid
               and gme.reply_to_message_id is distinct from gme.telegram_thread_id))
  ),
  q_open as (
    select dq.tid, dq.gid, count(*)::int as n,
      round((extract(epoch from (now() - min(dq.q_at))) / 3600.0)::numeric, 1) as oldest
    from dq
    where not exists (
      select 1 from public.group_message_events a
      where a.telegram_chat_id = dq.chat and a.telegram_thread_id is not distinct from dq.thread
        and a.sent_at > dq.q_at and a.profile_id in (select sid from staff_ids))
    group by dq.tid, dq.gid
  )
  select tp.tid, tp.gid, tp.is_primary, g.name, g.course_id, c.title,
         coalesce(pd.n, 0), pd.oldest, coalesce(q.n, 0), q.oldest
  from tp
  join public.groups g on g.id = tp.gid
  left join public.courses c on c.id = g.course_id
  left join pend pd on pd.gid = tp.gid
  left join q_open q on q.tid = tp.tid and q.gid = tp.gid
  order by tp.tid, c.title nulls last, g.name;
$$;
revoke execute on function public.teacher_group_signals(integer, integer) from public, anon, authenticated;
grant execute on function public.teacher_group_signals(integer, integer) to service_role;

-- ═══ 3. WHO IS PAID teacher engagement XP (read-only; award_teacher_engagement_xp only mints) ═══
-- (A) teacher_answer +8: a directed question answered by staff within 6 hours is paid ONCE, to the teacher
--     of the group who sent the first staff message after it; when that person does not teach the group
--     (an admin, another group's teacher) the group's primary is paid, as before. A question whose ref key
--     is already in xp_events (for anyone) is never paid again: no double pay across the switch from
--     "always the primary" and none if the answerer is ever re-derived differently.
-- (B) teacher_queue_clear +20: every teacher of any group (co-teachers too) who graded something today
--     (Tashkent, hs.scored_by) and has nothing waiting in ANY group they teach.
create or replace function public.teacher_engagement_xp_candidates(p_lookback_hours integer default 26)
returns table(teacher_id uuid, amount integer, reason text, ref_key text)
language sql
stable
security definer
set search_path = public
as $$
  with tg as (
    select pr.group_id as gid, pr.teacher_id as tid, pr.is_primary, p.telegram_id as t_tgid
    from public.teacher_group_pairs() pr
    join public.profiles p on p.id = pr.teacher_id
  ),
  staff_ids as (
    select distinct ur.user_id as sid from public.user_roles ur
    where ur.role in ('teacher'::app_role, 'admin'::app_role, 'superadmin'::app_role)
  ),
  dq as (
    select distinct tg.gid, gme.telegram_chat_id as chat, gme.telegram_thread_id as thread, gme.sent_at as q_at
    from public.group_message_events gme
    join tg on tg.gid = gme.group_id
    where gme.sent_at >= now() - make_interval(hours => p_lookback_hours)
      and gme.profile_id is not null and gme.profile_id not in (select sid from staff_ids)
      and (gme.mentions_teacher or gme.has_ustoz
           or (gme.reply_to_user_id is not null and tg.t_tgid is not null and gme.reply_to_user_id = tg.t_tgid
               and gme.reply_to_message_id is distinct from gme.telegram_thread_id))
  ),
  answered as (
    select dq.gid, dq.chat, dq.q_at, a.profile_id as aid
    from dq
    join lateral (
      select x.sent_at, x.profile_id
      from public.group_message_events x
      where x.telegram_chat_id = dq.chat and x.telegram_thread_id is not distinct from dq.thread
        and x.sent_at > dq.q_at and x.profile_id in (select sid from staff_ids)
      order by x.sent_at, x.telegram_message_id
      limit 1
    ) a on true
    where a.sent_at - dq.q_at <= interval '6 hours'
  ),
  answer_pay as (
    select distinct on (k.ref) k.ref, k.tid
    from (
      select 'tanswer:' || an.chat::text || ':' || ((extract(epoch from an.q_at) * 1000000)::bigint)::text as ref,
             coalesce((select tg.tid from tg where tg.gid = an.gid and tg.tid = an.aid),
                      (select tg.tid from tg where tg.gid = an.gid and tg.is_primary)) as tid
      from answered an
    ) k
    where k.tid is not null
    order by k.ref, k.tid
  ),
  qc as (
    select t.tid
    from (select distinct tg.tid from tg) t
    where exists (
        select 1 from public.homework_submissions hs
        where hs.scored_by = t.tid
          and (hs.scored_at at time zone 'Asia/Tashkent')::date = (now() at time zone 'Asia/Tashkent')::date)
      and not exists (
        select 1 from public.homework_submissions hs2
        join public.profiles pr on pr.id = hs2.user_id
        join tg g2 on g2.gid = pr.group_id
        where g2.tid = t.tid and hs2.score is null and hs2.submitted_at is not null)
  )
  select ap.tid, 8, 'teacher_answer', ap.ref
  from answer_pay ap
  where not exists (select 1 from public.xp_events e where e.ref_key = ap.ref and e.reason = 'teacher_answer')
  union all
  select qc.tid, 20, 'teacher_queue_clear',
         'tqueueclear:' || qc.tid::text || ':' || ((now() at time zone 'Asia/Tashkent')::date)::text
  from qc;
$$;
revoke execute on function public.teacher_engagement_xp_candidates(integer) from public, anon, authenticated;
grant execute on function public.teacher_engagement_xp_candidates(integer) to service_role;

-- ═══ 4. THE PINNED REWRITES (17 live functions) + deploy-time self-tests ═══
do $mig$
declare
  _marker constant text := '(20260930183000)';

  -- [signature, md5(replace(prosrc, CR, '')) read live 2026-09-30]
  _fns constant text[] := array[
    ['public.admin_group_module_submissions(uuid,uuid)',                    '408b67434cde2493c262f878a3597a41'],
    ['public.teacher_group_top(uuid,uuid,integer)',                         '366b6472d9cbd0fc846ac5392736849e'],
    ['public.admin_export_group_csv(uuid,boolean)',                         '0bb5a39080b3f470f5405e41d49d085a'],
    ['public.admin_dashboard_students(uuid,timestamp with time zone)',      'b5588f00d420a8fcbe759c74a63ba33f'],
    ['public.staff_recent_auth_events(timestamp with time zone)',           '9259b47f6108b106a2bd73965f63f96b'],
    ['public.staff_recent_lesson_progress(timestamp with time zone)',       '1f77cf8273ba4e35b7d31348d3dd8b80'],
    ['public.staff_top_students(integer)',                                  '86cade8d4d73a31fa5403ef510ff664e'],
    ['public.admin_teacher_groups(uuid,integer,integer)',                   'b274f70dbab1fc600562ae87ac36e451'],
    ['public.admin_teacher_unanswered(uuid,integer,integer)',               '2f6119c2faea16cb0815275379f81173'],
    ['public.analytics_teacher_quality(integer)',                           '896a8f390ba4222ff9ea28f5ada6b087'],
    ['public.admin_teacher_stats(integer,integer)',                         'a22a27311707a2d0362609f9e91ce5eb'],
    ['public.admin_teacher_weekly(integer,uuid)',                           'ea30477a239b98d00ce12107b88ada59'],
    ['public.teacher_daily_report()',                                       'ef0733215c7de6faeb33f384d68ed39a'],
    ['public.teacher_nudge_signals(integer,integer)',                       '7f94d545b538b3a8f26dcf5373ed75d6'],
    ['public.teacher_weekly_self(uuid,integer)',                            'a91406c7efbf6f8fcbb2afd7d6ee75dc'],
    ['public.award_teacher_engagement_xp(integer)',                         '934a501ed3009c21345a333f7048d7a5'],
    ['public.xp_on_student_module_impact()',                                '0b8a63e7a60eb204e1c95f97863e9839']
  ];

  -- [signature, old text (must match exactly once, in order), new text]. Edits of the CRLF-bodied functions
  -- (created from the dashboard) are single lines, so they match whether or not the stored text has CRs.
  _edits constant text[] := array[
    -- admin_group_module_submissions: the bot's /thomework and GroupDetail
    ['public.admin_group_module_submissions(uuid,uuid)',
     E'    WHERE (v_is_admin OR g.teacher_id = v_caller)\n',
     E'    WHERE (v_is_admin OR public.is_group_teacher(g.id, v_caller))  -- every teacher of the group, co-teachers too (20260930183000)\n'],

    -- teacher_group_top: the Top-5 on the web profile and the bot's teacher card
    ['public.teacher_group_top(uuid,uuid,integer)',
     E'        and (g.teacher_id = uid or has_role(auth.uid(), ''admin''::app_role) or has_role(auth.uid(), ''superadmin''::app_role))\n',
     E'        and (public.is_group_teacher(g.id, uid) or has_role(auth.uid(), ''admin''::app_role) or has_role(auth.uid(), ''superadmin''::app_role))  -- co-teachers too (20260930183000)\n'],

    -- admin_export_group_csv: a co-teacher was refused ("forbidden")
    ['public.admin_export_group_csv(uuid,boolean)',
     'OR EXISTS (SELECT 1 FROM public.groups g WHERE g.id = _group_id AND g.teacher_id = auth.uid())',
     'OR public.is_group_teacher(_group_id, auth.uid())  -- every teacher of the group, co-teachers too (20260930183000)'],

    -- the web dashboard (AdminDashboard.tsx) as a teacher
    ['public.admin_dashboard_students(uuid,timestamp with time zone)',
     'OR (is_teacher AND p.group_id IN (SELECT g.id FROM public.groups g WHERE g.teacher_id = uid))',
     'OR (is_teacher AND p.group_id IN (SELECT public.teacher_group_ids(uid)))  -- co-taught groups too (20260930183000)'],
    ['public.staff_recent_auth_events(timestamp with time zone)',
     'AND e.user_id IN (SELECT p.id FROM public.profiles p WHERE p.group_id IN (SELECT g.id FROM public.groups g WHERE g.teacher_id = uid))',
     'AND e.user_id IN (SELECT p.id FROM public.profiles p WHERE p.group_id IN (SELECT public.teacher_group_ids(uid)))  -- co-taught groups too (20260930183000)'],
    ['public.staff_recent_lesson_progress(timestamp with time zone)',
     'AND lp.user_id IN (SELECT p.id FROM public.profiles p WHERE p.group_id IN (SELECT g.id FROM public.groups g WHERE g.teacher_id = uid))',
     'AND lp.user_id IN (SELECT p.id FROM public.profiles p WHERE p.group_id IN (SELECT public.teacher_group_ids(uid)))  -- co-taught groups too (20260930183000)'],
    ['public.staff_top_students(integer)',
     'ELSE p.group_id IN (SELECT g.id FROM public.groups g WHERE g.teacher_id = uid)',
     'ELSE p.group_id IN (SELECT public.teacher_group_ids(uid))  -- co-taught groups too (20260930183000)'],

    -- admin per-teacher detail (no caller in the repo today; kept consistent)
    ['public.admin_teacher_groups(uuid,integer,integer)',
     'tg AS (SELECT id, name, homework_topic_id FROM groups WHERE teacher_id = p_teacher_id),',
     'tg AS (SELECT id, name, homework_topic_id FROM groups WHERE id IN (SELECT public.teacher_group_ids(p_teacher_id))),  -- co-taught groups too (20260930183000)'],
    ['public.admin_teacher_unanswered(uuid,integer,integer)',
     'tg AS (SELECT id, name, homework_topic_id FROM groups WHERE teacher_id = p_teacher_id),',
     'tg AS (SELECT id, name, homework_topic_id FROM groups WHERE id IN (SELECT public.teacher_group_ids(p_teacher_id))),  -- co-taught groups too (20260930183000)'],

    -- analytics_teacher_quality (AnalyticsTeachers.tsx)
    ['public.analytics_teacher_quality(integer)',
     'SELECT g.teacher_id, g.id AS group_id',
     'SELECT tp.teacher_id, tp.group_id  -- every teacher of the group, co-teachers too (20260930183000)'],
    ['public.analytics_teacher_quality(integer)',
     'FROM public.groups g',
     'FROM public.teacher_group_pairs() tp'],
    ['public.analytics_teacher_quality(integer)',
     'WHERE g.teacher_id IS NOT NULL',
     'WHERE tp.teacher_id IS NOT NULL'],

    -- admin_teacher_stats (no caller in the repo today; kept consistent)
    ['public.admin_teacher_stats(integer,integer)',
     'SELECT g.id AS group_id, g.teacher_id AS tid FROM groups g WHERE g.teacher_id IS NOT NULL',
     'SELECT tp.group_id, tp.teacher_id AS tid FROM public.teacher_group_pairs() tp  -- every teacher of the group, co-teachers too (20260930183000)'],
    ['public.admin_teacher_stats(integer,integer)',
     'SELECT g.teacher_id AS tid, gme.telegram_chat_id AS chat, gme.telegram_thread_id AS thread,',
     'SELECT tg.tid, gme.telegram_chat_id AS chat, gme.telegram_thread_id AS thread,'],
    ['public.admin_teacher_stats(integer,integer)',
     'JOIN groups g ON g.id = gme.group_id AND g.teacher_id IS NOT NULL',
     'JOIN groups g ON g.id = gme.group_id JOIN tgroups tg ON tg.group_id = g.id  -- one row per teacher of the group'],

    -- admin_teacher_weekly (AdminTeacherStats.tsx): one unit per (teacher, group), co-teachers too
    ['public.admin_teacher_weekly(integer,uuid)',
     E'  tg AS (\n    SELECT g.id AS gid, g.name AS gname, g.teacher_id AS tid, p.telegram_id AS t_tgid\n    FROM groups g\n    JOIN teachers t ON t.tid = g.teacher_id\n    JOIN profiles p ON p.id = g.teacher_id\n',
     E'  -- Every teacher of the group, co-teachers too (20260930183000). is_primary: the bot attributes an\n'
     || E'  -- anonymous-admin post to the group''s primary teacher, so only the primary''s unit counts those posts.\n'
     || E'  tg AS (\n'
     || E'    SELECT g.id AS gid, g.name AS gname, tp.teacher_id AS tid, p.telegram_id AS t_tgid, tp.is_primary\n'
     || E'    FROM public.teacher_group_pairs() tp\n'
     || E'    JOIN groups g ON g.id = tp.group_id\n'
     || E'    JOIN teachers t ON t.tid = tp.teacher_id\n'
     || E'    JOIN profiles p ON p.id = tp.teacher_id\n'],
    ['public.admin_teacher_weekly(integer,uuid)',
     E'      AND (e.is_anon_admin OR (tg.t_tgid IS NOT NULL AND e.telegram_user_id = tg.t_tgid))\n',
     E'      AND ((e.is_anon_admin AND tg.is_primary) OR (tg.t_tgid IS NOT NULL AND e.telegram_user_id = tg.t_tgid))\n'],
    ['public.admin_teacher_weekly(integer,uuid)',
     E'         AND (e.is_anon_admin OR (tg.t_tgid IS NOT NULL AND e.telegram_user_id = tg.t_tgid))) AS last_active\n',
     E'         AND ((e.is_anon_admin AND tg.is_primary) OR (tg.t_tgid IS NOT NULL AND e.telegram_user_id = tg.t_tgid))) AS last_active\n'],
    ['public.admin_teacher_weekly(integer,uuid)',
     E'       WHERE a.telegram_chat_id = dq.chat AND a.telegram_thread_id = dq.thread\n',
     E'       WHERE a.telegram_chat_id = dq.chat AND a.telegram_thread_id IS NOT DISTINCT FROM dq.thread  -- NULL-safe: the General chat\n'],
    ['public.admin_teacher_weekly(integer,uuid)',
     E'    SELECT g.teacher_id AS tid, g.id AS gid, count(*)::int AS graded,\n',
     E'    -- credited to the teacher who GRADED (hs.scored_by), per group of the student (20260930183000)\n'
     || E'    SELECT hs.scored_by AS tid, pr.group_id AS gid, count(*)::int AS graded,\n'],
    ['public.admin_teacher_weekly(integer,uuid)',
     E'    JOIN groups g ON g.id = pr.group_id AND g.teacher_id IS NOT NULL\n'
     || E'    WHERE hs.scored_at >= _from AND hs.submitted_at IS NOT NULL AND hs.score IS NOT NULL\n'
     || E'    GROUP BY g.teacher_id, g.id\n',
     E'    WHERE hs.scored_at >= _from AND hs.submitted_at IS NOT NULL AND hs.score IS NOT NULL\n'
     || E'      AND hs.scored_by IS NOT NULL AND pr.group_id IS NOT NULL\n'
     || E'    GROUP BY hs.scored_by, pr.group_id\n'],
    ['public.admin_teacher_weekly(integer,uuid)',
     E'    SELECT g.teacher_id AS tid, g.id AS gid, count(*)::int AS ungraded,\n',
     E'    SELECT tg.tid, tg.gid, count(*)::int AS ungraded,\n'],
    ['public.admin_teacher_weekly(integer,uuid)',
     E'    JOIN groups g ON g.id = pr.group_id AND g.teacher_id IS NOT NULL\n'
     || E'    WHERE hs.score IS NULL AND hs.submitted_at IS NOT NULL\n'
     || E'    GROUP BY g.teacher_id, g.id\n',
     E'    JOIN tg ON tg.gid = pr.group_id  -- every teacher of the group sees its backlog\n'
     || E'    WHERE hs.score IS NULL AND hs.submitted_at IS NOT NULL\n'
     || E'    GROUP BY tg.tid, tg.gid\n'],
    ['public.admin_teacher_weekly(integer,uuid)',
     E'    SELECT g.teacher_id AS tid, g.id AS gid,\n',
     E'    SELECT tg.tid, tg.gid,\n'],
    ['public.admin_teacher_weekly(integer,uuid)',
     E'    JOIN groups g ON g.id = pr.group_id AND g.teacher_id IS NOT NULL\n'
     || E'    WHERE hs.submitted_at >= _from\n'
     || E'    GROUP BY g.teacher_id, g.id\n',
     E'    JOIN tg ON tg.gid = pr.group_id\n'
     || E'    WHERE hs.submitted_at >= _from\n'
     || E'    GROUP BY tg.tid, tg.gid\n'],

    -- teacher_daily_report: the 21:00 teacher digest and its admin roll-up
    ['public.teacher_daily_report()',
     E'  tg as (\n    select g.id as gid, g.teacher_id as tid, p.telegram_id as t_tgid\n    from groups g\n    join teachers t on t.tid = g.teacher_id\n    join profiles p on p.id = g.teacher_id\n    where exists (select 1 from group_message_events e where e.group_id = g.id)\n  ),\n',
     E'  -- Every (teacher, group) pair, co-teachers too (20260930183000). is_primary: the bot attributes an\n'
     || E'  -- anonymous-admin post to the group''s primary teacher, so only the primary counts those posts.\n'
     || E'  tg as (\n'
     || E'    select tp.group_id as gid, tp.teacher_id as tid, p.telegram_id as t_tgid, tp.is_primary\n'
     || E'    from public.teacher_group_pairs() tp\n'
     || E'    join teachers t on t.tid = tp.teacher_id\n'
     || E'    join profiles p on p.id = tp.teacher_id\n'
     || E'    where exists (select 1 from group_message_events e where e.group_id = tp.group_id)\n'
     || E'  ),\n'],
    ['public.teacher_daily_report()',
     E'      and (e.is_anon_admin or (tg.t_tgid is not null and e.telegram_user_id = tg.t_tgid))\n',
     E'      and ((e.is_anon_admin and tg.is_primary) or (tg.t_tgid is not null and e.telegram_user_id = tg.t_tgid))\n'],
    ['public.teacher_daily_report()',
     E'             and (e.is_anon_admin or (tg.t_tgid is not null and e.telegram_user_id = tg.t_tgid)))) as last_active\n',
     E'             and ((e.is_anon_admin and tg.is_primary) or (tg.t_tgid is not null and e.telegram_user_id = tg.t_tgid)))) as last_active\n'],
    ['public.teacher_daily_report()',
     E'  -- Homework graded TODAY (Tashkent).\n  grading as (\n    select g.teacher_id as tid, count(*)::int as graded_today,\n',
     E'  -- Homework graded TODAY (Tashkent), credited to the teacher who GRADED it (hs.scored_by), whichever\n'
     || E'  -- group the student is in (20260930183000). It used to go to the student''s group''s primary teacher.\n'
     || E'  grading as (\n'
     || E'    select hs.scored_by as tid, count(*)::int as graded_today,\n'],
    ['public.teacher_daily_report()',
     E'    join profiles pr on pr.id = hs.user_id\n'
     || E'    join groups g on g.id = pr.group_id and g.teacher_id is not null\n'
     || E'    where hs.scored_at >= _daystart and hs.submitted_at is not null and hs.score is not null\n'
     || E'    group by g.teacher_id\n',
     E'    where hs.scored_at >= _daystart and hs.submitted_at is not null and hs.score is not null\n'
     || E'      and hs.scored_by is not null\n'
     || E'    group by hs.scored_by\n'],
    ['public.teacher_daily_report()',
     E'  -- All-time ungraded backlog (work waiting on the teacher).\n  backlog as (\n    select g.teacher_id as tid, count(*)::int as ungraded,\n      round((extract(epoch from (now() - min(hs.submitted_at))) / 3600.0)::numeric, 1) as oldest_pending_hours\n    from homework_submissions hs\n    join profiles pr on pr.id = hs.user_id\n    join groups g on g.id = pr.group_id and g.teacher_id is not null\n    where hs.score is null and hs.submitted_at is not null\n    group by g.teacher_id\n  ),\n',
     E'  -- All-time ungraded backlog (work waiting on the teacher): every group the teacher teaches, co-taught\n'
     || E'  -- ones too, summed from the per-group engine teacher_group_signals() that the digest prints one line\n'
     || E'  -- per group from (20260930183000), so the total and its lines cannot disagree.\n'
     || E'  backlog as (\n'
     || E'    select s.teacher_id as tid, sum(s.pending_homework)::int as ungraded,\n'
     || E'      max(s.oldest_pending_hours) as oldest_pending_hours\n'
     || E'    from public.teacher_group_signals() s\n'
     || E'    group by s.teacher_id\n'
     || E'    having sum(s.pending_homework) > 0\n'
     || E'  ),\n'],

    -- teacher_nudge_signals: the hourly "a student is waiting" / "you've gone quiet" DM
    ['public.teacher_nudge_signals(integer,integer)',
     E'  staff_ids as (\n    select distinct ur.user_id as sid from user_roles ur\n    where ur.role in (''teacher''::app_role, ''admin''::app_role, ''superadmin''::app_role)\n  ),\n  my_groups as (\n    select g.id as gid, g.teacher_id as tid, t.telegram_id as t_tgid\n    from groups g join teachers t on t.tid = g.teacher_id\n  ),\n  -- directed student questions in the window that are old enough to nudge\n  dq as (\n    select mg.tid, gme.telegram_chat_id as chat, gme.telegram_thread_id as thread, gme.sent_at as q_at\n    from group_message_events gme\n    join my_groups mg on mg.gid = gme.group_id\n    where gme.sent_at >= now() - make_interval(days => p_window_days)\n      and gme.sent_at <= now() - make_interval(hours => p_q_hours)\n      and gme.profile_id is not null and gme.profile_id not in (select sid from staff_ids)\n      and (gme.mentions_teacher or gme.has_ustoz\n           or (gme.reply_to_user_id is not null and mg.t_tgid is not null and gme.reply_to_user_id = mg.t_tgid\n               and gme.reply_to_message_id is distinct from gme.telegram_thread_id))\n  ),\n  -- ...that STILL have no staff reply after them in the same thread\n  dq_open as (\n    select dq.tid, dq.q_at\n    from dq\n    where not exists (\n      select 1 from group_message_events a\n      where a.telegram_chat_id = dq.chat and a.telegram_thread_id = dq.thread\n        and a.sent_at > dq.q_at and a.profile_id in (select sid from staff_ids)\n    )\n  ),\n  q_agg as (\n    select tid, count(*)::int as waiting_questions,\n      round((extract(epoch from (now() - min(q_at))) / 3600.0)::numeric, 1) as oldest_wait_hours\n    from dq_open group by tid\n  ),\n  pend as (\n    select g.teacher_id as tid, count(*)::int as pending_homework\n    from homework_submissions hs\n    join profiles pr on pr.id = hs.user_id\n    join groups g on g.id = pr.group_id and g.teacher_id is not null\n    where hs.score is null and hs.submitted_at is not null\n    group by g.teacher_id\n  ),\n',
     E'  -- Every group the teacher teaches, co-taught ones too (20260930183000). is_primary: the bot attributes an\n'
     || E'  -- anonymous-admin post to the group''s primary teacher, so only the primary counts those posts as activity.\n'
     || E'  my_groups as (\n'
     || E'    select tp.group_id as gid, tp.teacher_id as tid, tp.is_primary\n'
     || E'    from public.teacher_group_pairs() tp join teachers t on t.tid = tp.teacher_id\n'
     || E'  ),\n'
     || E'  -- Waiting questions and pending homework, summed from the per-group engine teacher_group_signals()\n'
     || E'  -- that the nudge DM lists one line per group from (same rules as before, NULL-safe in the General chat).\n'
     || E'  sig as (\n'
     || E'    select s.teacher_id as tid, s.waiting_questions, s.oldest_wait_hours, s.pending_homework\n'
     || E'    from public.teacher_group_signals(p_q_hours, p_window_days) s\n'
     || E'  ),\n'
     || E'  q_agg as (\n'
     || E'    select sig.tid, sum(sig.waiting_questions)::int as waiting_questions, max(sig.oldest_wait_hours) as oldest_wait_hours\n'
     || E'    from sig group by sig.tid having sum(sig.waiting_questions) > 0\n'
     || E'  ),\n'
     || E'  pend as (\n'
     || E'    select sig.tid, sum(sig.pending_homework)::int as pending_homework\n'
     || E'    from sig group by sig.tid having sum(sig.pending_homework) > 0\n'
     || E'  ),\n'],
    ['public.teacher_nudge_signals(integer,integer)',
     E'                  where (e.is_anon_admin or (t.telegram_id is not null and e.telegram_user_id = t.telegram_id))),\n',
     E'                  where ((e.is_anon_admin and mg.is_primary) or (t.telegram_id is not null and e.telegram_user_id = t.telegram_id))),\n'],

    -- teacher_weekly_self: the web profile's "your week", the bot's teacher card and the weekly digest
    ['public.teacher_weekly_self(uuid,integer)',
     E'  my_groups as (\n    select g.id as gid from groups g where g.teacher_id = uid\n  ),\n',
     E'  -- Every group this teacher teaches, co-taught ones too (20260930183000). is_primary: the bot attributes an\n'
     || E'  -- anonymous-admin post to the group''s primary teacher, so only the primary counts those posts.\n'
     || E'  my_groups as (\n'
     || E'    select tp.group_id as gid, tp.is_primary from public.teacher_group_pairs() tp where tp.teacher_id = uid\n'
     || E'  ),\n'],
    ['public.teacher_weekly_self(uuid,integer)',
     E'        where a.telegram_chat_id = dq.chat and a.telegram_thread_id = dq.thread\n',
     E'        where a.telegram_chat_id = dq.chat and a.telegram_thread_id is not distinct from dq.thread  -- NULL-safe: the General chat\n'],
    ['public.teacher_weekly_self(uuid,integer)',
     E'      and (e.is_anon_admin or (_tgid is not null and e.telegram_user_id = _tgid))\n',
     E'      and ((e.is_anon_admin and mg.is_primary) or (_tgid is not null and e.telegram_user_id = _tgid))\n'],

    -- award_teacher_engagement_xp: selection moved to the read-only teacher_engagement_xp_candidates()
    ['public.award_teacher_engagement_xp(integer)',
     E'  -- (A) Answered-question XP: +8 per directed question answered by staff within 6h.\n  perform public.award_xp(a.tid, 8, ''teacher_answer'',\n      ''tanswer:'' || a.chat::text || '':'' || ((extract(epoch from a.q_at) * 1000000)::bigint)::text)\n  from (\n    with staff_ids as (\n      select distinct ur.user_id as sid from user_roles ur\n      where ur.role in (''teacher''::app_role, ''admin''::app_role, ''superadmin''::app_role)\n    ),\n    tg as (\n      select g.id as gid, g.teacher_id as tid, p.telegram_id as t_tgid\n      from groups g join profiles p on p.id = g.teacher_id\n      where g.teacher_id is not null\n    ),\n    dq as (\n      select tg.tid, gme.telegram_chat_id as chat, gme.telegram_thread_id as thread, gme.sent_at as q_at\n      from group_message_events gme\n      join tg on tg.gid = gme.group_id\n      where gme.sent_at >= _from\n        and gme.profile_id is not null and gme.profile_id not in (select sid from staff_ids)\n        and (gme.mentions_teacher or gme.has_ustoz\n             or (gme.reply_to_user_id is not null and tg.t_tgid is not null and gme.reply_to_user_id = tg.t_tgid\n                 and gme.reply_to_message_id is distinct from gme.telegram_thread_id))\n    ),\n    answered as (\n      select dq.tid, dq.chat, dq.q_at,\n        (select min(x.sent_at) from group_message_events x\n         where x.telegram_chat_id = dq.chat and x.telegram_thread_id = dq.thread\n           and x.sent_at > dq.q_at and x.profile_id in (select sid from staff_ids)) as a_at\n      from dq\n    )\n    select tid, chat, q_at from answered\n    where a_at is not null and (a_at - q_at) <= interval ''6 hours''\n  ) a;\n\n  -- (B) Queue-clear XP: +20 once per Tashkent-day to teachers who graded today AND now have 0 backlog.\n  perform public.award_xp(t.tid, 20, ''teacher_queue_clear'',\n      ''tqueueclear:'' || t.tid::text || '':'' || ((now() at time zone ''Asia/Tashkent'')::date)::text)\n  from (\n    select g.teacher_id as tid\n    from groups g\n    where g.teacher_id is not null\n    group by g.teacher_id\n    having exists (\n        select 1 from homework_submissions hs\n        where hs.scored_by = g.teacher_id\n          and (hs.scored_at at time zone ''Asia/Tashkent'')::date = (now() at time zone ''Asia/Tashkent'')::date)\n      and not exists (\n        select 1 from homework_submissions hs2\n        join profiles pr on pr.id = hs2.user_id\n        join groups g2 on g2.id = pr.group_id\n        where g2.teacher_id = g.teacher_id and hs2.score is null and hs2.submitted_at is not null)\n  ) t;\n',
     E'  -- (A) +8 teacher_answer and (B) +20 teacher_queue_clear. WHO is paid is decided by the read-only\n'
     || E'  -- teacher_engagement_xp_candidates() (20260930183000): co-teachers count, answer XP goes to the teacher\n'
     || E'  -- who answered, queue-clear to whoever graded today with nothing left in any group they teach, and a\n'
     || E'  -- question already paid to anyone is never paid again. This function only mints.\n'
     || E'  perform public.award_xp(c.teacher_id, c.amount, c.reason, c.ref_key)\n'
     || E'  from public.teacher_engagement_xp_candidates(p_lookback_hours) c;\n'],

    -- xp_on_student_module_impact: +25 teacher_impact when a student completes a module
    ['public.xp_on_student_module_impact()',
     E'  select g.teacher_id into _teacher\n  from public.profiles p\n  join public.groups g on g.id = p.group_id\n  where p.id = new.profile_id;\n\n  if _teacher is not null then\n    begin\n      perform public.award_xp(_teacher, 25, ''teacher_impact'',\n        ''timpact:mod:'' || new.profile_id::text || '':'' || new.module_id::text);\n    exception when others then\n      raise warning ''xp_on_student_module_impact skipped (%, %): %'', new.profile_id, new.module_id, sqlerrm;\n    end;\n  end if;\n',
     E'  -- Every teacher of the student''s group, co-teachers too (20260930183000); each is paid once per student\n'
     || E'  -- and module (award_xp is idempotent per teacher and ref key).\n'
     || E'  for _teacher in\n'
     || E'    select tp.teacher_id\n'
     || E'    from public.profiles p\n'
     || E'    join public.teacher_group_pairs() tp on tp.group_id = p.group_id\n'
     || E'    where p.id = new.profile_id\n'
     || E'    order by tp.is_primary desc, tp.teacher_id\n'
     || E'  loop\n'
     || E'    begin\n'
     || E'      perform public.award_xp(_teacher, 25, ''teacher_impact'',\n'
     || E'        ''timpact:mod:'' || new.profile_id::text || '':'' || new.module_id::text);\n'
     || E'    exception when others then\n'
     || E'      raise warning ''xp_on_student_module_impact skipped (%, %, %): %'', new.profile_id, new.module_id, _teacher, sqlerrm;\n'
     || E'    end;\n'
     || E'  end loop;\n']
  ];

  -- [signature, fragment that must NOT be in the rewritten body]: the primary-only scope is gone.
  _absent constant text[] := array[
    ['public.admin_group_module_submissions(uuid,uuid)',               'g.teacher_id = v_caller'],
    ['public.teacher_group_top(uuid,uuid,integer)',                    'g.teacher_id = uid'],
    ['public.admin_export_group_csv(uuid,boolean)',                    'g.teacher_id = auth.uid()'],
    ['public.admin_dashboard_students(uuid,timestamp with time zone)', 'g.teacher_id = uid'],
    ['public.staff_recent_auth_events(timestamp with time zone)',      'g.teacher_id = uid'],
    ['public.staff_recent_lesson_progress(timestamp with time zone)',  'g.teacher_id = uid'],
    ['public.staff_top_students(integer)',                             'g.teacher_id = uid'],
    ['public.admin_teacher_groups(uuid,integer,integer)',              'teacher_id = p_teacher_id'],
    ['public.admin_teacher_unanswered(uuid,integer,integer)',          'teacher_id = p_teacher_id'],
    ['public.analytics_teacher_quality(integer)',                      'g.teacher_id'],
    ['public.admin_teacher_stats(integer,integer)',                    'g.teacher_id'],
    ['public.admin_teacher_weekly(integer,uuid)',                      'g.teacher_id'],
    ['public.teacher_daily_report()',                                  'g.teacher_id'],
    ['public.teacher_nudge_signals(integer,integer)',                  'g.teacher_id'],
    ['public.teacher_weekly_self(uuid,integer)',                       'g.teacher_id'],
    ['public.award_teacher_engagement_xp(integer)',                    'g.teacher_id'],
    ['public.xp_on_student_module_impact()',                           'g.teacher_id']
  ];

  _fn regprocedure;
  _src text; _def text; _new text;
  _acl text; _owner oid; _secdef boolean;
  _n int; _k int;
  _rewritten int := 0; _skipped int := 0; _names text[] := '{}';
  _bad text;
  _pairs int; _co_pairs int; _cand_answer int; _cand_clear int; _teachers int;
begin
  -- Every CREATE OR REPLACE below validates the edited body, whatever the session default is.
  perform set_config('check_function_bodies', 'on', true);

  -- The edit and absence lists name only functions in _fns (a typo there would silently skip an edit).
  for _k in 1 .. array_length(_edits, 1) loop
    if not exists (select 1 from generate_subscripts(_fns, 1) i where _fns[i][1] = _edits[_k][1]) then
      raise exception 'ABORT: edit % names %, which is not in the rewrite list', _k, _edits[_k][1];
    end if;
  end loop;

  for i in 1 .. array_length(_fns, 1) loop
    _fn := to_regprocedure(_fns[i][1]);
    if _fn is null then
      raise exception 'ABORT: % does not exist', _fns[i][1];
    end if;
    select prosrc, coalesce(array_to_string(proacl, ','), ''), proowner, prosecdef
      into _src, _acl, _owner, _secdef
      from pg_proc where oid = _fn;

    if position(_marker in _src) > 0 then
      raise notice '% already counts co-teachers -- rewrite skipped', _fns[i][1];
      _skipped := _skipped + 1;
      continue;
    end if;
    if md5(replace(_src, E'\r', '')) <> _fns[i][2] then
      raise exception 'ABORT: % changed since it was verified on 2026-09-30 (md5 %); re-read the live definition and regenerate this migration',
        _fns[i][1], md5(replace(_src, E'\r', ''));
    end if;

    _def := pg_get_functiondef(_fn);
    _new := _def;
    _n := 0;
    for _k in 1 .. array_length(_edits, 1) loop
      continue when _edits[_k][1] <> _fns[i][1];
      _n := _n + 1;
      if (length(_new) - length(replace(_new, _edits[_k][2], ''))) / length(_edits[_k][2]) <> 1 then
        raise exception 'ABORT: % edit % matched % times (want exactly 1); regenerate this migration',
          _fns[i][1], _n, (length(_new) - length(replace(_new, _edits[_k][2], ''))) / length(_edits[_k][2]);
      end if;
      _new := replace(_new, _edits[_k][2], _edits[_k][3]);
    end loop;
    if _n = 0 or position(_marker in _new) = 0 then
      raise exception 'ABORT: % has no edit carrying the marker', _fns[i][1];
    end if;

    execute _new;

    -- Post-conditions, from the catalog only.
    if pg_get_functiondef(_fn) is distinct from _new then
      raise exception 'ABORT: % -- the stored definition differs from the one executed', _fns[i][1];
    end if;
    if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
       or (select proowner from pg_proc where oid = _fn) <> _owner
       or (select prosecdef from pg_proc where oid = _fn) <> _secdef then
      raise exception 'ABORT: % -- owner, ACL or SECURITY DEFINER changed', _fns[i][1];
    end if;
    _rewritten := _rewritten + 1;
    _names := _names || _fns[i][1];
  end loop;

  -- ── Static checks of what now runs (on a replay too) ──
  for i in 1 .. array_length(_fns, 1) loop
    select prosrc into _src from pg_proc where oid = to_regprocedure(_fns[i][1]);
    if position(_marker in _src) = 0 then
      raise exception 'ABORT: % does not carry the marker after the rewrite', _fns[i][1];
    end if;
  end loop;
  for _k in 1 .. array_length(_absent, 1) loop
    select prosrc into _src from pg_proc where oid = to_regprocedure(_absent[_k][1]);
    if position(_absent[_k][2] in _src) > 0 then
      raise exception 'ABORT: % still reads the primary only (%)', _absent[_k][1], _absent[_k][2];
    end if;
  end loop;
  select string_agg(p, ', ') into _bad
  from unnest(array['public.teacher_group_pairs()', 'public.teacher_group_signals(integer,integer)',
                    'public.teacher_engagement_xp_candidates(integer)']) p
  where has_function_privilege('anon', p::regprocedure, 'EXECUTE')
     or has_function_privilege('authenticated', p::regprocedure, 'EXECUTE');
  if _bad is not null then
    raise exception 'ABORT: new helper(s) executable by anon or authenticated: %', _bad;
  end if;

  -- ── Self-tests: read-only calls only (no JWT needed, nothing minted, nothing sent) ──
  -- T1. teacher_group_pairs() is exactly primary ∪ junction.
  select count(*) into _n from (
    (select g.id, g.teacher_id from public.groups g where g.teacher_id is not null
     union select gt.group_id, gt.teacher_id from public.group_teachers gt)
    except select tp.group_id, tp.teacher_id from public.teacher_group_pairs() tp
  ) d;
  select count(*) into _k from (
    select tp.group_id, tp.teacher_id from public.teacher_group_pairs() tp
    except (select g.id, g.teacher_id from public.groups g where g.teacher_id is not null
            union select gt.group_id, gt.teacher_id from public.group_teachers gt)
  ) d;
  if _n <> 0 or _k <> 0 then
    raise exception 'ABORT: self-test T1 -- teacher_group_pairs() differs from primary ∪ group_teachers (% missing, % extra)', _n, _k;
  end if;
  select count(*), count(*) filter (where not tp.is_primary) into _pairs, _co_pairs from public.teacher_group_pairs() tp;
  if exists (select 1 from public.teacher_group_pairs() tp join public.groups g on g.id = tp.group_id
             where tp.is_primary is distinct from coalesce(g.teacher_id = tp.teacher_id, false)) then
    raise exception 'ABORT: self-test T1 -- is_primary disagrees with groups.teacher_id';
  end if;

  -- T2. The daily report: backlog = every group the teacher teaches; graded_today = what they graded.
  --     (teacher_daily_report allows auth.uid() is null: the cron's service role, and this migration.)
  select count(*) into _teachers from public.teacher_daily_report();
  select string_agg(r.teacher_id::text, ', ') into _bad
  from public.teacher_daily_report() r
  where r.ungraded_backlog <> (
          select count(*) from public.homework_submissions hs
          join public.profiles pr on pr.id = hs.user_id
          where hs.score is null and hs.submitted_at is not null
            and pr.group_id in (select tp.group_id from public.teacher_group_pairs() tp where tp.teacher_id = r.teacher_id))
     or r.graded_today <> (
          select count(*) from public.homework_submissions hs
          where hs.scored_by = r.teacher_id and hs.score is not null and hs.submitted_at is not null
            and hs.scored_at >= ((now() at time zone 'Asia/Tashkent')::date::timestamp) at time zone 'Asia/Tashkent');
  if _bad is not null then
    raise exception 'ABORT: self-test T2 -- teacher_daily_report backlog/graded_today disagree for %', _bad;
  end if;

  -- T3. The nudge totals are the sums of the per-group lines it prints.
  select string_agg(n.teacher_id::text, ', ') into _bad
  from public.teacher_nudge_signals(8, 3) n
  left join (select s.teacher_id, sum(s.waiting_questions)::int w, sum(s.pending_homework)::int p
             from public.teacher_group_signals(8, 3) s group by s.teacher_id) s on s.teacher_id = n.teacher_id
  where n.waiting_questions <> coalesce(s.w, 0) or n.pending_homework <> coalesce(s.p, 0);
  if _bad is not null then
    raise exception 'ABORT: self-test T3 -- teacher_nudge_signals disagrees with teacher_group_signals for %', _bad;
  end if;

  -- T4. Who would be paid now (read-only; the cron at :07 every 4 hours does the paying).
  select count(*) filter (where c.reason = 'teacher_answer'), count(*) filter (where c.reason = 'teacher_queue_clear')
    into _cand_answer, _cand_clear
  from public.teacher_engagement_xp_candidates(26) c;
  if exists (select 1 from public.teacher_engagement_xp_candidates(26) c group by c.ref_key having count(*) > 1) then
    raise exception 'ABORT: self-test T4 -- a ref key would be paid twice';
  end if;
  if exists (select 1 from public.teacher_engagement_xp_candidates(26) c
             where c.reason = 'teacher_answer'
               and exists (select 1 from public.xp_events e where e.ref_key = c.ref_key and e.reason = 'teacher_answer')) then
    raise exception 'ABORT: self-test T4 -- an already-paid question would be paid again';
  end if;
  if exists (select 1 from public.teacher_engagement_xp_candidates(26) c
             where c.teacher_id not in (select tp.teacher_id from public.teacher_group_pairs() tp)
                or (c.reason, c.amount) not in (('teacher_answer', 8), ('teacher_queue_clear', 20))) then
    raise exception 'ABORT: self-test T4 -- a candidate is not a teacher of any group, or has the wrong amount';
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'coteachers_counted_everywhere',
         jsonb_build_object(
           'migration', '20260930183000',
           'rewritten', _rewritten, 'skipped_already_done', _skipped, 'functions', to_jsonb(_names),
           'new_helpers', jsonb_build_array('teacher_group_pairs()', 'teacher_group_signals(integer,integer)',
                                            'teacher_engagement_xp_candidates(integer)'),
           'pairs', _pairs, 'co_teacher_pairs', _co_pairs, 'report_teachers', _teachers,
           'xp_candidates_now', jsonb_build_object('teacher_answer', _cand_answer, 'teacher_queue_clear', _cand_clear),
           'unchanged_on_purpose', jsonb_build_array('public_profile', 'admin_course_group_stats', 'admin_homework_health',
                                                     'nudge_candidates_inactive', 'admin_teacher_activity_daily'),
           'why', 'co-teachers (group_teachers) were invisible to 17 functions that read only groups.teacher_id; grading and answer credit went to the primary',
           'at', now())
  where not exists (select 1 from public.admin_actions where action = 'coteachers_counted_everywhere');
end $mig$;
