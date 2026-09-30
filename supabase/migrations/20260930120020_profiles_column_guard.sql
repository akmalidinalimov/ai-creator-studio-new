-- SECURITY: a signed-in student could rewrite the privileged columns of their own profile row.
-- PR-0 of the Challenge Daily Tasks plan (design §3A, gap G2). Prevention hierarchy layer 2 (DB
-- invariant) plus a layer-5 detector.
-- Re-issue of 20260930120010 (never applied anywhere), adding two review findings: the student arm
-- of "hws own update", and active_teacher_group_id as a SCOPED column.
--
-- ── EVIDENCE (production, read-only, 2026-09-30) ────────────────────────────────────────────────
--   * pg_class.relacl on public.profiles: anon=arwdDxtm, authenticated=arwdDxtm (table-level UPDATE,
--     every column; pg_attribute.attacl is NULL everywhere).
--   * The only UPDATE policy, "profiles update own or admin": USING (auth.uid() = id OR
--     has_role(auth.uid(), 'admin')), no WITH CHECK (so the USING expression is the check, which keeps
--     id fixed and nothing else). "profiles insert self": WITH CHECK (auth.uid() = id OR admin).
--   * Triggers: trg_new_student_alert, trg_profiles_normalize_instagram,
--     trg_profiles_sync_group_enrollment, trg_profiles_updated. None guards a column.
--   So `PATCH /rest/v1/profiles?id=eq.<self>` with a student JWT could set:
--     account_type='paid'        -> lesson-video-url (server side) and the bot's lesson commands refuse
--                                   lessons to 'provisional' accounts by this column alone;
--     group_id=<any group>       -> trg_profiles_sync_group_enrollment (SECURITY DEFINER) then ENROLLS
--                                   them in that group's course and tier ("on conflict do update set
--                                   tier_id"), i.e. free paid access or a tier upgrade;
--     telegram_id / telegram_username / email -> the identity keys every linker and importer matches
--                                   on: the bot, telegram-auth and tg-miniapp-auth link a Telegram
--                                   account to the profile with this username and a NULL telegram_id;
--                                   staff-intake and admin-create-students patch the EXISTING profile
--                                   with this username (group, tier, account_type=paid); AdminGroups'
--                                   CSV import matches by email or username. Squatting a classmate's
--                                   handle therefore diverts the classmate's intake, paid access and
--                                   (for the daily-task engine) their posts to the squatter;
--     status / archived_at       -> undo an admin's deactivation or archive.
--
-- ── LEGITIMATE WRITERS (every one verified; none is a student) ──────────────────────────────────
--   src/ (supabase-js as `authenticated`): only admin pages write the guarded columns
--     (AdminUsers: status, archived_at, telegram_id, updateProfile; AdminGroups: group_id,
--     account_type; GroupDetail: group_id). Students write preferred_language (Settings,
--     LanguageSwitcher), name/last_name/timezone/weekly_goal_lessons/instagram_username (Settings),
--     avatar_url (Profile), digest_opt_in (Settings). Teachers write active_teacher_group_id
--     (TeacherProfile.pickGroup, AdminDashboard), always a group from teacher_groups(). No src/
--     code inserts or upserts profiles.
--   Edge functions: every profiles write goes through a service_role client (admin-create-students,
--     admin-merge-duplicates, staff-intake, telegram-auth, telegram-bot-webhook, tg-miniapp-auth,
--     cron-engagement, sheet-sync).
--   SQL: admin_assign_group (admin-gated), admin_set_account_type (admin/superadmin-gated),
--     set_board_visibility (hide_from_group_boards only), handle_new_user (defaults only). All four
--     are SECURITY DEFINER. No SECURITY INVOKER function writes profiles.
--
-- ── WHAT THIS DOES ──────────────────────────────────────────────────────────────────────────────
-- 1. profiles.telegram_write_access_at (moved here from PR-3 so the guard can list it).
-- 2. profiles_column_guard(), SECURITY INVOKER, BEFORE INSERT OR UPDATE, trigger
--    trg_profiles_zz_column_guard. A caller is PRIVILEGED when current_user is not authenticated/anon
--    (service_role, a migration, cron, or any SECURITY DEFINER function, which runs as its owner) or
--    when auth.uid() has the admin or superadmin role. For everyone else, a change to any GUARDED
--    column (UPDATE: IS DISTINCT FROM; INSERT: anything but the column default, and an email that is
--    not the caller's own sign-in email) raises P0001 'Bu maydonni faqat admin o‘zgartira oladi'.
--      GUARDED: telegram_id, telegram_username, email, group_id, status, archived_at, account_type,
--               telegram_write_access_at, created_at.
--      SCOPED:  active_teacher_group_id. The bot scopes a teacher's roster, module-progress and
--               legacy student-picker views by this column (tr:list, thm:list, thm:mod, gs:list), so
--               a non-privileged caller may set it only to NULL or to a group they teach
--               (is_group_teacher: groups.teacher_id or group_teachers). Anything else is rejected
--               like a guarded column. Not recorded as a privileged change (the bot rewrites it on
--               every group switch, which would be noise), and not part of the drift snapshot.
--               The bot re-checks the stored value on read as well (a reassignment leaves it stale).
--      SELF-EDITABLE (unchanged): name, last_name, avatar_url, bio, phone, timezone,
--               tashkent_offset_minutes, weekly_goal_lessons, goals, onboarding_completed,
--               preferred_language, preferred_locale, reminder_time, notifications_enabled,
--               digest_opt_in, hide_from_group_boards, instagram_username (audited, step 4), and
--               the bot's bookkeeping stamps (telegram_onboarded_at, name_confirmed_at,
--               name_prompt_last_at, last_*_reminder/warning_*). None of them grants access to
--               anything or anyone else: they shape the user's own display and own reminders.
--    Consequences checked: an FK action (groups deleted -> group_id SET NULL) runs as the table owner,
--    so it passes and is recorded; a client UPSERT that echoes guarded values would fail its INSERT
--    arm (the BEFORE INSERT trigger sees the proposed row), and no client upserts profiles.
--    A privileged change of a guarded column writes admin_actions 'profile_privileged_change'
--    {op, changes:{col:{old,new}}, caller, jwt_role}. Until now most of these changes (CSV imports,
--    dashboard edits) left no per-user trail at all, which is why the blast-radius query below could
--    not attribute two of them.
-- 3. A rejection cannot leave a row (the raise rolls the statement back), so it bumps a SEQUENCE,
--    profiles_guard_rejections_seq, whose nextval survives the rollback. The watchdog reads it.
-- 4. trg_profiles_zz_instagram_audit: AFTER UPDATE OF instagram_username writes admin_actions
--    'instagram_handle_changed' {old, new, actor, jwt_role, request_role}. (PR-3 locks the handle.)
-- 5. FAN-OUT, same class (a student-writable row that mints XP, badges or grades), each policy
--    unused by any legitimate writer (all writers are SECURITY DEFINER or service_role, which bypass
--    RLS; src/ never writes these tables):
--      streaks  "streaks own write"/"streaks own update": set current_streak = 30 with a fresh
--               last_active_date -> xp_on_streak_milestone pays 200 XP per distinct date (ref key
--               'streak30:'||date), unbounded; evaluate_streak_badges awards streak badges.
--      daily_watch_summary "dws own insert"/"dws own update": one row per invented date -> 5 XP each
--               (xp_on_daily_activity; reconcile_daily_active_xp re-derives it), unbounded, and the
--               row also counts as genuine activity for streaks.
--      homework_submissions "hws own insert": insert your own submission already graded (score 10,
--               scored_by = self) -> homework XP, teacher-grade XP to "scored_by", the perfect-score
--               badge and the Saturday group spotlight. Every real insert is service_role
--               (submit-homework, the bot).
--      homework_submissions "hws own update", STUDENT ARM only: ((auth.uid() = user_id) AND
--               (score IS NULL)) with no WITH CHECK keeps score NULL and nothing else, so a student
--               could write previous_attempts, previous_score, scored_by, scored_at, assignment_id and
--               submitted_at on their own ungraded row. previous_attempts is READ AS A GRADE:
--               user_homework_avg10_effective() and vw_module_homework_score_effective take
--               COALESCE(score, last numeric previous_attempts[].score), recalc_leaderboard() feeds it
--               into leaderboard_cache, and pick_weekly_group_stars() (Student of the Week) picks the
--               top of that; staff pages show previous_attempts as earlier grades. The arm has no
--               legitimate writer: src/ updates homework_submissions only from teacher code
--               (TeacherProfile, teacherApi, TeacherHomework), students submit through submit-homework
--               (service_role) and resubmit through start_homework_resubmission (SECURITY DEFINER), and
--               every pg_proc writer is SECURITY DEFINER. The policy is re-created with the admin and
--               teacher arms only, WITH CHECK = USING, TO authenticated (live it was TO PUBLIC).
--      quiz_attempts "quiz_a own all" -> replaced by a read-only "quiz_a own read" (grade_quiz_attempt,
--               SECURITY DEFINER, is the only writer; staff dashboards read these scores).
--    NOT changed here (documented in the PR): lesson_progress (the client writes completed_at by
--    design, so a student can mark any lesson complete: 20 XP per lesson, bounded; fixing it needs
--    server-side completion), and the self-only tables (notes, bookmarks, ratings, comments,
--    ai_chat_messages, user_daily_goal, nudge_preferences, module_celebrations, auth_events).
-- 6. DETECTOR (hourly at :19, cron 'profiles-guard-watchdog'), DMs up to 3 admins via ops_net_post:
--      guard_down            the guard trigger is missing, disabled, not BEFORE INSERT/UPDATE ROW,
--                            SECURITY DEFINER (that would make every caller "privileged"), or not the
--                            LAST before-row trigger (a later one could rewrite a column after the
--                            check);
--      instagram_audit_down  the handle audit trigger is missing or disabled;
--      rls_drift             a write policy reappeared on a table closed in step 5, or an UPDATE
--                            policy on homework_submissions regained a student arm
--                            (auth.uid() = user_id) or an unconditional (true) predicate;
--      rejections (event)    new guard rejections since the last run (sequence delta);
--      drift (event)         a guarded column changed with no matching 'profile_privileged_change'
--                            row, i.e. the trigger was bypassed (disabled, session_replication_role,
--                            a superuser edit). Compared against profiles_guard_snapshot, refreshed in
--                            the SAME statement that compares it (one MVCC snapshot), so a change is
--                            examined exactly once.
--    The state row is named 'profiles_guard_watchdog_state', so hw_dm_health_stats().stale_watchdogs
--    (asserted by the out-of-band GitHub verifier) reports this cron if it stops for 25 h.
--
-- ── BLAST RADIUS (read-only, 2026-09-30) ───────────────────────────────────────────────────────
--   No DB history of profile writes exists, and the API logs carry no request body, so a self-edit
--   cannot be proven or excluded row by row. Cross-checks:
--   * 40 bot-registered 'provisional' profiles still exist; 33 are now 'paid'; 31 of those have a
--     staff_intake / account_type_changed trail. 2 have none: 19ee0d35… and 71c477cf…. The second
--     ALSO had its telegram_id replaced (8590499891 -> 8622111901, the same @username on a new
--     Telegram account) with no audit row, while every code path that writes telegram_id only fills
--     a NULL and logs it. Consistent with a manual dashboard fix; referred to the owner, not healed.
--   * 164 grouped students: 144 posted in their group's chat, the rest have an intake/import trail.
--     0 uncorroborated. All 164 tiered enrollments match the current group's tier; 3 more belong to
--     students who now have no group (a removal keeps the enrollment; not an escalation).
--   * 572 telegram_ids: 0 unexplained (seen in the bot's inbox, or created/linked with a trail).
--   * Fan-out: 734 graded submissions, 0 self-graded or graded by a non-staff user; 10291
--     daily_watch_summary rows, 0 in the future, 0 XP without a row; streaks bounded by account
--     age, <= 2 streak_30 awards per user; 5 quiz attempts ever, all score-consistent.
--   * "hws own update" student arm: 220 previous_attempts entries on 127 rows, and ALL 220 equal,
--     key for key, the 'RESUBMIT' progress_audit snapshot that start_homework_resubmission wrote
--     for that row; all 220 were scored by staff; 0 entries above 10; 0 ungraded rows carrying
--     previous_attempts, scored_by or scored_at; leaderboard_cache max 91. The 3 ungraded rows with a
--     previous_score are the bot's picker-path resubmits (source telegram_topic, which stamps
--     previous_score and resets score by design).
--   * active_teacher_group_id: 3 profiles hold one, all 3 teach that group. The bot's inbox has 2
--     tprof:g: taps since 2026-05-06; 1 names a group this teacher does not teach, and that group no
--     longer exists (pre-replay id, 2026-07-06), i.e. stale, not forged.
--   => nothing proven damaged, so there is no heal step.
--
-- ── DEVIATIONS FROM THE DESIGN (§3A), and why ──────────────────────────────────────────────────
--   * Trigger name trg_profiles_zz_column_guard, not trg_profiles_aa_…: BEFORE triggers fire in name
--     order, and trg_profiles_normalize_instagram rewrites instagram_username. Firing LAST, the guard
--     judges the final row; PR-3's handle lock needs exactly that (it compares the NORMALISED handle).
--   * Three more guarded columns: telegram_username and email are identity keys (see above) and
--     created_at is an audit timestamp. No legitimate non-admin writer of any of them exists.
--   * active_teacher_group_id is SCOPED (above), and the bot re-validates it on read
--     (telegram-bot-webhook/teacher-scope.ts). The design marked PR-0 touches_bot: false; review
--     found the bot trusting the column, and a stale value after a reassignment can only be
--     caught by the reader, so this PR carries that two-site bot change.
--   * "hws own update" loses its student arm (review finding; same class as the policies closed in
--     step 5).
--   * The rejection counter and the drift snapshot (the design had no DB-visible rejection signal).
--   * Column REVOKE/GRANT is NOT used: a column REVOKE is a no-op against the table GRANT, and
--     replacing the table GRANT with column GRANTs would also block the admin pages, which write
--     these columns as `authenticated`.
--
-- ── KILL-SWITCHES ──────────────────────────────────────────────────────────────────────────────
--   Watchdog: platform_settings 'profiles_guard_watchdog' {"enabled": false} (a disabled run still
--   stamps checked_at, so the GitHub verifier stays green). The guard itself has no soft switch, on
--   purpose: `alter table public.profiles disable trigger trg_profiles_zz_column_guard;` turns it off
--   and the watchdog alarms 'guard_down' within the hour.
--
-- ── DEPLOY SELF-TEST ────────────────────────────────────────────────────────────────────────────
--   Structure, privileges, the closed policies, pure-function vectors, then an END-TO-END run on a
--   real student row as `authenticated` (SET LOCAL ROLE + request.jwt.claims, no real JWT needed),
--   inside a sub-block that raises a sentinel so every write rolls back on the SUCCESS path too. It
--   takes no advisory lock, sends nothing and awards nothing. The one non-transactional effect, the
--   rejection sequence, is put back with setval() afterwards. A PGlite harness covers the same and
--   more: supabase/functions/_challenge/testing/profiles_column_guard_test.ts.
--
-- Replay-safe: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS before CREATE,
-- ON CONFLICT DO NOTHING seeds, unschedule before schedule, one audit row guarded by NOT EXISTS.
-- PR-3 replaces profiles_column_guard() with v2 (the handle lock); it is our own function, no pin.

