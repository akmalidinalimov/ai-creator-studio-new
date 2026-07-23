-- Admin broadcast (2026-07-23): send an image+message to all students of one course as a Telegram DM.
-- Queue + once-a-minute drainer, mirroring badge_award_queue's hardened delivery model. Composed in
-- the admin panel; delivered DM-only. Ships dormant-safe (platform_settings.broadcast.enabled=false).
-- See docs/superpowers/specs/2026-07-23-admin-broadcast-design.md.

-- 1) Tables (service-role only: RLS on, no policies — the admin UI reads via SECURITY DEFINER RPCs).
create table if not exists public.broadcasts (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  created_by uuid,
  image_path text,                              -- storage key in broadcast-images (nullable)
  body_uz text not null,
  body_ru text, body_en text,                   -- optional overrides; missing → uz
  button_label text, button_url text,
  mode text not null check (mode in ('test','all')),
  status text not null default 'sending' check (status in ('sending','done')),
  total int not null default 0,
  sent int not null default 0,
  failed int not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
alter table public.broadcasts enable row level security;

create table if not exists public.broadcast_deliveries (
  id bigint generated always as identity primary key,
  broadcast_id uuid not null references public.broadcasts(id) on delete cascade,
  user_id uuid not null,
  telegram_id text,
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  error text,
  attempts int not null default 0,
  last_attempt_at timestamptz,
  scheduled_for timestamptz not null default now(),   -- quiet-hours deferral
  sent_at timestamptz
);
alter table public.broadcast_deliveries enable row level security;
create index if not exists idx_bcd_broadcast on public.broadcast_deliveries (broadcast_id);
create index if not exists idx_bcd_pending on public.broadcast_deliveries (scheduled_for)
  where status = 'pending';

-- 2) Image bucket (public so Telegram can fetch the URL; upload restricted to admins).
insert into storage.buckets (id, name, public) values ('broadcast-images','broadcast-images', true)
on conflict (id) do nothing;
drop policy if exists "broadcast img admin write" on storage.objects;
create policy "broadcast img admin write" on storage.objects for insert to authenticated
  with check (bucket_id = 'broadcast-images' and public.has_role(auth.uid(), 'admin'::app_role));
drop policy if exists "broadcast img admin modify" on storage.objects;
create policy "broadcast img admin modify" on storage.objects for update to authenticated
  using (bucket_id = 'broadcast-images' and public.has_role(auth.uid(), 'admin'::app_role));

-- 3) Kill-switch (dormant until owner flips it on).
insert into public.platform_settings (key, value)
values ('broadcast', jsonb_build_object('enabled', false))
on conflict (key) do nothing;

-- 4) Admin-callable RPCs (SECURITY DEFINER + internal has_role gate; UI reads through these since the
--    tables themselves are service-role only).
create or replace function public.broadcast_reachable(_course_id uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(distinct p.id)::int
  from profiles p
  join enrollments e on e.user_id = p.id and e.course_id = _course_id
  where public.has_role(auth.uid(), 'admin'::app_role)
    and p.telegram_id is not null and p.status = 'active' and p.archived_at is null
$$;
revoke execute on function public.broadcast_reachable(uuid) from public, anon;
grant execute on function public.broadcast_reachable(uuid) to authenticated;

create or replace function public.broadcast_status(_broadcast_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare _b record; _pending int;
begin
  if not public.has_role(auth.uid(), 'admin'::app_role) then
    return jsonb_build_object('error','forbidden');
  end if;
  select * into _b from broadcasts where id = _broadcast_id;
  if not found then return jsonb_build_object('error','not_found'); end if;
  select count(*) into _pending from broadcast_deliveries where broadcast_id = _broadcast_id and status = 'pending';
  return jsonb_build_object('status', _b.status, 'total', _b.total, 'sent', _b.sent,
    'failed', _b.failed, 'pending', _pending, 'mode', _b.mode);
end;
$$;
revoke execute on function public.broadcast_status(uuid) from public, anon;
grant execute on function public.broadcast_status(uuid) to authenticated;

-- 5) Drainer cron (every minute, Vault-authed like canary-15min).
do $$
begin
  if exists (select 1 from cron.job where jobname='broadcast-drainer-every-minute') then
    perform cron.unschedule('broadcast-drainer-every-minute');
  end if;
  perform cron.schedule('broadcast-drainer-every-minute', '* * * * *', $cmd$
    select net.http_post(
      url := 'https://cdyidatkegxwhtuoqxly.supabase.co/functions/v1/broadcast-drainer',
      headers := jsonb_build_object(
        'Content-Type','application/json',
        'apikey', public.cron_service_key(),
        'Authorization', 'Bearer '||public.cron_service_key(),
        'x-internal-secret', public.internal_fn_secret()),
      body := '{}'::jsonb)
  $cmd$);
end $$;

-- 6) Health: read-only stats + a stuck-broadcast watchdog (DMs admins if a 'sending' broadcast has
--    deliveries pending past 30 min → drainer down or wedged). Independent SQL+pg_net leg.
create or replace function public.broadcast_health_stats()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'sending_broadcasts', (select count(*) from broadcasts where status='sending'),
    'stuck_pending', (select count(*) from broadcast_deliveries d join broadcasts b on b.id=d.broadcast_id
        where b.status='sending' and d.status='pending' and d.scheduled_for < now() - interval '30 minutes'),
    'sent_24h', (select count(*) from broadcast_deliveries where status='sent' and sent_at > now()-interval '24 hours'),
    'failed_24h', (select count(*) from broadcast_deliveries where status='failed' and last_attempt_at > now()-interval '24 hours'),
    'checked_at', now());
