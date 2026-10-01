-- DETECTOR for the production FRONTEND deploy (Vercel) — incident 2026-09-30 → 10-01 (prevention hierarchy layer 5).
--
-- ═══ WHAT HAPPENED (verified 2026-10-01 02:50 UTC from GitHub's commit statuses and deployments) ═══
-- The Vercel production builds of main FAILED for four merges in a row: 148fe16 (#241), 21b8cdc (#242), a92bfcd (#243)
-- and b575fce (#244), each with the commit status context "Vercel", state "failure", description "Deployment rate
-- limited — retry in 24 hours.". The last successful production build is afe750e (#232). So since ~19:55 UTC on
-- 2026-09-30 the live website (www.aicreator.academy, which is also the Telegram Mini App) has been frozen at afe750e,
-- while Supabase (edge functions + migrations, deployed by GitHub Actions) moved on to b575fce.
-- Root cause: Vercel's Hobby plan allows 100 deployments a day. On 2026-09-30 GitHub recorded 133 Vercel deployments:
-- 110 Preview (agent PR branches, one per push) and 23 Production. The previews used the quota up; production then
-- failed SILENTLY — nothing in the database, no alert, only a red status on a commit nobody was looking at.
--
-- ═══ THE FIX OF THE CLASS (same PR, not SQL) ═══
-- vercel.json "git": {"deploymentEnabled": {"main": true, "**": false}} — only main is built; no branch can spend the
-- production quota again. This migration is the DETECTOR for everything that can still go wrong with that one build.
--
-- ═══ WHAT THIS MIGRATION DOES ═══
-- 1. cron 'frontend-deploy-watchdog', every 15 min at :07/:22/:37/:52 (off canary-15min's :00/:15/:30/:45), calls the
--    edge function frontend-deploy-watchdog through public.ops_net_post with the same headers as canary-15min:
--    Content-Type, apikey + Bearer cron_service_key() (the function has no config.toml entry → gateway verify_jwt
--    default, like canary), x-internal-secret (verifyInternalSecret). The function reads main's newest commits and their
--    "Vercel" commit status with the Vault OPS_GITHUB_PAT and alarms the admins (sendTelegram, up to 3 admins /
--    superadmins with a telegram_id — the challenge_tasks_admin_dm() recipients) when the newest main commit's build
--    FAILED (quota or build error) or is pending / absent more than 30 min after the commit (STALLED). One alarm per
--    incident (deduped per sha in the state AND in admin_actions), a recovery DM only after an alarm. Rows:
--    frontend_deploy_failed / frontend_deploy_stalled / frontend_deploy_recovered, and once a Tashkent day each when it
--    cannot see: frontend_deploy_watch_no_pat / _forbidden / _api_error / _crashed (graceful is not silent; _forbidden
--    also DMs, because only a human can widen the token).
-- 2. Seeds app_settings 'frontend_deploy_watchdog_state'. The edge function overwrites it on EVERY run with
--    {checked_at, state, sha, lag, live_sha, alerting, ...}. Its name matches hw_dm_health_stats()'s liveness scan,
--    which is DERIVED (key like '%\_watchdog\_state', checked_at older than 25 h → stale_watchdogs > 0 → the out-of-band
--    GitHub verifier fails). Verified live 2026-10-01: that scan reads app_settings dynamically, so this watchdog is
--    covered without touching hw_dm_health_stats() (pinned by PR #234). The seed matters: a row that is never
--    refreshed (function not deployed, or 401 at the gateway) goes stale and trips the verifier.
-- 3. A read-only deploy self-test (catalog only): it never calls the edge function, never calls ops_github_pat() (that
--    returns the secret), never sends anything and needs no JWT. Any failed check raises, so the whole file rolls back.
-- 4. One audit row (frontend_deploy_watchdog_installed), written once.
--
-- No new SQL function, table or view: the work is in the edge function, the state lives in app_settings (RLS: admin
-- only). So there is nothing to grant; the self-test instead asserts that the one privileged function the edge function
-- depends on, public.ops_github_pat(), is still service_role-only (not executable by anon or authenticated).
--
-- INERT-SAFE: with no OPS_GITHUB_PAT in Vault the edge function records 'frontend_deploy_watch_no_pat' once a day,
-- stamps the state, and does nothing else. (Verified 2026-10-01: the secret IS present; whether the fine-grained token
-- may read COMMIT STATUSES is unknown — if not, GitHub answers 403 and the function DMs the admins once a day naming
-- the missing permission, 'Commit statuses: Read-only'. The owner widens the token on GitHub; Vault needs no change.)
--
-- KILL-SWITCH: select cron.unschedule('frontend-deploy-watchdog');

-- 1. The cron job (re-runnable: drop an earlier copy first).
do $$
begin
  perform cron.unschedule('frontend-deploy-watchdog');
exception when others then null;
end $$;

do $$
begin
  perform cron.schedule('frontend-deploy-watchdog', '7,22,37,52 * * * *', $cmd$
    select public.ops_net_post(
      p_url := 'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/frontend-deploy-watchdog',
      p_body := '{}'::jsonb,
      p_headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'apikey', public.cron_service_key(),
        'Authorization', 'Bearer ' || public.cron_service_key(),
        'x-internal-secret', public.internal_fn_secret()),
      p_purpose := 'frontend-deploy-watchdog',
      p_timeout_ms := 60000)
  $cmd$);
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_schedule_failed', jsonb_build_object('job', 'frontend-deploy-watchdog', 'error', sqlerrm));
end $$;

-- 2. The liveness row (the edge function replaces the value on every run).
insert into public.app_settings (key, value)
values ('frontend_deploy_watchdog_state', jsonb_build_object(
  'checked_at', now(),
  'state', 'seeded',
  'alerting', false,
  'seeded_by', '20261001030000'))
on conflict (key) do nothing;

-- 3 + 4. Read-only self-test, then the audit row.
do $selftest$
declare
  _cmd     text;
  _sched   text;
  _active  boolean;
  _checked timestamptz;
  _pat     boolean;
begin
  select command, schedule, active into _cmd, _sched, _active
    from cron.job where jobname = 'frontend-deploy-watchdog';
  if _cmd is null then
    raise exception 'ABORT: cron job frontend-deploy-watchdog was not scheduled (see admin_actions cron_schedule_failed)';
  end if;
  if _sched <> '7,22,37,52 * * * *' or not coalesce(_active, false) then
    raise exception 'ABORT: cron job frontend-deploy-watchdog has schedule % / active %', _sched, _active;
  end if;
  if position('public.ops_net_post(' in _cmd) = 0
     or position('''Content-Type'', ''application/json''' in _cmd) = 0
     or position('public.cron_service_key()' in _cmd) = 0
     or position('''x-internal-secret'', public.internal_fn_secret()' in _cmd) = 0
     or position('https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/frontend-deploy-watchdog' in _cmd) = 0
     or position('net.http_' in _cmd) > 0 then
    raise exception 'ABORT: cron job frontend-deploy-watchdog does not call ops_net_post with the expected URL and headers';
  end if;

  -- What the cron command and the edge function call must exist.
  if to_regprocedure('public.ops_net_post(text, jsonb, jsonb, text, integer)') is null
     or to_regprocedure('public.cron_service_key()') is null
     or to_regprocedure('public.internal_fn_secret()') is null
     or to_regprocedure('public.ops_github_pat()') is null then
    raise exception 'ABORT: ops_net_post / cron_service_key / internal_fn_secret / ops_github_pat missing';
  end if;

  -- ops_github_pat() returns a credential: service_role only (the edge function's client), never anon / authenticated.
  if has_function_privilege('anon', 'public.ops_github_pat()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ops_github_pat()', 'EXECUTE') then
    raise exception 'ABORT: public.ops_github_pat() is executable by anon or authenticated';
  end if;
  if not has_function_privilege('service_role', 'public.ops_github_pat()', 'EXECUTE') then
    raise exception 'ABORT: service_role cannot execute public.ops_github_pat() — the watchdog would be blind';
  end if;

  -- The liveness row exists, is on the scanned naming convention, and its checked_at casts.
  select (value->>'checked_at')::timestamptz into _checked
    from public.app_settings where key = 'frontend_deploy_watchdog_state';
  if _checked is null or 'frontend_deploy_watchdog_state' not like '%\_watchdog\_state' then
    raise exception 'ABORT: app_settings frontend_deploy_watchdog_state missing or without a valid checked_at';
  end if;

  -- Presence only (metadata, never the value): recorded so the audit row says whether the watchdog starts dormant.
  begin
    select exists (select 1 from vault.secrets where name = 'OPS_GITHUB_PAT') into _pat;
  exception when others then
    _pat := null;
  end;

  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'frontend_deploy_watchdog_installed',
         jsonb_build_object(
           'migration', '20261001030000',
           'cron_job', 'frontend-deploy-watchdog',
           'schedule', _sched,
           'edge_function', 'frontend-deploy-watchdog',
           'state_key', 'frontend_deploy_watchdog_state',
           'pat_present', _pat,
           'why', 'Vercel production builds of main failed silently (Hobby quota used up by preview builds, '
                  || '2026-09-30: 4 merges, #241-#244, never reached the live site)',
           'at', now())
  where not exists (select 1 from public.admin_actions where action = 'frontend_deploy_watchdog_installed');
end $selftest$;