set local lock_timeout = '15s';  -- never queue behind a long transaction on profiles and stall prod

-- ─────────────── 1. The column ───────────────
alter table public.profiles add column if not exists telegram_write_access_at timestamptz;

-- ─────────────── 2. Rejection counter (non-transactional by design) ───────────────
create sequence if not exists public.profiles_guard_rejections_seq;
revoke all on sequence public.profiles_guard_rejections_seq from public, anon, authenticated;

-- ─────────────── 3. The guarded column set, normalised ───────────────
-- ONE definition, used by the guard (what changed) and by the drift detector (what it looked like).
-- Timestamps are rendered at UTC and citext/enums as text, so the jsonb is identical whatever the
-- session TimeZone of the writer or the watchdog.
create or replace function public.profiles_guard_values(_r public.profiles)
returns jsonb
language sql
stable
set search_path to 'public'
as $function$
  select jsonb_build_object(
    'telegram_id',              _r.telegram_id,
    'telegram_username',        _r.telegram_username::text,
    'email',                    _r.email,
    'group_id',                 _r.group_id,
    'status',                   _r.status::text,
    'archived_at',              _r.archived_at at time zone 'UTC',
    'account_type',             _r.account_type,
    'telegram_write_access_at', _r.telegram_write_access_at at time zone 'UTC',
    'created_at',               _r.created_at at time zone 'UTC')
