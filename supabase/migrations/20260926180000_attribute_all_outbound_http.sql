-- OBSERVABILITY: every outbound HTTP call from SQL now goes through public.ops_net_post(), so a
-- failure names its caller instead of arriving as "unattributed".
--
-- SUPERSEDES 20260926170000 (same intent, never merged or applied), after three adversarial reviews:
-- the per-call headers check was cut at the first ';' (defeated by a '&amp;' inside a body literal),
-- the rename proof counted per body rather than per call, rewritten cron commands were never resolved,
-- header attributes were not re-checked, and the header claimed "no new alert fires", which was wrong.
--
-- WHY. The twelve-week stale-project incident fixed in 20260926161000 was not silent — it was
-- UNTRACEABLE. ops_http_failure_watchdog fired 159 times ("403 × N unattributed"), DMing admins each
-- time, but a raw net.http_post records no URL, so no alert could say where the requests were going.
-- Measured on 2026-09-26, the same blindness is still the dominant signal: ~790 UNATTRIBUTED timeouts
-- in the last 7 days (~113/day, still arriving after that fix), plus "bot was blocked" 403s that can't
-- be traced to the watchdog that sent them. An alarm nobody can act on is barely better than none.
-- Where those timeouts cluster is itself a clue this migration will turn into an answer: 593 of 791
-- land on minute :00 or :30, when the hourly, */30 and */15 jobs all fire at once; only 139 fall on
-- minutes where the every-minute job runs alone. So the pile-up, not any one job, is the likeliest
-- cause — attribution will say which callers actually time out.
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
--   * 12 active pg_cron jobs, all POSTing to this project's edge functions: notify-badge-award-every-
--     minute, canary-15min, cron-admin-digest-30min, cron-engagement-every-30-min, import-digest-30min,
--     detect_and_nudge, ungraded-homework-reminder-hourly, reputation-check-12h, student-of-week,
--     teacher-weekly-digest, weekly_digest, weekly-admin-topic-check.
--   NOT converted: `bot-warmth-ping` — it is a net.http_get, and ops_net_post only POSTs. It is a
--   fire-and-forget keep-alive whose failures carry no information; left as is, deliberately.
--   Already on ops_net_post before this migration: 8 functions and 6 cron jobs.
--
-- THE TRANSFORM, and why it is safe to apply to live definitions rather than transcribed copies. Each
-- call is rewritten mechanically:
--     net.http_post(url := U, body := B, headers := H)
--  →  public.ops_net_post(p_purpose := '<function or job name>', p_url := U, p_body := B, p_headers := H)
-- ops_net_post calls net.http_post with exactly those arguments, then records the call in ops_http_calls
-- with a URL that ops_sanitize_url() has scrubbed (it rewrites /bot<digits>:<token> to /bot<redacted>, so
-- the bot token cannot be logged). The ops_http_calls insert is exception-swallowed inside ops_net_post,
-- so attribution failing can never block a send. The rewrite runs on each LIVE definition inside this
-- migration instead of from 25 hand-copied bodies, because copying ~75KB of function source by hand is
-- where errors creep in, and because the live text is the only authoritative version.
--
-- EVERY CALL IS PROVEN BEFORE IT IS CHANGED. For each function and job the migration raises (rolling
-- everything back) unless ALL of these hold:
--   1. PER CALL: each call's argument list is located by a real scan — parentheses matched, with string
--      literals (E'...' backslash escapes included), quoted identifiers, dollar-quoted strings and
--      comments skipped — and must name exactly one url, one body and one headers. That gives three
--      guarantees at once: no positional or duplicated argument, no nested call, and EVERY call passes
--      headers explicitly. The last one matters: net.http_post DEFAULTS headers to
--      {"Content-Type":"application/json"}, but ops_net_post defaults p_headers to {} and passes it
--      through, so a call relying on the default would silently lose Content-Type and Telegram would
--      stop parsing the JSON body of every converted alert.
--   2. IN TOTAL: url/body/headers assignments across the whole text = 3 × calls. With (1), that proves
--      every occurrence the rename touches is inside a call's own argument list — never `r.url :=`, a
--      string, or a named argument to some other function.
--   3. no call uses `params` or `timeout_milliseconds`, which ops_net_post has no equivalent for.
--   4. reversing the rewrite reproduces the original BYTE FOR BYTE (md5) before anything is executed.
--   5. functions: after CREATE OR REPLACE, the stored pg_get_functiondef() must EQUAL the text executed
--      — which covers SECURITY DEFINER, search_path, volatility and every other attribute, not only the
--      body — owner and ACL are unchanged, and there are 0 raw calls and exactly as many ops_net_post.
--   6. cron jobs: every rewritten command is EXPLAINed before cron.alter_job stores it. EXPLAIN resolves
--      each function the command calls and checks EXECUTE, but runs nothing (ops_net_post is VOLATILE
--      and the secret readers are STABLE, so the planner folds none of them). cron.alter_job does not
--      validate a command, so without this a mistake would surface as a failed run — up to a week later
--      for the weekly jobs. Only a single statement is EXPLAINed: a ';' aborts, because EXPLAIN would
--      cover only the first of several statements. Afterwards schedule, active, database, username and
--      node are unchanged.
-- Plus, once, an EXPLAIN of the exact call shape used inside functions: PL/pgSQL does not resolve a call
-- until run time, so CREATE OR REPLACE alone would accept a wrong signature and the first real alert
-- would fail with 42883. The final invariant is BROADER than the selection — case- and whitespace-
-- insensitive, quoted identifiers included (NET.HTTP_POST(, "net".http_post(, net . http_post() — so
-- a raw call in a form this migration does not rewrite aborts it instead of surviving it. Live, the
-- broad and the strict patterns select the same 25 functions and 12 jobs.
-- Dry-run read-only against production on 2026-09-26 (every step above except the writes): 25
-- functions, 12 jobs, 38 calls, 0 failures, every call's scan ending at its own ')'. The scanner was
-- also run against 14 crafted inputs — 7 that must abort (no headers, stray rename, headers only in a
-- string, duplicate url, positional, a second call smuggling an extra headers, unbalanced) and 7 that
-- must pass (';' and '&amp;' in a body, E'it\'s (x', ')' in a comment, dollar quote, quoted identifier,
-- $1): 0 failures.
--
-- WHAT CHANGES IN ALERTING, precisely.
--   * REAL failures (4xx/5xx/transport errors) are grouped by ops_http_failure_watchdog under the
--     signature 'real:' || coalesce(purpose, url, 'unattributed') || ':' || status, each with its own
--     cooldown (platform_settings.ops_http_watchdog.cooldown_hours, 3 today). Before this migration
--     every raw caller shared one 'real:unattributed:<status>' signature, so at most one line per status
--     every 3 hours. After it, each caller has its own signature, so several callers failing inside one
--     window can each produce a line. That is the intended trade — more lines, each naming its source —
--     and it does mean more alert traffic during a broad outage. alert_state gains one key per (caller,
--     status), bounded by the ~52 callers.
--   * TIMEOUTS stay counted in aggregate, and 'expected' failures (e.g. "bot was blocked") stay ignored.
--   * Timeout values: both functions default to 5000 ms and no call overrides it — unchanged.
--
-- KNOWN COSTS, accepted.
--   * Concentration: ~52 call sites, including every watchdog's own alert channel, now resolve
--     public.ops_net_post by name at run time. pg_depend records no dependency from a PL/pgSQL body or a
--     cron command, so DROP or RENAME would succeed silently and break them all at their next send.
--     scripts/check-migration-grants.mjs now fails a migration that drops or renames ops_net_post without
--     recreating the same named-argument shape (E9), and fails a new raw net.http_post (E8, promoted
--     from a warning) — the repo still holds the pre-conversion bodies of these 25 functions, and copying
--     one forward would otherwise silently revert its attribution.
--   * hw_dm_fallback_deliver already runs each of up to 50 rows in its own exception block; the
--     ops_http_calls insert adds a nested one, so a full run holds up to ~100 subtransaction XIDs, past
--     the 64-entry per-backend cache. Only while that transaction is open, only on the fallback path
--     (the edge stack is down), and bounded by its LIMIT 50. Noted, not changed.
--   * Lock coupling: an ACCESS EXCLUSIVE lock on ops_http_calls (DDL, VACUUM FULL) now delays every
--     converted send until it is released — the insert cannot FAIL a send, but it can wait. Any DDL on
--     ops_http_calls must SET lock_timeout and use CREATE INDEX CONCURRENTLY.
--   * ops_http_calls grows by ~1,700 rows/day; it is already pruned to ~3 days.
--   * Security: every converted function is SECURITY DEFINER owned by postgres, so it executes
--     ops_net_post as postgres. ops_net_post stays revoked from anon/authenticated (20260925201000 — it is
--     an SSRF primitive); none of these callers ever needed that grant.
--
-- IDEMPOTENT + REPLAY-SAFE: the loop selects only definitions that still contain a raw net.http_post,
-- so a replay finds nothing to do. The audit row is guarded by NOT EXISTS.

do $attr$
declare
  r record;
  _call_re  constant text := '\mnet\.http_post\s*\(';
  _named_re constant text := '\m(url|body|headers)\s*(:=|=>)';
  _purpose text;                 -- 'p_purpose := ''<name>'', ' — inserted before each call's arguments
  _old text; _new text;          -- the text the proofs run on: prosrc (function) or command (cron job)
  _old_def text; _new_def text;  -- functions: the whole definition, header included
  _old_acl text; _old_owner oid; _old_meta text;
  _n int; _nargs int;
  _chars text[]; _len int;
  _k int; _pos int; _i int; _depth int; _cdepth int; _end int;
  _c text; _tag text; _span text; _estr boolean;
  _fns int := 0; _jobs int := 0; _calls int := 0;
  _left int;
begin
  -- The string scan below treats a backslash as literal outside E'...' strings, which is only true
  -- with standard_conforming_strings on (the default since PG 9.1, and on in production).
  if current_setting('standard_conforming_strings') <> 'on' then
    raise exception 'ABORT: standard_conforming_strings is off — the call scanner would misread string literals';
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
    where j.active and j.command ~ '\mnet\.http_post\s*\('
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

    -- Per call: find the matching ')' and check that argument list on its own.
    _chars := string_to_array(_old, null);          -- one element per character
    _len := coalesce(array_length(_chars, 1), 0);
    for _k in 1 .. _n loop
      _pos := regexp_instr(_old, _call_re, 1, _k, 1); -- first character after the '('
      _i := _pos;
      _depth := 1;
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
          while _i <= _len and _chars[_i] <> E'\n' loop
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
        end if;
        _i := _i + 1;
      end loop;
      _span := substr(_old, _pos, _i - 1 - _pos);     -- the arguments, without the closing ')'

      if (select count(*) from regexp_matches(_span, '\murl\s*(:=|=>)', 'g')) <> 1
         or (select count(*) from regexp_matches(_span, '\mbody\s*(:=|=>)', 'g')) <> 1
         or (select count(*) from regexp_matches(_span, '\mheaders\s*(:=|=>)', 'g')) <> 1 then
        raise exception 'ABORT: % % — call % does not pass exactly one url, one body and one headers by name (a missing headers would drop Content-Type)', r.kind, r.name, _k;
      end if;
      if _span ~ _call_re then
        raise exception 'ABORT: % % — call % contains another net.http_post call', r.kind, r.name, _k;
      end if;
    end loop;

    if r.kind = 'function' then
      select pg_get_functiondef(p.oid), coalesce(array_to_string(p.proacl, ','), ''), p.proowner
        into _old_def, _old_acl, _old_owner
      from pg_proc p where p.oid = r.id::oid;
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
      select row(j.schedule, j.active, j.database, j.username, j.nodename, j.nodeport)::text
        into _old_meta
      from cron.job j where j.jobid = r.id;

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
  where active and command ~* '(^|[^[:alnum:]_$])"?net"?\s*\.\s*"?http_post"?\s*\(';
  if _left <> 0 then
    raise exception 'ABORT: % active cron job(s) still make a raw net.http_post', _left;
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
