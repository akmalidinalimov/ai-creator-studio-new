-- DETECTOR for the ☰ menu-button sweep + the pg_net Telegram classifier aligned with the edge one
-- (incident 2026-10-01, branch fix/telegram-recipient-class).
--
-- Slot: 20261001050010 re-issues 20261001050000 (committed on this branch, never merged or applied — the live
-- bodies carry no marker, menu_sweep_stuck_verdict does not exist, ops_applied_migrations has no row). A committed
-- migration file is never edited: that file is git rm'd and this one replaces it, with the review fix below (2:
-- the per-recipient exclusion).
--
-- ═══ WHY ═══
-- #237 (merged 2026-10-01 04:00 UTC) added the ☰ sweep: telegram-bot-webhook menu-sweep.ts walks every current
-- member and sets the Mini App menu button. Two minutes later it stopped on member 96 of 166 and never moved again:
-- Telegram answered setChatMenuButton with "Bad Request: user not found" (a member the bot cannot resolve), the
-- shared classifier did not list that per-USER description, menu-button.ts read "a non-recipient 400 on a web_app
-- button" as "Telegram refuses OUR Mini App button", and the sweep — by design — stops on a refusal, backs off 30
-- minutes and does not move past the member. Every 30 minutes it re-hit the same member: the pass could never
-- finish, the 6-hour re-pass never ran, ~70 members (66 students, 4 staff) never got the ☰ door, and a misleading
-- student 'miniapp_button_rejected' row (with student kill-switch advice) recurred daily.
-- The edge half of the fix is in the same branch (classifier, positive button match, one member can never freeze a
-- pass). THIS migration is the detector the incident lacked: nothing DB-side could see that the sweep was stuck.
--
-- ═══ WHAT ═══
-- 1. public.menu_sweep_stuck_verdict(progress jsonb, enabled boolean, at timestamptz) → jsonb. New, STABLE, reads
--    no table: a pure verdict over the progress row app_settings 'menu_button_sweep'. stuck =
--      stalled         not done and no progress for 2 h — coalesce(last_progress_at, pass_started_at) older than
--                      2 h (the sweep stamps last_progress_at whenever a tick moves the cursor forward; a row
--                      written before this branch has none, so the pass start counts — which is exactly what makes
--                      today's frozen row visible). Also covers "the minute tick stopped": no tick, no progress.
--      repeated_stop   not done and stop_repeats >= 2 — the same cursor stopped twice by a hard stop (a refusal of
--                      our button / a bot-wide 401-404). A GLOBAL refusal now rewinds and stops at the same
--                      cursor every backoff, so this fires within ~1 h instead of 2.
--      repass_overdue  done, and the 6-hour re-pass is 2 h overdue (finished_at older than 8 h): the sweep is dead.
--      unreadable      a row whose shape or times cannot be read is an alarm, never a quiet "false".
--    Not stuck: no row (the sweep has not run; it creates the row on its first tick), or the sweep switched off
--    (platform_settings 'menu_button_sweep' {"enabled": false} — mirrored exactly from parseSweepSettings: absent
--    row or anything but a literal false is ON).
-- 2. watch_button_health() (pinned rewrite): reads the row + the switch, adds 'menu_sweep' (the verdict) and
--    'menu_sweep_stuck' to its jsonb, ORs menu_sweep_stuck into 'alarm', and appends "⚠️ ☰ menyu sweep toʻxtab qoldi"
--    to its Mini App digest line while stuck. A verdict that raises is itself stuck ('verdict_error').
--    It ALSO stops counting a 'miniapp_button_rejected' row whose Telegram description is PER-RECIPIENT (the edge
--    isRecipientError list, verbatim) as a student button fault. Without this the incident's own row —
--    admin_actions 'miniapp_button_rejected' 2026-10-01 04:02:04 {fn: menu_button_sweep, error: "Bad Request: user
--    not found"}, the ONLY fault row in 3 days — keeps fallback_fault true for 24 h after the fix: the watchdog
--    (ALARM 04:25, alerting) would re-send the false student button-fault DM at 10:25, 16:25 and 22:25 and recover
--    only at 04:25 on 10-02, and every 6-hour cooldown would swallow the first DM of a REAL alarm from any leg. It
--    also closes the class for the senders a _shared-only change does not redeploy (they still run the old rule
--    "any non-recipient 400 on a web_app button = refusal"). A negative exclusion on purpose, not the positive
--    /button|web ?app/ match: an unknown 400 a sender filed here keeps alarming; only a description we KNOW is one
--    member's is dropped. Those rows stay visible as 'fault_rows_recipient_24h' (count), never in 'alarm'.
-- 3. watch_button_watchdog() (pinned rewrite): one DM paragraph for menu_sweep_stuck, with the kill-switch and the
--    rerun lever. Same cooldown (6 h), recovery DM and ALARM / recovered rows as today (they carry 'menu_sweep').
--    STAFF AND STUDENT REFUSALS STAY SEPARATED (#239): this leg is audience-neutral liveness; it reads no refusal
--    row, and 'teacher_miniapp_button_rejected' still never feeds the student fallback_fault leg.
-- 4. platform_settings.ops_http_watchdog.tg_expected_regex (the pg_net side's "expected Telegram non-delivery"
--    regex, read by ops_http_failure_sweep): the per-recipient descriptions the edge classifier lists and it did
--    not — user not found, user_id_invalid, invalid user_id, participant_id_invalid, member not found,
--    peer_id_invalid, user_is_blocked, chat_id is empty, have no rights, bots can't send — are appended, so the two
--    classifiers stop disagreeing. Compare-and-set against the value read on 2026-10-01; any other value is left
--    alone and says so ('ops_http_tg_regex_alignment_skipped'). 'forbidden' is deliberately NOT added: the edge
--    reads every 403 as recipient, but a 403 that is not a Telegram description must stay 'real' here.
--
-- ═══ PINNED REWRITES (the house pattern, as 20260930160000) ═══
-- Each function is edited FROM ITS LIVE pg_get_functiondef, only if md5(replace(prosrc, CR, '')) is the value read
-- read-only on 2026-10-01 (re-verified 05:16 UTC) — which is also the md5 of the body 20260930160000 installed (the
-- live text was never touched since):
--      watch_button_health()     aa4691666c7b903bf94472035a1d49c7   (pg_get_functiondef md5 ea0df155df7c9266571bafafb24d4cfe)
--      watch_button_watchdog()   4ceae804ac3f403b96e4e2986cbde199   (pg_get_functiondef md5 a7ecc5f31acaabe4a76e9a636521bece)
-- Anything else aborts with "regenerate". Every edit must match exactly once (verified: 6 / 1). After EXECUTE (body
-- validation on) the stored definition must equal the executed text; owner, ACL and SECURITY DEFINER must be
-- unchanged, and anon / authenticated still unable to execute. REPLAY-SAFE: the marker "(20261001050010)" in a
-- body means its rewrite is in place and is skipped; the static checks and the self-test run either way.
--
-- ═══ SELF-TEST (read-only: never sends, awards, needs a JWT, or mutates what it checks) ═══
-- * menu_sweep_stuck_verdict() on SYNTHETIC rows only, starting with the live frozen row verbatim (cursor
--   83d961a5…, 95/166, last_stop 'rejected', pass started 04:00:09 UTC): stuck at 06:01, not at 05:00; progress
--   inside the window clears it; the same cursor stopped twice is stuck; a finished pass is fine until its re-pass
--   is 2 h overdue; switched off / no row → not stuck; an unreadable row → stuck.
-- * watch_button_health() (STABLE, SELECTs only, no advisory lock, no auth.uid()) must return booleans for alarm and
--   menu_sweep_stuck and an object for menu_sweep. It asserts the SHAPE, not "false": a real stuck sweep at deploy
--   time must not fail the migration. watch_button_watchdog() is NEVER called here (it sends).
-- * the per-recipient exclusion: the stored regex is the one tested here; it must match the incident row's
--   description verbatim ("Bad Request: user not found") and its per-recipient siblings, and must NOT match a
--   refusal of our button / web app URL, our content, a bot-wide 401 or an empty error. Against the live rows
--   (read-only, the same now()): the health function's student 'miniapp_button_rejected' count must equal the 24 h
--   rows that are NOT per-recipient, and 'fault_rows_recipient_24h' the ones that are — so the 04:02 row, if still
--   inside 24 h at deploy, is shown to be out of the alarm without asserting "no alarm" (a real fault at deploy time
--   must not fail the migration).
-- * tg_expected_regex: whatever is stored afterwards must compile; when this migration set it, it must match each
--   per-recipient description and must NOT match a refusal of our button, our content, or a bot-wide 401.
--
-- ═══ KILL-SWITCHES ═══
--   the detector leg     select cron.unschedule('watch-button-watchdog');   (also mutes the other watch-button legs)
--   the sweep itself     platform_settings 'menu_button_sweep' {"enabled": false}   (the verdict then says 'disabled')
--   a fresh pass         platform_settings 'menu_button_sweep' {"rerun": "<anything new>"}
--   the regex            update platform_settings set value = jsonb_set(value, '{tg_expected_regex}', '"<old>"')
--                        where key = 'ops_http_watchdog';   (the old value is quoted in section 4 below)

-- ─────────────────────────── 1. the verdict ───────────────────────────
create or replace function public.menu_sweep_stuck_verdict(p_progress jsonb, p_enabled boolean, p_at timestamptz)
returns jsonb
language plpgsql
stable
set search_path to 'public'
as $function$
declare
  _ts constant text := '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?$';
  _done boolean;
  _started timestamptz;
  _last_progress timestamptz;
  _progress_at timestamptz;
  _finished timestamptz;
  _repeats int;
  _stalled boolean := false;
  _repeated boolean := false;
  _overdue boolean := false;
  _reason text;
begin
  if p_progress is null or jsonb_typeof(p_progress) = 'null' then
    return jsonb_build_object('present', false, 'enabled', coalesce(p_enabled, true), 'stuck', false,
                              'reason', 'no_progress_row');
  end if;
  if not coalesce(p_enabled, true) then
    return jsonb_build_object('present', true, 'enabled', false, 'stuck', false, 'reason', 'disabled');
  end if;
  if jsonb_typeof(p_progress) <> 'object' or coalesce(jsonb_typeof(p_progress->'done'), '') <> 'boolean' then
    return jsonb_build_object('present', true, 'enabled', true, 'stuck', true, 'reason', 'unreadable');
  end if;

  _done := (p_progress->>'done')::boolean;
  _started := case when coalesce(p_progress->>'pass_started_at', '') ~ _ts
                   then (p_progress->>'pass_started_at')::timestamptz end;
  _last_progress := case when coalesce(p_progress->>'last_progress_at', '') ~ _ts
                         then (p_progress->>'last_progress_at')::timestamptz end;
  _progress_at := greatest(_started, _last_progress);   -- greatest() ignores a NULL
  _finished := case when coalesce(p_progress->>'finished_at', '') ~ _ts
                    then (p_progress->>'finished_at')::timestamptz end;
  _repeats := case when coalesce(p_progress->>'stop_repeats', '') ~ '^[0-9]{1,6}$'
                   then (p_progress->>'stop_repeats')::int else 0 end;

  if not _done then
    if _progress_at is null then
      _stalled := true;
      _reason := 'unreadable_times';
    elsif _progress_at < p_at - interval '2 hours' then
      _stalled := true;
      _reason := 'no_progress_2h';
    end if;
    if _repeats >= 2 then
      _repeated := true;
      _reason := coalesce(_reason, 'same_cursor_stopped_' || _repeats || 'x');
    end if;
  else
    if _finished is null then
      _overdue := true;
      _reason := 'unreadable_times';
    elsif _finished < p_at - interval '8 hours' then   -- REPASS_MS (6 h) + 2 h
      _overdue := true;
      _reason := 'repass_overdue';
    end if;
  end if;

  return jsonb_build_object(
    'present', true,
    'enabled', true,
    'stuck', _stalled or _repeated or _overdue,
    'reason', coalesce(_reason, case when _done then 'done' else 'progressing' end),
    'stalled', _stalled,
    'repeated_stop', _repeated,
    'repass_overdue', _overdue,
    'done', _done,
    'processed', p_progress->'totals'->'processed',
    'targets', p_progress->'totals'->'targets',
    'skipped', p_progress->'totals'->'skipped',
    'last_stop', p_progress->'last_stop',
    'stop_repeats', _repeats,
    'last_tick_at', p_progress->'last_tick_at',
    'progress_at', _progress_at,
    'minutes_without_progress',
      case when not _done and _progress_at is not null
           then floor(extract(epoch from (p_at - _progress_at)) / 60)::int end,
    'suspect_role', p_progress->'suspect'->'role');
end;
$function$;

-- House pattern: PUBLIC first, then the roles. watch_button_health() is SECURITY INVOKER and service_role runs it.
revoke execute on function public.menu_sweep_stuck_verdict(jsonb, boolean, timestamptz) from public, anon, authenticated;
grant  execute on function public.menu_sweep_stuck_verdict(jsonb, boolean, timestamptz) to service_role;

-- ─────────────────────────── 2 + 3. pinned rewrites ───────────────────────────
do $mig$
declare
  _marker constant text := '(20261001050010)';
  _plan jsonb;
  _item jsonb;
  _edit jsonb;
  _fn regprocedure;
  _src text; _def text; _new text; _old text;
  _acl text; _owner oid; _secdef boolean;
  _n int;
begin
  -- The EXECUTE below must validate the edited body, whatever the session default is.
  perform set_config('check_function_bodies', 'on', true);

  _plan := jsonb_build_array(
    jsonb_build_object(
      'fn', 'public.watch_button_health()',
      'pin', 'aa4691666c7b903bf94472035a1d49c7',
      'edits', jsonb_build_array(
        jsonb_build_array(
$h1o$  _since timestamptz;
begin
$h1o$,
$h1n$  _since timestamptz;
  _sweep jsonb;
  _sweep_row jsonb;
  _sweep_enabled boolean;
  _sweep_stuck boolean;
  -- telegram-classify.ts isRecipientError, verbatim (20261001050010): one member's problem, never our button.
  _recipient_rx constant text := 'bot was blocked|chat not found|user is deactivated|can''t initiate|peer_id_invalid|user_is_blocked|have no rights|forbidden|chat_id is empty|bots can''t send|user not found|user_id_invalid|invalid user_id|participant_id_invalid|member not found|not enough rights|group chat was upgraded';
  _fault_rows_recipient bigint;
begin
$h1n$),
        jsonb_build_array(
$h6o$    where a.action in ('miniapp_button_fallback', 'miniapp_button_rejected')
      and a.created_at > now() - interval '24 hours'
    group by a.action
  ) f;
$h6o$,
$h6n$    where a.action in ('miniapp_button_fallback', 'miniapp_button_rejected')
      and a.created_at > now() - interval '24 hours'
      -- (20261001050010) A 'rejected' row whose Telegram description is PER-RECIPIENT is one member's problem, not a
      -- refusal of our button: the incident row ("Bad Request: user not found", menu_button_sweep, 2026-10-01 04:02)
      -- kept this leg — and its student kill-switch advice — alarming for 24 h after the fix, and the senders a
      -- _shared-only change does not redeploy still file every non-recipient 400 on a web_app button here. Such rows
      -- are counted in 'fault_rows_recipient_24h' instead. A row with no error, or any other error, still counts.
      and not (a.action = 'miniapp_button_rejected' and coalesce(a.details->>'error', '') ~* _recipient_rx)
    group by a.action
  ) f;
  select count(*) into _fault_rows_recipient
  from public.admin_actions a
  where a.action = 'miniapp_button_rejected'
    and a.created_at > now() - interval '24 hours'
    and coalesce(a.details->>'error', '') ~* _recipient_rx;
$h6n$),
        jsonb_build_array(
$h2o$  _fallback_fault := coalesce(_unexpected_24h, 0) > 0 or coalesce(_fault_rows_n, 0) > 0;
$h2o$,
$h2n$  -- ☰ menu-button sweep liveness (20261001050010). On 2026-10-01 the sweep (telegram-bot-webhook menu-sweep.ts)
  -- froze on ONE member and nothing noticed. Not done and no progress for 2 h, the same cursor stopped twice, or a
  -- re-pass 2 h overdue is an alarm (menu_sweep_stuck_verdict); a verdict that cannot be computed is one too.
  -- Audience-neutral liveness: student / staff refusal rows stay in their own legs (#239).
  select not coalesce(ps.value->'enabled' = 'false'::jsonb, false) into _sweep_enabled
    from public.platform_settings ps where ps.key = 'menu_button_sweep';
  select a.value into _sweep_row from public.app_settings a where a.key = 'menu_button_sweep';
  begin
    _sweep := public.menu_sweep_stuck_verdict(_sweep_row, coalesce(_sweep_enabled, true), now());
  exception when others then
    _sweep := jsonb_build_object('stuck', true, 'reason', 'verdict_error', 'error', left(sqlerrm, 200));
  end;
  _sweep_stuck := case when jsonb_typeof(_sweep->'stuck') = 'boolean' then (_sweep->>'stuck')::boolean else true end;

  _fallback_fault := coalesce(_unexpected_24h, 0) > 0 or coalesce(_fault_rows_n, 0) > 0;
$h2n$),
        jsonb_build_array(
$h3o$            || E'\n';

  return jsonb_build_object(
$h3o$,
$h3n$            || case when _sweep_stuck then ' · ⚠️ ☰ menyu sweep toʻxtab qoldi' else '' end
            || E'\n';

  return jsonb_build_object(
$h3n$),
        jsonb_build_array(
$h4o$    'alarm', _fallback_fault or _opens_missing or _tally_missing or _coverage_gap,
$h4o$,
$h4n$    'alarm', _fallback_fault or _opens_missing or _tally_missing or _coverage_gap or _sweep_stuck,
$h4n$),
        jsonb_build_array(
$h5o$    'coverage_gap', _coverage_gap,
$h5o$,
$h5n$    'coverage_gap', _coverage_gap,
    'menu_sweep_stuck', _sweep_stuck,
    'menu_sweep', _sweep,
    'fault_rows_recipient_24h', coalesce(_fault_rows_recipient, 0),
$h5n$))),
    jsonb_build_object(
      'fn', 'public.watch_button_watchdog()',
      'pin', '4ceae804ac3f403b96e4e2986cbde199',
      'edits', jsonb_build_array(
        jsonb_build_array(
$w1o$        if _r ? 'health_error' then
$w1o$,
$w1n$        if coalesce(_r->>'menu_sweep_stuck', '') = 'true' then
          -- ☰ menu-button sweep stuck or dead (20261001050010): the Mini App door stops reaching members.
          _msg := _msg || '🚨 ☰ Mini App menyu tugmasi (sweep) toʻxtab qoldi: '
               || coalesce(_r->'menu_sweep'->>'processed', '?') || '/' || coalesce(_r->'menu_sweep'->>'targets', '?')
               || ' aʼzo, sabab: ' || coalesce(_r->'menu_sweep'->>'reason', '?')
               || coalesce(' (oxirgi toʻxtash: ' || (_r->'menu_sweep'->>'last_stop') || ')', '')
               || '. admin_actions: menu_button_sweep_failed / menu_button_sweep_member_skipped. '
               || 'Oʻchirish: platform_settings menu_button_sweep {"enabled": false}; '
               || 'yangi pass: {"rerun": "<yangi qiymat>"}.' || E'\n';
        end if;
        if _r ? 'health_error' then
$w1n$))));

  for _item in select * from jsonb_array_elements(_plan) loop
    _fn := to_regprocedure(_item->>'fn');
    if _fn is null then
      raise exception 'ABORT: % does not exist', _item->>'fn';
    end if;
    select prosrc, coalesce(array_to_string(proacl, ','), ''), proowner, prosecdef
      into _src, _acl, _owner, _secdef
      from pg_proc where oid = _fn;

    if position(_marker in _src) > 0 then
      raise notice '% already carries the menu-sweep leg -- rewrite skipped', _item->>'fn';
      continue;
    end if;
    if md5(replace(_src, E'\r', '')) <> _item->>'pin' then
      raise exception 'ABORT: % changed since it was verified on 2026-10-01 (md5 %); re-read the live definition and regenerate this migration',
        _item->>'fn', md5(replace(_src, E'\r', ''));
    end if;

    _def := pg_get_functiondef(_fn);
    _new := _def;
    _n := 0;
    for _edit in select * from jsonb_array_elements(_item->'edits') loop
      _n := _n + 1;
      _old := replace(_edit->>0, E'\r', '');   -- a Windows checkout of this file is CRLF; the live text is LF
      if (length(_new) - length(replace(_new, _old, ''))) / length(_old) <> 1 then
        raise exception 'ABORT: % edit % matched % times (want exactly 1); regenerate this migration',
          _item->>'fn', _n, (length(_new) - length(replace(_new, _old, ''))) / length(_old);
      end if;
      _new := replace(_new, _old, replace(_edit->>1, E'\r', ''));
    end loop;

    execute _new;

    -- Post-conditions, from the catalog only.
    if pg_get_functiondef(_fn) is distinct from _new then
      raise exception 'ABORT: % -- the stored definition differs from the one executed', _item->>'fn';
    end if;
    if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
       or (select proowner from pg_proc where oid = _fn) <> _owner
       or (select prosecdef from pg_proc where oid = _fn) <> _secdef then
      raise exception 'ABORT: % -- owner, ACL or SECURITY DEFINER changed', _item->>'fn';
    end if;
    if has_function_privilege('anon', _fn, 'EXECUTE') or has_function_privilege('authenticated', _fn, 'EXECUTE') then
      raise exception 'ABORT: % became executable by anon or authenticated', _item->>'fn';
    end if;
  end loop;

  -- Static checks of what now runs (replay included).
  select prosrc into _src from pg_proc where oid = 'public.watch_button_health()'::regprocedure;
  if position(_marker in _src) = 0
     or position('_sweep := public.menu_sweep_stuck_verdict(_sweep_row, coalesce(_sweep_enabled, true), now());' in _src) = 0
     or position('_coverage_gap or _sweep_stuck,' in _src) = 0
     or position('''menu_sweep'', _sweep,' in _src) = 0
     or position('and not (a.action = ''miniapp_button_rejected'' and coalesce(a.details->>''error'', '''') ~* _recipient_rx)' in _src) = 0
     or position('''fault_rows_recipient_24h'', coalesce(_fault_rows_recipient, 0),' in _src) = 0 then
    raise exception 'ABORT: watch_button_health -- the menu-sweep leg / the per-recipient exclusion is not in the stored body';
  end if;
  select prosrc into _src from pg_proc where oid = 'public.watch_button_watchdog()'::regprocedure;
  if position(_marker in _src) = 0 or position('if coalesce(_r->>''menu_sweep_stuck'', '''') = ''true'' then' in _src) = 0 then
    raise exception 'ABORT: watch_button_watchdog -- the menu-sweep paragraph is not in the stored body';
  end if;
end $mig$;

-- ─────────────────────────── 4. the pg_net classifier, aligned ───────────────────────────
do $rx$
declare
  -- platform_settings.ops_http_watchdog.tg_expected_regex, read-only 2026-10-01 04:2x UTC (re-verified 05:16 UTC).
  _old constant text := 'bot was blocked|can''t initiate|chat not found|user is deactivated|bot was kicked|not enough rights|group chat was upgraded|bot was blocked by the user';
  _add constant text := '|user not found|user_id_invalid|invalid user_id|participant_id_invalid|member not found|peer_id_invalid|user_is_blocked|chat_id is empty|have no rights|bots can''t send';
  _cur text;
  _n int;
  _probe text;
begin
  select value->>'tg_expected_regex' into _cur from public.platform_settings where key = 'ops_http_watchdog';
  if _cur is null then
    raise notice 'ops_http_watchdog.tg_expected_regex is absent -- alignment skipped';
  elsif _cur = _old || _add then
    raise notice 'tg_expected_regex already aligned -- skipped';
  elsif _cur <> _old then
    raise notice 'tg_expected_regex differs from the value verified on 2026-10-01 -- left alone';
    insert into public.admin_actions (actor_user_id, action, details)
    select null, 'ops_http_tg_regex_alignment_skipped',
           jsonb_build_object('migration', '20261001050010', 'current', _cur, 'expected_old', _old, 'would_add', _add)
    where not exists (select 1 from public.admin_actions where action = 'ops_http_tg_regex_alignment_skipped');
  else
    -- One key, compare-and-set: ops_http_failure_sweep() rewrites other keys of this same row (watermark,
    -- alert_state) every few minutes, and jsonb_set leaves them as they are.
    update public.platform_settings
       set value = jsonb_set(value, '{tg_expected_regex}', to_jsonb(_old || _add))
     where key = 'ops_http_watchdog' and value->>'tg_expected_regex' = _old;
    get diagnostics _n = row_count;
    if _n <> 1 then
      raise exception 'ABORT: tg_expected_regex compare-and-set touched % rows (want 1)', _n;
    end if;
  end if;

  -- Self-test on literals only (read-only).
  select value->>'tg_expected_regex' into _cur from public.platform_settings where key = 'ops_http_watchdog';
  if _cur is not null then
    perform 'x' ~* _cur;   -- the stored regex compiles
  end if;
  if _cur = _old || _add then
    foreach _probe in array array[
      '{"ok":false,"error_code":400,"description":"Bad Request: user not found"}',
      '{"ok":false,"error_code":400,"description":"Bad Request: USER_ID_INVALID"}',
      '{"ok":false,"error_code":400,"description":"Bad Request: invalid user_id specified"}',
      '{"ok":false,"error_code":400,"description":"Bad Request: PARTICIPANT_ID_INVALID"}',
      '{"ok":false,"error_code":400,"description":"Bad Request: member not found"}',
      '{"ok":false,"error_code":400,"description":"Bad Request: PEER_ID_INVALID"}',
      '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}',
      '{"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}'
    ] loop
      if not (_probe ~* _cur) then
        raise exception 'ABORT: tg_expected_regex self-test -- a per-recipient answer is not expected: %', _probe;
      end if;
    end loop;
    foreach _probe in array array[
      '{"ok":false,"error_code":400,"description":"Bad Request: BUTTON_URL_INVALID"}',
      '{"ok":false,"error_code":400,"description":"Bad Request: inline keyboard button Web App URL ''x'' is invalid"}',
      '{"ok":false,"error_code":400,"description":"Bad Request: text must be encoded in UTF-8"}',
      '{"ok":false,"error_code":400,"description":"Bad Request: can''t parse entities"}',
      '{"ok":false,"error_code":401,"description":"Unauthorized"}'
    ] loop
      if _probe ~* _cur then
        raise exception 'ABORT: tg_expected_regex self-test -- a real failure would be hidden as expected: %', _probe;
      end if;
    end loop;
  end if;
end $rx$;

-- ─────────────────────────── self-test (read-only) ───────────────────────────
do $st$
declare
  -- app_settings 'menu_button_sweep', LIVE, 2026-10-01 04:22 UTC: frozen on member 96 of 166.
  _live constant jsonb := '{"rev": 6, "done": false, "ticks": 3, "cursor": "83d961a5-34a3-4f2d-9bb6-c7734ded29f3",
    "totals": {"ok": 92, "staff": 9, "failed": 0, "targets": 166, "rejected": 1, "students": 157, "processed": 95,
               "commands_ok": 4, "unreachable": 3, "commands_failed": 0, "global_commands_ok": 3, "global_commands_failed": 0},
    "version": 1, "pass_key": "v1|c1|s1|t1|https://aicreator.academy|", "last_stop": "rejected", "finished_at": null,
    "lease_until": null, "retry_after": "2026-10-01T04:32:05.001Z", "last_tick_at": "2026-10-01T04:02:02.189Z",
    "pass_started_at": "2026-10-01T04:00:09.620Z", "global_commands_sent": true}';
  -- The per-recipient regex watch_button_health() must now carry (telegram-classify.ts isRecipientError, verbatim).
  _rx constant text := $q$bot was blocked|chat not found|user is deactivated|can't initiate|peer_id_invalid|user_is_blocked|have no rights|forbidden|chat_id is empty|bots can't send|user not found|user_id_invalid|invalid user_id|participant_id_invalid|member not found|not enough rights|group chat was upgraded$q$;
  _src text;
  _probe text;
  _fault_n bigint;
  _recip_n bigint;
  _v jsonb;
  _r jsonb;
  _case text;
begin
  _case := 'the live frozen row, 2 h after its pass started';
  _v := public.menu_sweep_stuck_verdict(_live, true, '2026-10-01 06:01:00+00');
  if _v->>'stuck' is distinct from 'true' or _v->>'reason' is distinct from 'no_progress_2h' or _v->>'processed' is distinct from '95' then
    raise exception 'ABORT: self-test (%) -- %', _case, _v;
  end if;

  _case := 'the live row inside the 2 h window';
  _v := public.menu_sweep_stuck_verdict(_live, true, '2026-10-01 05:00:00+00');
  if _v->>'stuck' is distinct from 'false' or _v->>'reason' is distinct from 'progressing' then
    raise exception 'ABORT: self-test (%) -- %', _case, _v;
  end if;

  _case := 'progress 30 min ago clears a pass that started long ago';
  _v := public.menu_sweep_stuck_verdict(_live || '{"last_progress_at": "2026-10-01T05:31:00Z"}', true, '2026-10-01 06:01:00+00');
  if _v->>'stuck' is distinct from 'false' then
    raise exception 'ABORT: self-test (%) -- %', _case, _v;
  end if;

  _case := 'the same cursor stopped twice';
  _v := public.menu_sweep_stuck_verdict(_live || '{"stop_repeats": 2, "stop_cursor": "83d961a5-34a3-4f2d-9bb6-c7734ded29f3"}',
                                        true, '2026-10-01 04:40:00+00');
  if _v->>'stuck' is distinct from 'true' or _v->>'repeated_stop' is distinct from 'true' or _v->>'reason' is distinct from 'same_cursor_stopped_2x' then
    raise exception 'ABORT: self-test (%) -- %', _case, _v;
  end if;

  _case := 'a finished pass, re-pass not yet due';
  _v := public.menu_sweep_stuck_verdict(_live || '{"done": true, "finished_at": "2026-10-01T04:40:00Z"}', true, '2026-10-01 12:00:00+00');
  if _v->>'stuck' is distinct from 'false' or _v->>'reason' is distinct from 'done' then
    raise exception 'ABORT: self-test (%) -- %', _case, _v;
  end if;

  _case := 'a finished pass whose re-pass is 2 h overdue (the sweep is dead)';
  _v := public.menu_sweep_stuck_verdict(_live || '{"done": true, "finished_at": "2026-10-01T04:40:00Z"}', true, '2026-10-01 12:41:00+00');
  if _v->>'stuck' is distinct from 'true' or _v->>'reason' is distinct from 'repass_overdue' then
    raise exception 'ABORT: self-test (%) -- %', _case, _v;
  end if;

  _case := 'the sweep switched off';
  _v := public.menu_sweep_stuck_verdict(_live, false, '2026-10-02 00:00:00+00');
  if _v->>'stuck' is distinct from 'false' or _v->>'reason' is distinct from 'disabled' then
    raise exception 'ABORT: self-test (%) -- %', _case, _v;
  end if;

  _case := 'no progress row yet';
  _v := public.menu_sweep_stuck_verdict(null, true, '2026-10-02 00:00:00+00');
  if _v->>'stuck' is distinct from 'false' or _v->>'present' is distinct from 'false' then
    raise exception 'ABORT: self-test (%) -- %', _case, _v;
  end if;

  _case := 'an unreadable row';
  _v := public.menu_sweep_stuck_verdict('"garbage"'::jsonb, true, '2026-10-02 00:00:00+00');
  if _v->>'stuck' is distinct from 'true' or _v->>'reason' is distinct from 'unreadable' then
    raise exception 'ABORT: self-test (%) -- %', _case, _v;
  end if;
  _v := public.menu_sweep_stuck_verdict(_live - 'pass_started_at', true, '2026-10-01 04:10:00+00');
  if _v->>'stuck' is distinct from 'true' or _v->>'reason' is distinct from 'unreadable_times' then
    raise exception 'ABORT: self-test (a pass with no readable times) -- %', _v;
  end if;

  -- The per-recipient exclusion: the stored body carries exactly the regex tested here.
  select prosrc into _src from pg_proc where oid = 'public.watch_button_health()'::regprocedure;
  if position('_recipient_rx constant text := ' || quote_literal(_rx) || ';' in _src) = 0 then
    raise exception 'ABORT: self-test -- watch_button_health() does not carry the per-recipient regex verbatim';
  end if;
  -- ...it drops one member's problem (the incident row's description first, verbatim)...
  foreach _probe in array array[
    'Bad Request: user not found',
    'Bad Request: USER_ID_INVALID',
    'Bad Request: invalid user_id specified',
    'Bad Request: PARTICIPANT_ID_INVALID',
    'Bad Request: member not found',
    'Bad Request: PEER_ID_INVALID',
    'Bad Request: chat not found',
    'Forbidden: bot was blocked by the user',
    'Forbidden: bot can''t initiate conversation with a user',
    'Forbidden: user is deactivated',
    'Bad Request: not enough rights to send text messages to the chat',
    'Bad Request: group chat was upgraded to a supergroup chat'
  ] loop
    if not (_probe ~* _rx) then
      raise exception 'ABORT: self-test -- a per-recipient description would still raise the student button alarm: %', _probe;
    end if;
  end loop;
  -- ...and never hides a refusal of OUR button / URL, our content, the bot itself, or a row with no description.
  foreach _probe in array array[
    'Bad Request: BUTTON_TYPE_INVALID',
    'Bad Request: BUTTON_URL_INVALID',
    'Bad Request: WEBAPP_URL_INVALID',
    'Bad Request: inline keyboard button Web App URL ''http://x'' is invalid: Only HTTPS links are allowed',
    'Bad Request: text must be encoded in UTF-8',
    'Bad Request: can''t parse entities: Unsupported start tag',
    'Bad Request: message is too long',
    'Unauthorized',
    'Not Found',
    'http_400',
    ''
  ] loop
    if _probe ~* _rx then
      raise exception 'ABORT: self-test -- a real button / content / bot fault would be dropped as per-recipient: %', _probe;
    end if;
  end loop;

  -- The rewritten health function, for real (STABLE, SELECTs only): the SHAPE, not a verdict — a sweep that is
  -- genuinely stuck at deploy time must not fail the migration.
  _r := public.watch_button_health();
  if _r is null
     or coalesce(jsonb_typeof(_r->'alarm'), '') is distinct from 'boolean'
     or coalesce(jsonb_typeof(_r->'menu_sweep_stuck'), '') is distinct from 'boolean'
     or coalesce(jsonb_typeof(_r->'menu_sweep'), '') is distinct from 'object'
     or coalesce(jsonb_typeof(_r->'menu_sweep'->'stuck'), '') is distinct from 'boolean'
     or coalesce(jsonb_typeof(_r->'fault_rows_recipient_24h'), '') is distinct from 'number' then
    raise exception 'ABORT: self-test -- watch_button_health() has no menu-sweep verdict / recipient count: %', coalesce(_r::text, 'NULL');
  end if;
  if (_r->>'menu_sweep_stuck') = 'true' and (_r->>'alarm') is distinct from 'true' then
    raise exception 'ABORT: self-test -- a stuck sweep does not raise watch_button_health().alarm: %', _r;
  end if;

  -- Against the live rows (same transaction, same now()): only the non-per-recipient 'miniapp_button_rejected' rows
  -- feed the student fault leg; the per-recipient ones are counted apart. The 04:02 incident row is the latter.
  select count(*) filter (where not (coalesce(a.details->>'error', '') ~* _rx)),
         count(*) filter (where coalesce(a.details->>'error', '') ~* _rx)
    into _fault_n, _recip_n
  from public.admin_actions a
  where a.action = 'miniapp_button_rejected' and a.created_at > now() - interval '24 hours';
  if coalesce((_r->'fault_rows_24h'->>'miniapp_button_rejected')::bigint, 0) <> _fault_n
     or (_r->>'fault_rows_recipient_24h')::bigint <> _recip_n then
    raise exception 'ABORT: self-test -- the student fault leg does not match the rows (want % fault / % per-recipient): %',
      _fault_n, _recip_n, _r;
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'menu_sweep_liveness_installed',
         jsonb_build_object('migration', '20261001050010',
                            'why', 'the ☰ sweep froze on one member on 2026-10-01 and nothing DB-side could see it',
                            'verdict_at_deploy', _r->'menu_sweep',
                            'fallback_fault_at_deploy', _r->'fallback_fault',
                            'fault_rows_recipient_at_deploy', _recip_n,
                            'at', now())
  where not exists (select 1 from public.admin_actions where action = 'menu_sweep_liveness_installed');
end $st$;