$function$;

-- Pure (reads only its argument). The INVOKER guard calls it as whoever writes profiles.
revoke execute on function public.profiles_guard_values(public.profiles) from public, anon, authenticated;
grant  execute on function public.profiles_guard_values(public.profiles) to authenticated, service_role;

-- ─────────────── 4. Helpers the guard calls (inert outside a trigger) ───────────────
-- SECURITY DEFINER so an invoker-rights guard can bump the private sequence and write admin_actions.
-- Granted to authenticated because the guard runs AS the writer; pg_trigger_depth() = 0 means a
-- direct /rest/v1/rpc call, which returns without doing anything.
create or replace function public.profiles_guard_note_rejection()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if pg_trigger_depth() < 1 then
    return;
  end if;
  perform nextval('public.profiles_guard_rejections_seq');
end;
$function$;

revoke execute on function public.profiles_guard_note_rejection() from public, anon, authenticated;
grant  execute on function public.profiles_guard_note_rejection() to authenticated, service_role;

create or replace function public.profiles_guard_record_change(p_user uuid, p_op text, p_changes jsonb, p_caller text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if pg_trigger_depth() < 1 then
    return;
  end if;
  insert into public.admin_actions (actor_user_id, action, target_user_id, details)
  values (auth.uid(), 'profile_privileged_change', p_user,
          jsonb_build_object('op', p_op, 'changes', p_changes, 'caller', p_caller,
                             'jwt_role', auth.role(), 'at', now()));
end;
$function$;

revoke execute on function public.profiles_guard_record_change(uuid, text, jsonb, text) from public, anon, authenticated;
grant  execute on function public.profiles_guard_record_change(uuid, text, jsonb, text) to authenticated, service_role;

-- The drift detector looks these rows up by user, within the last hour.
create index if not exists idx_admin_actions_profile_privileged
  on public.admin_actions (target_user_id, created_at desc)
  where action = 'profile_privileged_change';

-- ─────────────── 5. The guard ───────────────
-- SECURITY INVOKER on purpose: current_user must be the WRITER. Inside a SECURITY DEFINER function
-- it is the function's owner, which is how definer paths (admin RPCs, handle_new_user, PR-3's
-- my_telegram_write_access_granted) pass. A SECURITY DEFINER guard would pass everyone; the
-- watchdog alarms on that.
create or replace function public.profiles_column_guard()
returns trigger
language plpgsql
security invoker
set search_path to 'public'
as $function$
declare
  _new jsonb := public.profiles_guard_values(new);
  _old jsonb;
  _cols text[];
  _uid uuid;
  _restricted boolean := current_user::text in ('authenticated', 'anon');
  _scope_changed boolean;
  _changes jsonb := '{}'::jsonb;
  _k text;
