-- Tell Challenge 6.0 students they can report a technical problem with the bot's «❓ Yordam» button (owner request,
-- 2026-10-06; the support flow went live in #278).
--
-- The normal broadcast pipeline: one broadcasts row + one pending broadcast_deliveries row per student; the drainer
-- sends uz / ru / en and DEFERS quiet hours (22:00–08:00 Tashkent) to 08:00 — queued at 23:36 Tashkent, so it goes
-- out at 08:00. Audience as before: a course-6.0 group, the bot can DM them (telegram_write_access_at), active, not
-- archived, not staff. Respects the kill-switch. Replay-safe (audit marker).

do $$
declare
  _course constant uuid := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _marker constant text := 'help_button_20261006';
  _bid uuid;
  _n int;
begin
  if exists (select 1 from public.admin_actions where action = 'broadcast_created' and details->>'marker' = _marker) then
    raise notice 'help button announcement already queued';
    return;
  end if;
  if coalesce((select (value->>'enabled')::boolean from public.platform_settings where key = 'broadcast'), false) is not true then
    raise notice 'broadcast kill-switch is off, nothing queued';
    return;
  end if;

  insert into public.broadcasts (course_id, created_by, image_path, body_uz, body_ru, body_en,
                                 button_label, button_url, mode, status, started_at)
  values (_course, null, null,
    '🛠 <b>Texnik muammo boʻlsa — botga yozing!</b>' || E'\n\n' ||
    'Video ochilmayaptimi, vazifa qabul qilinmayaptimi yoki platformada nimadir ishlamayaptimi? ' ||
    'Botdagi <b>«❓ Yordam»</b> tugmasini bosing va muammoni yozing — kerak boʻlsa, <b>skrinshot</b> ham yuboring.' || E'\n\n' ||
    'Xabaringiz toʻgʻridan-toʻgʻri adminga boradi, javob esa shu yerga keladi. ✅',
    '🛠 <b>Техническая проблема? Напишите боту!</b>' || E'\n\n' ||
    'Не открывается видео, не принимается задание или что-то не работает на платформе? ' ||
    'Нажмите в боте кнопку <b>«❓ Помощь»</b> и опишите проблему — при необходимости приложите <b>скриншот</b>.' || E'\n\n' ||
    'Сообщение уйдёт прямо администратору, а ответ придёт сюда. ✅',
    '🛠 <b>A technical problem? Tell the bot!</b>' || E'\n\n' ||
    'A video won''t open, a task isn''t accepted or something on the platform doesn''t work? ' ||
    'Tap <b>«❓ Help»</b> in the bot and describe the problem — add a <b>screenshot</b> if it helps.' || E'\n\n' ||
    'Your message goes straight to an admin, and the answer comes back here. ✅',
    null, null, 'all', 'sending', now())
  returning id into _bid;

  insert into public.broadcast_deliveries (broadcast_id, user_id, telegram_id, scheduled_for)
  select _bid, p.id, p.telegram_id, now()
    from public.profiles p
    join public.groups g on g.id = p.group_id
   where g.course_id = _course
     and p.telegram_id is not null
     and p.telegram_write_access_at is not null
     and p.status = 'active' and p.archived_at is null
     and not exists (select 1 from public.user_roles r
                      where r.user_id = p.id and r.role in ('admin', 'superadmin', 'teacher'));
  get diagnostics _n = row_count;

  if _n > 300 then
    raise exception 'ABORT: % recipients — more than the whole 6.0 cohort', _n;
  end if;
  update public.broadcasts set total = _n,
         status = case when _n = 0 then 'done' else status end,
         finished_at = case when _n = 0 then now() end
   where id = _bid;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'broadcast_created', jsonb_build_object(
    'broadcast_id', _bid, 'course_id', _course, 'mode', 'all', 'total', _n, 'has_image', false,
    'marker', _marker, 'migration', '20261006184000'));
end $$;
