-- DETECTOR for the anon-EXECUTE class (prevention hierarchy layer 5 — the backstop, and the ONLY
-- layer that can see what the other two cannot).
--
-- WHY A WATCHDOG IS STILL NEEDED after 20260926093000 (default privileges) and the author-time lint:
-- neither can see DRIFT. `cron_service_key()` — a SECURITY DEFINER function returning a decrypted
-- Vault service_role credential that `anon` could call over /rest/v1/rpc for ~83 days — existed in
-- production with **NO CREATE FUNCTION in any migration** (reconciled only by 20260926060000). No
-- author-time check could ever have seen it, because it was never authored here. Separately,
-- `ops_net_post`, `nudge_candidates_inactive/stuck` and `nudge_cron_status` each carried an explicit
-- `anon=X` grant even though their own migrations revoked anon at creation — something re-granted them
-- outside version control. A REPO GREP IS NOT AUTHORITATIVE FOR SECURITY STATE. This asks the catalog.
--
-- ── WHAT IT WATCHES ──
--
-- Primary signal: a SET DIFFERENCE against a ledgered baseline of the 27 anon-executable SECURITY
-- DEFINER routines accounted for as of today (77 → 64 → 55 → 27 across 20260925201000,
-- 20260926101000 and 20260926111000). Anything anon-executable and NOT in the baseline alarms.
--
-- SET membership, deliberately, NOT a count. A count-only detector sleeps through a SWAP — one closed,
-- one opened, total unchanged — and a swap is what SQL-editor drift looks like. It also reports
-- `closed_since_baseline`, so tightening further never looks like an alarm.
--
-- Two CLASS checks, independent of the baseline so that editing the baseline cannot silence them:
--   C1 (critical): body touches `vault.` or `decrypted_secret` — the cron_service_key() shape.
--   C2 (warning, self-labelled HEURISTIC): reads `platform_settings` but never calls
--       jsonb_build_object, i.e. likely returns a settings row VERBATIM. This is the
--       `challenge_config()` (revoked; will hold a Meta token) versus `get_public_setting()`
--       (safe because it enumerates the fields it returns) distinction.
--   C3: a routine whose body C1/C2 CANNOT READ — see the next section.
-- VERIFIED against production before merge: C1, C2 and C3 all match NOTHING today, so this does not
-- cry wolf on its first run. A detector that alarms spuriously gets muted, and a muted detector is
-- worse than none.
--
-- ── FIXES FROM AN ADVERSARIAL REVIEW OF THE PREVIOUS DRAFT, each verified against the catalog ──
--
-- 1. C3 WAS DEAD CODE, and it was the exact sin this header boasts about avoiding. It tested
--    `p.prosrc is null` to find routines whose body C1/C2 cannot read. **`pg_proc.prosrc` is declared
--    NOT NULL** (verified: pg_attribute.attnotnull = true), so that predicate can NEVER be true — a
--    check that cannot fire, in the migration complaining about checks that cannot fire. The real
--    test is `prosqlbody IS NOT NULL`: a standard-conforming `BEGIN ATOMIC` routine keeps its parsed
--    body there, and `prosrc` then holds no useful text, so C1 and C2 are structurally blind to it.
--    Zero such routines exist in this database today, so this starts clean and only speaks if the
--    blind spot becomes real. ("Graceful is not silent" — a known gap that emits no counter hides.)
--
-- 2. THE LIVENESS CLAIM WAS OVERSTATED, which is this project's most expensive bug class. The
--    previous header claimed that if pg_cron OR pg_net OR Telegram died, this watchdog's own silence
--    would be caught from outside. Only the FIRST is true. The out-of-band leg keys on a stale
--    `checked_at`, and `checked_at` only goes stale if the function stops RUNNING. If pg_net or
--    Telegram is dead the function still runs, still writes a fresh `checked_at`, and the DM fails
--    silently. Fixed two ways: the header now says what is actually covered, and the send goes
--    through `public.ops_net_post(...)` rather than a raw `net.http_post`, so a non-delivery lands in
--    `ops_http_failures` and is alarmed by the EXISTING `ops_http_failure_watchdog`. That primitive
--    also runs the URL through `ops_sanitize_url`, which rewrites `/bot<digits>:<token>` to
--    `/bot<redacted>` — so the bot token cannot be logged, which matters because this project has
--    already had a plaintext-bot-token-in-logs incident (20260913, PR #163).
--    WHAT IS COVERED, precisely: pg_cron stops → `checked_at` goes stale → hw_dm_health_stats()
--    counts it → the GitHub verifier exits non-zero → GitHub emails the owner. DM cannot be
--    delivered → `ops_http_failures` → `ops_http_failure_watchdog`. Neither leg depends on the other.
--
-- 3. `alert_path_proven: true` WAS A HARDCODED LITERAL asserting something the code never observed —
--    precisely the "metric nothing writes" failure this file claims to design out. It is replaced by
--    `dm_attempted` (how many admin sends were actually enqueued on THIS run) and a sticky
--    `dm_ever_attempted`. The first-run proof is now driven by `dm_ever_attempted` rather than "is the
--    state row absent", so if the bot token is missing or the loop finds no admin, the proof is NOT
--    consumed and the next run tries again. It can no longer claim a proof it did not get.
--
-- 4. A PERMANENTLY-BROKEN DETECTOR WAS INVISIBLE. The out-of-band scan counts EXISTING stale rows, so
--    if this function raised on every run the state row would never be created and the verifier would
--    see nothing at all. The deploy self-test's exception handler now writes a state row with
--    `checked_at = 'epoch'` — immediately and permanently stale — so a detector that cannot run is
--    flagged by the out-of-band leg on its next daily pass instead of hiding.
--
-- 5. A FUTURE `last_alert_ms` (clock skew, a hand-edited row) would make `_now_ms - _last_ms` negative
--    forever and suppress every re-alert. It is now clamped to `least(_last_ms, _now_ms)`.
--
-- 6. THE DM COULD EXCEED TELEGRAM'S 4096-CHARACTER LIMIT if many routines appeared at once, in which
--    case the send fails and the alarm is lost exactly when it matters most. The text is truncated.
--
-- ── KNOWN LIMITS, DOCUMENTED RATHER THAN PAPERED OVER ──
--
--   * IT WATCHES REACHABILITY, NOT BEHAVIOUR. The baseline stores signatures, so `CREATE OR REPLACE`
--     on an already-approved routine is invisible unless the new body trips C1/C2. Someone who can
--     already run DDL could swap a dossier dump into `staff_group_members` and this would stay quiet.
--     Detecting that means hashing bodies, which is a different (and much noisier) detector; the
--     author-time lint and code review are the right layers for it.
--   * THE BASELINE IS EDITABLE by anything holding the service key or an admin path to app_settings,
--     so the PRIMARY signal is silenceable by a sufficiently privileged actor. That is why C1/C2/C3
--     are computed from the catalog and never consult the baseline — those cannot be edited away.
--   * THE DEPLOY SELF-TEST CAN RACE the :17 cron tick, which could send the first-run informational DM
--     twice. One duplicate info message is not worth an advisory lock here.
--   * A DEAD HOURLY WATCHDOG can look healthy for up to ~49h: the threshold is 25h but the verifier
--     checks once a day. That is inherited from the shared liveness convention, not introduced here;
--     narrowing it would mean changing the threshold for all watchdogs at once.
--
-- ⚠️ OWNER ACTION, UNRELATED TO THIS FILE BUT IT BLUNTS THIS FILE'S OUT-OF-BAND LEG: from 2026-10-01
--    the GitHub verifier's "Credential expiry countdown" step exits 1 UNCONDITIONALLY every day
--    (.github/workflows/hw-dm-health.yml:114) because `OPS_GITHUB_PAT` expires 2026-10-10. A daily
--    workflow that is always red stops being read, and this watchdog's silence-detection depends on
--    that run being trustworthy. Regenerate the PAT before 2026-10-01 to keep the channel meaningful.
--
-- ── DESIGNED-OUT: BOTH OF THIS PROJECT'S PAST WATCHDOG FAILURES ──
--   * THE BLIND FLOOR. `xp_throughput_watchdog` had a minimum-baseline of 12 against a baseline of 10,
--     so NO value — including zero — could ever alert (fixed in 20260925043000). There is **no floor,
--     no minimum volume and no fixed threshold anywhere here.** Set membership has no scale to be
--     below. (Fix 1 above is the same disease caught in this very file, by review rather than by luck.)
--   * THE METRIC NOTHING WRITES. Every number comes from `pg_proc` + `has_function_privilege()` — the
--     authoritative catalog, which cannot read 0 because its writer broke. (Fix 3 removes the one
--     field that violated this.)
--   * `array_length` on an EMPTY array returns NULL, not 0, so a bare `> 0` yields NULL and recorded
--     `"alarm": null` — indistinguishable from "the check did not run". Every such comparison is
--     wrapped in coalesce(..., 0). Verified against the live database.
--
-- SCOPE: prokind in ('f','p') — functions AND procedures. PostgREST exposes both.
--
-- Idempotent + replay-safe: the baseline is inserted ONLY IF ABSENT (a replay, or a considered human
-- edit, is never clobbered); the function is CREATE OR REPLACE; the state row is an upsert;
-- cron.unschedule precedes cron.schedule so a retry cannot duplicate the job.

-- ── The ledgered baseline: the 27 accounted-for as of 2026-09-26 ──
-- VERIFIED before merge: these 27 literals set-difference to EXACTLY nothing against live
-- oid::regprocedure::text, in both directions. They were generated FROM the catalog rather than typed,
-- which is why `uuid[]` is not `_uuid`, `timestamp with time zone` is spelled out, and there are no
-- spaces after commas. One formatting mismatch would make that routine read as `unexpected` forever.
--
-- Exactly two are DELIBERATELY anon-callable and must stay: has_role (124 RLS policy expressions
-- across 63 tables, 151 pg_depend entries — revoking it once broke every policy that called it, see
-- 20260705110000) and get_public_setting (field-whitelisted, never returns the token). The other 25
-- are admin/staff RPCs WITH real callers, each already guarded in-body by has_role. Whether
-- `authenticated` should reach an admin endpoint at all is a product decision, deliberately left open.
insert into public.app_settings (key, value)
select 'anon_execute_watchdog_baseline', jsonb_build_object(
  'approved', jsonb_build_array(
    'admin_assign_group(uuid[],uuid)',
    'admin_change_role(uuid,text)',
    'admin_dashboard_students(uuid,timestamp with time zone)',
    'admin_duplicate_course(uuid,text)',
    'admin_export_group_csv(uuid,boolean)',
    'admin_list_users()',
    'admin_set_account_type(uuid,text)',
    'admin_set_enrollment_tier(uuid,uuid,uuid)',
    'admin_teacher_weekly(integer,uuid)',
    'get_public_setting(text)',
    'has_module_access(uuid,uuid)',
    'has_role(uuid,app_role)',
    'my_module_limit(uuid)',
    'nudge_cron_set_enabled(boolean)',
    're_engagement_eligible_count()',
    're_engagement_eligible_profiles()',
    'recalc_leaderboard()',
    'staff_count_lessons_by_storage_path(text,uuid)',
    'staff_get_lesson(uuid)',
    'staff_group_members(uuid)',
    'staff_group_overview(uuid)',
    'staff_list_pending_bunny()',
    'staff_list_students()',
    'staff_recent_auth_events(timestamp with time zone)',
    'staff_recent_lesson_progress(timestamp with time zone)',
    'start_homework_resubmission(uuid)',
    'student_assignable_homework()'
  ),
  'sealed_at', now(),
  'note', 'Set by 20260926140000. To approve a NEW anon-executable SECURITY DEFINER routine, add its oid::regprocedure signature here AND say why in the migration that adds it. Removing one is always safe. Editing this row CANNOT silence the C1/C2/C3 class checks, which read the catalog directly.')
where not exists (select 1 from public.app_settings where key = 'anon_execute_watchdog_baseline');

create or replace function public.anon_execute_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _baseline text[];
  _live text[];
  _unexpected text[];
  _closed text[];
  _vault_leaks text[];
  _settings_verbatim text[];
  _unreadable text[];
  _alarm boolean;
  _critical boolean;
  _report jsonb;
  _state jsonb; _alerting boolean; _last_ms bigint;
  _should_alert boolean := false; _recovered boolean := false;
  _never_proven boolean := false;
  _dm_attempted int := 0;
  _now_ms bigint := (extract(epoch from now())*1000)::bigint;
  _tok text; _admin record; _msg text; _req bigint;
begin
  select coalesce(array_agg(x order by x), array[]::text[]) into _baseline
  from public.app_settings s,
       jsonb_array_elements_text(coalesce(s.value->'approved','[]'::jsonb)) x
  where s.key = 'anon_execute_watchdog_baseline';

  -- The authoritative source: the live catalog, not a table some other job keeps fresh.
  select coalesce(array_agg(sig order by sig), array[]::text[]) into _live
  from (
    select p.oid::regprocedure::text as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and p.prokind in ('f','p')
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  ) s;

  select coalesce(array_agg(x order by x), array[]::text[]) into _unexpected
  from unnest(_live) x where not (x = any(_baseline));
  select coalesce(array_agg(x order by x), array[]::text[]) into _closed
  from unnest(_baseline) x where not (x = any(_live));

  -- C1 (critical, baseline-independent): the cron_service_key() shape.
  select coalesce(array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text), array[]::text[])
    into _vault_leaks
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and p.prokind in ('f','p')
    and has_function_privilege('anon', p.oid, 'EXECUTE')
    and coalesce(p.prosrc, '') ~* '(vault\.|decrypted_secret)';

  -- C2 (warning, baseline-independent, HEURISTIC): returns a settings row verbatim?
  select coalesce(array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text), array[]::text[])
    into _settings_verbatim
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and p.prokind in ('f','p')
    and has_function_privilege('anon', p.oid, 'EXECUTE')
    and coalesce(p.prosrc, '') ~* 'platform_settings'
    and coalesce(p.prosrc, '') !~* 'jsonb_build_object';

  -- C3: routines whose body C1/C2 CANNOT read. `prosqlbody is not null` — NOT `prosrc is null`,
  -- which can never be true because pg_proc.prosrc is declared NOT NULL. See header fix 1.
  select coalesce(array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text), array[]::text[])
    into _unreadable
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and p.prokind in ('f','p')
    and has_function_privilege('anon', p.oid, 'EXECUTE')
    and p.prosqlbody is not null;

  _critical := coalesce(array_length(_vault_leaks, 1), 0) > 0;
  _alarm := _critical
         or coalesce(array_length(_unexpected, 1), 0) > 0
         or coalesce(array_length(_settings_verbatim, 1), 0) > 0
         or coalesce(array_length(_unreadable, 1), 0) > 0;

  select value into _state from public.app_settings where key = 'anon_execute_watchdog_state';
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  -- Clamp a future timestamp: otherwise the re-alert arithmetic goes negative forever (header fix 5).
  _last_ms  := least(coalesce((_state->>'last_alert_ms')::bigint, 0), _now_ms);
  -- The first-run proof is keyed on whether a DM was EVER actually attempted, not on the row's
  -- absence — so a missing bot token or an empty admin list does not consume it (header fix 3).
  _never_proven := not coalesce((_state->>'dm_ever_attempted')::boolean, false);

  if _alarm then
    if (not _alerting) or (_now_ms - _last_ms > 21600000) then _should_alert := true; end if;
  elsif _alerting then
    _recovered := true;
  end if;

  if _should_alert or _recovered or _never_proven then
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if _tok is not null and _tok <> '' then
      if _critical then
        _msg := '🚨 XAVFSIZLIK: anon roli VAULT sirlarini oʻqiydigan funksiyani chaqira oladi: '
             || array_to_string(_vault_leaks, ', ')
             || E'\nBu cron_service_key() bilan bir xil sinf. Darhol REVOKE qiling.';
      elsif coalesce(array_length(_unexpected, 1), 0) > 0 then
        _msg := '⚠️ XAVFSIZLIK: anon uchun ochiq YANGI SECURITY DEFINER funksiya(lar): '
             || array_to_string(_unexpected, ', ')
             || E'\nBaseline da yoʻq — migratsiyada yoki DB drift orqali qoʻshilgan.';
      elsif coalesce(array_length(_settings_verbatim, 1), 0) > 0 then
        _msg := '⚠️ anon chaqira oladigan funksiya platform_settings ni butunligicha qaytarayotgan '
             || 'boʻlishi mumkin: ' || array_to_string(_settings_verbatim, ', ')
             || ' (evristika — tekshirib koʻring).';
      elsif coalesce(array_length(_unreadable, 1), 0) > 0 then
        _msg := '⚠️ anon uchun ochiq funksiya(lar) tanasi BEGIN ATOMIC — vault/platform_settings '
             || 'tekshiruvlari ularni KOʻRMAYDI: ' || array_to_string(_unreadable, ', ')
             || E'\nQoʻlda tekshiring.';
      elsif _recovered then
        _msg := '✅ anon-execute holati normallashdi ('
             || coalesce(array_length(_live, 1), 0) || ' ta funksiya, baseline ga mos).';
      end if;

      -- Never yet proven the alarm path: send something even on a clean surface, and say so.
      if _never_proven and _msg is null then
        _msg := 'ℹ️ anon-execute watchdog ishga tushdi: '
             || coalesce(array_length(_live, 1), 0) || ' ta anon-ochiq SECURITY DEFINER funksiya, '
             || 'baseline ga mos, ogohlantirish yoʻq. (Bu xabar alarm kanali ishlayotganini tasdiqlaydi.)';
      end if;

      if _msg is not null and _msg <> '' then
        for _admin in
          select distinct p.telegram_id from public.profiles p
          join public.user_roles r on r.user_id = p.id and r.role in ('admin','superadmin')
          where p.telegram_id is not null limit 3
        loop
          begin
            -- ops_net_post (NOT raw net.http_post): a non-delivery lands in ops_http_failures and is
            -- alarmed by ops_http_failure_watchdog, and ops_sanitize_url keeps the bot token out of
            -- the recorded URL. See header fix 2.
            -- left(_msg, 3900): Telegram rejects >4096 chars, which would lose the alarm exactly when
            -- the list is longest. See header fix 6.
            _req := public.ops_net_post(
              p_url     := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
              p_body    := jsonb_build_object('chat_id', _admin.telegram_id, 'text', left(_msg, 3900)),
              p_headers := jsonb_build_object('Content-Type','application/json'),
              p_purpose := 'anon_execute_watchdog',
              p_timeout_ms := 5000);
            _dm_attempted := _dm_attempted + 1;
          exception when others then null; end;
        end loop;
      end if;
    end if;
  end if;

  _report := jsonb_build_object(
    'live_count', coalesce(array_length(_live, 1), 0),
    'baseline_count', coalesce(array_length(_baseline, 1), 0),
    'unexpected', to_jsonb(_unexpected),
    'closed_since_baseline', to_jsonb(_closed),
    'vault_reachable_by_anon_CRITICAL', to_jsonb(_vault_leaks),
    'settings_verbatim_heuristic', to_jsonb(_settings_verbatim),
    'bodies_unreadable_by_class_checks', to_jsonb(_unreadable),
    'alarm', _alarm,
    'critical', _critical,
    'dm_attempted', _dm_attempted,
    'checked_at', now());

  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, case when _alarm then 'anon_execute_watchdog_ALARM' else 'anon_execute_report' end,
            _report);
  exception when others then null; end;

  insert into public.app_settings (key, value)
  values ('anon_execute_watchdog_state', jsonb_build_object(
    'alerting', _alarm,
    'last_alert_ms', case when _should_alert or _dm_attempted > 0 then _now_ms else _last_ms end,
    -- Observed, never asserted: sticky once a send has actually been enqueued.
    'dm_ever_attempted', (not _never_proven) or _dm_attempted > 0,
    'dm_attempted_last_run', _dm_attempted,
    'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return _report;
end;
$function$;

-- The house pattern, and the rule the author-time lint enforces: PUBLIC first, then service_role.
revoke execute on function public.anon_execute_watchdog() from public, anon, authenticated;
grant  execute on function public.anon_execute_watchdog() to service_role;

-- Hourly at :17, off the busy minute boundaries, well inside the 25h staleness window.
do $$
begin
  perform cron.unschedule('anon-execute-watchdog');
exception when others then null;
end $$;

do $$
begin
  perform cron.schedule('anon-execute-watchdog', '17 * * * *',
                        $cmd$ select public.anon_execute_watchdog() $cmd$);
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_schedule_failed',
          jsonb_build_object('job', 'anon-execute-watchdog', 'error', sqlerrm));
end $$;

-- Deploy self-test. Runs the watchdog for real, which is REQUIRED rather than optional: the liveness
-- scan counts EXISTING stale `%_watchdog_state` rows, so the row must exist from the moment this
-- lands or the watchdog reads as "never deployed" instead of "stale".
-- Catch-and-log rather than raise, because the watchdog is additive and rolling a detector back over
-- a transient pg_net hiccup is the wrong trade. But the handler ALSO seeds the state row with
-- checked_at = 'epoch' — immediately and permanently stale — so a detector that cannot run at all is
-- flagged by the out-of-band GitHub verifier on its next daily pass instead of being invisible to it.
-- See header fix 4. A later successful run overwrites this with a real timestamp.
do $$
begin
  perform public.anon_execute_watchdog();
exception when others then
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'anon_execute_watchdog_selftest_failed', jsonb_build_object('error', sqlerrm));
  exception when others then null; end;
  begin
    insert into public.app_settings (key, value)
    values ('anon_execute_watchdog_state', jsonb_build_object(
      'alerting', true,
      'selftest_failed', sqlerrm,
      'last_alert_ms', 0,
      'dm_ever_attempted', false,
      'checked_at', 'epoch'::timestamptz))
    on conflict (key) do update set value = excluded.value;
  exception when others then null; end;
end $$;