begin
  if tg_op = 'UPDATE' then
    _old := public.profiles_guard_values(old);
    select coalesce(array_agg(k order by k), '{}') into _cols
      from jsonb_object_keys(_new) k
     where (_new -> k) is distinct from (_old -> k);
    _scope_changed := new.active_teacher_group_id is distinct from old.active_teacher_group_id;
  else
    -- INSERT: a row may only be born with the column defaults. (email and created_at have no
    -- default to compare with; email is checked against the caller below.)
    _old := jsonb_build_object('telegram_id', null, 'telegram_username', null, 'group_id', null,
                               'status', 'active', 'archived_at', null, 'account_type', 'paid',
                               'telegram_write_access_at', null);
    select coalesce(array_agg(k order by k), '{}') into _cols
      from jsonb_object_keys(_old) k
     where (_new -> k) is distinct from (_old -> k);
    -- A signed-in user may only create a profile carrying their OWN sign-in email.
    if _restricted
       and (coalesce(auth.jwt() ->> 'email', '') = ''
            or lower(new.email) is distinct from lower(auth.jwt() ->> 'email')) then
      _cols := _cols || 'email'::text;
    end if;
    _scope_changed := new.active_teacher_group_id is not null;
  end if;

  -- SCOPED: a non-privileged caller may point active_teacher_group_id only at NULL or at a group
  -- they teach (the bot scopes a teacher's roster views by it). An unchanged value is never judged,
  -- so a value left stale by a reassignment does not block the teacher's other edits.
  if _restricted and _scope_changed and new.active_teacher_group_id is not null then
    _uid := auth.uid();
    if _uid is null then
      _cols := _cols || 'active_teacher_group_id'::text;
    elsif not public.is_group_teacher(new.active_teacher_group_id, _uid) then
      _cols := _cols || 'active_teacher_group_id'::text;  -- an admin still passes below
    end if;
  end if;

  if cardinality(_cols) = 0 then
    return new;
  end if;

  if _restricted then
    _uid := auth.uid();
    if _uid is null
       or not (public.has_role(_uid, 'admin'::app_role) or public.has_role(_uid, 'superadmin'::app_role)) then
      begin
        perform public.profiles_guard_note_rejection();
      exception when others then
        null;  -- the counter must never change the answer below
      end;
      raise exception using
        errcode = 'P0001',
        message = 'Bu maydonni faqat admin o‘zgartira oladi',
        detail  = 'profiles_column_guard: ' || array_to_string(_cols, ', ');
    end if;
  end if;

  -- Privileged: leave a DB-visible record (forensics, and the drift detector's "explained" set).
  -- The scoped column is a preference, not a privileged change: never recorded.
  foreach _k in array _cols loop
    continue when _k = 'active_teacher_group_id';
    _changes := _changes || jsonb_build_object(_k, jsonb_build_object('old', _old -> _k, 'new', _new -> _k));
  end loop;
  if _changes = '{}'::jsonb then
    return new;
  end if;
  begin
    perform public.profiles_guard_record_change(new.id, lower(tg_op), _changes, current_user::text);
  exception when others then
    null;  -- never block a legitimate write; a missing record surfaces as drift within the hour
  end;
  return new;
end;
$function$;

-- A trigger function needs no EXECUTE grant to fire.
revoke execute on function public.profiles_column_guard() from public, anon, authenticated;

drop trigger if exists trg_profiles_zz_column_guard on public.profiles;
create trigger trg_profiles_zz_column_guard
  before insert or update on public.profiles
  for each row execute function public.profiles_column_guard();

-- ─────────────── 6. Instagram handle audit ───────────────
create or replace function public.profiles_instagram_audit()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  begin
    insert into public.admin_actions (actor_user_id, action, target_user_id, details)
    values (auth.uid(), 'instagram_handle_changed', new.id,
            jsonb_build_object('old', old.instagram_username::text, 'new', new.instagram_username::text,
                               'actor', auth.uid(), 'jwt_role', auth.role(),
                               'request_role', current_setting('role', true)));
  exception when others then
    null;  -- the audit must never block the student's own save
  end;
  return null;
end;
$function$;

revoke execute on function public.profiles_instagram_audit() from public, anon, authenticated;

drop trigger if exists trg_profiles_zz_instagram_audit on public.profiles;
create trigger trg_profiles_zz_instagram_audit
  after update of instagram_username on public.profiles
  for each row when (old.instagram_username is distinct from new.instagram_username)
  execute function public.profiles_instagram_audit();

-- ─────────────── 7. Fan-out: close the unused student write policies ───────────────
drop policy if exists "streaks own write" on public.streaks;
drop policy if exists "streaks own update" on public.streaks;
drop policy if exists "dws own insert" on public.daily_watch_summary;
drop policy if exists "dws own update" on public.daily_watch_summary;
drop policy if exists "hws own insert" on public.homework_submissions;
-- Grading stays with staff: admin, or a teacher of the student's group (is_teacher_of is SECURITY
-- DEFINER, junction-aware via is_group_teacher). WITH CHECK = USING, so the new row must still be
-- one the grader may grade.
drop policy if exists "hws own update" on public.homework_submissions;
create policy "hws own update" on public.homework_submissions
  for update to authenticated
  using (public.has_role(auth.uid(), 'admin'::app_role)
         or (public.has_role(auth.uid(), 'teacher'::app_role) and public.is_teacher_of(user_id, auth.uid())))
  with check (public.has_role(auth.uid(), 'admin'::app_role)
              or (public.has_role(auth.uid(), 'teacher'::app_role) and public.is_teacher_of(user_id, auth.uid())));
drop policy if exists "quiz_a own all" on public.quiz_attempts;
drop policy if exists "quiz_a own read" on public.quiz_attempts;
create policy "quiz_a own read" on public.quiz_attempts
  for select
  using ((auth.uid() = user_id) or public.has_role(auth.uid(), 'admin'::app_role));

-- ─────────────── 8. Drift snapshot ───────────────
create table if not exists public.profiles_guard_snapshot (
  user_id  uuid primary key references public.profiles(id) on delete cascade,
  vals     jsonb not null,
  taken_at timestamptz not null default now()
);
alter table public.profiles_guard_snapshot enable row level security;  -- no policies: definer-only
revoke all on table public.profiles_guard_snapshot from public, anon, authenticated;

-- Changed guarded columns since the last snapshot, and whether a privileged-change record explains
-- each one (same user, recorded since the snapshot minus 15 min of commit slack, new value equal to
-- the current value). STABLE: inside the watchdog's single statement it sees that statement's
-- snapshot, the same one the refresh writes from.
create or replace function public.profiles_guard_drift()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  with cur as (
    select p.id, public.profiles_guard_values(p) as v from public.profiles p
  ),
  diff as (
    select c.id, k.key,
           exists (select 1 from public.admin_actions a
                   where a.action = 'profile_privileged_change'
                     and a.target_user_id = c.id
                     and a.created_at >= s.taken_at - interval '15 minutes'
                     and (a.details -> 'changes' -> k.key -> 'new') = (c.v -> k.key)) as explained
    from cur c
    join public.profiles_guard_snapshot s on s.user_id = c.id
    cross join lateral jsonb_object_keys(c.v) k(key)
    where (c.v -> k.key) is distinct from coalesce(s.vals -> k.key, 'null'::jsonb)
  ),
  per_user as (
    select id,
           array_agg(key order by key) filter (where not explained) as cols,
           bool_and(explained) as all_explained
    from diff group by id
  )
  select jsonb_build_object(
    'changed_users',     (select count(*) from per_user),
    'unexplained_users', (select count(*) from per_user where not all_explained),
    'unexplained',       coalesce((select jsonb_agg(jsonb_build_object('user_id', x.id, 'cols', to_jsonb(x.cols))
                                                    order by x.id)
                                   from (select id, cols from per_user where not all_explained
                                         order by id limit 20) x), '[]'::jsonb),
    'snapshot_rows',     (select count(*) from public.profiles_guard_snapshot))
$function$;

revoke execute on function public.profiles_guard_drift() from public, anon, authenticated;
grant  execute on function public.profiles_guard_drift() to service_role;

-- ─────────────── 9. Health (read-only) ───────────────
create or replace function public.profiles_guard_health()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  _problems text[] := '{}';
  _keys text[] := '{}';
  _trg record;
  _last_before text;
  _ig_ok boolean;
  _rls jsonb;
  _total bigint;
  _state jsonb;
  _seen bigint;
  _new_rej bigint := 0;
  _drift jsonb;
  _unexplained bigint;
begin
  select t.tgenabled, t.tgtype, p.prosecdef, p.proname into _trg
    from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = 'public.profiles'::regclass and t.tgname = 'trg_profiles_zz_column_guard'
     and not t.tgisinternal;
  if not found then
    _problems := _problems || 'guard_trigger_missing'::text;
  else
    if _trg.tgenabled not in ('O', 'A') then _problems := _problems || 'guard_trigger_disabled'::text; end if;
    if _trg.proname <> 'profiles_column_guard' then _problems := _problems || 'guard_trigger_wrong_function'::text; end if;
    if _trg.prosecdef then _problems := _problems || 'guard_is_security_definer'::text; end if;
    -- tgtype bits: ROW 1, BEFORE 2, INSERT 4, UPDATE 16
    if (_trg.tgtype & 1) = 0 or (_trg.tgtype & 2) = 0 or (_trg.tgtype & 4) = 0 or (_trg.tgtype & 16) = 0 then
      _problems := _problems || 'guard_trigger_wrong_events'::text;
    end if;
  end if;
  -- BEFORE ROW triggers fire in name order; the guard must judge the final row.
  select t.tgname into _last_before
    from pg_trigger t
   where t.tgrelid = 'public.profiles'::regclass and not t.tgisinternal and t.tgenabled <> 'D'
     and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2
   order by t.tgname desc limit 1;
  if _last_before is distinct from 'trg_profiles_zz_column_guard' then
    _problems := _problems || ('guard_not_last:' || coalesce(_last_before, 'none'));
  end if;

  _ig_ok := exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                    where t.tgrelid = 'public.profiles'::regclass
                      and t.tgname = 'trg_profiles_zz_instagram_audit'
                      and t.tgenabled in ('O', 'A') and p.proname = 'profiles_instagram_audit');

  -- Write policies on the tables closed by 20260930120020 (any reappearance is a regression until
  -- someone updates this list on purpose). homework_submissions keeps its staff UPDATE policy, so
  -- there an UPDATE policy is drift only when it lets the row's owner in (a student arm
  -- auth.uid() = user_id, in either order) or has no real predicate at all. The expressions are
  -- deparsed under this function's fixed search_path, so the text is stable.
  select coalesce(jsonb_agg(jsonb_build_object('table', c.relname, 'policy', p.polname, 'cmd', p.polcmd::text)
                            order by c.relname, p.polname), '[]'::jsonb)
    into _rls
    from pg_policy p join pg_class c on c.oid = p.polrelid
   where c.relnamespace = 'public'::regnamespace
     and ((c.relname in ('streaks', 'daily_watch_summary', 'quiz_attempts') and p.polcmd in ('a', 'w', '*'))
          or (c.relname = 'homework_submissions' and p.polcmd in ('a', '*'))
          or (c.relname = 'homework_submissions' and p.polcmd = 'w'
              and (p.polqual is null
                   or btrim(pg_get_expr(p.polqual, p.polrelid), '() ') = 'true'
                   or (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' '
                       || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''))
                      ~ '(auth\.uid\(\)\s*=\s*(homework_submissions\.)?user_id|(homework_submissions\.)?user_id\s*=\s*auth\.uid\(\))')));

  select case when is_called then last_value else 0 end into _total from public.profiles_guard_rejections_seq;
  select value into _state from public.app_settings where key = 'profiles_guard_watchdog_state';
  _seen := case when coalesce(_state->>'rejections_seen', '') ~ '^[0-9]{1,18}$'
                then (_state->>'rejections_seen')::bigint end;
  _new_rej := case when _seen is null then 0 else greatest(_total - _seen, 0) end;

  _drift := public.profiles_guard_drift();
  _unexplained := case when coalesce(_drift->>'unexplained_users', '') ~ '^[0-9]{1,18}$'
                       then (_drift->>'unexplained_users')::bigint else 0 end;

  if cardinality(_problems) > 0 then _keys := _keys || 'guard_down'::text; end if;
  if not _ig_ok then _keys := _keys || 'instagram_audit_down'::text; end if;
  if jsonb_array_length(_rls) > 0 then _keys := _keys || 'rls_drift'::text; end if;

  return jsonb_build_object(
    'guard_ok', cardinality(_problems) = 0,
    'problems', to_jsonb(_problems),
    'instagram_audit_ok', _ig_ok,
    'rls_write_policies', _rls,
    'rejections_total', _total,
    'rejections_new', _new_rej,
    'drift', _drift,
    'privileged_changes_24h',
      (select count(*) from public.admin_actions
        where action = 'profile_privileged_change' and created_at > now() - interval '24 hours'),
    'privileged_changes_by_caller_24h',
      (select coalesce(jsonb_object_agg(caller, n), '{}'::jsonb)
         from (select coalesce(details->>'caller', '?') as caller, count(*) as n
                 from public.admin_actions
                where action = 'profile_privileged_change' and created_at > now() - interval '24 hours'
                group by 1) x),
    'instagram_handle_changes_7d',
      (select count(*) from public.admin_actions
        where action = 'instagram_handle_changed' and created_at > now() - interval '7 days'),
    'keys', to_jsonb(_keys),
    'events', _new_rej + _unexplained,
    'alarm', cardinality(_keys) > 0 or _new_rej + _unexplained > 0,
    'checked_at', now());
