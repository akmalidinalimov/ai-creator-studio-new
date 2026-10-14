-- Tell 1-GURUH's curator the question reminders did not reach her (owner, 2026-10-14: "send notification to necessary
-- users"). PR #309: a student name in Mathematical Bold letters cut mid-character made Telegram refuse every
-- teacher-questions reminder that held it — 367 failed sends, 2026-10-12 11:35 → 2026-10-14 16:45 Tashkent, to two
-- curators. Gulhayo (2-GURUH) has no backlog (her group's only open question is fresh), so only Rano — the only curator
-- of 1-GURUH, which has the backlog — is told: an apology, the live number of waiting questions, and the ❓ Savollar
-- inbox button (tq:s). Daytime only (08:00–21:59 Tashkent); once (audit marker).
do $$
declare
  _marker constant text := 'missed_tq_reminders_20261014';
  _tg constant bigint := 5491811269;           -- Rano (@Rano_suvonqulovna), curator of AC CHALLENGE | 1-GURUH
  _tok text;
  _open int;
  _old int;
  _oldest date;
  _hour int := extract(hour from now() at time zone 'Asia/Tashkent')::int;
  _text text;
begin
  if exists (select 1 from public.admin_actions where action = 'curator_notified' and details->>'marker' = _marker) then
    raise notice 'curator already notified'; return;
  end if;
  if _hour < 8 or _hour >= 22 then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'curator_notify_skipped', jsonb_build_object('marker', _marker, 'reason', 'quiet hours', 'hour', _hour));
    raise notice 'quiet hours — not sent'; return;
  end if;
  select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
  if coalesce(_tok, '') = '' then raise notice 'no bot token'; return; end if;

  select count(*), count(*) filter (where q.asked_at < now() - interval '1 day'), min(q.asked_at at time zone 'Asia/Tashkent')::date
    into _open, _old, _oldest
    from public.teacher_questions q join public.groups g on g.id = q.group_id
   where q.status = 'open' and g.name = 'AC CHALLENGE | 1-GURUH';

  _text := 'Assalomu alaykum, Rano! 🙏' || E'\n\n' ||
    '12-oktabrdan beri «KURATORGA SAVOLLAR» boʻyicha eslatmalar sizga texnik xato tufayli yetib bormagan ekan — uzr soʻraymiz. Xato bugun tuzatildi, eslatmalar yana keladi.' ||
    case when _open > 0 then
      E'\n\n' || '📌 Hozir 1-GURUHda <b>' || _open || ' ta savol</b> javob kutmoqda'
      || case when _old > 0 then ' (' || _old || ' tasi 1 kundan ortiq, eng eskisi ' || to_char(_oldest, 'DD.MM') || ' dan)' else '' end
      || '.' || E'\n\n' || 'Quyidagi tugma orqali roʻyxatni ochib, javob berishingiz mumkin 👇'
    else E'\n\n' || 'Hozircha javob kutayotgan savol yoʻq 🎉' end;

  perform public.ops_net_post(
    p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
    p_body       := jsonb_build_object('chat_id', _tg, 'text', _text, 'parse_mode', 'HTML',
                      'reply_markup', jsonb_build_object('inline_keyboard',
                        jsonb_build_array(jsonb_build_array(jsonb_build_object('text', '❓ Savollar', 'callback_data', 'tq:s'))))),
    p_headers    := jsonb_build_object('Content-Type', 'application/json'),
    p_purpose    := 'curator_missed_reminders_notice',
    p_timeout_ms := 10000);

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'curator_notified', jsonb_build_object('marker', _marker, 'telegram_id', _tg, 'open', _open, 'older_1d', _old,
          'migration', '20261014121300'));
end $$;
