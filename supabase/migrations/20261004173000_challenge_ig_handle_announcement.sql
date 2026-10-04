-- One announcement to the Challenge 6.0 students who have not added an Instagram username (owner request, 2026-10-04).
--
-- WHY: only 31 of 169 students have one; the first Instagram task is Friday 2026-10-09 and every Instagram task is
-- checked against that username. The bot can now take it (keyboard «📸 Instagram qo‘shish», /instagram,
-- t.me/<bot>?start=ig; PRs #259/#260) and reminds at 13:00 / 21:00 — this is the clear, explained kick-off.
--
-- HOW: the normal broadcast pipeline (one broadcasts row + one pending delivery per student; broadcast-drainer sends
-- in each student's language, defers anything due in quiet hours 22:00-08:00 to 08:00, records every outcome).
-- Audience = the reminder's: in a course-6.0 group, no instagram_username, pressed Start (the bot cannot DM the
-- others), active, not archived, not staff.
--
-- NO TRIPLE MESSAGE: the announcement takes the place of the next reminder slot on the day it is delivered: it
-- writes that slot's once-only marker ('ig_handle_reminder_sent', reason 'replaced_by_announcement'), so
-- challenge_ig_handle_reminder() skips it. Queued at night → delivered 08:00 → that day's 13:00 slot is skipped.
--
-- Replay-safe: skipped if its own audit row exists. Respects the broadcast kill-switch.

do $$
declare
  _course constant uuid := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _bot text;
  _bid uuid;
  _n int;
  _local timestamp := now() at time zone 'Asia/Tashkent';
  _deliver timestamp;     -- Tashkent wall time the drainer will send it
  _slot text;
begin
  if exists (select 1 from public.admin_actions where action = 'challenge_ig_handle_announcement') then
    raise notice 'Instagram announcement already queued';
    return;
  end if;
  if coalesce((select (value->>'enabled')::boolean from public.platform_settings where key = 'broadcast'), false) is not true then
    raise notice 'broadcast kill-switch is off, nothing queued';
    return;
  end if;
  select nullif(btrim(value->>'bot_username'), '') into _bot from public.platform_settings where key = 'telegram';
  if _bot is null then
    raise exception 'ABORT: platform_settings.telegram.bot_username is missing';
  end if;

  insert into public.broadcasts (course_id, created_by, image_path, body_uz, body_ru, body_en,
                                 button_label, button_url, mode, status, started_at)
  values (_course, null, null,
    '📸 <b>Muhim: Instagram username’ingizni qo‘shing</b>' || E'\n\n' ||
    'Challenge davomida Instagram’ingiz shaxsiy portfoliongizga aylanadi: har hafta Instagram vazifalari bo‘ladi (birinchisi — <b>juma, 9-oktabr</b>), va ular uchun ball aynan Instagram username’ingiz orqali beriladi.' || E'\n\n' ||
    '<b>Qanday qo‘shiladi (10 soniya):</b>' || E'\n' ||
    '1️⃣ Pastdagi «📸 Instagram qo‘shish» tugmasini bosing' || E'\n' ||
    '2️⃣ Instagram username’ingizni yozib yuboring (masalan: @ismingiz)' || E'\n' ||
    '3️⃣ «✅ Saqlandi» chiqsa — tayyor!' || E'\n\n' ||
    '<i>Username qo‘shmaguningizcha bot har kuni 13:00 va 21:00 da eslatib turadi.</i>',
    '📸 <b>Важно: добавьте ваш Instagram username</b>' || E'\n\n' ||
    'За время челленджа ваш Instagram станет вашим портфолио: каждую неделю будут Instagram-задания (первое — <b>в пятницу, 9 октября</b>), и баллы за них начисляются именно по вашему Instagram username.' || E'\n\n' ||
    '<b>Как добавить (10 секунд):</b>' || E'\n' ||
    '1️⃣ Нажмите кнопку «📸 Instagram qo‘shish» ниже' || E'\n' ||
    '2️⃣ Отправьте свой Instagram username (например: @vashe_imya)' || E'\n' ||
    '3️⃣ Появилось «✅ Сохранено» — готово!' || E'\n\n' ||
    '<i>Пока username не добавлен, бот будет напоминать каждый день в 13:00 и 21:00.</i>',
    '📸 <b>Important: add your Instagram username</b>' || E'\n\n' ||
    'Over the challenge your Instagram becomes your portfolio: there are Instagram tasks every week (the first is <b>Friday, 9 October</b>), and their points are given by your Instagram username.' || E'\n\n' ||
    '<b>How to add it (10 seconds):</b>' || E'\n' ||
    '1️⃣ Tap the «📸 Instagram qo‘shish» button below' || E'\n' ||
    '2️⃣ Send your Instagram username (for example: @yourname)' || E'\n' ||
    '3️⃣ When «✅ Saved» appears — done!' || E'\n\n' ||
    '<i>Until it is added, the bot reminds you every day at 13:00 and 21:00.</i>',
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

  if _n > 200 then
    raise exception 'ABORT: % recipients — more than the whole 6.0 cohort', _n;
  end if;
  update public.broadcasts set total = _n,
         status = case when _n = 0 then 'done' else status end,
         finished_at = case when _n = 0 then now() end
   where id = _bid;

  -- when the drainer will actually send it (quiet hours 22:00-08:00 Tashkent defer to 08:00)
  _deliver := case
    when extract(hour from _local) >= 22 then date_trunc('day', _local) + interval '1 day 8 hours'
    when extract(hour from _local) < 8 then date_trunc('day', _local) + interval '8 hours'
    else _local end;
  -- the next reminder slot after delivery that same day is replaced by this announcement
  _slot := case when extract(hour from _deliver) < 13 then 'afternoon'
                when extract(hour from _deliver) < 21 then 'evening' end;
  if _slot is not null and _n > 0
     and not exists (select 1 from public.admin_actions where action = 'ig_handle_reminder_sent'
                      and details->>'day' = (_deliver::date)::text and coalesce(details->>'slot', 'afternoon') = _slot) then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'ig_handle_reminder_sent', jsonb_build_object(
      'day', _deliver::date, 'slot', _slot, 'total', 0, 'reason', 'replaced_by_announcement',
      'broadcast_ids', jsonb_build_array(_bid), 'at', now()));
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'challenge_ig_handle_announcement', jsonb_build_object(
    'broadcast_id', _bid, 'total', _n, 'deliver_tashkent', _deliver, 'replaced_slot', _slot,
    'migration', '20261004173000', 'at', now()));
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'broadcast_created', jsonb_build_object(
    'broadcast_id', _bid, 'course_id', _course, 'mode', 'all', 'total', _n, 'has_image', false,
    'marker', 'ig_handle_announcement_20261004', 'migration', '20261004173000'));
end $$;