end;
$function$;

revoke execute on function public.profiles_guard_health() from public, anon, authenticated;
grant  execute on function public.profiles_guard_health() to service_role;

-- ─────────────── 10. Alert decision + text (pure, unit-tested below) ───────────────
-- Persistent keys (guard_down, instagram_audit_down, rls_drift, unreadable): alert when a key is new
-- to this episode, then a reminder every ~24 h (23.5 h: last_alert_ms is a run's now(), which moves by
-- milliseconds from day to day), and one "recovered" when all clear -- but only for an episode an
-- admin was actually told about. Events (new rejections, unexplained drift): alert, at most every
-- ~6 h (5.5 h); every event run still writes an ALARM row, so nothing is lost in between.
create or replace function public.profiles_guard_alert_decision(p_keys jsonb, p_events bigint, p_state jsonb, p_now_ms bigint)
returns text
language sql
immutable
set search_path to 'public'
as $function$
  with s as (
    select case when jsonb_typeof(p_keys) = 'array' then p_keys else '["unreadable"]'::jsonb end as keys,
           case when jsonb_typeof(p_state->'notified_keys') = 'array' then p_state->'notified_keys' end as notified,
           p_now_ms - least(case when coalesce(p_state->>'last_alert_ms', '') ~ '^[0-9]{1,15}$'
                                 then (p_state->>'last_alert_ms')::bigint else 0 end, p_now_ms) as since_ms
  )
  select case
    when jsonb_array_length(s.keys) > 0 and s.notified is null then 'alert'
    when jsonb_array_length(s.keys) > 0
         and exists (select 1 from jsonb_array_elements_text(s.keys) k(key) where not (s.notified ? k.key))
      then 'alert'
    when jsonb_array_length(s.keys) > 0 and s.since_ms >= 84600000 then 'alert'
    when coalesce(p_events, 0) > 0 and s.since_ms >= 19800000 then 'alert'
    when jsonb_array_length(s.keys) = 0 and s.notified is not null and jsonb_array_length(s.notified) > 0
      then 'recovered'
    else 'none'
  end
  from s
$function$;

revoke execute on function public.profiles_guard_alert_decision(jsonb, bigint, jsonb, bigint) from public, anon, authenticated;
grant  execute on function public.profiles_guard_alert_decision(jsonb, bigint, jsonb, bigint) to service_role;

create or replace function public.profiles_guard_alert_text(p_report jsonb, p_kind text)
returns text
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  _msg text := '';
  _keys jsonb;
  _n bigint;
  _u jsonb;
  _shown int := 0;
