-- The Instagram-username reminder goes out TWICE a day: 13:00 and 21:00 Tashkent (owner request, 2026-10-04).
--
-- Was (20261004060000): once a day at 11:00, marker per Tashkent day.
-- Now:
--   * two cron jobs, 08:00 UTC (13:00 Tashkent) and 16:00 UTC (21:00 Tashkent, before the 22:00 quiet hours);
--   * the run's slot ('afternoon' before 17:00 Tashkent, 'evening' after) is part of the once-only marker, so each
--     slot sends at most once a day and a manual re-run never doubles it;
--   * the text says why it matters (the Instagram becomes the student's portfolio over the course) and points at the
--     new keyboard button «📸 Instagram qo‘shish» (telegram-bot-webhook, same PR); the inline button opens the bot's
--     username question (t.me/<bot>?start=ig) as before.
--   Unchanged: who gets it (challenge-course students with no instagram_username who pressed Start, not staff), the
--   broadcast pipeline, the kill-switch platform_settings.ig_handle_reminder, the liveness row.
--
-- PIN: the live body must be the reviewed 20261004060000 text (md5 46c7f8ae…), or this run's own new text (replay).

do $$
declare
  _md5 text;
begin
  select md5(replace(prosrc, E'\r', '')) into _md5 from pg_proc
   where oid = to_regprocedure('public.challenge_ig_handle_reminder()');
  if _md5 is null then
    raise exception 'ABORT: public.challenge_ig_handle_reminder() is missing';
  end if;
  if _md5 <> '46c7f8ae12cff045e38b087a4dbcc177'
     and not exists (select 1 from pg_proc where oid = 'public.challenge_ig_handle_reminder()'::regprocedure
                      and prosrc like '%ig_handle_reminder_slot%') then
    raise exception 'ABORT: challenge_ig_handle_reminder() is not the reviewed text (md5 %)', _md5;
  end if;
end $$;

create or replace function public.challenge_ig_handle_reminder()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
-- ig_handle_reminder_slot: twice a day (13:00 / 21:00 Tashkent), once per slot (20261004170000).
declare
  _cfg jsonb;
  _ch jsonb;
  _bot text;
  _local timestamp := now() at time zone 'Asia/Tashkent';
  _day date := (now() at time zone 'Asia/Tashkent')::date;
  _slot text := case when extract(hour from (now() at time zone 'Asia/Tashkent')) < 17 then 'afternoon' else 'evening' end;
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
    _result := jsonb_build_object('skipped', 'disabled', 'slot', _slot);
  elsif coalesce(_ch->>'enabled', '') <> 'true' then
    _result := jsonb_build_object('skipped', 'challenge_off', 'slot', _slot);
  elsif exists (select 1 from public.admin_actions
                 where action = 'ig_handle_reminder_sent' and details->>'day' = _day::text
                   and coalesce(details->>'slot', 'afternoon') = _slot) then
    _result := jsonb_build_object('skipped', 'already_sent_this_slot', 'slot', _slot);
  else
    select nullif(btrim(value->>'bot_username'), '') into _bot from public.platform_settings where key = 'telegram';
    if _bot is null then
      _result := jsonb_build_object('skipped', 'no_bot_username', 'slot', _slot);
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'ig_handle_reminder_failed', jsonb_build_object('day', _day, 'slot', _slot, 'reason', 'no_bot_username'));
    else
      for _course in
        select x::uuid from jsonb_array_elements_text(case when jsonb_typeof(_ch->'course_ids') = 'array'
                                                           then _ch->'course_ids' else '[]'::jsonb end) x
      loop
        insert into public.broadcasts (course_id, created_by, image_path, body_uz, body_ru, body_en,
                                       button_label, button_url, mode, status, started_at)
        values (_course, null, null,
          '📸 <b>Instagram username’ingizni qo‘shing</b>' || E'\n\n' ||
          'Kurs davomida Instagram’ingiz portfoliongizga aylanadi: har bir Instagram vazifasi uchun ball aynan shu nom orqali beriladi. Siz hali qo‘shmagansiz — shuning uchun Instagram vazifalaringiz tasdiqlanmaydi.' || E'\n\n' ||
          '👇 Pastdagi tugmani yoki menyudagi «📸 Instagram qo‘shish» tugmasini bosing — 10 soniyalik ish.' || E'\n\n' ||
          '<i>Username qo‘shilgach, bu eslatma to‘xtaydi.</i>',
          '📸 <b>Добавьте ваш Instagram username</b>' || E'\n\n' ||
          'За время курса ваш Instagram станет вашим портфолио: баллы за каждое Instagram-задание начисляются именно по этому имени. Вы его ещё не добавили — поэтому Instagram-задания не засчитываются.' || E'\n\n' ||
          '👇 Нажмите кнопку ниже или «📸 Добавить Instagram» в меню — это 10 секунд.' || E'\n\n' ||
          '<i>Как только username добавлен, напоминания прекратятся.</i>',
          '📸 <b>Add your Instagram username</b>' || E'\n\n' ||
          'Over the course your Instagram becomes your portfolio: every Instagram task''s points are given by this name. You haven''t added it yet, so your Instagram tasks can''t be accepted.' || E'\n\n' ||
          '👇 Tap the button below or «📸 Add Instagram» in the menu — it takes 10 seconds.' || E'\n\n' ||
          '<i>Once your username is added, these reminders stop.</i>',
          '📸 Instagram qo‘shish', 'https://t.me/' || _bot || '?start=ig',
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
      values (null, 'ig_handle_reminder_sent', jsonb_build_object('day', _day, 'slot', _slot, 'local_time', _local,
                                                                  'total', _total, 'broadcast_ids', _bids, 'at', now()));
      _result := jsonb_build_object('day', _day, 'slot', _slot, 'total', _total, 'broadcast_ids', _bids);
    end if;
  end if;

  insert into public.app_settings (key, value)
  values ('ig_handle_reminder_watchdog_state', jsonb_build_object('checked_at', now(), 'last', _result))
  on conflict (key) do update set value = excluded.value;
  return _result;
end
$fn$;

revoke execute on function public.challenge_ig_handle_reminder() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'challenge-ig-handle-reminder') then
    perform cron.unschedule('challenge-ig-handle-reminder');
  end if;
  if exists (select 1 from cron.job where jobname = 'challenge-ig-handle-reminder-13') then
    perform cron.unschedule('challenge-ig-handle-reminder-13');
  end if;
  if exists (select 1 from cron.job where jobname = 'challenge-ig-handle-reminder-21') then
    perform cron.unschedule('challenge-ig-handle-reminder-21');
  end if;
  perform cron.schedule('challenge-ig-handle-reminder-13', '0 8 * * *', 'select public.challenge_ig_handle_reminder()');
  perform cron.schedule('challenge-ig-handle-reminder-21', '0 16 * * *', 'select public.challenge_ig_handle_reminder()');

  if (select count(*) from cron.job where jobname like 'challenge-ig-handle-reminder%') <> 2 then
    raise exception 'ABORT: expected exactly the 13:00 and 21:00 reminder jobs';
  end if;
end $$;
