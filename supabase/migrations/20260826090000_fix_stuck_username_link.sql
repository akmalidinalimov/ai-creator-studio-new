-- Incident (2026-08-26): a paid 2-VIP student (@MEN_UZ05, telegram_id 8398953436) could not enter the
-- bot — every /start hit the username→telegram_id LINK gate and got "Этот бот только для студентов".
-- Root cause: his profile was matched only by telegram_username (telegram_id NULL — a pre-created
-- account), and the anti-squat gate that links username→telegram_id requires a live getChatMember
-- membership confirmation. His early attempts fell inside a 30-minute NEGATIVE-membership cache
-- (probed "not a member yet" right as he joined the group), so every retry in that window was refused.
-- He is a confirmed, active member of the 2-VIP 5.0 group (posts there under 8398953436; profile in
-- that published-course group; verified no other profile uses that telegram_id).
--
--   Part A — HEAL: link the confirmed student directly (guarded + idempotent) → bypasses the gate for good.
--   Part B — DETECT: a daily watchdog that flags a telegram_id refused many times in 24h WHILE STILL
--            UNLINKED — the signature of a real member stuck at the gate (not a one-off squatter), so
--            admins can verify + link them before a complaint.
-- The forward FIX (negative-membership cache 30m → 3m, so a just-joined member isn't locked out for
-- half an hour) ships in the same PR as a telegram-bot-webhook change.

-- ── Part A: link the confirmed student (guarded, idempotent, exception-safe) ─────────────────────
-- Exception-guarded so a concurrent-write unique_violation (profiles_telegram_id_unique) fails SAFE
-- and still lets Part B land, instead of aborting the whole migration transaction.
do $$
declare _collision int; _updated int;
begin
  -- Count OTHER profiles holding this id (exclude the target so a re-run isn't misread as a collision).
  select count(*) into _collision from public.profiles
   where telegram_id = 8398953436 and id <> '90415cd8-2ca2-4a22-9bc3-1c3d705d8d87';
  if _collision > 0 then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'profile_telegram_id_link_skipped',
      jsonb_build_object('telegram_id', 8398953436, 'reason', 'already_in_use', 'collisions', _collision));
  else
    begin
      update public.profiles
         set telegram_id = 8398953436,
             telegram_onboarded_at = coalesce(telegram_onboarded_at, now()),
             updated_at = now()
       where id = '90415cd8-2ca2-4a22-9bc3-1c3d705d8d87'
         and telegram_id is null;
      get diagnostics _updated = row_count;
      if _updated > 0 then                                   -- 0 on an idempotent re-run (already linked)
        insert into public.admin_actions (actor_user_id, action, target_user_id, details)
        values (null, 'profile_telegram_id_linked_admin', '90415cd8-2ca2-4a22-9bc3-1c3d705d8d87',
          jsonb_build_object('telegram_id', 8398953436, 'telegram_username', 'MEN_UZ05',
            'reason', 'incident_stuck_username_link_gate'));
      end if;
    exception when unique_violation then
      -- a concurrent write claimed 8398953436 between the check and the update → fail safe, keep Part B.
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'profile_telegram_id_link_skipped',
        jsonb_build_object('telegram_id', 8398953436, 'reason', 'unique_violation_race'));
    end;
  end if;
end $$;

-- ── Part B: "stuck at the link gate" detector ───────────────────────────────────────────────────
create or replace function public.username_link_stuck_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _tok text; _admin record; _stuck record; _stuck_list text := ''; _n int := 0;
  _state jsonb; _alerting boolean; _last_ms bigint;
  _now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  _should_alert boolean := false; _recovered boolean := false; _breached boolean; _msg text;
  _t_refused int := 5;   -- same telegram_id refused >=5x/24h WHILE STILL UNLINKED = a real member stuck
begin
  -- Distinct telegram_ids refused many times AND still without a linked profile = legitimate members
  -- locked out of the link gate (a one-off squatter doesn't retry 5+ times; a linked user won't refuse).
  -- NB: compare as TEXT (profiles.telegram_id::text) so the untrusted jsonb value is never cast to
  -- bigint — a malformed refusal payload can't error the query. The ~ '^[0-9]+$' guard keeps the
  -- grouped/displayed id numeric.
  for _stuck in
    select a.details->>'telegram_id' as tgid,
           coalesce(nullif(a.details->>'telegram_username',''), '?') as uname,
           count(*) as c
    from public.admin_actions a
    where a.action = 'username_link_refused'
      and a.created_at > now() - interval '24 hours'
      and a.details->>'telegram_id' ~ '^[0-9]+$'
      and not exists (select 1 from public.profiles p
                       where p.telegram_id::text = a.details->>'telegram_id')
    group by 1, 2
    having count(*) >= _t_refused
    order by count(*) desc
    limit 10
  loop
    _n := _n + 1;
    _stuck_list := _stuck_list || E'\n' || '• @' || _stuck.uname || ' (id ' || _stuck.tgid || ') — ' || _stuck.c || ' marta';
  end loop;
  _breached := (_n > 0);

  select value into _state from public.app_settings where key = 'username_link_stuck_watchdog_state';
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  _last_ms  := coalesce((_state->>'last_alert_ms')::bigint, 0);

  if _breached then
    if (not _alerting) or (_now_ms - _last_ms > 86400000) then _should_alert := true; end if;
  elsif _alerting then
    _recovered := true;
  end if;

  if _should_alert or _recovered then
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if _tok is not null and _tok <> '' then
      _msg := case
        when _recovered then '✅ Hisob ulanish darvozasi normallashdi: soʻnggi 24 soatda takror rad etilgan (ulanmagan) talaba yoʻq.'
        else '⚠️ Botga kira olmayotgan talaba(lar) — username↔Telegram ulanishi darvozada takror rad etildi (aslida guruh aʼzosi boʻlishi mumkin). Shaxsini tekshirib, Telegram ID sini qoʻlda ulang:' || _stuck_list
      end;
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
        exception when others then null;
        end;
      end loop;
    end if;
  end if;

  insert into public.app_settings (key, value) values ('username_link_stuck_watchdog_state', jsonb_build_object(
    'alerting', _breached,
    'last_alert_ms', case when _should_alert then _now_ms else _last_ms end,
    'stuck_count', _n, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('stuck_count', _n, 'breached', _breached, 'alerted', _should_alert, 'recovered', _recovered);
end;
$function$;

revoke execute on function public.username_link_stuck_watchdog() from public, anon, authenticated;
grant execute on function public.username_link_stuck_watchdog() to service_role;

-- Deploy-time self-test. Safe: Part A above linked @MEN_UZ05 first, so his tgid now HAS a profile and
-- is excluded from the stuck count → no alarm fires at apply for the very incident this migration heals.
do $$
begin
  perform public.username_link_stuck_watchdog();
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'username_link_stuck_watchdog_selftest_failed', jsonb_build_object('error', sqlerrm));
end $$;

-- Cron — daily 07:30 UTC (clear of the other daily watchdogs at 04:50–06:35). Idempotent.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'username-link-stuck-watchdog') then
    perform cron.unschedule('username-link-stuck-watchdog');
  end if;
  perform cron.schedule('username-link-stuck-watchdog', '30 7 * * *', 'select public.username_link_stuck_watchdog()');
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_schedule_failed', jsonb_build_object('job', 'username-link-stuck-watchdog', 'error', sqlerrm));
end $$;
