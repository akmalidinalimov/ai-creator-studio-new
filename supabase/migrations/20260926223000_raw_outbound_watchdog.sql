-- DETECTOR for the "unattributed outbound HTTP" class (incident doctrine step 5 for 20260926210000).
--
-- WHY. 20260926210000 converted every raw net.http_post in public functions and cron jobs to
-- public.ops_net_post(), so every failure now names its caller. Before it, ops_http_failure_watchdog
-- fired 159 times as "403 × N unattributed" during the stale-project incident and nobody could tell
-- where the requests were going. Two author-time guards keep migrations from bringing raw calls back
-- (lint E8 fails a raw net.http_post; E10 stops a backdated file from skipping E8). NEITHER CAN SEE
-- DRIFT: a cron job created in the Supabase dashboard with `select net.http_post(...)` — which is how
-- the original 12 were made — or a function edited in the SQL editor never passes through the lint.
-- A repo grep is not authoritative for production state; this asks the catalog.
--
-- WHAT IT WATCHES, hourly at :23 (off the :00/:15/:17/:30 pile-ups):
--   PRIMARY (alarm): any public function (except ops_net_post itself) or ANY cron job — active or not,
--     so re-enabling a paused one is caught too — whose text contains a raw net.http_post call. The
--     pattern is the same broad one 20260926210000 verified: any case, whitespace OR comments between
--     the tokens, quoted identifiers. Set membership, not a threshold: there is no floor to sit under.
--     A BEGIN ATOMIC function keeps its body in prosqlbody, not prosrc, so both are read.
--     VERIFIED before merge: matches NOTHING today (0 functions, 0 jobs), so it does not cry wolf on
--     its first run — and it matched exactly the 25 functions + 12 jobs before the conversion, and not
--     the one function whose comment merely mentions net.http_post.
--   REPORT-ONLY: unattributed HTTP failures since the conversion (ops_http_failures.purpose IS NULL),
--     and the raw GET/DELETE jobs (bot-warmth-ping, a */4 keep-alive, is the one deliberate one).
--     These are DB-visible in the state row but do not alarm: pg_net records no URL for a raw call, so
--     an unattributed failure cannot be pinned on a caller — which is exactly why the primary check
--     reads the catalog instead. Verified: 0 unattributed failures since the conversion.
--
-- HOW IT ALERTS, and what covers its own failure (the anon_execute_watchdog pattern, 20260926140000):
--   * Admin DM through ops_net_post (never raw), so a non-delivery lands in ops_http_failures and is
--     alarmed by ops_http_failure_watchdog; ops_sanitize_url keeps the bot token out of the log.
--     Re-alerts at most every 6h while alarming; says so once when it recovers.
--   * The first run sends one informational DM so the alarm channel is PROVEN, not assumed; the proof
--     is "a DM was ever actually attempted", so a missing token or an empty admin list does not use it up.
--   * State row app_settings 'raw_outbound_watchdog_state' (checked_at every run): if pg_cron stops,
--     hw_dm_health_stats() counts it stale after 25h and the out-of-band GitHub verifier fails.
--   * admin_actions gets a row only on ALARM or RECOVERY — not 24 identical "all clear" rows a day.
--   * array_length() of an empty array is NULL; every comparison is coalesce(..., 0).
--
-- KNOWN LIMITS: only the public schema and cron.job are scanned (the one raw caller elsewhere today is
-- Supabase's own extensions.grant_pg_net_access). A raw call built dynamically ('net.http_' || 'post')
-- is invisible to any text scan; the report-only unattributed-failure count is the backstop for it.
--
-- Idempotent + replay-safe: CREATE OR REPLACE; state is an upsert; cron.unschedule precedes
-- cron.schedule so a retry cannot duplicate the job.

create or replace function public.raw_outbound_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  -- Same pattern 20260926210000 verified: any case; whitespace or comments between the tokens.
  _raw_re constant text := '(^|[^[:alnum:]_$])"?net"?(\s|--[^\r\n]*|/\*([^*]|\*+[^*/])*\*+/)*\.(\s|--[^\r\n]*|/\*([^*]|\*+[^*/])*\*+/)*"?http_post"?(\s|--[^\r\n]*|/\*([^*]|\*+[^*/])*\*+/)*\(';
  _fns text[];
  _jobs text[];
  _get_jobs text[];
  _since timestamptz;
  _unattributed int := 0;
  _alarm boolean;
  _report jsonb;
  _state jsonb; _alerting boolean; _last_ms bigint;
  _should_alert boolean := false; _recovered boolean := false;
  _never_proven boolean := false;
  _dm_attempted int := 0;
  _now_ms bigint := (extract(epoch from now())*1000)::bigint;
  _tok text; _admin record; _msg text; _req bigint;
begin
  select coalesce(array_agg(p.oid::regprocedure::text order by p.oid::regprocedure::text), array[]::text[])
    into _fns
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname <> 'ops_net_post'
    and (case when p.prosqlbody is not null then coalesce(pg_get_function_sqlbody(p.oid), '')
              else coalesce(p.prosrc, '') end) ~* _raw_re;

  select coalesce(array_agg(coalesce(j.jobname, 'jobid ' || j.jobid) order by j.jobid), array[]::text[])
    into _jobs
  from cron.job j
  where j.command ~* _raw_re;

  select coalesce(array_agg(coalesce(j.jobname, 'jobid ' || j.jobid) order by j.jobid), array[]::text[])
    into _get_jobs
  from cron.job j
  where j.command ~* '(^|[^[:alnum:]_$])"?net"?\s*\.\s*"?http_(get|delete)"?\s*\(';

  -- Unattributed failures since the conversion (report-only; see header).
  select greatest(coalesce(max((details->>'at')::timestamptz), now() - interval '24 hours'),
                  now() - interval '24 hours')
    into _since
  from public.admin_actions where action = 'outbound_http_attributed';
  select count(*) into _unattributed
  from public.ops_http_failures where purpose is null and occurred_at > _since;

  _alarm := coalesce(array_length(_fns, 1), 0) + coalesce(array_length(_jobs, 1), 0) > 0;

  select value into _state from public.app_settings where key = 'raw_outbound_watchdog_state';
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  -- Clamp a future timestamp, or the re-alert arithmetic goes negative forever.
  _last_ms  := least(coalesce((_state->>'last_alert_ms')::bigint, 0), _now_ms);
  _never_proven := not coalesce((_state->>'dm_ever_attempted')::boolean, false);

  if _alarm then
    if (not _alerting) or (_now_ms - _last_ms > 21600000) then _should_alert := true; end if;
  elsif _alerting then
    _recovered := true;
  end if;

  if _should_alert or _recovered or _never_proven then
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if _tok is not null and _tok <> '' then
      if _alarm then
        _msg := '⚠️ Kuzatuv: xom (attributsiz) net.http_post chaqiruvi paydo boʻldi. Uning xatolari '
             || '"unattributed" boʻlib keladi va qaysi funksiya yoki cron ekanini aytib boʻlmaydi.'
             || case when coalesce(array_length(_fns, 1), 0) > 0
                     then E'\nFunksiyalar: ' || array_to_string(_fns, ', ') else '' end
             || case when coalesce(array_length(_jobs, 1), 0) > 0
                     then E'\nCron: ' || array_to_string(_jobs, ', ') else '' end
             || E'\npublic.ops_net_post(p_purpose := ...) ga oʻtkazing (20260926210000 ga qarang).';
      elsif _recovered then
        _msg := '✅ Barcha tashqi HTTP chaqiruvlar yana ops_net_post orqali (attributsiyali).';
      end if;

      -- Never yet proven the alarm path: send something even when clean, and say so.
      if _never_proven and _msg is null then
        _msg := 'ℹ️ raw-outbound watchdog ishga tushdi: xom net.http_post chaqiruvi yoʻq (0 funksiya, '
             || '0 cron). Har bir tashqi HTTP xato endi kimdan kelganini koʻrsatadi. (Bu xabar alarm '
             || 'kanali ishlayotganini tasdiqlaydi.)';
      end if;

      if _msg is not null and _msg <> '' then
        for _admin in
          select distinct p.telegram_id from public.profiles p
          join public.user_roles r on r.user_id = p.id and r.role in ('admin','superadmin')
          where p.telegram_id is not null limit 3
        loop
          begin
            -- left(_msg, 3900): Telegram rejects >4096 chars, which would lose the alarm exactly when
            -- the list is longest.
            _req := public.ops_net_post(
              p_url     := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
              p_body    := jsonb_build_object('chat_id', _admin.telegram_id, 'text', left(_msg, 3900)),
              p_headers := jsonb_build_object('Content-Type','application/json'),
              p_purpose := 'raw_outbound_watchdog',
              p_timeout_ms := 5000);
            _dm_attempted := _dm_attempted + 1;
          exception when others then null; end;
        end loop;
      end if;
    end if;
  end if;

  _report := jsonb_build_object(
    'raw_post_functions', to_jsonb(_fns),
    'raw_post_cron_jobs', to_jsonb(_jobs),
    'raw_get_or_delete_cron_jobs', to_jsonb(_get_jobs),
    'unattributed_failures_since', _since,
    'unattributed_failures', _unattributed,
    'alarm', _alarm,
    'dm_attempted', _dm_attempted,
    'checked_at', now());

  if _alarm or _recovered then
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, case when _alarm then 'raw_outbound_watchdog_ALARM' else 'raw_outbound_watchdog_recovered' end,
              _report);
    exception when others then null; end;
  end if;

  insert into public.app_settings (key, value)
  values ('raw_outbound_watchdog_state', _report || jsonb_build_object(
    'alerting', _alarm,
    'last_alert_ms', case when _should_alert or _dm_attempted > 0 then _now_ms else _last_ms end,
    -- Observed, never asserted: sticky once a send has actually been enqueued.
    'dm_ever_attempted', (not _never_proven) or _dm_attempted > 0))
  on conflict (key) do update set value = excluded.value;

  return _report;
