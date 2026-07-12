-- Instant new-joiner alert (owner request 2026-07-12: "when a new person joins").
-- A DB trigger is the one chokepoint every signup path crosses (intake form, admin-create,
-- group auto-register, web) — no per-path wiring, no path ever forgotten.
--
-- Shape: trigger → queue row → per-minute flush that sends ONE aggregated Telegram DM to the
-- admins. The queue (not direct send from the trigger) is deliberate:
--   * a bulk import of 30 students becomes one message, not 30;
--   * the trigger stays instant and can never fail the INSERT it rides on;
--   * queue rows with sent_at are the DB-visible health signal the doctrine requires.

create table if not exists public.new_student_alert_queue (
  id bigint generated always as identity primary key,
  profile_id uuid not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
alter table public.new_student_alert_queue enable row level security;
-- no policies: service_role only, invisible to anon/authenticated

create index if not exists idx_nsaq_unsent on public.new_student_alert_queue (id) where sent_at is null;

create or replace function public.enqueue_new_student_alert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Synthetic E2E users (verification bar) must never ping the admins.
  if new.name is null or new.name not like 'E2E-TEST-%' then
    insert into public.new_student_alert_queue (profile_id) values (new.id);
  end if;
  return new;
exception when others then
  return new; -- alerting must never break a signup
end;
$$;

drop trigger if exists trg_new_student_alert on public.profiles;
create trigger trg_new_student_alert
  after insert on public.profiles
  for each row execute function public.enqueue_new_student_alert();

create or replace function public.flush_new_student_alerts()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  _tok text;
  _admin record;
  _row record;
  _lines text := '';
  _count int := 0;
  _shown int := 0;
  _sent int := 0;
begin
  -- Claim first (atomic), then send best-effort: a Telegram outage can cost one aggregated
  -- alert but can never double-send, and unsent claims stay visible via sent_at timestamps.
  -- LEFT joins (review finding): a profile deleted between enqueue and flush still shows up
  -- as a line instead of silently vanishing from the audit trail.
  for _row in
    with claimed as (
      update public.new_student_alert_queue
      set sent_at = now()
      where sent_at is null
      returning profile_id
    )
    select p.name, p.telegram_username, p.account_type, g.name as group_name
    from claimed c
    left join profiles p on p.id = c.profile_id
    left join groups g on g.id = p.group_id
    order by p.created_at nulls last
  loop
    _count := _count + 1;
    if _shown < 15 then
      _lines := _lines || E'\n• ' || coalesce(_row.name, '(profil o''chirilgan)')
        || case when _row.telegram_username is not null then ' (@' || _row.telegram_username || ')' else '' end
        || ' — ' || coalesce(_row.group_name, 'guruhsiz')
        || case when _row.account_type = 'provisional' then ' · sinov' else '' end;
      _shown := _shown + 1;
    end if;
  end loop;

  if _count = 0 then return 0; end if;
  if _count > _shown then _lines := _lines || E'\n… va yana ' || (_count - _shown) || ' ta'; end if;

  select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
  if _tok is null or _tok = '' then return 0; end if;

  for _admin in
    select distinct p.id, p.telegram_id from profiles p
    join user_roles r on r.user_id = p.id and r.role in ('admin','superadmin')
    where p.telegram_id is not null limit 3
  loop
    begin
      perform net.http_post(
        url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
        headers := jsonb_build_object('Content-Type','application/json'),
        body := jsonb_build_object('chat_id', _admin.telegram_id,
          'text', '🆕 Yangi qo''shilganlar (' || _count || '):' || _lines));
      _sent := _sent + 1;
    exception when others then null;
    end;
  end loop;
  return _sent;
end;
$$;

revoke execute on function public.enqueue_new_student_alert() from public, anon, authenticated;
revoke execute on function public.flush_new_student_alerts() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'new-student-alert-flush') then
    perform cron.unschedule('new-student-alert-flush');
  end if;
  perform cron.schedule('new-student-alert-flush', '* * * * *', $cmd$ select public.flush_new_student_alerts() $cmd$);
end $$;
