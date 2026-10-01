-- GRADING QUEUE: every row says which course its TASK belongs to and can be filtered by course and group;
-- the groups' "N kutilmoqda" badge counts exactly what the queue shows; the SQL fallback teacher DM names
-- the course and the group like every other teacher DM does. (Teacher audit 2026-09-30, PR-4: TUI-1, TUI-10,
-- BOT-3. The Mini App side of PR-4 ships in the same PR: src/pages/teacher/TeacherGrade.tsx.)
--
-- ═══ WHAT WAS WRONG (verified read-only against production, 2026-09-30) ═══
-- 1. teacher_pending_submissions() -- the Mini App grading queue (/tg/teacher/grade) and the Baholash badge --
--    returns the student's group but no course, takes no filter, and is ordered oldest-first across every
--    group the teacher has. The ten Challenge 6.0 tasks are copies of the 5.0 tasks (same titles, same task
--    numbers, same description md5), and the same "Modul N" is a different task in each course (the Claude
--    task is M6 in 5.0 and M4 in 6.0). A teacher of both courses gets one mixed list she cannot split
--    (audit TUI-1). #227 made the card say "<course> · <group>" with an extra client read; the course
--    belongs in the RPC, and the screen needs a course and group filter.
-- 2. teacher_groups(uid).pending_homework -- the "N kutilmoqda" badge on the Mini App Groups and Stats
--    screens, the web teacher profile and dashboard, the bot's teacher /start line and the weekly digest --
--    counts `score is null` over ACTIVE, non-archived members only. The queue, the bot's /baholash and every
--    other grading surface count `score is null OR score_is_stale` over every student of the group. Today
--    2-GURUH VIP 5.0 shows 6 on the badge and 7 in the queue: one resubmission waiting for a re-grade
--    (audit TUI-10). The web profile's optimistic bump(-1) after grading such a resubmission then undercounts.
-- 3. hw_dm_fallback_deliver() -- the SQL fallback that delivers a teacher's new-homework DM when the
--    notify-homework-submission drainer is down (cron hw-dm-fallback-deliver) -- still sends the old text
--    "<name> Modul N · Vazifa N ni topshirdi «title»", with no group and no course (audit BOT-3). #227 gave
--    the drainer "<course> · <group> · M<n> V<step> — <title>". The fallback also always adds
--    "📂 Postni ko'rish" with the row's message_url; for a Mini App submission that is a bot deep link
--    (49 of the 1,175 queue rows), so the button only opened the bot chat. The drainer shows that button only
--    for a real group-topic post (https://t.me/c/...) since 2026-08-18. The fallback has delivered 0 DMs so
--    far (no queue row closed with 'sql_fallback_delivery'); it exists for the day the drainer is down.
--
-- ═══ THE FIX ═══
-- A. teacher_pending_submissions(p_group_id uuid default null, p_course_id uuid default null) replaces
--    teacher_pending_submissions(). It returns two more columns, course_id and course_title: the TASK's course
--    (assignment -> module -> course), not the course of the student's current group, so a moved student's
--    old work keeps its own course (the chip then shows the mismatch). p_group_id filters on the student's
--    current group (the same scope the queue always used), p_course_id on the task's course; NULL = no
--    filter, so the call without arguments -- the only one the app ever made -- returns what it returned
--    before, plus the two columns, in the same order. Scope and role gate are unchanged. The Mini App still
--    reads the whole queue once and filters in the page, because the filter bar shows every course's count.
--    The function is DROPPED and re-created (a new return column cannot be added by CREATE OR REPLACE, and
--    keeping the old zero-argument one would make every no-argument call ambiguous); its grants are re-made
--    exactly as they were (authenticated + service_role), which the block asserts.
-- B. teacher_groups(uid): `pend` uses the queue's rule -- every submission of a student whose current group
--    is this one, `score is null or score_is_stale is true`. Nothing else in the function changes. Per group
--    the badge now equals the queue (the harness asserts it for every group on a seeded mix).
-- C. hw_dm_fallback_deliver(): the text is public.hw_submission_dm_text_uz(...), the drainer's Uzbek text
--    byte for byte; the course comes from the queue row's task, the group name from the row's group (left
--    joins: a label can never cost a delivery). "📂 Postni ko'rish" only for a https://t.me/c/ link, as in
--    the drainer. Nothing else changes: quiet hours, RBAC join, the 15-minute grace, ops_net_post with its
--    Content-Type header, the sent/err stamping and the admin alert are byte-identical.
-- D. Two new IMMUTABLE helpers, the SQL twin of the shared label (supabase/functions/_shared/hw-label.ts =
--    src/lib/hwLabel.ts): public.hw_label(course_title, group_name, module_number, step, title) and
--    public.hw_submission_dm_text_uz(student_name, course_title, group_name, module_number, step, title) =
--    notify-homework-submission/copy.ts submissionDmText('uz', ...). JavaScript's \s and \b are spelled out
--    (Postgres' own \s and \m depend on the locale), so the two agree on odd input too. Execute: service_role
--    only (the SECURITY DEFINER fallback runs them as their owner).
--
-- ═══ ONE TEXT, CHECKED ON BOTH SIDES ═══
-- The parity cases between the parity-cases markers below are read by src/test/hw-label-sql-parity.test.ts
-- (vitest, CI): each "want" must equal submissionDmText('uz', ...). This migration asserts
-- hw_submission_dm_text_uz(...) = "want" for every case before it commits. So SQL = want = TypeScript on
-- every case, and a later edit to either side fails a build or a deploy. The PGlite harness adds a fuzz run.
--
-- ═══ CALLERS (pg_proc prosrc, cron.job, views, src/, supabase/functions/) ═══
-- teacher_pending_submissions: only the app -- src/lib/teacherApi.ts fetchPendingQueue and
--   src/hooks/usePendingGrading.ts, both with no arguments (supabase-js POSTs {}; PostgREST resolves the
--   defaulted parameters). No SQL function, view, policy or cron job references it; pg_depend is empty.
-- teacher_groups: TeacherHome, TeacherGroups/Stats/Nudges/Broadcast/StudentDetail (useSelectedGroup),
--   TeacherProfile, AdminDashboard, AdminUsers, TeacherHomework, TeacherLoginAnalytics, teacher-weekly-digest
--   and the bot (teacher profile card, teacher /start). Each reads pending_homework as "waiting to be graded".
--   Signature and grants unchanged.
-- hw_dm_fallback_deliver: cron job hw-dm-fallback-deliver only. Signature and grants unchanged.
--
-- ═══ HOW, and why it is safe (the pinned-rewrite pattern) ═══
-- Each function is rewritten FROM ITS LIVE pg_get_functiondef, and only if its live prosrc (CRs stripped) has
-- the md5 re-read on 2026-09-30; anything else aborts with "regenerate". Every edit must match exactly once.
-- After the rewrite the stored definition must equal the executed one; owner, ACL, SECURITY DEFINER,
-- search_path and volatility must be unchanged, and the new body must have the md5 the harness verified.
-- SELF-TESTS never call anything that sends or writes: the helpers are pure (checked on every parity case);
-- the fallback is NOT called -- its candidate SELECT is cut from the STORED body and run read-only, which
-- proves the new joins and columns resolve (plpgsql checks only syntax at CREATE); teacher_pending_submissions
-- and teacher_groups are SQL functions, fully analysed at CREATE, and their guard needs a JWT, so they are
-- checked from the catalog (result columns, ACL, the stored rule) and end to end in the harness instead.
-- Harness: supabase/functions/_teacher/testing/grading-queue-filter-check.ts (PGlite, on the LIVE definitions
-- in grading_queue.live-2026-09-30.sql, md5-checked against production): pins refuse drifted bodies; the file
-- applies and replays; grants; the queue's columns, filters, scope, order and a moved student; badge = queue
-- for every group; the fallback's DM text and buttons (stub ops_net_post); SQL = TypeScript on the parity
-- cases plus a fuzz set.
-- REPLAY-SAFE: the new signature / the "20260930182000" markers mean a rewrite is in place; its body must
-- then have the verified md5, and it is skipped. The helpers are CREATE OR REPLACE. The audit row is written once.
--
-- ═══ KNOWN LIMITS (not this PR) ═══
-- * The group on a queue row is still the student's CURRENT group, so after a move between courses the old
--   course's work is listed under the new group (audit F1/TUI-2); the chip shows the mismatch. The structural
--   fix -- each submission records the group it was submitted in -- is the P2 item.
-- * The fallback DM stays Uzbek-only (as before), without the drainer's "(taxminiy)" retag note.

-- ─────────────────────────────── D. the label helpers ───────────────────────────────
create or replace function public.hw_label(p_course_title text, p_group_name text,
                                           p_module_number integer, p_step integer, p_title text)
returns text
language plpgsql
immutable
parallel safe
set search_path to 'public'
as $fn$
-- The SQL twin of hwLabel() in supabase/functions/_shared/hw-label.ts (= src/lib/hwLabel.ts), migration
-- 20260930182000: "<course short> · <group> · M<n> V<step> — <title>", every missing part left out.
-- Kept in step by src/test/hw-label-sql-parity.test.ts and this migration's parity cases.
declare
  -- JavaScript's \s, spelled out: Postgres' \s follows the locale (en_US.UTF-8 leaves out U+00A0).
  _ws constant text := '[\t\n\v\f\r ' || chr(160) || chr(5760) || chr(8192) || '-' || chr(8202)
                       || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279) || ']+';
  -- JavaScript's /\bchallenge\b/i (ASCII word characters), not Postgres' locale-aware \m / \M.
  _chal constant text := '(^|[^A-Za-z0-9_])challenge([^A-Za-z0-9_]|$)';
  _t text; _g text; _ttl text; _ver text; _cs text := ''; _gs text := ''; _tt text; _m text[]; _head text;
begin
  _t   := btrim(regexp_replace(coalesce(p_course_title, ''), _ws, ' ', 'g'), ' ');
  _g   := btrim(regexp_replace(coalesce(p_group_name, ''), _ws, ' ', 'g'), ' ');
  _ttl := btrim(regexp_replace(coalesce(p_title, ''), _ws, ' ', 'g'), ' ');

  -- courseVersion: the LAST number in the course title ("AI CREATORS 5.0" -> "5.0", "5,0" -> "5.0").
  select replace(x.m[1], ',', '.') into _ver
    from regexp_matches(_t, '([0-9]+(?:[.,][0-9]+)?)', 'g') with ordinality as x(m, i)
   order by x.i desc
   limit 1;
  _ver := coalesce(_ver, '');

  -- courseShort: "5.0", "CH6" (a ".0" minor is dropped), else the title clipped to 14 characters.
  if _t <> '' then
    if _t ~* _chal then
      _cs := 'CH' || regexp_replace(_ver, '\.0+$', '');
    elsif _ver <> '' then
      _cs := _ver;
    elsif char_length(_t) > 14 then
      _cs := left(_t, 13) || '…';
    else
      _cs := _t;
    end if;
  end if;

  -- groupShort: the group name without the course markers the course short already shows. Only a marker of
  -- the GIVEN course is removed, so a group of another course keeps its whole name. Never empty.
  if _g <> '' then
    _gs := _g;
    if _cs <> '' then
      if _t ~* _chal then
        _m := regexp_match(_gs, '^([^|]*[^A-Za-z0-9_|])?challenge([^A-Za-z0-9_|][^|]*)?\|(.+)$', 'i');
        if _m is not null then
          _gs := _m[3];
        end if;
      end if;
      if position('.' in _ver) > 0 then
        _gs := regexp_replace(_gs, '(^| )' || replace(_ver, '.', '\.') || '(?= |$)', ' ', 'g');
      end if;
      _gs := btrim(regexp_replace(_gs, _ws, ' ', 'g'), ' ');
      _gs := regexp_replace(_gs, '^[| ·]+|[| ·]+$', '', 'g');
      if _gs = '' then
        _gs := _g;
      end if;
    end if;
  end if;

  -- taskTag: "M2 V1"; a missing or negative part is left out.
  _tt := concat_ws(' ', case when p_module_number >= 0 then 'M' || p_module_number end,
                        case when p_step >= 0 then 'V' || p_step end);

  _head := concat_ws(' · ', nullif(_cs, ''), nullif(_gs, ''), nullif(_tt, ''));
  if _head <> '' and _ttl <> '' then
    return _head || ' — ' || _ttl;
  end if;
  return case when _head <> '' then _head else _ttl end;
end;
$fn$;

create or replace function public.hw_submission_dm_text_uz(p_student_name text, p_course_title text,
                                                           p_group_name text, p_module_number integer,
                                                           p_step integer, p_title text)
returns text
language sql
immutable
parallel safe
set search_path to 'public'
as $fn$
  -- notify-homework-submission/copy.ts submissionDmText('uz', ...), migration 20260930182000: the new-homework
  -- DM a teacher gets. Name and label are HTML-escaped (& < >) for parse_mode HTML.
  select E'📝 <b>Yangi topshiriq</b>\n\n<b>'
      || replace(replace(replace(coalesce(nullif(p_student_name, ''), '—'), '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
      || E'</b> vazifa topshirdi:\n📌 <b>'
      || replace(replace(replace(coalesce(nullif(public.hw_label(p_course_title, p_group_name, p_module_number,
                                                                 p_step, p_title), ''), '—'),
                                 '&', '&amp;'), '<', '&lt;'), '>', '&gt;')
      || '</b>'
$fn$;

revoke execute on function public.hw_label(text, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.hw_label(text, text, integer, integer, text) to service_role;
revoke execute on function public.hw_submission_dm_text_uz(text, text, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.hw_submission_dm_text_uz(text, text, text, integer, integer, text) to service_role;

-- ─────────────────────────────── A. teacher_pending_submissions ───────────────────────────────
do $mig$
declare
  _pin     constant text := 'c9e8e54f0a6f6cfdc821340e49f740cd';  -- live md5(replace(prosrc, CR, '')), 2026-09-30
  _new_pin constant text := 'f9576555057f74b4c44a0b98da05d4ea';  -- the rewritten body (PGlite harness)
  _old_sig constant text := 'public.teacher_pending_submissions()';
  _new_sig constant text := 'public.teacher_pending_submissions(uuid, uuid)';
  _olds text[] := array[
    $t$CREATE OR REPLACE FUNCTION public.teacher_pending_submissions()$t$ || E'\n',
    $t$, media jsonb, submitted_image_url text)$t$ || E'\n',
    $t$as submitted_image_url$t$ || E'\n' || $t$  from homework_submissions hs$t$ || E'\n',
    $t$  where p.group_id in (select public.teacher_group_ids(auth.uid()))$t$ || E'\n',
    $t$  order by hs.submitted_at asc;$t$ || E'\n'];
  _news text[] := array[
    $t$CREATE OR REPLACE FUNCTION public.teacher_pending_submissions(p_group_id uuid DEFAULT NULL::uuid, p_course_id uuid DEFAULT NULL::uuid)$t$ || E'\n',
    $t$, media jsonb, submitted_image_url text, course_id uuid, course_title text)$t$ || E'\n',
    array_to_string(array[
      $t$as submitted_image_url,$t$,
      $t$    -- 20260930182000: the TASK's course (assignment -> module -> course), not the course of the student's$t$,
      $t$    -- current group: the Challenge 6.0 tasks are copies of the 5.0 tasks, and a moved student's old work$t$,
      $t$    -- keeps its own course.$t$,
      $t$    m.course_id                                                           as course_id,$t$,
      $t$    c.title                                                               as course_title$t$,
      $t$  from homework_submissions hs$t$], E'\n') || E'\n',
    array_to_string(array[
      $t$  left join courses c         on c.id = m.course_id            -- 20260930182000 (FK NOT NULL; left: never hides work)$t$,
      $t$  where p.group_id in (select public.teacher_group_ids(auth.uid()))$t$], E'\n') || E'\n',
    array_to_string(array[
      $t$    -- 20260930182000: optional filters. NULL = no filter (the default, and the only call the app made$t$,
      $t$    -- before). The group is the student's CURRENT group (the scope above); the course is the TASK's course.$t$,
      $t$    and (p_group_id is null or p.group_id = p_group_id)$t$,
      $t$    and (p_course_id is null or m.course_id = p_course_id)$t$,
      $t$  order by hs.submitted_at asc;$t$], E'\n') || E'\n'];
  _old regprocedure; _nw regprocedure;
  _src text; _def text; _new text; _n int;
  _acl text[]; _owner oid; _secdef boolean; _pcfg text[]; _vol "char";
begin
  perform set_config('check_function_bodies', 'on', true);
  _old := to_regprocedure(_old_sig);
  _nw  := to_regprocedure(_new_sig);

  if _nw is not null then                                    -- replay
    if _old is not null then
      raise exception 'ABORT: teacher_pending_submissions exists in BOTH signatures (% and %)', _old_sig, _new_sig;
    end if;
    if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _nw) <> _new_pin then
      raise exception 'ABORT: % exists but its body is not the harness-verified one (md5 %)', _new_sig,
        (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _nw);
    end if;
    raise notice 'teacher_pending_submissions already takes (p_group_id, p_course_id) -- rewrite skipped';
    return;
  end if;
  if _old is null then
    raise exception 'ABORT: % not found', _old_sig;
  end if;

  select prosrc, array(select x::text from unnest(proacl) x order by 1), proowner, prosecdef, proconfig, provolatile
    into _src, _acl, _owner, _secdef, _pcfg, _vol
    from pg_proc where oid = _old;
  if md5(replace(_src, E'\r', '')) <> _pin then
    raise exception 'ABORT: teacher_pending_submissions changed since it was verified on 2026-09-30 (md5 %); re-read the live definition and regenerate this migration',
      md5(replace(_src, E'\r', ''));
  end if;

  _def := pg_get_functiondef(_old);
  _new := _def;
  for i in 1 .. array_length(_olds, 1) loop
    _n := (length(_new) - length(replace(_new, _olds[i], ''))) / length(_olds[i]);
    if _n <> 1 then
      raise exception 'ABORT: teacher_pending_submissions edit % matched % times (want exactly 1); regenerate this migration', i, _n;
    end if;
    _new := replace(_new, _olds[i], _news[i]);
  end loop;

  execute format('drop function %s', _old::regprocedure);
  execute _new;
  _nw := to_regprocedure(_new_sig);
  if _nw is null then
    raise exception 'ABORT: % was not created', _new_sig;
  end if;
  -- A new function is born with the schema's default grants; re-make the live ones exactly.
  execute format('revoke execute on function %s from public, anon, authenticated', _nw::regprocedure);
  execute format('grant execute on function %s to authenticated, service_role', _nw::regprocedure);

  if pg_get_functiondef(_nw) is distinct from _new then
    raise exception 'ABORT: teacher_pending_submissions -- the stored definition differs from the one executed';
  end if;
  if (select array(select x::text from unnest(proacl) x order by 1) from pg_proc where oid = _nw) is distinct from _acl
     or (select proowner from pg_proc where oid = _nw) <> _owner
     or (select prosecdef from pg_proc where oid = _nw) <> _secdef
     or (select proconfig from pg_proc where oid = _nw) is distinct from _pcfg
     or (select provolatile from pg_proc where oid = _nw) <> _vol then
    raise exception 'ABORT: teacher_pending_submissions -- owner, ACL, SECURITY DEFINER, search_path or volatility changed';
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _nw) <> _new_pin then
    raise exception 'ABORT: teacher_pending_submissions -- the rewritten body is not the harness-verified one (md5 %)',
      (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _nw);
  end if;
end $mig$;
-- The same grants as statements (idempotent), visible to review and to the footguns lint.
revoke execute on function public.teacher_pending_submissions(uuid, uuid) from public, anon, authenticated;
grant execute on function public.teacher_pending_submissions(uuid, uuid) to authenticated, service_role;

-- ─────────────────────────────── B + C. teacher_groups and hw_dm_fallback_deliver ───────────────────────────────
do $mig$
declare
  r record;
  _fn regprocedure;
  _src text; _def text; _new text; _n int;
  _acl text[]; _owner oid; _secdef boolean; _pcfg text[]; _vol "char";
  _olds text[]; _news text[];
begin
  perform set_config('check_function_bodies', 'on', true);

  for r in
    select * from (values
      ('teacher_groups',
       'public.teacher_groups(uuid)',
       '9665d53f561cc39f5487f3c983236019',               -- live md5(prosrc), re-read 2026-09-30
       'bd7f37fa9b449c2612dd8282845efe12',               -- the rewritten body (PGlite harness)
       '20260930182000: the grading queue''s rule',       -- replay marker
       array[
         array_to_string(array[
           $t$  pend as ($t$,
           $t$    select mem.group_id as gid, count(*) as n$t$,
           $t$    from homework_submissions hs$t$,
           $t$    join members mem on mem.student_id = hs.user_id$t$,
           $t$    where hs.score is null$t$,
           $t$    group by mem.group_id$t$,
           $t$  )$t$], E'\n') || E'\n'],
       array[
         array_to_string(array[
           $t$  pend as ($t$,
           $t$    -- 20260930182000: the grading queue's rule (teacher_pending_submissions), so this badge is the$t$,
           $t$    -- queue's count for the group: every submission of a student whose CURRENT group this is (active$t$,
           $t$    -- or not -- the queue never hides work), ungraded OR a resubmission awaiting a re-grade.$t$,
           $t$    select p.group_id as gid, count(*) as n$t$,
           $t$    from homework_submissions hs$t$,
           $t$    join profiles p on p.id = hs.user_id$t$,
           $t$    join gs on gs.id = p.group_id$t$,
           $t$    where (hs.score is null or hs.score_is_stale is true)$t$,
           $t$    group by p.group_id$t$,
           $t$  )$t$], E'\n') || E'\n']),
      ('hw_dm_fallback_deliver',
       'public.hw_dm_fallback_deliver()',
       'a9d0d84d6f4bfb5ed3d155808ecec8aa',               -- live md5(prosrc), re-read 2026-09-30
       '4025f0407f7bbc7d823c0f14c72ff58b',               -- the rewritten body (PGlite harness)
       '20260930182000: the DM names',                    -- replay marker
       array[
         array_to_string(array[
           $t$    select q.id, q.student_name, q.module_number, q.task_number, q.assignment_title,$t$,
           $t$           q.message_url, q.submission_id, t.telegram_id, t.preferred_locale$t$], E'\n') || E'\n',
         $t$      and t.telegram_id is not null and t.notifications_enabled is distinct from false$t$ || E'\n',
         array_to_string(array[
           $t$          'text', '📝 <b>Yangi topshiriq</b>' || E'\n\n<b>'$t$,
           $t$                  || replace(replace(replace(coalesce(_row.student_name, '—'), '&','&amp;'), '<','&lt;'), '>','&gt;')$t$,
           $t$                  || '</b> Modul ' || _row.module_number || ' · Vazifa ' || _row.task_number$t$,
           $t$                  || ' ni topshirdi' || case when coalesce(_row.assignment_title,'') <> ''$t$,
           $t$                       then E'\n«' || replace(replace(replace(_row.assignment_title, '&','&amp;'), '<','&lt;'), '>','&gt;') || '»' else '' end,$t$], E'\n') || E'\n',
         array_to_string(array[
           $t$          'reply_markup', jsonb_build_object('inline_keyboard', jsonb_build_array(jsonb_build_array($t$,
           $t$            jsonb_build_object('text', '📂 Postni ko''rish', 'url', _row.message_url),$t$,
           $t$            jsonb_build_object('text', '🎯 Baholash', 'callback_data', 'gs:open:' || _row.submission_id)$t$,
           $t$          )))$t$], E'\n') || E'\n'],
       array[
         array_to_string(array[
           $t$    select q.id, q.student_name, q.module_number, q.task_number, q.assignment_title,$t$,
           $t$           q.message_url, q.submission_id, t.telegram_id, t.preferred_locale,$t$,
           $t$           -- 20260930182000: the DM names the course (of the TASK) and the group, like the drainer's.$t$,
           $t$           g.name as group_name, c.title as course_title$t$], E'\n') || E'\n',
         array_to_string(array[
           $t$      and t.telegram_id is not null and t.notifications_enabled is distinct from false$t$,
           $t$    -- 20260930182000: left joins, so a label can never cost a delivery.$t$,
           $t$    left join homework_assignments ha on ha.id = q.assignment_id$t$,
           $t$    left join modules m on m.id = ha.module_id$t$,
           $t$    left join courses c on c.id = m.course_id$t$], E'\n') || E'\n',
         array_to_string(array[
           $t$          -- 20260930182000: the drainer's Uzbek text, byte for byte (notify-homework-submission/copy.ts):$t$,
           $t$          -- "<course> · <group> · M<n> V<step> — <title>".$t$,
           $t$          'text', public.hw_submission_dm_text_uz(_row.student_name, _row.course_title, _row.group_name,$t$,
           $t$                                                  _row.module_number, _row.task_number, _row.assignment_title),$t$], E'\n') || E'\n',
         array_to_string(array[
           $t$          -- 20260930182000: "Postni ko'rish" only for a real group-topic post, as the drainer does. A Mini$t$,
           $t$          -- App row's message_url is a bot deep link (t.me/<bot>?start=hw_...): it only opened the bot chat.$t$,
           $t$          'reply_markup', jsonb_build_object('inline_keyboard', jsonb_build_array($t$,
           $t$            case when _row.message_url like 'https://t.me/c/%'$t$,
           $t$                 then jsonb_build_array($t$,
           $t$                        jsonb_build_object('text', '📂 Postni ko''rish', 'url', _row.message_url),$t$,
           $t$                        jsonb_build_object('text', '🎯 Baholash', 'callback_data', 'gs:open:' || _row.submission_id))$t$,
           $t$                 else jsonb_build_array($t$,
           $t$                        jsonb_build_object('text', '🎯 Baholash', 'callback_data', 'gs:open:' || _row.submission_id))$t$,
           $t$            end))$t$], E'\n') || E'\n'])
    ) v(name, sig, pin, new_pin, marker, olds, news)
  loop
    _fn := to_regprocedure(r.sig);
    if _fn is null then
      raise exception 'ABORT: % not found', r.sig;
    end if;
    select prosrc, array(select x::text from unnest(proacl) x order by 1), proowner, prosecdef, proconfig, provolatile
      into _src, _acl, _owner, _secdef, _pcfg, _vol
      from pg_proc where oid = _fn;

    if position(r.marker in _src) > 0 then                   -- replay
      if md5(replace(_src, E'\r', '')) <> r.new_pin then
        raise exception 'ABORT: % carries the 20260930182000 marker but not the harness-verified body (md5 %)', r.name,
          md5(replace(_src, E'\r', ''));
      end if;
      raise notice '% already rewritten -- skipped', r.name;
      continue;
    end if;
    if md5(replace(_src, E'\r', '')) <> r.pin then
      raise exception 'ABORT: % changed since it was verified on 2026-09-30 (md5 %); re-read the live definition and regenerate this migration',
        r.name, md5(replace(_src, E'\r', ''));
    end if;

    _olds := r.olds;
    _news := r.news;
    _def := pg_get_functiondef(_fn);
    _new := _def;
    for i in 1 .. array_length(_olds, 1) loop
      _n := (length(_new) - length(replace(_new, _olds[i], ''))) / length(_olds[i]);
      if _n <> 1 then
        raise exception 'ABORT: % edit % matched % times (want exactly 1); regenerate this migration', r.name, i, _n;
      end if;
      _new := replace(_new, _olds[i], _news[i]);
    end loop;

    execute _new;

    if pg_get_functiondef(_fn) is distinct from _new then
      raise exception 'ABORT: % -- the stored definition differs from the one executed', r.name;
    end if;
    if (select array(select x::text from unnest(proacl) x order by 1) from pg_proc where oid = _fn) is distinct from _acl
       or (select proowner from pg_proc where oid = _fn) <> _owner
       or (select prosecdef from pg_proc where oid = _fn) <> _secdef
       or (select proconfig from pg_proc where oid = _fn) is distinct from _pcfg
       or (select provolatile from pg_proc where oid = _fn) <> _vol then
      raise exception 'ABORT: % -- owner, ACL, SECURITY DEFINER, search_path or volatility changed', r.name;
    end if;
    if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _fn) <> r.new_pin then
      raise exception 'ABORT: % -- the rewritten body is not the harness-verified one (md5 %)', r.name,
        (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _fn);
    end if;
  end loop;
