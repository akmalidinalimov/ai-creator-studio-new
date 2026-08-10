-- Tier-config watchdog — guards the VIP/PREM ↔ module-access invariant.
--
-- Prompted by a support case (student @AMuborakxon1997, VIP, reported seeing 5/8 modules). The config
-- was actually CORRECT (their stale client, not a data bug), and the fan-out audit found every 5.0
-- group correctly mapped. This detector makes sure it STAYS correct: it flags any VIP/PREM-named group
-- whose tier's module_limit contradicts its name — the real failure mode (a new VIP group left on the
-- Premium tier, a PREM group on an unlimited tier, or a name/tier mismatch).
--
-- Gating recap: course_tiers.module_limit caps how many modules (by position) a tier sees. VIP should
-- grant FULL access (limit NULL or >= the course's module count); PREM should be capped BELOW full.
-- Scope: only PUBLISHED (active) courses — a draft/unpublished course's groups are intentionally
-- ignored. Daily; DMs admins ONLY on a NEW/changed mismatch set (snapshot dedup, like
-- platform_anomaly_digest). Emits a DB-visible health signal (tier_config_health()) per the incident
-- doctrine. Detector logic validated read-only on prod 2026-08-10 (0 false positives on the clean
-- config; fires on real mismatches; word-boundary matches avoid "compressed"/"impression").

-- 1. Pure detector: one row per VIP/PREM-named group (published course) whose tier contradicts its name.
--    Name matching is word-boundary-anchored (\m) on both sides for symmetry / no substring false-hits.
create or replace function public.tier_config_mismatches()
returns table(group_id uuid, group_name text, course_title text, tier_name text,
              module_limit int, course_modules int, issue text)
language sql
stable
security definer
set search_path = public
as $fn$
  with base as (
    select g.id as gid, g.name as gname, c.title as ctitle,
           ct.id as tid, coalesce(ct.name, '(none)') as tname, ct.module_limit as mlim,
           (select count(*)::int from modules m where m.course_id = g.course_id) as cm
    from groups g
    join courses c on c.id = g.course_id and c.published
    left join course_tiers ct on ct.id = g.tier_id
    where g.name ~* '\mvip' or g.name ~* '\mpre'
  ),
  flagged as (
    select gid, gname, ctitle, tname, mlim, cm,
      case
        when gname ~* '\mvip' and tid is null                    then 'VIP group has no tier (no gating)'
        when gname ~* '\mvip' and tname !~* 'vip'                then 'VIP group on non-VIP tier: ' || tname
        when gname ~* '\mvip' and mlim is not null and mlim < cm then 'VIP capped below full (' || mlim || '/' || cm || ')'
        when gname ~* '\mpre' and tid is null                    then 'PREM group has no tier (full access)'
        when gname ~* '\mpre' and tname ~* 'vip'                 then 'PREM group on VIP tier'
        when gname ~* '\mpre' and mlim is null                   then 'PREM group has unlimited access'
        when gname ~* '\mpre' and mlim >= cm                     then 'PREM not capped below full (' || mlim || '/' || cm || ')'
        else null
      end as issue
    from base
  )
  select gid, gname, ctitle, tname, mlim, cm, issue
  from flagged
  where issue is not null
  order by gname;
$fn$;
revoke execute on function public.tier_config_mismatches() from public, anon, authenticated;

-- 2. Health signal (DB-visible; for the daily digest / external verifier — wiring is a fast-follow).
create or replace function public.tier_config_health()
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select jsonb_build_object(
    'mismatches', (select count(*) from public.tier_config_mismatches()),
    'checked_at', now(),
    'detail', (select coalesce(jsonb_agg(jsonb_build_object('group', group_name, 'issue', issue)), '[]'::jsonb)
               from public.tier_config_mismatches())
  );
$fn$;
revoke execute on function public.tier_config_health() from public, anon, authenticated;

-- 3. Watchdog: alert admins on a NEW/changed mismatch set; silent when clean or unchanged.
create or replace function public.tier_config_watchdog()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  _cur jsonb; _prev jsonb; _n int := 0; _rows text := '';
  _tok text; _admin record; _sent int := 0;
begin
  select coalesce(jsonb_agg(jsonb_build_object('g', group_id, 'i', issue) order by group_id), '[]'::jsonb),
         count(*),
         string_agg('• ' || group_name || ' — ' || issue, E'\n' order by group_name)
    into _cur, _n, _rows
  from public.tier_config_mismatches();

  -- snapshot dedup — persist the current set, only alert when it changed since last time
  select value into _prev from platform_settings where key = 'tier_config_snapshot';
  insert into platform_settings (key, value, updated_at)
  values ('tier_config_snapshot', _cur, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();

  if _n = 0 then return 0; end if;                              -- all good → silent
  if _prev is not null and _prev = _cur then return 0; end if;  -- unchanged since last alert → no repeat

  select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
  if _tok is null or _tok = '' then return 0; end if;

  for _admin in
    select distinct p.telegram_id from profiles p
    join user_roles r on r.user_id = p.id and r.role in ('admin', 'superadmin')
    where p.telegram_id is not null
    limit 3
  loop
    begin
      perform net.http_post(
        url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('chat_id', _admin.telegram_id,
          'text', '⚠️ Tarif sozlamasi muammosi (' || _n || '):' || E'\n' || _rows ||
                  E'\n\nVIP = barcha modullar, PREM = cheklangan bo''lishi kerak.' ||
                  E'\nTekshiring: groups.tier_id / course_tiers.module_limit.'));
      _sent := _sent + 1;
    exception when others then null; end;
  end loop;

  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'tier_config_watchdog_alert', jsonb_build_object('n', _n, 'sent', _sent, 'issues', _rows, 'at', now()));
  exception when others then null; end;

  return _sent;
end;
$$;
revoke execute on function public.tier_config_watchdog() from public, anon, authenticated;

-- 4. Schedule daily (05:50 UTC, offset from enrollment/attribution watchdogs) + prime the snapshot once
--    (silent on the current clean config). The prime is wrapped so a failure can't roll back the file.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'tier-config-watchdog') then
    perform cron.unschedule('tier-config-watchdog');
  end if;
  perform cron.schedule('tier-config-watchdog', '50 5 * * *', $cmd$ select public.tier_config_watchdog() $cmd$);

  begin
    perform public.tier_config_watchdog();
  exception when others then
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'tier_config_watchdog_prime_failed', jsonb_build_object('error', sqlerrm, 'at', now()));
    exception when others then null; end;
  end;
end $$;
