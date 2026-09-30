-- CROSS-COURSE MOVE GUARD (DB invariant) + CROSS-COURSE DETECTOR. Teacher audit 2026-09-30, PR-3b.
-- Prevention hierarchy: layer 2 (a trigger no code path can skip) plus a layer-5 detector for what escapes.
--
-- ═══ WHY ═══
-- Who may see and grade a homework is decided by the student's CURRENT group: is_teacher_of(), the
-- "hws own select/update" policies, teacher_pending_submissions, start_homework_resubmission, the bot's
-- gradingScopeIds, hw-image-url, notify-grade-voice, teacher-voice-request, the ungraded reminder and
-- reconcile_teacher_dm_queue all read profiles.group_id. homework_submissions records no group or course of
-- its own. So moving a student from an AI CREATORS 5.0 group into an AI CREATORS CHALLENGE 6.0 group hands
-- their WAITING 5.0 homework to the 6.0 teachers (they see it, get its reminders and "(tiklandi)" DMs, and can
-- grade it), locks the 5.0 teacher out of it, and leaves the student unable to hand in the rest of 5.0
-- (audit findings F1, BOT-1, TUI-2, FB-1). The owner's rule (confirmed 2026-09-30): Challenge 6.0 is for NEW
-- students only; a move between courses is allowed only once nothing waits in the old course.
-- PR-3a (#226) enforces that rule in the edge engine (staff-intake / admin-create-students) and on the admin
-- screens (AdminUsers bulk move, the AdminGroups CSV). It cannot cover a direct write: admin_assign_group()
-- called by hand, a profiles UPDATE from the dashboard or SQL editor, a stale browser tab, or homework that
-- arrives between the screen's check and its write. This file closes those paths in the database.
--
-- ═══ EVIDENCE (production, read-only, 2026-09-30 ~17:50 UTC) ═══
--   * Writers of profiles.group_id: admin_assign_group() (the only SQL function; admin-gated, plain UPDATE, no
--     course check), AdminUsers → admin_assign_group, AdminGroups CSV and GroupDetail (direct UPDATE, the
--     latter only to NULL), and the service-role edge functions admin-create-students (the engine behind
--     staff-intake, sheet-sync and the bot's auto-register) and admin-merge-duplicates (dormant: the unique
--     indexes on telegram_id and lower(telegram_username) make its clusters impossible; 0 merges ever).
--     Students cannot write it since #222 (profiles_column_guard).
--   * 737 submissions; 9 waiting (score NULL or score_is_stale). cross_course_pending = 0 and
--     cross_chat_captures = 0 today: 6.0 has 0 students. The chat map below resolves 9 chats, each to exactly
--     one group and one course; 95 submissions sit in chats of retired groups (no current group: not counted).
--   * The same failure already happened INSIDE 5.0: 13 submissions of 3 students were captured in one 5.0
--     group's chat while the student now sits in another 5.0 group. Same course, so neither signal counts them
--     (moves within a course are PR-8/PR-9's structural fix, not this guard's).
--
-- ═══ WHAT ═══
-- 1. public.course_move_facts(user, from_group, to_group) — STABLE, read-only jsonb: both groups, both courses,
--    `cross` (both courses known and different) and `old_course_waiting` (the student's submissions in the
--    FROM course with score NULL or score_is_stale: the same "waiting" as the grading queue, the bot and
--    PR-3a's _shared/course-move-guard.ts).
-- 2. public.profiles_course_move_guard() + trigger trg_profiles_aa_course_move_guard, AFTER UPDATE OF group_id
--    FOR EACH ROW WHEN (old and new group both set and different). A move between courses while the old course
--    still has waiting homework RAISES P0001 'cross_course_refused: <Uzbek sentence>' (DETAIL = the facts
--    jsonb): the whole statement rolls back, so a bulk admin_assign_group() moves nobody. Every cross-course
--    move that IS allowed (0 waiting) writes admin_actions 'cross_course_move' {facts, override, jwt_role},
--    whichever path made it. The same rule as PR-3a, now for every writer, including admin_assign_group(),
--    which therefore needs no signature change (see "NO p_force" below).
--    A refusal cannot leave a row (the raise rolls it back), so it bumps course_move_refusals_seq, whose
--    nextval survives the rollback (the #222 pattern); the watchdog reports new refusals.
--    WHY AFTER, and why this name: BEFORE ROW triggers fire in name order and #222's profiles_guard_health()
--    requires trg_profiles_zz_column_guard to be the LAST before-row trigger. An AFTER trigger cannot change
--    the row, sees only writes the column guard already allowed (a student's own attempt is refused there
--    first, and counted there), and "aa" makes it the FIRST after-row trigger, so on a refusal
--    sync_group_enrollment and challenge_retro_on_profile_link never run.
-- 3. public.cross_course_health() — STABLE, read-only: guard_ok (the trigger exists, is enabled, AFTER UPDATE
--    ROW, calls the guard), cross_course_pending, cross_chat_captures, up to 10 labelled samples of each, the
--    item keys the watchdog de-duplicates on, moves/overrides in 24 h and the refusal counter.
--      cross_course_pending  = waiting submissions whose task's course differs from the course of the
--                              student's CURRENT group (both known).
--      cross_chat_captures   = submissions whose telegram_chat_id belongs to one or more CURRENT groups, none
--                              of them in the task's course. A group's chats are the /c/<id>/ links of its
--                              homework_topic_url and telegram_group_url, its daily_task_chat_id and its
--                              group_module_topics URLs: the rule capture-guard.ts (#225) uses.
-- 4. public.cross_course_watchdog() — SECURITY DEFINER, hourly at :49 (cron 'cross-course-watchdog'). DMs up
--    to 3 admins through public.ops_net_post (Content-Type passed): at the start of an episode, when a NEW item
--    appears, then at most once per 24 h while it persists; one "recovered" message when it clears; every new
--    guard refusal. The decision and the text are pure IMMUTABLE functions (cross_course_alert_decision,
--    cross_course_alert_text) so the self-test can drive them with fixed vectors. Rows
--    'cross_course_watchdog_ALARM' / '_recovered'. State row 'cross_course_watchdog_state': its
--    *_watchdog_state name puts it under hw_dm_health_stats().stale_watchdogs, which the out-of-band GitHub
--    verifier ASSERTS, so a dead cron is reported from outside Supabase.
-- 5. hw_dm_health_stats() gains 'cross_course_pending' and 'cross_chat_captures' (pinned rewrite, below). They
--    reach the GitHub verifier's JSON through hw-dm-health unchanged. -1 = the check itself failed.
--    OWNER FOLLOW-UP: the assertion "both are 0" belongs in .github/workflows/hw-dm-health.yml, which agent PRs
--    may not touch; the exact lines are in the PR description.
--
-- ═══ NO p_force ═══
-- The audit's plan read "admin_assign_group refuses a cross-course move while old-course work is waiting,
-- unless p_force is set". #226 (merged, owner-approved) then fixed the rule: an override is allowed ONLY when
-- nothing waits in the old course. With that rule a force flag has nothing left to override (a move with 0
-- waiting passes and is audited; a move with waiting work is never allowed), and the trigger covers
-- admin_assign_group() without changing its signature, its ACL or its one caller. The owner-only escape for an
-- emergency is a transaction-local setting that no API client can set (PostgREST exposes no way to set a
-- custom GUC), used in the SQL editor:
--     begin; set local app.course_move_override = 'on'; update public.profiles set group_id = ... ; commit;
-- The move is then recorded with override = true and its old_course_waiting count.
--
-- ═══ hw_dm_health_stats: the pinned-rewrite pattern (as 20260930160000) ═══
-- Edited FROM ITS LIVE pg_get_functiondef, only if its live prosrc (CRs stripped) has the md5 read read-only on
-- 2026-09-30 (fa76b14cdcfeb3c84e5220852e0e6bef; pg_get_functiondef md5 5964793a61b404e39a1cad7cfd1d24cd, no CR
-- in the body). Anything else aborts with "regenerate". Three edits, each must match exactly once. After
-- CREATE OR REPLACE (body validation on) the stored definition must equal the executed text; owner, ACL and
-- SECURITY DEFINER must be unchanged, and anon / authenticated still unable to execute it. REPLAY-SAFE: the
-- marker "(20260930181000)" in the body means the rewrite is in place and is skipped.
--
-- ═══ DEPLOY SELF-TEST (never sends, never keeps a write, needs no JWT, takes no advisory lock) ═══
--   * static: the trigger's shape, every new function present, none executable by anon or authenticated.
--   * the pure decision/text functions against fixed vectors.
--   * course_move_facts(), cross_course_health() and hw_dm_health_stats() (all read-only): well-formed, the two
--     new fields present and >= 0. Not asserted to be 0: a real mismatch at deploy time must not fail the
--     migration; the first watchdog run reports it.
--   * the guard itself on LIVE data, rolled back: a student with waiting homework in their current group's
--     course is moved to a group of another course inside a sub-block. The trigger must refuse with
--     'cross_course_refused:'; if the UPDATE went through instead, a sentinel raise rolls it back and the
--     migration aborts. Either way the savepoint undoes every trigger's writes; only the refusal counter (a
--     sequence) keeps its +1, and the watchdog's baseline is seeded AFTER it. The refusal path runs no other
--     AFTER trigger (this one is first by name). Skipped (and recorded) when no such student exists.
--
-- ═══ DRY-RUN, read-only against production, 2026-09-30 ~18:00 UTC ═══
--   * pin matched (fa76b14c…); edits 1 / 1 / 1 matched exactly once; no marker yet.
--   * the detector's query: cross_course_pending 0, cross_chat_captures 0, 9 chats mapped, 646 submissions in
--     mapped chats, 0 'cross_course_move' rows.
--   * the self-test's vector exists: a 2-GURUH VIP 5.0 student with 1 waiting 5.0 submission → AC CHALLENGE |
--     3-GURUH (cross = true, old_course_waiting = 1), so the live guard test will run, not skip.
--   * the BEFORE triggers that UPDATE fires (update_updated_at_column, profiles_column_guard →
--     profiles_guard_record_change) take no advisory lock and have no non-transactional side effect.
--   * auth.uid(), auth.role() and cron.schedule(name, schedule, command) exist.
-- PGlite harness (production's hw_dm_health_stats and admin_assign_group text, byte for byte):
--   deno run -A --node-modules-dir=none supabase/functions/_watchdogs/testing/cross-course-guard-check.ts
--
-- KILL-SWITCHES: select cron.unschedule('cross-course-watchdog');                                  (the DMs)
--                alter table public.profiles disable trigger trg_profiles_aa_course_move_guard;    (the guard;
--                the watchdog then reports guard_down every 24 h until it is enabled again)
--                per operation: set local app.course_move_override = 'on'   (SQL editor, see above)

-- ── 1. The refusal counter (survives the rollback of the refused statement) ──
create sequence if not exists public.course_move_refusals_seq;
revoke all on sequence public.course_move_refusals_seq from public, anon, authenticated;
grant select on sequence public.course_move_refusals_seq to service_role;

-- ── 2. The facts of one move ──
create or replace function public.course_move_facts(_user_id uuid, _from_group_id uuid, _to_group_id uuid)
returns jsonb
language sql
stable
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'user_id', _user_id,
    'student', coalesce((select coalesce(nullif(btrim(coalesce(p.name, '') || ' ' || coalesce(p.last_name, '')), ''),
                                         '@' || nullif(btrim(p.telegram_username), ''))
                           from public.profiles p where p.id = _user_id), 'Talaba'),
    'from_group_id', fg.id, 'from_group', fg.name, 'from_course_id', fg.course_id, 'from_course', fc.title,
    'to_group_id', tg.id, 'to_group', tg.name, 'to_course_id', tg.course_id, 'to_course', tc.title,
    'cross', coalesce(fg.id is not null and tg.id is not null and fg.id <> tg.id
                      and fg.course_id is not null and tg.course_id is not null
                      and fg.course_id <> tg.course_id, false),
    'old_course_waiting', case when fg.course_id is null or _user_id is null then 0 else (
      select count(*)::int
        from public.homework_submissions hs
        join public.homework_assignments a on a.id = hs.assignment_id
        join public.modules m on m.id = a.module_id
       where hs.user_id = _user_id
         and m.course_id = fg.course_id
         and (hs.score is null or coalesce(hs.score_is_stale, false))) end)
  from (select 1) as one
  left join public.groups fg on fg.id = _from_group_id
  left join public.courses fc on fc.id = fg.course_id
  left join public.groups tg on tg.id = _to_group_id
  left join public.courses tc on tc.id = tg.course_id;
$function$;

-- ── 3. The guard ──
create or replace function public.profiles_course_move_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _f jsonb;
  _waiting int;
  _override boolean;
begin
  _f := public.course_move_facts(new.id, old.group_id, new.group_id);
  if not coalesce((_f->>'cross')::boolean, false) then
    return null;   -- same course, or a group without a course: PR-3a's same-course flow applies
  end if;
  _waiting := coalesce((_f->>'old_course_waiting')::int, 0);
  _override := coalesce(current_setting('app.course_move_override', true), '') = 'on';
  if _waiting > 0 and not _override then
    perform nextval('public.course_move_refusals_seq');
    raise exception using
      errcode = 'P0001',
      message = format('cross_course_refused: %s boshqa kursga (%s) o''tkazilmadi: eski kursda (%s) %s ta vazifa hali baholanmagan. Avval ustoz ularni baholashi kerak. Hech kim ko''chirilmadi.',
                       _f->>'student', coalesce(_f->>'to_course', '?'), coalesce(_f->>'from_course', '?'), _waiting),
      detail = _f::text,
      hint = 'Challenge 6.0 faqat yangi o''quvchilar uchun (20260930181000).';
  end if;
  -- Allowed (nothing waits in the old course, or the owner's transaction-local override): record it.
  begin
    insert into public.admin_actions (actor_user_id, action, target_user_id, target_resource_type, target_resource_id, details)
    values (auth.uid(), 'cross_course_move', new.id, 'profile', new.id,
            _f || jsonb_build_object('override', _override, 'jwt_role', auth.role()));
  exception when others then
    raise warning 'cross_course_move audit row failed: %', sqlerrm;
  end;
  return null;
end;
$function$;

drop trigger if exists trg_profiles_aa_course_move_guard on public.profiles;
create trigger trg_profiles_aa_course_move_guard
  after update of group_id on public.profiles
  for each row
  when (old.group_id is distinct from new.group_id and old.group_id is not null and new.group_id is not null)
  execute function public.profiles_course_move_guard();

-- ── 4. The detector ──
create or replace function public.cross_course_health()
returns jsonb
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  _en text;
  _type int;
  _fn text;
  _guard_ok boolean;
  _n_pending int;
  _n_chat int;
  _pending jsonb;
  _chat jsonb;
  _keys jsonb;
  _moves int;
  _overrides int;
  _refusals bigint;
begin
  select t.tgenabled::text, t.tgtype::int, p.proname::text into _en, _type, _fn
    from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = 'public.profiles'::regclass and t.tgname = 'trg_profiles_aa_course_move_guard'
     and not t.tgisinternal;
  -- tgtype bits: ROW 1, BEFORE 2 (unset = AFTER), UPDATE 16
  _guard_ok := coalesce(_en in ('O', 'A') and _fn = 'profiles_course_move_guard'
                        and (_type & 1) = 1 and (_type & 2) = 0 and (_type & 16) = 16, false);

  with base as (
    select hs.id, hs.submitted_at, hs.telegram_chat_id,
           (hs.score is null or coalesce(hs.score_is_stale, false)) as waiting,
           m.course_id as task_course_id, tc.title as task_course,
           coalesce(tc.title || ' · ', '') || 'M' || (coalesce(m.position, 0) + 1) || ' — ' || left(coalesce(a.title, '?'), 60) as label,
           g.name as group_name, g.course_id as group_course_id, gc.title as group_course,
           coalesce(nullif(btrim(coalesce(p.name, '') || ' ' || coalesce(p.last_name, '')), ''),
                    '@' || nullif(btrim(p.telegram_username), ''), 'Talaba') as student
      from public.homework_submissions hs
      join public.homework_assignments a on a.id = hs.assignment_id
      join public.modules m on m.id = a.module_id
      left join public.courses tc on tc.id = m.course_id
      left join public.profiles p on p.id = hs.user_id
      left join public.groups g on g.id = p.group_id
      left join public.courses gc on gc.id = g.course_id
  ),
  pend as (
    select * from base
     where waiting and task_course_id is not null and group_course_id is not null
       and group_course_id <> task_course_id
  ),
  chat_map as (
    select g.id as group_id, g.name as group_name, g.course_id, x.chat_id
      from public.groups g
      cross join lateral (
        select ('-100' || substring(g.homework_topic_url from '/c/([0-9]{1,15})/'))::bigint as chat_id
         where g.homework_topic_url ~ '/c/[0-9]{1,15}/'
        union
        select ('-100' || substring(g.telegram_group_url from '/c/([0-9]{1,15})/'))::bigint
         where g.telegram_group_url ~ '/c/[0-9]{1,15}/'
        union
        select g.daily_task_chat_id where g.daily_task_chat_id is not null
        union
        select ('-100' || substring(t.telegram_topic_url from '/c/([0-9]{1,15})/'))::bigint
          from public.group_module_topics t
         where t.group_id = g.id and t.telegram_topic_url ~ '/c/[0-9]{1,15}/'
      ) x
     where g.course_id is not null
  ),
  chat as (
    select b.*,
           (select string_agg(distinct cm.group_name, ', ') from chat_map cm where cm.chat_id = b.telegram_chat_id) as chat_group,
           (select string_agg(distinct c2.title, ', ') from chat_map cm join public.courses c2 on c2.id = cm.course_id
             where cm.chat_id = b.telegram_chat_id) as chat_course
      from base b
     where b.telegram_chat_id is not null and b.task_course_id is not null
       and exists (select 1 from chat_map cm where cm.chat_id = b.telegram_chat_id)
       and not exists (select 1 from chat_map cm where cm.chat_id = b.telegram_chat_id and cm.course_id = b.task_course_id)
  )
  select (select count(*)::int from pend),
         (select count(*)::int from chat),
         (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', s.id, 'student', s.student, 'label', s.label, 'group', s.group_name,
                    'group_course', s.group_course, 'task_course', s.task_course,
                    'submitted_at', s.submitted_at) order by s.submitted_at, s.id), '[]'::jsonb)
            from (select * from pend order by submitted_at, id limit 10) s),
         (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', s.id, 'student', s.student, 'label', s.label, 'chat_group', s.chat_group,
                    'chat_course', s.chat_course, 'task_course', s.task_course,
                    'submitted_at', s.submitted_at) order by s.submitted_at, s.id), '[]'::jsonb)
            from (select * from chat order by submitted_at, id limit 10) s),
         (select coalesce(jsonb_agg(k order by k), '[]'::jsonb) from (
            select 'p:' || id::text as k from pend
            union all
            select 'c:' || id::text from chat
            order by 1 limit 500) kk)
    into _n_pending, _n_chat, _pending, _chat, _keys;

  if not _guard_ok then
    _keys := '["guard_down"]'::jsonb || _keys;
  end if;

  select count(*)::int, count(*) filter (where coalesce(details->>'override', '') = 'true')::int
    into _moves, _overrides
    from public.admin_actions
   where action = 'cross_course_move' and created_at > now() - interval '24 hours';

  select case when is_called then last_value else 0 end into _refusals from public.course_move_refusals_seq;

  return jsonb_build_object(
    'guard_ok', _guard_ok,
    'cross_course_pending', _n_pending,
    'cross_chat_captures', _n_chat,
    'pending', _pending,
    'chat', _chat,
    'keys', _keys,
    'moves_24h', _moves,
    'overrides_24h', _overrides,
    'refusals_total', _refusals,
    'alarm', jsonb_array_length(_keys) > 0,
    'checked_at', now());
