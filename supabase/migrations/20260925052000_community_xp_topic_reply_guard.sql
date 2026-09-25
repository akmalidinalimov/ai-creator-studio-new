-- Community XP: an ordinary post in a forum topic is not "helping a peer".
--
-- THE BUG (latent, not yet exploited — and that is the point)
--   Telegram marks EVERY message posted in a forum topic as a reply to that topic's creation service
--   message. `recordGroupMessageEvent` stored `reply_to_message.from.id` unconditionally, so an
--   ordinary post looked like a reply to a person: whoever CREATED the topic. reconcile_community_xp
--   pays the replied-to peer's sender +3 `chelp:` per peer per day, so every classmate posting in a
--   topic would mint a help point crediting the topic's creator, every day, forever.
--
--   61,911 such rows already exist in group_message_events. NOTHING has been minted from them, and
--   the reason is pure luck: across every chat only TWO accounts have ever created a topic —
--   telegram_id 6542876935 (@alikhanova_admin, excluded by the staff CTE) and 1087968824
--   (GroupAnonymousBot, which has no profile so the peer never resolves). That is an accident of who
--   taps "create topic", not a rule. It stops protecting anyone the first time a student, an
--   assistant, or a co-teacher without the `teacher` role creates a topic in a 6.0 group — which is
--   why this lands BEFORE the first 6.0 group exists rather than after.
--
--   Counterfactual, measured: restricting to rows that pass every OTHER gate, 7,446 implicit topic
--   replies from 111 distinct students collapse under the (student, peer, day) dedup to 1,255 award
--   events = 3,765 XP, before the 10/day cap trims it.
--
-- TWO CHANGES, both forward-only.
--   1. The `help` branch now requires an EXPLICIT reply:
--        g.reply_to_message_id is distinct from g.telegram_thread_id
--      Verified against 5,000 real replies in webhook_inbox: 2,315 carry `forum_topic_created`, and
--      exactly those 2,315 have reply_to_message_id = message_thread_id. Zero rows match one signal
--      without the other, so this predicate separates implicit from explicit cleanly and cannot
--      silently drop a genuine reply.
--      An implicit topic reply now falls THROUGH to the question branch instead of being dropped, so
--      a student posting "Ustoz, savolim bor" in a topic is scored as a question rather than
--      mis-attributed as help. That is a correction, not a loss.
--   2. `staff` now also covers `group_teachers` — the junction table for co-teachers. The CTE read
--      `user_roles` only, so a co-teacher who was never given the `teacher` role could both earn
--      student community XP and, as a topic creator, collect help points from a whole group. All 3
--      current co-teachers (Guli, Feruza, Rano) already hold the role, so this is a no-op today and
--      exists to keep it one.
--
-- HISTORY IS NOT HEALED, DELIBERATELY. All 2,022 reconstructable `chelp:` events were matched back to
-- their raw Telegram payloads and 2,022 of 2,022 are genuine explicit peer replies. There is no damage
-- to repair, and deleting anything would take points off ~82 real students for a bug that never
-- touched them. The incident doctrine's "heal history" step is satisfied by verifying there is nothing
-- to heal.
--
-- REGRESSION TEST, run read-only against ALL of production history before this was written: replaying
-- the full base/typed/deduped chain under the OLD and NEW rules produces 4,890 awardable events each
-- way — 0 lost, 0 gained, 0 students affected, 0 already-paid events invalidated. The paired bot-side
-- capture fix (telegram-bot-webhook) drops both reply fields together for an implicit topic reply, so
-- new rows cannot resolve a peer at all; this predicate covers the 61,911 rows already stored.
--
-- Idempotent + replay-safe: create-or-replace only. Awards nothing on its own; the hourly cron
-- `community-xp-reconcile` (20 * * * *) calls it as before, and the engine only ever INSERTs a
-- ref_key that does not exist yet, so it can never remove or alter an existing point.

