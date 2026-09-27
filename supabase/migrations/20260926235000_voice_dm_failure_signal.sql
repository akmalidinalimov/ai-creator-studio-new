-- DETECTOR: teacher voice feedback that does not reach a reachable student is now counted and alarmed.
--
-- WHY (read-only evidence from production, 2026-09-27).
--   Teacher voice feedback reaches students on three paths, and every one of them already writes a row
--   to admin_actions when a delivery fails:
--     * telegram-bot-webhook, in-bot grading (grade_comment step)  -> 'grade_voice_delivery_failed'
--     * telegram-bot-webhook, Mini App voice bridge (#162)          -> 'grade_voice_delivery_failed'
--     * notify-grade-voice, voice recorded inside the app (#100)    -> 'grade_voice_dm_failed'
--   But NOTHING reads those rows: not grade_delivery_watchdog, not grade_delivery_watchdog_fast, not
--   hw_dm_health_stats (so not the GitHub verifier either). A voice path that broke completely would
--   keep writing rows that no one ever sees.
--   Volume: 192 voice notes ever, all through the bot (score_feedback_voice_file_id); 4 in the 30 days
--   to 2026-09-27, ~10 a day at the July peak. In-app recordings (score_feedback_voice_path): 0 ever.
--   Failures recorded: 2, both 2026-08-18, both to students who had a telegram_id.
--   The rows could not be counted honestly until now: the webhook's sendVoice() returned a bare
--   boolean and threw Telegram's reason away, so a student who blocked the bot (EXPECTED, most students
--   never press Start) looked exactly like a broken voice path. The same PR changes sendVoice() to
--   return the classified outcome and record error + recipient_error on both webhook rows, which is the
--   contract grade_card_dm_failed and notify-grade-voice already follow.
--
-- WHAT.
--   1. hw_dm_health_stats() gains 'voice_dm_failed_24h': non-recipient voice failures in 24h. Reported,
--      NOT asserted: .github/workflows/hw-dm-health.yml only logs the JSON for fields it does not know,
--      so this cannot fail the verifier. (Agent PRs may not touch .github; asserting on it is an owner
--      decision once there is a baseline.) The ops agent reads this endpoint too.
--   2. grade_delivery_watchdog_fast() (hourly at :37, 2h window) gains a voice leg: more than 3
--      non-recipient voice failures in 2h breaches, with the same 3h cooldown, DM and state row as the
--      other legs. The alert text gains one line; the audit row, state row and return value gain
--      'voice_fail'. The most voice failures ever seen in any 2h window is 2, so it would never have
--      fired on history.
--   Both count the two action names together, EXCLUDE recipient-class rows (recipient_error = true), and
--   COUNT rows that carry no classification, so an unknown failure is never hidden. Neither casts the
--   jsonb value, so a malformed row is counted instead of aborting the health endpoint or the watchdog.
--   The two rows from 2026-08-18 are unclassified but far outside both windows.
--
-- HOW. Both functions are rewritten FROM THEIR LIVE DEFINITIONS (never a hand-copied body: the database
-- drifts from the repo), and only if each is byte-for-byte the definition verified on 2026-09-27 (md5
-- pinned below). Each edit is an exact replace() whose anchor must occur exactly once; the rewritten
-- text must hash to the md5 of the text that was dry-run; after EXECUTE the stored definition must equal
-- the executed text, and owner, ACL and SECURITY DEFINER must be unchanged. Anything else aborts, and
-- the whole block rolls back.
-- DRY-RUN, read-only against production on 2026-09-27, generated from this file: every one of the 10
-- anchors found exactly once; both rewritten bodies compiled by Postgres as DO blocks that RETURN before
-- running anything (a deliberate syntax error in the same harness IS caught, so the check is real); the
-- rewritten texts hash to the two _new_md5 values below; the two new count queries return 0 (24h) and
-- 0 (2h) today.
--
-- SELF-TEST. hw_dm_health_stats() is STABLE and read-only and needs no JWT, so it is called once to
-- prove the new key comes back as a number. grade_delivery_watchdog_fast() is NOT called: it writes its
-- state row and can DM admins, so it is checked from the catalog only.
--
-- IDEMPOTENT + REPLAY-SAFE: a function whose definition already hashes to the post-rewrite md5 is
-- skipped; any other unexpected definition aborts with a message to regenerate. The audit row is guarded
-- by NOT EXISTS.

do $mig$
declare
  -- hw_dm_health_stats(): three edits.
  _h_old text[] := array[
$a$  _telegram_send_broken_24h int;
begin$a$,
$a$  return jsonb_build_object(
    'unsent_overdue', _unsent_overdue,$a$,
$a$    'telegram_send_broken_24h', _telegram_send_broken_24h,
    'checked_at', now()$a$
  ];
  _h_new text[] := array[
$a$  _telegram_send_broken_24h int;
  _voice_dm_failed_24h int;
begin$a$,
$a$  -- Teacher VOICE feedback that did not reach a student who CAN be reached (20260926235000). Both
  -- voice senders write their own row: telegram-bot-webhook (bot grading and the Mini App voice
  -- bridge) -> grade_voice_delivery_failed; notify-grade-voice (in-app recording) ->
  -- grade_voice_dm_failed. Recipient-class misses (blocked the bot, never pressed Start, voice
  -- messages restricted) are EXPECTED reach and excluded. A row with no classification is counted,
  -- so an unknown failure is never hidden. No boolean cast: a malformed value is counted instead of
  -- failing the whole endpoint. Baseline 0 (2 failures ever, both 2026-08-18, of 192 voice notes).
  -- Reported only: the GitHub verifier logs this field but does not assert on it.
  select count(*) into _voice_dm_failed_24h from admin_actions
   where action in ('grade_voice_delivery_failed', 'grade_voice_dm_failed')
     and (details->>'recipient_error') is distinct from 'true'
     and created_at > now() - interval '24 hours';

  return jsonb_build_object(
    'unsent_overdue', _unsent_overdue,$a$,
$a$    'telegram_send_broken_24h', _telegram_send_broken_24h,
    'voice_dm_failed_24h', _voice_dm_failed_24h,
    'checked_at', now()$a$
  ];

  -- grade_delivery_watchdog_fast(): seven edits.
  _f_old text[] := array[
$a$_tg_fail int;$a$,
$a$  _cooldown_ms bigint := 10800000;$a$,
$a$  _breached := (_grade_fail > _t_grade or _media_unavail > _t_media or _tg_fail > _t_tg);$a$,
$a$_tg_fail || E'\n' ||$a$,
$a$'tg_fail', _tg_fail,
        'window', '2h'$a$,
$a$'tg_fail', _tg_fail, 'checked_at', now()))$a$,
$a$'tg_fail', _tg_fail,
    'breached', _breached$a$
  ];
  _f_new text[] := array[
$a$_tg_fail int; _voice_fail int;$a$,
$a$  _t_voice int := 3;    -- acute burst floor: non-recipient teacher VOICE-feedback DM failures in 2h
                        -- (20260926235000). Baseline 0 and volume is small (~10 voice notes a day at
                        -- the July peak), so 4+ in 2h means a grading session's voice notes are not
                        -- reaching students who can be reached.
  _cooldown_ms bigint := 10800000;$a$,
$a$  -- Teacher voice feedback (20260926235000): bot grading and the Mini App voice bridge write
  -- grade_voice_delivery_failed, in-app recording writes grade_voice_dm_failed. Recipient-class misses
  -- are expected reach and excluded; an unclassified row counts. No cast, so a malformed value cannot
  -- abort the run.
  select count(*) into _voice_fail from public.admin_actions
   where action in ('grade_voice_delivery_failed', 'grade_voice_dm_failed')
     and (details->>'recipient_error') is distinct from 'true'
     and created_at > now() - _win;

  _breached := (_grade_fail > _t_grade or _media_unavail > _t_media or _tg_fail > _t_tg
                or _voice_fail > _t_voice);$a$,
$a$_tg_fail || E'\n' ||
             '• Ovozli izoh talabaga yetmadi: ' || _voice_fail || E'\n' ||$a$,
$a$'tg_fail', _tg_fail, 'voice_fail', _voice_fail,
        'window', '2h'$a$,
$a$'tg_fail', _tg_fail, 'voice_fail', _voice_fail, 'checked_at', now()))$a$,
$a$'tg_fail', _tg_fail, 'voice_fail', _voice_fail,
    'breached', _breached$a$
  ];

  _k int; _i int;
  _name text; _fn regprocedure; _old_md5 text; _new_md5 text; _olds text[]; _news text[];
  _def text; _new text; _o text; _n text;
  _acl text; _owner oid; _secdef boolean;
  _stats jsonb;
