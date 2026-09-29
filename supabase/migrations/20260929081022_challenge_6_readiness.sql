-- Challenge 6.0 readiness — three gaps found by the 2026-09-29 end-to-end code verification.
--
-- 1. HOMEWORK CAPTURE: platform_settings.homework_capture = {mode:picker, course_ids:[5.0],
--    auto_register:true}. Picker mode and in-topic auto-registration are scoped to course_ids, so a
--    6.0 homework post fell through to the legacy auto-guess (no picker, no "taxminiy" marker, no retag
--    button for the teacher) and an unregistered 6.0 poster was dropped with a log line only.
--    → append the 6.0 course id (5.0 stays; nothing else in the row changes).
--
-- 2. QUIET GROUPS NEVER GET POSTS: post_group_weekly_boards, post_group_homework_spotlight and
--    post_challenge_team_board found a group's chat ONLY from its latest group_message_events row, so a
--    group nobody has posted in yet is skipped (6.0 groups 1 and 4 today). New helper
--    group_telegram_chat_id(): the configured homework_topic_url (t.me/c/<internal>/…, the same parse the
--    bot's membership gate and submit-homework use) first, the latest message second. Verified read-only
--    2026-09-29: for every group that has both, they are equal — no change for 5.0.
--    (The same lookup in tg-miniapp-auth is fixed in the companion code PR.)
--
-- 3. A CHALLENGE THAT STARTS MID-WEEK LOSES ITS FIRST WEEK: freeze_challenge_week and
--    post_challenge_team_board ran only if challenge_active(<previous Monday>). The window opens
--    Wed 2026-10-01, so on Mon 10-05 both skipped Oct 1-4 — no frozen results (prizes are paid from
--    them), no team board — and challenge_xp_watchdog, seeing no freeze for 8 days, would have DM'd
--    admins a false "weekly results not saved" alarm twice a day from ~10-09 until the 10-12 freeze.
--    → a week counts if the challenge was active at its start OR at its end. (Start-of-week keeps the
--    final partial week when the challenge closes mid-week, exactly as before.)
--
-- Function rewrites follow the pinned pattern: start from the LIVE pg_get_functiondef, require the
-- body md5 verified today, apply asserted replace()s (each old text must occur exactly once), EXECUTE,
-- then assert the stored definition equals what was executed and owner/ACL/SECURITY DEFINER are
-- unchanged. A replay (already rewritten) is detected by marker and skipped.
-- No function is CALLED here: they post to Telegram / write results.

-- ─────────────── 1. homework capture scope ───────────────
do $$
declare
  _c6 constant text := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _v jsonb;
begin
  update public.platform_settings
     set value = jsonb_set(value, '{course_ids}', coalesce(value->'course_ids', '[]'::jsonb) || to_jsonb(_c6)),
         updated_at = now()
   where key = 'homework_capture'
     and not coalesce(value->'course_ids', '[]'::jsonb) ? _c6;

  select value into _v from public.platform_settings where key = 'homework_capture';
  if _v is null then
    raise exception 'platform_settings.homework_capture row missing';
  end if;
  if not (_v->'course_ids') ? _c6
     or not (_v->'course_ids') ? '78011384-4024-49b0-b72d-b0b2e3a04ee8'
     or _v->>'mode' is distinct from 'picker' then
    raise exception 'homework_capture not as intended: %', _v;
  end if;
end $$;

-- ─────────────── 2a. helper: a group's Telegram chat id ───────────────
create or replace function public.group_telegram_chat_id(_group_id uuid)
returns bigint
language sql
stable
set search_path to 'public'
as $function$
  select coalesce(
    (select ('-100' || m[1])::bigint
       from public.groups g,
            regexp_match(g.homework_topic_url, '^https?://t\.me/c/(\d+)(/|$)') m
      where g.id = _group_id),
    (select e.telegram_chat_id
       from public.group_message_events e
      where e.group_id = _group_id
      order by e.sent_at desc
      limit 1));
$function$;

revoke execute on function public.group_telegram_chat_id(uuid) from public, anon, authenticated;
grant execute on function public.group_telegram_chat_id(uuid) to service_role;

-- ─────────────── 2b + 3. pinned rewrites ───────────────
do $$
declare
  _old_chat constant text := E'select telegram_chat_id into _chat from group_message_events\n        where group_id = _g.id order by sent_at desc limit 1;';
  _new_chat constant text := E'_chat := public.group_telegram_chat_id(_g.id);  -- homework link first, latest message second';
  _old_act  constant text := 'public.challenge_active(_prev_mon)';
  _new_act  constant text := E'(public.challenge_active(_prev_mon) or public.challenge_active(_this_mon - interval \'1 second\'))';
  r record;
  _fn oid;
  _def text; _new text; _src text;
  _acl text; _owner oid; _secdef boolean;
  _n int;
begin
  for r in
    select * from (values
      -- name,                            live body md5 (2026-09-29),           fix chat, fix week
      ('post_group_weekly_boards',        '3e2ab8b09dddd029d39af21ea2186158',   true,     false),
      ('post_group_homework_spotlight',   '0cfe4f6735faaba219f8f879bd5615f0',   true,     false),
      ('post_challenge_team_board',       '160d7f69b9ae3489e0c797cf1b175a77',   true,     true),
      ('freeze_challenge_week',           '506db44006fd2c009f8a92776844b4ee',   false,    true)
    ) v(name, pin, fix_chat, fix_week)
  loop
    select p.oid into _fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = r.name;
    if _fn is null then
      raise exception 'ABORT: public.% not found (or overloaded)', r.name;
    end if;
    select prosrc, coalesce(array_to_string(proacl, ','), ''), proowner, prosecdef
      into _src, _acl, _owner, _secdef
      from pg_proc where oid = _fn;

    -- Replay: already rewritten → skip (the markers only exist after this migration).
    if (not r.fix_chat or position('public.group_telegram_chat_id(_g.id)' in _src) > 0)
       and (not r.fix_week or position('_this_mon - interval ''1 second''' in _src) > 0) then
      raise notice '% already rewritten — skipped', r.name;
      continue;
    end if;
    if md5(replace(_src, E'\r', '')) <> r.pin then
      raise exception 'ABORT: % changed since it was verified (md5 %); regenerate this migration from the live definition',
        r.name, md5(replace(_src, E'\r', ''));
    end if;

    _def := pg_get_functiondef(_fn);
    _new := _def;
    if r.fix_chat then
      _n := (length(_new) - length(replace(_new, _old_chat, ''))) / length(_old_chat);
      if _n <> 1 then raise exception 'ABORT: % — chat lookup found % times (want 1)', r.name, _n; end if;
      _new := replace(_new, _old_chat, _new_chat);
    end if;
    if r.fix_week then
      _n := (length(_new) - length(replace(_new, _old_act, ''))) / length(_old_act);
      if _n <> 1 then raise exception 'ABORT: % — challenge_active(_prev_mon) found % times (want 1)', r.name, _n; end if;
      _new := replace(_new, _old_act, _new_act);
    end if;

    execute _new;

    if pg_get_functiondef(_fn) is distinct from _new then
      raise exception 'ABORT: % — stored definition differs from what was executed', r.name;
    end if;
    if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
       or (select proowner from pg_proc where oid = _fn) <> _owner
       or (select prosecdef from pg_proc where oid = _fn) <> _secdef then
      raise exception 'ABORT: % — owner, ACL or SECURITY DEFINER changed', r.name;
    end if;
  end loop;

  -- The helper must be callable by the (SECURITY DEFINER, postgres-owned) posters.
  if not has_function_privilege('postgres', 'public.group_telegram_chat_id(uuid)', 'EXECUTE') then
    raise exception 'ABORT: postgres cannot EXECUTE group_telegram_chat_id';
  end if;
  -- It resolves every configured 6.0 group, including the two nobody has posted in yet.
  select count(*) into _n from public.groups
   where course_id = 'f502f631-2104-4834-b6c2-702cd3080e27'
     and public.group_telegram_chat_id(id) is not null;
  if _n <> 4 then
    raise exception 'ABORT: group_telegram_chat_id resolves % of 4 challenge groups', _n;
  end if;

  if not exists (select 1 from public.admin_actions where action = 'challenge_6_readiness_applied') then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_6_readiness_applied', jsonb_build_object(
      'homework_capture', (select value from public.platform_settings where key = 'homework_capture'),
      'rewritten', jsonb_build_array('post_group_weekly_boards', 'post_group_homework_spotlight',
                                     'post_challenge_team_board', 'freeze_challenge_week'),
      'at', now()));
  end if;
end $$;
