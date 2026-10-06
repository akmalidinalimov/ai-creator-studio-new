-- 🆘 «❓ Yordam» support inside the bot (owner request, 2026-10-06; flow in telegram-bot-webhook/support.ts).
--
-- A student taps «❓ Yordam», describes the technical problem (text and/or a screenshot); every admin gets a card in
-- the bot; the admin answers (✍️ Javob yozish, or a plain reply to the card) and the answer goes to the student as
-- "problem solved". This table is the ticket ledger: written only by the bot (service role), RLS on with no policy.
--
-- support_ticket_append(): the ONE way to add messages / admin card ids to a ticket — an atomic jsonb append, so the
-- parts of an album arriving as concurrent webhook calls never overwrite each other.
--
-- Detector support_tickets_watchdog() (hourly :27, admin DM 08:00–22:00 Tashkent): open tickets older than 3 hours,
-- and at once (after 10 min) a ticket that reached NO admin (admin_messages empty); each reminded at most once per
-- 12 hours — a ticket nobody answered is never silent.

create table if not exists public.support_tickets (
  id              bigserial primary key,
  user_id         uuid references public.profiles(id) on delete set null,
  telegram_id     bigint not null,
  chat_id         bigint not null,
  username        text,
  display_name    text,
  group_name      text,
  locale          text not null default 'uz' check (locale in ('uz', 'ru', 'en')),
  status          text not null default 'open' check (status in ('open', 'answered')),
  messages        jsonb not null default '[]'::jsonb check (jsonb_typeof(messages) = 'array'),
  admin_messages  jsonb not null default '[]'::jsonb check (jsonb_typeof(admin_messages) = 'array'),
  reply_text      text check (reply_text is null or char_length(reply_text) <= 4000),
  answered_by     uuid references public.profiles(id) on delete set null,
  answered_at     timestamptz,
  reminded_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists support_tickets_user_status_idx on public.support_tickets (user_id, status);
create index if not exists support_tickets_open_idx on public.support_tickets (created_at) where status = 'open';
create index if not exists support_tickets_admin_messages_idx on public.support_tickets using gin (admin_messages jsonb_path_ops);

alter table public.support_tickets enable row level security;
revoke all on table public.support_tickets from public, anon, authenticated;
grant select, insert, update, delete on table public.support_tickets to service_role;
grant usage, select on sequence public.support_tickets_id_seq to service_role;

-- admins read the ledger on the website later if wanted (read-only)
drop policy if exists support_tickets_admin_read on public.support_tickets;
create policy support_tickets_admin_read on public.support_tickets
  for select to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role));
grant select on table public.support_tickets to authenticated;

create or replace function public.support_ticket_append(_id bigint, _messages jsonb, _admin_messages jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $fn$
  update public.support_tickets
     set messages = messages || case when jsonb_typeof(_messages) = 'array' then _messages else '[]'::jsonb end,
         admin_messages = admin_messages || case when jsonb_typeof(_admin_messages) = 'array' then _admin_messages else '[]'::jsonb end,
         updated_at = now()
   where id = _id
$fn$;

revoke execute on function public.support_ticket_append(bigint, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.support_ticket_append(bigint, jsonb, jsonb) to service_role;

-- ───────────────────────────── the detector ─────────────────────────────
create or replace function public.support_tickets_watchdog()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  _hour int := extract(hour from (now() at time zone 'Asia/Tashkent'))::int;
  _open int;
  _due int;
  _lines text;
  _msg text;
  _tok text;
  _admin record;
  _dm int := 0;
begin
  select count(*) into _open from public.support_tickets where status = 'open';
  select count(*) into _due from public.support_tickets
   where status = 'open'
     and (created_at < now() - interval '3 hours'
          or (admin_messages = '[]'::jsonb and created_at < now() - interval '10 minutes'))   -- reached no admin
     and (reminded_at is null or reminded_at < now() - interval '12 hours');

  if _due > 0 and _hour between 8 and 21 then
    select string_agg(E'\n• #' || t.id || ' — ' || coalesce(nullif(t.display_name, ''), '?')
                      || coalesce(' (@' || t.username || ')', '') || coalesce(' · ' || t.group_name, '')
                      || ' · ' || floor(extract(epoch from now() - t.created_at) / 3600)::int || ' soat'
                      || case when t.admin_messages = '[]'::jsonb then ' ⚠️ adminga yetmagan — Admin → support_tickets' else '' end,
                      '' order by t.id)
      into _lines
      from (select * from public.support_tickets
             where status = 'open'
               and (created_at < now() - interval '3 hours'
                    or (admin_messages = '[]'::jsonb and created_at < now() - interval '10 minutes'))
               and (reminded_at is null or reminded_at < now() - interval '12 hours')
             order by id limit 15) t;
    _msg := '⏳ Javobsiz yordam soʻrovlari: ' || _due || coalesce(_lines, '')
            || E'\n\nJavob berish: botdagi soʻrov kartasiga reply qiling yoki «✍️ Javob yozish»ni bosing.';
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if coalesce(_tok, '') <> '' then
      for _admin in
        select distinct p.telegram_id from public.profiles p
          join public.user_roles ro on ro.user_id = p.id and ro.role in ('admin', 'superadmin')
         where p.telegram_id is not null and p.status = 'active' limit 3
      loop
        begin
          perform public.ops_net_post(
            p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            p_body       := jsonb_build_object('chat_id', _admin.telegram_id, 'text', left(_msg, 3900), 'disable_web_page_preview', true),
            p_headers    := jsonb_build_object('Content-Type', 'application/json'),
            p_purpose    := 'support_tickets_watchdog',
            p_timeout_ms := 5000);
          _dm := _dm + 1;
        exception when others then null; end;
      end loop;
    end if;
    if _dm > 0 then
      update public.support_tickets set reminded_at = now()
       where id in (select id from public.support_tickets
                     where status = 'open'
                       and (created_at < now() - interval '3 hours'
                            or (admin_messages = '[]'::jsonb and created_at < now() - interval '10 minutes'))
                       and (reminded_at is null or reminded_at < now() - interval '12 hours')
                     order by id limit 15);
    end if;
  end if;

  insert into public.app_settings (key, value)
  values ('support_tickets_watchdog_state', jsonb_build_object(
    'open', _open, 'due', _due, 'dm_attempted', _dm,
    'undelivered_24h', (select count(*) from public.admin_actions a
                         where a.action in ('support_ticket_undelivered', 'support_reply_undelivered', 'support_ticket_failed',
                                            'support_capture_failed')
                           and a.created_at > now() - interval '24 hours'),
    'checked_at', now()))
  on conflict (key) do update set value = excluded.value;
  return jsonb_build_object('open', _open, 'due', _due, 'dm_attempted', _dm, 'checked_at', now());
end
$fn$;

revoke execute on function public.support_tickets_watchdog() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'support-tickets-watchdog') then
    perform cron.unschedule('support-tickets-watchdog');
  end if;
  perform cron.schedule('support-tickets-watchdog', '27 * * * *', 'select public.support_tickets_watchdog()');
end $$;
