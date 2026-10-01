-- LIVE pg_get_functiondef of the five functions the 20260930182000 harness builds on, production, 2026-09-30.
-- grading-queue-filter-check.ts asserts each definition's md5 (and its prosrc's) equals production's, so the
-- migration's md5 pins and exactly-once replace() checks run against the real text. Fixture only; never applied.
CREATE OR REPLACE FUNCTION public.teacher_pending_submissions()
 RETURNS TABLE(submission_id uuid, user_id uuid, student_name text, group_id uuid, group_name text, module_number integer, task_number integer, assignment_id uuid, assignment_title text, max_score integer, submitted_at timestamp with time zone, previous_score integer, is_resubmission boolean, media jsonb, submitted_image_url text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    hs.id                                                                 as submission_id,
    hs.user_id                                                            as user_id,
    -- Same student_name formatting the DM reconciler uses (20260818190000:845-846): trimmed full
    -- name, '—' when blank, and the @username appended only when present (leading '@' stripped).
    (coalesce(nullif(trim(coalesce(p.name, '') || ' ' || coalesce(p.last_name, '')), ''), '—')
       || case when coalesce(p.telegram_username::text, '') <> ''
               then ' (@' || replace(p.telegram_username::text, '@', '') || ')'
               else '' end)                                               as student_name,
    p.group_id                                                            as group_id,
    g.name                                                                as group_name,
    (m.position + 1)                                                      as module_number,
    case when ha.parent_id is not null
         then coalesce(ha.sap_number, ha.task_number, 1)
         else coalesce(ha.task_number, 1) end                            as task_number,
    ha.id                                                                 as assignment_id,
    ha.title                                                              as assignment_title,
    coalesce(ha.max_score, 10)                                            as max_score,
    hs.submitted_at                                                       as submitted_at,
    hs.previous_score                                                     as previous_score,
    (coalesce(hs.attempt_number, 1) > 1)                                  as is_resubmission,
    hs.media                                                              as media,
    hs.submitted_image_url                                                as submitted_image_url
  from homework_submissions hs
  join profiles p              on p.id = hs.user_id
  join groups g                on g.id = p.group_id
  join homework_assignments ha on ha.id = hs.assignment_id      -- FK NOT NULL → never hides work
  join modules m               on m.id = ha.module_id           -- FK NOT NULL → never hides work
  where p.group_id in (select public.teacher_group_ids(auth.uid()))
    and (hs.score is null or hs.score_is_stale is true)
    -- Defense-in-depth (matches sibling RPCs teacher_groups / group_student_leaderboard): the
    -- junction scope above already returns zero rows for a non-teacher, but gate on the role
    -- explicitly too so this never depends solely on teacher_group_ids() semantics (the
    -- security-definer-anon-guard lesson: keep SECURITY DEFINER reads role-gated).
    and (public.has_role(auth.uid(), 'teacher'::public.app_role)
         or public.has_role(auth.uid(), 'admin'::public.app_role)
         or public.has_role(auth.uid(), 'superadmin'::public.app_role))
  order by hs.submitted_at asc;
$function$
;
CREATE OR REPLACE FUNCTION public.teacher_groups(uid uuid)
 RETURNS TABLE(group_id uuid, group_name text, course_name text, total_students integer, active_7d integer, avg_completion_pct integer, pending_homework integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with ok as (
    select (auth.role() = 'service_role' or auth.uid() = uid
            or has_role(auth.uid(), 'admin'::app_role) or has_role(auth.uid(), 'superadmin'::app_role)) as allowed
  ),
  gs as (
    select g.id, g.name, g.course_id, c.title as course_name
    from groups g
    left join courses c on c.id = g.course_id
    where g.id in (select public.teacher_group_ids(uid)) and (select allowed from ok)
  ),
  members as (
    select p.id as student_id, p.group_id
    from profiles p
    join gs on gs.id = p.group_id
    where p.status = 'active' and p.archived_at is null
  ),
  course_lessons as (
    select gs.id as gid, count(l.id) as n
    from gs
    join modules m on m.course_id = gs.course_id
    join lessons l on l.module_id = m.id
    group by gs.id
  ),
  done as (
    select mem.group_id as gid, mem.student_id, count(lp.lesson_id) as n_done
    from members mem
    left join lesson_progress lp
      on lp.user_id = mem.student_id and lp.completed_at is not null
      and lp.lesson_id in (
        select l.id from lessons l join modules m on m.id = l.module_id
        where m.course_id = (select course_id from gs where gs.id = mem.group_id)
      )
    group by mem.group_id, mem.student_id
  ),
  act as (
    select mem.group_id as gid, count(distinct mem.student_id) as n
    from members mem
    join daily_watch_summary d on d.user_id = mem.student_id
      and d.watch_date > current_date - 7
    group by mem.group_id
  ),
  pend as (
    select mem.group_id as gid, count(*) as n
    from homework_submissions hs
    join members mem on mem.student_id = hs.user_id
    where hs.score is null
    group by mem.group_id
  )
  select gs.id, gs.name, gs.course_name,
         (select count(*)::int from members where group_id = gs.id),
         coalesce((select n from act where gid = gs.id), 0)::int,
         coalesce((select round(avg(d.n_done * 100.0 / nullif(cl.n, 0)))::int
                   from done d join course_lessons cl on cl.gid = gs.id
                   where d.gid = gs.id), 0),
         coalesce((select n from pend where gid = gs.id), 0)::int
  from gs
  order by gs.name;
$function$
;
CREATE OR REPLACE FUNCTION public.teacher_group_ids(_uid uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select id from public.groups where teacher_id = _uid
  union
  select group_id from public.group_teachers where teacher_id = _uid;
$function$
;
CREATE OR REPLACE FUNCTION public.is_group_teacher(_group_id uuid, _uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from public.groups g where g.id = _group_id and g.teacher_id = _uid)
      or exists (select 1 from public.group_teachers gt where gt.group_id = _group_id and gt.teacher_id = _uid);
$function$
;
CREATE OR REPLACE FUNCTION public.hw_dm_fallback_deliver()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  _tok text;
  _row record;
  _sent int := 0;
  _tash_hour int := extract(hour from now() + interval '5 hours')::int;
  _admin record;
begin
  -- Respect quiet hours: the fallback never pings a teacher at night either.
  if _tash_hour >= 22 or _tash_hour < 8 then return 0; end if;

  select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
  if _tok is null or _tok = '' then return 0; end if;

  for _row in
    select q.id, q.student_name, q.module_number, q.task_number, q.assignment_title,
           q.message_url, q.submission_id, t.telegram_id, t.preferred_locale
    from homework_teacher_dm_queue q
    join groups g on g.id = q.group_id and public.is_group_teacher(q.group_id, q.teacher_id)  -- RBAC: still assigned
    join profiles t on t.id = q.teacher_id
      and t.telegram_id is not null and t.notifications_enabled is distinct from false
    where q.sent_at is null
      and q.scheduled_for < now() - interval '15 minutes'  -- primary path has clearly failed
    order by q.scheduled_for
    limit 50
  loop
    begin
      perform public.ops_net_post(p_purpose := 'hw_dm_fallback_deliver', 
        p_url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
        p_headers := jsonb_build_object('Content-Type', 'application/json'),
        p_body := jsonb_build_object(
          'chat_id', _row.telegram_id,
          'parse_mode', 'HTML',
          'text', '📝 <b>Yangi topshiriq</b>' || E'\n\n<b>'
                  || replace(replace(replace(coalesce(_row.student_name, '—'), '&','&amp;'), '<','&lt;'), '>','&gt;')
                  || '</b> Modul ' || _row.module_number || ' · Vazifa ' || _row.task_number
                  || ' ni topshirdi' || case when coalesce(_row.assignment_title,'') <> ''
                       then E'\n«' || replace(replace(replace(_row.assignment_title, '&','&amp;'), '<','&lt;'), '>','&gt;') || '»' else '' end,
          'reply_markup', jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array(
            jsonb_build_object('text', '📂 Postni ko''rish', 'url', _row.message_url),
            jsonb_build_object('text', '🎯 Baholash', 'callback_data', 'gs:open:' || _row.submission_id)
          )))
        )
      );
      update homework_teacher_dm_queue
        set sent_at = now(), error = 'sql_fallback_delivery' where id = _row.id;
      _sent := _sent + 1;
    exception when others then
      update homework_teacher_dm_queue
        set error = 'sql_fallback_err: ' || left(sqlerrm, 200) where id = _row.id;
    end;
  end loop;

  -- If the fallback had to act, the primary path is sick — tell the admins (max 1 alert / 2h).
  if _sent > 0 and not exists (
    select 1 from notifications_log
    where notification_type = 'hw_dm_fallback' and sent_at > now() - interval '2 hours'
  ) then
    for _admin in
      select distinct p.id, p.telegram_id from profiles p
      join user_roles r on r.user_id = p.id and r.role in ('admin','superadmin')
      where p.telegram_id is not null limit 3
    loop
      begin
        perform public.ops_net_post(p_purpose := 'hw_dm_fallback_deliver', 
          p_url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
          p_headers := jsonb_build_object('Content-Type', 'application/json'),
          p_body := jsonb_build_object('chat_id', _admin.telegram_id,
            'text', '🛟 Zaxira kanal ' || _sent || ' ta o''qituvchi DM yetkazdi — asosiy drainer (notify-homework-submission) ishlamayapti. Tekshiring.'));
        insert into notifications_log (user_id, notification_type, sent_at)
        values (_admin.id, 'hw_dm_fallback', now());
        exit; -- one log row is enough for the rate-limit
      exception when others then null;
      end;
    end loop;
  end if;

  return _sent;
end;
$function$
;
