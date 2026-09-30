-- Challenge 6.0 daily tasks, PR-1: link each group's «KUNLIK VAZIFALAR» topic, and make that topic earn
-- ONLY daily-task points (invariant I2 of the Daily Tasks build spec v2, §3).
--
-- ═══ WHAT THIS DOES ═══
-- 1. groups.daily_task_topic_url / daily_task_topic_id / daily_task_chat_id. The id and chat are DERIVED from
--    the URL by trg_groups_extract_daily_task_topic and can never be written on their own (the trigger also
--    fires on UPDATE OF those two columns and re-derives them). CHECKs: all three set or all three NULL; the
--    topic is never General (1). UNIQUE (chat, topic): one topic can be the daily topic of only one group.
-- 2. The trigger refuses, with an Uzbek message the admin page shows verbatim: a malformed URL, General, a
--    missing or non-/c/ homework URL, a chat different from the homework chat, the homework topic itself, and
--    any of the group's module topics. The mirror guard trg_gmt_zz_daily_topic_guard refuses a module topic
--    equal to its group's daily topic (named to sort AFTER trg_gmt_parse_topic_id: BEFORE triggers fire in
--    name order, F10/G19).
-- 3. challenge_task_parse_topic_url (IMMUTABLE): https?://t.me/c/<chat>/<topic>, /c/<chat>/<topic>/<msg>
--    (the MIDDLE number is the topic) and /c/<chat>/<msg>?thread=<topic> (thread= wins). Returns the URL's
--    own chat number (without -100) and the topic, or NULLs. Both URLs are parsed with it; the trigger never
--    reads NEW.homework_topic_id, which trg_groups_extract_homework_topic_id fills AFTER this trigger runs.
-- 4. challenge_task_topics() (service_role): the daily topics of challenge_scope_group_ids() ∪
--    challenge_tasks.test_group_ids. my_daily_task_topic_url() (authenticated): the caller's own group's
--    topic link. admin_topic_lookup(chat, topic) (admin only): the topic's name as the bot saw it in
--    webhook_inbox (forum_topic_created / forum_topic_edited), so the admin page can confirm the paste.
-- 5. platform_settings 'challenge_tasks' seeded INERT (enabled:false, ai:false, miniapp:false), §4 verbatim,
--    ON CONFLICT DO NOTHING. The hand-edited 'challenge' row is not touched.
-- 6. THE EXCLUSION, two pinned rewrites of live functions (§3.6):
--    reconcile_challenge_xp: the media CASE skips the daily topic (+5 group_media no longer pays there);
--    challenge_social_source: the daily topic is not a source row, so neither chat (+1) nor an answer (+3)
--    posted there is ever seen by its two consumers (reconcile_challenge_social_xp's chat pass and
--    challenge_qa_enqueue_range). The topic decides, not the message, so this is race-free and holds from the
--    moment the URL is saved.
-- 7. SEED (owner-approved 2026-09-30): the four «KUNLIK VAZIFALAR» topics the bot recorded as
--    forum_topic_created in webhook_inbox at 10:18-10:19 UTC today. Each group's homework chat is asserted
--    to be the topic's chat before the URL is written; a mismatch or a missing group ABORTS the file (the
--    facts changed -- a human must look). Groups 5 and 6 (chats -1004396568866, -1004423411304) are not
--    registered yet and are not touched. Seeding runs on the first apply only (a replay never re-seeds a
--    URL an admin has since cleared).
-- 8. HISTORY: removes any challenge media/chat points already paid for a daily-topic message, voids any paid
--    answer posted there (challenge_qa_void_award, the #218 paved road), and retires unsettled answer
--    candidates posted there (status 'skipped', new skip_reason 'daily_task_topic') so they never pay when
--    qa.mode goes live. Verified 2026-09-30 11:52 UTC: 0 challenge xp_events, 0 qa candidates, 0 profiles
--    in the four groups -- this is a no-op unless the file lands after points were paid.
--
-- ═══ VERIFIED LIVE, 2026-09-30 (read-only) ═══
-- * reconcile_challenge_xp body md5 15362fff6d02865d677388ab8ce49b51 (def 34e8852bb22b0a20ffced8d9d3102d38)
--   = the 09-29 fixture + 20260929193000, re-derived byte-for-byte by the harness.
-- * challenge_social_source body md5 26fec5a1950a3ace908698d961fec715 (def 17aa387c70287f3bbfa15d9e69c153e3)
--   = 20260930100010 (#218, ledgered 11:32 UTC). Its ONLY callers: reconcile_challenge_social_xp and
--   challenge_qa_enqueue_range (pg_proc prosrc search).
-- * groups triggers: groups_set_updated_at, trg_groups_extract_homework_topic_id (regex
--   '^https?://t\.me/c/\d+/(\d+)'), trg_sync_primary_group_teacher. group_module_topics: trg_gmt_parse_topic_id
--   (TRAILING digits -- a pasted message link stores the message id; both readings are refused here).
-- * groups RLS: one policy, 'groups admin all' (has_role admin). So the trigger runs for admins and
--   service_role only; it is SECURITY DEFINER so its module-topic read never depends on the caller's RLS.
-- * AC CHALLENGE | 1..4-GURUH: homework URLs /c/4440955972/3, /c/4390902020/6, /c/3714608284/5,
--   /c/4463424516/7; 0 module topics; forum_topic_created 'KUNLIK VAZIFALAR' at threads 144/99/38/12.
--
-- ═══ DEVIATIONS FROM THE SPEC (each argued) ═══
-- v1 The homework URL is compared under BOTH parsers (this helper, and the live homework trigger's regex), and a
--    module topic under both its parsed URL and its stored telegram_topic_id: the bot routes by the stored
--    values, so a collision under either reading is a real conflict.
-- v2 A homework URL that is not a /c/ link (a public-group link) cannot prove the chat, so it is refused with
--    its own message rather than the "different chat" one.
-- v3 The trigger also fires on UPDATE OF daily_task_topic_id / daily_task_chat_id and re-derives them, and a
--    CHECK keeps the three columns all-or-none: the derived columns are unwritable by construction.
-- v4 History heal for answers (item 8) needs a new skip_reason value; the #218 CHECK is widened by exactly
--    that one value (drop + re-add of challenge_qa_candidates_skip_reason_check, same list + 1).
--
-- ═══ KILL-SWITCHES ═══
-- Clear a group's «Kunlik vazifalar topiki URL» (Admin -> Guruhlar): that topic earns like any other topic
-- again. The whole daily-task engine (PR-3+) stays behind platform_settings.challenge_tasks.enabled (false).
--
-- ═══ DETECTION ═══
-- Prevention is by construction (the predicate is keyed to the saved URL). The residuals the spec accepts
-- (G22: community_help/question outside the window; a cross-topic reply whose question sits in the daily
-- topic) are counted by PR-3's challenge_tasks_health().topic_points_leak_24h and its watchdog. This file
-- writes one audit row, 'challenge_daily_topic_applied', with the seed and heal counts and both new md5s.
--
-- SELF-TEST: non-mutating only (pure parse fixtures, object/trigger-order/ACL presence, the rewritten bodies'
-- predicates). It never calls a reconciler, the void function or anything that needs a JWT.
-- PGlite harness: supabase/functions/_challenge/testing/daily_topic_check_test.ts applies #218 and then THIS
-- file on the live bodies (md5-verified) and checks media/chat/answer pay 0 in the daily topic with parity
-- everywhere else, every trigger refusal, the unique index, the seed assertions, the heal, the pins, replay.
-- Merge: after PR-0 (20260930120000) is ledgered; label migration-approved, NEVER ops-agent.

-- ═══════════════════════════════ 1. Columns, CHECKs, unique index ═══════════════════════════════
alter table public.groups
  add column if not exists daily_task_topic_url text,
  add column if not exists daily_task_topic_id bigint,
  add column if not exists daily_task_chat_id bigint;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.groups'::regclass
                  and conname = 'groups_daily_task_topic_not_general') then
    alter table public.groups add constraint groups_daily_task_topic_not_general
      check (daily_task_topic_id is null or daily_task_topic_id > 1);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.groups'::regclass
                  and conname = 'groups_daily_task_topic_all_or_none') then
    alter table public.groups add constraint groups_daily_task_topic_all_or_none
      check ((daily_task_topic_url is null and daily_task_topic_id is null and daily_task_chat_id is null)
          or (daily_task_topic_url is not null and daily_task_topic_id is not null and daily_task_chat_id is not null));
  end if;
end $$;

create unique index if not exists uq_groups_daily_task_topic
  on public.groups (daily_task_chat_id, daily_task_topic_id) where daily_task_topic_id is not null;

comment on column public.groups.daily_task_topic_url is
  'The group''s «KUNLIK VAZIFALAR» forum topic (https://t.me/c/<chat>/<topic>). I2: a message in this topic earns ONLY '
  'daily-task points -- challenge media, chat and answer points exclude the whole topic. Clearing it opts the group out. '
  'daily_task_topic_id / daily_task_chat_id are derived from it by trg_groups_extract_daily_task_topic.';
comment on column public.groups.daily_task_topic_id is 'Derived from daily_task_topic_url (message_thread_id). Never written directly.';
comment on column public.groups.daily_task_chat_id is 'Derived from daily_task_topic_url (Bot API chat id, -100<chat>). Never written directly.';

-- ═══════════════════════════════ 2. The URL parser (pure) ═══════════════════════════════
create or replace function public.challenge_task_parse_topic_url(_url text, out chat bigint, out topic bigint)
language plpgsql
immutable
set search_path = public
as $fn$
-- chat = the number after /c/ (WITHOUT the -100 prefix; the Bot API chat id is ('-100' || chat)::bigint),
-- topic = the forum thread. NULLs for anything that is not a private-group topic link.
--   https?://t.me/c/<chat>/<topic>            the topic link ("Copy link" on a topic)
--   https?://t.me/c/<chat>/<topic>/<msg>      a message link inside a topic: the MIDDLE number
--   https?://t.me/c/<chat>/<msg>?thread=<t>   the thread parameter wins over the path
declare
  _m text[];
  _t text[];
begin
  _m := regexp_match(btrim(coalesce(_url, ''), E' \t\r\n'),
                     '^https?://t\.me/c/([1-9][0-9]{0,14})/([0-9]{1,12})(?:/([0-9]{1,12}))?/?(?:\?([^#]*))?$', 'i');
  if _m is null then
    return;
  end if;
  if coalesce(_m[4], '') ~ '(^|&)thread=' then
    _t := regexp_match(_m[4], '(?:^|&)thread=([0-9]{1,12})(?:&|$)');
    if _t is null then
      return;                                   -- a thread parameter that is not a number: not a topic link
    end if;
    topic := _t[1]::bigint;
  else
    topic := _m[2]::bigint;
  end if;
  chat := _m[1]::bigint;
end
$fn$;

comment on function public.challenge_task_parse_topic_url(text) is
  'Parses a t.me/c/ topic or message link. chat = the URL''s chat number WITHOUT -100 (Bot API id = (''-100''||chat)::bigint), '
  'topic = message_thread_id; ?thread= wins; /c/x/y/msg takes the middle number. NULLs otherwise.';

-- ═══════════════════════════════ 3. groups trigger + group_module_topics mirror guard ═══════════════════════════════
create or replace function public.groups_extract_daily_task_topic()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
-- BEFORE INSERT OR UPDATE OF daily_task_topic_url, daily_task_topic_id, daily_task_chat_id, homework_topic_url.
-- Fires BEFORE trg_groups_extract_homework_topic_id (name order), so NEW.homework_topic_id may be stale here:
-- the homework URL is parsed from the URL itself, never read from that column (F10).
declare
  _d record;
  _h record;
  _legacy text[];
begin
  if NEW.daily_task_topic_url is null or btrim(NEW.daily_task_topic_url, E' \t\r\n') = '' then
    NEW.daily_task_topic_url := null;
    NEW.daily_task_topic_id := null;
    NEW.daily_task_chat_id := null;
    return NEW;
  end if;
  NEW.daily_task_topic_url := btrim(NEW.daily_task_topic_url, E' \t\r\n');

  select p.chat, p.topic into _d from public.challenge_task_parse_topic_url(NEW.daily_task_topic_url) p;
  if _d.chat is null or _d.topic is null then
    raise exception using errcode = 'P0001',
      message = 'Kunlik vazifalar topiki havolasi noto‘g‘ri. Namuna: https://t.me/c/4440955972/144';
  end if;
  if _d.topic <= 1 then
    raise exception using errcode = 'P0001', message = 'Kunlik vazifalar topiki General bo‘la olmaydi';
  end if;

  if NEW.homework_topic_url is null or btrim(NEW.homework_topic_url, E' \t\r\n') = '' then
    raise exception using errcode = 'P0001', message = 'Avval «Vazifalar topiki URL»ni kiriting';
  end if;
  select p.chat, p.topic into _h from public.challenge_task_parse_topic_url(NEW.homework_topic_url) p;
  if _h.chat is null then
    raise exception using errcode = 'P0001',
      message = 'Avval «Vazifalar topiki URL»ni https://t.me/c/… ko‘rinishida kiriting';
  end if;
  if _h.chat <> _d.chat then
    raise exception using errcode = 'P0001', message = 'Kunlik vazifalar topiki boshqa guruhga tegishli';
  end if;
  -- The homework topic under BOTH readings: this parser, and the homework trigger's own regex (what the bot uses).
  _legacy := regexp_match(NEW.homework_topic_url, '^https?://t\.me/c/\d+/(\d{1,12})');
  if _d.topic = _h.topic or (_legacy is not null and _d.topic = _legacy[1]::bigint) then
    raise exception using errcode = 'P0001',
      message = 'Kunlik vazifalar topiki uy vazifasi topigi bilan bir xil bo‘lmasin';
  end if;
  -- A module topic of this group, under its stored id (what the bot routes by) or its parsed URL.
  if exists (select 1
               from public.group_module_topics t
               left join lateral public.challenge_task_parse_topic_url(t.telegram_topic_url) p on true
              where t.group_id = NEW.id
                and (t.telegram_topic_id = _d.topic or (p.chat = _d.chat and p.topic = _d.topic))) then
    raise exception using errcode = 'P0001',
      message = 'Kunlik vazifalar topiki modul topigi bilan bir xil bo‘lmasin';
  end if;

  NEW.daily_task_topic_id := _d.topic;
  NEW.daily_task_chat_id := ('-100' || _d.chat::text)::bigint;
  return NEW;
end
$fn$;

drop trigger if exists trg_groups_extract_daily_task_topic on public.groups;
create trigger trg_groups_extract_daily_task_topic
  before insert or update of daily_task_topic_url, daily_task_topic_id, daily_task_chat_id, homework_topic_url
  on public.groups
  for each row execute function public.groups_extract_daily_task_topic();

create or replace function public.gmt_daily_topic_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
-- trg_gmt_zz_daily_topic_guard: sorts AFTER trg_gmt_parse_topic_id, so NEW.telegram_topic_id is already the
-- parse trigger's (trailing-digits) value; the URL is also re-parsed with challenge_task_parse_topic_url.
declare
  _g record;
  _p record;
begin
  select g.daily_task_topic_id, g.daily_task_chat_id into _g from public.groups g where g.id = NEW.group_id;
  if _g.daily_task_topic_id is null then
    return NEW;
  end if;
  select p.chat, p.topic into _p from public.challenge_task_parse_topic_url(NEW.telegram_topic_url) p;
  if NEW.telegram_topic_id = _g.daily_task_topic_id
     or (_p.topic = _g.daily_task_topic_id and ('-100' || _p.chat::text)::bigint = _g.daily_task_chat_id) then
    raise exception using errcode = 'P0001',
      message = 'Modul topigi «Kunlik vazifalar» topigi bilan bir xil bo‘lmasin';
  end if;
  return NEW;
end
$fn$;

drop trigger if exists trg_gmt_zz_daily_topic_guard on public.group_module_topics;
create trigger trg_gmt_zz_daily_topic_guard
  before insert or update on public.group_module_topics
  for each row execute function public.gmt_daily_topic_guard();

-- ═══════════════════════════════ 4. Read functions ═══════════════════════════════
create or replace function public.challenge_task_topics()
returns table (group_id uuid, course_id uuid, chat_id bigint, thread_id bigint, is_test boolean)
language sql
stable
security definer
set search_path = public
as $fn$
  -- The daily-task topics the engine owns: challenge-scope groups plus challenge_tasks.test_group_ids (E2E
  -- only; never added to challenge_scope_group_ids(), the boards or the freeze -- G26). A malformed
  -- test_group_ids (not an array, a non-uuid element) contributes nothing instead of failing.
  with cfg as (
    select ps.value->'test_group_ids' as t from public.platform_settings ps where ps.key = 'challenge_tasks'
  ),
  test_ids as (
    select distinct x::uuid as id
      from cfg, jsonb_array_elements_text(case when jsonb_typeof(cfg.t) = 'array' then cfg.t else '[]'::jsonb end) x
     where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  scope as (
    select s.id from public.challenge_scope_group_ids() s(id)
  )
  select g.id, g.course_id, g.daily_task_chat_id, g.daily_task_topic_id,
         (g.id in (select id from test_ids) and g.id not in (select id from scope))
    from public.groups g
   where g.daily_task_topic_id is not null
     and (g.id in (select id from scope) or g.id in (select id from test_ids))
$fn$;

create or replace function public.my_daily_task_topic_url()
returns text
language sql
stable
security definer
set search_path = public
as $fn$
  -- The caller's own group's daily-task topic link (groups is admin-only under RLS), or NULL.
  select g.daily_task_topic_url
    from public.profiles p
    join public.groups g on g.id = p.group_id
   where p.id = auth.uid()
     and g.daily_task_topic_id is not null
     and exists (select 1 from public.challenge_task_topics() t where t.group_id = g.id)
   limit 1
$fn$;

create or replace function public.admin_topic_lookup(_chat bigint, _topic bigint)
returns text
language plpgsql
stable
security definer
set search_path = public
as $fn$
-- The forum topic's name as the bot recorded it: the newest forum_topic_edited name, else the
-- forum_topic_created name (that service message's id IS the thread id). NULL = the bot never saw the
-- topic being created or renamed -- the admin page shows a non-blocking warning. _chat is the Bot API id.
declare
  _name text;
begin
  if not public.has_role(auth.uid(), 'admin'::public.app_role) then
    raise exception using errcode = '42501', message = 'admin_topic_lookup: admin only';
  end if;
  if _chat is null or _topic is null or _topic <= 1 then
    return null;
  end if;
  select nullif(w.raw_update->'message'->'forum_topic_edited'->>'name', '') into _name
    from public.webhook_inbox w
   where w.chat_id = _chat
     and w.update_type = 'message'
     and w.raw_update->'message'->>'message_thread_id' = _topic::text
     and nullif(w.raw_update->'message'->'forum_topic_edited'->>'name', '') is not null
   order by w.id desc
   limit 1;
  if _name is null then
    select w.raw_update->'message'->'forum_topic_created'->>'name' into _name
      from public.webhook_inbox w
     where w.chat_id = _chat
       and w.message_id = _topic
       and w.raw_update->'message' ? 'forum_topic_created'
     order by w.id desc
     limit 1;
  end if;
  return _name;
end
$fn$;

-- ═══════════════════════════════ 5. Grants ═══════════════════════════════
revoke execute on function public.challenge_task_parse_topic_url(text) from public, anon, authenticated;
grant execute on function public.challenge_task_parse_topic_url(text) to service_role;
-- Trigger functions: EXECUTE is checked when the trigger is created, never when it fires.
revoke execute on function public.groups_extract_daily_task_topic() from public, anon, authenticated;
revoke execute on function public.gmt_daily_topic_guard() from public, anon, authenticated;
revoke execute on function public.challenge_task_topics() from public, anon, authenticated;
grant execute on function public.challenge_task_topics() to service_role;
revoke execute on function public.my_daily_task_topic_url() from public, anon, authenticated;
grant execute on function public.my_daily_task_topic_url() to authenticated;
revoke execute on function public.admin_topic_lookup(bigint, bigint) from public, anon, authenticated;
grant execute on function public.admin_topic_lookup(bigint, bigint) to authenticated;

-- ═══════════════════════════════ 6. Config row (inert) ═══════════════════════════════
insert into public.platform_settings (key, value)
values ('challenge_tasks', '{"enabled":false,"post":true,"dm":true,"remind":true,"summary":true,"ai":false,"receipts":true,"auto_register":true,"miniapp":false,"miniapp_link":null,"miniapp_onboarding":false,"test_group_ids":[],"task_weekdays":[1,2,3,4,5],"post_time":"09:00","remind_time":"19:00","summary_time":"20:00","quiet_start":"22:00","quiet_end":"08:00","late_days":2,"late_factor":0.5,"points":{"general":5,"instagram":8},"streak":{"every":5,"bonus":10},"merge_window_min":5,"min_text_chars":20,"min_voice_sec":3,"max_items_per_day":40,"max_attempts_per_task":3,"max_moves_per_submission":5,"receipt_budget_per_chat_min":12,"backfill_receipt_max_age_min":120,"fail_open_after_min":60,"liveness_check_time":"14:00","ig":{"tag_handle":"aicreators.students","min_confidence":0.6,"handle_edit_distance":1,"dhash_max_distance":4,"require_recent":true,"recent_min_confidence":0.8,"existence_probe":true,"lock_handle_after_accept":true},"generic":{"offtask_min_confidence":0.85},"ai_provider_order":["anthropic","openai"],"ai_models":{"anthropic":"claude-haiku-4-5","openai":"gpt-5-mini"},"ai_prices":{"anthropic":[1,5],"openai":[0.25,2]},"ai_daily_budget_usd":3,"ai_max_checks_per_user_day":6}'::jsonb)
on conflict (key) do nothing;

-- ═══════════════════════════════ 7. reconcile_challenge_xp: no media points in the daily topic ═══════════════════════════════
do $$
declare
  _pin constant text := '15362fff6d02865d677388ab8ce49b51';      -- live md5(prosrc), 2026-09-30
  _new_pin constant text := '6074d56ec11578ed727c5d6a390272f6';  -- the rewritten body, computed by the PGlite harness
  _old1 constant text := E'               grp.homework_topic_id,\n               (w.raw_update->''message'') as m\n';
  _new1 constant text :=
       E'               grp.homework_topic_id,\n'
    || E'               grp.daily_task_topic_id,   -- I2 (20260930121000): the group''s KUNLIK VAZIFALAR topic\n'
    || E'               (w.raw_update->''message'') as m\n';
  _old2 constant text := E'                 and b.thread_id is distinct from b.homework_topic_id\n';
  _new2 constant text :=
       E'                 and b.thread_id is distinct from b.homework_topic_id\n'
    || E'                 -- I2 (20260930121000): the daily-task topic earns ONLY daily-task points. The WHOLE topic\n'
    || E'                 -- is excluded, keyed to the group''s saved URL, whatever the message is.\n'
    || E'                 and (b.daily_task_topic_id is null or b.thread_id is distinct from b.daily_task_topic_id)\n';
  _olds text[];
  _news text[];
  _fn oid;
  _src text; _def text; _new text;
  _acl text; _owner oid; _secdef boolean;
  _n int;
begin
  _olds := array[_old1, _old2];
  _news := array[_new1, _new2];
  _fn := to_regprocedure('public.reconcile_challenge_xp(timestamp with time zone)');
  if _fn is null then
    raise exception 'ABORT: public.reconcile_challenge_xp(timestamptz) not found';
  end if;
  select prosrc, coalesce(array_to_string(proacl, ','), ''), proowner, prosecdef
    into _src, _acl, _owner, _secdef from pg_proc where oid = _fn;

  if position('b.daily_task_topic_id' in _src) > 0 then     -- replay: the marker exists only after this rewrite
    raise notice 'reconcile_challenge_xp already excludes the daily topic -- skipped';
    return;
  end if;
  if md5(replace(_src, E'\r', '')) <> _pin then
    raise exception 'ABORT: reconcile_challenge_xp changed since it was verified (md5 %); regenerate this migration from the live definition',
      md5(replace(_src, E'\r', ''));
  end if;

  _def := pg_get_functiondef(_fn);
  _new := _def;
  for i in 1 .. array_length(_olds, 1) loop
    _n := (length(_new) - length(replace(_new, _olds[i], ''))) / length(_olds[i]);
    if _n <> 1 then
      raise exception 'ABORT: reconcile_challenge_xp edit % matched % times (want exactly 1)', i, _n;
    end if;
    _new := replace(_new, _olds[i], _news[i]);
  end loop;

  execute _new;

  if pg_get_functiondef(_fn) is distinct from _new then
    raise exception 'ABORT: reconcile_challenge_xp -- stored definition differs from what was executed';
  end if;
  if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
     or (select proowner from pg_proc where oid = _fn) <> _owner
     or (select prosecdef from pg_proc where oid = _fn) <> _secdef then
    raise exception 'ABORT: reconcile_challenge_xp -- owner, ACL or SECURITY DEFINER changed';
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _fn) <> _new_pin then
    raise exception 'ABORT: reconcile_challenge_xp -- the rewritten body is not the harness-verified one (md5 %)',
      (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _fn);
  end if;
end $$;

-- ═══════════════════════════════ 8. challenge_social_source: no chat / answer rows from the daily topic ═══════════════════════════════
do $$
declare
  _pin constant text := '26fec5a1950a3ace908698d961fec715';      -- live md5(prosrc), 2026-09-30 (#218)
  _new_pin constant text := '224711a4266dd249e36be8d1b0132f21';  -- the rewritten body, computed by the PGlite harness
  _old1 constant text := E'   where g.group_id = any(_groups)\n';
  _new1 constant text :=
       E'   where g.group_id = any(_groups)\n'
    || E'     -- I2 (20260930121000): nothing posted in the group''s KUNLIK VAZIFALAR topic is a chat or an answer\n'
    || E'     -- source row; that topic earns only daily-task points. Keyed to the saved URL: the topic decides.\n'
    || E'     and (grp.daily_task_topic_id is null or g.telegram_thread_id is distinct from grp.daily_task_topic_id)\n';
  _fn oid;
  _src text; _def text; _new text;
  _acl text; _owner oid; _secdef boolean;
  _n int;
begin
  _fn := to_regprocedure('public.challenge_social_source(timestamp with time zone, timestamp with time zone, uuid[], timestamp with time zone, timestamp with time zone, integer)');
  if _fn is null then
    raise exception 'ABORT: public.challenge_social_source(...) not found -- #218 (20260930100010) must be applied first';
  end if;
  select prosrc, coalesce(array_to_string(proacl, ','), ''), proowner, prosecdef
    into _src, _acl, _owner, _secdef from pg_proc where oid = _fn;

  if position('grp.daily_task_topic_id' in _src) > 0 then   -- replay
    raise notice 'challenge_social_source already excludes the daily topic -- skipped';
    return;
  end if;
  if md5(replace(_src, E'\r', '')) <> _pin then
    raise exception 'ABORT: challenge_social_source changed since it was verified (md5 %); regenerate this migration from the live definition',
      md5(replace(_src, E'\r', ''));
  end if;

  _def := pg_get_functiondef(_fn);
  _n := (length(_def) - length(replace(_def, _old1, ''))) / length(_old1);
  if _n <> 1 then
    raise exception 'ABORT: challenge_social_source anchor matched % times (want exactly 1)', _n;
  end if;
  _new := replace(_def, _old1, _new1);

  execute _new;

  if pg_get_functiondef(_fn) is distinct from _new then
    raise exception 'ABORT: challenge_social_source -- stored definition differs from what was executed';
  end if;
  if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
     or (select proowner from pg_proc where oid = _fn) <> _owner
     or (select prosecdef from pg_proc where oid = _fn) <> _secdef then
    raise exception 'ABORT: challenge_social_source -- owner, ACL or SECURITY DEFINER changed';
  end if;
  if (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _fn) <> _new_pin then
    raise exception 'ABORT: challenge_social_source -- the rewritten body is not the harness-verified one (md5 %)',
      (select md5(replace(prosrc, E'\r', '')) from pg_proc where oid = _fn);
  end if;
end $$;

-- ═══════════════════════════════ 9. Seed the four known daily topics (first apply only) ═══════════════════════════════
do $$
declare
  -- Owner-approved 2026-09-30. chat = Bot API id; thread = the forum_topic_created message id in webhook_inbox.
  _seed constant jsonb := '[
    {"group": "f675a2fd-b1ce-4d28-94a4-7fc0e1a91515", "label": "1-GURUH", "chat": -1004440955972, "thread": 144, "url": "https://t.me/c/4440955972/144"},
    {"group": "c092a0db-b55f-4fa7-8548-befad285037b", "label": "2-GURUH", "chat": -1004390902020, "thread": 99,  "url": "https://t.me/c/4390902020/99"},
    {"group": "3a7ebea8-80eb-4b64-a282-471a0fa12ef4", "label": "3-GURUH", "chat": -1003714608284, "thread": 38,  "url": "https://t.me/c/3714608284/38"},
    {"group": "93e8e7b0-275c-47a9-a97d-ff28e26c8f5b", "label": "4-GURUH", "chat": -1004463424516, "thread": 12,  "url": "https://t.me/c/4463424516/12"}
  ]'::jsonb;
  _s jsonb;
  _g record;
  _hw record;
  _u record;
  _set jsonb := '[]'::jsonb;
  _kept jsonb := '[]'::jsonb;
begin
  if exists (select 1 from public.admin_actions where action = 'challenge_daily_topic_applied') then
    raise notice 'daily topics already seeded by the first apply -- skipped';
    return;
  end if;
  for _s in select * from jsonb_array_elements(_seed) loop
    select g.id, g.name, g.homework_topic_url, g.daily_task_topic_url into _g
      from public.groups g where g.id = (_s->>'group')::uuid;
    if _g.id is null then
      raise exception 'ABORT: seed group % (%) not found -- re-verify the daily-topic seed', _s->>'label', _s->>'group';
    end if;
    -- The seed URL must say exactly what was verified ...
    select p.chat, p.topic into _u from public.challenge_task_parse_topic_url(_s->>'url') p;
    if _u.chat is null or ('-100' || _u.chat::text)::bigint <> (_s->>'chat')::bigint or _u.topic <> (_s->>'thread')::bigint then
      raise exception 'ABORT: seed URL % does not parse to chat % thread %', _s->>'url', _s->>'chat', _s->>'thread';
    end if;
    -- ... and the group's homework topic must live in that same chat (the owner-approved assertion).
    select p.chat into _hw from public.challenge_task_parse_topic_url(_g.homework_topic_url) p;
    if _hw.chat is null or ('-100' || _hw.chat::text)::bigint <> (_s->>'chat')::bigint then
      raise exception 'ABORT: % (%) homework topic URL % is not in chat % -- the seed was verified against it; re-verify',
        _g.name, _g.id, coalesce(_g.homework_topic_url, 'NULL'), _s->>'chat';
    end if;
    if _g.daily_task_topic_url is null then
      update public.groups set daily_task_topic_url = _s->>'url' where id = _g.id;   -- the trigger validates + derives
      _set := _set || jsonb_build_object('group', _g.id, 'name', _g.name, 'url', _s->>'url');
    else
      _kept := _kept || jsonb_build_object('group', _g.id, 'name', _g.name, 'url', _g.daily_task_topic_url);
    end if;
  end loop;
  perform set_config('challenge_daily_topic.seeded', _set::text, true);
  perform set_config('challenge_daily_topic.kept', _kept::text, true);
end $$;

-- ═══════════════════════════════ 10. History: points already paid in a daily topic ═══════════════════════════════
-- Idempotent. A no-op today (0 challenge xp_events, 0 qa candidates, 0 profiles in the four groups).
-- Media/chat rows are keyed by the message (ch_img:/ch_chat:<chat>:<msg>, ch_alb:<chat>:<media_group_id>);
-- the SAME predicate the rewritten reconcilers use decides: the message's thread is its group's daily topic.
alter table public.challenge_qa_candidates drop constraint if exists challenge_qa_candidates_skip_reason_check;
alter table public.challenge_qa_candidates add constraint challenge_qa_candidates_skip_reason_check
  check (skip_reason in ('media_message', 'no_text', 'question_no_text', 'too_short', 'injection_marker',
    'duplicate_text', 'pair_day_paid', 'answerer_capped', 'question_capped', 'answerer_judge_budget',
    'daily_task_topic'));

do $$
declare
  _users uuid[] := '{}';
  _media int := 0;
  _chat int := 0;
  _voided int := 0;
  _retired int := 0;
  _c record;
begin
  with dt as (
    select g.id as group_id, g.daily_task_topic_id as thread
      from public.groups g where g.daily_task_topic_id is not null
  ),
  keyed as (
    select e.id, split_part(e.ref_key, ':', 1) as kind,
           case when split_part(e.ref_key, ':', 2) ~ '^-?[0-9]{1,18}$' then split_part(e.ref_key, ':', 2)::bigint end as chat,
           split_part(e.ref_key, ':', 3) as tail
      from public.xp_events e
     where e.reason in ('challenge_group_media', 'challenge_chat')
       and e.ref_key like 'ch\_%'
  ),
  leaked as (
    select k.id
      from keyed k
     where k.kind in ('ch_img', 'ch_chat')
       and exists (select 1
                     from public.group_message_events m
                     join dt on dt.group_id = m.group_id
                    where m.telegram_chat_id = k.chat
                      and m.telegram_message_id = case when k.tail ~ '^[0-9]{1,18}$' then k.tail::bigint end
                      and m.telegram_thread_id = dt.thread)
    union
    select k.id
      from keyed k
     where k.kind = 'ch_alb'
       and exists (select 1
                     from public.webhook_inbox w
                     join public.group_message_events m
                       on m.telegram_chat_id = w.chat_id and m.telegram_message_id = w.message_id
                     join dt on dt.group_id = m.group_id
                    where w.chat_id = k.chat
                      and w.update_type = 'message'
                      and w.raw_update->'message'->>'media_group_id' = k.tail
                      and m.telegram_thread_id = dt.thread)
  ),
  gone as (
    delete from public.xp_events e using leaked l where e.id = l.id
    returning e.user_id, e.reason
  )
  select coalesce(array_agg(distinct user_id), '{}'),
         count(*) filter (where reason = 'challenge_group_media'),
         count(*) filter (where reason = 'challenge_chat')
    into _users, _media, _chat
    from gone;

  if cardinality(_users) > 0 then
    insert into public.user_xp (user_id, total_xp, level, updated_at)
    select u.id,
           coalesce((select sum(e.amount) from public.xp_events e where e.user_id = u.id), 0)::int,
           public.xp_level_for(coalesce((select sum(e.amount) from public.xp_events e where e.user_id = u.id), 0)::int),
           now()
      from unnest(_users) as u(id)
    on conflict (user_id) do update
      set total_xp = excluded.total_xp, level = excluded.level, updated_at = now();
  end if;

  -- Answers posted in a daily topic: a paid one is voided through the #218 paved road (xp row, candidate
  -- 'voided', user_xp rebuild, 'challenge_answer_voided' audit) ...
  for _c in
    select c.id
      from public.challenge_qa_candidates c
      join public.groups g on g.id = c.group_id
     where g.daily_task_topic_id is not null
       and c.thread_id = g.daily_task_topic_id
       and c.award_status = 'awarded'
  loop
    if public.challenge_qa_void_award(_c.id, 'daily_task_topic') then
      _voided := _voided + 1;
    end if;
  end loop;
  -- ... and an unsettled one is retired so it can never pay when qa.mode goes live (challenge_qa_record
  -- answers 'stale' to a judge still holding its lease).
  with r as (
    update public.challenge_qa_candidates c
       set status = 'skipped', skip_reason = 'daily_task_topic', claim_token = null, claimed_at = null,
           next_attempt_at = null, updated_at = now()
      from public.groups g
     where g.id = c.group_id
       and g.daily_task_topic_id is not null
       and c.thread_id = g.daily_task_topic_id
       and c.award_status is null
       and not c.shadow_only
       and c.status in ('pending', 'error', 'judging', 'judged')
    returning c.id
  )
  select count(*) into _retired from r;

  perform set_config('challenge_daily_topic.heal',
    jsonb_build_object('media_removed', _media, 'chat_removed', _chat, 'answers_voided', _voided,
                       'candidates_retired', _retired, 'students_rebuilt', cardinality(_users))::text, true);
end $$;

-- ═══════════════════════════════ 11. Self-test (non-mutating) ═══════════════════════════════
do $$
declare
  _r record;
  _fx jsonb := '[
    ["https://t.me/c/4440955972/144",                      4440955972, 144],
    ["  https://t.me/c/4440955972/144/  ",                 4440955972, 144],
    ["https://t.me/c/4440955972/144/5321",                 4440955972, 144],
    ["https://t.me/c/4440955972/5321?thread=144",          4440955972, 144],
    ["https://t.me/c/4440955972/144/5321?single&thread=99", 4440955972, 99],
    ["http://t.me/c/1/2",                                  1,          2],
    ["HTTPS://T.ME/c/4390902020/99",                       4390902020, 99],
    ["https://t.me/c/4440955972/1",                        4440955972, 1],
    ["https://t.me/c/4440955972/144?single",               4440955972, 144],
    ["https://t.me/somegroup/144",                         null,       null],
    ["https://t.me/+AbCdEf123",                            null,       null],
    ["https://t.me/c/4440955972",                          null,       null],
    ["https://t.me/c/4440955972/144?thread=abc",           null,       null],
    ["https://t.me/c/0123/5",                              null,       null],
    ["https://t.me/c/4440955972/144#x",                    null,       null],
    ["t.me/c/4440955972/144",                              null,       null],
    ["",                                                   null,       null]
  ]'::jsonb;
  _f jsonb;
  _names text[];