create or replace function public.reconcile_community_xp(_since timestamptz default (now() - '02:00:00'::interval))
returns table(awarded integer, capped integer)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _help int; _q int; _cap int;
  _rec record;
  _run int := 0;        -- running community XP for the current (student, day)
  _key text := '';      -- current (student, day) group key
  _aw int := 0; _cp int := 0;
begin
  -- Serialize concurrent invocations (hourly cron vs. a manual re-run) so the check-then-act daily
  -- cap below can't be jointly overshot across distinct ref_keys. Released automatically at commit.
  -- NOTE for anyone calling this from inside a migration: this is the SAME lock key the live hourly
  -- cron takes, and an advisory XACT lock is held until the real transaction commits — a savepoint
  -- rollback does NOT release it. So a migration that calls this function holds the lock for the rest
  -- of the file, and will itself wait if the cron happens to be mid-run. Harmless here (the call is
  -- the last statement), but non-obvious.
  perform pg_advisory_xact_lock(hashtext('reconcile_community_xp'));

  select coalesce((value->>'help')::int, 3),
         coalesce((value->>'question')::int, 2),
         coalesce((value->>'daily_cap')::int, 10)
    into _help, _q, _cap
  from platform_settings where key = 'community_xp';
  _help := coalesce(_help, 3); _q := coalesce(_q, 2); _cap := coalesce(_cap, 10);

  for _rec in
    with staff as (
      select distinct ur.user_id
      from user_roles ur
      where ur.role in ('teacher'::app_role, 'admin'::app_role, 'superadmin'::app_role)
      union
      -- Co-teachers live in this junction table and may never have been given the `teacher` role.
      select gt.teacher_id from group_teachers gt
    ),
    base as (
      select g.id, g.profile_id as student, g.sent_at,
             (g.sent_at at time zone 'Asia/Tashkent')::date as day,
             rp.id as peer,
             case
               when rp.id is not null and rp.id <> g.profile_id
                    and rp.id not in (select user_id from staff)
                    -- EXPLICIT reply only. Telegram makes every post in a forum topic look like a
                    -- reply to the topic-creation message, whose id IS the thread id. Without this,
                    -- posting in a topic credits its creator with "help".
                    and g.reply_to_message_id is distinct from g.telegram_thread_id  then 'help'
               when coalesce(g.has_ustoz, false) or coalesce(g.mentions_teacher, false) then 'question'
               else null
             end as kind
      from group_message_events g
      join profiles sender on sender.id = g.profile_id            -- resolve the sender's CURRENT group
      join auth.users au on au.id = g.profile_id                  -- FK guard: only real users earn (no orphan-row abort)
      left join profiles rp on rp.telegram_id = g.reply_to_user_id
      where g.sent_at >= _since
        and coalesce(g.is_anon_admin, false) = false
        and g.group_id = sender.group_id                          -- current-group activity only (anti cross-course leak)
        and g.profile_id not in (select user_id from staff)
    ),
    typed as (
      select b.id, b.student, b.sent_at, b.day, b.peer, b.kind,
             (case b.kind when 'help' then _help when 'question' then _q end) as amount,
             (case b.kind
                when 'help' then 'chelp:' || b.peer::text || ':' || b.day::text
                when 'question' then 'cq:' || b.day::text
              end) as ref_key
      from base b
      where b.kind is not null
    ),
    -- help: earliest per (student, peer, day); question: earliest per (student, day). One window:
    -- the peer key collapses to null for questions, so all of a student's questions share one partition.
    deduped as (
      select t.*,
        row_number() over (
          partition by t.student, t.day, (case when t.kind = 'help' then t.peer end)
          order by t.sent_at
        ) as rn
      from typed t
    )
    select d.id, d.student, d.sent_at, d.day, d.kind, d.amount, d.ref_key
    from deduped d
    where d.rn = 1
      and not exists (select 1 from xp_events x where x.user_id = d.student and x.ref_key = d.ref_key)
    order by d.student, d.day, d.sent_at
  loop
    -- New (student, day) group → seed the running total from XP already credited that day.
    if _key is distinct from (_rec.student::text || '|' || _rec.day::text) then
      _key := _rec.student::text || '|' || _rec.day::text;
      select coalesce(sum(x.amount), 0) into _run
      from xp_events x
      where x.user_id = _rec.student
        and x.reason in ('community_help', 'community_question')
        and (x.created_at at time zone 'Asia/Tashkent')::date = _rec.day;
    end if;

    -- Hard cap: never let a single day exceed daily_cap (skip, don't overshoot).
    if _run + _rec.amount > _cap then
      _cp := _cp + 1;
      continue;
    end if;

    insert into xp_events (user_id, amount, reason, ref_key, created_at)
    values (_rec.student, _rec.amount, 'community_' || _rec.kind, _rec.ref_key, _rec.sent_at)
    on conflict (user_id, ref_key) do nothing;
    if found then
      _run := _run + _rec.amount;
      _aw := _aw + 1;
    end if;
  end loop;

  -- Rebuild totals from the ledger (same shape as reconcile_all_xp) only when something was awarded.
  if _aw > 0 then
    insert into user_xp (user_id, total_xp, level, updated_at)
    select e.user_id, sum(e.amount)::int, public.xp_level_for(sum(e.amount)::int), now()
    from xp_events e
    group by e.user_id
    on conflict (user_id) do update
      set total_xp = excluded.total_xp, level = excluded.level, updated_at = now();
  end if;

  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'community_xp_reconciled',
            jsonb_build_object('awarded', _aw, 'capped', _cp, 'since', _since, 'at', now()));
  exception when others then null; end;

  return query values (_aw, _cp);
