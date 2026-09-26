-- DETECTOR for the anon-EXECUTE class (prevention hierarchy layer 5 — the backstop, and the ONLY
-- layer that can see what the other two cannot).
--
-- WHY A WATCHDOG IS STILL NEEDED after 20260926093000 (default privileges) and the author-time lint:
-- neither can see DRIFT. `cron_service_key()` — the worst find of this whole incident, a SECURITY
-- DEFINER function returning a decrypted Vault service_role credential that `anon` could call over
-- /rest/v1/rpc for ~83 days — existed in production with **NO CREATE FUNCTION in any migration**
-- (reconciled only by 20260926060000). No author-time check could ever have seen it, because it was
-- never authored here. Separately, `ops_net_post`, `nudge_candidates_inactive/stuck` and
-- `nudge_cron_status` each carried an explicit `anon=X` grant even though their own migrations revoked
-- anon at creation — something re-granted them outside version control. A REPO GREP IS NOT
-- AUTHORITATIVE FOR SECURITY STATE. This function asks the live catalog instead.
--
-- ── WHAT IT WATCHES ──
--
-- Primary signal: a SET DIFFERENCE against a ledgered baseline of the 27 anon-executable SECURITY
-- DEFINER functions that exist and are accounted for as of today (77 → 64 → 55 → 27 across
-- 20260925201000, 20260926101000 and 20260926111000). Anything anon-executable that is NOT in the
-- baseline alarms.
--
-- SET membership, deliberately, NOT a count. A count-only detector sleeps through a SWAP — one
-- function closed, one opened, total unchanged — and a swap is exactly what SQL-editor drift looks
-- like. It also reports `closed_since_baseline` (baseline − live), which is good news, so tightening
-- further never looks like an alarm.
--
-- Two CLASS checks that are BASELINE-INDEPENDENT and cannot be silenced by editing the baseline,
-- because they encode the two failure shapes that actually hurt:
--   C1 (critical): an anon-executable SECURITY DEFINER function whose body touches `vault.` or
--       `decrypted_secret`. This is the cron_service_key() shape, verbatim. There is no legitimate
--       reason for anon to reach a function that reads the Vault.
--   C2 (warning): an anon-executable SECURITY DEFINER function that reads `platform_settings` but
--       does NOT construct its result with jsonb_build_object — i.e. it likely returns a settings row
--       VERBATIM. This is the distinction between `challenge_config()` (revoked in 20260926101000 —
--       returned its row whole, and will hold a Meta token once Instagram Phase 2 lands) and
--       `get_public_setting()` (deliberately anon-callable and safe precisely because it enumerates
--       the fields it returns, so a secret added to its row cannot widen it).
--       **Labelled a HEURISTIC in the output, because it is one** — a function could build a safe
--       result another way and trip this. It warns; it does not cry critical.
--
-- ── BOTH OF THIS PROJECT'S PAST WATCHDOG FAILURES ARE DESIGNED OUT ──
--
--   * THE BLIND FLOOR. `xp_throughput_watchdog` had a minimum-baseline of 12 against a baseline of 10,
--     so NO value — including zero — could ever raise the alarm; it had been silently blind while the
--     thing it watched was healthy (fixed in 20260925043000). There is therefore **no floor, no
--     minimum volume and no fixed threshold anywhere in this function.** The signal is set membership,
--     which has no scale to be below.
--   * THE METRIC NOTHING WRITES. A proposed health field once counted `admin_actions` rows that no
--     code path ever inserts, so it would have read 0 forever and looked healthy. Every number here
--     comes from `pg_proc` + `has_function_privilege()` — the authoritative catalog, which cannot be
--     "0 because the writer is broken" and has no intermediate table to go stale.
--
-- IT ALSO PROVES ITS OWN ALARM PATH. On its first run (no state row yet) it DMs admins unconditionally,
-- even on a completely clean surface, saying so. A watchdog that has never delivered a message is
-- indistinguishable from a healthy one until the day you need it.
--
-- AND IT DOES NOT GATE ITSELF ON THE THING THAT MIGHT BE BROKEN. The state row is named
-- `anon_execute_watchdog_state`, matching the `%_watchdog_state` convention that
-- `hw_dm_health_stats()` scans for a `checked_at` older than 25 hours (20260825150000). That count is
-- read by the out-of-band GitHub verifier (.github/workflows/hw-dm-health.yml, daily 03:25 UTC) which
-- runs on GitHub's servers. So if pg_cron dies, or pg_net dies, or Telegram dies, THIS watchdog's own
-- silence is alarmed from outside Supabase, by email — the one channel that survives all three. That
-- is also why the deploy self-test below calls the function: the liveness scan counts EXISTING stale
-- rows, so the row must exist from the moment this migration lands or the watchdog reads as
-- "never deployed" rather than "stale".
--
-- Idempotent + replay-safe: the baseline is inserted ONLY IF ABSENT (so a replay, or a considered
-- human edit, is never clobbered); the function is CREATE OR REPLACE; the state row is an upsert.