begin
  perform set_config('check_function_bodies', 'on', true);

  for _k in 1..2 loop
    if _k = 1 then
      _name := 'hw_dm_health_stats';
      _fn := to_regprocedure('public.hw_dm_health_stats()');
      _old_md5 := '17a61232e5b985b0e4d9fb64b694d48c';   -- live, verified 2026-09-27
      _new_md5 := '5964793a61b404e39a1cad7cfd1d24cd';   -- the dry-run's rewritten text
      _olds := _h_old; _news := _h_new;
    else
      _name := 'grade_delivery_watchdog_fast';
      _fn := to_regprocedure('public.grade_delivery_watchdog_fast()');
      _old_md5 := 'cd7836bd38fec4357bff20ed86aaa557';   -- live, verified 2026-09-27
      _new_md5 := '2328af6d2a4ce8dc27b135ea6df9366d';   -- the dry-run's rewritten text
      _olds := _f_old; _news := _f_new;
    end if;

    if _fn is null then
      raise exception 'ABORT: public.%() does not exist', _name;
    end if;

    select pg_get_functiondef(p.oid), coalesce(array_to_string(p.proacl, ','), ''), p.proowner, p.prosecdef
      into _def, _acl, _owner, _secdef
    from pg_proc p where p.oid = _fn;

    if md5(_def) = _new_md5 then
      continue;                                          -- already applied
    end if;
    if md5(_def) <> _old_md5 then
      raise exception 'ABORT: public.%() changed since it was verified (md5 %); re-read the live definition and regenerate this migration', _name, md5(_def);
    end if;

    _new := _def;
    for _i in 1..array_length(_olds, 1) loop
      -- A Windows checkout may turn the file's line breaks into CRLF; the catalog text has LF only.
      _o := replace(_olds[_i], chr(13), '');
      _n := replace(_news[_i], chr(13), '');
      if (length(_new) - length(replace(_new, _o, ''))) / length(_o) <> 1 then
        raise exception 'ABORT: %() edit %: its anchor does not occur exactly once; regenerate this migration', _name, _i;
      end if;
      _new := replace(_new, _o, _n);
    end loop;

    if md5(_new) <> _new_md5 then
      raise exception 'ABORT: the rewritten %() is not the text that was dry-run (md5 %); regenerate this migration', _name, md5(_new);
    end if;

    execute _new;

    -- Post-conditions, from the catalog only.
    if pg_get_functiondef(_fn) is distinct from _new then
      raise exception 'ABORT: the stored definition of %() differs from the one executed', _name;
    end if;
    if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
       or (select proowner from pg_proc where oid = _fn) <> _owner
       or (select prosecdef from pg_proc where oid = _fn) <> _secdef then
      raise exception 'ABORT: owner, ACL or SECURITY DEFINER of %() changed', _name;
    end if;
    if has_function_privilege('anon', _fn, 'EXECUTE') or has_function_privilege('authenticated', _fn, 'EXECUTE') then
      raise exception 'ABORT: %() became executable by anon or authenticated', _name;
    end if;
  end loop;

  -- Self-test: read-only (STABLE, SELECT-only, no JWT, no advisory lock). The watchdog is NOT called.
  _stats := public.hw_dm_health_stats();
  if jsonb_typeof(_stats -> 'voice_dm_failed_24h') is distinct from 'number' then
    raise exception 'ABORT: hw_dm_health_stats() does not return voice_dm_failed_24h as a number: %', _stats -> 'voice_dm_failed_24h';
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'voice_dm_failure_signal_added',
         jsonb_build_object('health_field', 'voice_dm_failed_24h',
                            'fast_watchdog_leg', 'voice_fail > 3 in 2h',
                            'counts', 'grade_voice_delivery_failed + grade_voice_dm_failed, recipient_error <> true',
                            'at', now())
  where not exists (select 1 from public.admin_actions where action = 'voice_dm_failure_signal_added');
end $mig$;
