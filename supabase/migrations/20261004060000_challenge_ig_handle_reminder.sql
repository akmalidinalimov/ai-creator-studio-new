-- A daily DM to every Challenge student who has not added an Instagram username yet (owner request, 2026-10-04).
--
-- WHY: Instagram tasks are checked against profiles.instagram_username. On 2026-10-04 only 31 of 169 Challenge 6.0
-- students had one, and the first Instagram task is Friday 2026-10-09. The same PR lets students set it in the
-- bot (/instagram, or t.me/<bot>?start=ig, see telegram-bot-webhook/ig-handle.ts), so the reminder's button
-- opens the bot and asks for the username: one tap, one message.
--
-- WHAT: challenge_ig_handle_reminder(), daily at 06:00 UTC (11:00 Tashkent, after the 09:00 task post):
--   * targets: students in a group of a challenge course (platform_settings.challenge.course_ids) with no
--     instagram_username who pressed Start (telegram_write_access_at; the bot cannot DM the others, and every
--     try would just fail), active, not archived, not staff;
--   * one broadcasts row per course + one pending broadcast_deliveries row per student. The existing
--     broadcast-drainer sends them: the student's language, quiet hours, every outcome recorded per row;
--   * at most once per Tashkent day (marker row 'ig_handle_reminder_sent'), so a re-run or a manual call never
--     doubles it. The reminder stops for a student the day they add a username.
-- KILL-SWITCH: platform_settings 'ig_handle_reminder' {"enabled": false}. Seeded ON (the owner asked for it).
-- LIVENESS: every run stamps app_settings 'ig_handle_reminder_watchdog_state'.checked_at, so
--   hw_dm_health_stats().stale_watchdogs and the daily GitHub verifier notice a cron that stops (they read every
--   '*_watchdog_state' row).
-- No self-test calls it: it queues real messages.

insert into public.platform_settings (key, value)
values ('ig_handle_reminder', '{"enabled": true}'::jsonb)
on conflict (key) do nothing;

create or replace function public.challenge_ig_handle_reminder()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  _cfg jsonb;
  _ch jsonb;
  _bot text;
  _day date := (now() at time zone 'Asia/Tashkent')::date;
  _course uuid;
  _bid uuid;
  _n int;
  _total int := 0;
  _bids jsonb := '[]'::jsonb;
  _result jsonb;
begin
  select value into _cfg from public.platform_settings where key = 'ig_handle_reminder';
  select value into _ch from public.platform_settings where key = 'challenge';

  if coalesce(_cfg->>'enabled', '') <> 'true' then
    _result := jsonb_build_object('skipped', 'disabled');
  elsif coalesce(_ch->>'enabled', '') <> 'true' then
    _result := jsonb_build_object('skipped', 'challenge_off');
  elsif exists (select 1 from public.admin_actions
                 where action = 'ig_handle_reminder_sent' and details->>'day' = _day::text) then
    _result := jsonb_build_object('skipped', 'already_sent_today');
  else
    select nullif(btrim(value->>'bot_username'), '') into _bot from public.platform_settings where key = 'telegram';
    if _bot is null then
      _result := jsonb_build_object('skipped', 'no_bot_username');
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'ig_handle_reminder_failed', jsonb_build_object('day', _day, 'reason', 'no_bot_username'));
    else
      for _course in
        select x::uuid from jsonb_array_elements_text(case when jsonb_typeof(_ch->'course_ids') = 'array'
                                                           then _ch->'course_ids' else '[]'::jsonb end) x
      loop
        insert into public.broadcasts (course_id, created_by, image_path, body_uz, body_ru, body_en,
                                       button_label, button_url, mode, status, started_at)
        values (_course, null, null,
          '📸 <b>Instagram username’ingizni qo‘shing</b>' || E'\n\n' ||
          'Instagram vazifalari uchun ball aynan shu nom orqali beriladi. Siz hali qo‘shmagansiz — shuning uchun Instagram vazifangiz tasdiqlanmaydi.' || E'\n\n' ||
          '👇 Pastdagi tugmani bosing yoki botga <b>/instagram</b> deb yozing — 10 soniyalik ish.' || E'\n\n' ||
          '<i>Username qo‘shilgach, bu eslatma boshqa kelmaydi.</i>',
          '📸 <b>Добавьте ваш Instagram username</b>' || E'\n\n' ||
          'Баллы за Instagram-задания начисляются именно по этому имени. Вы его ещё не добавили — поэтому Instagram-задание не засчитается.' || E'\n\n' ||
          '👇 Нажмите кнопку ниже или напишите боту <b>/instagram</b> — это 10 секунд.' || E'\n\n' ||
          '<i>Как только username добавлен, это напоминание больше не придёт.</i>',
          '📸 <b>Add your Instagram username</b>' || E'\n\n' ||
          'Instagram task points are given by this name. You haven''t added it yet, so your Instagram task can''t be accepted.' || E'\n\n' ||
          '👇 Tap the button below or send <b>/instagram</b> to the bot — it takes 10 seconds.' || E'\n\n' ||
          '<i>Once your username is added, this reminder stops.</i>',
          '📸 Instagram username', 'https://t.me/' || _bot || '?start=ig',
          'all', 'sending', now())
        returning id into _bid;

        insert into public.broadcast_deliveries (broadcast_id, user_id, telegram_id, scheduled_for)
        select _bid, p.id, p.telegram_id, now()
          from public.profiles p
          join public.groups g on g.id = p.group_id
         where g.course_id = _course
           and p.instagram_username is null
           and p.telegram_id is not null
           and p.telegram_write_access_at is not null
           and p.status = 'active' and p.archived_at is null
           and not exists (select 1 from public.user_roles r
                            where r.user_id = p.id and r.role in ('admin', 'superadmin', 'teacher'));
        get diagnostics _n = row_count;

        update public.broadcasts
           set total = _n,
               status = case when _n = 0 then 'done' else status end,
               finished_at = case when _n = 0 then now() end
         where id = _bid;
        _total := _total + _n;
        _bids := _bids || to_jsonb(_bid);
      end loop;

      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'ig_handle_reminder_sent', jsonb_build_object('day', _day, 'total', _total, 'broadcast_ids', _bids, 'at', now()));
      _result := jsonb_build_object('day', _day, 'total', _total, 'broadcast_ids', _bids);
    end if;
  end if;

  insert into public.app_settings (key, value)
  values ('ig_handle_reminder_watchdog_state', jsonb_build_object('checked_at', now(), 'last', _result))
  on conflict (key) do update set value = excluded.value;
  return _result;
end
$fn$;

revoke execute on function public.challenge_ig_handle_reminder() from public, anon, authenticated;

-- liveness baseline, so the stale check has a row from day one
insert into public.app_settings (key, value)
values ('ig_handle_reminder_watchdog_state', jsonb_build_object('checked_at', now(), 'last', jsonb_build_object('installed', true)))
on conflict (key) do nothing;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'challenge-ig-handle-reminder') then
    perform cron.unschedule('challenge-ig-handle-reminder');
  end if;
  perform cron.schedule('challenge-ig-handle-reminder', '0 6 * * *', 'select public.challenge_ig_handle_reminder()');
end $$;