end;
$function$;

-- Pure: what the watchdog does this run. 'alert' | 'recovered' | 'none'.
--   _keys    the current item keys (p:<submission>, c:<submission>, guard_down, unreadable)
--   _events  new guard refusals since the last run
--   _state   the state row as stored (alerting, notified_keys, last_alert_ms)
create or replace function public.cross_course_alert_decision(_keys jsonb, _events bigint, _state jsonb, _now_ms bigint)
returns text
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  _k jsonb := case when jsonb_typeof(_keys) = 'array' then _keys else '["unreadable"]'::jsonb end;
  _alerting boolean := coalesce(_state->>'alerting', '') = 'true';
  _notified jsonb := case when jsonb_typeof(_state->'notified_keys') = 'array' then _state->'notified_keys' else '[]'::jsonb end;
  _last bigint := least(case when coalesce(_state->>'last_alert_ms', '') ~ '^[0-9]{1,15}$'
                             then (_state->>'last_alert_ms')::bigint else 0 end, _now_ms);
begin
  if coalesce(_events, 0) > 0 then
    return 'alert';
  end if;
  if jsonb_array_length(_k) > 0 then
    if not _alerting then
      return 'alert';
    end if;
    if exists (select 1 from jsonb_array_elements_text(_k) e(v) where not (_notified ? e.v)) then
      return 'alert';
    end if;
    if _now_ms - _last >= 86400000 then
      return 'alert';      -- 24 h reminder while it persists
    end if;
    return 'none';
  end if;
  if _alerting then
    return 'recovered';
  end if;
  return 'none';
