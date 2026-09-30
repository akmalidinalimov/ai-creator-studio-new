-- FIX: teacherless-homework watchdog noise (follow-up to 20260929191000 / PR #210 review).
--
-- Five findings, each checked against the LIVE functions on 2026-09-30 (their md5s are pinned below;
-- the live bodies were still byte-identical to 20260929191000):
--
-- (a) A "recovered" DM for an episode that no admin was told about. The decision said 'recovered'
--     whenever the state row had alerting = true, and the watchdog wrote alerting := <alarm> on every
--     run, whether or not a DM went out. With no bot token, no admin telegram_id, or ops_net_post
--     raising for every admin, the alert was never sent, but the end of the episode was announced.
--     Now 'recovered' also needs state.notified_keys to be an array. The watchdog sets it only after
--     it attempted a DM (a 'none' run keeps an array that is already there) and clears it when the
--     episode ends, so it means exactly "an alert of this episode was attempted". Attempted = handed
--     to ops_net_post without an error; a request Telegram then rejects is in ops_http_failures.
-- (b) One ALARM admin_actions row every hour while an alert cannot be sent. The cooldown starts only
--     on an attempt, so the next run retries (by design), and every retry wrote its own ALARM row.
--     Now teacherless_homework_alarm_row_due() (new, pure) lets a failed alert write a row only if
--     the previous run did not already log a failure for the same key set and stage (kept in the
--     state row as 'undelivered'). The hourly retries are unchanged. A row for an attempted DM
--     follows the DM cadence, as before.
-- (c) Staff counted in two of the three legs of health(). The groups leg excludes profiles with a
--     teacher / admin / superadmin role; the ungraded-submissions leg and the sender-rows leg
--     ('no_teacher' / 'no_group') did not. 8 of the 9 staff accounts have no group, and
--     submit-homework's JSON path does not require one (only the multipart topic-post path does,
--     index.ts:363-366), so a staff account's own test submission could raise the alarm on its own
--     (an ungraded submission with no group, plus a 'no_group' sender row). Both legs now use the
--     same exclusion. For the sender rows the submitter is actor_user_id, which both senders set, or
--     details.student_id. Blast radius today: 1 staff submission ever (2026-07-10), none in the 7-day
--     window, 0 sender rows with a reason, 0 ALARM rows. Nothing to heal.
-- (d) The documented kill-switch, cron.unschedule, turned the GitHub verifier red every day after
--     25 h: hw_dm_health_stats().stale_watchdogs counts every app_settings row named
--     '%_watchdog_state' whose checked_at is older than 25 h, and hw-dm-health.yml fails when it is
--     above 0. The kill-switch is now platform_settings 'teacherless_homework_watchdog'
--     {"enabled": false} (seeded as true here). A disabled run reads nothing else and sends nothing,
--     writes one admin_actions row when it first sees the switch, and stamps checked_at, so the
--     verifier stays green while the cron is alive and still fails if the cron itself stops. The rest
--     of the state row is kept, so switching back on resumes the same episode.
-- (e) The daily reminder drifted between 24 h and 25 h. last_alert_ms is the run's now(), which
--     moves by tens of ms from day to day (anon-execute-watchdog, '17 * * * *', started at
--     2026-09-28 06:17:00.232959 and 2026-09-29 06:17:00.196517, 36 ms short of 24 h). With a
--     24 h threshold the run due 24 h later was often a few ms short, and the reminder went out an
--     hour late. The threshold is now 23.5 h: the 24th hourly run after an alert always qualifies
--     and the 23rd never does. (The other watchdogs' cooldowns have the same property; out of scope.)
--
-- KILL-SWITCH (replaces cron.unschedule):
--   update public.platform_settings set value = value || '{"enabled": false}'
--    where key = 'teacherless_homework_watchdog';          -- back on: '{"enabled": true}'
-- Full removal: select cron.unschedule('teacherless-homework-watchdog'); AND delete the app_settings
-- row 'teacherless_homework_watchdog_state' (stale_watchdogs counts only rows that exist).
--
-- HOW. Pinned rewrites of three live functions (teacherless_homework_alert_text is not changed). Each
-- starts from pg_get_functiondef, refuses a body whose md5 is not the one verified on 2026-09-30,
-- applies replace() edits that must each match exactly once, executes the result, and then checks the
-- stored definition, owner, ACL and SECURITY DEFINER. A body that already has this migration's
-- marker (20260930083000) is skipped, so a replay changes nothing. The state row is not touched: the
-- live row (alerting false, notified_keys null, no 'undelivered', no 'enabled') is a valid input to
-- every new rule, and the self-test checks that.
--
-- SELF-TEST: calls only the read-only health() and the pure functions. It never calls the watchdog, so
-- it cannot DM or change what it checks; it needs no JWT and takes no lock. The PGlite harness
-- supabase/functions/_watchdogs/testing/teacherless-noise-check.ts runs this file on the live
-- definitions and drives the watchdog end to end with a stub ops_net_post.

-- ─────────────── 1. The dedupe rule for the ALARM row (new, pure) ───────────────
create or replace function public.teacherless_homework_alarm_row_due(
  p_action text, p_dm integer, p_keys jsonb, p_stage integer, p_state jsonb)
returns boolean
language sql
immutable
set search_path to 'public'
as $function$
  -- Should this watchdog run write its teacherless_homework_watchdog_ALARM / _recovered row?
  -- The watchdog passes its decision, how many DMs it handed to ops_net_post, the report's key set
  -- and stage, and the state row as it was when the run started.
  select case
    when p_action = 'recovered' then true               -- once per episode: the state flips back
    when p_action is distinct from 'alert' then false   -- 'none', or anything unknown
    when coalesce(p_dm, 0) > 0 then true                -- an attempted DM: follows the DM cadence
    -- A failed alert: write a row unless the previous run already wrote one for the same key set and
    -- stage. The watchdog stores that pair as state.undelivered, built exactly like this object.
    else (p_state->'undelivered') is distinct from
         jsonb_build_object('keys', p_keys, 'stage', coalesce(p_stage, 0))
  end
$function$;

revoke execute on function public.teacherless_homework_alarm_row_due(text, integer, jsonb, integer, jsonb) from public, anon, authenticated;
grant  execute on function public.teacherless_homework_alarm_row_due(text, integer, jsonb, integer, jsonb) to service_role;

-- ─────────────── 2. health(): staff excluded in every leg (c) ───────────────
do $$
declare
  _pin constant text := '6863224f0f9b66ab8de4dda68dfe8148';   -- live body md5, 2026-09-30

  _old1 constant text :=
       E'      and hs.submitted_at > now() - interval ''7 days''\n'
    || E'      and coalesce(gr.has_reachable_teacher, false) = false\n';
  _new1 constant text :=
       E'      and hs.submitted_at > now() - interval ''7 days''\n'
    || E'      and coalesce(gr.has_reachable_teacher, false) = false\n'
    || E'      -- Staff are not students (20260930083000): the groups leg''s teacher/admin/superadmin\n'
    || E'      -- exclusion, so a staff account''s own test submission cannot raise the alarm.\n'
    || E'      and not exists (select 1 from public.user_roles r\n'
    || E'                      where r.user_id = hs.user_id and r.role in (''teacher'', ''admin'', ''superadmin''))\n';

  _old2 constant text :=
       E'      and a.details->>''reason'' in (''no_teacher'', ''no_group'')\n'
    || E'  ),\n';
  _new2 constant text :=
       E'      and a.details->>''reason'' in (''no_teacher'', ''no_group'')\n'
    || E'      -- ...and not a staff account''s own submission (20260930083000). Both senders set\n'
    || E'      -- actor_user_id and details.student_id to the submitter; either one being staff excludes it.\n'
    || E'      and not exists (select 1 from public.user_roles r\n'
    || E'                      where r.role in (''teacher'', ''admin'', ''superadmin'')\n'
    || E'                        and (r.user_id = a.actor_user_id or r.user_id::text = a.details->>''student_id''))\n'
    || E'  ),\n';

  _olds text[];
  _news text[];
  _fn oid;
  _src text; _def text; _new text;
  _acl text; _owner oid; _secdef boolean;
  _n int;
begin
  _olds := array[_old1, _old2];
  _news := array[_new1, _new2];

  _fn := 'public.teacherless_homework_health()'::regprocedure;
  select prosrc, coalesce(array_to_string(proacl, ','), ''), proowner, prosecdef
    into _src, _acl, _owner, _secdef
    from pg_proc where oid = _fn;

  if position('20260930083000' in _src) > 0 then
    raise notice 'teacherless_homework_health already rewritten by 20260930083000 -- skipped';
    return;
  end if;
  if md5(replace(_src, E'\r', '')) <> _pin then
    raise exception 'ABORT: teacherless_homework_health changed since it was verified (md5 %); regenerate this migration from the live definition',
      md5(replace(_src, E'\r', ''));
  end if;

  _def := pg_get_functiondef(_fn);
  _new := _def;
  for i in 1 .. array_length(_olds, 1) loop
    _n := (length(_new) - length(replace(_new, _olds[i], ''))) / length(_olds[i]);
    if _n <> 1 then
      raise exception 'ABORT: teacherless_homework_health edit % matched % times (want exactly 1)', i, _n;
    end if;
    _new := replace(_new, _olds[i], _news[i]);
  end loop;

  execute _new;

  if pg_get_functiondef(_fn) is distinct from _new then
    raise exception 'ABORT: teacherless_homework_health -- stored definition differs from what was executed';
  end if;
  if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
     or (select proowner from pg_proc where oid = _fn) <> _owner
     or (select prosecdef from pg_proc where oid = _fn) <> _secdef then
    raise exception 'ABORT: teacherless_homework_health -- owner, ACL or SECURITY DEFINER changed';
  end if;
end $$;

-- ─────────────── 3. alert_decision(): recovery only after an attempted alert (a); 23.5 h (e) ───────────────
do $$
declare
  _pin constant text := '41c55716aa0a067325a393ed8aa1009d';   -- live body md5, 2026-09-30

  _old1 constant text :=
       E'                              p_now_ms) >= 86400000\n'
    || E'          then ''alert''\n';
  _new1 constant text :=
       E'                              p_now_ms) >= 84600000\n'
    || E'          -- 23.5 h, not 24 h (20260930083000). last_alert_ms is a run''s now(), which moves by\n'
    || E'          -- tens of ms from day to day, so with 24 h the run due 24 h later was often a few ms\n'
    || E'          -- short and the reminder slipped an hour. With 30 min of slack the 24th hourly run\n'
    || E'          -- after an alert always qualifies and the 23rd never does.\n'
    || E'          then ''alert''\n';

  _old2 constant text :=
       E'    when coalesce(p_state->>''alerting'', '''') = ''true'' then ''recovered''\n';
  _new2 constant text :=
       E'    -- Recovery only for an episode whose alert was attempted (20260930083000). notified_keys is\n'
    || E'    -- an array only after a DM of this episode was attempted, and the watchdog clears it when\n'
    || E'    -- the episode ends, so an episode no admin was told about (no bot token, no admin\n'
    || E'    -- telegram_id, ops_net_post raising) now ends without a "recovered" message.\n'
    || E'    when coalesce(p_state->>''alerting'', '''') = ''true''\n'
    || E'         and jsonb_typeof(p_state->''notified_keys'') = ''array'' then ''recovered''\n';

  _olds text[];
  _news text[];
  _fn oid;
  _src text; _def text; _new text;
  _acl text; _owner oid; _secdef boolean;
  _n int;
begin
  _olds := array[_old1, _old2];
  _news := array[_new1, _new2];

  _fn := 'public.teacherless_homework_alert_decision(boolean, jsonb, integer, jsonb, bigint)'::regprocedure;
  select prosrc, coalesce(array_to_string(proacl, ','), ''), proowner, prosecdef
    into _src, _acl, _owner, _secdef
    from pg_proc where oid = _fn;

  if position('20260930083000' in _src) > 0 then
    raise notice 'teacherless_homework_alert_decision already rewritten by 20260930083000 -- skipped';
    return;
  end if;
  if md5(replace(_src, E'\r', '')) <> _pin then
    raise exception 'ABORT: teacherless_homework_alert_decision changed since it was verified (md5 %); regenerate this migration from the live definition',
      md5(replace(_src, E'\r', ''));
  end if;

  _def := pg_get_functiondef(_fn);
  _new := _def;
  for i in 1 .. array_length(_olds, 1) loop
    _n := (length(_new) - length(replace(_new, _olds[i], ''))) / length(_olds[i]);
    if _n <> 1 then
      raise exception 'ABORT: teacherless_homework_alert_decision edit % matched % times (want exactly 1)', i, _n;
    end if;
    _new := replace(_new, _olds[i], _news[i]);
  end loop;

  execute _new;

  if pg_get_functiondef(_fn) is distinct from _new then
    raise exception 'ABORT: teacherless_homework_alert_decision -- stored definition differs from what was executed';
  end if;
  if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
     or (select proowner from pg_proc where oid = _fn) <> _owner
     or (select prosecdef from pg_proc where oid = _fn) <> _secdef then
    raise exception 'ABORT: teacherless_homework_alert_decision -- owner, ACL or SECURITY DEFINER changed';
  end if;
end $$;

-- ─────────────── 4. watchdog(): kill-switch (d); one row per undelivered alert (b) ───────────────
do $$
declare
  _pin constant text := '9c92531b4672cbfade65c74e63a60c92';   -- live body md5, 2026-09-30

  _old1 constant text :=
       E'  _dm int := 0;\n'
    || E'begin\n'
    || E'  select value into _state from public.app_settings where key = ''teacherless_homework_watchdog_state'';\n';
  _new1 constant text :=
       E'  _dm int := 0;\n'
    || E'  _cfg jsonb;\n'
    || E'  _undelivered jsonb;\n'
    || E'begin\n'
    || E'  select value into _state from public.app_settings where key = ''teacherless_homework_watchdog_state'';\n'
    || E'\n'
    || E'  -- KILL-SWITCH (20260930083000): platform_settings ''teacherless_homework_watchdog'' {"enabled": false}.\n'
    || E'  -- A disabled run reads nothing else and sends nothing, writes one admin_actions row when it\n'
    || E'  -- first sees the switch, and stamps checked_at in the state row. hw_dm_health_stats()\n'
    || E'  -- .stale_watchdogs counts every *_watchdog_state row whose checked_at is older than 25 h, and\n'
    || E'  -- the GitHub verifier fails on it, so stopping the cron (the old kill-switch) turned the\n'
    || E'  -- verifier red every day. A disabled run keeps it green, and a cron that really stops still\n'
    || E'  -- goes stale. The rest of the state is kept, so switching back on resumes the same episode.\n'
    || E'  select value into _cfg from public.platform_settings where key = ''teacherless_homework_watchdog'';\n'
    || E'  if coalesce(_cfg->>''enabled'', '''') = ''false'' then\n'
    || E'    if coalesce(_state->>''last_action'', '''') <> ''disabled'' then\n'
    || E'      begin\n'
    || E'        insert into public.admin_actions (actor_user_id, action, details)\n'
    || E'        values (null, ''teacherless_homework_watchdog_disabled'', jsonb_build_object(''config'', _cfg));\n'
    || E'      exception when others then null; end;\n'
    || E'    end if;\n'
    || E'    insert into public.app_settings (key, value)\n'
    || E'    values (''teacherless_homework_watchdog_state'',\n'
    || E'            (case when jsonb_typeof(_state) = ''object'' then _state else ''{}''::jsonb end)\n'
    || E'            || jsonb_build_object(''enabled'', false, ''last_action'', ''disabled'',\n'
    || E'                                  ''dm_attempted_last_run'', 0, ''checked_at'', now()))\n'
    || E'    on conflict (key) do update set value = excluded.value;\n'
    || E'    return jsonb_build_object(''disabled'', true, ''checked_at'', now());\n'
    || E'  end if;\n';

  _old2 constant text :=
       E'    begin\n'
    || E'      insert into public.admin_actions (actor_user_id, action, details)\n'
    || E'      values (null,\n'
    || E'              case when _action = ''alert'' then ''teacherless_homework_watchdog_ALARM''\n'
    || E'                   else ''teacherless_homework_watchdog_recovered'' end,\n'
    || E'              coalesce(_r, jsonb_build_object(''error'', _err)) || jsonb_build_object(''dm_attempted'', _dm));\n'
    || E'    exception when others then null; end;\n'
    || E'  end if;\n';
  _new2 constant text :=
       E'    -- One ALARM row per alert that reached ops_net_post, and ONE per alert that could not\n'
    || E'    -- (20260930083000). With no bot token, no admin telegram_id or ops_net_post raising, the\n'
    || E'    -- decision says ''alert'' again every hour (the cooldown starts only on an attempt, so the\n'
    || E'    -- next run retries), and each retry used to write another ALARM row. The retries are\n'
    || E'    -- unchanged; a failed one writes a row only if the previous run did not already write one\n'
    || E'    -- for the same key set and stage.\n'
    || E'    if public.teacherless_homework_alarm_row_due(_action, _dm, _keys, _stage, _state) then\n'
    || E'      begin\n'
    || E'        insert into public.admin_actions (actor_user_id, action, details)\n'
    || E'        values (null,\n'
    || E'                case when _action = ''alert'' then ''teacherless_homework_watchdog_ALARM''\n'
    || E'                     else ''teacherless_homework_watchdog_recovered'' end,\n'
    || E'                coalesce(_r, jsonb_build_object(''error'', _err)) || jsonb_build_object(''dm_attempted'', _dm));\n'
    || E'      exception when others then null; end;\n'
    || E'    end if;\n'
    || E'  end if;\n';

  _old3 constant text :=
       E'  -- (alert with no DM attempted: keep the old values, so the next hourly run retries)\n';
  _new3 constant text :=
       E'  -- (alert with no DM attempted: keep the old values, so the next hourly run retries)\n'
    || E'  -- The key set and stage of a failed alert, which teacherless_homework_alarm_row_due() compares\n'
    || E'  -- the next failure with (20260930083000). Any other outcome clears it.\n'
    || E'  _undelivered := case when _action = ''alert'' and _dm = 0\n'
    || E'                       then jsonb_build_object(''keys'', _keys, ''stage'', _stage) end;\n';

  _old4 constant text :=
       E'    ''dm_attempted_last_run'', _dm,\n';
  _new4 constant text :=
       E'    ''dm_attempted_last_run'', _dm,\n'
    || E'    ''undelivered'', _undelivered,\n'
    || E'    ''enabled'', true,\n';

  _olds text[];
  _news text[];
  _fn oid;
  _src text; _def text; _new text;
  _acl text; _owner oid; _secdef boolean;
  _n int;
begin
  _olds := array[_old1, _old2, _old3, _old4];
  _news := array[_new1, _new2, _new3, _new4];

  _fn := 'public.teacherless_homework_watchdog()'::regprocedure;
  select prosrc, coalesce(array_to_string(proacl, ','), ''), proowner, prosecdef
    into _src, _acl, _owner, _secdef
    from pg_proc where oid = _fn;

  if position('20260930083000' in _src) > 0 then
    raise notice 'teacherless_homework_watchdog already rewritten by 20260930083000 -- skipped';
    return;
  end if;
  if md5(replace(_src, E'\r', '')) <> _pin then
    raise exception 'ABORT: teacherless_homework_watchdog changed since it was verified (md5 %); regenerate this migration from the live definition',
      md5(replace(_src, E'\r', ''));
  end if;

  _def := pg_get_functiondef(_fn);
  _new := _def;
  for i in 1 .. array_length(_olds, 1) loop
    _n := (length(_new) - length(replace(_new, _olds[i], ''))) / length(_olds[i]);
    if _n <> 1 then
      raise exception 'ABORT: teacherless_homework_watchdog edit % matched % times (want exactly 1)', i, _n;
    end if;
    _new := replace(_new, _olds[i], _news[i]);
  end loop;

  execute _new;

  if pg_get_functiondef(_fn) is distinct from _new then
    raise exception 'ABORT: teacherless_homework_watchdog -- stored definition differs from what was executed';
  end if;
  if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
     or (select proowner from pg_proc where oid = _fn) <> _owner
     or (select prosecdef from pg_proc where oid = _fn) <> _secdef then
    raise exception 'ABORT: teacherless_homework_watchdog -- owner, ACL or SECURITY DEFINER changed';
  end if;
  -- The (SECURITY DEFINER) watchdog runs as its owner, which must be able to call the new rule.
  if not has_function_privilege(_owner,
       'public.teacherless_homework_alarm_row_due(text, integer, jsonb, integer, jsonb)', 'EXECUTE') then
    raise exception 'ABORT: the watchdog''s owner cannot EXECUTE teacherless_homework_alarm_row_due()';
  end if;
end $$;

-- ─────────────── 5. The kill-switch row (d). Never overwrites an owner's setting. ───────────────
insert into public.platform_settings (key, value)
values ('teacherless_homework_watchdog', '{"enabled": true}'::jsonb)
on conflict (key) do nothing;

-- ─────────────── 6. Deploy self-test (read-only health + pure functions + static checks) ───────────────
do $$
declare
  _r jsonb;
  _live jsonb;
  _d text;
  _now bigint := 1790000000000;
  _ab jsonb := '["a:g1:no_teacher", "b:g1"]';
  _a  jsonb := '["a:g1:no_teacher"]';
  _seed jsonb := '{"alerting": false, "notified_keys": null, "notified_stage": 0, "last_alert_ms": 0, "seeded_by": "20260929191000"}';
  _st jsonb;
  _sig jsonb;
  _src text;
  _at_health int;
  _case record;
begin
  -- 1. health(): read-only, and still a well-formed verdict (true OR false).
  _r := public.teacherless_homework_health();
  if _r is null or jsonb_typeof(_r -> 'alarm') is distinct from 'boolean'
     or jsonb_typeof(_r -> 'keys') is distinct from 'array'
     or jsonb_typeof(_r -> 'groups') is distinct from 'array'
     or coalesce(_r->>'pending_stage', '') !~ '^[0-3]$'
     or jsonb_typeof(_r -> 'pending') is distinct from 'number'
     or jsonb_typeof(_r -> 'no_teacher_events_24h') is distinct from 'number'
     or jsonb_typeof(_r -> 'no_group_events_24h') is distinct from 'number' then
    raise exception 'ABORT: teacherless_homework_health() report is malformed: %', coalesce(_r::text, 'NULL');
  end if;

  -- 2. (c) health() excludes staff in the submissions leg and the sender-rows leg too. Static: the
  --    self-test writes no fixture rows. (The PGlite harness checks the behaviour.)
  select prosrc into _src from pg_proc where oid = 'public.teacherless_homework_health()'::regprocedure;
  if position('where r.user_id = hs.user_id and r.role in (''teacher'', ''admin'', ''superadmin'')' in _src) = 0
     or position('(r.user_id = a.actor_user_id or r.user_id::text = a.details->>''student_id'')' in _src) = 0 then
    raise exception 'ABORT: teacherless_homework_health() does not exclude staff in every leg';
  end if;

  -- 3. alert_decision(): the vectors of 20260929191000 (same answers), then (a), (e) and the live seed.
  _st := jsonb_build_object('alerting', true, 'notified_keys', _ab, 'notified_stage', 1,
                            'last_alert_ms', _now - 3600000);
  for _case in
    select * from (values
      ('healthy, no state',              false, _ab, 0, null::jsonb,                                 'none'),
      ('healthy after an alarm',         false, _ab, 0, _st,                                         'recovered'),
      ('healthy, never alerted',         false, _ab, 0, jsonb_build_object('alerting', false),       'none'),
      ('first alarm, no state',          true,  _ab, 1, null::jsonb,                                 'alert'),
      ('same keys, same stage, 1h later',true,  _ab, 1, _st,                                         'none'),
      ('a key disappears (good news)',   true,  _a,  1, _st,                                         'none'),
      ('a new key appears',              true,  _ab || '["a:g2:no_teacher"]'::jsonb, 1, _st,         'alert'),
      ('stage escalates 1 -> 2',         true,  _ab, 2, _st,                                         'alert'),
      ('stage de-escalates 1 -> 0',      true,  _ab, 0, _st,                                         'none'),
      ('24h since the last alert',       true,  _ab, 1, _st || jsonb_build_object('last_alert_ms', _now - 86400000), 'alert'),
      ('23h since the last alert',       true,  _ab, 1, _st || jsonb_build_object('last_alert_ms', _now - 82800000), 'none'),
      ('future last_alert_ms clamped',   true,  _ab, 1, _st || jsonb_build_object('last_alert_ms', _now + 999999999), 'none'),
      ('malformed last_alert_ms',        true,  _ab, 1, _st || jsonb_build_object('last_alert_ms', 'x'), 'alert'),
      ('nothing delivered this episode', true,  _ab, 1, _st || jsonb_build_object('notified_keys', null), 'alert'),
      ('malformed notified_keys',        true,  _ab, 1, _st || jsonb_build_object('notified_keys', 'x'), 'alert'),
      ('events only, already notified',  true,  '[]'::jsonb, 0, _st,                                 'none'),
      ('events only, new episode',       true,  '[]'::jsonb, 0, _st - 'notified_keys',               'alert'),
      ('unreadable verdict (NULL)',      null,  null::jsonb, 0, _st,                                 'alert'),
      -- (a) the end of an episode whose alert was never attempted is silent
      ('healthy after an undelivered alarm',        false, _ab, 0, _st || jsonb_build_object('notified_keys', null), 'none'),
      ('healthy after an alarm, no notified_keys',  false, _ab, 0, _st - 'notified_keys',                        'none'),
      ('healthy after an alarm, malformed keys',    false, _ab, 0, _st || jsonb_build_object('notified_keys', 'x'),  'none'),
      ('healthy after an alarm, empty key set',     false, _ab, 0, _st || jsonb_build_object('notified_keys', '[]'::jsonb), 'recovered'),
      ('unreadable after nothing was delivered',    null,  null::jsonb, 0, _st || jsonb_build_object('notified_keys', null), 'alert'),
      -- (e) the 24th hourly run always qualifies, the 23rd never does
      ('24h minus 36 ms of cron jitter',  true, _ab, 1, _st || jsonb_build_object('last_alert_ms', _now - 86400000 + 36), 'alert'),
      ('24h minus 29 min',                true, _ab, 1, _st || jsonb_build_object('last_alert_ms', _now - 84660000), 'alert'),
      ('exactly 23.5h',                   true, _ab, 1, _st || jsonb_build_object('last_alert_ms', _now - 84600000), 'alert'),
      ('23.5h minus 1 ms',                true, _ab, 1, _st || jsonb_build_object('last_alert_ms', _now - 84599999), 'none'),
      ('23h plus 36 ms of jitter',        true, _ab, 1, _st || jsonb_build_object('last_alert_ms', _now - 82800036), 'none'),
      -- the live state row as seeded by 20260929191000
      ('live seed, healthy',              false, '[]'::jsonb, 0, _seed, 'none'),
      ('live seed, first alarm',          true,  _a, 0, _seed,          'alert'),
      ('live seed + disabled marker',     false, '[]'::jsonb, 0, _seed || '{"enabled": false, "last_action": "disabled"}'::jsonb, 'none')
    ) v(label, alarm, keys, stage, state, expected)
  loop
    if public.teacherless_homework_alert_decision(_case.alarm, _case.keys, _case.stage, _case.state, _now)
       is distinct from _case.expected then
      raise exception 'ABORT: alert_decision(%) = %, expected %', _case.label,
        public.teacherless_homework_alert_decision(_case.alarm, _case.keys, _case.stage, _case.state, _now),
        _case.expected;
    end if;
  end loop;

  -- 4. (b) alarm_row_due(): one row per failed key set + stage, every attempted DM, every recovery.
  _sig := jsonb_build_object('keys', _ab, 'stage', 1);
  for _case in
    select * from (values
      ('recovered writes its row',            'recovered', 0, _ab, 0, _st,                                          true),
      ('none writes nothing',                 'none',      0, _ab, 1, _st,                                          false),
      ('none writes nothing, even with DMs',  'none',      3, _ab, 1, _st,                                          false),
      ('unknown action writes nothing',       null,        0, _ab, 1, _st,                                          false),
      ('alert with a DM attempted',           'alert',     3, _ab, 1, _st || jsonb_build_object('undelivered', _sig), true),
      ('first failed alert',                  'alert',     0, _ab, 1, _st,                                          true),
      ('first failed alert, no state row',    'alert',     0, _ab, 1, null::jsonb,                                  true),
      ('failed alert, NULL dm count',         'alert',     null, _ab, 1, _st,                                       true),
      ('same failure the next hour',          'alert',     0, _ab, 1, _st || jsonb_build_object('undelivered', _sig), false),
      ('same failure, NULL dm count',         'alert',     null, _ab, 1, _st || jsonb_build_object('undelivered', _sig), false),
      ('failure with a new key',              'alert',     0, _ab || '["a:g2:no_teacher"]'::jsonb, 1, _st || jsonb_build_object('undelivered', _sig), true),
      ('failure after a key disappeared',     'alert',     0, _a,  1, _st || jsonb_build_object('undelivered', _sig), true),
      ('failure, stage escalates',            'alert',     0, _ab, 2, _st || jsonb_build_object('undelivered', _sig), true),
      ('failure after undelivered cleared',   'alert',     0, _ab, 1, _st || jsonb_build_object('undelivered', null), true),
      ('unreadable failure, repeated',        'alert',     0, '["unreadable"]'::jsonb, 0,
         _st || jsonb_build_object('undelivered', jsonb_build_object('keys', '["unreadable"]'::jsonb, 'stage', 0)),  false),
      ('live seed, first failed alert',       'alert',     0, _a, 0, _seed,                                         true)
    ) v(label, action, dm, keys, stage, state, expected)
  loop
    if public.teacherless_homework_alarm_row_due(_case.action, _case.dm, _case.keys, _case.stage, _case.state)
       is distinct from _case.expected then
      raise exception 'ABORT: alarm_row_due(%) = %, expected %', _case.label,
        public.teacherless_homework_alarm_row_due(_case.action, _case.dm, _case.keys, _case.stage, _case.state),
        _case.expected;
    end if;
  end loop;

  -- 5. (b)(d) the watchdog's stored body (static; the watchdog itself is never called here): the
  --    kill-switch returns before health() and before any send; the dedupe rule is wired in; the
  --    stored 'undelivered' pair is built exactly like the one alarm_row_due() compares with.
  select prosrc into _src from pg_proc where oid = 'public.teacherless_homework_watchdog()'::regprocedure;
  _at_health := position('_r := public.teacherless_homework_health();' in _src);
  if _at_health = 0
     or position('from public.platform_settings where key = ''teacherless_homework_watchdog''' in _src) = 0
     or position('from public.platform_settings where key = ''teacherless_homework_watchdog''' in _src) > _at_health
     or position('return jsonb_build_object(''disabled'', true' in _src) = 0
     or position('return jsonb_build_object(''disabled'', true' in _src) > _at_health
     or position('return jsonb_build_object(''disabled'', true' in _src) > position('perform public.ops_net_post(' in _src)
     or position('if public.teacherless_homework_alarm_row_due(_action, _dm, _keys, _stage, _state) then' in _src) = 0
     or position('then jsonb_build_object(''keys'', _keys, ''stage'', _stage) end;' in _src) = 0
     or position('''undelivered'', _undelivered,' in _src) = 0 then
    raise exception 'ABORT: teacherless_homework_watchdog() body is missing the kill-switch or the ALARM-row dedupe';
  end if;

  -- 6. The live state row under the new rules (pure calls on the real row and the real verdict).
  select value into _live from public.app_settings where key = 'teacherless_homework_watchdog_state';
  _d := public.teacherless_homework_alert_decision((_r->>'alarm')::boolean, _r->'keys',
          (_r->>'pending_stage')::int, _live, (extract(epoch from now()) * 1000)::bigint);
  if _d is null or _d not in ('alert', 'none', 'recovered')
     or (_d = 'recovered' and jsonb_typeof(_live->'notified_keys') is distinct from 'array')
     or (not (_r->>'alarm')::boolean and coalesce(_live->>'alerting', '') <> 'true' and _d <> 'none') then
    raise exception 'ABORT: alert_decision on the live state row = % (state %, verdict %)', _d, _live, _r;
  end if;

  -- 7. The kill-switch row exists (its value is the owner's to set).
  if not exists (select 1 from public.platform_settings where key = 'teacherless_homework_watchdog') then
    raise exception 'ABORT: platform_settings teacherless_homework_watchdog is missing';
  end if;

  -- Audit once, even if a racing deploy replays this file.
  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'teacherless_homework_watchdog_noise_fixed',
         jsonb_build_object('migration', '20260930083000',
                            'kill_switch', 'platform_settings teacherless_homework_watchdog {"enabled": false}',
                            'health_md5', (select md5(prosrc) from pg_proc
                                            where oid = 'public.teacherless_homework_health()'::regprocedure),
                            'decision_md5', (select md5(prosrc) from pg_proc
                                              where oid = 'public.teacherless_homework_alert_decision(boolean, jsonb, integer, jsonb, bigint)'::regprocedure),
                            'watchdog_md5', (select md5(prosrc) from pg_proc
                                              where oid = 'public.teacherless_homework_watchdog()'::regprocedure),
                            'alarm_at_deploy', _r->'alarm',
                            'decision_at_deploy', _d,
                            'at', now())
  where not exists (select 1 from public.admin_actions
                    where action = 'teacherless_homework_watchdog_noise_fixed');
end $$;
