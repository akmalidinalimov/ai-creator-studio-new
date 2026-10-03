-- A one-off DM to the 15 students moved to AC CHALLENGE | 4-GURUH today (owner request, 2026-10-03):
-- "you are in group 4 now; if your homework wasn't accepted, send it again in group 4's homework topic".
--
-- Why it is needed: until 20261003160000 the platform still listed them in group 2 or 3. Their posts in
-- group 4's homework topic were refused as "another group's topic" (Hosiyat99 twice, robiyamuhammadjanova,
-- Shokabirovlar), and 6 of them have no homework recorded at all.
--
-- HOW: the normal broadcast pipeline (20260723120000_admin_broadcast.sql). One broadcasts row plus one
-- pending broadcast_deliveries row per student, drained by broadcast-drainer every minute: HTML, the
-- student's locale (uz/ru), quiet hours 22:00-08:00 Tashkent (mode 'all' rows due at night are deferred to
-- 08:00), and every outcome is recorded per row. The admin page can only target a whole course, so the
-- rows are written here, the same way createBroadcast() writes them.
--   * The audience is pinned: 14 moved by 20261003160000 + FabrikaUpakovki_97_4443040 (moved by hand
--     earlier today). Only students now in group 4 with a telegram_id receive it.
--   * Students who never pressed Start in the bot (Solarex_ROP, Umida_Kholdaraliyeva) are expected to fail
--     delivery. The owner tags them in the group instead.
--   * Kill-switch respected: nothing is queued unless platform_settings.broadcast.enabled is true.
--   * Replay-safe: a second run finds the broadcast by its marker and does nothing.

do $$
declare
  _course constant uuid := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _g4 constant uuid := '93e8e7b0-275c-47a9-a97d-ff28e26c8f5b';
  _marker constant text := 'group4_resubmit_notice_20261003';
  _bid uuid;
  _n int;
  _sched timestamptz;
  _thour int := extract(hour from (now() at time zone 'Asia/Tashkent'))::int;
begin
  if exists (select 1 from public.admin_actions where action = 'broadcast_created' and details->>'marker' = _marker) then
    raise notice 'group 4 notice already queued, skipping';
    return;
  end if;
  if coalesce((select (value->>'enabled')::boolean from public.platform_settings where key = 'broadcast'), false) is not true then
    raise notice 'broadcast kill-switch is off, nothing queued';
    return;
  end if;

  -- 08:00 Tashkent (03:00 UTC) if it is night now, as scheduledStart() does.
  _sched := (date_trunc('day', now() at time zone 'UTC') + interval '3 hours') at time zone 'UTC';
  if _sched <= now() then _sched := _sched + interval '1 day'; end if;
  if _thour >= 8 and _thour < 22 then _sched := now(); end if;

  insert into public.broadcasts (course_id, created_by, image_path, body_uz, body_ru, body_en,
                                 button_label, button_url, mode, status, started_at)
  values (_course, null, null,
    'Assalomu alaykum! 👋' || E'\n\n' ||
    'Siz endi platformada ham <b>AC CHALLENGE | 4-GURUH</b> a''zosisiz — vazifalaringizni shu guruh ustozi tekshiradi.' || E'\n\n' ||
    '📌 Agar 1-modul uyga vazifasini hali topshirmagan bo''lsangiz yoki 4-GURUH topigiga yuborgan vazifangiz qabul qilinmagan bo''lsa (✅ belgisi qo''yilmagan bo''lsa), iltimos, uni <b>4-GURUH «Uyga vazifa» topigiga</b> qaytadan yuboring va vazifani tanlang.' || E'\n\n' ||
    'Allaqachon qabul qilingan (✅) vazifani qayta yuborish shart emas. Rahmat! 🤍',
    'Здравствуйте! 👋' || E'\n\n' ||
    'Теперь и на платформе вы в группе <b>AC CHALLENGE | 4-GURUH</b> — ваши задания проверяет куратор этой группы.' || E'\n\n' ||
    '📌 Если вы ещё не сдали задание 1-го модуля или задание, отправленное в топик 4-GURUH, не было принято (нет отметки ✅), пожалуйста, отправьте его заново <b>в топик «Uyga vazifa» группы 4-GURUH</b> и выберите задание.' || E'\n\n' ||
    'Уже принятые (✅) задания отправлять повторно не нужно. Спасибо! 🤍',
    null, null, null, 'all', 'sending', now())
  returning id into _bid;

  insert into public.broadcast_deliveries (broadcast_id, user_id, telegram_id, scheduled_for)
  select _bid, p.id, p.telegram_id, _sched
    from public.profiles p
   where p.id in (
       '7ba56d35-6db9-4a25-b2f0-27423155c741', '52f3c697-2aca-4d0f-b18d-f4620f7580e2', 'b6cd6f62-0ec2-4611-8eaa-c04d4c9f4265',
       '71fe5183-2c4f-40e2-a2ac-345a6c436153', '8d1e1a57-97bd-4883-802b-6f10a0e08c99', 'c4c9df13-d6be-4f12-81c5-321e1ab577cf',
       '4d7d4058-2229-4cd8-8692-cbbabf0ad689', '685f2c9c-ba65-4f45-adb2-f8d4380e71ce', '0198174f-eee3-4b92-b7e7-fe6496971c18',
       '309e1c83-4123-42c5-b41c-44e599066575', '45b09e1a-b1cd-42f9-86fa-714df66b3865', '5ba5b937-4214-4f3e-8954-328358484503',
       'c15ce092-6a74-4f39-ae15-f9c342a824ce', '11246c31-2e24-4207-844a-707853b4b8f0', 'db99fcd0-70f4-4a9c-982e-8d675ad4f6ca')
     and p.group_id = _g4
     and p.telegram_id is not null
     and p.status = 'active' and p.archived_at is null;
  get diagnostics _n = row_count;

  if _n > 15 then
    raise exception 'ABORT: % recipients, expected at most 15', _n;
  end if;
  update public.broadcasts set total = _n, status = case when _n = 0 then 'done' else status end,
         finished_at = case when _n = 0 then now() end
   where id = _bid;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'broadcast_created', jsonb_build_object(
    'broadcast_id', _bid, 'course_id', _course, 'mode', 'all', 'total', _n, 'has_image', false,
    'scheduled_for', _sched, 'marker', _marker, 'audience', 'students moved to AC CHALLENGE | 4-GURUH on 2026-10-03',
    'migration', '20261003181000'));
end $$;
