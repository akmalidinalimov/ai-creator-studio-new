-- One student, two accounts: @lawyer_rahimov could not submit homework (owner report, 2026-10-06).
--
-- EVIDENCE (webhook_inbox / admin_actions):
--   * A «Lawyer A.R» 3e57f247… — the REAL account: telegram_id 8353138710, created 10-03 13:34 by the bot's
--     auto-registration (dm_start_member) into 4-GURUH, telegram_username NULL (Telegram sent none then); 99 XP, all 181
--     of his group messages. Every bot / Mini App path resolves him by telegram_id → this account.
--   * B «Talaba» ad0afe2e… — created 10-05 08:44 by the sales intake from the username only (the intake looks profiles
--     up by telegram_username, A had none, so it made a second account) in 3-GURUH; telegram_id NULL, never used:
--     0 XP, 0 homework, 0 lessons, 0 tasks.
--   * 10-05 15:41 the group-mismatch watchdog flagged A (profile 4-GURUH, writes in 3-GURUH, 16 refused tasks); at
--     18:52 A's group was cleared in the admin UI (4-GURUH → NULL) — B looked like the real student in 3-GURUH.
--     Since then the bot answers him "you are not in this group" (challenge_task_sender_held no_group,
--     hw_capture_skipped sender_has_no_group) and the site shows "Topshirish manzili sozlanmagan".
--   * The bot DOES stamp a sender's username on his profile (resolveProfileForTelegramUser), but B already owned
--     «lawyer_rahimov» (unique index), so the stamp failed — and silently (fixed in the same PR: now DB-visible).
--
-- 1. HEAL (fan-out over every such pair, 2026-10-06): a username-only profile B (telegram_id NULL) whose username the
--    bot has seen on a Telegram user who already owns profile A (by telegram_id), both active. Healed automatically
--    only when B is EMPTY (no XP, homework, lessons, daily tasks): B is archived and its username released, A takes
--    the username if it has none and — if A has no group — B's group. Today: @lawyer_rahimov (A → 3-GURUH) and @adm1n_kaa (VIP 5.0,
--    A already in the same group, B an empty phantom). Two pairs from May (neither in a group) are left alone.
--    A's move into 3-GURUH runs the normal move triggers: his group-3 chat / media points and his refused 3-GURUH
--    task posts are carried (20261005103000), so nothing he did there is lost.
-- 2. TELL HIM: a one-recipient DM through the broadcast pipeline — the group is fixed, resend the homework.
-- 3. DETECTOR identity_split_watchdog() (hourly :47, admin DM 08:00–22:00 Tashkent, one alert per pair per 20 h):
--    every such pair, auto-healable or not, and every bot 'telegram_username_conflict' signal of the last 24 h.