end;
$function$;

-- Pure: the admin DM for a report and a decision.
create or replace function public.cross_course_alert_text(_r jsonb, _action text)
returns text
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  _k jsonb := case when jsonb_typeof(_r->'keys') = 'array' then _r->'keys' else '[]'::jsonb end;
  _pending jsonb := case when jsonb_typeof(_r->'pending') = 'array' then _r->'pending' else '[]'::jsonb end;
  _chat jsonb := case when jsonb_typeof(_r->'chat') = 'array' then _r->'chat' else '[]'::jsonb end;
  _np int := case when coalesce(_r->>'cross_course_pending', '') ~ '^[0-9]{1,9}$' then (_r->>'cross_course_pending')::int else 0 end;
  _nc int := case when coalesce(_r->>'cross_chat_captures', '') ~ '^[0-9]{1,9}$' then (_r->>'cross_chat_captures')::int else 0 end;
  _ev int := case when coalesce(_r->>'refusals_new', '') ~ '^[0-9]{1,9}$' then (_r->>'refusals_new')::int else 0 end;
  _mv int := case when coalesce(_r->>'moves_24h', '') ~ '^[0-9]{1,9}$' then (_r->>'moves_24h')::int else 0 end;
  _msg text := '';
  _x jsonb;
begin
  if _action = 'recovered' then
    return '✅ Kurslararo nazorat: boshqa kursga tegishli kutilayotgan vazifa ham, boshqa kurs chatidan olingan vazifa ham qolmadi.';
  end if;
  if _k ? 'unreadable' then
    _msg := _msg || '⚠️ cross_course_health() o‘qilmadi: ' || coalesce(_r->>'error', '?') || E'\n\n';
  end if;
  if _k ? 'guard_down' then
    _msg := _msg || '🚨 Kurs almashtirish himoyasi (trg_profiles_aa_course_move_guard) o‘chirilgan yoki yo‘q: '
         || 'talabani baholanmagan vazifalari bilan boshqa kursga o‘tkazish yana mumkin.' || E'\n\n';
  end if;
  if _np > 0 then
    _msg := _msg || '⚠️ ' || _np || ' ta baholanmagan vazifa talabaning hozirgi guruhi kursiga tegishli emas. '
         || 'Uni yangi guruh ustozlari ko‘radi, asl ustoz esa ko‘rmaydi:' || E'\n';
    for _x in select v from jsonb_array_elements(_pending) v loop
      _msg := _msg || '• ' || coalesce(_x->>'student', '?') || ' — ' || coalesce(_x->>'label', '?')
           || ' · hozir: ' || coalesce(_x->>'group', '?') || coalesce(' (' || (_x->>'group_course') || ')', '') || E'\n';
    end loop;
    if _np > jsonb_array_length(_pending) then
      _msg := _msg || '… va yana ' || (_np - jsonb_array_length(_pending)) || ' ta' || E'\n';
    end if;
    _msg := _msg || 'Tuzatish: asl kurs ustozi vazifani baholasin yoki talabani eski guruhiga qaytaring.' || E'\n\n';
  end if;
  if _nc > 0 then
    _msg := _msg || '⚠️ ' || _nc || ' ta vazifa boshqa kurs guruhining Telegram chatidan olingan '
         || '(vazifa bir kursga, chat boshqa kursga tegishli):' || E'\n';
    for _x in select v from jsonb_array_elements(_chat) v loop
      _msg := _msg || '• ' || coalesce(_x->>'student', '?') || ' — ' || coalesce(_x->>'label', '?')
           || ' · chat: ' || coalesce(_x->>'chat_group', '?') || coalesce(' (' || (_x->>'chat_course') || ')', '')
           || coalesce(' · ' || left(_x->>'submitted_at', 10), '') || E'\n';
    end loop;
    if _nc > jsonb_array_length(_chat) then
      _msg := _msg || '… va yana ' || (_nc - jsonb_array_length(_chat)) || ' ta' || E'\n';
    end if;
    _msg := _msg || 'Tuzatish: vazifani to‘g‘ri kursdagi topshiriqqa o‘tkazing yoki o‘chiring.' || E'\n\n';
  end if;
  if _ev > 0 then
    _msg := _msg || 'ℹ️ Himoya ' || _ev || ' marta talabani boshqa kursga o‘tkazishni rad etdi: eski kursda '
         || 'baholanmagan vazifa bor edi (bu urinishlar hech narsani o‘zgartirmadi).' || E'\n\n';
  end if;
  if _mv > 0 then
    _msg := _msg || 'ℹ️ 24 soatda ' || _mv || ' ta talaba boshqa kursga o‘tkazildi (admin_actions: cross_course_move).' || E'\n\n';
  end if;
  if _msg = '' then
    _msg := '⚠️ Holatni o‘qib bo‘lmadi: ' || left(coalesce(_r::text, 'NULL'), 500) || E'\n\n';
  end if;
  return '🔀 Kurslararo nazorat' || E'\n\n' || rtrim(_msg, E'\n');
