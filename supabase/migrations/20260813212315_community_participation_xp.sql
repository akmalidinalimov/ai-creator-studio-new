-- Participation XP — reward students for HELPING peers and ASKING questions in THEIR OWN group.
--
-- Fills the one real gap in the gamification engine: today XP comes only from lessons, homework,
-- daily-active and streaks — never from community participation. This adds two reasons:
--   * community_help     — a student replies to ANOTHER student's message (reply_to resolves to a
--                          fellow non-staff student, not themselves).  Default +3, per (helper,peer,day).
--   * community_question — a student asks (has_ustoz OR mentions_teacher).  Default +2, ONCE per day.
--
-- Anti-farm / integrity design (this is a competitive-leaderboard XP source — it must not be gameable):
--   * Current-group gate — a message earns XP ONLY when it was posted in the sender's CURRENT group
--     (g.group_id = sender.group_id). Without this, a student who finished course 4.0 but is still a
--     Telegram member of the (still-open) 4.0 chat could keep earning there and inflate their ACTIVE
--     5.0 leaderboard rank — the exact "account≠rating" incident class fixed in
--     20260711150000_group_rating_matches_account_points.sql. community XP flows UNSCOPED into
--     user_group_rating_xp (like daily_active), so it must be scoped to the current group at the SOURCE.
--   * Daily cap — <= daily_cap (default 10) community XP per student per Tashkent-day, HARD (an award
--     that would cross the cap is skipped, never overshoots). Concurrent invocations are serialized by
--     an advisory xact lock so the check-then-act cap can't be jointly overshot. Because events are
--     stamped created_at = the message's sent_at, the per-day cap is accurate even for the backfill.
--   * Help dedup — one help per (helper, peer, day), enforced for free by ref_key `chelp:<peer>:<day>`
--     + xp_events' UNIQUE (user_id, ref_key). A second reply to the same peer that day is a no-op.
--   * Question dedup — ONCE per (student, day) via ref_key `cq:<day>`. has_ustoz is a loose substring
--     match (telegram-bot-webhook recordGroupMessageEvent), so per-message reward would be farmable by
--     typing "ustoz"; once-daily caps that whole vector at +2/day. mentions_teacher (a real @mention of
--     the group's teacher) also qualifies. NOTE: today 100% of "questions" are bare-ustoz; a future
--     slice can add a robust "genuine question" capture signal and raise this if desired.
--
-- Idempotent + re-derivable (the reliability doctrine): the reconciler is safe to re-run; it inserts
-- xp_events ON CONFLICT DO NOTHING and rebuilds totals from the ledger (same as reconcile_all_xp), so
-- reconcile_all_xp never double-counts. community_* XP flows into total_xp -> user_group_rating_xp ->
-- the group leaderboard / daily board (like daily_active), but NOT into user_course_xp (course
-- completion stays pure — it sums only lesson/homework reasons). Values tunable via
-- platform_settings.community_xp (no deploy needed).

-- Tunable values.
insert into platform_settings (key, value)
select 'community_xp', '{"help": 3, "question": 2, "daily_cap": 10}'::jsonb
where not exists (select 1 from platform_settings where key = 'community_xp');

create or replace function public.reconcile_community_xp(_since timestamptz default now() - interval '2 hours')
returns table(awarded int, capped int)
language plpgsql
security definer
set search_path = public
as $$
declare
  _help int; _q int; _cap int;
  _rec record;
  _run int := 0;        -- running community XP for the current (student, day)
  _key text := '';      -- current (student, day) group key
  _aw int := 0; _cp int := 0;
begin
  -- Serialize concurrent invocations (hourly cron vs. a manual re-run) so the check-then-act daily
  -- cap below can't be jointly overshot across distinct ref_keys. Released automatically at commit.
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
    ),
    base as (
      select g.id, g.profile_id as student, g.sent_at,
             (g.sent_at at time zone 'Asia/Tashkent')::date as day,
             rp.id as peer,
             case
               when rp.id is not null and rp.id <> g.profile_id
                    and rp.id not in (select user_id from staff)                     then 'help'
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
$$;
revoke execute on function public.reconcile_community_xp(timestamptz) from public, anon, authenticated;

-- DB-visible health signal (admin/owner can read that participation is flowing + spot gaming).
create or replace function public.community_xp_health()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'events',   (select count(*) from xp_events where reason in ('community_help','community_question')),
    'xp_total', (select coalesce(sum(amount),0) from xp_events where reason in ('community_help','community_question')),
    'students', (select count(distinct user_id) from xp_events where reason in ('community_help','community_question')),
    'help',     (select count(*) from xp_events where reason = 'community_help'),
    'question', (select count(*) from xp_events where reason = 'community_question'),
    'last_run', (select max(created_at) from admin_actions where action = 'community_xp_reconciled'),
    'checked_at', now()
  );
