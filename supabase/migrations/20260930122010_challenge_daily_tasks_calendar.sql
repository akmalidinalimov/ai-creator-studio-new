-- Challenge 6.0 daily tasks, PR-2: the task CALENDAR (build spec v2 §5). Inert: nothing here posts, awards, sends
-- or schedules anything -- the engine (PR-3) and the worker (PR-5) are what read these tables.
--
-- ═══ WHAT THIS DOES ═══
-- 1. public.challenge_tasks: one row per (course, Tashkent date). type general|instagram; title/body/learn line/
--    submit hint; accepts[] (what the bot may capture); requires jsonb (what MUST be sent: an AND of kind groups
--    {any: kinds[], min >= 1, label}, validated by the IMMUTABLE challenge_task_requires_valid CHECK -- G3);
--    min_text_chars / min_duration_sec / minutes / points override / check_rubric (the AI mezoni) / requires_tag;
--    status draft|approved|cancelled; source manual|import|ai_draft|retro; plan_ref + plan_format (the plan's own
--    format text, so the day drawer can flag a "(N)" the importer deliberately did not turn into a minimum).
--    UNIQUE (course_id, task_date) WHERE status <> 'cancelled': one live task per course per day (spec §5.1).
-- 2. public.challenge_task_posts (moved here from PR-3): one row per (task, group, kind task|summary) with the
--    posting state machine queued|sending|sent|failed|sent_via_sql|skipped|MANUAL. 'manual' = staff posted the
--    task by hand in the «Kunlik vazifalar» topic; the admin pastes that message's link in the day drawer, so a
--    student's reply to it targets the task (R3) and the retro backfill can attribute it (G8, G9). A message is
--    the post of at most one (task, group, kind): UNIQUE (chat_id, message_id).
-- 3. challenge_tasks_guard() v1 (BEFORE INSERT/UPDATE): keeps updated_at, created_by/at unforgeable; approving
--    (and every edit of an approved task) requires the course in challenge scope (course_ids / group_ids /
--    challenge_tasks.test_group_ids), task_date inside the challenge window DATES, requires consistent with the
--    type (instagram = a screenshot group + an ig_link group) and with accepts, and the rendered post <= 4000
--    UTF-16 units (G29); stamps approved_by/approved_at (and clears them on un-approve).
-- 4. The post renderer: challenge_task_render_post_text (IMMUTABLE, pure) + challenge_task_render_post(task) (day
--    number, points and late points from config). The guard measures the SAME function PR-5 will post with, via
--    challenge_task_post_length (UTF-16 code units -- how Telegram counts, and equal to JavaScript's String.length,
--    so the editor's counter and the guard can never disagree).
-- 5. Admin RPCs (has_role admin inside, authenticated EXECUTE): admin_challenge_task_preview(draft jsonb) for the
--    editor's live preview + counter; admin_challenge_tasks_import(course, items) -- the plan importer, drafts
--    only, skips plan_refs already in the calendar and dates already taken, atomic; admin_challenge_task_set_manual_post
--    (task, group, url) -- parses a topic message link, checks chat/topic against the group's daily topic and (when
--    the bot saw it) the message's real thread, refuses to overwrite a bot-sent post. Import and manual-post
--    changes write admin_actions rows (DB-visible).
-- 6. RLS: challenge_tasks -- admins read/insert/update, delete only a non-approved row; challenge_task_posts --
--    admins read (writes: the RPC above, and service_role for PR-5). No student policy anywhere.
--
-- ═══ VERIFIED LIVE, 2026-09-30 (read-only) ═══
-- * No challenge_task* table or function exists; no admin_challenge_* function exists.
-- * courses.id uuid; platform_settings.challenge: course_ids [f502f631… = AI CREATORS CHALLENGE 6.0], group_ids [],
--   window.start 2026-10-01T00:00+05, end null. Its 6 groups (1..6-GURUH) all have a «KUNLIK VAZIFALAR» topic
--   (PR-1 #220 linked 1..4, #221 registered 5 and 6).
-- * New public tables are born anon=arwdDxtm / authenticated=arwdDxtm (default privileges) -> every grant below is
--   explicit: REVOKE ALL from public, anon, authenticated first.
-- * has_role(uuid, app_role) is STABLE SECURITY DEFINER; RLS on groups/platform_settings is admin-only.
-- * PR-1 (20260930121000) is ledgered (12:59 UTC); this file still refuses to run without it (step 0).
-- * This name sorts BEFORE 20260930130549 (#221, ledgered 13:13 UTC): the slot was reserved for PR-2 before #221
--   existed. Neither file references anything the other creates, so replay order is irrelevant, and the deploy
--   pipeline applies the files a merge ADDS, whatever their names.
--
-- ═══ DEVIATIONS FROM THE SPEC (each argued) ═══
-- d1 Columns learn_line (the plan's learn_uz, <= 500) and plan_format (<= 200) are added: the post shows the
--    "Nimani o‘rganasiz" line, and the drawer needs the original format to flag "(N)" (§5.4 "the drawer flags it").
--    minutes (1..600) is the plan's time estimate, shown in the post.
-- d2 created_by / approved_by carry no FK: they are authorship stamps, never joined for gating, and must not make a
--    task undeletable or cascade away with a user. user_id FKs arrive with the engine tables (PR-3, G24).
-- d3 challenge_task_posts (chat_id, message_id) is UNIQUE (partial, message_id not null) rather than a plain index:
--    one Telegram message can be the post of only one task, so a reply can never target two tasks.
-- d4 challenge_task_posts.task_id is ON DELETE RESTRICT: a task that has a post row cannot vanish under it (the
--    delete policy already limits deletes to non-approved rows; the drawer clears manual links first).
-- d5 Delete is allowed only while status <> 'approved' (the spec says "admins get ALL"): an approved task is
--    cancelled, not deleted, so PR-3's submissions can never lose their task row.
-- d6 accepts is normalized to canonical order (only when every element is in the vocabulary; otherwise the CHECK
--    rejects it -- a bad kind is never silently dropped).
-- d7 "At most 4000 characters" is measured in UTF-16 code units on the HTML, tags included: stricter than
--    Telegram's own count (4096 after entity parsing), never looser. Every post carries 4-6 astral emoji.
-- d8 The post template itself is v1 (§10.3's topic line included). PR-3/PR-5 may CREATE OR REPLACE
--    challenge_task_render_post_text; the guard and the preview always measure whichever version is live.
-- d9 One live task per day is keyed WHERE status <> 'cancelled' (spec §5.1), not only among approved rows: it
--    implies one APPROVED task per day, and also stops a second import from stacking drafts on a taken day.
-- d10 This file was first written as 20260930122000; it is re-issued here (next reserved slot) only to name the
--    harness by its final file name. 20260930122000 was never merged or applied.
--
-- ═══ KILL-SWITCH / INERTNESS ═══
-- Nothing reads these tables until PR-3/PR-5, which stay behind platform_settings.challenge_tasks.enabled (false).
-- No cron, no outbound call, no trigger on any existing table.
--
-- ═══ DETECTION ═══
-- The approve guard is prevention by construction (an over-long or inconsistent task cannot be approved). Import
-- and manual-post changes write admin_actions ('challenge_tasks_imported', 'challenge_task_manual_post_set',
-- 'challenge_task_manual_post_cleared'). "No approved task for tomorrow" is shown as a red banner on the admin page
-- now; the DB alarm is PR-3's watchdog / PR-5's 18:00 check (task days only, G6).
--
-- SELF-TEST: non-mutating only -- pure fixtures (requires validator + consistency, message-link parser, renderer),
-- object / RLS / policy / index / trigger presence, ACLs, and that every already-approved task still renders
-- <= 4000. It never inserts, never calls an RPC that needs a JWT.
-- PGlite harness: supabase/functions/_challenge/testing/daily-tasks-calendar-check.ts applies #218, PR-1 and THIS
-- file, and checks the guard matrix, RLS as student/admin, grants, the TS mirrors (src/lib/dailyTasksPlan.ts), the
-- real 25-task plan importing and approving, the manual-post RPC, replay.
-- Merge: PR-1 (20260930121000) is ledgered, so this can merge now; label migration-approved, NEVER ops-agent.

-- ═══════════════════════════════ 0. Prerequisite: PR-1 ═══════════════════════════════
do $$
begin
  if to_regprocedure('public.challenge_task_topics()') is null
     or (select count(*) from information_schema.columns
          where table_schema = 'public' and table_name = 'groups'
            and column_name in ('daily_task_topic_id', 'daily_task_chat_id')) <> 2 then
    raise exception 'ABORT: 20260930121000 (Daily Tasks PR-1: groups.daily_task_topic_*) must be applied first';
  end if;
end $$;

-- ═══════════════════════════════ 1. Pure helpers (used by the CHECK and the guard) ═══════════════════════════════
create or replace function public.challenge_task_requires_valid(_r jsonb)
returns boolean
language plpgsql
immutable
set search_path = public
as $fn$
-- requires = [] (any one accepted item) or up to 8 groups {any: [distinct kinds, 1..11], min: integer 1..20,
-- label}. Exactly those three keys. Anything else -- including a string "1" or 1.5 for min -- is false, never an
-- error (a CHECK must answer, not raise).
declare
  _kinds constant text[] := array['text','photo','image_doc','video','video_doc','document','voice','video_note',
                                  'audio','link','ig_link'];
  _labels constant text[] := array['screenshot','video','file','text','link','ig_link','voice'];
  _g jsonb;
  _k jsonb;
  _seen text[];
begin
  if _r is null or jsonb_typeof(_r) <> 'array' or jsonb_array_length(_r) > 8 then
    return false;
  end if;
  for _g in select value from jsonb_array_elements(_r) loop
    if jsonb_typeof(_g) <> 'object' then
      return false;
    end if;
    if exists (select 1 from jsonb_object_keys(_g) k where k not in ('any', 'min', 'label')) then
      return false;
    end if;
    if jsonb_typeof(_g->'any') is distinct from 'array' then
      return false;
    end if;
    if jsonb_array_length(_g->'any') not between 1 and 11 then
      return false;
    end if;
    _seen := '{}';
    for _k in select value from jsonb_array_elements(_g->'any') loop
      if jsonb_typeof(_k) <> 'string' then
        return false;
      end if;
      if not ((_k #>> '{}') = any(_kinds)) or (_k #>> '{}') = any(_seen) then
        return false;
      end if;
      _seen := _seen || (_k #>> '{}');
    end loop;
    if jsonb_typeof(_g->'min') is distinct from 'number' then
      return false;
    end if;
    if (_g->>'min') !~ '^[0-9]{1,2}$' then
      return false;
    end if;
    if (_g->>'min')::int not between 1 and 20 then
      return false;
    end if;
    if jsonb_typeof(_g->'label') is distinct from 'string' then
      return false;
    end if;
    if not ((_g->>'label') = any(_labels)) then
      return false;
    end if;
  end loop;
  return true;
exception when others then
  return false;
end
$fn$;

comment on function public.challenge_task_requires_valid(jsonb) is
  'challenge_tasks.requires CHECK: [] or <= 8 groups {any: distinct kinds (text, photo, image_doc, video, video_doc, '
  'document, voice, video_note, audio, link, ig_link), min: int 1..20, label: screenshot|video|file|text|link|ig_link|voice}. '
  'Mirrored by requiresValid() in src/lib/dailyTasksPlan.ts.';

create or replace function public.challenge_task_requires_problem(_type text, _requires jsonb, _accepts text[])
returns text
language plpgsql
immutable
set search_path = public
as $fn$
-- NULL when requires is valid and consistent with the type and with accepts, else the approve guard's message.
-- Order (the TypeScript mirror requiresProblem keeps it): shape, ig_link on a general task, instagram needs a
-- screenshot-only group AND an ig_link-only group, every required kind is capturable (in accepts).
declare
  _g jsonb;
  _k text;
  _a text;
  _shot boolean := false;
  _ig boolean := false;
begin
  if not public.challenge_task_requires_valid(_requires) then
    return '«Nima yuborilishi shart» (requires) formati noto‘g‘ri';
  end if;
  if _type is distinct from 'instagram'
     and exists (select 1 from jsonb_array_elements(_requires) g, jsonb_array_elements_text(g->'any') k where k = 'ig_link') then
    return 'Instagram havolasi (ig_link) faqat Instagram vazifasida talab qilinadi';
  end if;
  if _type = 'instagram' then
    for _g in select value from jsonb_array_elements(_requires) loop
      if not exists (select 1 from jsonb_array_elements_text(_g->'any') k where k not in ('photo', 'image_doc')) then
        _shot := true;
      end if;
      if not exists (select 1 from jsonb_array_elements_text(_g->'any') k where k <> 'ig_link') then
        _ig := true;
      end if;
    end loop;
    if not (_shot and _ig) then
      return 'Instagram vazifasi skrinshot va Instagram havolasini talab qilishi kerak';
    end if;
  end if;
  for _g in select e.value from jsonb_array_elements(_requires) with ordinality e(value, n) order by e.n loop
    for _k in select x.value from jsonb_array_elements_text(_g->'any') with ordinality x(value, n) order by x.n loop
      _a := case _k when 'image_doc' then 'document' when 'video_doc' then 'document' when 'ig_link' then 'link' else _k end;
      if _accepts is null or not (_a = any(_accepts)) then
        return format('«%s» talab qilingan, lekin qabul qilinadigan formatlarda yo‘q', _k);
      end if;
    end loop;
  end loop;
  return null;
end
$fn$;

create or replace function public.challenge_task_parse_message_url(_url text, out chat bigint, out topic bigint, out msg bigint)
language plpgsql
immutable
set search_path = public
as $fn$
-- A link to ONE message inside a forum topic (the manual-post registration). chat = the URL's chat number WITHOUT
-- -100 (Bot API id = ('-100'||chat)::bigint), topic = message_thread_id, msg = message_id. NULLs otherwise.
--   https?://t.me/c/<chat>/<topic>/<msg>          "Copy link" on a message in a topic
--   https?://t.me/c/<chat>/<msg>?thread=<topic>   the older form; thread= names the topic (and wins over a path)
-- A two-number link with no thread= is refused: it cannot say which topic the message is in. Same pattern and
-- bounds as challenge_task_parse_topic_url (PR-1). Mirrored by parseMessageUrl() in src/lib/dailyTasksPlan.ts.
declare
  _m text[];
  _t text[];
  _thread bigint;
begin
  _m := regexp_match(btrim(coalesce(_url, ''), E' \t\r\n'),
                     '^https?://t\.me/c/([1-9][0-9]{0,14})/([0-9]{1,12})(?:/([0-9]{1,12}))?/?(?:\?([^#]*))?$', 'i');
  if _m is null then
    return;
  end if;
  if coalesce(_m[4], '') ~ '(^|&)thread=' then
    _t := regexp_match(_m[4], '(?:^|&)thread=([0-9]{1,12})(?:&|$)');
    if _t is null then
      return;
    end if;
    _thread := _t[1]::bigint;
  end if;
  if _m[3] is not null then
    chat := _m[1]::bigint;
    topic := coalesce(_thread, _m[2]::bigint);
    msg := _m[3]::bigint;
  elsif _thread is not null then
    chat := _m[1]::bigint;
    topic := _thread;
    msg := _m[2]::bigint;
  end if;
end
$fn$;

create or replace function public.challenge_task_render_post_text(
  _type text, _title text, _body text, _learn text, _hint text, _minutes integer,
  _points integer, _late_points integer, _day_no integer, _task_date date, _tag_handle text)
returns text
language sql
immutable
set search_path = public
as $fn$
  -- The daily task post as Telegram HTML (parse_mode HTML). Pure: every input is an argument. Only <b> and the
  -- three entities &amp; &lt; &gt; are produced. challenge_tasks_guard measures THIS text (<= 4000, G29), so the
  -- limit is judged on what PR-5 will actually send.
  with e as (
    select replace(replace(replace(btrim(coalesce(_title, ''), E' \t\r\n'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') as title,
           replace(replace(replace(btrim(replace(coalesce(_body, ''), E'\r', ''), E' \t\r\n'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;') as body,
           nullif(replace(replace(replace(btrim(replace(coalesce(_learn, ''), E'\r', ''), E' \t\r\n'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '') as learn,
           nullif(replace(replace(replace(btrim(replace(coalesce(_hint, ''), E'\r', ''), E' \t\r\n'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '') as hint,
           nullif(replace(replace(replace(btrim(coalesce(_tag_handle, ''), E' \t\r\n@'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '') as tag
  )
  select concat_ws(E'\n',
           '📅 <b>' || coalesce(_day_no::text || '-kun vazifasi', 'Kunlik vazifa') || '</b>'
             || coalesce(' · ' || extract(day from _task_date)::int::text || '-'
                  || (array['yanvar','fevral','mart','aprel','may','iyun','iyul','avgust','sentabr','oktabr','noyabr','dekabr'])[extract(month from _task_date)::int]
                  || ', ' || (array['dushanba','seshanba','chorshanba','payshanba','juma','shanba','yakshanba'])[extract(isodow from _task_date)::int], ''),
           '<b>' || e.title || '</b>',
           '',
           e.body,
           '',
           case when e.learn is not null then '💡 ' || e.learn end,
           case when e.hint is not null then '📎 ' || e.hint end,
           case when _type = 'instagram' then
             '📸 ' || coalesce('Postda @' || e.tag || ' ni belgilang. ', '')
                   || 'Instagram username’ingiz ilovadagi profilingizda (Sozlamalar) bo‘lishi kerak.' end,
           case when _minutes is not null then '⏱ Taxminan ' || _minutes::text || ' daqiqa' end,
           '🏆 +' || coalesce(_points, 0)::text || ' ball — bugun 23:59 gacha. 1–2 kun kechiksa: +'
             || coalesce(_late_points, 0)::text || ' ball.',
           '📍 Faqat shu «Kunlik vazifalar» topikiga yuboring (uy vazifasi topikiga emas).')
    from e
$fn$;

create or replace function public.challenge_task_post_length(_s text)
returns integer
language sql
immutable
set search_path = public
as $fn$
  -- Telegram measures a message in UTF-16 code units: a character outside the BMP (📅 🏆 📍 and most emoji) counts
  -- twice. Measured on the HTML (tags included), this is an upper bound of what Telegram counts after parsing.
  -- Equal to JavaScript's String.length, so the admin page's counter and this guard always agree.
  select char_length(coalesce(_s, ''))
       + char_length(regexp_replace(coalesce(_s, ''), '[^\U00010000-\U0010FFFF]', '', 'g'))
$fn$;

-- ═══════════════════════════════ 2. Tables ═══════════════════════════════
create table if not exists public.challenge_tasks (
  id bigint generated always as identity primary key,
  course_id uuid not null references public.courses(id) on delete restrict,
  task_date date not null,                                   -- Tashkent date
  type text not null check (type in ('general', 'instagram')),
  title text not null check (char_length(btrim(title)) between 3 and 120),
  body text not null check (char_length(btrim(body)) >= 1 and char_length(body) <= 3000),
  learn_line text check (learn_line is null or char_length(learn_line) <= 500),
  submit_hint text check (submit_hint is null or char_length(submit_hint) <= 500),
  accepts text[] not null check (cardinality(accepts) >= 1
    and accepts <@ array['text','photo','video','document','voice','video_note','audio','link']::text[]),
  requires jsonb not null default '[]'::jsonb check (public.challenge_task_requires_valid(requires)),
  min_text_chars integer check (min_text_chars is null or min_text_chars > 0),
  min_duration_sec integer check (min_duration_sec is null or min_duration_sec > 0),
  minutes integer check (minutes is null or minutes between 1 and 600),
  points integer check (points is null or points between 1 and 50),
  check_rubric text check (check_rubric is null or char_length(check_rubric) <= 2000),
  requires_tag boolean,
  status text not null default 'draft' check (status in ('draft', 'approved', 'cancelled')),
  source text not null default 'manual' check (source in ('manual', 'import', 'ai_draft', 'retro')),
  plan_ref text check (plan_ref is null or char_length(plan_ref) <= 120),
  plan_format text check (plan_format is null or char_length(plan_format) <= 200),
  approved_by uuid,
  approved_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint challenge_tasks_approved_stamped check (status <> 'approved' or approved_at is not null)
);

create unique index if not exists uq_challenge_tasks_course_date
  on public.challenge_tasks (course_id, task_date) where status <> 'cancelled';
create index if not exists idx_challenge_tasks_task_date on public.challenge_tasks (task_date);

comment on table public.challenge_tasks is
  'Challenge 6.0 daily-task calendar (Daily Tasks PR-2). One live task per (course, Tashkent date). Only status=approved '
  'is ever posted or scored (PR-3+). requires = what MUST be sent (AND of kind groups); accepts = what may be captured.';

create table if not exists public.challenge_task_posts (
  task_id bigint not null references public.challenge_tasks(id) on delete restrict,
  group_id uuid not null references public.groups(id) on delete cascade,
  kind text not null default 'task' check (kind in ('task', 'summary')),
  state text not null default 'queued'
    check (state in ('queued', 'sending', 'sent', 'failed', 'sent_via_sql', 'skipped', 'manual')),
  chat_id bigint not null,
  thread_id bigint,
  message_id bigint,
  net_request_id bigint,
  attempts integer not null default 0 check (attempts >= 0),
  claim_token uuid,
  claimed_at timestamptz,
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (task_id, group_id, kind),
  constraint challenge_task_posts_message_known check (state not in ('sent', 'sent_via_sql', 'manual') or message_id is not null)
);

create unique index if not exists uq_challenge_task_posts_message
  on public.challenge_task_posts (chat_id, message_id) where message_id is not null;

comment on table public.challenge_task_posts is
  'Where each approved task was posted, per group (Daily Tasks PR-2). state manual = staff posted it by hand; the admin '
  'registered the message link, so replies to it target the task (R3). Written by admin_challenge_task_set_manual_post '
  'and (PR-5) the worker / SQL fallback poster.';

-- ═══════════════════════════════ 3. Render (config-aware) + the guard ═══════════════════════════════
create or replace function public.challenge_task_post_context(_t public.challenge_tasks,
  out day_no integer, out points integer, out late_points integer, out tag_handle text)
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- day_no = 1 + the course's approved tasks dated before this one (the rank among approved tasks; a draft shows the
-- number it would get). points = the task's override, else challenge_tasks.points[type] (1..50), else 5 / 8.
-- late_points = ceil(points * late_factor), late_factor in (0, 1] else 0.5. tag_handle only when the tag is
-- required (requires_tag, default: instagram tasks).
declare
  _c jsonb;
  _p text;
  _f text;
  _factor numeric := 0.5;
begin
  _c := coalesce((select ps.value from public.platform_settings ps where ps.key = 'challenge_tasks'), '{}'::jsonb);
  if jsonb_typeof(_c) is distinct from 'object' then
    _c := '{}'::jsonb;
  end if;
  points := _t.points;
  if points is null then
    _p := case when jsonb_typeof(_c->'points') = 'object' then _c->'points'->>coalesce(_t.type, 'general') end;
    if _p ~ '^[0-9]{1,2}$' then
      if _p::int between 1 and 50 then
        points := _p::int;
      end if;
    end if;
  end if;
  points := coalesce(points, case when _t.type = 'instagram' then 8 else 5 end);
  _f := _c->>'late_factor';
  if _f ~ '^(0(\.[0-9]{1,6})?|1(\.0{1,6})?)$' then
    if _f::numeric > 0 then
      _factor := _f::numeric;
    end if;
  end if;
  late_points := greatest(1, ceil(points * _factor))::int;
  tag_handle := case when coalesce(_t.requires_tag, _t.type = 'instagram')
                     then coalesce(nullif(btrim(case when jsonb_typeof(_c->'ig') = 'object' then _c->'ig'->>'tag_handle' end), ''),
                                   'aicreators.students') end;
  day_no := 1 + (select count(*)::int from public.challenge_tasks x
                  where x.course_id = _t.course_id and x.status = 'approved'
                    and x.task_date < _t.task_date and x.id is distinct from _t.id);
end
$fn$;

create or replace function public.challenge_task_render_post(_t public.challenge_tasks)
returns text
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  _c record;
begin
  select * into _c from public.challenge_task_post_context(_t);
  return public.challenge_task_render_post_text(_t.type, _t.title, _t.body, _t.learn_line, _t.submit_hint, _t.minutes,
                                                _c.points, _c.late_points, _c.day_no, _t.task_date, _c.tag_handle);
end
$fn$;

create or replace function public.challenge_tasks_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
-- challenge_tasks_guard v1 (PR-2). PR-3 replaces it with v2 (immutability once posted / submitted) -- our own
-- function, no pin needed. SECURITY DEFINER: it reads platform_settings / groups whatever the caller's RLS.
declare
  _vocab constant text[] := array['text','photo','video','document','voice','video_note','audio','link'];
  _cfg jsonb;
  _tcfg jsonb;
  _s text;
  _e text;
  _sd date;
  _ed date;
  _problem text;
  _len int;
begin
  -- bookkeeping the client can never forge
  if TG_OP = 'INSERT' then
    NEW.created_by := coalesce(auth.uid(), NEW.created_by);
    NEW.created_at := now();
  else
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
  end if;
  NEW.updated_at := now();
  NEW.title := btrim(NEW.title, E' \t\r\n');
  if NEW.accepts is not null and NEW.accepts <@ _vocab then     -- d6: never drops an invalid kind (the CHECK rejects it)
    NEW.accepts := array(select v.k from unnest(_vocab) with ordinality v(k, i) where v.k = any(NEW.accepts) order by v.i);
  end if;

  if NEW.status is distinct from 'approved' then
    NEW.approved_at := null;
    NEW.approved_by := null;
    return NEW;
  end if;

  -- ── approving, or editing an approved task: every rule below must hold ──
  _cfg := coalesce((select ps.value from public.platform_settings ps where ps.key = 'challenge'), '{}'::jsonb);
  _tcfg := coalesce((select ps.value from public.platform_settings ps where ps.key = 'challenge_tasks'), '{}'::jsonb);
  if jsonb_typeof(_cfg) is distinct from 'object' then _cfg := '{}'::jsonb; end if;
  if jsonb_typeof(_tcfg) is distinct from 'object' then _tcfg := '{}'::jsonb; end if;

  -- (1) scope: a challenge course, the course of a challenge group, or the course of an E2E test group (G26)
  if not (
       exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(_cfg->'course_ids') = 'array'
                                                             then _cfg->'course_ids' else '[]'::jsonb end) x
                where x = NEW.course_id::text)
    or exists (select 1 from public.groups g
                where g.course_id = NEW.course_id
                  and g.id::text in (select x from jsonb_array_elements_text(case when jsonb_typeof(_cfg->'group_ids') = 'array'
                                                                                  then _cfg->'group_ids' else '[]'::jsonb end) x
                                     union all
                                     select x from jsonb_array_elements_text(case when jsonb_typeof(_tcfg->'test_group_ids') = 'array'
                                                                                  then _tcfg->'test_group_ids' else '[]'::jsonb end) x))
  ) then
    raise exception using errcode = 'P0001', message = 'Bu kurs challenge doirasida emas — vazifani tasdiqlab bo‘lmaydi';
  end if;

  -- (2) the challenge window, by DATES (C20): Tashkent dates of window.start / window.end; NULL = open
  _s := nullif(btrim(coalesce(case when jsonb_typeof(_cfg->'window') = 'object' then _cfg->'window'->>'start' end, '')), '');
  _e := nullif(btrim(coalesce(case when jsonb_typeof(_cfg->'window') = 'object' then _cfg->'window'->>'end' end, '')), '');
  begin
    if _s is not null then _sd := (_s::timestamptz at time zone 'Asia/Tashkent')::date; end if;
    if _e is not null then _ed := (_e::timestamptz at time zone 'Asia/Tashkent')::date; end if;
  exception when others then
    raise exception using errcode = 'P0001',
      message = 'Challenge oynasi (platform_settings.challenge.window) noto‘g‘ri — vazifani tasdiqlab bo‘lmaydi';
  end;
  if _sd is not null and NEW.task_date < _sd then
    raise exception using errcode = 'P0001',
      message = format('Sana challenge oynasidan oldin (boshlanishi: %s) — tasdiqlab bo‘lmaydi', to_char(_sd, 'YYYY-MM-DD'));
  end if;
  if _ed is not null and NEW.task_date > _ed then
    raise exception using errcode = 'P0001',
      message = format('Sana challenge oynasidan keyin (tugashi: %s) — tasdiqlab bo‘lmaydi', to_char(_ed, 'YYYY-MM-DD'));
  end if;

  -- (3) requires is valid, fits the type and is capturable (G3)
  _problem := public.challenge_task_requires_problem(NEW.type, NEW.requires, NEW.accepts);
  if _problem is not null then
    raise exception using errcode = 'P0001', message = _problem;
  end if;

  -- (4) the rendered post fits one Telegram message (G29), counted the way Telegram counts (UTF-16 units)
  _len := public.challenge_task_post_length(public.challenge_task_render_post(NEW));
  if _len > 4000 then
    raise exception using errcode = 'P0001',
      message = format('E’lon matni juda uzun: %s / 4000 belgi — matnni qisqartiring', _len);
  end if;

  if TG_OP = 'UPDATE' and OLD.status = 'approved' then
    NEW.approved_at := OLD.approved_at;                          -- an edit keeps the original approval stamp
    NEW.approved_by := OLD.approved_by;
  else
    NEW.approved_at := now();
    NEW.approved_by := auth.uid();
  end if;
  return NEW;
end
$fn$;

drop trigger if exists trg_challenge_tasks_guard on public.challenge_tasks;
create trigger trg_challenge_tasks_guard
  before insert or update on public.challenge_tasks
  for each row execute function public.challenge_tasks_guard();

-- ═══════════════════════════════ 4. Admin RPCs ═══════════════════════════════
create or replace function public.admin_challenge_task_preview(_draft jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- The day drawer's live preview + counter: renders an UNSAVED draft with exactly the function the guard measures.
-- Never writes. A draft the record type cannot hold (e.g. minutes = "abc") answers {error}, not an exception.
declare
  _t public.challenge_tasks;
  _c record;
  _txt text;
begin
  if not public.has_role(auth.uid(), 'admin'::public.app_role) then
    raise exception using errcode = '42501', message = 'admin_challenge_task_preview: admin only';
  end if;
  begin
    _t := jsonb_populate_record(null::public.challenge_tasks,
                                case when jsonb_typeof(_draft) = 'object' then _draft else '{}'::jsonb end);
  exception when others then
    return jsonb_build_object('error', sqlerrm);
  end;
  _t.type := coalesce(_t.type, 'general');
  select * into _c from public.challenge_task_post_context(_t);
  _txt := public.challenge_task_render_post_text(_t.type, _t.title, _t.body, _t.learn_line, _t.submit_hint, _t.minutes,
                                                 _c.points, _c.late_points, _c.day_no, _t.task_date, _c.tag_handle);
  return jsonb_build_object('text', _txt, 'length', public.challenge_task_post_length(_txt), 'max', 4000, 'day_no', _c.day_no,
                            'points', _c.points, 'late_points', _c.late_points,
                            'requires_problem', public.challenge_task_requires_problem(_t.type, _t.requires, _t.accepts));
end
$fn$;

create or replace function public.admin_challenge_tasks_import(_course_id uuid, _items jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- The plan importer. Every item becomes a DRAFT (source 'import'); nothing is ever approved here -- a human reviews
-- `requires` in the drawer first (G3). Idempotent: an item whose plan_ref is already a live task of the course, or
-- whose date is already taken, is SKIPPED and reported. Atomic: any invalid item aborts the whole import with its
-- position in the message. Writes admin_actions 'challenge_tasks_imported'.
declare
  _it jsonb;
  _n bigint;
  _ref text;
  _date date;
  _id bigint;
  _created bigint[] := '{}';
  _skipped jsonb := '[]'::jsonb;
begin
  if not public.has_role(auth.uid(), 'admin'::public.app_role) then
    raise exception using errcode = '42501', message = 'admin_challenge_tasks_import: admin only';
  end if;
  if _course_id is null or not exists (select 1 from public.courses c where c.id = _course_id) then
    raise exception using errcode = 'P0001', message = 'Kurs topilmadi';
  end if;
  if jsonb_typeof(_items) is distinct from 'array' or jsonb_array_length(_items) = 0 then
    raise exception using errcode = 'P0001', message = 'Import ro‘yxati bo‘sh';
  end if;
  if jsonb_array_length(_items) > 200 then
    raise exception using errcode = 'P0001', message = 'Bir martada ko‘pi bilan 200 ta vazifa import qilinadi';
  end if;
  perform pg_advisory_xact_lock(hashtext('challenge_tasks_import:' || _course_id::text));   -- two tabs, one calendar

  for _it, _n in select e.value, e.n from jsonb_array_elements(_items) with ordinality e(value, n) order by e.n loop
    _ref := nullif(btrim(coalesce(case when jsonb_typeof(_it) = 'object' then _it->>'plan_ref' end, '')), '');
    begin
      _date := (_it->>'task_date')::date;
    exception when others then
      _date := null;
    end;
    if _date is null then
      raise exception using errcode = 'P0001', message = format('Reja elementi #%s (%s): sana noto‘g‘ri', _n, coalesce(_ref, '—'));
    end if;
    if _ref is not null and exists (select 1 from public.challenge_tasks t
                                     where t.course_id = _course_id and t.plan_ref = _ref and t.status <> 'cancelled') then
      _skipped := _skipped || jsonb_build_object('plan_ref', _ref, 'task_date', _date, 'reason', 'plan_ref_exists');
      continue;
    end if;
    if exists (select 1 from public.challenge_tasks t
                where t.course_id = _course_id and t.task_date = _date and t.status <> 'cancelled') then
      _skipped := _skipped || jsonb_build_object('plan_ref', _ref, 'task_date', _date, 'reason', 'date_taken');
      continue;
    end if;
    begin
      insert into public.challenge_tasks (course_id, task_date, type, title, body, learn_line, submit_hint, accepts, requires,
                                          min_text_chars, min_duration_sec, minutes, points, check_rubric, requires_tag,
                                          status, source, plan_ref, plan_format)
      values (_course_id, _date, _it->>'type', _it->>'title', _it->>'body',
              nullif(btrim(coalesce(_it->>'learn_line', '')), ''), nullif(btrim(coalesce(_it->>'submit_hint', '')), ''),
              array(select jsonb_array_elements_text(_it->'accepts')),
              coalesce(_it->'requires', '[]'::jsonb),
              (_it->>'min_text_chars')::int, (_it->>'min_duration_sec')::int, (_it->>'minutes')::int, (_it->>'points')::int,
              nullif(btrim(coalesce(_it->>'check_rubric', '')), ''), (_it->>'requires_tag')::boolean,
              'draft', 'import', _ref, nullif(btrim(coalesce(_it->>'plan_format', '')), ''))
      returning id into _id;
    exception when others then
      raise exception using errcode = 'P0001', message = format('Reja elementi #%s (%s): %s', _n, coalesce(_ref, '—'), sqlerrm);
    end;
    _created := _created || _id;
  end loop;

  insert into public.admin_actions (actor_user_id, action, details)
  values (auth.uid(), 'challenge_tasks_imported', jsonb_build_object(
    'course_id', _course_id, 'items', jsonb_array_length(_items), 'created', cardinality(_created),
    'created_ids', to_jsonb(_created), 'skipped', _skipped));
  return jsonb_build_object('created', cardinality(_created), 'created_ids', to_jsonb(_created), 'skipped', _skipped);
end
$fn$;

create or replace function public.admin_challenge_task_set_manual_post(_task_id bigint, _group_id uuid, _url text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $fn$
-- Registers (or, with a blank _url, clears) the message staff posted BY HAND for this task in this group's
-- «Kunlik vazifalar» topic: challenge_task_posts (task, group, 'task') state 'manual'. So a reply to that message
-- targets the task (R3) and the retro backfill can attribute it (G8, G9). Refuses: a link that is not a topic
-- message, another chat, another topic, the topic itself, a message registered for another task, overwriting (or
-- clearing) a post the bot sent. When the bot saw the message (webhook_inbox), its real thread must match too, and
-- its text is returned so the admin can confirm the paste. Writes admin_actions.
declare
  _t record;
  _g record;
  _row public.challenge_task_posts;
  _had boolean;
  _p record;
  _chat bigint;
  _other record;
  _m jsonb;
  _seen boolean := false;
  _preview text;
  _sent timestamptz;
begin
  if not public.has_role(auth.uid(), 'admin'::public.app_role) then
    raise exception using errcode = '42501', message = 'admin_challenge_task_set_manual_post: admin only';
  end if;
  select t.id, t.course_id, t.task_date into _t from public.challenge_tasks t where t.id = _task_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'Vazifa topilmadi';
  end if;
  select g.id, g.name, g.course_id, g.daily_task_chat_id, g.daily_task_topic_id into _g from public.groups g where g.id = _group_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'Guruh topilmadi';
  end if;
  if _g.daily_task_topic_id is null then
    raise exception using errcode = 'P0001', message = 'Bu guruhda «Kunlik vazifalar» topiki sozlanmagan (Admin → Guruhlar)';
  end if;
  if _g.course_id is distinct from _t.course_id then
    raise exception using errcode = 'P0001', message = 'Bu guruh vazifaning kursiga tegishli emas';
  end if;

  select * into _row from public.challenge_task_posts p
   where p.task_id = _task_id and p.group_id = _group_id and p.kind = 'task'
   for update;
  _had := found;

  if nullif(btrim(coalesce(_url, ''), E' \t\r\n'), '') is null then
    if not _had then
      return jsonb_build_object('state', null, 'changed', false);
    end if;
    if _row.state <> 'manual' then
      raise exception using errcode = 'P0001', message = 'Bot e’lon qilgan xabarni bu yerdan o‘chirib bo‘lmaydi';
    end if;
    delete from public.challenge_task_posts p where p.task_id = _task_id and p.group_id = _group_id and p.kind = 'task';
    insert into public.admin_actions (actor_user_id, action, details)
    values (auth.uid(), 'challenge_task_manual_post_cleared', jsonb_build_object(
      'task_id', _task_id, 'task_date', _t.task_date, 'group_id', _group_id, 'chat_id', _row.chat_id, 'message_id', _row.message_id));
    return jsonb_build_object('state', null, 'changed', true);
  end if;

  select p.chat, p.topic, p.msg into _p from public.challenge_task_parse_message_url(_url) p;
  if _p.msg is null then
    raise exception using errcode = 'P0001',
      message = 'Xabar havolasi noto‘g‘ri. Xabar ustida «Havolani nusxalash»: https://t.me/c/4440955972/144/5321';
  end if;
  _chat := ('-100' || _p.chat::text)::bigint;
  if _chat <> _g.daily_task_chat_id then
    raise exception using errcode = 'P0001', message = 'Bu havola boshqa guruhdagi xabarga tegishli';
  end if;
  if _p.topic is distinct from _g.daily_task_topic_id then
    raise exception using errcode = 'P0001', message = 'Bu havola «Kunlik vazifalar» topikidagi xabarga emas';
  end if;
  if _p.msg <= _p.topic then
    raise exception using errcode = 'P0001', message = 'Bu topikning o‘zi — e’lon qilingan xabarning havolasini yuboring';
  end if;
  if _had and _row.state in ('sending', 'sent', 'sent_via_sql') then
    raise exception using errcode = 'P0001', message = 'Bot bu vazifani bu guruhda allaqachon e’lon qilgan';
  end if;
  select t.task_date into _other
    from public.challenge_task_posts p join public.challenge_tasks t on t.id = p.task_id
   where p.chat_id = _chat and p.message_id = _p.msg
     and not (p.task_id = _task_id and p.group_id = _group_id and p.kind = 'task')
   limit 1;
  if found then
    raise exception using errcode = 'P0001',
      message = format('Bu xabar boshqa vazifaga (%s) biriktirilgan', to_char(_other.task_date, 'YYYY-MM-DD'));
  end if;

  select w.raw_update->'message' into _m
    from public.webhook_inbox w
   where w.chat_id = _chat and w.message_id = _p.msg and w.update_type = 'message'
   order by w.id
   limit 1;
  if _m is not null then
    _seen := true;
    if (_m->>'message_thread_id') is distinct from _p.topic::text then
      raise exception using errcode = 'P0001',
        message = 'Bot bu xabarni «Kunlik vazifalar» topikida ko‘rmagan — havolani tekshiring';
    end if;
    _preview := left(coalesce(_m->>'text', _m->>'caption', ''), 160);
    _sent := case when (_m->>'date') ~ '^[0-9]{1,12}$' then to_timestamp((_m->>'date')::bigint) end;
  end if;

  insert into public.challenge_task_posts as p (task_id, group_id, kind, state, chat_id, thread_id, message_id, sent_at)
  values (_task_id, _group_id, 'task', 'manual', _chat, _p.topic, _p.msg, _sent)
  on conflict (task_id, group_id, kind) do update
    set state = 'manual', chat_id = excluded.chat_id, thread_id = excluded.thread_id, message_id = excluded.message_id,
        sent_at = excluded.sent_at, error = null, claim_token = null, claimed_at = null;

  insert into public.admin_actions (actor_user_id, action, details)
  values (auth.uid(), 'challenge_task_manual_post_set', jsonb_build_object(
    'task_id', _task_id, 'task_date', _t.task_date, 'group_id', _group_id, 'chat_id', _chat, 'thread_id', _p.topic,
    'message_id', _p.msg, 'seen_by_bot', _seen, 'previous_state', case when _had then _row.state end,
    'previous_message_id', case when _had then _row.message_id end));
  return jsonb_build_object('state', 'manual', 'changed', true, 'chat_id', _chat, 'thread_id', _p.topic, 'message_id', _p.msg,
                            'seen_by_bot', _seen, 'preview', _preview, 'sent_at', _sent);
end
$fn$;

-- ═══════════════════════════════ 5. RLS, grants ═══════════════════════════════
alter table public.challenge_tasks enable row level security;
alter table public.challenge_task_posts enable row level security;

drop policy if exists "challenge_tasks admin read" on public.challenge_tasks;
create policy "challenge_tasks admin read" on public.challenge_tasks
  for select to authenticated using (public.has_role(auth.uid(), 'admin'::public.app_role));
drop policy if exists "challenge_tasks admin insert" on public.challenge_tasks;
create policy "challenge_tasks admin insert" on public.challenge_tasks
  for insert to authenticated with check (public.has_role(auth.uid(), 'admin'::public.app_role));
drop policy if exists "challenge_tasks admin update" on public.challenge_tasks;
create policy "challenge_tasks admin update" on public.challenge_tasks
  for update to authenticated using (public.has_role(auth.uid(), 'admin'::public.app_role))
  with check (public.has_role(auth.uid(), 'admin'::public.app_role));
drop policy if exists "challenge_tasks admin delete unapproved" on public.challenge_tasks;
create policy "challenge_tasks admin delete unapproved" on public.challenge_tasks
  for delete to authenticated using (public.has_role(auth.uid(), 'admin'::public.app_role) and status <> 'approved');
drop policy if exists "challenge_task_posts admin read" on public.challenge_task_posts;
create policy "challenge_task_posts admin read" on public.challenge_task_posts
  for select to authenticated using (public.has_role(auth.uid(), 'admin'::public.app_role));

revoke all on table public.challenge_tasks from public, anon, authenticated;
revoke all on table public.challenge_task_posts from public, anon, authenticated;
grant select, insert, update, delete on table public.challenge_tasks to authenticated;      -- RLS: admins only
grant select on table public.challenge_task_posts to authenticated;                         -- RLS: admins only
grant select, insert, update, delete on table public.challenge_tasks to service_role;
grant select, insert, update, delete on table public.challenge_task_posts to service_role;
do $$
declare
  _s text := pg_get_serial_sequence('public.challenge_tasks', 'id');
begin
  -- an identity column needs no sequence privilege to INSERT; nobody but service_role touches it directly
  execute format('revoke all on sequence %s from public, anon, authenticated', _s);
  execute format('grant usage, select on sequence %s to service_role', _s);
end $$;

-- The CHECK evaluates challenge_task_requires_valid as the INSERTING role, so authenticated (admins, under RLS)
-- needs EXECUTE on it. It is pure and reads nothing.
revoke execute on function public.challenge_task_requires_valid(jsonb) from public, anon, authenticated;
grant execute on function public.challenge_task_requires_valid(jsonb) to authenticated, service_role;
revoke execute on function public.challenge_task_requires_problem(text, jsonb, text[]) from public, anon, authenticated;
grant execute on function public.challenge_task_requires_problem(text, jsonb, text[]) to service_role;
revoke execute on function public.challenge_task_parse_message_url(text) from public, anon, authenticated;
grant execute on function public.challenge_task_parse_message_url(text) to service_role;
revoke execute on function public.challenge_task_render_post_text(text, text, text, text, text, integer, integer, integer, integer, date, text)
  from public, anon, authenticated;
grant execute on function public.challenge_task_render_post_text(text, text, text, text, text, integer, integer, integer, integer, date, text)
  to service_role;
revoke execute on function public.challenge_task_post_length(text) from public, anon, authenticated;
grant execute on function public.challenge_task_post_length(text) to service_role;
revoke execute on function public.challenge_task_post_context(public.challenge_tasks) from public, anon, authenticated;
grant execute on function public.challenge_task_post_context(public.challenge_tasks) to service_role;
revoke execute on function public.challenge_task_render_post(public.challenge_tasks) from public, anon, authenticated;
grant execute on function public.challenge_task_render_post(public.challenge_tasks) to service_role;
-- Trigger function: EXECUTE is checked when the trigger is created, never when it fires.
revoke execute on function public.challenge_tasks_guard() from public, anon, authenticated;
revoke execute on function public.admin_challenge_task_preview(jsonb) from public, anon, authenticated;
grant execute on function public.admin_challenge_task_preview(jsonb) to authenticated;
revoke execute on function public.admin_challenge_tasks_import(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.admin_challenge_tasks_import(uuid, jsonb) to authenticated;
revoke execute on function public.admin_challenge_task_set_manual_post(bigint, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_challenge_task_set_manual_post(bigint, uuid, text) to authenticated;

-- ═══════════════════════════════ 6. Self-test (non-mutating) ═══════════════════════════════
do $$
declare
  _f jsonb;
  _r record;
  _txt text;
  _last constant text := E'\n📍 Faqat shu «Kunlik vazifalar» topikiga yuboring (uy vazifasi topikiga emas).';
  _valid jsonb := '[
    [],
    [{"any":["photo","image_doc"],"min":1,"label":"screenshot"}],
    [{"any":["photo","image_doc"],"min":1,"label":"screenshot"},{"any":["text"],"min":1,"label":"text"}],
    [{"any":["text","photo","image_doc","link"],"min":1,"label":"text"}],
    [{"label":"voice","min":20,"any":["voice","video_note","audio"]}]
  ]'::jsonb;
  _invalid jsonb := '[
    null, {}, [1], [[]],
    [{"any":[],"min":1,"label":"text"}],
    [{"any":["pdf"],"min":1,"label":"file"}],
    [{"any":["text","text"],"min":1,"label":"text"}],
    [{"any":["text"],"min":0,"label":"text"}],
    [{"any":["text"],"min":21,"label":"text"}],
    [{"any":["text"],"min":1.5,"label":"text"}],
    [{"any":["text"],"min":"1","label":"text"}],
    [{"any":["text"],"min":1}],
    [{"any":["text"],"min":1,"label":"image"}],
    [{"any":["text"],"min":1,"label":"text","x":1}],
    [{"any":"text","min":1,"label":"text"}],
    [{"any":[1],"min":1,"label":"text"}],
    [{"any":["text"],"min":1,"label":"text"},{"any":["text"],"min":1,"label":"text"},{"any":["text"],"min":1,"label":"text"},
     {"any":["text"],"min":1,"label":"text"},{"any":["text"],"min":1,"label":"text"},{"any":["text"],"min":1,"label":"text"},
     {"any":["text"],"min":1,"label":"text"},{"any":["text"],"min":1,"label":"text"},{"any":["text"],"min":1,"label":"text"}]
  ]'::jsonb;
  _problems jsonb := '[
    ["general",   [], ["text"], null],
    ["general",   [{"any":["photo","image_doc"],"min":1,"label":"screenshot"}], ["text","photo","document"], null],
    ["general",   [{"any":["photo","image_doc"],"min":1,"label":"screenshot"}], ["text","photo"], "«image_doc» talab qilingan, lekin qabul qilinadigan formatlarda yo‘q"],
    ["general",   [{"any":["ig_link"],"min":1,"label":"ig_link"}], ["text","link"], "Instagram havolasi (ig_link) faqat Instagram vazifasida talab qilinadi"],
    ["instagram", [{"any":["photo","image_doc"],"min":1,"label":"screenshot"},{"any":["ig_link"],"min":1,"label":"ig_link"}], ["text","photo","document","link"], null],
    ["instagram", [{"any":["photo","image_doc"],"min":1,"label":"screenshot"}], ["text","photo","document","link"], "Instagram vazifasi skrinshot va Instagram havolasini talab qilishi kerak"],
    ["instagram", [{"any":["photo","ig_link"],"min":1,"label":"screenshot"}], ["photo","link"], "Instagram vazifasi skrinshot va Instagram havolasini talab qilishi kerak"],
    ["general",   [{"any":["text"],"min":0,"label":"text"}], ["text"], "«Nima yuborilishi shart» (requires) formati noto‘g‘ri"]
  ]'::jsonb;
  _links jsonb := '[
    ["https://t.me/c/4440955972/144/5321",                 4440955972, 144, 5321],
    ["  https://t.me/c/4440955972/144/5321/  ",            4440955972, 144, 5321],
    ["https://t.me/c/4440955972/5321?thread=144",          4440955972, 144, 5321],
    ["https://t.me/c/4440955972/144/5321?single&thread=99", 4440955972, 99, 5321],
    ["HTTPS://T.ME/c/4390902020/99/7",                     4390902020, 99, 7],
    ["https://t.me/c/4440955972/144",                      null, null, null],
    ["https://t.me/c/4440955972/144?single",               null, null, null],
    ["https://t.me/c/4440955972/5321?thread=abc",          null, null, null],
    ["https://t.me/c/4440955972/144/5321#x",               null, null, null],
    ["https://t.me/somegroup/144/5",                       null, null, null],
    ["t.me/c/1/2/3",                                       null, null, null],
    ["",                                                   null, null, null]
  ]'::jsonb;
begin
  -- (a) the requires validator
  for _f in select value from jsonb_array_elements(_valid) loop
    if not public.challenge_task_requires_valid(_f) then
      raise exception 'SELF-TEST: requires_valid(%) should be true', _f;
    end if;
  end loop;
  for _f in select value from jsonb_array_elements(_invalid) loop
    if public.challenge_task_requires_valid(case when jsonb_typeof(_f) = 'null' then null else _f end) then
      raise exception 'SELF-TEST: requires_valid(%) should be false', _f;
    end if;
  end loop;
  -- (b) consistency (the approve guard's rule 3)
  for _f in select value from jsonb_array_elements(_problems) loop
    if public.challenge_task_requires_problem(_f->>0, _f->1, array(select jsonb_array_elements_text(_f->2)))
       is distinct from (_f->>3) then
      raise exception 'SELF-TEST: requires_problem(%) = %, want %', _f, public.challenge_task_requires_problem(_f->>0, _f->1,
        array(select jsonb_array_elements_text(_f->2))), _f->>3;
    end if;
  end loop;
  -- (c) the manual-post link parser
  for _f in select value from jsonb_array_elements(_links) loop
    select p.chat, p.topic, p.msg into _r from public.challenge_task_parse_message_url(_f->>0) p;
    if _r.chat is distinct from (_f->>1)::bigint or _r.topic is distinct from (_f->>2)::bigint or _r.msg is distinct from (_f->>3)::bigint then
      raise exception 'SELF-TEST: parse_message_url(%) = (%, %, %)', _f->>0, _r.chat, _r.topic, _r.msg;
    end if;
  end loop;
  -- (d) the renderer (pure): header, escaping, the instagram line, the topic line; NULLs never blank the post
  _txt := public.challenge_task_render_post_text('instagram', ' A <b> & c ', E'Line 1\r\nLine 2', 'Learn', null, 15, 8, 4, 3,
                                                 date '2026-10-01', '@aicreators.students');
  if position('📅 <b>3-kun vazifasi</b> · 1-oktabr, payshanba' in _txt) <> 1
     or position(E'<b>A &lt;b&gt; &amp; c</b>\n\nLine 1\nLine 2\n\n💡 Learn\n📸 Postda @aicreators.students ni belgilang.' in _txt) = 0
     or position('⏱ Taxminan 15 daqiqa' in _txt) = 0
     or position('🏆 +8 ball — bugun 23:59 gacha. 1–2 kun kechiksa: +4 ball.' in _txt) = 0
     or right(_txt, char_length(_last)) <> _last then
    raise exception 'SELF-TEST: render_post_text fixture is wrong: %', _txt;
  end if;
  if public.challenge_task_render_post_text('general', 'T', 'B', null, null, null, 5, 3, null, null, null) is null
     or position('📸' in public.challenge_task_render_post_text('general', 'Tit', 'B', null, null, null, 5, 3, 1, date '2026-10-02', null)) > 0 then
    raise exception 'SELF-TEST: render_post_text general / NULL handling is wrong';
  end if;
  -- UTF-16 units: an astral emoji counts 2, a BMP character (« ‘ ’ — ʻ) counts 1
  if public.challenge_task_post_length('a📅b') <> 4 or public.challenge_task_post_length('«o‘ʻ»—') <> 6
     or public.challenge_task_post_length(null) <> 0 or public.challenge_task_post_length(_txt) <= char_length(_txt) then
    raise exception 'SELF-TEST: challenge_task_post_length is wrong';
  end if;

  -- (e) objects: tables, RLS, policies, the partial unique indexes, the guard trigger
  if to_regclass('public.challenge_tasks') is null or to_regclass('public.challenge_task_posts') is null then
    raise exception 'SELF-TEST: tables missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.challenge_tasks'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.challenge_task_posts'::regclass) then
    raise exception 'SELF-TEST: RLS is not enabled';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'challenge_tasks') <> 4
     or (select count(*) from pg_policies where schemaname = 'public' and tablename = 'challenge_task_posts') <> 1 then
    raise exception 'SELF-TEST: policy count is wrong';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'uq_challenge_tasks_course_date'
                  and indexdef like 'CREATE UNIQUE INDEX%(course_id, task_date) WHERE (status <> ''cancelled''::text)')
     or not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'uq_challenge_task_posts_message'
                     and indexdef like 'CREATE UNIQUE INDEX%(chat_id, message_id) WHERE (message_id IS NOT NULL)') then
    raise exception 'SELF-TEST: a partial unique index is missing or changed';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.challenge_tasks'::regclass
                  and tgname = 'trg_challenge_tasks_guard' and not tgisinternal) then
    raise exception 'SELF-TEST: trg_challenge_tasks_guard missing';
  end if;

  -- (f) ACLs: tables unreachable by anon; authenticated only through RLS; functions never PUBLIC/anon
  if has_table_privilege('anon', 'public.challenge_tasks', 'SELECT') or has_table_privilege('anon', 'public.challenge_task_posts', 'SELECT')
     or has_table_privilege('anon', 'public.challenge_tasks', 'INSERT') then
    raise exception 'SELF-TEST: anon can reach a challenge_task table';
  end if;
  if has_table_privilege('authenticated', 'public.challenge_task_posts', 'INSERT')
     or has_table_privilege('authenticated', 'public.challenge_task_posts', 'UPDATE')
     or has_table_privilege('authenticated', 'public.challenge_tasks', 'TRUNCATE') then
    raise exception 'SELF-TEST: authenticated has a table privilege it must not have';
  end if;
  for _r in
    select p.proname, coalesce(array_to_string(p.proacl, ','), '') as acl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('challenge_task_requires_valid', 'challenge_task_requires_problem', 'challenge_task_parse_message_url',
                         'challenge_task_render_post_text', 'challenge_task_post_length', 'challenge_task_post_context', 'challenge_task_render_post',
                         'challenge_tasks_guard', 'admin_challenge_task_preview', 'admin_challenge_tasks_import',
                         'admin_challenge_task_set_manual_post')
  loop
    if _r.acl = '' or _r.acl ~ '(^|,)=' or _r.acl ~ '(^|,)anon=' then
      raise exception 'SELF-TEST: % is reachable by PUBLIC or anon (%)', _r.proname, _r.acl;
    end if;
    if (_r.proname in ('challenge_task_requires_valid', 'admin_challenge_task_preview', 'admin_challenge_tasks_import',
                       'admin_challenge_task_set_manual_post')) <> (_r.acl ~ '(^|,)authenticated=') then
      raise exception 'SELF-TEST: % authenticated grant is wrong (%)', _r.proname, _r.acl;
    end if;
  end loop;

  -- (g) every task already approved (a replay) still fits one message
  for _r in select t.id, public.challenge_task_post_length(public.challenge_task_render_post(t)) as n
              from public.challenge_tasks t where t.status = 'approved' loop
    if _r.n > 4000 then
      raise exception 'SELF-TEST: approved task % renders % characters (> 4000)', _r.id, _r.n;
    end if;
  end loop;
end $$;

-- ═══════════════════════════════ 7. Audit once ═══════════════════════════════
do $$
begin
  if not exists (select 1 from public.admin_actions where action = 'challenge_tasks_calendar_applied') then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_tasks_calendar_applied', jsonb_build_object(
      'tables', jsonb_build_array('challenge_tasks', 'challenge_task_posts'),
      'tasks_existing', (select count(*) from public.challenge_tasks),
      'rpcs', jsonb_build_array('admin_challenge_task_preview', 'admin_challenge_tasks_import', 'admin_challenge_task_set_manual_post'),
      'at', now()));
  end if;
end $$;
