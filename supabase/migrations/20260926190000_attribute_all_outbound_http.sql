-- OBSERVABILITY: every outbound HTTP call from SQL now goes through public.ops_net_post(), so a
-- failure names its caller instead of arriving as "unattributed".
--
-- SUPERSEDES 20260926170000 and 20260926180000 (same intent; neither was merged or applied). Two rounds
-- of adversarial review reproduced FALSE PASSES in their proofs — none on today's live data, but each
-- a case where the proof passed while the property it claimed was false:
--   * 170000 cut each call at the first ';', which a '&amp;' inside a body literal defeats, and counted
--     argument names per body rather than per call.
--   * 180000 found each call's real closing ')' but then counted url/body/headers ANYWHERE inside it —
--     so a `headers :=` in a comment, a string or a nested call satisfied the "every call passes
--     headers" proof for a call that had none. It also read E'x'<newline>'y\'' (a string Postgres glues
--     across the line break, keeping E mode) as two plain strings, and ended a -- comment only at LF.
-- This version counts only real code at the call's own level, refuses what it does not model, and
-- asks Postgres's own parser to confirm every argument list it found.
--
-- WHY. The twelve-week stale-project incident fixed in 20260926161000 was not silent — it was
-- UNTRACEABLE. ops_http_failure_watchdog fired 159 times ("403 × N unattributed"), DMing admins each
-- time, but a raw net.http_post records no URL, so no alert could say where the requests were going.
-- Measured on 2026-09-26, the same blindness is still the dominant signal: ~790 UNATTRIBUTED timeouts
-- in the last 7 days (~113/day), plus "bot was blocked" 403s that can't be traced to the watchdog that
-- sent them. Where those timeouts cluster is itself a clue this migration will turn into an answer:
-- 593 of 791 land on minute :00 or :30, when the hourly, */30 and */15 jobs all fire at once; only 139
-- fall on minutes where the every-minute job runs alone. Attribution will say which callers time out.
--
-- WHAT. 38 raw net.http_post call sites, found by querying the LIVE catalog (this database has drifted
-- from the repo before, so the repo was not trusted for the inventory):
--   * 26 calls in 25 public functions — every one SECURITY DEFINER owned by postgres, none a trigger,
--     none callable by anon or authenticated. They are admin-alert watchdogs, digests and the SQL
--     fallback deliverer: badge_dm_watchdog, badge_orphan_watchdog, broadcast_watchdog,
--     client_error_watchdog, community_xp_watchdog, enrollment_watchdog, flush_new_student_alerts,
--     grade_delivery_watchdog, grade_delivery_watchdog_fast, grade_orphan_watchdog,
--     homework_attribution_watchdog, hw_dm_fallback_deliver (2 calls), hw_dm_queue_watchdog,
--     leads_watchdog, lesson_media_guard_enforce, miniapp_entry_watchdog, ops_daily_digest,
--     platform_anomaly_digest, send_resubmit_campaign_once, tier_config_watchdog,
--     username_link_stuck_watchdog, verify_student_stats_integrity, watch_gate_watchdog,
--     web_traffic_watchdog, xp_award_integrity_watchdog. All 26 go to api.telegram.org.
--   * 12 pg_cron jobs, all POSTing to this project's edge functions and all running as postgres:
--     notify-badge-award-every-minute, canary-15min, cron-admin-digest-30min,
--     cron-engagement-every-30-min, import-digest-30min, detect_and_nudge,
--     ungraded-homework-reminder-hourly, reputation-check-12h, student-of-week, teacher-weekly-digest,
--     weekly_digest, weekly-admin-topic-check. INACTIVE jobs are converted too (none hold a raw call
--     today), so re-enabling a paused job can never bring an unattributed call back.
--   NOT converted: `bot-warmth-ping` — it is a net.http_get, and ops_net_post only POSTs. It is a
--   fire-and-forget keep-alive whose failures carry no information; left as is, deliberately.
--   Already on ops_net_post before this migration: 8 functions and 6 cron jobs.
--
-- THE TRANSFORM. Each call is rewritten mechanically, on each LIVE definition inside this migration
-- rather than from 25 hand-copied bodies (~75KB of source is where transcription errors creep in, and
-- the live text is the only authoritative version):
--     net.http_post(url := U, body := B, headers := H)
--  →  public.ops_net_post(p_purpose := '<function or job name>', p_url := U, p_body := B, p_headers := H)
-- ops_net_post calls net.http_post with those arguments, then records the call in ops_http_calls with a
-- URL that ops_sanitize_url() has scrubbed (/bot<digits>:<token> → /bot<redacted>, so the bot token
-- cannot be logged). That insert is exception-swallowed, so attribution failing never blocks a send.
--
-- EVERY CALL IS PROVEN BEFORE IT IS CHANGED. For each function and job the migration raises (rolling
-- everything back) unless ALL of these hold:
--   1. AT THE CALL'S OWN LEVEL. A scan walks each call's argument list tracking bracket depth and what
--      is code versus a '...' string (E'...' backslash escapes included), a "quoted identifier", a
--      $tag$ string, or a comment (-- to the end of the line at LF or CR; nested /* */). Counting ONLY
--      code at the call's own depth, the call must have exactly three arguments — url, body and
--      headers, each by name. A `headers :=` in a comment, a string or a nested call does not count.
--      That is what guarantees EVERY call passes headers, and it matters: net.http_post DEFAULTS
--      headers to {"Content-Type":"application/json"} but ops_net_post defaults p_headers to {}, so a
--      call relying on the default would silently lose Content-Type and Telegram would stop parsing the
--      JSON body of every converted alert. What the scan does not model, it refuses: a string continued
--      across a line break, and a ';' (a statement boundary can never be inside an argument list).
--   2. POSTGRES AGREES. Each argument list the scan found is compiled by Postgres inside a DO block
--      whose body RETURNs before reaching it: every SQL expression is syntax-checked, and nothing runs
--      (verified: a 1/0 and a smuggled second statement placed after the RETURN never execute). If the
--      scan and Postgres's lexer ever disagree about where a call ends, this rejects it.
--   3. IN TOTAL. url/body/headers name matches across the whole text = 3 × calls. With (1) finding
--      exactly 3 top-level ones per call, that proves every occurrence the rename touches IS one of
--      those top-level arguments — never `r.url :=`, a string, a comment or another function's argument.
--   4. No call uses `params` or `timeout_milliseconds`, which ops_net_post has no equivalent for.
--   5. Reversing the rewrite reproduces the original BYTE FOR BYTE (md5) before anything is executed.
--   6. WHOEVER RUNS IT CAN RUN IT. A function must be SECURITY DEFINER (an invoker function would call
--      ops_net_post with its CALLER's rights, and anon/authenticated have none) and its owner must have
--      EXECUTE on ops_net_post. A cron job must run in this database, as a role with that EXECUTE.
--   7. Functions: after CREATE OR REPLACE, the stored pg_get_functiondef() must EQUAL the text executed
--      — covering SECURITY DEFINER, search_path, volatility and every other attribute, not only the body
--      — owner and ACL are unchanged, and there are 0 raw calls and exactly as many ops_net_post calls.
--   8. Cron jobs: each rewritten command is EXPLAINed before cron.alter_job stores it (resolves every
--      function and checks EXECUTE; runs nothing — ops_net_post is VOLATILE and the secret readers are
--      STABLE, so the planner folds none of them). cron.alter_job does not validate a command, so
--      without this a mistake would surface as a failed run, up to a week later for the weekly jobs.
--      Only a single statement is EXPLAINed (a ';' aborts). Schedule, active, database, username and
--      node must be unchanged afterwards.
-- Plus, once, an EXPLAIN of the exact call shape used inside functions (PL/pgSQL resolves calls only at
-- run time, so a wrong signature would otherwise fail the first real alert with 42883). The final
-- invariant is BROADER than the selection — case- and whitespace-insensitive, quoted identifiers
-- included — so a raw call in a form this migration does not rewrite aborts it instead of surviving.
--
-- DRY-RUN, read-only against production on 2026-09-26 (every step above except the writes): 25
-- functions, 12 jobs, 38 calls, 0 failures; every call has exactly url/body/headers at top level and
-- Postgres's parser accepts every argument list. The scan was also run against 27 crafted inputs — the
-- 15 that must abort did (including all 8 attacks the reviews reproduced: headers in a line comment, a
-- string, a nested call or a block comment; the E-string continuation; the bare-CR comment; a
-- positional url behind a nested `url :=`; an extra positional argument) and the 12 legitimate shapes
-- that must pass did. The parser check was shown to fire on its own (a span the counts accept but
-- Postgres rejects → 42601).
--
-- WHAT CHANGES IN ALERTING, precisely.
--   * REAL failures (4xx/5xx/transport errors) are grouped by ops_http_failure_watchdog under the
--     signature 'real:' || coalesce(purpose, url, 'unattributed') || ':' || status, each with its own
--     cooldown (platform_settings.ops_http_watchdog.cooldown_hours, 3 today). Before this migration
--     every raw caller shared one 'real:unattributed:<status>' signature, so at most one line per status
--     every 3 hours. After it, each caller has its own signature, so several callers failing inside one
--     window can each produce a line — the intended trade (more lines, each naming its source), and more
--     alert traffic during a broad outage. alert_state gains one key per (caller, status), bounded.
--   * TIMEOUTS stay counted in aggregate, and 'expected' failures (e.g. "bot was blocked") stay ignored.
--   * Timeout values: both functions default to 5000 ms and no converted call overrides it — unchanged.
--
-- KNOWN COSTS, accepted.
--   * Concentration: ~52 call sites, including every watchdog's own alert channel, now resolve
--     public.ops_net_post at run time — some by name (anon_execute_watchdog passes p_timeout_ms :=), six
--     cron jobs POSITIONALLY with a fifth argument. pg_depend records no dependency from a PL/pgSQL body
--     or a cron command, so a DROP, RENAME or reshaped recreate would succeed and break them at their
--     next send. scripts/check-migration-grants.mjs now fails a migration that drops, renames, re-owns
--     or narrows ops_net_post, or creates any version of it whose parameters are not exactly
--     (p_url text, p_body jsonb, p_headers jsonb, p_purpose text, p_timeout_ms integer) in that order
--     (E9); and it fails a new raw net.http_post (E8, promoted from a warning) — the repo still holds
--     the pre-conversion bodies of these 25 functions, and copying one forward would revert it.
--   * hw_dm_fallback_deliver runs each of up to 50 rows in its own exception block; the ops_http_calls
--     insert adds a nested one, so a full run holds up to ~100 subtransaction XIDs, past the 64-entry
--     per-backend cache. Only on the fallback path (the edge stack is down), bounded by its LIMIT 50.
--   * Lock coupling: an ACCESS EXCLUSIVE lock on ops_http_calls (DDL, VACUUM FULL) now delays every
--     converted send until released — it cannot FAIL a send, but it can make one wait. Any DDL on
--     ops_http_calls must SET lock_timeout and use CREATE INDEX CONCURRENTLY.
--   * ops_http_calls grows by ~1,700 rows/day; it is already pruned to ~3 days.
--   * Security: ops_net_post stays revoked from anon/authenticated (20260925201000 — it is an SSRF
--     primitive); every converted caller runs it as postgres, which never needed that grant.
--
-- IDEMPOTENT + REPLAY-SAFE: the loop selects only definitions that still contain a raw net.http_post,
-- so a replay finds nothing to do. The audit row is guarded by NOT EXISTS.

do $attr$
declare
  r record;
  _call_re  constant text := '\mnet\.http_post\s*\(';
  _named_re constant text := '\m(url|body|headers)\s*(:=|=>)';
  _onp regprocedure;             -- public.ops_net_post, by exact signature
  _purpose text;                 -- 'p_purpose := ''<name>'', ' — inserted before each call's arguments
  _old text; _new text;          -- the text the proofs run on: prosrc (function) or command (cron job)
  _old_def text; _new_def text;  -- functions: the whole definition, header included
  _old_acl text; _old_owner oid; _old_meta text; _secdef boolean;
  _jdb text; _juser text;
  _n int; _nargs int;
  _chars text[]; _len int;
  _k int; _pos int; _i int; _depth int; _cdepth int; _end int;
  _c text; _tag text; _span text; _estr boolean; _m text;
  _u int; _b int; _h int; _commas int;
  _fns int := 0; _jobs int := 0; _calls int := 0;
  _left int;
begin
  -- The scan treats a backslash as literal outside E'...' strings, which is only true with
  -- standard_conforming_strings on (the default since PG 9.1, and on in production).
  if current_setting('standard_conforming_strings') <> 'on' then
    raise exception 'ABORT: standard_conforming_strings is off — the call scanner would misread string literals';
  end if;

  _onp := to_regprocedure('public.ops_net_post(text,jsonb,jsonb,text,integer)');
  if _onp is null then
    raise exception 'ABORT: public.ops_net_post(text, jsonb, jsonb, text, integer) does not exist — nothing to convert to';
  end if;

  -- ── Resolution check, once: the exact named-argument shape every converted call will use. ──
  begin
    execute $q$explain select public.ops_net_post(
      p_purpose := 'resolution_probe', p_url := 'https://example.invalid/x',
      p_body := jsonb_build_object('k','v'),
      p_headers := jsonb_build_object('Content-Type','application/json'))$q$;
  exception when undefined_function then
    raise exception 'ABORT: ops_net_post(p_purpose, p_url, p_body, p_headers) does not resolve — every converted call would fail at run time';
  end;

  for r in
    select 'function'::text as kind, p.oid::bigint as id, p.proname::text as name, p.prosrc as src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosrc ~ '\mnet\.http_post\s*\('
      and p.proname <> 'ops_net_post'
    union all
    select 'cron job', j.jobid, j.jobname::text, j.command
    from cron.job j
    where j.command ~ '\mnet\.http_post\s*\('
    order by 1, 3
  loop
    -- A NULL name would make every expression below NULL, and a NULL comparison never raises.
    if r.name is null then
      raise exception 'ABORT: a % (id %) makes a raw net.http_post but has no name to attribute it to', r.kind, r.id;
    end if;
    _old := r.src;
    _purpose := 'p_purpose := ' || quote_literal(r.name) || ', ';

    -- ── Proofs on the text, before anything changes ──
    _n := (select count(*) from regexp_matches(_old, _call_re, 'g'));
    if _old ~ '\m(params|timeout_milliseconds)\s*(:=|=>)' then
      raise exception 'ABORT: % % uses params/timeout_milliseconds, which ops_net_post cannot express', r.kind, r.name;
    end if;
    if _old ~ '\mp_(url|body|headers|purpose)\s*(:=|=>)' or _old ~ 'ops_net_post' then
      raise exception 'ABORT: % % already contains p_* arguments or ops_net_post — refusing a partial rewrite', r.kind, r.name;
    end if;
    _nargs := (select count(*) from regexp_matches(_old, _named_re, 'g'));
    if _nargs <> 3 * _n then
      raise exception 'ABORT: % % has % url/body/headers assignments for % call(s); expected exactly 3 per call — a name is used outside a call', r.kind, r.name, _nargs, _n;
    end if;

    -- Per call: walk to the matching ')' and count, at the call's own level only, what it passes.
    _chars := string_to_array(_old, null);          -- one element per character
    _len := coalesce(array_length(_chars, 1), 0);
    for _k in 1 .. _n loop
      _pos := regexp_instr(_old, _call_re, 1, _k, 1); -- first character after the '('
      _i := _pos;
      _depth := 1;
      _u := 0; _b := 0; _h := 0; _commas := 0;
      while _depth > 0 loop
        if _i > _len then
          raise exception 'ABORT: % % — call % has no closing parenthesis', r.kind, r.name, _k;
        end if;
        _c := _chars[_i];
        if _c = '''' then
          -- In an E'...' string a backslash escapes the next character (E'\n', E'\''); 14 of these
          -- functions build their Telegram text that way. In a plain '...' string it does not
          -- (standard_conforming_strings, checked above), and '' is the escaped quote in both.
          _estr := _i > 1 and lower(_chars[_i - 1]) = 'e' and (_i = 2 or _chars[_i - 2] !~ '[[:alnum:]_]');
          _i := _i + 1;
          loop
            if _i > _len then
              raise exception 'ABORT: % % — call % has an unterminated string literal', r.kind, r.name, _k;
            end if;
            if _estr and _chars[_i] = chr(92) then
              _i := _i + 2;                           -- backslash + the character it escapes
              continue;
            end if;
            if _chars[_i] = '''' then
              exit when _i = _len or _chars[_i + 1] <> '''';
              _i := _i + 1;                           -- '' is an escaped quote: step over the pair
            end if;
            _i := _i + 1;
          end loop;
          -- Postgres glues 'a'<whitespace with a newline>'b' into ONE literal (keeping E mode). The
          -- scan does not model that, so it refuses it.
          if substr(_old, _i + 1) ~ '^\s*(--[^\r\n]*[\r\n]\s*)*''' then
            raise exception 'ABORT: % % — call % continues a string literal across a line break; convert it by hand', r.kind, r.name, _k;
          end if;
        elsif _c = '"' then
          _i := _i + 1;
          loop
            if _i > _len then
              raise exception 'ABORT: % % — call % has an unterminated quoted identifier', r.kind, r.name, _k;
            end if;
            if _chars[_i] = '"' then
              exit when _i = _len or _chars[_i + 1] <> '"';
              _i := _i + 1;
            end if;
            _i := _i + 1;
          end loop;
        elsif _c = '-' and _i < _len and _chars[_i + 1] = '-' then
          -- Postgres ends a -- comment at LF or at CR.
          while _i <= _len and _chars[_i] <> chr(10) and _chars[_i] <> chr(13) loop
            _i := _i + 1;
          end loop;
        elsif _c = '/' and _i < _len and _chars[_i + 1] = '*' then
          _cdepth := 1;                               -- Postgres block comments nest
          _i := _i + 2;
          while _cdepth > 0 loop
            if _i > _len then
              raise exception 'ABORT: % % — call % has an unterminated comment', r.kind, r.name, _k;
            end if;
            if _chars[_i] = '/' and _i < _len and _chars[_i + 1] = '*' then
              _cdepth := _cdepth + 1; _i := _i + 2;
            elsif _chars[_i] = '*' and _i < _len and _chars[_i + 1] = '/' then
              _cdepth := _cdepth - 1; _i := _i + 2;
            else
              _i := _i + 1;
            end if;
          end loop;
          _i := _i - 1;                               -- the common step below lands just past '*/'
        elsif _c = '$' and (_i = 1 or _chars[_i - 1] !~ '[[:alnum:]_]') then
          _tag := substring(substr(_old, _i) from '^(\$([A-Za-z_][A-Za-z_0-9]*)?\$)');
          if _tag is not null then                    -- a dollar quote; $1 and friends are not
            _end := strpos(substr(_old, _i + length(_tag)), _tag);
            if _end = 0 then
              raise exception 'ABORT: % % — call % has an unterminated dollar quote', r.kind, r.name, _k;
            end if;
            _i := _i + length(_tag) + _end - 1 + length(_tag) - 1;   -- last character of the closing tag
          end if;
        elsif _c = '(' then
          _depth := _depth + 1;
        elsif _c = ')' then
          _depth := _depth - 1;
        elsif _c = ';' then
          raise exception 'ABORT: % % — call % contains a statement boundary, so the scan cannot have found the real call', r.kind, r.name, _k;
        elsif _depth = 1 and _c = ',' then
          _commas := _commas + 1;
        elsif _depth = 1 and _c ~ '[a-z]' and (_i = 1 or _chars[_i - 1] !~ '[[:alnum:]_$."]') then
          _m := substring(substr(_old, _i, 48) from '^(url|body|headers)\s*(?::=|=>)');
          if _m = 'url' then _u := _u + 1;
          elsif _m = 'body' then _b := _b + 1;
          elsif _m = 'headers' then _h := _h + 1;
          end if;
        end if;
        _i := _i + 1;
      end loop;
      _span := substr(_old, _pos, _i - 1 - _pos);     -- the arguments, without the closing ')'

      if _u <> 1 or _b <> 1 or _h <> 1 or _commas <> 2 then
        raise exception 'ABORT: % % — call % must pass exactly url, body and headers, by name, as its only arguments (found at top level: url=%, body=%, headers=%, commas=%); a missing headers would drop Content-Type',
          r.kind, r.name, _k, _u, _b, _h, _commas;
      end if;
      if _span ~ _call_re then
        raise exception 'ABORT: % % — call % contains another net.http_post call', r.kind, r.name, _k;
      end if;
      -- Postgres's own parser must accept the argument list the scan found. The DO body RETURNs before
      -- the call, so it is compiled (syntax-checked) in full and nothing in it ever runs.
      if strpos(_span, '$span_check$') > 0 then
        raise exception 'ABORT: % % — call % contains the parser-check delimiter', r.kind, r.name, _k;
      end if;
      begin
        execute 'do $span_check$ begin return; perform net.http_post(' || _span || '); end $span_check$';  -- lint:allow E8: compiled only to syntax-check the span; RETURN comes first, so it never runs
      exception when others then
        raise exception 'ABORT: % % — Postgres''s parser rejects the argument list the scan found for call % (% %)', r.kind, r.name, _k, sqlstate, sqlerrm;
      end;
    end loop;

    if r.kind = 'function' then
      select pg_get_functiondef(p.oid), coalesce(array_to_string(p.proacl, ','), ''), p.proowner, p.prosecdef
        into _old_def, _old_acl, _old_owner, _secdef
      from pg_proc p where p.oid = r.id::oid;
      if not _secdef then
        raise exception 'ABORT: function % is SECURITY INVOKER — it would call ops_net_post with its CALLER''s rights, which anon/authenticated do not have', r.name;
      end if;
      if not has_function_privilege(_old_owner, _onp, 'EXECUTE') then
        raise exception 'ABORT: function %''s owner cannot EXECUTE ops_net_post', r.name;
      end if;
      -- The header (name, attributes) must add no matches of its own, so the proofs on prosrc hold for
      -- the whole definition that is about to be executed.
      if (select count(*) from regexp_matches(_old_def, _call_re, 'g')) <> _n
         or (select count(*) from regexp_matches(_old_def, _named_re, 'g')) <> _nargs then
        raise exception 'ABORT: function % — its definition header matches the rewrite patterns', r.name;
      end if;

      _new_def := regexp_replace(_old_def, '\mnet\.http_post(\s*)\(', 'public.ops_net_post\1(' || _purpose, 'g');
      _new_def := regexp_replace(_new_def, '\m(url|body|headers)(\s*(:=|=>))', 'p_\1\2', 'g');

      if md5(regexp_replace(
               regexp_replace(replace(_new_def, _purpose, ''), '\mpublic\.ops_net_post(\s*)\(', 'net.http_post\1(', 'g'),
               '\mp_(url|body|headers)(\s*(:=|=>))', '\1\2', 'g'))
         <> md5(_old_def) then
        raise exception 'ABORT: function % — reversing the rewrite does not reproduce the original definition', r.name;
      end if;

      execute _new_def;

      -- The stored definition must be exactly what was executed (attributes and body), and nothing
      -- about who owns or may call it may have moved.
      if pg_get_functiondef(r.id::oid) is distinct from _new_def then
        raise exception 'ABORT: function % — the stored definition differs from the one executed', r.name;
      end if;
      select prosrc into _new from pg_proc where oid = r.id::oid;
      if (select count(*) from regexp_matches(_new, _call_re, 'g')) <> 0
         or (select count(*) from regexp_matches(_new, '\mpublic\.ops_net_post\s*\(', 'g')) <> _n then
        raise exception 'ABORT: function % — expected 0 raw calls and % ops_net_post call(s) after the rewrite', r.name, _n;
      end if;
      if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = r.id::oid) <> _old_acl
         or (select proowner from pg_proc where oid = r.id::oid) <> _old_owner then
        raise exception 'ABORT: function % — its ACL or owner changed', r.name;
      end if;
      _fns := _fns + 1;

    else
      select row(j.schedule, j.active, j.database, j.username, j.nodename, j.nodeport)::text, j.database, j.username
        into _old_meta, _jdb, _juser
      from cron.job j where j.jobid = r.id;
      if _jdb is distinct from current_database() then
        raise exception 'ABORT: cron job % runs in database %, not % — its command cannot be checked here', r.name, _jdb, current_database();
      end if;
      if not has_function_privilege(_juser::name, _onp, 'EXECUTE') then
        raise exception 'ABORT: cron job % runs as %, which cannot EXECUTE ops_net_post — every run would fail', r.name, _juser;
      end if;

      _new := regexp_replace(_old, '\mnet\.http_post(\s*)\(', 'public.ops_net_post\1(' || _purpose, 'g');
      _new := regexp_replace(_new, '\m(url|body|headers)(\s*(:=|=>))', 'p_\1\2', 'g');

      if md5(regexp_replace(
               regexp_replace(replace(_new, _purpose, ''), '\mpublic\.ops_net_post(\s*)\(', 'net.http_post\1(', 'g'),
               '\mp_(url|body|headers)(\s*(:=|=>))', '\1\2', 'g'))
         <> md5(_old) then
        raise exception 'ABORT: cron job % — reversing the rewrite does not reproduce the original command', r.name;
      end if;

      if _new ~ ';' then
        raise exception 'ABORT: cron job % — command is not a single statement, so it cannot be EXPLAINed safely; convert it by hand', r.name;
      end if;
      begin
        execute 'explain ' || _new;
      exception when others then
        raise exception 'ABORT: cron job % — the rewritten command does not resolve (% %)', r.name, sqlstate, sqlerrm;
      end;

      perform cron.alter_job(job_id := r.id, command := _new);

      if (select command from cron.job where jobid = r.id) is distinct from _new then
        raise exception 'ABORT: cron job % — command did not update as written', r.name;
      end if;
      if (select row(j.schedule, j.active, j.database, j.username, j.nodename, j.nodeport)::text
          from cron.job j where j.jobid = r.id) is distinct from _old_meta then
        raise exception 'ABORT: cron job % — schedule/active/database/username/node changed', r.name;
      end if;
      _jobs := _jobs + 1;
    end if;

    _calls := _calls + _n;
  end loop;

  -- ── The invariant this migration establishes, checked directly and BROADER than the selection
  --    (case- and whitespace-insensitive, quoted identifiers), so an unconverted form aborts. ──
  select count(*) into _left
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname <> 'ops_net_post'
    and p.prosrc ~* '(^|[^[:alnum:]_$])"?net"?\s*\.\s*"?http_post"?\s*\(';
  if _left <> 0 then
    raise exception 'ABORT: % public function(s) still make a raw net.http_post call, possibly in a form this migration does not rewrite', _left;
  end if;
  select count(*) into _left
  from cron.job
  where command ~* '(^|[^[:alnum:]_$])"?net"?\s*\.\s*"?http_post"?\s*\(';
  if _left <> 0 then
    raise exception 'ABORT: % cron job(s) still make a raw net.http_post call', _left;
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'outbound_http_attributed',
         jsonb_build_object(
           'functions_converted', _fns,
           'cron_jobs_converted', _jobs,
           'calls_converted', _calls,
           'left_raw_deliberately', 'bot-warmth-ping (net.http_get; ops_net_post is POST-only)',
           'why', 'ops_http_failure_watchdog fired 159x as "403 × N unattributed" and could not name the caller; ~790 unattributed timeouts in the 7 days before this',
           'at', now())
  where not exists (select 1 from public.admin_actions where action = 'outbound_http_attributed');
end $attr$;
