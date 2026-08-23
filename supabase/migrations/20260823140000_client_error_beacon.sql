-- Client error/health beacon — the missing client-tier signal in the reliability architecture.
-- Browser-side failures (render crashes, 404'd lazy chunks, backend-unreachable fetches, video-player
-- failures) leave no server-side trace, so every incident this session was found only via a student
-- complaint. This adds the DB side: a table the client beacons into (via the /sb same-origin edge
-- function, so it lands even when the client can't reach supabase.co directly) + a detect-only watchdog
-- + a prune job. Spec: docs/superpowers/specs/2026-08-23-client-error-beacon-design.md.

create table if not exists public.client_error_events (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  event_type  text not null check (event_type in
                 ('chunk_load','render_crash','unhandled_error','unhandled_rejection','backend_unreachable','video_error','other')),
  message     text,
  route       text,
  user_id     uuid,              -- nullable: anon (logged-out) beacons are allowed
  session_id  text,              -- client-generated (or ip-fallback); the impact unit the watchdog counts
  app_version text,
  user_agent  text,
  extra       jsonb
);
create index if not exists idx_client_error_events_created on public.client_error_events (created_at);
create index if not exists idx_client_error_events_type_created on public.client_error_events (event_type, created_at);

alter table public.client_error_events enable row level security;
-- Admin-read only; inserts happen ONLY via the client-beacon edge function (service_role bypasses RLS).
-- No insert/select policy for anon/authenticated → never PostgREST-writable or -readable.
drop policy if exists "client_error_events admin read" on public.client_error_events;
create policy "client_error_events admin read" on public.client_error_events
  for select using (public.has_role(auth.uid(), 'admin'));

-- ------------------------------------------------------------------------------------------------
-- Watchdog: hourly-ish scan; reports the last-hour breakdown every run (admin_actions), DMs admins
-- only on an egregious spike. Impact is measured in distinct SESSIONS (present even for anon/ip-fallback
-- beacons); distinct users are also reported for attribution. Thresholds tuned so a normal post-deploy
-- chunk trickle (which the client auto-recovers) does NOT alarm; a sustained/large spike does. Detect-only.
create or replace function public.client_error_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _since timestamptz := now() - interval '1 hour';
  _chunk int; _crash int; _backend int; _video int; _unhandled int; _other int; _total int;
  _s_chunk int; _s_backend int; _s_video int; _s_crash int; _s_unhandled int;   -- distinct-session spike signals
  _u_chunk int; _u_backend int;                                                 -- distinct-user attribution
  _report jsonb; _alarm boolean; _tok text; _admin record; _msg text;
  _state jsonb; _alerting boolean; _last_ms bigint;
  _now_ms bigint := (extract(epoch from now())*1000)::bigint;
  _should_alert boolean := false; _recovered boolean := false;
begin
  select
    count(*) filter (where event_type='chunk_load'),
    count(*) filter (where event_type='render_crash'),
    count(*) filter (where event_type='backend_unreachable'),
    count(*) filter (where event_type='video_error'),
    count(*) filter (where event_type in ('unhandled_error','unhandled_rejection')),
    count(*) filter (where event_type='other'),
    count(*),
    count(distinct session_id) filter (where event_type='chunk_load'),
    count(distinct session_id) filter (where event_type='backend_unreachable'),
    count(distinct session_id) filter (where event_type='video_error'),
    count(distinct session_id) filter (where event_type='render_crash'),
    count(distinct session_id) filter (where event_type in ('unhandled_error','unhandled_rejection')),
    count(distinct user_id) filter (where event_type='chunk_load' and user_id is not null),
    count(distinct user_id) filter (where event_type='backend_unreachable' and user_id is not null)
  into _chunk,_crash,_backend,_video,_unhandled,_other,_total,
       _s_chunk,_s_backend,_s_video,_s_crash,_s_unhandled,_u_chunk,_u_backend
  from public.client_error_events where created_at > _since;

  -- Thresholds (tunable): a real problem, not normal post-deploy churn. Covers EVERY event class incl.
  -- unhandled_* (a mass JS crash) and a raw-volume floor (catches an 'other'/garbage flood or abuse).
  _alarm := (_s_chunk > 25) or (_s_backend > 10) or (_s_crash > 15) or (_s_video > 15)
            or (_s_unhandled > 25) or (_total > 3000);

  _report := jsonb_build_object(
    'window','1h', 'total', _total,
    'chunk_load', jsonb_build_object('n', _chunk, 'sessions', _s_chunk, 'users', _u_chunk),
    'render_crash', jsonb_build_object('n', _crash, 'sessions', _s_crash),
    'backend_unreachable', jsonb_build_object('n', _backend, 'sessions', _s_backend, 'users', _u_backend),
    'video_error', jsonb_build_object('n', _video, 'sessions', _s_video),
    'unhandled', jsonb_build_object('n', _unhandled, 'sessions', _s_unhandled),
    'other', _other, 'alarm', _alarm, 'checked_at', now());

  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'client_error_report', _report);
  exception when others then null; end;

  select value into _state from app_settings where key='client_error_watchdog_state';
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  _last_ms  := coalesce((_state->>'last_alert_ms')::bigint, 0);
  if _alarm then
    if (not _alerting) or (_now_ms - _last_ms > 43200000) then _should_alert := true; end if;  -- re-alert every 12h
  elsif _alerting then
    _recovered := true;
  end if;

  if _should_alert or _recovered then
    select value->>'bot_token' into _tok from platform_settings where key='telegram';
    if _tok is not null and _tok <> '' then
      _msg := case when _recovered
        then '✅ Klient xatoliklari normallashdi.'
        else '⚠️ Klient xatoliklari (soʻnggi 1 soat): chunk-load ' || _s_chunk || ' sessiya, backend-unreachable '
             || _s_backend || ' sessiya, crash ' || _s_crash || ', video ' || _s_video || ', js-crash '
             || _s_unhandled || ', jami ' || _total || '. admin_actions "client_error_report" ni koʻring.'
      end;
      for _admin in select distinct p.telegram_id from profiles p
        join user_roles r on r.user_id=p.id and r.role in ('admin','superadmin')
        where p.telegram_id is not null limit 3
      loop
        begin
          perform net.http_post(url:='https://api.telegram.org/bot'||_tok||'/sendMessage',
            headers:=jsonb_build_object('Content-Type','application/json'),
            body:=jsonb_build_object('chat_id',_admin.telegram_id,'text',_msg));
        exception when others then null; end;
      end loop;
    end if;
  end if;

  insert into app_settings (key, value) values ('client_error_watchdog_state', jsonb_build_object(
    'alerting', _alarm, 'last_alert_ms', case when _should_alert then _now_ms else _last_ms end, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return _report;
end;
$function$;

revoke execute on function public.client_error_watchdog() from public, anon, authenticated;
grant execute on function public.client_error_watchdog() to service_role;

-- Prune (bounded growth) — keep 30 days.
create or replace function public.prune_client_error_events()
returns int language plpgsql security definer set search_path to 'public' as $function$
declare _n int;
begin
  delete from public.client_error_events where created_at < now() - interval '30 days';
  get diagnostics _n = row_count;
  return _n;
end;
$function$;
revoke execute on function public.prune_client_error_events() from public, anon, authenticated;
grant execute on function public.prune_client_error_events() to service_role;

-- Deploy self-test.
do $$
begin
  perform public.client_error_watchdog();
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'client_error_watchdog_selftest_failed', jsonb_build_object('error', sqlerrm));
end $$;

-- Crons (idempotent; failure surfaced durably).
do $$
begin
  if exists (select 1 from cron.job where jobname='client-error-watchdog') then perform cron.unschedule('client-error-watchdog'); end if;
  perform cron.schedule('client-error-watchdog', '25 * * * *', 'select public.client_error_watchdog()');
  if exists (select 1 from cron.job where jobname='prune-client-error-events') then perform cron.unschedule('prune-client-error-events'); end if;
  perform cron.schedule('prune-client-error-events', '35 3 * * *', 'select public.prune_client_error_events()');
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'cron_schedule_failed', jsonb_build_object('job','client-error-beacon','error',sqlerrm));
end $$;
