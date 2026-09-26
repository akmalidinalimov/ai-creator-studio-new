-- OBSERVABILITY: every outbound HTTP call from SQL now goes through public.ops_net_post(), so a
-- failure names its caller instead of arriving as "unattributed".
--
-- WHY. The twelve-week stale-project incident fixed in 20260926161000 was not silent — it was
-- UNTRACEABLE. ops_http_failure_watchdog fired 159 times ("403 × N unattributed"), DMing admins each
-- time, but a raw net.http_post records no URL, so no alert could say where the requests were going.
-- Measured on 2026-09-26, the same blindness is still the dominant signal: 792 UNATTRIBUTED timeouts
-- in the last 7 days (~113/day, still arriving after that fix), plus "bot was blocked" 403s that can't
-- be traced to the watchdog that sent them. An alarm nobody can act on is barely better than none.
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
--     minute (1,440 runs/day — the likeliest source of most of those unattributed timeouts), canary-15min,
--     cron-admin-digest-30min, cron-engagement-every-30-min, import-digest-30min, detect_and_nudge,
--     ungraded-homework-reminder-hourly, reputation-check-12h, student-of-week, teacher-weekly-digest,
--     weekly_digest, weekly-admin-topic-check.
--   NOT converted: `bot-warmth-ping` — it is a net.http_get, and ops_net_post only POSTs. It is a
--   fire-and-forget keep-alive whose failures carry no information; left as is, deliberately.
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
-- EVERY CALL IS PROVEN BEFORE IT IS CHANGED. For each function and job the migration refuses (raises,
-- rolling everything back) unless ALL of these hold:
--   1. every call uses exactly url + body + headers, and those names appear nowhere else in the body
--      (count must equal 3 × calls) — so the rename cannot touch an unrelated variable;
--   2. no call uses `params` or `timeout_milliseconds`, which ops_net_post has no equivalent for;
--   3. EVERY call passes `headers` explicitly. This matters: net.http_post DEFAULTS headers to
--      {"Content-Type":"application/json"}, but ops_net_post defaults p_headers to {} and passes it
--      through. A call relying on the default would silently lose Content-Type, and Telegram would stop
--      parsing the JSON body of every converted alert. All 38 set it today; this makes that a guarantee;
--   4. reversing the rewrite reproduces the original definition BYTE FOR BYTE (md5), both before the
--      CREATE OR REPLACE and again on the stored body afterwards — so nothing but the intended
--      substitution changed;
--   5. afterwards there are zero raw net.http_post calls and exactly as many ops_net_post calls as there
--      were raw ones, and the function's ACL is unchanged.
-- Plus, once: an EXPLAIN of the exact call shape, which resolves the named-argument signature without
-- executing it. PL/pgSQL does not resolve a function call until run time, so CREATE OR REPLACE alone
-- would accept a wrong signature and the first real alert would fail. A signature mismatch raises
-- 42883 at resolution; the EXPLAIN turns that into a deploy-time failure.
-- All of the above was dry-run read-only against production on 2026-09-26: 37 sites, 38 calls, 0
-- failures on every check.
--
-- WHAT DOES NOT CHANGE.
--   * Timeouts: both functions default to 5000 ms and no call overrides it, so behaviour is identical.
--     (Attribution will reveal WHICH jobs time out; raising a job's timeout is a separate decision.)
--   * Alert volume: ops_http_failure_watchdog groups REAL failures by coalesce(purpose, url,
--     'unattributed') — so they now carry a caller's name, which is the point — while it counts
--     timeouts in aggregate and ignores 'expected' ones (e.g. "bot was blocked"). No new alert fires.
--   * Security: every converted function is SECURITY DEFINER owned by postgres, so it executes
--     ops_net_post as postgres. ops_net_post stays revoked from anon/authenticated (20260925201000 — it is
--     an SSRF primitive); none of these callers ever needed that grant.
--   * ops_http_calls volume rises by ~1,700 rows/day; it is already pruned to ~3 days (10,854 rows,
--     oldest 2026-09-23 at the time of writing).
--
-- IDEMPOTENT + REPLAY-SAFE: both loops select only definitions that still contain a raw net.http_post,
-- so a replay finds nothing to do. The audit row is guarded by NOT EXISTS.

do $attr$
declare
  r record;
  _name text;
  _old_def text; _new_def text;
  _old_src text; _new_src text;
  _old_acl text;
  _old_cmd text; _new_cmd text;
  _n int; _nargs int;
  _call text;
  _fns int := 0; _jobs int := 0; _calls int := 0;
  _left int;
begin
  -- ── Resolution check, once: the exact named-argument shape every converted call will use. ──
  begin
    execute $q$explain select public.ops_net_post(
      p_purpose := 'resolution_probe', p_url := 'https://example.invalid/x',
      p_body := jsonb_build_object('k','v'),
      p_headers := jsonb_build_object('Content-Type','application/json'))$q$;
  exception when undefined_function then
    raise exception 'ABORT: ops_net_post(p_purpose, p_url, p_body, p_headers) does not resolve — every converted call would fail at run time';
  end;

  -- ─────────────────────────── Part 1: functions ───────────────────────────
  for r in
    select p.oid, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosrc ~ 'net\.http_post\s*\('
      and p.proname <> 'ops_net_post'
    order by p.proname
  loop
    _name := r.proname;
    select prosrc, coalesce(array_to_string(proacl, ','), '') into _old_src, _old_acl
    from pg_proc where oid = r.oid;
    _old_def := pg_get_functiondef(r.oid);

    _n := (select count(*) from regexp_matches(_old_src, 'net\.http_post\s*\(', 'g'));
    if _old_src ~ '\m(params|timeout_milliseconds)\s*(:=|=>)' then
      raise exception 'ABORT: % uses params/timeout_milliseconds, which ops_net_post cannot express', _name;
    end if;
    if _old_src ~ '\mp_(url|body|headers|purpose)\s*(:=|=>)' or _old_src ~ 'ops_net_post' then
      raise exception 'ABORT: % already contains p_* arguments or ops_net_post — refusing a partial rewrite', _name;
    end if;
    _nargs := (select count(*) from regexp_matches(_old_src, '\m(url|body|headers)\s*(:=|=>)', 'g'));
    if _nargs <> 3 * _n then
      raise exception 'ABORT: % has % url/body/headers assignments for % call(s); expected exactly 3 each — a name is used outside a call', _name, _nargs, _n;
    end if;
    for _call in select (regexp_matches(_old_src, 'net\.http_post\s*\(([^;]*);?', 'g'))[1] loop
      if _call !~ '\mheaders\s*(:=|=>)' then
        raise exception 'ABORT: % has a call without explicit headers — ops_net_post would drop Content-Type', _name;
      end if;
    end loop;

    _new_def := regexp_replace(_old_def, 'net\.http_post(\s*)\(',
                  'public.ops_net_post\1(p_purpose := ' || quote_literal(_name) || ', ', 'g');
    _new_def := regexp_replace(_new_def, '\m(url|body|headers)(\s*(:=|=>))', 'p_\1\2', 'g');

    if md5(regexp_replace(regexp_replace(_new_def, '\mp_(url|body|headers)(\s*(:=|=>))', '\1\2', 'g'),
             'public\.ops_net_post(\s*)\(p_purpose := ' || quote_literal(_name) || ', ', 'net.http_post\1(', 'g'))
       <> md5(_old_def) then
      raise exception 'ABORT: % — reversing the rewrite does not reproduce the original definition', _name;
    end if;

    execute _new_def;

    select prosrc into _new_src from pg_proc where oid = r.oid;
    if (select count(*) from regexp_matches(_new_src, 'net\.http_post\s*\(', 'g')) <> 0 then
      raise exception 'ABORT: % still contains a raw net.http_post after the rewrite', _name;
    end if;
    if (select count(*) from regexp_matches(_new_src, 'public\.ops_net_post\s*\(', 'g')) <> _n then
      raise exception 'ABORT: % — ops_net_post call count does not match the % raw call(s)', _name, _n;
    end if;
    if md5(regexp_replace(regexp_replace(_new_src, '\mp_(url|body|headers)(\s*(:=|=>))', '\1\2', 'g'),
             'public\.ops_net_post(\s*)\(p_purpose := ' || quote_literal(_name) || ', ', 'net.http_post\1(', 'g'))
       <> md5(_old_src) then
      raise exception 'ABORT: % — the STORED body is not the original plus the intended rewrite', _name;
    end if;
    if coalesce((select array_to_string(proacl, ',') from pg_proc where oid = r.oid), '') <> _old_acl then
      raise exception 'ABORT: % — its ACL changed', _name;
    end if;

    _fns := _fns + 1;
    _calls := _calls + _n;
  end loop;

  -- ─────────────────────────── Part 2: cron jobs ───────────────────────────
  for r in
    select jobid, jobname, command from cron.job
    where active and command ~ 'net\.http_post\s*\('
    order by jobid
  loop
    _name := r.jobname;
    _old_cmd := r.command;

    _n := (select count(*) from regexp_matches(_old_cmd, 'net\.http_post\s*\(', 'g'));
    if _old_cmd ~ '\m(params|timeout_milliseconds)\s*(:=|=>)' then
      raise exception 'ABORT: cron job % uses params/timeout_milliseconds', _name;
    end if;
    if _old_cmd ~ '\mp_(url|body|headers|purpose)\s*(:=|=>)' or _old_cmd ~ 'ops_net_post' then
      raise exception 'ABORT: cron job % already partially converted — refusing', _name;
    end if;
    _nargs := (select count(*) from regexp_matches(_old_cmd, '\m(url|body|headers)\s*(:=|=>)', 'g'));
    if _nargs <> 3 * _n then
      raise exception 'ABORT: cron job % has % url/body/headers assignments for % call(s)', _name, _nargs, _n;
    end if;
    for _call in select (regexp_matches(_old_cmd, 'net\.http_post\s*\(([^;]*);?', 'g'))[1] loop
      if _call !~ '\mheaders\s*(:=|=>)' then
        raise exception 'ABORT: cron job % has a call without explicit headers', _name;
      end if;
    end loop;

    _new_cmd := regexp_replace(_old_cmd, 'net\.http_post(\s*)\(',
                  'public.ops_net_post\1(p_purpose := ' || quote_literal(_name) || ', ', 'g');
    _new_cmd := regexp_replace(_new_cmd, '\m(url|body|headers)(\s*(:=|=>))', 'p_\1\2', 'g');

    if md5(regexp_replace(regexp_replace(_new_cmd, '\mp_(url|body|headers)(\s*(:=|=>))', '\1\2', 'g'),
             'public\.ops_net_post(\s*)\(p_purpose := ' || quote_literal(_name) || ', ', 'net.http_post\1(', 'g'))
       <> md5(_old_cmd) then
      raise exception 'ABORT: cron job % — reversing the rewrite does not reproduce the original command', _name;
    end if;

    -- alter_job keeps the jobid, schedule, active flag and owner; only the command changes.
    perform cron.alter_job(job_id := r.jobid, command := _new_cmd);

    if (select command from cron.job where jobid = r.jobid) is distinct from _new_cmd then
      raise exception 'ABORT: cron job % — command did not update as written', _name;
    end if;

    _jobs := _jobs + 1;
    _calls := _calls + _n;
  end loop;

  -- ── The invariant this migration establishes, checked directly rather than by counting. ──
  select count(*) into _left
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosrc ~ 'net\.http_post\s*\(' and p.proname <> 'ops_net_post';
  if _left <> 0 then
    raise exception 'ABORT: % public function(s) still make a raw net.http_post', _left;
  end if;
  select count(*) into _left from cron.job where active and command ~ 'net\.http_post\s*\(';
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
           'why', 'ops_http_failure_watchdog fired 159x as "403 × N unattributed" and could not name the caller; 792 unattributed timeouts in the 7 days before this',
           'at', now())
  where not exists (select 1 from public.admin_actions where action = 'outbound_http_attributed');
end $attr$;
