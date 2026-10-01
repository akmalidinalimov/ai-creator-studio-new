-- PROFILES COLUMN GUARD: make it the LAST BEFORE trigger by construction, and make its watchdog check the real
-- property instead of a stand-in. Incident 2026-09-30 17:26 UTC ("guard down" DM, profiles_guard_watchdog).
-- Prevention hierarchy: layer 1 (a name every "zz_" trigger sorts before), layer 3 (lint rule E11 in
-- scripts/check-migration-grants.mjs) and layer 5 (the detector, rewritten to check what actually matters).
--
-- ═══ WHAT HAPPENED (production, read-only, 2026-10-01 04:35 UTC) ═══
--   * #222 (20260930120020) installed the security guard as trg_profiles_zz_column_guard: BEFORE INSERT OR
--     UPDATE, FOR EACH ROW, profiles_column_guard() (SECURITY INVOKER). It stops a signed-in student from
--     rewriting account_type, group_id (which auto-enrolls), telegram_id and the other guarded columns of
--     their own row over /rest/v1. BEFORE ROW triggers fire in NAME order, so its watchdog
--     (profiles_guard_health(), cron 'profiles-guard-watchdog' at :19) demanded that the guard be the
--     alphabetically LAST before-row trigger: a later one could rewrite NEW after the guard judged it.
--   * #232 (20260930150020, 17:26:56 UTC) added trg_profiles_zz_ig_handle_lock (BEFORE UPDATE OF
--     instagram_username, challenge_task_ig_handle_guard()). 'zz_i' sorts after 'zz_c', so it fires AFTER
--     the guard. The house convention "zz_ = sort me last" is used by five triggers on three tables
--     (profiles x3, challenge_tasks, group_module_topics); it beats the guard for every later name whose letter
--     after "zz_" is above 'c'.
--   * 18:19 UTC: the watchdog alarmed: guard_ok false, problems ["guard_not_last:trg_profiles_zz_ig_handle_lock"],
--     keys ["guard_down"]. One admin_actions row (profiles_guard_watchdog_ALARM 7bb0d370…, dm_attempted 2).
--     One of the two DMs failed with Telegram 403 "user is deactivated" (ops_http_failures, classified
--     'expected'), so exactly ONE admin was told. The 11 hourly runs since decided 'none' and wrote nothing:
--     the state is latched (notified_keys ["guard_down"], last_alert_ms 18:19:00). The 24-h reminder is due
--     at 18:19 UTC on 2026-10-01 (cron :19 + the 23.5-h rule).
--
-- ═══ WAS THE GUARD WEAKENED? No (a false alarm, by the watchdog's own stand-in rule) ═══
--   * challenge_task_ig_handle_guard() (live md5 29319d2e45e7c471d0be2f94f518c4f3, SECURITY INVOKER, ACL
--     postgres + service_role) NEVER assigns NEW: every path either returns NEW unchanged (handle not
--     changed / privileged current_user / not locked) or RAISEs P0001. A trigger that can only raise can only
--     make a write FAIL; it cannot undo a guard decision. Its helper challenge_task_ig_handle_locked(uuid)
--     (STABLE SECURITY DEFINER, EXECUTE authenticated + service_role) answers a boolean about the CALLER
--     only, from read-only STABLE calls.
--   * The guard is intact: profiles_column_guard() md5 8016e666d828887f6b4f9bd2a1b7960f, trigger enabled 'O',
--     SECURITY INVOKER, ROW BEFORE INSERT|UPDATE, no column list, no WHEN.
--   * Nothing slipped through: drift (the one check that does not depend on trigger order) changed_users 0,
--     unexplained_users 0 on every run (snapshot 695 rows, refreshed 04:19); rejection counter 0; exactly one
--     privileged change ever (2026-10-01 04:34:39, service_role, telegram_write_access_at, the bot); 0
--     challenge_task_submissions, 0 'instagram_handle_changed' rows since the lock was created.
--   * The REAL weak spot was the alert latch, not the guard: every structural problem collapsed into the one
--     key 'guard_down', and profiles_guard_alert_decision() alerts only for a key the admins were not told
--     about. So from 18:19 until the 24-h reminder, a REAL outage (trigger dropped, disabled, pointed at
--     another function, made SECURITY DEFINER, wrong events) would have decided 'none' and sent nothing. The
--     same holds for 'rls_drift' (one key for any number of re-opened policies).
--
-- ═══ WHAT THIS DOES (one transaction) ═══
-- 1. RENAME THE GUARD: trg_profiles_zz_column_guard -> trg_profiles_zzz_column_guard. Created first, then the
--    old one dropped, so the table is never without a guard even inside this transaction. Same function,
--    timing, events, (absent) column list and (absent) WHEN; asserted afterwards field by field and as
--    pg_get_triggerdef() equal to the pre-image with only the name changed. 'zzz_' > 'zz_<anything>' in byte
--    order ('z' 0x7A > '_' 0x5F), so the guard now fires after trg_profiles_zz_ig_handle_lock and after every
--    future trigger that follows the "zz_" convention. Renaming the GUARD (not the lock) beats the convention
--    as a whole; renaming the lock to "zy_" would collide again with the next "zz_" trigger. The lock must
--    keep sorting after trg_profiles_normalize_instagram (it compares the NORMALISED handle): it does.
--    Behaviour change, accepted: a single PATCH that changes a LOCKED Instagram handle AND a guarded column is
--    now refused by the lock first (its message, not the guard's), so it does not bump the guard's rejection
--    counter. Both refuse; the lock is dormant until a student has an accepted Instagram task.
-- 2. profiles_guard_health() (pinned rewrite of the LIVE text, md5 42f8156667ea347f1136047ffea07860):
--    a. THE REAL PROPERTY: every enabled BEFORE ROW INSERT/UPDATE trigger on profiles that sorts after the
--       guard (byte order) is a problem 'guard_not_last:<name>' unless it is in the pinned _vetted list
--       (name, function, function body md5, SECURITY DEFINER, type, column list, WHEN): any change to any of
--       them re-arms the alarm. Proving "never assigns NEW" by parsing PL/pgSQL is the lexer trap #189
--       taught us to refuse, so vetting is a human review recorded as a pin. The list starts EMPTY: after
--       the rename nothing sorts after the guard. BEFORE DELETE-only and statement-level triggers cannot
--       touch NEW and are ignored; a disabled one is ignored until it is enabled.
--    b. The guard's own shape check also rejects a column list (BEFORE UPDATE OF x) or a WHEN clause
--       ('guard_trigger_narrowed': either lets other writes skip the guard while every old check passed),
--       and identifies the function by oid, not by name ('guard_trigger_wrong_function').
--    c. ONE ALERT KEY PER PROBLEM: 'guard_down:<problem>' next to 'guard_down', and 'rls_drift:<table>/<policy>/
--       <cmd>' next to 'rls_drift'. The decision function is unchanged (IMMUTABLE); with these keys a second
--       problem during a latched episode is a NEW key, so it alerts at once.
-- 3. profiles_guard_alert_text() (pinned, md5 44cb94ccf7365892d2e38a47ce16a483): the new trigger name, and a
--    'guard_not_last'-only episode says what it is (a trigger firing after the guard: a bypass only if it
--    rewrites NEW) instead of "students can change their group and paid status".
-- 4. profiles_guard_drift() (pinned, md5 4adc2cc0f73c5174ad04f434d284214f): a profile born since the last
--    run (no snapshot row yet) was skipped by the inner join, so a row INSERTED past the guard (replica mode,
--    a disabled trigger) with a group or an account type was never examined and the next refresh absorbed it.
--    Now it is compared with the values the guard lets a row be born with (its INSERT rule: the column
--    defaults; email and created_at have no default and are not compared for it).
-- 5. challenge_task_ig_handle_guard() (pinned, md5 29319d2e45e7c471d0be2f94f518c4f3): COMMENT ONLY. Its
--    header named the guard trigger by its old name; the code lines are asserted byte-identical.
--    NOT changed: profiles_column_guard() (the guard), profiles_guard_watchdog(), profiles_guard_alert_decision().
--
-- ═══ HEAL (automatic; nothing to backfill) ═══
-- No data was damaged (above). On the first profiles_guard_watchdog run after this applies (the next :19):
-- keys = [] while the state still holds notified_keys ["guard_down"], so the unchanged decision says
-- 'recovered': the "✅ Profil himoyasi tiklandi" DM goes to the admins with a telegram_id (up to 3), ONE
-- admin_actions row 'profiles_guard_watchdog_recovered' {decision 'recovered', dm_attempted N} is written, and
-- the state resets (notified_keys null, last_action 'recovered'). Every later run: 'none', no row. If a run
-- instead shows keys, they now name each problem ('guard_down:<problem>').
--
-- ═══ NOT CLOSED HERE (documented gaps) ═══
--   * active_teacher_group_id is not in the drift value set: the guard does not record scope changes on
--     purpose (the bot rewrites it on every group switch), and a value left stale by a reassignment is legal,
--     so "a forged scope" cannot be told from "a stale scope" without history. The bot re-validates it on read.
--   * Guards on other tables that depend on name order have no detector yet (trg_gmt_zz_daily_topic_guard,
--     trg_challenge_tasks_zz_lock; homework_submissions_guard_upd and lesson_progress_guard_upd are already
--     not last, harmless today: the later triggers set only updated_at). Listed in the PR as follow-ups.
--
-- ═══ KILL-SWITCHES (unchanged) ═══
--   Watchdog: platform_settings 'profiles_guard_watchdog' {"enabled": false}. The guard itself has no soft
--   switch, on purpose: `alter table public.profiles disable trigger trg_profiles_zzz_column_guard;` turns it
--   off and the watchdog alarms 'guard_down' + 'guard_down:guard_trigger_disabled' within the hour.
--
-- ═══ PINNED REWRITES (the #189 / 20260930181010 pattern) ═══
-- Each function is edited FROM ITS LIVE pg_get_functiondef, only if md5(replace(prosrc, CR, '')) equals the
-- value read read-only on 2026-10-01 (no CR in any of the four live bodies). Anything else aborts the whole
-- migration with "regenerate". Every edit must match exactly once. After CREATE OR REPLACE (body validation
-- on) the stored definition must equal the executed text; owner, ACL and SECURITY DEFINER must be unchanged.
-- REPLAY-SAFE: the marker "(20261001060000)" in a body means its rewrite is in place and is skipped; the
-- rename is skipped when the guard already has its new name; the audit row is written once.
--
-- ═══ DEPLOY SELF-TEST (sends nothing, keeps no write, needs no JWT, takes no advisory lock) ═══
--   * static: the renamed trigger's shape, the guard is the last enabled BEFORE ROW INSERT/UPDATE trigger,
--     exactly one trigger runs the guard function, ACLs still closed to anon / authenticated.
--   * profiles_guard_health() (read-only): guard_ok true, no 'guard_down' key. Live rls / drift counts are
--     NOT asserted: a real finding at deploy time must not fail the migration; the next run reports it.
--   * the detector on the LIVE catalog, rolled back: inside a sub-block, two throw-away BEFORE UPDATE
--     triggers are created on profiles (one "zz_" name, one sorting after the guard), health() is read, and
--     a sentinel raise rolls the sub-block back (the trigger DDL included). The "zz_" one must NOT be a
--     problem; the later one must be 'guard_not_last:<name>' with its own key. health() is read-only, and
--     profiles is already locked by step 1 in this transaction, so no live write can see them.
--   * the pure decision / text functions against fixed vectors (heal, a second problem during a latch).
--   * profiles_guard_drift() (read-only): well-formed.
--   A PGlite harness covers all of it end to end, plus a student's authenticated UPDATE of account_type /
--   group_id / telegram_id against the renamed guard:
--     deno run -A --node-modules-dir=none supabase/functions/_watchdogs/testing/profiles-guard-order-check.ts
--
-- ═══ DRY-RUN, read-only against production, 2026-10-01 ~05:00 UTC ═══
--   * pins: profiles_guard_health 42f81566…, profiles_guard_alert_text 44cb94cc…, profiles_guard_drift
--     4adc2cc0…, challenge_task_ig_handle_guard 29319d2e… (and profiles_column_guard 8016e666…); no CR in any
--     body; the repo copies (#222, #232) are md5-identical, which is what the harness applies.
--   * trigger pre-image: tgtype 23, tgattr '', no WHEN, tgenabled 'O', tgfoid profiles_column_guard().
--   * public functions naming the guard trigger: profiles_guard_health, profiles_guard_alert_text,
--     challenge_task_ig_handle_guard (comment). Callers of health/drift: profiles_guard_watchdog only.
--   * no open PR adds a BEFORE trigger on profiles or touches these functions (#247: 20261001030000 only).
--
-- MERGE: independent of every open PR. Label migration-approved; NEVER ops-agent (a one-tap merge would land
-- it without the label and it would never be applied).

set local lock_timeout = '15s';  -- never queue behind a long transaction on profiles and stall prod

-- ─────────────── 1. Rename the guard trigger (create new, drop old, assert) ───────────────
do $rename$
declare
  _old_name constant text := 'trg_profiles_zz_column_guard';
  _new_name constant text := 'trg_profiles_zzz_column_guard';
  _guard_fn regprocedure := to_regprocedure('public.profiles_column_guard()');
  _pre record;
  _post record;
  _pre_def text;
  _has_old boolean;
  _has_new boolean;
begin
  if _guard_fn is null then
    raise exception 'ABORT: public.profiles_column_guard() does not exist';
  end if;
  _has_old := exists (select 1 from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname = _old_name);
  _has_new := exists (select 1 from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname = _new_name);

  if _has_new and not _has_old then
    raise notice 'profiles guard trigger already renamed to % -- rename skipped (replay)', _new_name;
  elsif _has_old and not _has_new then
    select t.tgfoid, t.tgtype::int as tgtype, t.tgattr::text as tgattr, t.tgqual is null as no_when,
           t.tgenabled, t.tgnargs, t.tgdeferrable, t.tginitdeferred, t.tgconstraint, t.tgisinternal
      into _pre
      from pg_trigger t where t.tgrelid = 'public.profiles'::regclass and t.tgname = _old_name;
    -- The pre-image this migration was verified against: ROW|BEFORE|INSERT|UPDATE = 1+2+4+16 = 23, no column
    -- list, no WHEN, no arguments, enabled in origin mode, an ordinary (non-constraint) trigger.
    if _pre.tgfoid <> _guard_fn::oid or _pre.tgtype <> 23 or _pre.tgattr <> '' or not _pre.no_when
       or _pre.tgenabled <> 'O' or _pre.tgnargs <> 0 or _pre.tgdeferrable or _pre.tginitdeferred
       or _pre.tgconstraint <> 0 or _pre.tgisinternal then
      raise exception 'ABORT: % is not the shape verified on 2026-10-01 (%); inspect it before renaming', _old_name, row_to_json(_pre);
    end if;
    _pre_def := pg_get_triggerdef((select oid from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname = _old_name));

    create trigger trg_profiles_zzz_column_guard
      before insert or update on public.profiles
      for each row execute function public.profiles_column_guard();
    drop trigger trg_profiles_zz_column_guard on public.profiles;

    select t.tgfoid, t.tgtype::int as tgtype, t.tgattr::text as tgattr, t.tgqual is null as no_when,
           t.tgenabled, t.tgnargs, t.tgdeferrable, t.tginitdeferred, t.tgconstraint, t.tgisinternal
      into _post
      from pg_trigger t where t.tgrelid = 'public.profiles'::regclass and t.tgname = _new_name;
    if row_to_json(_post)::text is distinct from row_to_json(_pre)::text then
      raise exception 'ABORT: the renamed guard differs from its pre-image: % vs %', row_to_json(_post), row_to_json(_pre);
    end if;
    if pg_get_triggerdef((select oid from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname = _new_name))
       is distinct from replace(_pre_def, _old_name, _new_name) then
      raise exception 'ABORT: pg_get_triggerdef of the renamed guard is not the pre-image with only the name changed';
    end if;
  elsif _has_old and _has_new then
    raise exception 'ABORT: both % and % exist on public.profiles; inspect before continuing', _old_name, _new_name;
  else
    raise exception 'ABORT: the profiles guard trigger is MISSING (neither % nor % exists); restore it first', _old_name, _new_name;
  end if;
end $rename$;

-- ─────────────── 2-5. Pinned rewrites of the live functions ───────────────
do $mig$
declare
  _marker constant text := '(20261001060000)';

  -- ── profiles_guard_health() ──
  _h_old1 constant text := E'  _last_before text;\n';
  _h_new1 constant text :=
       E'  _later record;\n'
    || E'  _p text;\n'
    || E'  _e jsonb;\n'
    || E'  -- (20261001060000) VETTED BEFORE ROW triggers that may fire AFTER the guard. Each entry pins one exactly:\n'
    || E'  -- {"tgname", "fn" (regprocedure text), "body_md5" (md5 of prosrc, CRs stripped), "prosecdef", "tgtype",\n'
    || E'  --  "tgattr" (int2vector text), "tgqual" (deparsed WHEN, '''' for none)}; any change re-arms the alarm. Vet\n'
    || E'  -- only a trigger PROVEN never to assign NEW (read its body), only in a reviewed migration. Empty since the\n'
    || E'  -- guard was renamed trg_profiles_zzz_column_guard: nothing sorts after it.\n'
    || E'  _vetted constant jsonb := ''[]'';\n';

  _h_old2 constant text :=
       E'  select t.tgenabled, t.tgtype, p.prosecdef, p.proname into _trg\n'
    || E'    from pg_trigger t join pg_proc p on p.oid = t.tgfoid\n'
    || E'   where t.tgrelid = ''public.profiles''::regclass and t.tgname = ''trg_profiles_zz_column_guard''\n';
  _h_new2 constant text :=
       E'  select t.tgenabled, t.tgtype, p.prosecdef, p.proname, t.tgfoid, t.tgattr::text as tgattr,\n'
    || E'         t.tgqual is not null as has_when into _trg\n'
    || E'    from pg_trigger t join pg_proc p on p.oid = t.tgfoid\n'
    || E'   where t.tgrelid = ''public.profiles''::regclass and t.tgname = ''trg_profiles_zzz_column_guard''\n';

  _h_old3 constant text :=
       E'    if _trg.proname <> ''profiles_column_guard'' then _problems := _problems || ''guard_trigger_wrong_function''::text; end if;\n';
  _h_new3 constant text :=
       E'    -- (20261001060000) by oid: a same-named function in another schema is not the guard.\n'
    || E'    if _trg.tgfoid is distinct from to_regprocedure(''public.profiles_column_guard()'')::oid then\n'
    || E'      _problems := _problems || ''guard_trigger_wrong_function''::text;\n'
    || E'    end if;\n';

  _h_old4 constant text :=
       E'      _problems := _problems || ''guard_trigger_wrong_events''::text;\n'
    || E'    end if;\n'
    || E'  end if;\n';
  _h_new4 constant text :=
       E'      _problems := _problems || ''guard_trigger_wrong_events''::text;\n'
    || E'    end if;\n'
    || E'    -- (20261001060000) a column list (BEFORE UPDATE OF x) or a WHEN clause would let every other write skip\n'
    || E'    -- the guard while every check above still passed.\n'
    || E'    if _trg.tgattr <> '''' or _trg.has_when then\n'
    || E'      _problems := _problems || ''guard_trigger_narrowed''::text;\n'
    || E'    end if;\n'
    || E'  end if;\n';

  _h_old5 constant text :=
       E'  -- BEFORE ROW triggers fire in name order; the guard must judge the final row.\n'
    || E'  select t.tgname into _last_before\n'
    || E'    from pg_trigger t\n'
    || E'   where t.tgrelid = ''public.profiles''::regclass and not t.tgisinternal and t.tgenabled <> ''D''\n'
    || E'     and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2\n'
    || E'   order by t.tgname desc limit 1;\n'
    || E'  if _last_before is distinct from ''trg_profiles_zz_column_guard'' then\n'
    || E'    _problems := _problems || (''guard_not_last:'' || coalesce(_last_before, ''none''));\n'
    || E'  end if;\n';
  _h_new5 constant text :=
       E'  -- (20261001060000) BEFORE ROW triggers fire in name order (byte order: type "name" sorts in the "C"\n'
    || E'  -- collation). One that fires AFTER the guard could rewrite NEW once the guard has judged it, so every\n'
    || E'  -- enabled BEFORE ROW INSERT/UPDATE trigger sorting after the guard is a problem unless pinned in _vetted.\n'
    || E'  -- (This used to compare only the alphabetically LAST name: a stand-in that latched on 2026-09-30 on\n'
    || E'  -- trg_profiles_zz_ig_handle_lock, a trigger that only raises.) DELETE-only and statement-level triggers\n'
    || E'  -- cannot touch NEW; a disabled one does not fire.\n'
    || E'  for _later in\n'
    || E'    select t.tgname::text as tgname, t.tgfoid::regprocedure::text as fn,\n'
    || E'           md5(replace(p.prosrc, chr(13), '''')) as body_md5, p.prosecdef, t.tgtype::int as tgtype,\n'
    || E'           t.tgattr::text as tgattr, coalesce(pg_get_expr(t.tgqual, t.tgrelid), '''') as tgqual\n'
    || E'      from pg_trigger t join pg_proc p on p.oid = t.tgfoid\n'
    || E'     where t.tgrelid = ''public.profiles''::regclass and not t.tgisinternal and t.tgenabled <> ''D''\n'
    || E'       and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 20) <> 0\n'
    || E'       and t.tgname::text collate "C" > ''trg_profiles_zzz_column_guard''\n'
    || E'     order by t.tgname::text collate "C"\n'
    || E'  loop\n'
    || E'    if not exists (select 1 from jsonb_array_elements(_vetted) v where v.value = to_jsonb(_later)) then\n'
    || E'      _problems := _problems || (''guard_not_last:'' || _later.tgname);\n'
    || E'    end if;\n'
    || E'  end loop;\n';

  _h_old6 constant text :=
       E'  if cardinality(_problems) > 0 then _keys := _keys || ''guard_down''::text; end if;\n'
    || E'  if not _ig_ok then _keys := _keys || ''instagram_audit_down''::text; end if;\n'
    || E'  if jsonb_array_length(_rls) > 0 then _keys := _keys || ''rls_drift''::text; end if;\n';
  _h_new6 constant text :=
       E'  -- (20261001060000) One key per problem and per policy as well. profiles_guard_alert_decision() alerts only\n'
    || E'  -- for a key the admins were not told about yet, so with ONE coarse key a second problem of the same\n'
    || E'  -- episode stayed silent until the 24-h reminder.\n'
    || E'  if cardinality(_problems) > 0 then\n'
    || E'    _keys := _keys || ''guard_down''::text;\n'
    || E'    foreach _p in array _problems loop\n'
    || E'      _keys := _keys || (''guard_down:'' || _p);\n'
    || E'    end loop;\n'
    || E'  end if;\n'
    || E'  if not _ig_ok then _keys := _keys || ''instagram_audit_down''::text; end if;\n'
    || E'  if jsonb_array_length(_rls) > 0 then\n'
    || E'    _keys := _keys || ''rls_drift''::text;\n'
    || E'    for _e in select value from jsonb_array_elements(_rls) loop\n'
    || E'      _keys := _keys || (''rls_drift:'' || coalesce(_e->>''table'', ''?'') || ''/'' || coalesce(_e->>''policy'', ''?'')\n'
    || E'                         || ''/'' || coalesce(_e->>''cmd'', ''?''));\n'
    || E'    end loop;\n'
    || E'  end if;\n';

  -- ── profiles_guard_alert_text() ──
  _t_old1 constant text :=
       E'  if _keys ? ''guard_down'' then\n'
    || E'    _msg := _msg || ''🚨 Profil himoyasi (trg_profiles_zz_column_guard) ishlamayapti: ''\n'
    || E'         || coalesce((select string_agg(value, '', '') from jsonb_array_elements_text(p_report->''problems'')), ''?'')\n'
    || E'         || E''.\\nTalabalar oʻz guruhi, toʻlov turi (paid), Telegram ID si va holatini oʻzgartira oladi. ''\n'
    || E'         || ''Darhol tekshiring.'';\n'
    || E'  end if;\n';
  _t_new1 constant text :=
       E'  if _keys ? ''guard_down'' then\n'
    || E'    -- (20261001060000) the guard trigger is trg_profiles_zzz_column_guard. A guard_not_last-only episode is a\n'
    || E'    -- POSSIBLE bypass (a trigger firing after the guard matters only if it rewrites NEW): say exactly that.\n'
    || E'    if jsonb_typeof(p_report->''problems'') = ''array'' and jsonb_array_length(p_report->''problems'') > 0\n'
    || E'       and not exists (select 1 from jsonb_array_elements_text(p_report->''problems'') x(v)\n'
    || E'                       where x.v not like ''guard_not_last:%'') then\n'
    || E'      _msg := _msg || ''⚠️ Profil himoyasidan (trg_profiles_zzz_column_guard) KEYIN ishlaydigan trigger bor: ''\n'
    || E'           || coalesce((select string_agg(substr(value, 16), '', '') from jsonb_array_elements_text(p_report->''problems'')), ''?'')\n'
    || E'           || E''.\\nAgar u yozuvni (NEW) oʻzgartirsa, himoya chetlab oʻtiladi: talaba oʻz guruhi, toʻlov turi yoki ''\n'
    || E'           || ''Telegram ID sini oʻzgartira oladi. Trigger kodini tekshiring: u faqat xato chiqarsa, xavf yoʻq.'';\n'
    || E'    else\n'
    || E'      _msg := _msg || ''🚨 Profil himoyasi (trg_profiles_zzz_column_guard) ishlamayapti: ''\n'
    || E'           || coalesce((select string_agg(value, '', '') from jsonb_array_elements_text(p_report->''problems'')), ''?'')\n'
    || E'           || E''.\\nTalabalar oʻz guruhi, toʻlov turi (paid), Telegram ID si va holatini oʻzgartira oladi. ''\n'
    || E'           || ''Darhol tekshiring.'';\n'
    || E'    end if;\n'
    || E'  end if;\n';

  -- ── profiles_guard_drift() ──
  _d_old1 constant text := E'                     and a.created_at >= s.taken_at - interval ''15 minutes''\n';
  _d_new1 constant text := E'                     and (s.user_id is null or a.created_at >= s.taken_at - interval ''15 minutes'')\n';
  _d_old2 constant text :=
       E'    join public.profiles_guard_snapshot s on s.user_id = c.id\n'
    || E'    cross join lateral jsonb_object_keys(c.v) k(key)\n'
    || E'    where (c.v -> k.key) is distinct from coalesce(s.vals -> k.key, ''null''::jsonb)\n';
  _d_new2 constant text :=
       E'    -- (20261001060000) LEFT join: a profile born since the last run has no snapshot row yet. It used to be\n'
    || E'    -- skipped, so a row INSERTED past the guard (replica mode, a disabled trigger) with a group or an account\n'
    || E'    -- type was never examined and the next refresh absorbed it. It is now compared with what the guard lets\n'
    || E'    -- a row be born with (its INSERT rule: the column defaults); email and created_at have no default and\n'
    || E'    -- are not compared for it. Any matching privileged-change record explains it.\n'
    || E'    left join public.profiles_guard_snapshot s on s.user_id = c.id\n'
    || E'    cross join lateral jsonb_object_keys(c.v) k(key)\n'
    || E'    where (s.user_id is not null or k.key not in (''email'', ''created_at''))\n'
    || E'      and (c.v -> k.key) is distinct from\n'
    || E'          case when s.user_id is not null then coalesce(s.vals -> k.key, ''null''::jsonb)\n'
    || E'               else coalesce(jsonb_build_object(''telegram_id'', null, ''telegram_username'', null, ''group_id'', null,\n'
    || E'                                                ''status'', ''active'', ''archived_at'', null, ''account_type'', ''paid'',\n'
    || E'                                                ''telegram_write_access_at'', null) -> k.key, ''null''::jsonb) end\n';

  -- ── challenge_task_ig_handle_guard(): comment only ──
  _g_old1 constant text :=
       E'-- and admins pass. The PR-0 guard (trg_profiles_zz_column_guard) is untouched.\n';
  _g_new1 constant text :=
       E'-- and admins pass. The PR-0 guard is untouched: since (20261001060000) it is trg_profiles_zzz_column_guard,\n'
    || E'-- which fires AFTER this trigger (BEFORE triggers fire in name order), so it judges the row this one leaves.\n';

  _r record;
  _fn regprocedure;
  _src text; _def text; _new text;
  _acl text; _owner oid; _secdef boolean;
  _n int;
  _done jsonb := '{}'::jsonb;
begin
  -- The CREATE OR REPLACE below must validate the edited body, whatever the session default is.
  perform set_config('check_function_bodies', 'on', true);

  for _r in
    select * from (values
      (1, 'public.profiles_guard_health()', '42f8156667ea347f1136047ffea07860',
          array[_h_old1, _h_old2, _h_old3, _h_old4, _h_old5, _h_old6],
          array[_h_new1, _h_new2, _h_new3, _h_new4, _h_new5, _h_new6]),
      (2, 'public.profiles_guard_alert_text(jsonb,text)', '44cb94ccf7365892d2e38a47ce16a483',
          array[_t_old1], array[_t_new1]),
      (3, 'public.profiles_guard_drift()', '4adc2cc0f73c5174ad04f434d284214f',
          array[_d_old1, _d_old2], array[_d_new1, _d_new2]),
      (4, 'public.challenge_task_ig_handle_guard()', '29319d2e45e7c471d0be2f94f518c4f3',
          array[_g_old1], array[_g_new1])
    ) v(ord, sig, pin, olds, news)
    order by ord
  loop
    _fn := to_regprocedure(_r.sig);
    if _fn is null then
      raise exception 'ABORT: % does not exist', _r.sig;
    end if;
    select prosrc, coalesce(array_to_string(proacl, ','), ''), proowner, prosecdef
      into _src, _acl, _owner, _secdef
      from pg_proc where oid = _fn;

    if position(_marker in _src) > 0 then
      raise notice '% already carries %: rewrite skipped (replay)', _r.sig, _marker;
      _done := _done || jsonb_build_object(_r.sig, 'skipped: already rewritten');
      continue;
    end if;
    if md5(replace(_src, E'\r', '')) <> _r.pin then
      raise exception 'ABORT: % changed since it was verified on 2026-10-01 (md5 %, pinned %); re-read the live definition and regenerate this migration',
        _r.sig, md5(replace(_src, E'\r', '')), _r.pin;
    end if;

    _def := pg_get_functiondef(_fn);
    _new := _def;
    for i in 1 .. array_length(_r.olds, 1) loop
      _n := (length(_new) - length(replace(_new, _r.olds[i], ''))) / length(_r.olds[i]);
      if _n <> 1 then
        raise exception 'ABORT: % edit % matched % times (want exactly 1); regenerate this migration', _r.sig, i, _n;
      end if;
      _new := replace(_new, _r.olds[i], _r.news[i]);
    end loop;

    execute _new;

    -- Post-conditions, from the catalog only.
    if pg_get_functiondef(_fn) is distinct from _new then
      raise exception 'ABORT: % -- the stored definition differs from the one executed', _r.sig;
    end if;
    if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
       or (select proowner from pg_proc where oid = _fn) <> _owner
       or (select prosecdef from pg_proc where oid = _fn) <> _secdef then
      raise exception 'ABORT: % -- owner, ACL or SECURITY DEFINER changed', _r.sig;
    end if;
    if position(_marker in (select prosrc from pg_proc where oid = _fn)) = 0 then
      raise exception 'ABORT: % -- the marker is not in the stored body', _r.sig;
    end if;
    _done := _done || jsonb_build_object(_r.sig, jsonb_build_object(
      'from_md5', _r.pin, 'to_md5', (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _fn)));
  end loop;

  -- The ig-lock rewrite is comment-only: its CODE lines (comment and blank lines removed) must be byte-identical
  -- to the live code verified on 2026-10-01.
  if (select string_agg(l, E'\n' order by n) from regexp_split_to_table(
            (select replace(prosrc, E'\r', '') from pg_proc where oid = 'public.challenge_task_ig_handle_guard()'::regprocedure), E'\n')
            with ordinality x(l, n) where l !~ '^\s*(--|$)')
     is distinct from
     E'begin\n'
     || E'  if NEW.instagram_username is not distinct from OLD.instagram_username then\n'
     || E'    return NEW;\n'
     || E'  end if;\n'
     || E'  if current_user::text not in (''authenticated'', ''anon'') then\n'
     || E'    return NEW;\n'
     || E'  end if;\n'
     || E'  if public.challenge_task_ig_handle_locked(NEW.id) then\n'
     || E'    raise exception using errcode = ''P0001'', message = ''Instagram profilingizni o‘zgartirish uchun admin bilan bog‘laning'',\n'
     || E'      detail = ''challenge_task_ig_handle_guard: instagram_username locked after an accepted instagram task'';\n'
     || E'  end if;\n'
     || E'  return NEW;\n'
     || E'end' then
    raise exception 'ABORT: challenge_task_ig_handle_guard() -- its code changed, not only its comment';
  end if;

  perform set_config('pgo.rewrites', _done::text, true);
end $mig$;

-- ─────────────── 6. Deploy self-test + one audit row (see the header) ───────────────
do $selftest$
declare
  _guard_fn regprocedure := to_regprocedure('public.profiles_column_guard()');
  _h jsonb;
  _healthy_keys jsonb;
  _d jsonb;
  _txt text;
  _now bigint := 1790000000000;
  _case record;
  _k text;
  _last text;
  _detector jsonb;
  _sqlstate text;
  _msg text;
begin
  -- A. Static: the renamed trigger, and that it is last.
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.profiles'::regclass and t.tgname = 'trg_profiles_zzz_column_guard'
                    and t.tgfoid = _guard_fn::oid and t.tgtype = 23 and t.tgattr::text = '' and t.tgqual is null
                    and t.tgenabled = 'O' and not t.tgisinternal) then
    raise exception 'ABORT: trg_profiles_zzz_column_guard is missing or not BEFORE INSERT OR UPDATE FOR EACH ROW profiles_column_guard()';
  end if;
  if exists (select 1 from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname = 'trg_profiles_zz_column_guard') then
    raise exception 'ABORT: the old guard trigger name is still present';
  end if;
  if (select count(*) from pg_trigger where tgrelid = 'public.profiles'::regclass and tgfoid = _guard_fn::oid) <> 1 then
    raise exception 'ABORT: exactly one trigger on profiles must run profiles_column_guard()';
  end if;
  select t.tgname::text into _last
    from pg_trigger t
   where t.tgrelid = 'public.profiles'::regclass and not t.tgisinternal and t.tgenabled <> 'D'
     and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 20) <> 0
   order by t.tgname::text collate "C" desc limit 1;
  if _last is distinct from 'trg_profiles_zzz_column_guard' then
    raise exception 'ABORT: the guard is not the last BEFORE ROW INSERT/UPDATE trigger on profiles (last: %)', _last;
  end if;
  if (select prosecdef from pg_proc where oid = _guard_fn::oid) then
    raise exception 'ABORT: profiles_column_guard() must be SECURITY INVOKER';
  end if;
  foreach _k in array array['public.profiles_guard_health()', 'public.profiles_guard_drift()',
                            'public.profiles_guard_watchdog()', 'public.profiles_guard_alert_text(jsonb,text)',
                            'public.profiles_guard_alert_decision(jsonb,bigint,jsonb,bigint)',
                            'public.challenge_task_ig_handle_guard()'] loop
    if has_function_privilege('anon', _k, 'EXECUTE') or has_function_privilege('authenticated', _k, 'EXECUTE') then
      raise exception 'ABORT: anon or authenticated can execute %', _k;
    end if;
  end loop;

  -- B. The detector, read-only: healthy now.
  _h := public.profiles_guard_health();
  if _h is null or jsonb_typeof(_h->'keys') is distinct from 'array' or jsonb_typeof(_h->'problems') is distinct from 'array' then
    raise exception 'ABORT: profiles_guard_health() report is malformed: %', coalesce(_h::text, 'NULL');
  end if;
  if coalesce(_h->>'guard_ok', '') <> 'true' or jsonb_array_length(_h->'problems') <> 0 then
    raise exception 'ABORT: the guard is not healthy after the rename: %', _h->'problems';
  end if;
  if exists (select 1 from jsonb_array_elements_text(_h->'keys') x(v) where x.v like 'guard_down%') then
    raise exception 'ABORT: guard_down keys after the rename: %', _h->'keys';
  end if;
  _healthy_keys := _h->'keys';
  _d := public.profiles_guard_drift();
  if _d is null or jsonb_typeof(_d->'unexplained') is distinct from 'array'
     or coalesce(_d->>'unexplained_users', '') !~ '^[0-9]+$' or coalesce(_d->>'snapshot_rows', '') !~ '^[0-9]+$' then
    raise exception 'ABORT: profiles_guard_drift() report is malformed: %', coalesce(_d::text, 'NULL');
  end if;

  -- C. The detector on the LIVE catalog: a later trigger alarms, a "zz_" one does not. Rolled back.
  begin
    create trigger trg_profiles_zz_order_selftest before update on public.profiles
      for each row execute function public.update_updated_at_column();
    create trigger trg_profiles_zzzz_order_selftest before update on public.profiles  -- lint:allow E11: rolled-back self-test proving the detector fires on a later trigger
      for each row execute function public.update_updated_at_column();
    _h := public.profiles_guard_health();
    _detector := jsonb_build_object('problems', _h->'problems', 'keys', _h->'keys');
    raise exception using errcode = 'ZX998', message = 'profiles guard order self-test rollback';
  exception when sqlstate 'ZX998' then
    null;
  end;
  if (_detector->'problems') is distinct from '["guard_not_last:trg_profiles_zzzz_order_selftest"]'::jsonb
     or not ((_detector->'keys') @> '["guard_down", "guard_down:guard_not_last:trg_profiles_zzzz_order_selftest"]'::jsonb) then
    raise exception 'ABORT: the detector did not flag (only) the later trigger: %', _detector;
  end if;
  if exists (select 1 from pg_trigger where tgrelid = 'public.profiles'::regclass and tgname like '%order_selftest') then
    raise exception 'ABORT: the self-test triggers were not rolled back';
  end if;

  -- D. Pure: the alert decision with per-problem keys (the function itself is unchanged).
  for _case in
    select * from (values
      ('heal: the latched 2026-09-30 episode clears', '[]'::jsonb,
         jsonb_build_object('notified_keys', '["guard_down"]'::jsonb, 'last_alert_ms', _now - 3600000), 'recovered'),
      ('the old coarse latch meets a per-problem key: told once', '["guard_down", "guard_down:guard_trigger_disabled"]'::jsonb,
         jsonb_build_object('notified_keys', '["guard_down"]'::jsonb, 'last_alert_ms', _now - 3600000), 'alert'),
      ('same problems an hour later: quiet', '["guard_down", "guard_down:guard_not_last:x"]'::jsonb,
         jsonb_build_object('notified_keys', '["guard_down", "guard_down:guard_not_last:x"]'::jsonb, 'last_alert_ms', _now - 3600000), 'none'),
      ('a SECOND problem during a latch: alert at once',
         '["guard_down", "guard_down:guard_not_last:x", "guard_down:guard_trigger_disabled"]'::jsonb,
         jsonb_build_object('notified_keys', '["guard_down", "guard_down:guard_not_last:x"]'::jsonb, 'last_alert_ms', _now - 3600000), 'alert'),
      ('a SECOND re-opened policy during a latch: alert at once',
         '["rls_drift", "rls_drift:streaks/a/a", "rls_drift:streaks/b/w"]'::jsonb,
         jsonb_build_object('notified_keys', '["rls_drift", "rls_drift:streaks/a/a"]'::jsonb, 'last_alert_ms', _now - 3600000), 'alert')
    ) v(label, keys, state, expected)
  loop
    if public.profiles_guard_alert_decision(_case.keys, 0, _case.state, _now) is distinct from _case.expected then
      raise exception 'ABORT: alert_decision(%) = %, expected %', _case.label,
        public.profiles_guard_alert_decision(_case.keys, 0, _case.state, _now), _case.expected;
    end if;
  end loop;

  -- E. Pure: the alert text.
  _txt := public.profiles_guard_alert_text(jsonb_build_object(
            'keys', '["guard_down", "guard_down:guard_not_last:trg_x"]'::jsonb, 'problems', '["guard_not_last:trg_x"]'::jsonb), 'alert');
  if coalesce(_txt, '') not like '%trg_profiles_zzz_column_guard%' or _txt not like '%KEYIN%' or _txt not like '%: trg_x.%'
     or _txt like '%🚨%' then
    raise exception 'ABORT: alert_text for a later trigger is wrong: %', _txt;
  end if;
  _txt := public.profiles_guard_alert_text(jsonb_build_object(
            'keys', '["guard_down", "guard_down:guard_trigger_disabled"]'::jsonb, 'problems', '["guard_trigger_disabled"]'::jsonb), 'alert');
  if coalesce(_txt, '') not like '%🚨 Profil himoyasi (trg_profiles_zzz_column_guard) ishlamayapti: guard_trigger_disabled.%' then
    raise exception 'ABORT: alert_text for a disabled guard is wrong: %', _txt;
  end if;
  if coalesce(public.profiles_guard_alert_text(null, 'alert'), '') = ''
     or coalesce(public.profiles_guard_alert_text('{}'::jsonb, 'recovered'), '') not like '✅%' then
    raise exception 'ABORT: profiles_guard_alert_text() is broken';
  end if;

  -- F. Audit once, even if a racing deploy replays this file.
  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'profiles_guard_trigger_renamed',
         jsonb_build_object('migration', '20261001060000',
                            'from', 'trg_profiles_zz_column_guard', 'to', 'trg_profiles_zzz_column_guard',
                            'triggerdef', (select pg_get_triggerdef(oid) from pg_trigger
                                            where tgrelid = 'public.profiles'::regclass and tgname = 'trg_profiles_zzz_column_guard'),
                            'guard_md5', (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _guard_fn::oid),
                            'rewrites', coalesce(nullif(current_setting('pgo.rewrites', true), '')::jsonb, '{}'::jsonb),
                            'self_test', jsonb_build_object('detector', _detector, 'health_keys', _healthy_keys,
                                                            'drift_unexplained', _d->'unexplained_users'),
                            'false_alarm', 'guard_not_last:trg_profiles_zz_ig_handle_lock since 2026-09-30 18:19 UTC: the lock never assigns NEW',
                            'at', now())
  where not exists (select 1 from public.admin_actions where action = 'profiles_guard_trigger_renamed');
end
$selftest$;
