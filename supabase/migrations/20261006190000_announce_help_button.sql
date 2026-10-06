-- Tell Challenge 6.0 students they can report a technical problem with the bot's «❓ Yordam» button (owner request,
-- 2026-10-06; the support flow went live in #278). The owner asked for the fuller text: what to report, the three
-- ways to explain it (text, screenshot, voice message) and an answer within 24 hours.
--
-- The wording matches support.ts exactly: ONE message is taken per «❓ Yordam» tap (an album of screenshots counts as
-- one); more details are added by tapping the button again (they join the same open request).
--
-- The normal broadcast pipeline: one broadcasts row + one pending broadcast_deliveries row per student; the drainer
-- sends uz / ru / en and DEFERS quiet hours (22:00–08:00 Tashkent) to 08:00. Audience as before: a course-6.0 group,
-- the bot can DM them (telegram_write_access_at), active, not archived, not staff. Respects the kill-switch.
-- Replay-safe (audit marker).

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
    '🛠 <b>Texnik yordam endi botning ichida!</b>' || E'\n\n' ||
    'Platformada yoki botda muammo chiqdimi? Masalan:' || E'\n' ||
    '• video dars ochilmayapti yoki toʻxtab qolyapti;' || E'\n' ||
    '• uyga vazifa yoki qoʻshimcha vazifa qabul qilinmayapti;' || E'\n' ||
    '• ballaringiz yoki guruhingiz notoʻgʻri koʻrinyapti;' || E'\n' ||
    '• platformaga kira olmayapsiz.' || E'\n\n' ||
    '<b>Qanday murojaat qilasiz:</b>' || E'\n' ||
    '1️⃣ Botdagi <b>«❓ Yordam»</b> tugmasini bosing.' || E'\n' ||
    '2️⃣ Muammoni oʻzingizga qulay usulda tushuntiring: <b>matn</b> yozing, <b>skrinshot</b> yuboring (izoh bilan) ' ||
    'yoki <b>ovozli xabar</b> qoldiring. Bir nechta skrinshotni bittada yuborsangiz ham boʻladi.' || E'\n' ||
    '3️⃣ Bot sizga murojaat raqamini beradi (masalan, <b>#12</b>). Yana nimadir qoʻshmoqchi boʻlsangiz — ' ||
    '«❓ Yordam»ni qayta bosing, u shu murojaatga qoʻshiladi.' || E'\n\n' ||
    'Xabaringiz toʻgʻridan-toʻgʻri adminga boradi. Javob <b>24 soat ichida</b> shu botga keladi. ✅',
    '🛠 <b>Техподдержка теперь прямо в боте!</b>' || E'\n\n' ||
    'Возникла проблема на платформе или в боте? Например:' || E'\n' ||
    '• видеоурок не открывается или зависает;' || E'\n' ||
    '• домашнее или дополнительное задание не принимается;' || E'\n' ||
    '• баллы или группа отображаются неверно;' || E'\n' ||
    '• не получается войти на платформу.' || E'\n\n' ||
    '<b>Как обратиться:</b>' || E'\n' ||
    '1️⃣ Нажмите в боте кнопку <b>«❓ Помощь»</b>.' || E'\n' ||
    '2️⃣ Объясните проблему как вам удобно: напишите <b>текст</b>, отправьте <b>скриншот</b> (с подписью) ' ||
    'или запишите <b>голосовое сообщение</b>. Несколько скриншотов можно отправить одним сообщением.' || E'\n' ||
    '3️⃣ Бот пришлёт номер обращения (например, <b>#12</b>). Хотите что-то добавить — нажмите «❓ Помощь» ещё раз, ' ||
    'это добавится к тому же обращению.' || E'\n\n' ||
    'Сообщение уйдёт прямо администратору. Ответ придёт в этот бот <b>в течение 24 часов</b>. ✅',
    '🛠 <b>Tech support is now right inside the bot!</b>' || E'\n\n' ||
    'Ran into a problem on the platform or in the bot? For example:' || E'\n' ||
    '• a video lesson won''t open or keeps freezing;' || E'\n' ||
    '• your homework or extra task isn''t accepted;' || E'\n' ||
    '• your points or your group look wrong;' || E'\n' ||
    '• you can''t log in to the platform.' || E'\n\n' ||
    '<b>How to report it:</b>' || E'\n' ||
    '1️⃣ Tap <b>«❓ Help»</b> in the bot.' || E'\n' ||
    '2️⃣ Explain the problem the way that suits you: write a <b>text</b>, send a <b>screenshot</b> (with a caption) ' ||
    'or record a <b>voice message</b>. Several screenshots can go in one message.' || E'\n' ||
    '3️⃣ The bot gives you a request number (for example, <b>#12</b>). Want to add something? Tap «❓ Help» again — ' ||
    'it joins the same request.' || E'\n\n' ||
    'Your message goes straight to an admin. The answer comes to this bot <b>within 24 hours</b>. ✅',
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
    'marker', _marker, 'migration', '20261006190000'));
end $$;
