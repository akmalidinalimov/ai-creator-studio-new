-- Daily tasks: module 1 gets two days, module 2 starts Wednesday and is approved (owner request, 2026-10-03).
--
-- THE OWNER'S PLAN
--   Module 1 (ChatGPT, four short lessons) is too short for a whole week of tasks:
--     Mon 10-05, Tue 10-06  -> module 1, the two most practical of the five approved week-1 tasks
--     Wed 10-07 .. Sat 10-10, Mon 10-12, Tue 10-13 -> module 2 (AI images), six tasks
--   Students already created a ChatGPT Project in their homework, so the Project tasks are dropped.
--
-- MODULE 1: kept, moved
--   #2 "Shaxsiy prompt shabloningiz" (lesson 1.2, prompt engineering)  10-06 -> 10-05
--       It also starts the "Retseptlar kitobi" that the module 2 and 3 tasks add recipes to.
--   #4 "Work rejimi: raqobatchilar jadvali" (lesson 1.4, Work mode)       10-08 -> 10-06
--   Both stay APPROVED: the guard keeps the original approval stamp on an edit.
-- MODULE 1: cancelled (nothing was posted or submitted, so a cancel pays nothing and loses nothing)
--   #1 "ChatGPTʼni oʻzingizga moslang" (10-05)   #3 "Brendingiz uchun Project" (10-07)
--   #5 "Tanishuv posti: captionʼni Project yozadi" (10-09, built on the Project)
--
-- MODULE 2: the five drafted image tasks, re-dated into lesson order, plus one new task. The owner asked for the two
-- Instagram tasks on Friday and Monday (Tuesday's moved to Monday) and asked for all of module 2 to be APPROVED
-- here (2026-10-03). The guard re-checks every approval rule (scope, window, requires, post length); approved_by
-- is NULL because a migration has no signed-in user, and the audit row names the owner's request.
--   Wed 10-07  #6  Yorugʻlik mashqi            (lesson 2.8)                 was 10-12
--   Thu 10-08  #8  Obyektiv va fon 35/85mm      (lessons 2.9-2.11)           was 10-14
--   Fri 10-09  #7  Kamera burchagi karusel (IG) (lessons 2.9-2.11)           was 10-13
--   Sat 10-10  #9  Plastikdan haqiqiy suratga   (lesson 2.8)                 was 10-15
--   Mon 10-12  #10 Telefon suratidan reklama (IG)                           was 10-16
--   Tue 10-13  NEW Personaj varaqasi            (lesson 2.6, character sheet)
--   Two wording fixes: #6 names Syntx too (the course teaches Higgsfield and Syntx), and #10 says "2-moduldagi"
--   recipes instead of "shu haftadagi", because by Monday those recipes are from the previous week.
--
-- SATURDAY: challenge_task_is_task_day() counts any date that carries an APPROVED task, and posting selects the
-- approved task of the day without a weekday filter. So Saturday 10-10 posts (#9 is approved below), and
-- task_weekdays stays [1..5] (adding 6 would make every future Saturday a "task day" that alarms when empty).
--
-- NOT DONE HERE: 10-14 .. 10-16 now have no task. Module 3 (video) needs scheduling from Wednesday 10-14; its
-- drafts are still on 10-19 .. 10-23.
--
-- SAFETY: each task is pinned to its live (date, status, title) and the migration refuses if any differs.
-- Replay-safe: a second run finds the new layout and changes nothing.

do $$
declare
  _course constant uuid := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _r record;
  _n int;
begin
  -- replay: already applied
  if exists (select 1 from public.admin_actions where action = 'challenge_tasks_rescheduled' and details->>'migration' = '20261003190000') then
    raise notice 'already applied';
    return;
  end if;

  -- nothing may have been posted or submitted for these tasks
  if exists (select 1 from public.challenge_task_posts p where p.task_id in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10))
     or exists (select 1 from public.challenge_task_submissions s where s.task_id in (1, 2, 3, 4, 5, 6, 7, 8, 9, 10)) then
    raise exception 'ABORT: a task in this reshuffle was already posted or has submissions';
  end if;

  -- pins: the live rows must be exactly what was reviewed on 2026-10-03
  for _r in
    select * from (values
      (1::bigint, date '2026-10-05', 'approved', 'ChatGPTʼni oʻzingizga moslang'),
      (2, date '2026-10-06', 'approved', 'Shaxsiy prompt shabloningiz'),
      (3, date '2026-10-07', 'approved', 'Brendingiz uchun Project'),
      (4, date '2026-10-08', 'approved', 'Work rejimi: raqobatchilar jadvali'),
      (5, date '2026-10-09', 'approved', 'Tanishuv posti: captionʼni Project yozadi'),
      (6, date '2026-10-12', 'draft', 'Yorugʻlik mashqi: 1 sahna, 3 xil yorugʻlik'),
      (7, date '2026-10-13', 'draft', 'Kamera burchagi: 4 rasmli karusel'),
      (8, date '2026-10-14', 'draft', 'Obyektiv va fon: 35mm yoki 85mm'),
      (9, date '2026-10-15', 'draft', 'Plastik koʻrinishdan haqiqiy suratga'),
      (10, date '2026-10-16', 'draft', 'Telefon suratidan reklama suratiga')
    ) v(id, d, st, title)
  loop
    if not exists (select 1 from public.challenge_tasks t
                    where t.id = _r.id and t.course_id = _course and t.task_date = _r.d and t.status = _r.st and t.title = _r.title) then
      raise exception 'ABORT: task #% is not the reviewed row (% / % / %)', _r.id, _r.d, _r.st, _r.title;
    end if;
  end loop;
  if exists (select 1 from public.challenge_tasks where course_id = _course and status <> 'cancelled'
              and task_date in (date '2026-10-10') ) then
    raise exception 'ABORT: Saturday 2026-10-10 already has a task';
  end if;

  -- 1. module 1: cancel three, then move the two kept ones into Mon/Tue (order frees each date before it is used)
  update public.challenge_tasks set status = 'cancelled' where id in (1, 3, 5);
  update public.challenge_tasks set task_date = date '2026-10-05' where id = 2;
  update public.challenge_tasks set task_date = date '2026-10-06' where id = 4;

  -- 2. module 2: re-date the drafts (each target date is free by now)
  update public.challenge_tasks set task_date = date '2026-10-07' where id = 6;   -- lighting
  update public.challenge_tasks set task_date = date '2026-10-08' where id = 8;   -- lens
  update public.challenge_tasks set task_date = date '2026-10-09' where id = 7;   -- angle carousel (IG)
  update public.challenge_tasks set task_date = date '2026-10-10' where id = 9;   -- realism (Saturday)
  update public.challenge_tasks set task_date = date '2026-10-12' where id = 10;  -- phone photo -> ad (IG), Monday

  -- wording: name the course's own tools, and point Tuesday at the module's recipes, not "this week's"
  update public.challenge_tasks
     set body = replace(body, 'Bitta promptni bitta vositada — ChatGPT, Nano Banana (Gemini) yoki Higgsfieldʼda —',
                              'Bitta promptni bitta vositada — Higgsfield, Syntx, ChatGPT yoki Nano Banana (Gemini)ʼda —')
   where id = 6;
  update public.challenge_tasks
     set body = replace(body, 'shu haftadagi eng yaxshi yorugʻlik, burchak va obyektiv retseptlaringizdan',
                              '2-moduldagi eng yaxshi yorugʻlik, burchak va obyektiv retseptlaringizdan')
   where id = 10;
  if not exists (select 1 from public.challenge_tasks where id = 6 and body like '%Higgsfield, Syntx, ChatGPT%')
     or not exists (select 1 from public.challenge_tasks where id = 10 and body like '%2-moduldagi eng yaxshi%') then
    raise exception 'ABORT: a wording fix did not match the live text';
  end if;

  -- 3. module 2, new: the character-sheet lesson (2.6) had no task
  insert into public.challenge_tasks (course_id, task_date, type, title, body, learn_line, submit_hint, accepts, requires,
                                      minutes, check_rubric, status, source, plan_ref, plan_format)
  values (_course, date '2026-10-13', 'general',
    'Personaj varaqasi: bitta qahramon, 2 ta sahna',
    'Brendingiz yoki kontentingiz uchun bitta doimiy qahramon oʻylab toping (masalan, kafe uchun “barista Aziz” yoki doʻkoningiz uchun model). '
    || 'Darsdagi usul bilan Higgsfield, Syntx yoki Nano Bananaʼda uning personaj varaqasini (character sheet) yarating: old, yon va orqa koʻrinish hamda 2–3 xil yuz ifodasi bitta rasmda. '
    || 'Keyin shu varaqni reference qilib, qahramonni 2 xil sahnaga joylashtiring (masalan, ish joyida va koʻchada) — yuzi va kiyimi oʻzgarmasin. '
    || 'Yuz oʻzgarib qolsa, darsdagi tuzatish usulini qoʻllang va ishlagan promptni Retseptlar kitobingizga yozing.',
    'Nimani oʻrganasiz: bitta qahramonni har xil sahnada bir xil saqlashni — brend maskoti, reklama modeli yoki seriyali kontent uchun yuzi oʻzgarmaydigan doimiy personajingiz boʻladi.',
    'Topshirish: personaj varaqasi + shu qahramon tushgan 2 ta sahna rasmi + ishlatgan promptingiz.',
    array['text', 'photo', 'document'],
    '[{"any": ["photo", "image_doc"], "min": 1, "label": "screenshot"}, {"any": ["text"], "min": 1, "label": "text"}]'::jsonb,
    20,
    'Three parts: (1) a character sheet image showing one character from several angles (front/side/back) and/or several facial expressions; (2) two scene images in which the same character (same face, hair and outfit) appears in different settings; (3) the prompt text used. Reject if the character sheet is missing, only one scene is sent, the face or outfit clearly changes between images, or no prompt is written. Quality is not graded strictly; watermarks are fine.',
    'draft', 'manual', 'M2-character', 'image (3) + text');

  -- 4. approve module 2 (owner's request). The guard validates each row and raises on any problem.
  update public.challenge_tasks set status = 'approved'
   where course_id = _course and status = 'draft'
     and task_date in (date '2026-10-07', date '2026-10-08', date '2026-10-09', date '2026-10-10',
                       date '2026-10-12', date '2026-10-13');

  -- 5. the end state the owner asked for
  select count(*) into _n from public.challenge_tasks
   where course_id = _course and status <> 'cancelled'
     and task_date in (date '2026-10-05', date '2026-10-06', date '2026-10-07', date '2026-10-08', date '2026-10-09',
                       date '2026-10-10', date '2026-10-12', date '2026-10-13');
  if _n <> 8 then
    raise exception 'ABORT: expected 8 scheduled tasks on 10-05..10-13 (Sunday off), found %', _n;
  end if;
  if (select count(*) from public.challenge_tasks where course_id = _course and status = 'approved'
       and task_date in (date '2026-10-05', date '2026-10-06', date '2026-10-07', date '2026-10-08', date '2026-10-09',
                         date '2026-10-10', date '2026-10-12', date '2026-10-13')) <> 8 then
    raise exception 'ABORT: not all 8 tasks of 10-05..10-13 are approved';
  end if;
  -- Instagram on Friday and Monday, as the owner asked
  if (select string_agg(to_char(task_date, 'MM-DD'), ',' order by task_date) from public.challenge_tasks
       where course_id = _course and status = 'approved' and type = 'instagram'
         and task_date between date '2026-10-05' and date '2026-10-13') is distinct from '10-09,10-12' then
    raise exception 'ABORT: module 2 Instagram tasks are not on Friday 10-09 and Monday 10-12';
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'challenge_tasks_rescheduled', jsonb_build_object(
    'migration', '20261003190000', 'at', now(),
    'module_1', jsonb_build_object('kept', jsonb_build_array(2, 4), 'cancelled', jsonb_build_array(1, 3, 5)),
    'module_2', jsonb_build_object('redated', jsonb_build_array(6, 8, 7, 9, 10),
                                   'new', (select id from public.challenge_tasks where course_id = _course and task_date = date '2026-10-13' and status <> 'cancelled'),
                                   'instagram_days', jsonb_build_array('2026-10-09', '2026-10-12'),
                                   'approved_on_owner_request', true),
    'why', 'owner: module 1 on Mon-Tue only, module 2 from Wednesday (Wed-Sat + Mon-Tue), Instagram on Fri and Mon, approve module 2; students already built a Project'));
end $$;