end;
$function$;

create or replace function public.cross_course_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _state jsonb;
  _r jsonb;
  _err text;
  _keys jsonb;
  _total bigint;
  _seen bigint;
  _events bigint;
  _report jsonb;
  _action text;
  _now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  _last_ms bigint;
  _alerting boolean;
  _notified jsonb;
  _tok text;
  _admin record;
  _msg text;
  _dm int := 0;
begin
  select value into _state from public.app_settings where key = 'cross_course_watchdog_state';
  if jsonb_typeof(_state) is distinct from 'object' then
    _state := '{}'::jsonb;
  end if;

  begin
    _r := public.cross_course_health();
  exception when others then
    _err := left(sqlerrm, 300);
    _r := null;
  end;

  -- A verdict we cannot read is itself an alarm, never a quiet "false".
  _keys := case when _r is not null and jsonb_typeof(_r->'keys') = 'array' then _r->'keys'
                else '["unreadable"]'::jsonb end;
  _total := case when coalesce(_r->>'refusals_total', '') ~ '^[0-9]{1,18}$' then (_r->>'refusals_total')::bigint end;
  _seen := case when coalesce(_state->>'refusals_seen', '') ~ '^[0-9]{1,18}$' then (_state->>'refusals_seen')::bigint end;
  _events := case when _total is null or _seen is null then 0 else greatest(_total - _seen, 0) end;
  _report := coalesce(_r, '{}'::jsonb)
          || jsonb_build_object('keys', _keys, 'refusals_new', _events, 'error', _err,
                                'alarm', jsonb_array_length(_keys) > 0 or _events > 0);

  _action := public.cross_course_alert_decision(_keys, _events, _state, _now_ms);

  if _action in ('alert', 'recovered') then
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if coalesce(_tok, '') <> '' then
      _msg := public.cross_course_alert_text(_report, _action);
      for _admin in
        select distinct p.telegram_id from public.profiles p
        join public.user_roles ro on ro.user_id = p.id and ro.role in ('admin', 'superadmin')
        where p.telegram_id is not null limit 3
      loop
        begin
          perform public.ops_net_post(
            p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            p_body       := jsonb_build_object('chat_id', _admin.telegram_id, 'text', left(_msg, 3900)),
            p_headers    := jsonb_build_object('Content-Type', 'application/json'),
            p_purpose    := 'cross_course_watchdog',
            p_timeout_ms := 5000);
          _dm := _dm + 1;
        exception when others then null; end;
      end loop;
    end if;
  end if;

  -- DB-visible rows: every recovery, every alert with new events or a DM, and an undelivered alert only when
  -- its key set changed (no bot token / no admin telegram_id would otherwise write one row an hour).
  if _action = 'recovered'
     or (_action = 'alert' and (_dm > 0 or _events > 0 or (_state->'undelivered') is distinct from _keys)) then
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null,
              case when _action = 'recovered' then 'cross_course_watchdog_recovered' else 'cross_course_watchdog_ALARM' end,
              _report || jsonb_build_object('decision', _action, 'dm_attempted', _dm));
    exception when others then null; end;
  end if;

  -- State. The episode (alerting / notified_keys) starts only when a DM was actually attempted, so a
  -- "recovered" message is never sent for an episode nobody was told about, and the next run retries.
  _alerting := coalesce(_state->>'alerting', '') = 'true';
  _notified := case when jsonb_typeof(_state->'notified_keys') = 'array' then _state->'notified_keys' else '[]'::jsonb end;
  _last_ms := least(case when coalesce(_state->>'last_alert_ms', '') ~ '^[0-9]{1,15}$'
                         then (_state->>'last_alert_ms')::bigint else 0 end, _now_ms);
  if jsonb_array_length(_keys) = 0 then
    _alerting := false;
    _notified := '[]'::jsonb;
  elsif _action = 'alert' and _dm > 0 then
    _alerting := true;
    _notified := _keys;
    _last_ms := _now_ms;
  end if;

  insert into public.app_settings (key, value)
  values ('cross_course_watchdog_state', jsonb_build_object(
    'alerting', _alerting,
    'notified_keys', _notified,
    'last_alert_ms', _last_ms,
    'refusals_seen', coalesce(_total, _seen),
    'undelivered', case when _action = 'alert' and _dm = 0 then _keys end,
    'first_checked_at', coalesce(_state->'first_checked_at', to_jsonb(now())),
    'dm_attempted_last_run', _dm,
    'last_action', _action,
    'last_report', _report - 'keys',
    'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return _report || jsonb_build_object('decision', _action, 'dm_attempted', _dm);
end;
$function$;

-- House pattern: PUBLIC first, then the roles; only service_role (and the owner) may run them.
revoke execute on function public.course_move_facts(uuid, uuid, uuid) from public, anon, authenticated;
grant  execute on function public.course_move_facts(uuid, uuid, uuid) to service_role;
revoke execute on function public.profiles_course_move_guard() from public, anon, authenticated;
revoke execute on function public.cross_course_health() from public, anon, authenticated;
grant  execute on function public.cross_course_health() to service_role;
revoke execute on function public.cross_course_alert_decision(jsonb, bigint, jsonb, bigint) from public, anon, authenticated;
grant  execute on function public.cross_course_alert_decision(jsonb, bigint, jsonb, bigint) to service_role;
revoke execute on function public.cross_course_alert_text(jsonb, text) from public, anon, authenticated;
grant  execute on function public.cross_course_alert_text(jsonb, text) to service_role;
revoke execute on function public.cross_course_watchdog() from public, anon, authenticated;
grant  execute on function public.cross_course_watchdog() to service_role;

-- ── 5. hw_dm_health_stats: the two fields (pinned rewrite, see the header) ──
do $mig$
declare
  _pin    constant text := 'fa76b14cdcfeb3c84e5220852e0e6bef';  -- md5(replace(prosrc, CR, '')), live, 2026-09-30
  _marker constant text := '(20260930181000)';

  _old1 constant text := E'  _voice_dm_failed_24h int;\nbegin\n';
  _new1 constant text := E'  _voice_dm_failed_24h int;\n'
                      || E'  _cross_course_pending int;\n'
                      || E'  _cross_chat_captures int;\n'
                      || E'begin\n';

  _old2 constant text := E'  return jsonb_build_object(\n';
  _new2 constant text :=
       E'  -- Cross-course homework (20260930181000): waiting work whose task belongs to another course than the\n'
    || E'  -- student''s current group (a move carried it to the new group''s teachers), and work captured in the\n'
    || E'  -- Telegram chat of a group of another course. Both are 0 by design; cross_course_watchdog() DMs the\n'
    || E'  -- admins. -1 = the check itself failed: fail loud (!= 0), never 500 the whole endpoint.\n'
    || E'  begin\n'
    || E'    select case when coalesce(h->>''cross_course_pending'', '''') ~ ''^[0-9]{1,9}$''\n'
    || E'                then (h->>''cross_course_pending'')::int else -1 end,\n'
    || E'           case when coalesce(h->>''cross_chat_captures'', '''') ~ ''^[0-9]{1,9}$''\n'
    || E'                then (h->>''cross_chat_captures'')::int else -1 end\n'
    || E'      into _cross_course_pending, _cross_chat_captures\n'
    || E'      from (select public.cross_course_health() as h) x;\n'
    || E'  exception when others then\n'
    || E'    _cross_course_pending := -1;\n'
    || E'    _cross_chat_captures := -1;\n'
    || E'  end;\n'
    || E'\n'
    || E'  return jsonb_build_object(\n';

  _old3 constant text := E'    ''voice_dm_failed_24h'', _voice_dm_failed_24h,\n';
  _new3 constant text := E'    ''voice_dm_failed_24h'', _voice_dm_failed_24h,\n'
                      || E'    ''cross_course_pending'', _cross_course_pending,\n'
                      || E'    ''cross_chat_captures'', _cross_chat_captures,\n';

  _olds text[];
  _news text[];
  _fn regprocedure;
  _src text; _def text; _new text;
  _acl text; _owner oid; _secdef boolean;
  _n int;
begin
  -- The CREATE OR REPLACE below must validate the edited body, whatever the session default is.
  perform set_config('check_function_bodies', 'on', true);

  _fn := to_regprocedure('public.hw_dm_health_stats()');
  if _fn is null then
    raise exception 'ABORT: public.hw_dm_health_stats() does not exist';
  end if;
  select prosrc, coalesce(array_to_string(proacl, ','), ''), proowner, prosecdef
    into _src, _acl, _owner, _secdef
    from pg_proc where oid = _fn;

  if position(_marker in _src) > 0 then
    raise notice 'hw_dm_health_stats already reports the cross-course fields -- rewrite skipped';
  else
    if md5(replace(_src, E'\r', '')) <> _pin then
      raise exception 'ABORT: hw_dm_health_stats changed since it was verified on 2026-09-30 (md5 %); re-read the live definition and regenerate this migration',
        md5(replace(_src, E'\r', ''));
    end if;

    _olds := array[_old1, _old2, _old3];
    _news := array[_new1, _new2, _new3];
    _def := pg_get_functiondef(_fn);
    _new := _def;
    for i in 1 .. array_length(_olds, 1) loop
      _n := (length(_new) - length(replace(_new, _olds[i], ''))) / length(_olds[i]);
      if _n <> 1 then
        raise exception 'ABORT: hw_dm_health_stats edit % matched % times (want exactly 1); regenerate this migration', i, _n;
      end if;
      _new := replace(_new, _olds[i], _news[i]);
    end loop;

    execute _new;

    -- Post-conditions, from the catalog only.
    if pg_get_functiondef(_fn) is distinct from _new then
      raise exception 'ABORT: hw_dm_health_stats -- the stored definition differs from the one executed';
    end if;
    if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
       or (select proowner from pg_proc where oid = _fn) <> _owner
       or (select prosecdef from pg_proc where oid = _fn) <> _secdef then
      raise exception 'ABORT: hw_dm_health_stats -- owner, ACL or SECURITY DEFINER changed';
    end if;
  end if;

  if has_function_privilege('anon', _fn, 'EXECUTE') or has_function_privilege('authenticated', _fn, 'EXECUTE') then
    raise exception 'ABORT: hw_dm_health_stats is executable by anon or authenticated';
  end if;
  select prosrc into _src from pg_proc where oid = _fn;
  if position('from (select public.cross_course_health() as h) x;' in _src) = 0
     or position(E'    ''cross_chat_captures'', _cross_chat_captures,\n' in _src) = 0
     or position(_marker in _src) = 0 then
    raise exception 'ABORT: hw_dm_health_stats -- the cross-course fields are not in the stored body';
  end if;
end $mig$;

-- ── 6. Schedule: hourly at :49 (a minute no other job uses) ──
do $$
begin
  perform cron.unschedule('cross-course-watchdog');
exception when others then null;
end $$;

do $$
begin
  perform cron.schedule('cross-course-watchdog', '49 * * * *',
                        $cmd$ select public.cross_course_watchdog() $cmd$);
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_schedule_failed',
          jsonb_build_object('job', 'cross-course-watchdog', 'error', sqlerrm));
end $$;

-- ── 7. Deploy self-test + state seed + one audit row (see the header) ──
do $selftest$
declare
  _fn text;
  _t record;
  _h jsonb;
  _s jsonb;
  _f jsonb;
  _txt text;
  _now bigint := 1790000000000;
  _uid uuid;
  _from uuid;
  _to uuid;
  _outcome text;
  _live text := 'skipped: no student with waiting homework in their group''s course, or no group of another course';
begin
  -- Static: the trigger.
  select t.tgenabled::text as en, t.tgtype::int as ty, p.proname::text as fn, pg_get_triggerdef(t.oid) as def
    into _t
    from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = 'public.profiles'::regclass and t.tgname = 'trg_profiles_aa_course_move_guard' and not t.tgisinternal;
  if not found then
    raise exception 'ABORT: self-test -- trg_profiles_aa_course_move_guard is missing';
  end if;
  if _t.en not in ('O', 'A') or _t.fn <> 'profiles_course_move_guard'
     or (_t.ty & 1) <> 1 or (_t.ty & 2) <> 0 or (_t.ty & 16) <> 16
     or _t.def !~ 'AFTER UPDATE OF group_id ON public\.profiles FOR EACH ROW WHEN' then
    raise exception 'ABORT: self-test -- the guard trigger has the wrong shape: %', _t.def;
  end if;

  -- Static: nothing new is reachable by anon or authenticated.
  foreach _fn in array array['public.course_move_facts(uuid,uuid,uuid)', 'public.profiles_course_move_guard()',
                             'public.cross_course_health()', 'public.cross_course_alert_decision(jsonb,bigint,jsonb,bigint)',
                             'public.cross_course_alert_text(jsonb,text)', 'public.cross_course_watchdog()'] loop
    if to_regprocedure(_fn) is null then
      raise exception 'ABORT: self-test -- % is missing', _fn;
    end if;
    if has_function_privilege('anon', to_regprocedure(_fn), 'EXECUTE')
       or has_function_privilege('authenticated', to_regprocedure(_fn), 'EXECUTE') then
      raise exception 'ABORT: self-test -- % is executable by anon or authenticated', _fn;
    end if;
  end loop;
  if has_sequence_privilege('anon', 'public.course_move_refusals_seq', 'USAGE')
     or has_sequence_privilege('authenticated', 'public.course_move_refusals_seq', 'USAGE') then
    raise exception 'ABORT: self-test -- course_move_refusals_seq is usable by anon or authenticated';
  end if;

  -- Pure decision, fixed vectors.
  if public.cross_course_alert_decision('[]'::jsonb, 0, '{}'::jsonb, _now) <> 'none'
     or public.cross_course_alert_decision('["p:a"]'::jsonb, 0, '{}'::jsonb, _now) <> 'alert'
     or public.cross_course_alert_decision('["p:a"]'::jsonb, 0,
          jsonb_build_object('alerting', true, 'notified_keys', '["p:a"]'::jsonb, 'last_alert_ms', _now - 3600000), _now) <> 'none'
     or public.cross_course_alert_decision('["p:a","c:b"]'::jsonb, 0,
          jsonb_build_object('alerting', true, 'notified_keys', '["p:a"]'::jsonb, 'last_alert_ms', _now - 3600000), _now) <> 'alert'
     or public.cross_course_alert_decision('["p:a"]'::jsonb, 0,
          jsonb_build_object('alerting', true, 'notified_keys', '["p:a"]'::jsonb, 'last_alert_ms', _now - 86400000), _now) <> 'alert'
     or public.cross_course_alert_decision('["p:a"]'::jsonb, 0,
          jsonb_build_object('alerting', true, 'notified_keys', '["p:a"]'::jsonb, 'last_alert_ms', _now + 999999999), _now) <> 'none'
     or public.cross_course_alert_decision('[]'::jsonb, 0, jsonb_build_object('alerting', true), _now) <> 'recovered'
     or public.cross_course_alert_decision('[]'::jsonb, 2, '{}'::jsonb, _now) <> 'alert'
     or public.cross_course_alert_decision(null, 0, '{}'::jsonb, _now) <> 'alert' then
    raise exception 'ABORT: self-test -- cross_course_alert_decision failed a fixed vector';
  end if;

  -- Pure text, fixed vectors.
  _txt := public.cross_course_alert_text(jsonb_build_object(
            'keys', '["guard_down","p:1"]'::jsonb, 'cross_course_pending', 11, 'cross_chat_captures', 0,
            'pending', jsonb_build_array(jsonb_build_object('student', 'Ali Valiyev', 'label', 'AI CREATORS 5.0 · M2 — ATIR',
                                                            'group', 'AC CHALLENGE | 3-GURUH', 'group_course', 'AI CREATORS CHALLENGE 6.0'))),
          'alert');
  if _txt is null or position('🔀 Kurslararo nazorat' in _txt) <> 1 or position('trg_profiles_aa_course_move_guard' in _txt) = 0
     or position('11 ta baholanmagan vazifa' in _txt) = 0
     or position('• Ali Valiyev — AI CREATORS 5.0 · M2 — ATIR · hozir: AC CHALLENGE | 3-GURUH (AI CREATORS CHALLENGE 6.0)' in _txt) = 0
     or position('… va yana 10 ta' in _txt) = 0 then
    raise exception 'ABORT: self-test -- cross_course_alert_text rendered unexpectedly: %', _txt;
  end if;
  if public.cross_course_alert_text('{}'::jsonb, 'recovered') not like '✅%' then
    raise exception 'ABORT: self-test -- the recovered text is wrong';
  end if;

  -- Read-only verdicts on live data (well-formed; not asserted to be 0).
  _h := public.cross_course_health();
  if _h is null or (_h->>'guard_ok') is distinct from 'true'
     or coalesce(_h->>'cross_course_pending', '') !~ '^[0-9]+$' or coalesce(_h->>'cross_chat_captures', '') !~ '^[0-9]+$'
     or jsonb_typeof(_h->'keys') <> 'array' or jsonb_typeof(_h->'pending') <> 'array' or jsonb_typeof(_h->'chat') <> 'array' then
    raise exception 'ABORT: self-test -- cross_course_health() is not well-formed: %', coalesce(_h::text, 'NULL');
  end if;
  _s := public.hw_dm_health_stats();
  if coalesce(_s->>'cross_course_pending', '') !~ '^[0-9]+$' or coalesce(_s->>'cross_chat_captures', '') !~ '^[0-9]+$'
     or (_s->>'cross_course_pending')::int <> (_h->>'cross_course_pending')::int
     or (_s->>'cross_chat_captures')::int <> (_h->>'cross_chat_captures')::int then
    raise exception 'ABORT: self-test -- hw_dm_health_stats() does not carry the two fields: %', coalesce(_s::text, 'NULL');
  end if;
  _f := public.course_move_facts(null, null, null);
  if _f is null or (_f->>'cross') <> 'false' or (_f->>'old_course_waiting') <> '0' then
    raise exception 'ABORT: self-test -- course_move_facts(null, null, null) = %', coalesce(_f::text, 'NULL');
  end if;

  -- The guard on live data, rolled back (see the header).
  select hs.user_id, p.group_id, tg.id
    into _uid, _from, _to
    from public.homework_submissions hs
    join public.homework_assignments a on a.id = hs.assignment_id
    join public.modules m on m.id = a.module_id
    join public.profiles p on p.id = hs.user_id
    join public.groups g on g.id = p.group_id and g.course_id = m.course_id
    join public.groups tg on tg.course_id is not null and tg.course_id <> g.course_id
   where hs.score is null or coalesce(hs.score_is_stale, false)
   order by hs.submitted_at, hs.id, tg.id
   limit 1;
  if _uid is not null then
    _f := public.course_move_facts(_uid, _from, _to);
    if (_f->>'cross') <> 'true' or coalesce((_f->>'old_course_waiting')::int, 0) < 1 then
      raise exception 'ABORT: self-test -- course_move_facts does not see the live vector: %', _f;
    end if;
    if coalesce(current_setting('app.course_move_override', true), '') = 'on' then
      raise exception 'ABORT: self-test -- app.course_move_override is on in the deploy session';
    end if;
    _outcome := null;
    begin
      update public.profiles set group_id = _to where id = _uid;
      _outcome := 'moved';
      raise exception 'course_move_guard_selftest_sentinel';
    exception when others then
      if _outcome is null then
        _outcome := sqlerrm;
      end if;
    end;
    if _outcome = 'moved' then
      raise exception 'ABORT: self-test -- the guard did NOT refuse a cross-course move with % waiting homework (rolled back)',
        _f->>'old_course_waiting';
    end if;
    if _outcome not like 'cross_course_refused: %' then
      raise exception 'ABORT: self-test -- the guard failed with an unexpected error: %', _outcome;
    end if;
    if (select group_id from public.profiles where id = _uid) is distinct from _from then
      raise exception 'ABORT: self-test -- the refused move was not rolled back';
    end if;
    _live := 'refused as expected: ' || left(_outcome, 200);
  end if;

  -- The watchdog's baseline, AFTER the refusal above (its counter bump is not a new event).
  insert into public.app_settings (key, value)
  values ('cross_course_watchdog_state', jsonb_build_object(
    'alerting', false,
    'notified_keys', '[]'::jsonb,
    'last_alert_ms', 0,
    'refusals_seen', (_h->>'refusals_total')::bigint
                     + case when _live like 'refused%' then 1 else 0 end,
    'first_checked_at', now(),
    'seeded_by', '20260930181000',
    'last_report', _h - 'keys',
    'checked_at', now()))
  on conflict (key) do nothing;

  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'cross_course_move_guard_installed',
         jsonb_build_object('migration', '20260930181000',
                            'trigger', 'trg_profiles_aa_course_move_guard',
                            'watchdog', 'cross-course-watchdog (hourly :49)',
                            'health_fields', jsonb_build_array('cross_course_pending', 'cross_chat_captures'),
                            'cross_course_pending', (_h->>'cross_course_pending')::int,
                            'cross_chat_captures', (_h->>'cross_chat_captures')::int,
                            'live_guard_selftest', _live,
                            'at', now())
  where not exists (select 1 from public.admin_actions where action = 'cross_course_move_guard_installed');
end $selftest$;