begin
  if p_kind = 'recovered' then
    return '✅ Profil himoyasi tiklandi: himoya trigger joyida va ishlayapti, Instagram audit yoqilgan, '
        || 'yopilgan jadvallarda talaba yozish qoidasi yoʻq.';
  end if;
  if p_report is null or jsonb_typeof(p_report->'keys') is distinct from 'array' then
    return '⚠️ Profil himoyasi watchdog holatni oʻqiy olmadi, shuning uchun himoya hozir tekshirilmayapti: '
        || left(coalesce(p_report::text, 'NULL'), 500);
  end if;
  _keys := p_report->'keys';

  if _keys ? 'guard_down' then
    _msg := _msg || '🚨 Profil himoyasi (trg_profiles_zz_column_guard) ishlamayapti: '
         || coalesce((select string_agg(value, ', ') from jsonb_array_elements_text(p_report->'problems')), '?')
         || E'.\nTalabalar oʻz guruhi, toʻlov turi (paid), Telegram ID si va holatini oʻzgartira oladi. '
         || 'Darhol tekshiring.';
  end if;
  if _keys ? 'instagram_audit_down' then
    _msg := _msg || case when _msg = '' then '' else E'\n\n' end
         || '⚠️ Instagram profil nomi oʻzgarishlari endi yozib borilmayapti (trg_profiles_zz_instagram_audit).';
  end if;
  if _keys ? 'rls_drift' then
    _msg := _msg || case when _msg = '' then '' else E'\n\n' end
         || '🚨 Talaba yozishi yopilgan jadvalda yana yozish qoidasi paydo boʻldi (XP/baho qoʻlda yozilishi mumkin): '
         || left(coalesce(p_report->>'rls_write_policies', '?'), 600);
  end if;
  if _keys ? 'unreadable' then
    _msg := _msg || case when _msg = '' then '' else E'\n\n' end
         || '⚠️ Himoya holatini oʻqib boʻlmadi: ' || left(coalesce(p_report->>'error', p_report::text), 400);
  end if;
  if _keys ? 'drift_unreadable' then
    _msg := _msg || case when _msg = '' then '' else E'\n\n' end
         || '⚠️ Audit yozuvisiz oʻzgarishlarni tekshirib boʻlmadi: ' || left(coalesce(p_report->>'error', '?'), 400);
  end if;

  _n := case when coalesce(p_report->>'rejections_new', '') ~ '^[0-9]{1,18}$'
             then (p_report->>'rejections_new')::bigint else 0 end;
  if _n > 0 then
    _msg := _msg || case when _msg = '' then '' else E'\n\n' end
         || '⛔ ' || _n || ' ta taqiqlangan profil oʻzgartirish urinishi rad etildi (admin boʻlmagan foydalanuvchi '
         || 'guruh, toʻlov turi, Telegram ID, email, holat yoki oʻzi dars bermaydigan faol guruh kabi '
         || 'maydonni oʻzgartirmoqchi boʻldi). '
         || 'Tafsilot: API loglarida PATCH/POST /rest/v1/profiles → 400. Agar bu ilovadagi oddiy amal '
         || 'boʻlsa, qaysidir sahifa himoyalangan maydonga yozyapti — bu xato, tuzatish kerak.';
  end if;

  _n := case when coalesce(p_report#>>'{drift,unexplained_users}', '') ~ '^[0-9]{1,18}$'
             then (p_report#>>'{drift,unexplained_users}')::bigint else 0 end;
  if _n > 0 then
    _msg := _msg || case when _msg = '' then '' else E'\n\n' end
         || '🚨 ' || _n || ' ta profilda himoyalangan maydon audit yozuvisiz oʻzgargan (himoya chetlab oʻtilgan):';
    for _u in select value from jsonb_array_elements(coalesce(p_report#>'{drift,unexplained}', '[]'::jsonb)) loop
      exit when _shown >= 10;
      _msg := _msg || E'\n• ' || coalesce(_u->>'user_id', '?') || ': '
           || coalesce((select string_agg(value, ', ') from jsonb_array_elements_text(_u->'cols')), '?');
      _shown := _shown + 1;
    end loop;
  end if;

  if _msg = '' then
    return '⚠️ Profil himoyasi watchdog signal berdi, lekin tafsilotni oʻqiy olmadi: ' || left(p_report::text, 500);
  end if;
  return '🛡 Profil himoyasi' || E'\n\n' || _msg;
end;
$function$;

revoke execute on function public.profiles_guard_alert_text(jsonb, text) from public, anon, authenticated;
grant  execute on function public.profiles_guard_alert_text(jsonb, text) to service_role;

-- ─────────────── 11. The watchdog (the only writer/sender) ───────────────
create or replace function public.profiles_guard_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _state jsonb;
  _cfg jsonb;
  _r jsonb;
  _err text;
  _drift jsonb;
  _snap bigint;
  _report jsonb;
  _keys jsonb;
  _events bigint;
  _total bigint;
  _seen bigint;
  _action text;
  _now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  _last_ms bigint;
  _notified jsonb;
  _tok text;
  _admin record;
  _msg text;
  _dm int := 0;
  _undelivered jsonb;
begin
  select value into _state from public.app_settings where key = 'profiles_guard_watchdog_state';

  -- KILL-SWITCH: platform_settings 'profiles_guard_watchdog' {"enabled": false}. A disabled run reads
  -- nothing else and sends nothing, but stamps checked_at so the GitHub verifier stays green.
  select value into _cfg from public.platform_settings where key = 'profiles_guard_watchdog';
  if coalesce(_cfg->>'enabled', '') = 'false' then
    if coalesce(_state->>'last_action', '') <> 'disabled' then
      begin
        insert into public.admin_actions (actor_user_id, action, details)
        values (null, 'profiles_guard_watchdog_disabled', jsonb_build_object('config', _cfg));
      exception when others then null; end;
    end if;
    insert into public.app_settings (key, value)
    values ('profiles_guard_watchdog_state',
            (case when jsonb_typeof(_state) = 'object' then _state else '{}'::jsonb end)
            || jsonb_build_object('enabled', false, 'last_action', 'disabled',
                                  'dm_attempted_last_run', 0, 'checked_at', now()))
    on conflict (key) do update set value = excluded.value;
    return jsonb_build_object('disabled', true, 'checked_at', now());
  end if;

  begin
    _r := public.profiles_guard_health();
  exception when others then
    _err := sqlerrm;
    _r := null;
  end;

  -- Drift, atomically with the snapshot refresh: one statement, one MVCC snapshot, so every change
  -- is compared exactly once (never absorbed into the new snapshot unseen).
  begin
    with d as (select public.profiles_guard_drift() as r),
    up as (
      insert into public.profiles_guard_snapshot (user_id, vals, taken_at)
      select p.id, public.profiles_guard_values(p), now() from public.profiles p
      on conflict (user_id) do update set vals = excluded.vals, taken_at = excluded.taken_at
      returning 1
    )
    select d.r, (select count(*) from up) into _drift, _snap from d;
  exception when others then
    _err := coalesce(_err || '; ', '') || 'drift: ' || sqlerrm;
    _drift := null;
  end;

  _keys := case when _r is not null and jsonb_typeof(_r->'keys') = 'array' then _r->'keys'
                else '["unreadable"]'::jsonb end;
  if _drift is null then
    _keys := _keys || '["drift_unreadable"]'::jsonb;
  end if;
  _events := (case when coalesce(_r->>'rejections_new', '') ~ '^[0-9]{1,18}$'
                   then (_r->>'rejections_new')::bigint else 0 end)
           + (case when coalesce(_drift->>'unexplained_users', '') ~ '^[0-9]{1,18}$'
                   then (_drift->>'unexplained_users')::bigint else 0 end);
  _report := coalesce(_r, jsonb_build_object('alarm', true)) - 'drift'
          || jsonb_build_object('drift', coalesce(_drift, 'null'::jsonb), 'keys', _keys, 'events', _events,
                                'alarm', jsonb_array_length(_keys) > 0 or _events > 0,
                                'error', _err, 'snapshot_refreshed', _snap);

  _action := public.profiles_guard_alert_decision(_keys, _events, _state, _now_ms);

  if _action in ('alert', 'recovered') then
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if coalesce(_tok, '') <> '' then
      _msg := public.profiles_guard_alert_text(_report, _action);
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
            p_purpose    := 'profiles_guard_watchdog',
            p_timeout_ms := 5000);
          _dm := _dm + 1;
        exception when others then null; end;
      end loop;
    end if;
  end if;

  -- DB-visible alarm rows: every run with new events (they are new facts each time), every recovery,
  -- and every persistent-key alert -- except a repeat of an alert that again reached no admin for the
  -- same key set (no bot token / no admin telegram_id would otherwise write one row an hour).
  _undelivered := case when _action = 'alert' and _dm = 0 then _keys end;
  if _events > 0 or _action = 'recovered'
     or (_action = 'alert' and (_dm > 0 or (_state->'undelivered') is distinct from _keys)) then
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null,
              case when _action = 'recovered' and _events = 0 then 'profiles_guard_watchdog_recovered'
                   else 'profiles_guard_watchdog_ALARM' end,
              _report || jsonb_build_object('decision', _action, 'dm_attempted', _dm));
    exception when others then null; end;
  end if;

  -- State.
  _last_ms := least(case when coalesce(_state->>'last_alert_ms', '') ~ '^[0-9]{1,15}$'
                         then (_state->>'last_alert_ms')::bigint else 0 end, _now_ms);
  _notified := case when jsonb_typeof(_state->'notified_keys') = 'array' then _state->'notified_keys' end;
  if jsonb_array_length(_keys) = 0 then
    _notified := null;                        -- episode over (recovered, or never told): start afresh
  elsif _action = 'alert' and _dm > 0 then
    _notified := _keys;
  elsif _action = 'none' and _notified is not null then
    _notified := _keys;                       -- same or fewer keys: silent
  end if;
  if _action = 'alert' and _dm > 0 then
    _last_ms := _now_ms;
  end if;
  _total := case when coalesce(_r->>'rejections_total', '') ~ '^[0-9]{1,18}$'
                 then (_r->>'rejections_total')::bigint end;
  _seen := case when coalesce(_state->>'rejections_seen', '') ~ '^[0-9]{1,18}$'
                then (_state->>'rejections_seen')::bigint end;

  insert into public.app_settings (key, value)
  values ('profiles_guard_watchdog_state', jsonb_build_object(
    'enabled', true,
    'notified_keys', _notified,
    'last_alert_ms', _last_ms,
    'rejections_seen', coalesce(_total, _seen, 0),   -- an unreadable run consumes nothing
    'undelivered', _undelivered,
    'last_action', _action,
    'dm_attempted_last_run', _dm,
    'last_report', _report,
    'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return _report;
end;
$function$;

revoke execute on function public.profiles_guard_watchdog() from public, anon, authenticated;
grant  execute on function public.profiles_guard_watchdog() to service_role;

-- ─────────────── 12. Seeds (never overwrite) ───────────────
insert into public.platform_settings (key, value)
values ('profiles_guard_watchdog', '{"enabled": true}'::jsonb)
on conflict (key) do nothing;

insert into public.profiles_guard_snapshot (user_id, vals, taken_at)
select p.id, public.profiles_guard_values(p), now() from public.profiles p
on conflict (user_id) do nothing;

-- ─────────────── 13. Deploy self-test ───────────────
do $selftest$
declare
  _r jsonb;
  _d text;
  _now bigint := 1790000000000;
  _st jsonb;
  _case record;
  _student uuid;
  _student_email text;
  _student_group uuid;
  _other_group uuid;
  _admin uuid;
  _fresh uuid := gen_random_uuid();
  _seq_last bigint;
  _seq_called boolean;
  _before bigint;
  _after bigint;
  _res jsonb := '{}'::jsonb;
  _n int;
  _sqlstate text;
  _msg text;
  _k text;
  _e2e text := 'ran';
  _hws uuid;
  _hws_owner uuid;
begin
  -- A. Structure and privileges.
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'profiles'
                   and column_name = 'telegram_write_access_at' and data_type = 'timestamp with time zone') then
    raise exception 'ABORT: profiles.telegram_write_access_at is missing';
  end if;
  _r := public.profiles_guard_health();
  if _r is null or jsonb_typeof(_r->'keys') is distinct from 'array' or jsonb_typeof(_r->'alarm') is distinct from 'boolean' then
    raise exception 'ABORT: profiles_guard_health() report is malformed: %', coalesce(_r::text, 'NULL');
  end if;
  if coalesce(_r->>'guard_ok', '') <> 'true' then
    raise exception 'ABORT: the guard is not healthy: %', _r->'problems';
  end if;
  if coalesce(_r->>'instagram_audit_ok', '') <> 'true' then
    raise exception 'ABORT: the instagram audit trigger is not installed';
  end if;
  if jsonb_array_length(_r->'rls_write_policies') <> 0 then
    raise exception 'ABORT: student write policies still open: %', _r->'rls_write_policies';
  end if;
  if not exists (select 1 from pg_policy where polrelid = 'public.quiz_attempts'::regclass
                   and polname = 'quiz_a own read' and polcmd = 'r') then
    raise exception 'ABORT: quiz_attempts lost its read policy';
  end if;
  -- Staff grading must survive the student arm's removal: exactly one UPDATE policy, for
  -- authenticated, with the teacher arm in both USING and WITH CHECK (the no-student-arm half is
  -- the rls_write_policies assertion above).
  if (select count(*) from pg_policy p
       where p.polrelid = 'public.homework_submissions'::regclass and p.polcmd in ('w', '*')) <> 1
     or not exists (select 1 from pg_policy p
                     where p.polrelid = 'public.homework_submissions'::regclass
                       and p.polname = 'hws own update' and p.polcmd = 'w'
                       and p.polroles = array['authenticated'::regrole::oid]
                       and pg_get_expr(p.polqual, p.polrelid) like '%is_teacher_of(user_id, auth.uid())%'
                       and pg_get_expr(p.polwithcheck, p.polrelid) like '%is_teacher_of(user_id, auth.uid())%'
                       and pg_get_expr(p.polqual, p.polrelid) like '%''admin''::%app_role%') then
    raise exception 'ABORT: homework_submissions UPDATE policy is not the staff-only "hws own update"';
  end if;
  if not has_function_privilege('authenticated', 'public.is_group_teacher(uuid, uuid)', 'EXECUTE') then
    raise exception 'ABORT: the guard runs as the writer and needs is_group_teacher(uuid, uuid)';
  end if;
  if coalesce((_r#>>'{drift,unexplained_users}')::int, -1) <> 0 then
    raise exception 'ABORT: drift right after seeding the snapshot: %', _r->'drift';
  end if;
  if (select prosecdef from pg_proc where oid = 'public.profiles_column_guard()'::regprocedure) then
    raise exception 'ABORT: profiles_column_guard() must be SECURITY INVOKER';
  end if;
  if not has_function_privilege('authenticated', 'public.profiles_guard_values(public.profiles)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.profiles_guard_note_rejection()', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.profiles_guard_record_change(uuid, text, jsonb, text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.profiles_guard_record_change(uuid, text, jsonb, text)', 'EXECUTE') then
    raise exception 'ABORT: the guard''s writers cannot call its helpers';
  end if;
  foreach _k in array array['public.profiles_guard_note_rejection()',
                            'public.profiles_guard_record_change(uuid, text, jsonb, text)',
                            'public.profiles_guard_drift()', 'public.profiles_guard_health()',
                            'public.profiles_guard_watchdog()'] loop
    if has_function_privilege('anon', _k, 'EXECUTE') then
      raise exception 'ABORT: anon can execute %', _k;
    end if;
  end loop;
  foreach _k in array array['public.profiles_guard_drift()', 'public.profiles_guard_health()',
                            'public.profiles_guard_watchdog()'] loop
    if has_function_privilege('authenticated', _k, 'EXECUTE') then
      raise exception 'ABORT: authenticated can execute %', _k;
    end if;
  end loop;
  if has_sequence_privilege('authenticated', 'public.profiles_guard_rejections_seq', 'USAGE')
     or has_sequence_privilege('anon', 'public.profiles_guard_rejections_seq', 'USAGE')
     or has_table_privilege('authenticated', 'public.profiles_guard_snapshot', 'SELECT')
     or has_table_privilege('anon', 'public.profiles_guard_snapshot', 'SELECT') then
    raise exception 'ABORT: the rejection counter or the snapshot is reachable by clients';
  end if;

  -- B. Pure: the alert decision.
  _st := jsonb_build_object('notified_keys', '["guard_down"]'::jsonb, 'last_alert_ms', _now - 3600000);
  for _case in
    select * from (values
      ('healthy, no state',               '[]'::jsonb, 0::bigint, null::jsonb, 'none'),
      ('healthy after a told episode',    '[]'::jsonb, 0::bigint, _st, 'recovered'),
      ('healthy, never told',             '[]'::jsonb, 0::bigint, '{"notified_keys": null}'::jsonb, 'none'),
      ('first key',                       '["guard_down"]'::jsonb, 0::bigint, null::jsonb, 'alert'),
      ('same key an hour later',          '["guard_down"]'::jsonb, 0::bigint, _st, 'none'),
      ('new key',                         '["guard_down","rls_drift"]'::jsonb, 0::bigint, _st, 'alert'),
      ('same key a day later',            '["guard_down"]'::jsonb, 0::bigint,
                                          jsonb_build_object('notified_keys', '["guard_down"]'::jsonb,
                                                             'last_alert_ms', _now - 84600000), 'alert'),
      ('unreadable keys',                 null::jsonb, 0::bigint, _st, 'alert'),
      ('events, no state',                '[]'::jsonb, 3::bigint, null::jsonb, 'alert'),
      ('events 1 h after an alert',       '[]'::jsonb, 3::bigint,
                                          jsonb_build_object('last_alert_ms', _now - 3600000), 'none'),
      ('events as a told episode ends',   '[]'::jsonb, 3::bigint, _st, 'recovered'),
      ('events 6 h after an alert',       '[]'::jsonb, 3::bigint,
                                          jsonb_build_object('last_alert_ms', _now - 21600000), 'alert'),
      ('future last_alert_ms heals',      '[]'::jsonb, 1::bigint,
                                          jsonb_build_object('last_alert_ms', _now + 99999999), 'none'),
      ('garbage state',                   '["guard_down"]'::jsonb, 0::bigint, '"x"'::jsonb, 'alert')
    ) v(label, keys, events, state, expected)
  loop
    _d := public.profiles_guard_alert_decision(_case.keys, _case.events, _case.state, _now);
    if _d is distinct from _case.expected then
      raise exception 'ABORT: alert_decision(%) = %, expected %', _case.label, _d, _case.expected;
    end if;
  end loop;
  if coalesce(public.profiles_guard_alert_text(_r || '{"keys": ["guard_down"], "problems": ["x"]}'::jsonb, 'alert'), '') not like '%trg_profiles_zz_column_guard%'
     or coalesce(public.profiles_guard_alert_text(null, 'alert'), '') = ''
     or coalesce(public.profiles_guard_alert_text(_r, 'recovered'), '') = '' then
    raise exception 'ABORT: profiles_guard_alert_text() is broken';
  end if;

  -- C. End to end on a real row, rolled back by a sentinel.
  select p.id, p.email, p.group_id into _student, _student_email, _student_group
    from public.profiles p
   where p.group_id is not null and p.status = 'active' and p.archived_at is null
     and not exists (select 1 from public.user_roles r
                     where r.user_id = p.id and r.role in ('admin', 'teacher', 'superadmin'))
   order by p.created_at, p.id limit 1;
  select g.id into _other_group from public.groups g
   where g.id is distinct from _student_group and not public.is_group_teacher(g.id, _student)
   order by g.id limit 1;
  select r.user_id into _admin from public.user_roles r join public.profiles p on p.id = r.user_id
   where r.role = 'admin' order by r.user_id limit 1;
  -- Any non-staff student's UNGRADED submission: the one row the removed student arm would match.
  select hs.id, hs.user_id into _hws, _hws_owner
    from public.homework_submissions hs
   where hs.score is null
     and not exists (select 1 from public.user_roles r
                     where r.user_id = hs.user_id and r.role in ('admin', 'teacher', 'superadmin'))
   order by hs.submitted_at desc nulls last, hs.id limit 1;

  if _student is null or _other_group is null or _admin is null then
    _e2e := 'skipped: no student with a group, second group and admin to test with';
  else
    select last_value, is_called into _seq_last, _seq_called from public.profiles_guard_rejections_seq;
    _before := case when _seq_called then _seq_last else 0 end;
    begin
      -- 1. As the student (authenticated, no admin role).
      perform set_config('request.jwt.claims',
                         jsonb_build_object('sub', _student, 'role', 'authenticated', 'email', _student_email)::text, true);
      perform set_config('request.jwt.claim.sub', _student::text, true);
      perform set_config('request.jwt.claim.role', 'authenticated', true);
      set local role authenticated;

      update public.profiles set preferred_language = case when preferred_language = 'ru' then 'uz' else 'ru' end
       where id = _student;
      get diagnostics _n = row_count;
      _res := _res || jsonb_build_object('student_preferred_language_rows', _n);

      begin
        update public.profiles set group_id = _other_group where id = _student;
        _res := _res || jsonb_build_object('student_group_id', 'NOT BLOCKED');
      exception when others then
        get stacked diagnostics _sqlstate = returned_sqlstate, _msg = message_text;
        _res := _res || jsonb_build_object('student_group_id', _sqlstate || ' ' || _msg);
      end;
      begin
        update public.profiles set account_type = case when account_type = 'paid' then 'provisional' else 'paid' end
         where id = _student;
        _res := _res || jsonb_build_object('student_account_type', 'NOT BLOCKED');
      exception when others then
        get stacked diagnostics _sqlstate = returned_sqlstate, _msg = message_text;
        _res := _res || jsonb_build_object('student_account_type', _sqlstate || ' ' || _msg);
      end;
      begin
        update public.profiles set telegram_id = 999000000001 where id = _student;
        _res := _res || jsonb_build_object('student_telegram_id', 'NOT BLOCKED');
      exception when others then
        get stacked diagnostics _sqlstate = returned_sqlstate, _msg = message_text;
        _res := _res || jsonb_build_object('student_telegram_id', _sqlstate || ' ' || _msg);
      end;
      begin
        update public.profiles set telegram_username = 'guard_selftest_squat' where id = _student;
        _res := _res || jsonb_build_object('student_telegram_username', 'NOT BLOCKED');
      exception when others then
        get stacked diagnostics _sqlstate = returned_sqlstate, _msg = message_text;
        _res := _res || jsonb_build_object('student_telegram_username', _sqlstate || ' ' || _msg);
      end;
      begin
        -- SCOPED: pointing the bot's teacher scope at a group this user does not teach.
        update public.profiles set active_teacher_group_id = _other_group where id = _student;
        _res := _res || jsonb_build_object('student_active_teacher_group_id', 'NOT BLOCKED');
      exception when others then
        get stacked diagnostics _sqlstate = returned_sqlstate, _msg = message_text;
        _res := _res || jsonb_build_object('student_active_teacher_group_id', _sqlstate || ' ' || _msg);
      end;

      -- 1b. The owner of an ungraded submission can no longer write it (RLS filters it: 0 rows, so
      --     no homework trigger fires). The structural check in A has already proven the policy.
      if _hws is null then
        _res := _res || jsonb_build_object('student_hws_update_rows', 'skipped: no ungraded student submission');
      else
        perform set_config('request.jwt.claims',
                           jsonb_build_object('sub', _hws_owner, 'role', 'authenticated')::text, true);
        perform set_config('request.jwt.claim.sub', _hws_owner::text, true);
        update public.homework_submissions set previous_attempts = previous_attempts where id = _hws;
        get diagnostics _n = row_count;
        _res := _res || jsonb_build_object('student_hws_update_rows', _n);
      end if;

      -- 2. A brand-new signed-in user inserting a profile that is already in a group.
      perform set_config('request.jwt.claims',
                         jsonb_build_object('sub', _fresh, 'role', 'authenticated', 'email', 'guard-selftest@invalid')::text, true);
      perform set_config('request.jwt.claim.sub', _fresh::text, true);
      begin
        insert into public.profiles (id, email, group_id) values (_fresh, 'guard-selftest@invalid', _other_group);
        _res := _res || jsonb_build_object('student_insert_with_group', 'NOT BLOCKED');
      exception when others then
        get stacked diagnostics _sqlstate = returned_sqlstate, _msg = message_text;
        _res := _res || jsonb_build_object('student_insert_with_group', _sqlstate || ' ' || _msg);
      end;
      reset role;

      -- 3. As an admin (authenticated + admin role): allowed, and recorded.
      perform set_config('request.jwt.claims', jsonb_build_object('sub', _admin, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', _admin::text, true);
      set local role authenticated;
      update public.profiles set status = 'inactive' where id = _student;
      get diagnostics _n = row_count;
      reset role;
      _res := _res || jsonb_build_object('admin_status_rows', _n,
        'admin_status_recorded', (select count(*) from public.admin_actions
                                   where action = 'profile_privileged_change' and target_user_id = _student
                                     and created_at = now() and details->>'caller' = 'authenticated'
                                     and details#>>'{changes,status,new}' = 'inactive'));

      -- 4. A definer path (current_user = the owner, as inside any SECURITY DEFINER function), with a
      --    STUDENT's claims still set: allowed, and recorded.
      perform set_config('request.jwt.claims', jsonb_build_object('sub', _student, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', _student::text, true);
      update public.profiles set telegram_write_access_at = now() where id = _student;
      get diagnostics _n = row_count;
      _res := _res || jsonb_build_object('definer_rows', _n,
        'definer_recorded', (select count(*) from public.admin_actions
                              where action = 'profile_privileged_change' and target_user_id = _student
                                and created_at = now() and details->>'caller' = current_user::text
                                and details#>'{changes}' ? 'telegram_write_access_at'));

      raise exception using errcode = 'ZX999', message = 'profiles_column_guard self-test rollback';
    exception when sqlstate 'ZX999' then
      null;
    end;
    select case when is_called then last_value else 0 end into _after from public.profiles_guard_rejections_seq;
    _res := _res || jsonb_build_object('rejections_counted', _after - _before);
    -- The sequence is the only effect a rollback cannot undo: put it back.
    perform setval('public.profiles_guard_rejections_seq', _seq_last, _seq_called);

    if (_res->>'student_preferred_language_rows') is distinct from '1'
       or coalesce(_res->>'admin_status_rows', '') <> '1'
       or coalesce(_res->>'admin_status_recorded', '') <> '1'
       or coalesce(_res->>'definer_rows', '') <> '1'
       or coalesce(_res->>'definer_recorded', '') <> '1'
       or coalesce((_res->>'rejections_counted')::int, 0) < 6
       or coalesce(_res->>'student_hws_update_rows', '') not in ('0', 'skipped: no ungraded student submission') then
      raise exception 'ABORT: guard end-to-end self-test failed: %', _res;
    end if;
    foreach _k in array array['student_group_id', 'student_account_type', 'student_telegram_id',
                              'student_telegram_username', 'student_active_teacher_group_id',
                              'student_insert_with_group'] loop
      if coalesce(_res->>_k, '') not like 'P0001 Bu maydonni faqat admin%' then
        raise exception 'ABORT: guard end-to-end self-test: % was not rejected by the guard: %', _k, _res;
      end if;
    end loop;
    -- Nothing leaked out of the rolled-back block.
    if exists (select 1 from public.admin_actions
               where action = 'profile_privileged_change' and target_user_id = _student and created_at = now())
       or exists (select 1 from public.profiles where id = _fresh) then
      raise exception 'ABORT: the self-test left rows behind';
    end if;
  end if;

  -- D. Seed the watchdog state AFTER the sequence is restored: its baseline is today's count.
  insert into public.app_settings (key, value)
  values ('profiles_guard_watchdog_state', jsonb_build_object(
    'enabled', true, 'notified_keys', null, 'last_alert_ms', 0,
    'rejections_seen', (select case when is_called then last_value else 0 end
                          from public.profiles_guard_rejections_seq),
    'seeded_by', '20260930120020', 'checked_at', now()))
  on conflict (key) do nothing;

  -- Audit once, even if a racing deploy replays this file.
  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'profiles_column_guard_applied',
         jsonb_build_object('migration', '20260930120020',
                            'guarded', '["telegram_id","telegram_username","email","group_id","status","archived_at","account_type","telegram_write_access_at","created_at"]'::jsonb,
                            'scoped', '["active_teacher_group_id"]'::jsonb,
                            'policies_closed', '["streaks own write","streaks own update","dws own insert","dws own update","hws own insert","quiz_a own all","hws own update (student arm)"]'::jsonb,
                            'self_test', _e2e, 'self_test_results', _res,
                            'guard_md5', (select md5(prosrc) from pg_proc where oid = 'public.profiles_column_guard()'::regprocedure),
                            'kill_switch', 'platform_settings profiles_guard_watchdog {"enabled": false}; guard: alter table public.profiles disable trigger trg_profiles_zz_column_guard',
                            'at', now())
  where not exists (select 1 from public.admin_actions where action = 'profiles_column_guard_applied');
end
$selftest$;

-- ─────────────── 14. Schedule (hourly at :19; :17 and :23 are other watchdogs) ───────────────
select cron.unschedule(jobid) from cron.job where jobname = 'profiles-guard-watchdog';
select cron.schedule('profiles-guard-watchdog', '19 * * * *', $cron$select public.profiles_guard_watchdog()$cron$);
