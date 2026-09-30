CREATE OR REPLACE FUNCTION public.reconcile_community_xp(_since timestamp with time zone DEFAULT (now() - '02:00:00'::interval))
 RETURNS TABLE(awarded integer, capped integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