-- ───────────────────────────── the pair query (shared by the heal and the watchdog) ─────────────────────────────
create or replace function public.identity_split_pairs()
returns table (a_id uuid, b_id uuid, username text, a_group uuid, b_group uuid, b_empty boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  -- B: a profile known only by username (telegram_id NULL); A: the profile of the Telegram user the bot has seen
  -- using that username. Both active, not archived. b_empty: B never did anything (safe to retire).
  with seen as (
    select distinct on (lower(w.from_username)) lower(w.from_username) as uname, w.from_user_id as tid
      from public.webhook_inbox w
     where w.from_username is not null and w.from_user_id is not null
       and w.received_at > now() - interval '60 days'
     order by lower(w.from_username), w.received_at desc
  )
  select a.id, b.id, b.telegram_username, a.group_id, b.group_id,
         not exists (select 1 from public.xp_events e where e.user_id = b.id)
         and not exists (select 1 from public.homework_submissions h where h.user_id = b.id)
         and not exists (select 1 from public.lesson_progress l where l.user_id = b.id)
         and not exists (select 1 from public.challenge_task_submissions s where s.user_id = b.id)
    from public.profiles b
    join seen on seen.uname = lower(replace(b.telegram_username, '@', ''))
    join public.profiles a on a.telegram_id = seen.tid and a.id <> b.id
   where b.telegram_id is null
     and b.status = 'active' and b.archived_at is null
     and a.status = 'active' and a.archived_at is null
     and not exists (select 1 from public.user_roles r where r.user_id in (a.id, b.id)
                      and r.role in ('admin', 'superadmin', 'teacher'))
$fn$;

revoke execute on function public.identity_split_pairs() from public, anon, authenticated;
grant execute on function public.identity_split_pairs() to service_role;

-- ───────────────────────────── 1. heal ─────────────────────────────
do $$
declare
  _p record;
  _healed jsonb := '[]'::jsonb;
  _left jsonb := '[]'::jsonb;
begin
  if exists (select 1 from public.admin_actions where action = 'identity_split_healed' and details->>'migration' = '20261006164500') then
    raise notice 'already healed';
    return;
  end if;
  if (select count(*) from public.identity_split_pairs()) > 20 then
    raise exception 'ABORT: % split pairs — the evidence on 2026-10-06 was 4', (select count(*) from public.identity_split_pairs());
  end if;

  for _p in select * from public.identity_split_pairs() loop
    -- only an empty B that has a group to hand over, or that shares A's group (a phantom); never two live groups
    if not _p.b_empty or _p.b_group is null or (_p.a_group is not null and _p.a_group <> _p.b_group) then
      _left := _left || jsonb_build_object('a', _p.a_id, 'b', _p.b_id, 'username', _p.username,
                                           'b_empty', _p.b_empty, 'a_group', _p.a_group, 'b_group', _p.b_group);
      continue;
    end if;
    -- release the username first (unique index), then retire B, then A takes over
    update public.profiles
       set telegram_username = null, group_id = null, status = 'archived', archived_at = now()
     where id = _p.b_id;
    delete from public.enrollments where user_id = _p.b_id;
    update public.profiles
       set telegram_username = coalesce(telegram_username, _p.username),   -- never overwrite A's CURRENT username
           group_id = coalesce(group_id, _p.b_group)
     where id = _p.a_id;
    _healed := _healed || jsonb_build_object('a', _p.a_id, 'b', _p.b_id, 'username', _p.username,
                                             'a_group_was', _p.a_group, 'group_now', coalesce(_p.a_group, _p.b_group));
  end loop;

  if not exists (select 1 from public.profiles where id = '3e57f247-a6aa-4ee4-a03a-fe4f6cb94c67'
                  and group_id = '3a7ebea8-80eb-4b64-a282-471a0fa12ef4' and lower(telegram_username) = 'lawyer_rahimov') then
    raise exception 'ABORT: @lawyer_rahimov was not healed into 3-GURUH';
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'identity_split_healed', jsonb_build_object(
    'migration', '20261006164500', 'healed', _healed, 'left_for_review', _left, 'at', now()));
end $$;

-- ───────────────────────────── 2. tell him ─────────────────────────────
do $$
declare
  _bid uuid;
begin
  if exists (select 1 from public.admin_actions where action = 'broadcast_created' and details->>'marker' = 'lawyer_rahimov_fixed_20261006') then
    return;
  end if;
  if not coalesce((select (value->>'enabled')::boolean from public.platform_settings where key = 'broadcast'), false) then
    raise notice 'broadcast kill-switch is off, no DM';
    return;
  end if;
  insert into public.broadcasts (course_id, created_by, image_path, body_uz, body_ru, body_en, button_label, button_url, mode, status, started_at)
  values ('f502f631-2104-4834-b6c2-702cd3080e27', null, null,
    '✅ <b>Guruhingiz toʻgʻrilandi</b> — siz endi platformada ham <b>3-GURUH</b>dasiz.' || E'\n\n' ||
    'Noqulaylik uchun uzr! Uyga vazifangizni guruhdagi «UYGA VAZIFA» topigiga <b>qayta yuboring</b> — endi qabul qilinadi.',
    '✅ <b>Ваша группа исправлена</b> — теперь и на платформе вы в <b>3-GURUH</b>.' || E'\n\n' ||
    'Извините за неудобство! Отправьте домашнее задание <b>ещё раз</b> в тему «UYGA VAZIFA» группы — теперь оно будет принято.',
    '✅ <b>Your group is fixed</b> — on the platform you are now in <b>3-GURUH</b> too.' || E'\n\n' ||
    'Sorry for the trouble! Please <b>send your homework again</b> to the group''s «UYGA VAZIFA» topic — it will be accepted now.',
    null, null, 'all', 'sending', now())
  returning id into _bid;
  insert into public.broadcast_deliveries (broadcast_id, user_id, telegram_id, scheduled_for)
  select _bid, p.id, p.telegram_id, now() from public.profiles p
   where p.id = '3e57f247-a6aa-4ee4-a03a-fe4f6cb94c67' and p.telegram_id is not null and p.telegram_write_access_at is not null;
  update public.broadcasts set total = (select count(*) from public.broadcast_deliveries where broadcast_id = _bid) where id = _bid;
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'broadcast_created', jsonb_build_object('broadcast_id', _bid, 'mode', 'all', 'total', 1,
    'marker', 'lawyer_rahimov_fixed_20261006', 'migration', '20261006164500'));