$$;
revoke execute on function public.community_xp_health() from public, anon, authenticated;

-- Detector (incident doctrine): the reconciler logs 'community_xp_reconciled' EVERY hourly tick even
-- when it awards 0, so a >3h gap means the job died. DM up to 3 admins (mirrors badge_orphan_watchdog).
create or replace function public.community_xp_watchdog()
returns int
language plpgsql security definer set search_path = public
as $$
declare _last timestamptz; _tok text; _admin record; _sent int := 0;
begin
  select max(created_at) into _last from admin_actions where action = 'community_xp_reconciled';
  if _last is not null and _last > now() - interval '3 hours' then
    return 0;  -- healthy: reconciler ran recently.
  end if;

  select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
  if _tok is not null and _tok <> '' then
    for _admin in
      select distinct p.telegram_id from profiles p
      join user_roles r on r.user_id = p.id and r.role in ('admin','superadmin')
      where p.telegram_id is not null limit 3
    loop
      begin
        perform net.http_post(
          url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
          headers := jsonb_build_object('Content-Type','application/json'),
          body := jsonb_build_object('chat_id', _admin.telegram_id,
            'text', '⚠️ community-xp-reconcile ishlamayapti — oxirgi yurish: ' ||
                    coalesce(_last::text, 'hech qachon') || E'.\nHar soatda ishlashi kerak (jamoa faolligi uchun XP).'));
        _sent := _sent + 1;
      exception when others then null; end;
    end loop;
  end if;

  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'community_xp_watchdog_alert', jsonb_build_object('last_run', _last, 'sent', _sent, 'at', now()));
  exception when others then null; end;
  return _sent;
end;
$$;
revoke execute on function public.community_xp_watchdog() from public, anon, authenticated;

-- Schedule the hourly reconciler (:20, offset from other jobs) + a twice-daily watchdog, and run a
-- one-time 7-day backfill so it launches with real numbers. Each risky action is wrapped in its own
-- exception block so a cron hiccup or a backfill error can't roll back the function definitions above.
-- (The pipeline posts the whole file as one implicit transaction — the functions are already created
-- as top-level statements before this block; wrapping keeps a failure here from aborting the file.)
do $$
begin
  begin
    if exists (select 1 from cron.job where jobname = 'community-xp-reconcile') then
      perform cron.unschedule('community-xp-reconcile');
    end if;
    perform cron.schedule('community-xp-reconcile', '20 * * * *', $cmd$ select public.reconcile_community_xp() $cmd$);
  exception when others then
    begin insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'community_xp_cron_failed', jsonb_build_object('job','reconcile','error',sqlerrm,'at',now()));
    exception when others then null; end;
  end;

  begin
    if exists (select 1 from cron.job where jobname = 'community-xp-watchdog') then
      perform cron.unschedule('community-xp-watchdog');
    end if;
    perform cron.schedule('community-xp-watchdog', '35 9,21 * * *', $cmd$ select public.community_xp_watchdog() $cmd$);
  exception when others then
    begin insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'community_xp_cron_failed', jsonb_build_object('job','watchdog','error',sqlerrm,'at',now()));
    exception when others then null; end;
  end;

  begin
    perform public.reconcile_community_xp(now() - interval '7 days');
  exception when others then
    begin insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'community_xp_backfill_failed', jsonb_build_object('error', sqlerrm, 'at', now()));
    exception when others then null; end;
  end;
end $$;