end;
$function$;

-- The house pattern, and the rule the author-time lint enforces: PUBLIC first, then service_role.
revoke execute on function public.raw_outbound_watchdog() from public, anon, authenticated;
grant  execute on function public.raw_outbound_watchdog() to service_role;

-- Hourly at :23, off the busy minute boundaries, well inside the 25h staleness window.
do $$
begin
  perform cron.unschedule('raw-outbound-watchdog');
exception when others then null;
end $$;

do $$
begin
  perform cron.schedule('raw-outbound-watchdog', '23 * * * *',
                        $cmd$ select public.raw_outbound_watchdog() $cmd$);
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_schedule_failed',
          jsonb_build_object('job', 'raw-outbound-watchdog', 'error', sqlerrm));
end $$;

-- Deploy run: REQUIRED, because the liveness scan counts EXISTING `%_watchdog_state` rows — the row
-- must exist from the moment this lands. Catch-and-log rather than raise (a detector is additive), but
-- the handler seeds the state row with checked_at = 'epoch', immediately stale, so a detector that
-- cannot run at all is flagged by the out-of-band verifier instead of being invisible to it.
do $$
begin
  perform public.raw_outbound_watchdog();
exception when others then
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'raw_outbound_watchdog_selftest_failed', jsonb_build_object('error', sqlerrm));
  exception when others then null; end;
  begin
    insert into public.app_settings (key, value)
    values ('raw_outbound_watchdog_state', jsonb_build_object(
      'alerting', true,
      'selftest_failed', sqlerrm,
      'last_alert_ms', 0,
      'dm_ever_attempted', false,
      'checked_at', 'epoch'::timestamptz))
    on conflict (key) do update set value = excluded.value;
  exception when others then null; end;
end $$;