end;
$function$;
revoke execute on function public.reconcile_community_xp(timestamptz) from public, anon, authenticated;

-- ───────────────────────── Deploy self-test (guarded) ─────────────────────────
-- Smoke-tests the rewritten function end to end — parse, both CTEs, the window, the loop — with the
-- narrowest possible chance of touching real data.
--
-- BE PRECISE ABOUT WHY THIS IS SAFE, because an earlier draft of this comment was not. Passing a
-- "now" timestamp does NOT make an award structurally impossible: `now()` is transaction-start time,
-- and this database takes live webhook traffic, so a message committed by another transaction while
-- this migration runs could still satisfy `sent_at >= _since`. `clock_timestamp()` narrows that
-- window to the instant of the call rather than the start of the file, but does not close it.
--
-- THE REAL GUARANTEE is PL/pgSQL's rollback-on-exception: this block's `exception when others`
-- handler takes an implicit savepoint at BEGIN, so if the raise below fires, every persistent write
-- made since — including the nested reconcile_community_xp() call's xp_events insert, its user_xp
-- upsert and its own heartbeat — is rolled back. A raced award cannot survive; it surfaces as a
-- `community_xp_topic_guard_selftest_failed` row, which is written after the rollback and therefore
-- persists.
--
-- (An earlier draft replayed 30 days here, which would have written real XP to real students during a
-- deploy and could legitimately award a point the cap had previously skipped — turning a correct
-- outcome into a self-test "failure". A deploy check should observe, not mutate.)
do $$
declare _aw int; _cp int;
begin
  select r.awarded, r.capped into _aw, _cp from public.reconcile_community_xp(clock_timestamp()) r;

  if _aw <> 0 or _cp <> 0 then
    raise exception 'community xp self-test was not inert: awarded=% capped=%', _aw, _cp;
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'community_xp_topic_guard_selftest',
          jsonb_build_object('awarded', _aw, 'capped', _cp, 'at', now()));
exception when others then
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'community_xp_topic_guard_selftest_failed',
            jsonb_build_object('error', sqlerrm, 'at', now()));
  exception when others then null; end;
end $$;