end $mig$;

-- ─────────────────────────────── self-tests + audit ───────────────────────────────
do $mig$
declare
  -- parity-cases:begin  (read by src/test/hw-label-sql-parity.test.ts; "want" = submissionDmText('uz', ...))
  _cases constant jsonb := $cases$[
    {"name":"Aziza Karimova (@aziza)","course":"AI CREATORS 5.0","group":"1-GURUH VIP 5.0","m":1,"s":1,"title":"1- MODUL: PROMPT ENGINEERING","want":"📝 <b>Yangi topshiriq</b>\n\n<b>Aziza Karimova (@aziza)</b> vazifa topshirdi:\n📌 <b>5.0 · 1-GURUH VIP · M1 V1 — 1- MODUL: PROMPT ENGINEERING</b>"},
    {"name":"Aziza Karimova (@aziza)","course":"AI CREATORS CHALLENGE 6.0","group":"AC CHALLENGE | 1-GURUH","m":1,"s":1,"title":"1- MODUL: PROMPT ENGINEERING","want":"📝 <b>Yangi topshiriq</b>\n\n<b>Aziza Karimova (@aziza)</b> vazifa topshirdi:\n📌 <b>CH6 · 1-GURUH · M1 V1 — 1- MODUL: PROMPT ENGINEERING</b>"},
    {"name":"Bek","course":"AI CREATORS 5.0","group":"AC CHALLENGE | 3-GURUH","m":2,"s":1,"title":"2-MODUL ERKAKLAR KO'Z OYNAGI","want":"📝 <b>Yangi topshiriq</b>\n\n<b>Bek</b> vazifa topshirdi:\n📌 <b>5.0 · AC CHALLENGE | 3-GURUH · M2 V1 — 2-MODUL ERKAKLAR KO'Z OYNAGI</b>"},
    {"name":"Bek","course":"AI CREATORS CHALLENGE 6.0","group":"2-GURUH VIP 5.0","m":4,"s":4,"title":"CLAUDE AI VA CODEX","want":"📝 <b>Yangi topshiriq</b>\n\n<b>Bek</b> vazifa topshirdi:\n📌 <b>CH6 · 2-GURUH VIP 5.0 · M4 V4 — CLAUDE AI VA CODEX</b>"},
    {"name":"<b>x</b> & y","course":"AI CREATORS 5.0","group":"G<1>","m":1,"s":1,"title":"a & b <i>","want":"📝 <b>Yangi topshiriq</b>\n\n<b>&lt;b&gt;x&lt;/b&gt; &amp; y</b> vazifa topshirdi:\n📌 <b>5.0 · G&lt;1&gt; · M1 V1 — a &amp; b &lt;i&gt;</b>"},
    {"name":null,"course":null,"group":null,"m":3,"s":2,"title":"3-MODUL (taxminiy)","want":"📝 <b>Yangi topshiriq</b>\n\n<b>—</b> vazifa topshirdi:\n📌 <b>M3 V2 — 3-MODUL (taxminiy)</b>"},
    {"name":"","course":"AI CREATORS 4.0","group":"1-GURUH PRE 5.0","m":1,"s":1,"title":null,"want":"📝 <b>Yangi topshiriq</b>\n\n<b>—</b> vazifa topshirdi:\n📌 <b>4.0 · 1-GURUH PRE 5.0 · M1 V1</b>"},
    {"name":"S","course":"Midjourney masterclass pro","group":"Group A","m":0,"s":1,"title":"T","want":"📝 <b>Yangi topshiriq</b>\n\n<b>S</b> vazifa topshirdi:\n📌 <b>Midjourney ma… · Group A · M0 V1 — T</b>"},
    {"name":"S","course":"AI Creators Challenge 6.5","group":"AC CHALLENGE | 2-GURUH","m":6,"s":2,"title":"BONUS MULTFILM","want":"📝 <b>Yangi topshiriq</b>\n\n<b>S</b> vazifa topshirdi:\n📌 <b>CH6.5 · 2-GURUH · M6 V2 — BONUS MULTFILM</b>"},
    {"name":"S","course":"  ai creators   challenge 7.0 ","group":"  AC  CHALLENGE |  4-GURUH ","m":1,"s":1,"title":"  spaced   title  ","want":"📝 <b>Yangi topshiriq</b>\n\n<b>S</b> vazifa topshirdi:\n📌 <b>CH7 · 4-GURUH · M1 V1 — spaced title</b>"},
    {"name":"S","course":"AI CREATORS 5,0","group":"1-GURUH PRE 5.0","m":1,"s":1,"title":"t","want":"📝 <b>Yangi topshiriq</b>\n\n<b>S</b> vazifa topshirdi:\n📌 <b>5.0 · 1-GURUH PRE · M1 V1 — t</b>"},
    {"name":"S","course":"AI CREATORS 5.0","group":"5.0","m":1,"s":1,"title":"t","want":"📝 <b>Yangi topshiriq</b>\n\n<b>S</b> vazifa topshirdi:\n📌 <b>5.0 · 5.0 · M1 V1 — t</b>"},
    {"name":"S","course":"AI CREATORS 5.0","group":"15.0 GURUH","m":1,"s":1,"title":"t","want":"📝 <b>Yangi topshiriq</b>\n\n<b>S</b> vazifa topshirdi:\n📌 <b>5.0 · 15.0 GURUH · M1 V1 — t</b>"},
    {"name":"S","course":"AI CREATORS 5.0","group":"5.0 GURUH 5.0 PRE 5.0","m":1,"s":1,"title":"t","want":"📝 <b>Yangi topshiriq</b>\n\n<b>S</b> vazifa topshirdi:\n📌 <b>5.0 · GURUH PRE · M1 V1 — t</b>"},
    {"name":"S","course":"Challenges 2.0","group":"X 2.0","m":1,"s":1,"title":"t","want":"📝 <b>Yangi topshiriq</b>\n\n<b>S</b> vazifa topshirdi:\n📌 <b>2.0 · X · M1 V1 — t</b>"},
    {"name":"S","course":"CHALLENGE","group":"CHALLENGE | 1","m":1,"s":1,"title":"t","want":"📝 <b>Yangi topshiriq</b>\n\n<b>S</b> vazifa topshirdi:\n📌 <b>CH · 1 · M1 V1 — t</b>"},
    {"name":"S","course":"AI CREATORS CHALLENGE 6.0","group":"AC CHALLENGE | ","m":1,"s":1,"title":"t","want":"📝 <b>Yangi topshiriq</b>\n\n<b>S</b> vazifa topshirdi:\n📌 <b>CH6 · AC CHALLENGE · M1 V1 — t</b>"},
    {"name":"S","course":"AI CREATORS CHALLENGE 6.0","group":"AC-CHALLENGE|5-GURUH","m":1,"s":1,"title":"t","want":"📝 <b>Yangi topshiriq</b>\n\n<b>S</b> vazifa topshirdi:\n📌 <b>CH6 · 5-GURUH · M1 V1 — t</b>"},
    {"name":"S","course":"AI CREATORS CHALLENGE 6.0","group":"MYCHALLENGE | 5-GURUH","m":1,"s":1,"title":"t","want":"📝 <b>Yangi topshiriq</b>\n\n<b>S</b> vazifa topshirdi:\n📌 <b>CH6 · MYCHALLENGE | 5-GURUH · M1 V1 — t</b>"},
    {"name":"S","course":"AI CREATORS CHALLENGE 6.0","group":"| 5-GURUH ·","m":1,"s":1,"title":"t","want":"📝 <b>Yangi topshiriq</b>\n\n<b>S</b> vazifa topshirdi:\n📌 <b>CH6 · 5-GURUH · M1 V1 — t</b>"},
    {"name":"S","course":"AI CREATORS 5.0","group":"1-GURUH PRE 5.0","m":null,"s":null,"title":"Task","want":"📝 <b>Yangi topshiriq</b>\n\n<b>S</b> vazifa topshirdi:\n📌 <b>5.0 · 1-GURUH PRE — Task</b>"},
    {"name":"S","course":"AI CREATORS 5.0","group":"1-GURUH PRE 5.0","m":-1,"s":2,"title":"Task","want":"📝 <b>Yangi topshiriq</b>\n\n<b>S</b> vazifa topshirdi:\n📌 <b>5.0 · 1-GURUH PRE · V2 — Task</b>"},
    {"name":"Ali 🚀","course":"AI CREATORS CHALLENGE 6.0","group":"AC CHALLENGE | 5-GURUH","m":6,"s":2,"title":"🎬 Multfilm","want":"📝 <b>Yangi topshiriq</b>\n\n<b>Ali 🚀</b> vazifa topshirdi:\n📌 <b>CH6 · 5-GURUH · M6 V2 — 🎬 Multfilm</b>"},
    {"name":"S","course":"Кино мастеркласс продвинутый","group":"Группа 1","m":1,"s":1,"title":"Задание","want":"📝 <b>Yangi topshiriq</b>\n\n<b>S</b> vazifa topshirdi:\n📌 <b>Кино мастеркл… · Группа 1 · M1 V1 — Задание</b>"},
    {"name":"S","course":"Кино 🎬 мастеркласс","group":"G","m":1,"s":1,"title":"t","want":"📝 <b>Yangi topshiriq</b>\n\n<b>S</b> vazifa topshirdi:\n📌 <b>Кино 🎬 мастер… · G · M1 V1 — t</b>"},
    {"name":"S","course":"","group":"","m":1,"s":1,"title":"","want":"📝 <b>Yangi topshiriq</b>\n\n<b>S</b> vazifa topshirdi:\n📌 <b>M1 V1</b>"},
    {"name":"S","course":null,"group":null,"m":null,"s":null,"title":null,"want":"📝 <b>Yangi topshiriq</b>\n\n<b>S</b> vazifa topshirdi:\n📌 <b>—</b>"},
    {"name":"S","course":"AI CREATORS\tCHALLENGE\n6.0","group":"AC CHALLENGE |\t2-GURUH","m":1,"s":1,"title":"x\ty","want":"📝 <b>Yangi topshiriq</b>\n\n<b>S</b> vazifa topshirdi:\n📌 <b>CH6 · 2-GURUH · M1 V1 — x y</b>"},
    {"name":"S","course":"AI CREATORS 2026 5.0","group":"1-GURUH 5.0","m":1,"s":1,"title":"t","want":"📝 <b>Yangi topshiriq</b>\n\n<b>S</b> vazifa topshirdi:\n📌 <b>5.0 · 1-GURUH · M1 V1 — t</b>"}
  ]$cases$;
  -- parity-cases:end
  _c jsonb;
  _got text;
  _fn regprocedure;
  _src text;
  _q text;
  _n int;