begin
  -- (a) the parser, pure fixtures
  for _f in select * from jsonb_array_elements(_fx) loop
    select p.chat, p.topic into _r from public.challenge_task_parse_topic_url(_f->>0) p;
    if _r.chat is distinct from (_f->>1)::bigint or _r.topic is distinct from (_f->>2)::bigint then
      raise exception 'SELF-TEST: parse(%) = (%, %), want (%, %)', _f->>0, _r.chat, _r.topic, _f->>1, _f->>2;
    end if;
  end loop;
  select p.chat, p.topic into _r from public.challenge_task_parse_topic_url(null) p;
  if _r.chat is not null or _r.topic is not null then
    raise exception 'SELF-TEST: parse(NULL) is not NULL';
  end if;

  -- (b) objects, constraints, index, triggers and their firing order
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'groups'
       and column_name in ('daily_task_topic_url', 'daily_task_topic_id', 'daily_task_chat_id')) <> 3 then
    raise exception 'SELF-TEST: groups daily_task_* columns missing';
  end if;
  if (select count(*) from pg_constraint where conrelid = 'public.groups'::regclass
       and conname in ('groups_daily_task_topic_not_general', 'groups_daily_task_topic_all_or_none')) <> 2 then
    raise exception 'SELF-TEST: groups daily-topic CHECKs missing';
  end if;
  if to_regclass('public.uq_groups_daily_task_topic') is null
     or not (select indisunique from pg_index where indexrelid = 'public.uq_groups_daily_task_topic'::regclass) then
    raise exception 'SELF-TEST: uq_groups_daily_task_topic missing or not unique';
  end if;
  select array_agg(tgname::text order by tgname::text) into _names
    from pg_trigger where tgrelid = 'public.groups'::regclass and not tgisinternal and tgname::text like 'trg_groups_extract_%';
  if _names is distinct from array['trg_groups_extract_daily_task_topic', 'trg_groups_extract_homework_topic_id'] then
    raise exception 'SELF-TEST: groups extract triggers are %', _names;
  end if;
  select array_agg(tgname::text order by tgname::text) into _names
    from pg_trigger where tgrelid = 'public.group_module_topics'::regclass and not tgisinternal;
  if _names is null or _names[array_length(_names, 1)] <> 'trg_gmt_zz_daily_topic_guard'
     or not ('trg_gmt_parse_topic_id' = any(_names)) then
    raise exception 'SELF-TEST: the gmt guard must sort after trg_gmt_parse_topic_id (got %)', _names;
  end if;

  -- (c) ACLs: nothing new reachable by PUBLIC or anon; the two app RPCs by authenticated, the rest service-only
  for _r in
    select p.proname, coalesce(array_to_string(p.proacl, ','), '') as acl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('challenge_task_parse_topic_url', 'groups_extract_daily_task_topic', 'gmt_daily_topic_guard',
                         'challenge_task_topics', 'my_daily_task_topic_url', 'admin_topic_lookup')
  loop
    if _r.acl = '' or _r.acl ~ '(^|,)=' or _r.acl ~ '(^|,)anon=' then
      raise exception 'SELF-TEST: % is reachable by PUBLIC or anon (%)', _r.proname, _r.acl;
    end if;
    if (_r.proname in ('my_daily_task_topic_url', 'admin_topic_lookup')) <> (_r.acl ~ '(^|,)authenticated=') then
      raise exception 'SELF-TEST: % authenticated grant is wrong (%)', _r.proname, _r.acl;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.challenge_task_topics()', 'EXECUTE') then
    raise exception 'SELF-TEST: service_role cannot EXECUTE challenge_task_topics()';
  end if;

  -- (d) the rewritten bodies carry the exclusion (md5-pinned at rewrite time)
  if position('and (b.daily_task_topic_id is null or b.thread_id is distinct from b.daily_task_topic_id)' in
       (select prosrc from pg_proc where oid = 'public.reconcile_challenge_xp(timestamptz)'::regprocedure)) = 0 then
    raise exception 'SELF-TEST: reconcile_challenge_xp does not exclude the daily topic';
  end if;
  if position('and (grp.daily_task_topic_id is null or g.telegram_thread_id is distinct from grp.daily_task_topic_id)' in
       (select prosrc from pg_proc where oid = to_regprocedure('public.challenge_social_source(timestamp with time zone, timestamp with time zone, uuid[], timestamp with time zone, timestamp with time zone, integer)'))) = 0 then
    raise exception 'SELF-TEST: challenge_social_source does not exclude the daily topic';
  end if;

  -- (e) the config row exists (its values are the owner's to change later, so only its shape is checked)
  if (select jsonb_typeof(value) from public.platform_settings where key = 'challenge_tasks') is distinct from 'object' then
    raise exception 'SELF-TEST: platform_settings.challenge_tasks missing';
  end if;

  -- (f) every configured daily topic is consistent with its URL (derived columns never drift)
  for _r in
    select g.id, g.daily_task_topic_url, g.daily_task_topic_id, g.daily_task_chat_id, p.chat, p.topic
      from public.groups g
      left join lateral public.challenge_task_parse_topic_url(g.daily_task_topic_url) p on true
     where g.daily_task_topic_url is not null
  loop
    if _r.topic is distinct from _r.daily_task_topic_id or ('-100' || _r.chat::text)::bigint is distinct from _r.daily_task_chat_id then
      raise exception 'SELF-TEST: group % daily topic columns do not match its URL', _r.id;
    end if;
  end loop;
end $$;

-- ═══════════════════════════════ 12. Audit once ═══════════════════════════════
do $$
begin
  if not exists (select 1 from public.admin_actions where action = 'challenge_daily_topic_applied') then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_daily_topic_applied', jsonb_build_object(
      'seeded', coalesce(nullif(current_setting('challenge_daily_topic.seeded', true), '')::jsonb, '[]'::jsonb),
      'kept', coalesce(nullif(current_setting('challenge_daily_topic.kept', true), '')::jsonb, '[]'::jsonb),
      'heal', coalesce(nullif(current_setting('challenge_daily_topic.heal', true), '')::jsonb, '{}'::jsonb),
      'topics', (select coalesce(jsonb_agg(jsonb_build_object('group', t.group_id, 'chat', t.chat_id, 'thread', t.thread_id)
                                           order by t.chat_id), '[]'::jsonb) from public.challenge_task_topics() t),
      'weekly_rows_existing', (select count(*) from public.challenge_weekly_results),
      'reconcile_challenge_xp_md5', (select md5(replace(prosrc, E'\r', '')) from pg_proc
                                      where oid = 'public.reconcile_challenge_xp(timestamptz)'::regprocedure),
      'challenge_social_source_md5', (select md5(replace(prosrc, E'\r', '')) from pg_proc
                                       where oid = to_regprocedure('public.challenge_social_source(timestamp with time zone, timestamp with time zone, uuid[], timestamp with time zone, timestamp with time zone, integer)')),
      'at', now()));
  end if;
end $$;
