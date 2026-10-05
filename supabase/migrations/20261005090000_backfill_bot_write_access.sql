-- Mark students who DID press Start in the bot as reachable, and deliver what they missed today (2026-10-05).
--
-- WHY: profiles.telegram_write_access_at ("the bot may DM this student") was stamped only by the Mini App sign-in.
-- A student who pressed Start in the bot but never opened the Mini App stayed NULL, so every flag-based audience
-- skipped them: the Instagram reminders, the Instagram announcement, the new points rules broadcast. On 2026-10-05,
-- 18 Challenge 6.0 students had a private message to the bot in webhook_inbox and a NULL flag (found while checking
-- @Solarex_ROP). The bot now stamps the flag on any private message (same PR); this repairs the history.
--
-- 1. BACKFILL: for every course-6.0 profile with a NULL flag whose telegram_id has sent the bot a private message
--    (webhook_inbox, chat.type = 'private'), the flag = the time of that first private message. Evidence-based,
--    idempotent (only NULL rows). Scoped to 6.0 on purpose (18 rows): 479 older-course profiles have the same gap but
--    nothing there reads the flag; the bot's own stamp (same PR) marks them as they write.
-- 2. CATCH-UP: the newly marked course-6.0 students who are not staff get the two broadcasts they missed today:
--    the new points rules (everyone) and the Instagram announcement (only those still without a username). Rows
--    are added to the existing broadcasts; the drainer sends them in the student's language, now (it is daytime).

do $$
declare
  _stamped int;
  _course constant uuid := 'f502f631-2104-4834-b6c2-702cd3080e27';
  _rules uuid;
  _ig uuid;
  _n_rules int := 0;
  _n_ig int := 0;
begin
  if exists (select 1 from public.admin_actions where action = 'bot_write_access_backfilled') then
    raise notice 'already backfilled';
    return;
  end if;

  create temporary table _newly (id uuid primary key, telegram_id bigint) on commit drop;

  with first_pm as (
    select (w.raw_update->'message'->'from'->>'id')::bigint as tg, min(w.received_at) as at
      from public.webhook_inbox w
     where w.raw_update->'message'->'chat'->>'type' = 'private'
       and (w.raw_update->'message'->'from'->>'id') ~ '^[0-9]{1,15}$'
     group by 1
  ), upd as (
    update public.profiles p
       set telegram_write_access_at = f.at
      from first_pm f
     where p.telegram_id = f.tg and p.telegram_write_access_at is null
       and p.group_id in (select g.id from public.groups g where g.course_id = _course)
    returning p.id, p.telegram_id
  )
  insert into _newly select id, telegram_id from upd;
  get diagnostics _stamped = row_count;

  if _stamped > 60 then
    raise exception 'ABORT: % profiles would be stamped — far more than the evidence on 2026-10-05 (18)', _stamped;
  end if;

  select (details->>'broadcast_id')::uuid into _rules from public.admin_actions
   where action = 'broadcast_created' and details->>'marker' = 'new_points_rules_20261005' limit 1;
  select (details->>'broadcast_id')::uuid into _ig from public.admin_actions
   where action = 'challenge_ig_handle_announcement' limit 1;

  if _rules is not null then
    insert into public.broadcast_deliveries (broadcast_id, user_id, telegram_id, scheduled_for)
    select _rules, p.id, p.telegram_id, now()
      from _newly n join public.profiles p on p.id = n.id join public.groups g on g.id = p.group_id
     where g.course_id = _course and p.status = 'active' and p.archived_at is null
       and not exists (select 1 from public.user_roles r where r.user_id = p.id and r.role in ('admin', 'superadmin', 'teacher'))
       and not exists (select 1 from public.broadcast_deliveries d where d.broadcast_id = _rules and d.user_id = p.id);
    get diagnostics _n_rules = row_count;
    update public.broadcasts set total = total + _n_rules, status = case when _n_rules > 0 then 'sending' else status end,
           finished_at = case when _n_rules > 0 then null else finished_at end
     where id = _rules;
  end if;

  if _ig is not null then
    insert into public.broadcast_deliveries (broadcast_id, user_id, telegram_id, scheduled_for)
    select _ig, p.id, p.telegram_id, now()
      from _newly n join public.profiles p on p.id = n.id join public.groups g on g.id = p.group_id
     where g.course_id = _course and p.status = 'active' and p.archived_at is null and p.instagram_username is null
       and not exists (select 1 from public.user_roles r where r.user_id = p.id and r.role in ('admin', 'superadmin', 'teacher'))
       and not exists (select 1 from public.broadcast_deliveries d where d.broadcast_id = _ig and d.user_id = p.id);
    get diagnostics _n_ig = row_count;
    update public.broadcasts set total = total + _n_ig, status = case when _n_ig > 0 then 'sending' else status end,
           finished_at = case when _n_ig > 0 then null else finished_at end
     where id = _ig;
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'bot_write_access_backfilled', jsonb_build_object(
    'migration', '20261005090000', 'at', now(), 'stamped', _stamped,
    'catch_up_rules', _n_rules, 'catch_up_ig_announcement', _n_ig));
end $$;
