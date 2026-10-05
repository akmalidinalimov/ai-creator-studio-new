-- Broadcast the new points rules to every Challenge 6.0 student (owner request, 2026-10-05).
--
-- The rules went live in 20261005070000 (chat 0; a helpful answer +3; an answered real question +2; questions +
-- answers ≤ 10 a day; own work +5 at most twice a day). This tells the students, in their own language.
--
-- HOW: the normal broadcast pipeline — one broadcasts row + one pending broadcast_deliveries row per student; the
-- broadcast-drainer sends in each student's locale (uz / ru / en), defers anything due in quiet hours to 08:00, and
-- records every outcome. Audience: students of a course-6.0 group who pressed Start in the bot (the bot cannot DM the
-- others), active, not archived, not staff. Respects the broadcast kill-switch. Replay-safe (audit marker).

do $$
declare
  _course constant uuid := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _marker constant text := 'new_points_rules_20261005';
  _bid uuid;
  _n int;
begin
  if exists (select 1 from public.admin_actions where action = 'broadcast_created' and details->>'marker' = _marker) then
    raise notice 'new points rules broadcast already queued';
    return;
  end if;
  if coalesce((select (value->>'enabled')::boolean from public.platform_settings where key = 'broadcast'), false) is not true then
    raise notice 'broadcast kill-switch is off, nothing queued';
    return;
  end if;

  insert into public.broadcasts (course_id, created_by, image_path, body_uz, body_ru, body_en,
                                 button_label, button_url, mode, status, started_at)
  values (_course, null, null,
    '📢 <b>Ball tizimidagi o‘zgarish</b>' || E'\n\n' ||
    'Guruhda oddiy yozishma endi ball bermaydi. Ball <b>foydali</b> faollik uchun beriladi:' || E'\n\n' ||
    '💬 Guruhdoshingizning savoliga <b>foydali javob</b> — <b>+3 ball</b>' || E'\n' ||
    '❓ Javob olgan <b>haqiqiy savolingiz</b> (dars yoki platforma bo‘yicha) — <b>+2 ball</b>' || E'\n' ||
    '📸 O‘z ishingizni guruhga tashlash (rasm/video) — <b>+5 ball</b> (kuniga 2 martagacha)' || E'\n\n' ||
    'Savol-javoblardan jami <b>kuniga 10 ballgacha</b>. Savol va javoblarni AI tekshiradi: salomlashish, «rahmat» yoki mavzudan tashqari xabarlar ball bermaydi.' || E'\n\n' ||
    'Asosiy ballar o‘zgarmaydi: darslar, uyga vazifa va kunlik vazifalar.' || E'\n\n' ||
    'Savol bering, bir-biringizga yordam bering — shu uchun ball oling! 💪',
    '📢 <b>Изменения в системе баллов</b>' || E'\n\n' ||
    'Обычная переписка в группе больше не приносит баллы. Баллы начисляются за <b>полезную</b> активность:' || E'\n\n' ||
    '💬 <b>Полезный ответ</b> на вопрос однокурсника — <b>+3 балла</b>' || E'\n' ||
    '❓ Ваш <b>настоящий вопрос</b> (по урокам или платформе), получивший ответ — <b>+2 балла</b>' || E'\n' ||
    '📸 Своя работа в группе (фото/видео) — <b>+5 баллов</b> (до 2 раз в день)' || E'\n\n' ||
    'За вопросы и ответы — всего <b>до 10 баллов в день</b>. Вопросы и ответы проверяет AI: приветствия, «спасибо» и сообщения не по теме баллов не дают.' || E'\n\n' ||
    'Основные баллы не меняются: уроки, домашние задания и ежедневные задания.' || E'\n\n' ||
    'Задавайте вопросы, помогайте друг другу — и получайте за это баллы! 💪',
    '📢 <b>Changes to the points system</b>' || E'\n\n' ||
    'Ordinary chatting in the group no longer earns points. Points now go to <b>useful</b> activity:' || E'\n\n' ||
    '💬 A <b>helpful answer</b> to a classmate''s question — <b>+3 points</b>' || E'\n' ||
    '❓ Your <b>real question</b> (about lessons or the platform) that gets answered — <b>+2 points</b>' || E'\n' ||
    '📸 Sharing your own work in the group (photo/video) — <b>+5 points</b> (up to 2 a day)' || E'\n\n' ||
    'Questions and answers together: <b>up to 10 points a day</b>. They are checked by AI: greetings, «thanks» and off-topic messages earn nothing.' || E'\n\n' ||
    'The main points stay the same: lessons, homework and daily tasks.' || E'\n\n' ||
    'Ask questions, help each other — and earn points for it! 💪',
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
    'marker', _marker, 'migration', '20261005080000'));
end $$;
