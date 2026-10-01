-- Challenge 6.0 onboarding "starter kit": send it once to the members who ALREADY joined.
--
-- WHY A BACKFILL
--   The bot now sends this message to every new Challenge joiner (nmWelcomeChallenge, this PR's code
--   change). The members who joined BEFORE that code shipped got the old welcome, which told them
--   "lessons unlock after full payment" — untrue since the module ladder (migration 20261001075500)
--   opened module 1 for them. This block sends the correct message to exactly those people, once.
--
-- HOW IT SENDS
--   Through the existing broadcast pipeline — a broadcasts row plus one broadcast_deliveries row per
--   student — never with a direct Telegram call from SQL. That buys the properties a one-off loop would
--   not have: the drainer (cron 'broadcast-drainer-every-minute') paces the sends, retries a transient
--   failure, marks a recipient-side failure terminal, picks each student's own language from
--   profiles.preferred_locale, and leaves every outcome in broadcast_deliveries.status/error. The
--   broadcast-watchdog (every 30 min) already alarms on a broadcast that stalls.
--
-- WHO GETS IT
--   Active, non-archived profiles whose group belongs to course 6.0 and who have a telegram_id (the
--   bot can only DM someone who has opened it, which every auto-registered member has by definition).
--   27 such members at the time of writing. Nobody outside a Challenge 6.0 group is targeted, and the
--   block asserts that.
--
-- IDEMPOTENT: it is skipped entirely if its audit row already exists, so a replayed deploy cannot send
--   the message twice. Telegram is never called from here, so a rollback cannot "unsend" anything.
--
-- The text is the Uzbek/Russian/English starter kit, identical to the bot's nmWelcomeChallenge with
-- the per-name greeting removed (a broadcast body is the same for everyone). Every button and number
-- in it is real; the two rules that do not pay yet (answering a classmate, which is still judged in
-- shadow mode, and the Instagram @mention bonus, which needs the Meta app) are deliberately absent.

do $$
declare
  _course constant uuid := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _bid uuid;
  _n int;
  _outside int;
  _uz text;
  _ru text;
  _en text;
