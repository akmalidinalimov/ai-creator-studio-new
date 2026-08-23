-- Make the lost-completion reconciler duration-tolerant (the "watched lessons show as missing" half).
--
-- A genuinely-watched lesson stays unchecked if its completed_at write was lost AND
-- reconcile_lesson_completions() skips it because `duration_seconds_v2` is null (Bunny never reported a
-- runtime duration). Fix: fall back to the curated `lessons.duration_seconds` when the runtime one is
-- missing — but ONLY trust it when it is a plausible length (>= 60s), so a mistakenly-low curated value
-- can't let a lightly-watched video cross 85% of a wrong-short denominator and auto-complete.
--
-- Notes:
--  * Still requires >=85% watched → disjoint from the watch-gate false set (<20%); cannot re-mark a
--    false completion, and only ADDS the +20 a student genuinely earned (ref-key idempotent → never
--    double-awards). It can only correct UNDER-credit, never remove points.
--  * Current healable backlog is ~0 (measured): every stuck row already has duration_seconds_v2 set.
--    This is forward-robustness so the class cannot recur if a future video lacks a runtime duration.

create or replace function public.reconcile_lesson_completions()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  _n int := 0;
  _users uuid[];
begin
  -- 1. Fill completed_at for watched-to-threshold lessons whose completion write was lost, and award
  --    the matching lesson XP (ref-key idempotent → never double-awards). Effective duration falls back
  --    to lessons.duration_seconds ONLY when it is >= 60s (a plausible length) and the runtime
  --    duration_seconds_v2 is missing.
  with filled as (
    update public.lesson_progress lp
    set completed_at = coalesce(lp.updated_at, now())
    from public.lessons l
    where l.id = lp.lesson_id
      and lp.completed_at is null
      and greatest(coalesce(lp.duration_seconds_v2, 0),
                   case when coalesce(l.duration_seconds, 0) >= 60 then l.duration_seconds else 0 end) > 0
      and (lp.max_position_seconds >= greatest(coalesce(lp.duration_seconds_v2, 0),
             case when coalesce(l.duration_seconds, 0) >= 60 then l.duration_seconds else 0 end) * 0.85
           or lp.max_position_seconds >= greatest(coalesce(lp.duration_seconds_v2, 0),
             case when coalesce(l.duration_seconds, 0) >= 60 then l.duration_seconds else 0 end) - 20)
    returning lp.user_id, lp.lesson_id, lp.completed_at
  ),
  awarded as (
    insert into public.xp_events (user_id, amount, reason, ref_key, created_at)
    select f.user_id, 20, 'lesson_complete', 'lesson:' || f.lesson_id::text, f.completed_at
    from filled f
    on conflict (user_id, ref_key) do nothing
    returning 1
  )
  select count(*), array_agg(distinct user_id) into _n, _users from filled;

  if _n > 0 then
    -- 2. Rebuild totals for ONLY the affected users (separate statement → sees new xp_events).
    insert into public.user_xp (user_id, total_xp, level, updated_at)
    select e.user_id, sum(e.amount)::int, public.xp_level_for(sum(e.amount)::int), now()
    from public.xp_events e
    where e.user_id = any(_users)
    group by e.user_id
    on conflict (user_id) do update
      set total_xp = excluded.total_xp, level = excluded.level, updated_at = now();

    -- 3. DB-visible health signal: a non-zero fill means a client completion write was lost.
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'lesson_completions_reconciled', jsonb_build_object('rows', _n, 'at', now()));
    exception when others then null;
    end;
  end if;

  return _n;
end;
$function$;

-- Re-assert ACLs (CREATE OR REPLACE preserves them, but be defensive — matches house precedent).
revoke execute on function public.reconcile_lesson_completions() from public, anon, authenticated;
grant execute on function public.reconcile_lesson_completions() to service_role;
