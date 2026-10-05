-- Challenge 6.0: «KUNLIK VAZIFALAR» becomes «QOʻSHIMCHA VAZIFALAR» — a task every other day (owner, 2026-10-05).
--
-- WHY: a task every day was too much and confused students. NEW RULES:
--   * a task is posted Monday, Wednesday and Friday at 09:00 (task_weekdays [1,3,5]);
--   * it is ON TIME until 23:59 of the NEXT day (Monday's task → Tuesday 23:59, Friday's → Saturday 23:59), full points;
--   * after that it is closed (no half-point late window any more), so only ONE task is ever open;
--   * three practical tasks a week; the topic is renamed (in Telegram, by the owner) to «QOʻSHIMCHA VAZIFALAR».
--
-- HOW (engine): one new setting, challenge_tasks.grace_days (0..6, default 0 = the old behaviour), and three helpers:
--   challenge_task_grace_days(cfg), challenge_task_window_days(cfg) = grace_days + late_days, and
--   challenge_task_late_days(task_date, day, cfg) = the days PAST THE DEADLINE (0 while inside the grace).
-- submissions.late_days keeps its meaning "0 = on time", so everything that reads it — points, the streak, the 🔥
-- reaction, the summary's on-time count — is unchanged. Every place that computed "day − task_date" or a window of
-- late_days is patched to the helpers, by a PINNED rewrite of the reviewed live text (md5 of each body; each anchor
-- asserted to occur exactly the expected number of times; owner / ACL / SECURITY DEFINER asserted unchanged):
--   close_at, capture, capture_miniapp, move_core, payload (+ task.rel_days for the receipt label), prepare_miniapp,
--   capture's "today's slot" (= still on time, so a text-only answer the next day is not dropped), the Mini App's
--   'late' flag, tick (window + 'due_date' in the morning / evening DMs), post_claim ('due_date' in the 20:00 summary), and the
--   config validator (accepts grace_days).
-- The post layout (challenge_task_render_post_text, replaced whole, pinned): «N-QOʻSHIMCHA VAZIFA» header, the real
-- deadline ("ertaga, 6-oktabr (seshanba) 23:59 gacha"), the late line only while a late window exists, and the
-- «QOʻSHIMCHA VAZIFALAR» topic name. It now reads the settings, so it is STABLE instead of IMMUTABLE.
--
-- SCHEDULE: three practical tasks a week, Mon/Wed/Fri, all set to DRAFT for the owner to approve (Admin → Qoʻshimcha
-- vazifalar). Monday 10-05 (#2) is already posted and stays. Cancelled (never posted): #4 #7 #8 #9 #13 #14 #19 #20 #22
-- #24. Two bodies reworded where they pointed at a dropped task (#10, #23). Each task gets its image
-- /challenge/extra/task-N.jpg (N = its position; the header number is the live rank among APPROVED tasks).

-- ───────────────────────────── 1. helpers ─────────────────────────────
create or replace function public.challenge_task_grace_days(_cfg jsonb)
returns integer
language sql
immutable
set search_path = public
as $fn$
  -- 20261005112000: days after task_date that still count as ON TIME (0..6; absent / invalid = 0, the old rule)
  select least(greatest(coalesce(case when (_cfg->>'grace_days') ~ '^[0-9]{1,2}$' then (_cfg->>'grace_days')::int end, 0), 0), 6)
$fn$;

create or replace function public.challenge_task_window_days(_cfg jsonb)
returns integer
language sql
immutable
set search_path = public
as $fn$
  -- 20261005112000: how many days after task_date a task still accepts work (on time + late)
  select public.challenge_task_grace_days(_cfg) + coalesce((_cfg->>'late_days')::int, 2)
$fn$;

create or replace function public.challenge_task_late_days(_task_date date, _d date, _cfg jsonb)
returns integer
language sql
immutable
set search_path = public
as $fn$
  -- 20261005112000: days PAST THE DEADLINE (task_date + grace_days). 0 = on time. A day before task_date stays negative
  -- (callers treat that as "not open yet"), exactly as the old "_d - task_date".
  select case when _d is null or _task_date is null then null
              when _d - _task_date <= 0 then _d - _task_date
              else greatest(0, _d - _task_date - public.challenge_task_grace_days(_cfg)) end
$fn$;

revoke execute on function public.challenge_task_grace_days(jsonb) from public, anon, authenticated;
revoke execute on function public.challenge_task_window_days(jsonb) from public, anon, authenticated;
revoke execute on function public.challenge_task_late_days(date, date, jsonb) from public, anon, authenticated;
grant execute on function public.challenge_task_grace_days(jsonb) to service_role;
grant execute on function public.challenge_task_window_days(jsonb) to service_role;
grant execute on function public.challenge_task_late_days(date, date, jsonb) to service_role;

-- ───────────────────────────── 2. pinned patches ─────────────────────────────
create or replace function pg_temp.dt_patch(_sig text, _md5 text, _old text[], _new text[], _counts int[])
returns void
language plpgsql
as $fn$
declare
  _marker constant text := '20261005112000';
  _oid oid := to_regprocedure(_sig);
  _src text; _acl text; _owner oid; _secdef boolean; _def text; _n int; i int;
begin
  if _oid is null then raise exception 'ABORT: % is missing', _sig; end if;
  select prosrc, array_to_string(proacl, ','), proowner, prosecdef into _src, _acl, _owner, _secdef from pg_proc where oid = _oid;
  if position(_marker in _src) > 0 then
    raise notice '% already patched', _sig;
    return;
  end if;
  if md5(replace(_src, E'\r', '')) <> _md5 then
    raise exception 'ABORT: % is not the reviewed live text (md5 %)', _sig, md5(replace(_src, E'\r', ''));
  end if;
  _def := replace(pg_get_functiondef(_oid), E'\r', '');
  for i in 1 .. array_length(_old, 1) loop
    _n := (length(_def) - length(replace(_def, _old[i], ''))) / length(_old[i]);
    if _n <> _counts[i] then
      raise exception 'ABORT: %: anchor % occurs % times, expected %', _sig, i, _n, _counts[i];
    end if;
    _def := replace(_def, _old[i], _new[i]);
  end loop;
  if position(_marker in _def) = 0 then raise exception 'ABORT: %: no marker after the patch', _sig; end if;
  execute _def;
  if position(_marker in (select prosrc from pg_proc where oid = _oid)) = 0 then
    raise exception 'ABORT: % was not rewritten', _sig;
  end if;
  if (select array_to_string(proacl, ',') from pg_proc where oid = _oid) is distinct from _acl
     or (select proowner from pg_proc where oid = _oid) <> _owner
     or (select prosecdef from pg_proc where oid = _oid) is distinct from _secdef then
    raise exception 'ABORT: % changed its owner, ACL or SECURITY DEFINER', _sig;
  end if;
end
$fn$;

do $$
begin
  -- the config validator: accept grace_days (0..6, default 0)
  perform pg_temp.dt_patch('public.challenge_tasks_config()', 'd40ab1725851c424bcde075fef3c574e',
    array['_ints constant jsonb := ''{"late_days":[2,0,7],'],
    array['_ints constant jsonb := /* 20261005112000: + grace_days */ ''{"late_days":[2,0,7],"grace_days":[0,0,6],'],
    array[1]);

  -- close_at = task_date + grace_days + late_days + 1 (Tashkent midnight)
  perform pg_temp.dt_patch('public.challenge_task_close_at(public.challenge_tasks, jsonb)', 'c70dff14c1e0f75ae0fff84d1d6bd35b',
    array['On time = by 23:59 of task_date.',
          '(_t.task_date + coalesce((_cfg->>''late_days'')::int, 2) + 1)'],
    array['On time = by 23:59 of task_date + grace_days (20261005112000).',
          '(_t.task_date + public.challenge_task_window_days(_cfg) + 1)'],
    array[1, 1]);

  -- capture: the slot window and the stored late_days
  perform pg_temp.dt_patch('public.challenge_task_capture(jsonb, text, jsonb)', '226e33fb8a26cfd065bbd44fd3336366',
    array['_d - _create_task.task_date,',
          'and t.task_date between _d - coalesce((_cfg->>''late_days'')::int, 2) and _d',
          '(t.task_date = _d) as is_today,'],
    array['public.challenge_task_late_days(_create_task.task_date, _d, _cfg),',
          'and t.task_date between _d - public.challenge_task_window_days(_cfg) and _d  -- 20261005112000: + grace_days',
          '(public.challenge_task_late_days(t.task_date, _d, _cfg) = 0) as is_today,  -- 20261005112000: on time = today''s slot'],
    array[1, 1, 1]);

  perform pg_temp.dt_patch('public.challenge_task_capture_miniapp(uuid, bigint, text, timestamp with time zone, jsonb)',
    'd5c4fd21e6da3a7f60c9dd9979350a12',
    array['public.challenge_task_local_date(_ts) - _t.task_date, 1 + _rej'],
    array['public.challenge_task_late_days(_t.task_date, public.challenge_task_local_date(_ts), _cfg) /* 20261005112000 */, 1 + _rej'],
    array[1]);

  perform pg_temp.dt_patch((select p.oid::regprocedure::text from pg_proc p where p.proname = 'challenge_task_move_core' and p.pronamespace = 'public'::regnamespace),
    '1c57363484560cf69d586a848059408d',
    array['_late := _d0 - _to.task_date;',
          'late_days = public.challenge_task_local_date(least(submitted_at, _s.submitted_at)) - _to.task_date,'],
    array['_late := public.challenge_task_late_days(_to.task_date, _d0, _cfg);  -- 20261005112000: days past the deadline',
          'late_days = public.challenge_task_late_days(_to.task_date, public.challenge_task_local_date(least(submitted_at, _s.submitted_at)), _cfg),'],
    array[1, 1]);

  -- payload: the alternatives window; task.rel_days (calendar days from task_date to the first post) for the label
  perform pg_temp.dt_patch((select p.oid::regprocedure::text from pg_proc p where p.proname = 'challenge_task_payload' and p.pronamespace = 'public'::regnamespace),
    '379c13ea13adb69feadbc25a8d69c9e5',
    array['and x.task_date >= _d0 - coalesce((_cfg->>''late_days'')::int, 2);',
          '''type'', _t.type, ''title'', _t.title)),'],
    array['and x.task_date >= _d0 - public.challenge_task_window_days(_cfg);  -- 20261005112000: + grace_days',
          '''type'', _t.type, ''title'', _t.title,' || E'\n'
          || '                                 ''rel_days'', public.challenge_task_local_date(_s.submitted_at) - _t.task_date)),'],
    array[1, 1]);

  perform pg_temp.dt_patch((select p.oid::regprocedure::text from pg_proc p where p.proname = 'challenge_task_prepare_miniapp' and p.pronamespace = 'public'::regnamespace),
    '86fbda0f5da09b2c4fba455db2fb0573',
    array['public.challenge_task_local_date(_now) - _t.task_date',
          '''late'', t.task_date < public.challenge_task_local_date(_now))'],
    array['public.challenge_task_late_days(_t.task_date, public.challenge_task_local_date(_now), _cfg) /* 20261005112000 */',
          '''late'', public.challenge_task_late_days(t.task_date, public.challenge_task_local_date(_now), _cfg) > 0)'],
    array[2, 1]);

  -- tick: the open-task window, the late_days / points of a pending task, and the deadline in the DMs
  perform pg_temp.dt_patch('public.challenge_tasks_tick()', 'd5cc2f601896ce1713002b207bb6c745',
    array['_late int := coalesce((_cfg->>''late_days'')::int, 2);',
          'public.challenge_task_points_for(t, _today - t.task_date, _cfg) as points',
          '''type'', x.type, ''late_days'', _today - x.task_date,',
          '''title'', tt.title, ''points'', tt.points, ''late_points'', tt.late_points,'],
    array['_late int := public.challenge_task_window_days(_cfg);  -- 20261005112000: grace_days + late_days',
          'public.challenge_task_points_for(t, public.challenge_task_late_days(t.task_date, _today, _cfg), _cfg) as points',
          '''type'', x.type, ''late_days'', public.challenge_task_late_days(x.task_date, _today, _cfg),' || E'\n'
          || '                                                                        ''due_date'', x.task_date + public.challenge_task_grace_days(_cfg),',
          '''title'', tt.title, ''points'', tt.points, ''late_points'', tt.late_points,' || E'\n'
          || '                                ''due_date'', tt.task_date + public.challenge_task_grace_days(_cfg),'],
    array[1, 1, 1, 1]);

  -- post_claim: the 20:00 summary says until when the task is open
  perform pg_temp.dt_patch((select p.oid::regprocedure::text from pg_proc p where p.proname = 'challenge_task_post_claim' and p.pronamespace = 'public'::regnamespace),
    '3f27978c0361778ef5dc78896f829e83',
    array['''task_date'', (select t.task_date from public.challenge_tasks t where t.id = _r.task_id))'],
    array['''task_date'', (select t.task_date from public.challenge_tasks t where t.id = _r.task_id),' || E'\n'
          || '                 ''due_date'', (select t.task_date + public.challenge_task_grace_days(_cfg) /* 20261005112000 */'
          || ' from public.challenge_tasks t where t.id = _r.task_id))'],
    array[1]);
end $$;

-- ───────────────────────────── 3. the post layout ─────────────────────────────
do $$
declare
  _md5 text;
begin
  select md5(replace(prosrc, E'\r', '')) into _md5 from pg_proc
   where oid = to_regprocedure('public.challenge_task_render_post_text(text, text, text, text, text, integer, integer, integer, integer, date, text)');
  if _md5 is null then
    raise exception 'ABORT: challenge_task_render_post_text(...) is missing';
  end if;
  if _md5 <> 'da11682d292942a5ba15c265ab888047'
     and not exists (select 1 from pg_proc where proname = 'challenge_task_render_post_text' and prosrc like '%QOʻSHIMCHA VAZIFA%') then
    raise exception 'ABORT: challenge_task_render_post_text is not the reviewed live text (md5 %)', _md5;
  end if;
end $$;

create or replace function public.challenge_task_render_post_text(_type text, _title text, _body text, _learn text, _hint text,
  _minutes integer, _points integer, _late_points integer, _day_no integer, _task_date date, _tag_handle text)
returns text
language sql
stable
set search_path to 'public'
as $function$
  -- The task post as Telegram HTML (parse_mode HTML). 20261005112000: «QOʻSHIMCHA VAZIFALAR» (was KUNLIK VAZIFALAR), a
  -- task every other day: the deadline is task_date + grace_days 23:59 ("ertaga, 6-oktabr (seshanba) 23:59 gacha"),
  -- and the late line shows only while a late window exists. Reads the settings, hence STABLE. Only <b>, <blockquote>
  -- and the three entities &amp; &lt; &gt; are produced; every user text is escaped. challenge_tasks_guard measures
  -- THIS text (<= 4000, G29); the worker posts it as a photo caption when it fits 1024 visible characters.
  with cfg as (
    select public.challenge_tasks_config() as c
  ), k as (
    select _task_date + public.challenge_task_grace_days(cfg.c) as due,
           coalesce((cfg.c->>'late_days')::int, 2) as late
      from cfg
  ), e as (
    select replace(replace(replace(btrim(coalesce(_title, ''), E' \t\r\n'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') as title,
           replace(replace(replace(btrim(replace(coalesce(_body, ''), E'\r', ''), E' \t\r\n'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') as body,
           nullif(replace(replace(replace(btrim(regexp_replace(replace(coalesce(_learn, ''), E'\r', ''), '^[[:space:]]*Nimani[[:space:]]+o.?rganasiz[[:space:]]*:[[:space:]]*', '', 'i'), E' \t\r\n'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '') as learn,
           nullif(replace(replace(replace(btrim(regexp_replace(replace(coalesce(_hint, ''), E'\r', ''), '^[[:space:]]*Topshirish[[:space:]]*:[[:space:]]*', '', 'i'), E' \t\r\n'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '') as hint,
           nullif(replace(replace(replace(btrim(coalesce(_tag_handle, ''), E' \t\r\n@'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '') as tag
  )
  select concat_ws(E'\n',
           '📌 <b>' || coalesce(_day_no::text || '-QOʻSHIMCHA VAZIFA', 'QOʻSHIMCHA VAZIFA') || '</b>'
             || coalesce(' · ' || extract(day from _task_date)::int::text || '-'
                  || (array['yanvar','fevral','mart','aprel','may','iyun','iyul','avgust','sentabr','oktabr','noyabr','dekabr'])[extract(month from _task_date)::int]
                  || ', ' || (array['dushanba','seshanba','chorshanba','payshanba','juma','shanba','yakshanba'])[extract(isodow from _task_date)::int], ''),
           '🎯 <b>' || e.title || '</b>',
           '',
           e.body,
           '',
           case when e.hint is not null then '📎 <b>Topshirish:</b> ' || e.hint end,
           case when e.learn is not null then '<blockquote>💡 <b>Nimani oʻrganasiz:</b> ' || e.learn || '</blockquote>' end,
           case when _type = 'instagram' then '📸 Postda <b>@' || coalesce(e.tag, 'aicreators.students') || '</b> ni belgilang.' end,
           '',
           case when _minutes is not null then '⏱ ~' || _minutes::text || ' daqiqa · ' else '' end
             || '🏆 <b>+' || coalesce(_points, 0)::text || ' ball</b> — '
             || case when _task_date is null or k.due is null or k.due <= _task_date then '<b>bugun 23:59</b> gacha'
                     else '<b>' || case when k.due - _task_date = 1 then 'ertaga, ' else '' end
                          || extract(day from k.due)::int::text || '-'
                          || (array['yanvar','fevral','mart','aprel','may','iyun','iyul','avgust','sentabr','oktabr','noyabr','dekabr'])[extract(month from k.due)::int]
                          || ' (' || (array['dushanba','seshanba','chorshanba','payshanba','juma','shanba','yakshanba'])[extract(isodow from k.due)::int]
                          || ') 23:59</b> gacha' end,
           case when k.late > 0 then '⌛ Kechiksa (' || k.late::text || ' kungacha): <b>+' || coalesce(_late_points, 0)::text || ' ball</b>' end,
           '📍 Faqat shu <b>«QOʻSHIMCHA VAZIFALAR»</b> topigiga yuboring.')
    from e, k
$function$;

revoke execute on function public.challenge_task_render_post_text(text, text, text, text, text, integer, integer, integer, integer, date, text)
  from public, anon, authenticated;
grant execute on function public.challenge_task_render_post_text(text, text, text, text, text, integer, integer, integer, integer, date, text)
  to service_role;

-- ───────────────────────────── 4. the settings ─────────────────────────────
update public.platform_settings
   set value = value || jsonb_build_object('task_weekdays', jsonb_build_array(1, 3, 5), 'grace_days', 1, 'late_days', 0)
 where key = 'challenge_tasks'
   and not exists (select 1 from public.admin_actions where action = 'challenge_tasks_rescheduled'
                    and details->>'marker' = '20261005112000');

do $$
declare
  _c jsonb := public.challenge_tasks_config();
begin
  if exists (select 1 from public.admin_actions where action = 'challenge_tasks_rescheduled'
              and details->>'marker' = '20261005112000') then
    return;
  end if;
  if (_c->>'grace_days')::int is distinct from 1 or (_c->>'late_days')::int is distinct from 0
     or _c->'task_weekdays' is distinct from '[1, 3, 5]'::jsonb then
    raise exception 'ABORT: the task settings did not take (grace %, late %, weekdays %)',
      _c->>'grace_days', _c->>'late_days', _c->'task_weekdays';
  end if;
  -- the engine reads them as intended: Monday's task closes at Wednesday 00:00, on time all of Tuesday
  if public.challenge_task_window_days(_c) <> 1
     or public.challenge_task_late_days(date '2026-10-05', date '2026-10-06', _c) <> 0
     or public.challenge_task_late_days(date '2026-10-05', date '2026-10-05', _c) <> 0 then
    raise exception 'ABORT: the grace helpers disagree with the settings';
  end if;
end $$;

-- ───────────────────────────── 5. the schedule ─────────────────────────────
do $$
declare
  _course constant uuid := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _r record;
  _len int;
begin
  if exists (select 1 from public.admin_actions where action = 'challenge_tasks_rescheduled' and details->>'marker' = '20261005112000') then
    raise notice 'schedule already applied';
    return;
  end if;
  -- nothing below may touch a posted task (only #2 is posted, and it stays as it is)
  if exists (select 1 from public.challenge_task_posts p
              where p.task_id in (4, 7, 8, 9, 13, 14, 19, 20, 22, 24, 6, 10, 26, 11, 12, 15, 16, 17, 18, 21, 23, 25)
                and p.state in ('sent', 'sent_via_sql', 'manual')) then
    raise exception 'ABORT: a task to reschedule was already posted';
  end if;
  if exists (select 1 from public.challenge_task_submissions s
              where s.task_id in (4, 7, 8, 9, 13, 14, 19, 20, 22, 24, 6, 10, 26, 11, 12, 15, 16, 17, 18, 21, 23, 25)
                and s.status in ('needs_more', 'checking', 'accepted')) then
    raise exception 'ABORT: a task to reschedule has live submissions';
  end if;

  update public.challenge_tasks set status = 'cancelled'
   where course_id = _course and id in (4, 7, 8, 9, 13, 14, 19, 20, 22, 24) and status <> 'cancelled';

  -- reworded where the old text pointed at a dropped task
  update public.challenge_tasks
     set body = E'1️⃣ Uydagi buyumni (krujka, atir, krossovka yoki oʻz mahsulotingiz) telefonda suratga oling.\n'
             || E'2️⃣ Uni ChatGPT yoki Nano Bananaʼga yuklang. Promptga eng yaxshi yorugʻlik retseptingizni (chorshanbadagi vazifadan) qoʻshing va yozing: «shakli, rangi va yozuvlarini oʻzgartirma».\n'
             || '3️⃣ «Telefon surati → AI reklama» karuselini Instagramʼga joylang. Captionʼda ishlatgan promptingizni yozing.'
   where id = 10 and course_id = _course;
  update public.challenge_tasks
     set body = replace(body, '1-kundagi paketlardan birini', 'paketlaringizdan birini'),
         learn_line = replace(learn_line, '5-kundagi xabarlaringizda', 'keyingi vazifadagi xabarlaringizda')
   where id = 23 and course_id = _course;

  -- ascending new dates: each target date is free by the time it is taken (uq_challenge_tasks_course_date)
  for _r in
    select * from (values
      (6::bigint, date '2026-10-07', 2), (10, date '2026-10-09', 3), (26, date '2026-10-12', 4),
      (11, date '2026-10-14', 5), (12, date '2026-10-16', 6), (15, date '2026-10-19', 7),
      (16, date '2026-10-21', 8), (17, date '2026-10-23', 9), (18, date '2026-10-26', 10),
      (21, date '2026-10-28', 11), (23, date '2026-10-30', 12), (25, date '2026-11-02', 13)
    ) v(id, d, n)
    order by d
  loop
    update public.challenge_tasks
       set task_date = _r.d, status = 'draft',
           image_url = 'https://www.aicreator.academy/challenge/extra/task-' || _r.n::text || '.jpg'
     where id = _r.id and course_id = _course;
    if not found then
      raise exception 'ABORT: task #% is not a course-6.0 task', _r.id;
    end if;
    select public.challenge_task_post_length(public.challenge_task_render_post(t)) into _len
      from public.challenge_tasks t where t.id = _r.id;
    if _len > 980 then
      raise exception 'ABORT: task #% post is % characters — too long for a photo caption (<= 980 kept as margin)', _r.id, _len;
    end if;
  end loop;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'challenge_tasks_rescheduled', jsonb_build_object(
    'marker', '20261005112000', 'rule', 'Mon/Wed/Fri 09:00, on time until next day 23:59, no late window',
    'kept_posted', jsonb_build_array(2),
    'cancelled', jsonb_build_array(4, 7, 8, 9, 13, 14, 19, 20, 22, 24),
    'drafts_for_approval', jsonb_build_array(6, 10, 26, 11, 12, 15, 16, 17, 18, 21, 23, 25), 'at', now()));
end $$;
