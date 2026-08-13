-- ONE-SHOT broadcast — tell current students about the new ways to earn XP (participation XP + the
-- weekly group leaderboard). Runs once on apply (the pipeline ledgers migrations and never re-applies).
--
-- Reach: posts the announcement into each ACTIVE-course group's General topic (visible to ALL students,
-- incl. the ~70% the bot can't DM) + DMs the onboarded (bot-started) students in those groups.
-- Scoped to active groups only — past cohorts (unpublished courses, inactive groups) can't earn the
-- new XP, so messaging them would be noise.
--
-- Safe: idempotent per recipient (admin_actions 'xp_announcement_sent' guard → re-apply/re-run never
-- double-sends), attributed via ops_net_post('...','xp-announcement'[/-dm]) so any bounced send is
-- captured by ops_http_failure_sweep()/watchdog instead of vanishing. Static message (no user input),
-- so no HTML-injection surface. All sends are async net.http_post enqueues (fire-and-forget).

do $do$
declare
  _tok text; _txt text; _g record; _chat bigint; _s record; _req bigint;
  _groups int := 0; _dms int := 0; _dm_skip int := 0;
begin
  select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
  if _tok is null or _tok = '' then
    insert into admin_actions (actor_user_id, action, details)
    values (null, 'xp_announcement_run', jsonb_build_object('skipped', 'no_bot_token', 'at', now()));
    return;
  end if;

  _txt := $msg$🎉 <b>Yangilik: endi guruhda faol bo'lib, ko'proq XP ishlang!</b>

Bugundan boshlab quyidagilar uchun ball olasiz:

🤝 <b>Yordam bering</b> — boshqa o'quvchining xabariga <i>reply</i> qilib yordam bersangiz: <b>+3 XP</b>
❓ <b>Savol bering</b> — ustozga savol yozsangiz: <b>+2 XP</b> (kuniga 1 marta)

📌 Jamoaviy faollikdan kuniga <b>10 XP gacha</b> olishingiz mumkin. Bu darslar, uy vazifasi va har kunlik faollik XP'siga <b>qo'shimcha</b>.

🏆 Har <b>dushanba</b> guruhingizda <b>Haftalik Top-10</b> e'lon qilamiz — o'tgan hafta eng ko'p XP to'plaganlar. Birinchi bo'lish uchun kurashing! 😎

Bir-biringizga yordam bering, savol berishdan tortinmang. Omad! 💪$msg$;

  -- Group posts (active-course groups, General topic — omit message_thread_id).
  for _g in
    select g.id from groups g join courses c on c.id = g.course_id where c.published = true
  loop
    if exists (select 1 from admin_actions where action = 'xp_announcement_sent'
               and details->>'kind' = 'group' and details->>'group_id' = _g.id::text) then
      continue;
    end if;
    select telegram_chat_id into _chat from group_message_events
      where group_id = _g.id order by sent_at desc limit 1;
    if _chat is null then continue; end if;
    _req := public.ops_net_post(
      'https://api.telegram.org/bot' || _tok || '/sendMessage',
      jsonb_build_object('chat_id', _chat, 'text', _txt, 'parse_mode', 'HTML', 'disable_web_page_preview', true),
      jsonb_build_object('Content-Type', 'application/json'),
      'xp-announcement', 8000);
    insert into admin_actions (actor_user_id, action, details)
    values (null, 'xp_announcement_sent',
            jsonb_build_object('kind', 'group', 'group_id', _g.id, 'chat_id', _chat, 'req_id', _req, 'at', now()));
    _groups := _groups + 1;
  end loop;

  -- DMs to onboarded (bot-started) active students in those groups.
  for _s in
    select p.id, p.telegram_id
    from profiles p
    join user_roles r on r.user_id = p.id and r.role = 'student'
    where p.telegram_onboarded_at is not null
      and p.status = 'active' and p.archived_at is null
      and p.telegram_id is not null
      and p.group_id in (select g.id from groups g join courses c on c.id = g.course_id where c.published = true)
  loop
    if exists (select 1 from admin_actions where action = 'xp_announcement_sent'
               and details->>'kind' = 'dm' and details->>'profile_id' = _s.id::text) then
      _dm_skip := _dm_skip + 1;
      continue;
    end if;
    _req := public.ops_net_post(
      'https://api.telegram.org/bot' || _tok || '/sendMessage',
      jsonb_build_object('chat_id', _s.telegram_id, 'text', _txt, 'parse_mode', 'HTML', 'disable_web_page_preview', true),
      jsonb_build_object('Content-Type', 'application/json'),
      'xp-announcement-dm', 8000);
    insert into admin_actions (actor_user_id, action, details)
    values (null, 'xp_announcement_sent',
            jsonb_build_object('kind', 'dm', 'profile_id', _s.id, 'tgid', _s.telegram_id, 'req_id', _req, 'at', now()));
    _dms := _dms + 1;
  end loop;

  insert into admin_actions (actor_user_id, action, details)
  values (null, 'xp_announcement_run',
          jsonb_build_object('groups', _groups, 'dms', _dms, 'dm_skipped', _dm_skip, 'at', now()));
end
$do$;