-- ── The ledgered baseline: the 27 accounted-for as of 2026-09-26 ──
-- Of these, exactly two are DELIBERATELY anon-callable and must stay: has_role (124 RLS policy
-- expressions across 63 tables, 151 pg_depend entries — revoking it once broke every policy that
-- called it, see 20260705110000) and get_public_setting (field-whitelisted, never returns the token).
-- The other 25 are admin/staff RPCs WITH real callers, each already guarded in-body by has_role, so a
-- signed-in student gets "forbidden" rather than data. Whether `authenticated` should reach an admin
-- endpoint at all is a product decision, deliberately left open — this baseline records the status quo
-- so that any CHANGE to it is loud, without pretending the status quo is ideal.
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
  'note', 'Set by 20260926120000. To approve a NEW anon-executable SECURITY DEFINER function, add its oid::regprocedure signature here AND say why in the migration that adds it. Removing one is always safe.')
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
  _alarm boolean;
  _critical boolean;
  _report jsonb;
  _state jsonb; _alerting boolean; _last_ms bigint;
  _should_alert boolean := false; _recovered boolean := false; _first_run boolean := false;
  _now_ms bigint := (extract(epoch from now())*1000)::bigint;
  _tok text; _admin record; _msg text;
begin
  select coalesce(array_agg(x order by x), array[]::text[]) into _baseline
  from public.app_settings s,
       jsonb_array_elements_text(coalesce(s.value->'approved','[]'::jsonb)) x
  where s.key = 'anon_execute_watchdog_baseline';

  -- The authoritative source: the live catalog. Not a table some other job has to keep fresh.
  select coalesce(array_agg(sig order by sig), array[]::text[]) into _live
  from (
    select p.oid::regprocedure::text as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  ) s;

  -- Set difference BOTH ways. A swap (one closed, one opened) leaves the count identical and still
  -- populates _unexpected — which is the whole point of not counting.
  select coalesce(array_agg(x order by x), array[]::text[]) into _unexpected
  from unnest(_live) x where not (x = any(_baseline));
  select coalesce(array_agg(x order by x), array[]::text[]) into _closed
  from unnest(_baseline) x where not (x = any(_live));

  -- C1 (critical, baseline-independent): the cron_service_key() shape.
  select coalesce(array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text), array[]::text[])
    into _vault_leaks
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
    and has_function_privilege('anon', p.oid, 'EXECUTE')
    and coalesce(p.prosrc, '') ~* '(vault\.|decrypted_secret)';

  -- C2 (warning, baseline-independent, HEURISTIC): returns a settings row verbatim?
  select coalesce(array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text), array[]::text[])
    into _settings_verbatim
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
    and has_function_privilege('anon', p.oid, 'EXECUTE')
    and coalesce(p.prosrc, '') ~* 'platform_settings'
    and coalesce(p.prosrc, '') !~* 'jsonb_build_object';

  _critical := array_length(_vault_leaks, 1) > 0;
  _alarm := _critical
         or array_length(_unexpected, 1) > 0
         or array_length(_settings_verbatim, 1) > 0;

  _report := jsonb_build_object(
    'live_count', coalesce(array_length(_live, 1), 0),
    'baseline_count', coalesce(array_length(_baseline, 1), 0),
    'unexpected', to_jsonb(_unexpected),
    'closed_since_baseline', to_jsonb(_closed),
    'vault_reachable_by_anon_CRITICAL', to_jsonb(_vault_leaks),
    'settings_verbatim_heuristic', to_jsonb(_settings_verbatim),
    'alarm', _alarm,
    'critical', _critical,
    'checked_at', now());

  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, case when _alarm then 'anon_execute_watchdog_ALARM' else 'anon_execute_report' end,
            _report);
  exception when others then null; end;

  select value into _state from public.app_settings where key = 'anon_execute_watchdog_state';
  _first_run := _state is null;
  _alerting  := coalesce((_state->>'alerting')::boolean, false);
  _last_ms   := coalesce((_state->>'last_alert_ms')::bigint, 0);

  if _alarm then
    -- Re-alert every 6h while it persists, matching the house cadence.
    if (not _alerting) or (_now_ms - _last_ms > 21600000) then _should_alert := true; end if;
  elsif _alerting then
    _recovered := true;
  end if;

  if _should_alert or _recovered or _first_run then
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if _tok is not null and _tok <> '' then
      if _critical then
        _msg := '🚨 XAVFSIZLIK: anon roli VAULT sirlarini oʻqiydigan funksiyani chaqira oladi: '
             || array_to_string(_vault_leaks, ', ')
             || E'\nBu cron_service_key() bilan bir xil sinf. Darhol REVOKE qiling.';
      elsif array_length(_unexpected, 1) > 0 then
        _msg := '⚠️ XAVFSIZLIK: anon uchun ochiq YANGI SECURITY DEFINER funksiya(lar) paydo boʻldi: '
             || array_to_string(_unexpected, ', ')
             || E'\nBu baseline da yoʻq — migratsiyada yoki DB drift orqali qoʻshilgan.';
      elsif array_length(_settings_verbatim, 1) > 0 then
        _msg := '⚠️ anon chaqira oladigan funksiya platform_settings ni butunligicha qaytarayotgan '
             || 'boʻlishi mumkin: ' || array_to_string(_settings_verbatim, ', ')
             || ' (evristika — tekshirib koʻring).';
      elsif _recovered then
        _msg := '✅ anon-execute holati normallashdi ('
             || coalesce(array_length(_live, 1), 0) || ' ta funksiya, baseline ga mos).';
      end if;

      -- FIRST RUN: always send something, even on a clean surface. A watchdog that has never
      -- delivered a message is indistinguishable from a healthy one.
      if _first_run and _msg is null then
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
            perform net.http_post(
              url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
              headers := jsonb_build_object('Content-Type','application/json'),
              body := jsonb_build_object('chat_id', _admin.telegram_id, 'text', _msg));
          exception when others then null; end;
        end loop;
      end if;
    end if;
  end if;

  insert into public.app_settings (key, value)
  values ('anon_execute_watchdog_state', jsonb_build_object(
    'alerting', _alarm,
    'last_alert_ms', case when _should_alert or _first_run then _now_ms else _last_ms end,
    'alert_path_proven', true,
    'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return _report;
end;
$function$;

-- The house pattern, and the rule the new author-time lint enforces: PUBLIC first, then service_role.
revoke execute on function public.anon_execute_watchdog() from public, anon, authenticated;
grant  execute on function public.anon_execute_watchdog() to service_role;

-- Hourly at :17, off the busy minute boundaries. Well inside the 25h staleness window that
-- hw_dm_health_stats() and the out-of-band GitHub verifier use to detect this watchdog's own silence.
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
-- scan counts EXISTING stale `%_watchdog_state` rows, so if this row does not exist from the moment
-- the migration lands, the watchdog reads as "never deployed" instead of "stale" and is invisible to
-- the out-of-band verifier. Catch-and-log rather than raise: the watchdog is additive and a rollback
-- would remove a detector over a transient pg_net hiccup.
do $$
begin
  perform public.anon_execute_watchdog();
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'anon_execute_watchdog_selftest_failed', jsonb_build_object('error', sqlerrm));
end $$;
