-- Platform bug sweep (owner, 2026-10-11: "the issues with watching videos, points not given, homework submission —
-- check the code, fix the problem and let the user know it's fixed"). Investigated from evidence first: 48
-- complaining students, every complaint mapped. The points engine itself is healthy (30 days: 2,428 lesson completions
-- → 2,428 +20; homework +15 / +25 missing on 1 row each; user_xp = Σ xp_events for all 210 6.0 students).
-- Code fixes ship in the same PR (bot + Mini App); this migration HEALS and NOTIFIES:
--
-- 1. «❓ Yordam» descriptions lost (RC1). typedIntent treated any description containing vazifa / dars / ball / kurs /
--    modul as a menu command: 11 of 11 since 10-06 (10 students) became a screen instead of a ticket, with no signal.
--    → each lost message becomes an open ticket (one per student, messages merged, idempotent on the message id); they
--      appear in the admins' «🆘 Murojaatlar» inbox and the 5-hourly summary, and support_tickets_watchdog DMs the
--      admins about tickets that reached no admin card. The student is told their message has now reached the team.
-- 2. Grading speed (RC4): 3-GURUH's median wait was 35.8 h (p90 62.6 h); the curator was reminded, nobody else knew.
--    → grading_sla_watchdog() (hourly :17): an ungraded submission older than 36 h in an active-course group → the
--      admins, once per group per day (admin_actions grading_sla_breach; state grading_sla_watchdog_state).
-- 3. "It's fixed" message (RC2/RC3/RC5) to every student who hit: the «Nimadir noto'g'ri ketdi» crash after deploys
--    (fixed #293/#294), the «Failed to fetch» homework upload (fixed #295), or a lesson video that failed to load
--    (fixed in this PR: the Mini App kept dropping its login on a weak connection; the video now retries). Through the
--    broadcast pipeline (quiet hours, every outcome recorded); only students the bot can write to.
-- Replay-safe: audit markers.

do $$
declare
  _marker_t constant text := 'support_lost_heal_20261011';
  _marker_n constant text := 'platform_fixed_20261011';
  _course constant uuid := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _tok text;
  _r record;
  _p record;
  _tid bigint;
  _made int := 0;
  _told int := 0;
  _bid uuid;
  _n int;
  _found int;
  _note constant text :=
    'Assalomu alaykum! «❓ Yordam» orqali yozgan xabaringiz texnik xato tufayli adminlarga yetib bormagan ekan — uzr soʻraymiz 🙏' || E'\n\n' ||
    'Xato tuzatildi. Murojaatingiz hozir koʻrib chiqilmoqda, javobini shu yerga yuboramiz.';
begin
  -- ── 1. lost «❓ Yordam» descriptions → tickets ──
  if not exists (select 1 from public.admin_actions where action = 'support_lost_heal' and details->>'marker' = _marker_t) then
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    select count(*) into _found from public.webhook_inbox
     where id in (168069, 168348, 168496, 168584, 170707, 170823, 173389, 174177, 174311, 174319, 174580);
    for _r in
      select w.from_user_id as tg, min(w.received_at) as first_at,
             jsonb_agg(jsonb_build_object('at', w.received_at, 'text', left(coalesce(w.raw_update#>>'{message,text}', ''), 4000),
                                          'media', null, 'message_id', (w.raw_update#>>'{message,message_id}')::bigint,
                                          'healed', 'typed_intent_loss')
                       order by w.received_at) as msgs
        from public.webhook_inbox w
       where w.id in (168069, 168348, 168496, 168584, 170707, 170823, 173389, 174177, 174311, 174319, 174580)
       group by w.from_user_id
    loop
      -- already a ticket holding one of these messages → skip (idempotent)
      if exists (select 1 from public.support_tickets t, jsonb_array_elements(_r.msgs) m
                  where t.telegram_id = _r.tg and t.messages @> jsonb_build_array(jsonb_build_object('message_id', m->'message_id'))) then
        continue;
      end if;
      select p.id, p.name, p.last_name, p.telegram_username, g.name as gname, coalesce(p.preferred_locale, 'uz') as loc
        into _p
        from public.profiles p left join public.groups g on g.id = p.group_id
       where p.telegram_id = _r.tg
       order by (p.status = 'active') desc, p.created_at desc limit 1;
      insert into public.support_tickets (user_id, telegram_id, chat_id, username, display_name, group_name, locale, status,
                                          messages, admin_messages, created_at, updated_at)
      values (_p.id, _r.tg, _r.tg, _p.telegram_username, nullif(btrim(coalesce(_p.name, '') || ' ' || coalesce(_p.last_name, '')), ''),
              _p.gname, case when _p.loc in ('uz', 'ru', 'en') then _p.loc else 'uz' end, 'open',
              _r.msgs, '[]'::jsonb, _r.first_at, now())
      returning id into _tid;
      _made := _made + 1;
      if coalesce(_tok, '') <> '' then
        perform public.ops_net_post(
          p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
          p_body       := jsonb_build_object('chat_id', _r.tg, 'text', _note),
          p_headers    := jsonb_build_object('Content-Type', 'application/json'),
          p_purpose    := 'support_lost_heal',
          p_timeout_ms := 10000);
        _told := _told + 1;
      end if;
    end loop;
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'support_lost_heal', jsonb_build_object('marker', _marker_t, 'lost_found', _found, 'tickets', _made, 'students_told', _told,
                                                           'migration', '20261011082500'));
  end if;

  -- ── 3. "it's fixed" to the students who hit the crash / upload / video failures ──
  if not exists (select 1 from public.admin_actions where action = 'broadcast_created' and details->>'marker' = _marker_n)
     and coalesce((select (value->>'enabled')::boolean from public.platform_settings where key = 'broadcast'), false) then
    insert into public.broadcasts (course_id, created_by, image_path, body_uz, body_ru, body_en, button_label, button_url, mode, status, started_at)
    values (_course, null, null,
      '🛠 <b>Ilovadagi xatolar tuzatildi</b>' || E'\n\n' ||
      'Soʻnggi kunlarda sizda ham uchragan muammolar hal qilindi:' || E'\n' ||
      '• «Nimadir notoʻgʻri ketdi» oynasi endi chiqmaydi' || E'\n' ||
      '• Uyga vazifa sekin internetda ham yuklanadi — ilova uni oʻzi tekshiradi' || E'\n' ||
      '• Dars videosi yuklanmay qolsa, ilova oʻzi qayta urinadi' || E'\n\n' ||
      'Ilovani yopib, qayta oching — hammasi odatdagidek ishlaydi. Muammo qolsa, «❓ Yordam» tugmasi orqali yozing 🙏',
      '🛠 <b>Ошибки в приложении исправлены</b>' || E'\n\n' ||
      'Проблемы последних дней, с которыми вы столкнулись, решены:' || E'\n' ||
      '• окно «Что-то пошло не так» больше не появляется' || E'\n' ||
      '• домашнее задание загружается даже при медленном интернете — приложение само проверяет его' || E'\n' ||
      '• если видео урока не загрузилось, приложение само пробует ещё раз' || E'\n\n' ||
      'Закройте и снова откройте приложение — всё работает как обычно. Если проблема осталась, напишите через «❓ Помощь» 🙏',
      '🛠 <b>App errors fixed</b>' || E'\n\n' ||
      'The problems you ran into recently are solved:' || E'\n' ||
      '• the «Something went wrong» screen no longer appears' || E'\n' ||
      '• homework uploads work on a slow connection too — the app checks it itself' || E'\n' ||
      '• if a lesson video fails to load, the app retries on its own' || E'\n\n' ||
      'Close and reopen the app — everything works as usual. If a problem remains, write via «❓ Help» 🙏',
      null, null, 'all', 'sending', now())
    returning id into _bid;

    insert into public.broadcast_deliveries (broadcast_id, user_id, telegram_id, scheduled_for)
    select distinct on (p.telegram_id) _bid, p.id, p.telegram_id, now()
      from public.profiles p
     where p.telegram_id is not null and p.telegram_write_access_at is not null
       and p.status = 'active' and p.archived_at is null
       and not exists (select 1 from public.user_roles r where r.user_id = p.id and r.role in ('admin', 'superadmin', 'teacher'))
       and p.id in (
         select c.user_id from public.client_error_events c
          where c.user_id is not null and c.created_at > '2026-09-28'
            and (c.event_type = 'render_crash'
                 or (c.event_type = 'backend_unreachable' and c.route ilike '%homework%')
                 or c.message = 'lesson_video_url_failed'))
     order by p.telegram_id, p.created_at desc;
    get diagnostics _n = row_count;
    if _n > 400 then raise exception 'ABORT: % recipients for the fixed notice — more than expected', _n; end if;
    update public.broadcasts set total = _n, status = case when _n = 0 then 'done' else status end,
           finished_at = case when _n = 0 then now() end where id = _bid;
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'broadcast_created', jsonb_build_object('broadcast_id', _bid, 'course_id', _course, 'mode', 'all', 'total', _n,
            'has_image', false, 'marker', _marker_n, 'migration', '20261011082500'));
  else
    raise notice 'fixed notice: already queued, or the broadcast kill-switch is off';
  end if;
end $$;

-- ── 2. grading SLA → the admins ─────────────────────────────────────────────────────────────────────────────────
create or replace function public.grading_sla_watchdog()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  _hour int := extract(hour from (now() at time zone 'Asia/Tashkent'))::int;
  _today text := (now() at time zone 'Asia/Tashkent')::date::text;
  _prev jsonb := coalesce((select value from public.app_settings where key = 'grading_sla_watchdog_state'), '{}'::jsonb);
  _sent jsonb := coalesce(_prev->'alerted', '{}'::jsonb);
  _g record;
  _breaches jsonb := '[]'::jsonb;
  _msg text;
  _tok text;
  _admin record;
  _tried int;
begin
  for _g in
    select g.id, g.name,
           (select string_agg(coalesce(nullif(btrim(p.name), ''), '@' || p.telegram_username), ', ')
              from public.profiles p
             where p.id = g.teacher_id or p.id in (select gt.teacher_id from public.group_teachers gt where gt.group_id = g.id)) as curators,
           count(*) as n,
           round(max(extract(epoch from (now() - h.submitted_at)) / 3600)) as oldest_h
      from public.homework_submissions h
      join public.profiles s on s.id = h.user_id and s.status = 'active' and s.archived_at is null
      join public.groups g on g.id = s.group_id
      join public.courses c on c.id = g.course_id and c.published
     where h.submitted_at is not null and h.submitted_at < now() - interval '36 hours'
       and h.submitted_at > now() - interval '14 days'
       and (h.score is null or h.score_is_stale)
     group by g.id, g.name
  loop
    _breaches := _breaches || jsonb_build_object('group', _g.name, 'n', _g.n, 'oldest_h', _g.oldest_h, 'curators', _g.curators);
    if _hour between 9 and 21 and coalesce(_sent->>_g.id::text, '') <> _today then
      _msg := '⏳ Baholash kechikmoqda: ' || _g.name || E'\n' || _g.n || ' ta uyga vazifa 36 soatdan ortiq baholanmagan (eng eskisi '
              || _g.oldest_h || ' soat).' || coalesce(E'\nKurator: ' || _g.curators, E'\nKurator biriktirilmagan.');
      select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
      _tried := 0;
      if coalesce(_tok, '') <> '' then
        for _admin in
          select distinct p.telegram_id from public.profiles p
            join public.user_roles ro on ro.user_id = p.id and ro.role in ('admin', 'superadmin')
           where p.telegram_id is not null and p.status = 'active'
           order by p.telegram_id
        loop
          _tried := _tried + 1;
          begin
            perform public.ops_net_post(
              p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
              p_body       := jsonb_build_object('chat_id', _admin.telegram_id, 'text', left(_msg, 3900)),
              p_headers    := jsonb_build_object('Content-Type', 'application/json'),
              p_purpose    := 'grading_sla_watchdog',
              p_timeout_ms := 5000);
          exception when others then null; end;
        end loop;
      end if;
      -- nobody could be told (no token / no admin) → not marked, so the next hour tries again
      if _tried > 0 then
        _sent := _sent || jsonb_build_object(_g.id::text, _today);
      end if;
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'grading_sla_breach', jsonb_build_object('group_id', _g.id, 'group', _g.name, 'pending', _g.n,
              'oldest_h', _g.oldest_h, 'admins_tried', _tried));
    end if;
  end loop;

  insert into public.app_settings (key, value)
  values ('grading_sla_watchdog_state', jsonb_build_object('checked_at', now(), 'breaches', _breaches, 'alerted', _sent))
  on conflict (key) do update set value = excluded.value;
  return jsonb_build_object('breaches', _breaches);
end
$function$;

revoke execute on function public.grading_sla_watchdog() from public, anon, authenticated;
grant execute on function public.grading_sla_watchdog() to service_role;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'grading-sla-watchdog';
  perform cron.schedule('grading-sla-watchdog', '17 * * * *', $cmd$ select public.grading_sla_watchdog() $cmd$);
end $$;

-- self-test (read-only): the watchdog's query runs (its alert leg only fires 09–21 Tashkent and dedupes per day)
do $test$
declare _n int;
begin
  select count(*) into _n from public.support_tickets where messages @> '[{"healed":"typed_intent_loss"}]';
  raise notice 'healed tickets present: %', _n;
end
$test$;