$$;
revoke execute on function public.broadcast_health_stats() from public, anon, authenticated;
grant execute on function public.broadcast_health_stats() to service_role;

create or replace function public.broadcast_watchdog()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  _tok text; _admin record; _stuck int; _oldest_min int;
  _state jsonb; _alerting boolean; _last_ms bigint;
  _now_ms bigint := (extract(epoch from now())*1000)::bigint;
  _should_alert boolean := false; _recovered boolean := false; _msg text;
begin
  select count(*), coalesce(ceil(extract(epoch from now()-min(d.scheduled_for))/60)::int,0)
    into _stuck, _oldest_min
  from broadcast_deliveries d join broadcasts b on b.id=d.broadcast_id
  where b.status='sending' and d.status='pending' and d.scheduled_for < now() - interval '30 minutes';

  select value into _state from app_settings where key='broadcast_watchdog_state';
  _alerting := coalesce((_state->>'alerting')::boolean,false);
  _last_ms  := coalesce((_state->>'last_alert_ms')::bigint,0);

  if _stuck > 0 then
    if (not _alerting) or (_now_ms - _last_ms > 3600000) then _should_alert := true; end if;
  elsif _alerting then _recovered := true; end if;

  if _should_alert or _recovered then
    select value->>'bot_token' into _tok from platform_settings where key='telegram';
    if _tok is not null and _tok<>'' then
      _msg := case when _recovered then '✅ Broadcast yetkazish tiklandi.'
        else '🚨 Broadcast qotib qoldi: '||_stuck||' ta xabar '||_oldest_min||
             ' daqiqadan beri yuborilmagan. broadcast-drainer ni tekshiring.' end;
      for _admin in select distinct p.telegram_id from profiles p
        join user_roles r on r.user_id=p.id and r.role in ('admin','superadmin')
        where p.telegram_id is not null limit 3
      loop
        begin perform net.http_post(url:='https://api.telegram.org/bot'||_tok||'/sendMessage',
          headers:=jsonb_build_object('Content-Type','application/json'),
          body:=jsonb_build_object('chat_id',_admin.telegram_id,'text',_msg));
        exception when others then null; end;
      end loop;
    end if;
  end if;

  insert into app_settings (key,value) values ('broadcast_watchdog_state',
    jsonb_build_object('alerting',(_stuck>0),'last_alert_ms',case when _should_alert then _now_ms else _last_ms end,
      'stuck',_stuck,'checked_at',now()))
  on conflict (key) do update set value=excluded.value;

  return jsonb_build_object('stuck',_stuck,'alerted',_should_alert,'recovered',_recovered);
end;
$fn$;
revoke execute on function public.broadcast_watchdog() from public, anon, authenticated;
grant execute on function public.broadcast_watchdog() to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname='broadcast-watchdog') then perform cron.unschedule('broadcast-watchdog'); end if;
  perform cron.schedule('broadcast-watchdog', '*/30 * * * *', $cmd$ select public.broadcast_watchdog() $cmd$);
end $$;