begin
  if exists (select 1 from public.admin_actions where action = 'challenge_onboarding_backfill') then
    raise notice 'challenge onboarding backfill already queued — nothing to do';
    return;
  end if;

  _uz :=
    '🎉 <b>AI CREATORS CHALLENGE 6.0</b>ga xush kelibsiz!' || E'\n\n' ||
    'Hisobingiz ochildi. Quyida 4 ta muhim narsa — bir daqiqada o''qib chiqing.' || E'\n\n' ||
    '<b>1) Darslar 📚</b>' || E'\n' ||
    'Hozir <b>1-modul</b> ochiq — «📚 Davom etish» tugmasini bosing. Keyingi modullar har hafta navbati bilan ochiladi.' || E'\n\n' ||
    '<b>2) Ismingizni to''g''rilang ✏️</b>' || E'\n' ||
    '/profil → «✏️ Ismni o''zgartirish». Reyting va sertifikatda aynan shu ism chiqadi.' || E'\n\n' ||
    '<b>3) Ball jadvali ⭐️</b>' || E'\n' ||
    '• Dars tugatish — <b>+20</b>' || E'\n' ||
    '• Uyga vazifa topshirish — <b>+15</b> (guruhdagi «UYGA VAZIFA» mavzusiga yuboring)' || E'\n' ||
    '• Vazifaga 9–10 baho — <b>+25</b>' || E'\n' ||
    '• Kunlik vazifa — <b>+5</b>, Instagram vazifasi — <b>+8</b> (5-oktabrdan, har kuni 09:00da «KUNLIK VAZIFALAR» mavzusida)' || E'\n' ||
    '• 5 kun ketma-ket o''z vaqtida bajarsangiz — <b>+10 bonus</b>' || E'\n' ||
    '• Guruhda faollik — har xabar uchun <b>+1</b> (kuniga 5 ballgacha)' || E'\n' ||
    '• O''z ishingizni guruhga tashlasangiz (rasm/video) — <b>+5</b> (kuniga 3 martagacha)' || E'\n' ||
    '• Har kuni platformaga kirish — <b>+5</b>' || E'\n' ||
    'Kechikkan kunlik vazifa — yarim ball; 2 kundan keyin yopiladi.' || E'\n\n' ||
    '<b>4) Reytingni ko''rish 📊</b>' || E'\n' ||
    '«📊 Statistikam» — o''z ballaringiz. /profil → «👥 Guruh reytingi» — guruhingizdagi o''rningiz.' || E'\n\n' ||
    'Savol bo''lsa — «❓ Yordam». Omad! 🚀';

  _ru :=
    '🎉 Добро пожаловать в <b>AI CREATORS CHALLENGE 6.0</b>!' || E'\n\n' ||
    'Аккаунт открыт. Ниже 4 главных вещи — прочитайте за минуту.' || E'\n\n' ||
    '<b>1) Уроки 📚</b>' || E'\n' ||
    'Сейчас открыт <b>1-й модуль</b> — нажмите «📚 Продолжить». Следующие модули открываются каждую неделю по очереди.' || E'\n\n' ||
    '<b>2) Исправьте своё имя ✏️</b>' || E'\n' ||
    '/profil → «✏️ Изменить имя». Именно это имя попадёт в рейтинг и сертификат.' || E'\n\n' ||
    '<b>3) Как начисляются баллы ⭐️</b>' || E'\n' ||
    '• Завершить урок — <b>+20</b>' || E'\n' ||
    '• Сдать домашнее задание — <b>+15</b> (в тему «UYGA VAZIFA» вашей группы)' || E'\n' ||
    '• Оценка 9–10 за задание — <b>+25</b>' || E'\n' ||
    '• Ежедневное задание — <b>+5</b>, задание с Instagram — <b>+8</b> (с 5 октября, каждый день в 09:00 в теме «KUNLIK VAZIFALAR»)' || E'\n' ||
    '• 5 дней подряд вовремя — <b>+10 бонус</b>' || E'\n' ||
    '• Активность в группе — <b>+1</b> за сообщение (до 5 баллов в день)' || E'\n' ||
    '• Своя работа в группе (фото/видео) — <b>+5</b> (до 3 раз в день)' || E'\n' ||
    '• Ежедневный вход на платформу — <b>+5</b>' || E'\n' ||
    'Опоздали с ежедневным заданием — половина баллов; через 2 дня оно закрывается.' || E'\n\n' ||
    '<b>4) Рейтинг 📊</b>' || E'\n' ||
    '«📊 Моя статистика» — ваши баллы. /profil → «👥 Рейтинг группы» — ваше место в группе.' || E'\n\n' ||
    'Вопросы — «❓ Помощь». Удачи! 🚀';

  _en :=
    '🎉 Welcome to <b>AI CREATORS CHALLENGE 6.0</b>!' || E'\n\n' ||
    'Your account is open. Four things to know — one minute to read.' || E'\n\n' ||
    '<b>1) Lessons 📚</b>' || E'\n' ||
    '<b>Module 1</b> is open now — tap «📚 Continue». The next modules open one per week.' || E'\n\n' ||
    '<b>2) Fix your name ✏️</b>' || E'\n' ||
    '/profil → «✏️ Edit name». This is the name that appears in the rating and on your certificate.' || E'\n\n' ||
    '<b>3) How points work ⭐️</b>' || E'\n' ||
    '• Finish a lesson — <b>+20</b>' || E'\n' ||
    '• Submit homework — <b>+15</b> (into your group''s «UYGA VAZIFA» topic)' || E'\n' ||
    '• A score of 9–10 — <b>+25</b>' || E'\n' ||
    '• Daily task — <b>+5</b>, Instagram task — <b>+8</b> (from 5 October, every day at 09:00 in «KUNLIK VAZIFALAR»)' || E'\n' ||
    '• 5 days in a row on time — <b>+10 bonus</b>' || E'\n' ||
    '• Being active in the group — <b>+1</b> per message (up to 5 a day)' || E'\n' ||
    '• Sharing your own work in the group (photo/video) — <b>+5</b> (up to 3 a day)' || E'\n' ||
    '• Opening the platform each day — <b>+5</b>' || E'\n' ||
    'A late daily task pays half; after 2 days it closes.' || E'\n\n' ||
    '<b>4) Your rating 📊</b>' || E'\n' ||
    '«📊 My stats» — your points. /profil → «👥 Group rating» — your place in the group.' || E'\n\n' ||
    'Questions — «❓ Help». Good luck! 🚀';

  -- Telegram's text limit is 4096; refuse to queue something that would be rejected for everyone.
  if length(_uz) > 4000 or length(_ru) > 4000 or length(_en) > 4000 then
    raise exception 'ABORT: a starter-kit body is too long for one Telegram message (uz %, ru %, en %)',
      length(_uz), length(_ru), length(_en);
  end if;

  insert into public.broadcasts (course_id, created_by, body_uz, body_ru, body_en, mode, status, started_at)
  values (_course, null, _uz, _ru, _en, 'all', 'sending', now())
  returning id into _bid;

  insert into public.broadcast_deliveries (broadcast_id, user_id, telegram_id, scheduled_for)
  select _bid, p.id, p.telegram_id, now()
    from public.profiles p
    join public.groups g on g.id = p.group_id
   where g.course_id = _course
     and p.telegram_id is not null
     and p.status = 'active'
     and p.archived_at is null;
  select count(*) into _n from public.broadcast_deliveries where broadcast_id = _bid;

  if _n = 0 then
    -- Nothing to send: close the broadcast rather than leaving it 'sending' for the watchdog to find.
    update public.broadcasts set status = 'done', total = 0, finished_at = now() where id = _bid;
    raise exception 'ABORT: no reachable challenge member found — nothing was queued (broadcast closed)';
  end if;
  update public.broadcasts set total = _n where id = _bid;

  -- Nobody outside a Challenge 6.0 group may be in this broadcast.
  select count(*) into _outside
    from public.broadcast_deliveries d
    join public.profiles p on p.id = d.user_id
   where d.broadcast_id = _bid
     and coalesce((select g.course_id from public.groups g where g.id = p.group_id), '00000000-0000-0000-0000-000000000000'::uuid) <> _course;
  if _outside > 0 then
    raise exception 'ABORT: % delivery row(s) target a student outside challenge 6.0', _outside;
  end if;
  if exists (select 1 from public.broadcast_deliveries where broadcast_id = _bid and status <> 'pending') then
    raise exception 'ABORT: a freshly queued delivery is not pending';
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'challenge_onboarding_backfill', jsonb_build_object(
    'at', now(),
    'migration', '20261001081500',
    'broadcast_id', _bid,
    'course_id', _course,
    'queued', _n,
    'drained_by', 'broadcast-drainer-every-minute',
    'why', 'members who joined before nmWelcomeChallenge shipped got the old "lessons unlock after full payment" welcome, which the module ladder made untrue'));
end $$;