begin
  -- 1. The helpers produce the drainer's text on every parity case (pure functions: nothing is written).
  if jsonb_array_length(_cases) < 25 then
    raise exception 'ABORT: self-test -- only % parity cases', jsonb_array_length(_cases);
  end if;
  for _c in select value from jsonb_array_elements(_cases) loop
    _got := public.hw_submission_dm_text_uz(_c->>'name', _c->>'course', _c->>'group',
                                            (_c->>'m')::int, (_c->>'s')::int, _c->>'title');
    if _got is distinct from _c->>'want' then
      raise exception 'ABORT: self-test -- hw_submission_dm_text_uz(%) = [%], TypeScript says [%]', _c::text, _got, _c->>'want';
    end if;
  end loop;

  -- 2. teacher_pending_submissions: the new shape, from the catalog (its guard needs a JWT).
  if to_regprocedure('public.teacher_pending_submissions()') is not null then
    raise exception 'ABORT: self-test -- the zero-argument teacher_pending_submissions() still exists';
  end if;
  _fn := to_regprocedure('public.teacher_pending_submissions(uuid, uuid)');
  if _fn is null
     or pg_get_function_result(_fn) <> 'TABLE(submission_id uuid, user_id uuid, student_name text, group_id uuid, group_name text, module_number integer, task_number integer, assignment_id uuid, assignment_title text, max_score integer, submitted_at timestamp with time zone, previous_score integer, is_resubmission boolean, media jsonb, submitted_image_url text, course_id uuid, course_title text)'
     or pg_get_function_arguments(_fn) <> 'p_group_id uuid DEFAULT NULL::uuid, p_course_id uuid DEFAULT NULL::uuid' then
    raise exception 'ABORT: self-test -- teacher_pending_submissions(uuid, uuid) does not have the expected arguments and columns';
  end if;
  if has_function_privilege('anon', _fn, 'EXECUTE')
     or not has_function_privilege('authenticated', _fn, 'EXECUTE')
     or not has_function_privilege('service_role', _fn, 'EXECUTE') then
    raise exception 'ABORT: self-test -- teacher_pending_submissions grants are not anon: no, authenticated + service_role: yes';
  end if;

  -- 3. teacher_groups counts with the queue's rule.
  select prosrc into _src from pg_proc where oid = 'public.teacher_groups(uuid)'::regprocedure;
  if position('where (hs.score is null or hs.score_is_stale is true)' in _src) = 0
     or position(E'    where hs.score is null\n' in _src) > 0 then
    raise exception 'ABORT: self-test -- teacher_groups.pend does not use the queue''s rule';
  end if;

  -- 4. hw_dm_fallback_deliver: NOT called (it sends). Its candidate SELECT is cut from the stored body and run
  --    read-only, which proves the new joins and columns resolve.
  select prosrc into _src from pg_proc where oid = 'public.hw_dm_fallback_deliver()'::regprocedure;
  if position('public.hw_submission_dm_text_uz(_row.student_name, _row.course_title, _row.group_name,' in _src) = 0
     or position($t$case when _row.message_url like 'https://t.me/c/%'$t$ in _src) = 0
     or position(' ni topshirdi' in _src) > 0 then
    raise exception 'ABORT: self-test -- hw_dm_fallback_deliver does not carry the new text and buttons';
  end if;
  _n := (length(_src) - length(replace(_src, E'  for _row in\n', ''))) / length(E'  for _row in\n');
  if _n <> 1 then
    raise exception 'ABORT: self-test -- "for _row in" matched % times in hw_dm_fallback_deliver (want 1)', _n;
  end if;
  _q := split_part(split_part(_src, E'  for _row in\n', 2), E'\n  loop\n', 1);
  if _q not like '%from homework_teacher_dm_queue q%' or position(';' in _q) > 0 then
    raise exception 'ABORT: self-test -- could not cut the candidate query out of hw_dm_fallback_deliver';
  end if;
  execute format('select count(*) from (select group_name, course_title from (%s) z) y', _q) into _n;

  -- 5. The helpers are not reachable over the API.
  if has_function_privilege('anon', 'public.hw_label(text, text, integer, integer, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.hw_label(text, text, integer, integer, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.hw_submission_dm_text_uz(text, text, text, integer, integer, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.hw_submission_dm_text_uz(text, text, text, integer, integer, text)', 'EXECUTE') then
    raise exception 'ABORT: self-test -- a label helper is executable by anon or authenticated';
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'grading_queue_course_filter_applied',
         jsonb_build_object('migration', '20260930182000',
                            'functions', jsonb_build_array('public.teacher_pending_submissions(uuid, uuid)',
                                                           'public.teacher_groups(uuid)',
                                                           'public.hw_dm_fallback_deliver()',
                                                           'public.hw_label(text, text, integer, integer, text)',
                                                           'public.hw_submission_dm_text_uz(text, text, text, integer, integer, text)'),
                            'parity_cases', jsonb_array_length(_cases),
                            'fallback_candidates_now', _n,
                            'at', now())
  where not exists (select 1 from public.admin_actions where action = 'grading_queue_course_filter_applied');
end $mig$;

-- PostgREST: the queue RPC changed signature.
notify pgrst, 'reload schema';