end $$;

-- ───────────────────────────── 3. the detector ─────────────────────────────
create or replace function public.identity_split_watchdog()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  _hour int := extract(hour from (now() at time zone 'Asia/Tashkent'))::int;
  _found int := 0;
  _new int := 0;
  _lines text;
  _msg text;
  _tok text;
  _admin record;
  _dm int := 0;
begin
  drop table if exists pg_temp._split;
  create temporary table _split on commit drop as
    select s.a_id, s.b_id, s.username, s.b_empty,
           trim(coalesce(pa.name, '') || ' ' || coalesce(pa.last_name, '')) as a_name, ga.name as a_group,
           trim(coalesce(pb.name, '') || ' ' || coalesce(pb.last_name, '')) as b_name, gb.name as b_group
      from public.identity_split_pairs() s
      join public.profiles pa on pa.id = s.a_id
      join public.profiles pb on pb.id = s.b_id
      left join public.groups ga on ga.id = s.a_group
      left join public.groups gb on gb.id = s.b_group
     where s.a_group is not null or s.b_group is not null;          -- a pair outside every group harms no one
  select count(*) into _found from pg_temp._split;

  delete from pg_temp._split x
   where exists (select 1 from public.admin_actions a
                  where a.action = 'identity_split_alerted' and a.target_user_id = x.b_id
                    and a.created_at > now() - interval '20 hours');
  select count(*) into _new from pg_temp._split;

  if _new > 0 and _hour between 8 and 21 then
    select string_agg(E'\n• @' || x.username || ' — bot hisobi: ' || coalesce(nullif(x.a_name, ''), '?') || ' ('
                      || coalesce(x.a_group, 'guruhsiz') || '), ikkinchi hisob: ' || coalesce(nullif(x.b_name, ''), '?')
                      || ' (' || coalesce(x.b_group, 'guruhsiz') || ')'
                      || case when x.b_empty then '' else ' ⚠️ ikkinchisida ham faollik bor' end,
                      '' order by x.username)
      into _lines from (select * from pg_temp._split order by username limit 15) x;
    _msg := '👥 Bitta o''quvchi — ikkita hisob: ' || _new || coalesce(_lines, '')
            || E'\n\nBot faqat «bot hisobi»ni taniydi. Guruhni oʻsha hisobga qoʻying; ikkinchisi boʻsh boʻlsa — arxivlang.';
    select value->>'bot_token' into _tok from public.platform_settings where key = 'telegram';
    if coalesce(_tok, '') <> '' then
      for _admin in
        select distinct p.telegram_id from public.profiles p
          join public.user_roles ro on ro.user_id = p.id and ro.role in ('admin', 'superadmin')
         where p.telegram_id is not null limit 3
      loop
        begin
          perform public.ops_net_post(
            p_url        := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            p_body       := jsonb_build_object('chat_id', _admin.telegram_id, 'text', left(_msg, 3900), 'disable_web_page_preview', true),
            p_headers    := jsonb_build_object('Content-Type', 'application/json'),
            p_purpose    := 'identity_split_watchdog',
            p_timeout_ms := 5000);
          _dm := _dm + 1;
        exception when others then null; end;
      end loop;
    end if;
    if _dm > 0 then
      insert into public.admin_actions (actor_user_id, action, target_user_id, details)
      select null, 'identity_split_alerted', x.b_id, jsonb_build_object('a', x.a_id, 'username', x.username, 'at', now())
        from (select * from pg_temp._split order by username limit 15) x;
    end if;
  end if;

  insert into public.app_settings (key, value)
  values ('identity_split_watchdog_state', jsonb_build_object(
    'found', _found, 'new', _new, 'dm_attempted', _dm,
    'username_conflicts_24h', (select count(*) from public.admin_actions a
                                where a.action = 'telegram_username_conflict' and a.created_at > now() - interval '24 hours'),
    'checked_at', now()))
  on conflict (key) do update set value = excluded.value;
  return jsonb_build_object('found', _found, 'new', _new, 'dm_attempted', _dm, 'checked_at', now());
end
$fn$;

revoke execute on function public.identity_split_watchdog() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'identity-split-watchdog') then
    perform cron.unschedule('identity-split-watchdog');
  end if;
  perform cron.schedule('identity-split-watchdog', '47 * * * *', 'select public.identity_split_watchdog()');
end $$;
