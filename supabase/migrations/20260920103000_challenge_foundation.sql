-- AI Creators Challenge 6.0 — foundation: Instagram handle, scope flag, group-activity points.
--
-- WHAT THIS IS: the next cohort runs as a CHALLENGE. Students earn points for every activity and
-- compete for weekly and grand prizes. This migration adds the points that come from TELEGRAM group
-- activity, plus the Instagram handle that the (later) Instagram webhook matches against.
--
-- WHY IT TOUCHES NO EDGE FUNCTION: the bot already persists every Telegram update raw in
-- webhook_inbox, and group_message_events already resolves the group + student. So the new points are
-- derived in SQL from data that exists today. `telegram-bot-webhook` is NOT modified — the live 5.0
-- cohort's bot behaviour stays byte-identical.
--
-- SAFETY FOR THE RUNNING 5.0 COHORT (the owner's first question):
--   * Everything here is gated on platform_settings.challenge, which is seeded DISABLED with an empty
--     scope. challenge_group_ids() returns NOTHING until an admin names groups, so the reconciler is a
--     no-op on deploy and 5.0 can never receive a challenge point by accident.
--   * Additive only: one nullable column on profiles, new tables, new functions. No existing column,
--     constraint, trigger or reconciler is altered.
--   * The profiles trigger added below is wrapped so it can NEVER block a profile write (see there).
--
-- ANTI-FARM DESIGN (these points decide prizes, so they must not be gameable) — mirrors
-- 20260813212315_community_participation_xp.sql:
--   * Current-group gate: a message earns only in the sender's CURRENT group (anti cross-course leak).
--   * Staff and anonymous-admin messages earn nothing.
--   * Per-day caps, enforced HARD (an award that would cross the cap is skipped, never overshoots),
--     serialized by an advisory xact lock so concurrent runs can't jointly overshoot.
--   * Dedup rides on xp_events' UNIQUE (user_id, ref_key): one media award per message, one question
--     per day.
--   * Events are stamped created_at = the message's sent_at, so the per-day cap stays accurate even
--     when a run covers a long window.
--
-- CROSS-RECONCILER SAFETY (both reviews flagged this; the XP review called it blocking): question
-- points deliberately reuse the EXISTING `cq:<day>` ref_key rather than a parallel `ch_q:<day>`.
-- reconcile_community_xp pays `cq:<day>` for an "ustoz" question and knows nothing about this engine.
-- A real question ("Ustoz, bu yerda nima xato?") satisfies BOTH engines, so with two different keys
-- whichever job ran second would have paid a SECOND point for the same question — +4 instead of +2,
-- permanently, since both are idempotent. Sharing one key makes that impossible by construction:
-- xp_events' UNIQUE (user_id, ref_key) rejects the duplicate, and the existing reconciler needs no
-- change. The reason column still records which engine paid ('challenge_question' vs
-- 'community_question'), so reporting can tell them apart.
--   Accepted side effect: a challenge question can add up to +2 beyond the community daily cap, since
--   that cap is counted inside the other reconciler. Bounded at one award per student per day.
--
-- ACCEPTED LIMITS, recorded so nobody rediscovers them the hard way (XP-integrity review):
--   * RATING CARRY-OVER: user_group_rating_xp subtracts only lesson/homework XP belonging to another
--     course, so challenge points — like community and daily XP before them — stay in a student's
--     total and follow them into whatever group they are in LATER. This cannot affect the challenge
--     prizes (every participant is in a 6.0 group for the whole window), but when this cohort moves on
--     their challenge points will sit in the next group's rating. Fixing it needs a source-group tag on
--     the ledger row, which changes the shared rating function and belongs in its own PR.
--   * GROUP MEDIA IS PARTICIPATION, NOT QUALITY: any photo or video outside the homework topic earns,
--     with no relevance bar. The daily cap is the bound — at most 2 posts, 10 points, against 30 for a
--     single verified Instagram post, so the cheapest path is also the least rewarding one.
--
-- KNOWN PRE-EXISTING VECTOR, deliberately NOT changed here: reconcile_community_xp pays `chelp:` for
-- any reply, and Telegram marks every post in a forum topic as a reply to the topic-creation message,
-- so a student who creates a topic can collect help points from posts in it. Fixing that changes what
-- 5.0 students already earn, so it belongs in its own reviewed PR rather than riding along here.

-- ───────────────────────── 1. Instagram handle on the profile ─────────────────────────
alter table public.profiles add column if not exists instagram_username citext;

-- One account, one student. This UNIQUE index is the backbone of Instagram anti-fraud: two students
-- cannot both claim the same handle, so a verified post maps to exactly one person.
create unique index if not exists uq_profiles_instagram_username
  on public.profiles (instagram_username)
  where instagram_username is not null;

-- Normalize whatever the student or the sales team types: "@Name", " name ", or a full profile URL
-- all become the bare handle. citext then makes matching case-insensitive.
-- NEVER let this block a profile write: profiles is a hot, shared table (5.0 included), so any
-- unexpected input falls through and saves the row unchanged rather than raising.
create or replace function public.normalize_instagram_username()
returns trigger
language plpgsql
as $$
declare _v text;
begin
  if new.instagram_username is null then
    return new;
  end if;
  begin
    _v := lower(btrim(new.instagram_username::text));
    if _v like '%instagram.com/%' then
      _v := split_part(split_part(_v, 'instagram.com/', 2), '?', 1);   -- strip query string
      _v := split_part(_v, '/', 1);                                    -- first path segment
    end if;
    _v := regexp_replace(_v, '^@+', '');
    _v := nullif(btrim(_v), '');
    if _v is not null and _v !~ '^[a-z0-9._]{1,30}$' then
      -- Unusable input must never silently WIPE a handle that already earned points: keep the old
      -- value on an update, and store nothing on an insert.
      if tg_op = 'UPDATE' then
        new.instagram_username := old.instagram_username;
        return new;
      end if;
      _v := null;
    end if;
    new.instagram_username := _v::citext;
  exception when others then
    return new;
  end;
  return new;
end;
$$;

drop trigger if exists trg_profiles_normalize_instagram on public.profiles;
create trigger trg_profiles_normalize_instagram
  before insert or update of instagram_username on public.profiles
  for each row execute function public.normalize_instagram_username();

-- ───────────────────────── 2. Scope flag (fail-closed) ─────────────────────────
-- enabled=false + empty scope => challenge_group_ids() returns nothing => every function below is
-- inert until an admin opts a group in. Values are tunable with no deploy.
insert into platform_settings (key, value)
select 'challenge', jsonb_build_object(
    'enabled', false,
    'course_ids', '[]'::jsonb,
    'group_ids', '[]'::jsonb,
    'window', jsonb_build_object('start', null, 'end', null),
    'points', jsonb_build_object('ig_post', 30, 'group_media', 5, 'question', 2),
    'caps', jsonb_build_object('ig_post_per_day', 2, 'group_media_per_day', 2)
  )
where not exists (select 1 from platform_settings where key = 'challenge');

create or replace function public.challenge_config()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select coalesce((select value from platform_settings where key = 'challenge'), '{}'::jsonb);
$$;

-- Active = switched on AND inside the challenge window (either end may be null = open-ended).
-- plpgsql with an exception handler on purpose: a malformed window timestamp typed into the settings
-- row would otherwise raise inside EVERY caller (the reconciler, health, the watchdog). It must fail
-- CLOSED rather than take the engine down.
create or replace function public.challenge_active(_at timestamptz default now())
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare _cfg jsonb; _s text; _e text;
begin
  _cfg := public.challenge_config();
  if not coalesce((_cfg->>'enabled')::boolean, false) then
    return false;
  end if;
  _s := nullif(_cfg->'window'->>'start', '');
  _e := nullif(_cfg->'window'->>'end', '');
  if _s is not null and _at < _s::timestamptz then return false; end if;
  if _e is not null and _at > _e::timestamptz then return false; end if;
  return true;
exception when others then
  return false;
end;
$$;

-- The groups in scope: explicitly listed groups, plus every group of a listed course. Returns NOTHING
-- when the flag is off or unset, which is what keeps 5.0 out.
create or replace function public.challenge_group_ids()
returns setof uuid
language sql stable security definer set search_path = public
as $$
  select g.id
  from groups g
  where public.challenge_active()
    and (
      g.id::text in (select jsonb_array_elements_text(coalesce(public.challenge_config()->'group_ids', '[]'::jsonb)))
      or g.course_id::text in (select jsonb_array_elements_text(coalesce(public.challenge_config()->'course_ids', '[]'::jsonb)))
    );
$$;

-- ───────────────────────── 3. Frozen weekly results (prizes are paid from these) ─────────────────────────
create table if not exists public.challenge_weekly_results (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  kind text not null check (kind in ('individual','team')),
  group_id uuid references public.groups(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  points int not null default 0,
  rank int,
  created_at timestamptz not null default now(),
  -- NULLS NOT DISTINCT so a team row (user_id null) can't be duplicated by a re-run.
  constraint uq_challenge_weekly unique nulls not distinct (week_start, kind, group_id, user_id)
);
alter table public.challenge_weekly_results enable row level security;  -- service-role only, no policies

-- ───────────────────────── 4. The reconciler (group-activity points) ─────────────────────────
-- Runs every 10 minutes. Every award is idempotent, so overlap is free and a missed tick heals itself.
create or replace function public.reconcile_challenge_xp(_since timestamptz default null)
returns table(awarded int, capped int)
language plpgsql
security definer
set search_path = public
as $$
declare
  _p_media int; _p_question int; _cap_media int;
  _rec record;
  _run_media int := 0;
  _key text := '';
  _aw int := 0; _cp int := 0;
  _active boolean := public.challenge_active();
begin
  perform pg_advisory_xact_lock(hashtext('reconcile_challenge_xp'));

  -- Self-healing lookback: normally the last heartbeat minus a 30-minute overlap, so an outage of any
  -- length is covered by the next tick instead of silently losing every point earned while the cron
  -- was down. Falls back to 2 hours on a first run. Cheap either way — webhook_inbox is read through
  -- its received_at index.
  _since := coalesce(
    _since,
    (select max(created_at) - interval '30 minutes'
       from admin_actions where action = 'challenge_xp_reconciled'),
    now() - interval '2 hours');

  if _active then
    select coalesce((public.challenge_config()->'points'->>'group_media')::int, 5),
           coalesce((public.challenge_config()->'points'->>'question')::int, 2),
           coalesce((public.challenge_config()->'caps'->>'group_media_per_day')::int, 2)
      into _p_media, _p_question, _cap_media;

    for _rec in
      with staff as (
        select distinct ur.user_id
        from user_roles ur
        where ur.role in ('teacher'::app_role, 'admin'::app_role, 'superadmin'::app_role)
      ),
      base as (
        -- Driven from webhook_inbox.received_at (indexed) so this never scans the 199MB table, then
        -- joined to group_message_events by its UNIQUE (chat, message) key.
        select g.profile_id as student,
               g.sent_at,
               (g.sent_at at time zone 'Asia/Tashkent')::date as day,
               g.telegram_chat_id as chat_id,
               g.telegram_message_id as msg_id,
               g.telegram_thread_id as thread_id,
               grp.homework_topic_id,
               (w.raw_update->'message') as m
        from webhook_inbox w
        join group_message_events g
          on g.telegram_chat_id = w.chat_id
         and g.telegram_message_id = w.message_id
        join groups grp on grp.id = g.group_id
        join profiles sender on sender.id = g.profile_id
        join auth.users au on au.id = g.profile_id          -- only real users earn
        where w.received_at >= _since
          and w.update_type = 'message'
          and g.group_id in (select public.challenge_group_ids())
          and g.group_id = sender.group_id                  -- current-group gate
          and coalesce(g.is_anon_admin, false) = false
          and g.profile_id not in (select user_id from staff)
      ),
      typed as (
        select b.*,
          case
            -- Own work shared in the group. The homework topic is excluded: homework already has its
            -- own points, and paying twice for one upload would be the easiest farm in the system.
            -- A group with NO homework topic configured earns NO media points rather than paying for
            -- every homework upload — safe by construction, and surfaced by challenge_health().
            when ((b.m->'photo') is not null or (b.m->'video') is not null)
                 and b.homework_topic_id is not null
                 and b.thread_id is distinct from b.homework_topic_id
              then 'media'
            -- A real question, not a bare "?" — 15 characters keeps one-character spam out.
            when coalesce(b.m->>'text', b.m->>'caption', '') like '%?%'
                 and length(coalesce(b.m->>'text', b.m->>'caption', '')) >= 15
              then 'question'
          end as kind
        from base b
      ),
      scored as (
        select t.student, t.sent_at, t.day, t.kind,
               case t.kind when 'media' then _p_media when 'question' then _p_question end as amount,
               case t.kind
                 when 'media' then 'ch_img:' || t.chat_id::text || ':' || t.msg_id::text
                 -- Shared namespace with reconcile_community_xp — see the header. The UNIQUE
                 -- (user_id, ref_key) makes a double-pay for one question impossible.
                 when 'question' then 'cq:' || t.day::text
               end as ref_key
        from typed t
        where t.kind is not null
      ),
      deduped as (
        select s.*,
               row_number() over (
                 partition by s.student, s.day, s.kind, (case when s.kind = 'media' then s.ref_key end)
                 order by s.sent_at
               ) as rn
        from scored s
      )
      select d.student, d.sent_at, d.day, d.kind, d.amount, d.ref_key
      from deduped d
      where d.rn = 1
        and not exists (select 1 from xp_events x where x.user_id = d.student and x.ref_key = d.ref_key)
      order by d.student, d.day, d.sent_at
    loop
      if _key is distinct from (_rec.student::text || '|' || _rec.day::text) then
        _key := _rec.student::text || '|' || _rec.day::text;
        select count(*) into _run_media
        from xp_events x
        where x.user_id = _rec.student
          and x.reason = 'challenge_group_media'
          and (x.created_at at time zone 'Asia/Tashkent')::date = _rec.day;
      end if;

      if _rec.kind = 'media' and _run_media >= _cap_media then
        _cp := _cp + 1;
        continue;
      end if;

      insert into xp_events (user_id, amount, reason, ref_key, created_at)
      values (_rec.student, _rec.amount,
              case _rec.kind when 'media' then 'challenge_group_media' else 'challenge_question' end,
              _rec.ref_key, _rec.sent_at)
      on conflict (user_id, ref_key) do nothing;
      if found then
        if _rec.kind = 'media' then _run_media := _run_media + 1; end if;
        _aw := _aw + 1;
      end if;
    end loop;

    if _aw > 0 then
      insert into user_xp (user_id, total_xp, level, updated_at)
      select e.user_id, sum(e.amount)::int, public.xp_level_for(sum(e.amount)::int), now()
      from xp_events e
      group by e.user_id
      on conflict (user_id) do update
        set total_xp = excluded.total_xp, level = excluded.level, updated_at = now();
    end if;
  end if;

  -- Heartbeat on EVERY tick, including while the challenge is off, and it records which. The watchdog
  -- can then tell "switched off" apart from "the job died" instead of guessing. It is also what the
  -- self-healing lookback above reads.
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_xp_reconciled',
            jsonb_build_object('awarded', _aw, 'capped', _cp, 'active', _active, 'since', _since, 'at', now()));
  exception when others then null; end;

  return query values (_aw, _cp);
end;
$$;
revoke execute on function public.reconcile_challenge_xp(timestamptz) from public, anon, authenticated;

-- ───────────────────────── 5. Team board (group vs group) ─────────────────────────
-- Ranked by average points per ENROLLED member, not by total: group sizes differ, and averaging over
-- everyone enrolled rewards groups that bring every member along rather than a few stars.
-- It counts ALL points earned in the window — lessons and homework included, not only challenge
-- points. That is deliberate: the rule is that every activity earns, so a group that studies hard
-- competes with a group that posts hard.
create or replace function public.challenge_team_board(_from timestamptz, _to timestamptz)
returns table(group_id uuid, group_name text, members int, total_points bigint, avg_points numeric)
language sql stable security definer set search_path = public
as $$
  with staff as (
    select distinct ur.user_id from user_roles ur
    where ur.role in ('teacher'::app_role, 'admin'::app_role, 'superadmin'::app_role)
  ),
  members as (
    select p.id as user_id, p.group_id
    from profiles p
    where p.group_id in (select public.challenge_group_ids())
      and coalesce(p.status::text, '') <> 'archived'
      and p.id not in (select user_id from staff)
  )
  select g.id, g.name,
         count(distinct m.user_id)::int as members,
         coalesce(sum(x.amount), 0)::bigint as total_points,
         round(coalesce(sum(x.amount), 0)::numeric / greatest(count(distinct m.user_id), 1), 1) as avg_points
  from groups g
  join members m on m.group_id = g.id
  left join xp_events x on x.user_id = m.user_id and x.created_at >= _from and x.created_at < _to
  group by g.id, g.name
  order by avg_points desc, total_points desc;
$$;
revoke execute on function public.challenge_team_board(timestamptz, timestamptz) from public, anon, authenticated;

-- ───────────────────────── 6. Disqualification (rare, admin-only) ─────────────────────────
-- There is no per-submission review; this is the reactive tool for a proven cheat. It matches on the
-- REASON as well as the ref_key, because question points share the community `cq:` namespace.
-- `starts_with(ref_key,'ch_')` deliberately does not match the existing `chelp:` community key.
create or replace function public.admin_void_challenge_points(_student uuid, _reason text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare _n int := 0;
begin
  if not (public.has_role(auth.uid(), 'admin'::app_role)
          or public.has_role(auth.uid(), 'superadmin'::app_role)) then
    raise exception 'forbidden';
  end if;

  delete from xp_events
  where user_id = _student
    and (starts_with(ref_key, 'ch_') or reason like 'challenge\_%');
  get diagnostics _n = row_count;

  insert into user_xp (user_id, total_xp, level, updated_at)
  select _student, coalesce(sum(amount), 0)::int,
         public.xp_level_for(coalesce(sum(amount), 0)::int), now()
  from xp_events where user_id = _student
  on conflict (user_id) do update
    set total_xp = excluded.total_xp, level = excluded.level, updated_at = now();

  begin
    insert into public.admin_actions (actor_user_id, action, target_user_id, details)
    values (auth.uid(), 'challenge_points_voided', _student,
            jsonb_build_object('removed', _n, 'reason', _reason, 'at', now()));
  exception when others then null; end;

  return _n;
end;
$$;
revoke execute on function public.admin_void_challenge_points(uuid, text) from public, anon;

-- ───────────────────────── 7. Health + watchdog ─────────────────────────
create or replace function public.challenge_health()
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'active',          public.challenge_active(),
    'groups_in_scope', (select count(*) from public.challenge_group_ids()),
    -- A scoped group with no homework topic configured earns NO media points at all (see the
    -- reconciler). Surfaced here so a mis-configured group is visible instead of silently unpaid.
    'groups_missing_homework_topic',
      (select count(*) from groups g
       where g.id in (select public.challenge_group_ids()) and g.homework_topic_id is null),
    'handles',         (select count(*) from profiles where instagram_username is not null),
    'media_points',    (select count(*) from xp_events where reason = 'challenge_group_media'),
    'question_points', (select count(*) from xp_events where reason = 'challenge_question'),
    'ig_points',       (select count(*) from xp_events where reason = 'challenge_instagram'),
    'students',        (select count(distinct user_id) from xp_events where reason like 'challenge\_%'),
    'xp_total',        (select coalesce(sum(amount), 0) from xp_events where reason like 'challenge\_%'),
    'last_run',        (select max(created_at) from admin_actions where action = 'challenge_xp_reconciled'),
    'checked_at',      now()
  );
$$;
revoke execute on function public.challenge_health() from public, anon, authenticated;

-- The reconciler heartbeats every 10 minutes, so a gap over an hour means the job died. Silence is
-- only acceptable while the challenge is switched off.
create or replace function public.challenge_xp_watchdog()
returns int
language plpgsql security definer set search_path = public
as $$
declare _last timestamptz; _tok text; _admin record; _sent int := 0;
begin
  if not public.challenge_active() then
    return 0;
  end if;

  select max(created_at) into _last from admin_actions where action = 'challenge_xp_reconciled';
  if _last is not null and _last > now() - interval '1 hour' then
    return 0;
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
            'text', E'⚠️ challenge-xp-reconcile ishlamayapti — oxirgi yurish: ' ||
                    coalesce(_last::text, 'hech qachon') ||
                    E'.\nChallenge yoqilgan, lekin ballar hisoblanmayapti.'));
        _sent := _sent + 1;
      exception when others then null; end;
    end loop;
  end if;

  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_xp_watchdog_alert', jsonb_build_object('last_run', _last, 'sent', _sent, 'at', now()));
  exception when others then null; end;
  return _sent;
end;
$$;
revoke execute on function public.challenge_xp_watchdog() from public, anon, authenticated;

-- ───────────────────────── 8. Schedules ─────────────────────────
-- Each action is wrapped separately so a cron hiccup can't roll back the definitions above. No
-- backfill is run here: the flag is off, so the reconciler is a deliberate no-op on deploy.
do $$
begin
  begin
    if exists (select 1 from cron.job where jobname = 'challenge-xp-reconcile') then
      perform cron.unschedule('challenge-xp-reconcile');
    end if;
    perform cron.schedule('challenge-xp-reconcile', '*/10 * * * *', $cmd$ select public.reconcile_challenge_xp() $cmd$);
  exception when others then
    begin insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'challenge_cron_failed', jsonb_build_object('job','reconcile','error',sqlerrm,'at',now()));
    exception when others then null; end;
  end;

  begin
    if exists (select 1 from cron.job where jobname = 'challenge-xp-watchdog') then
      perform cron.unschedule('challenge-xp-watchdog');
    end if;
    perform cron.schedule('challenge-xp-watchdog', '45 9,21 * * *', $cmd$ select public.challenge_xp_watchdog() $cmd$);
  exception when others then
    begin insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'challenge_cron_failed', jsonb_build_object('job','watchdog','error',sqlerrm,'at',now()));
    exception when others then null; end;
  end;
end $$;

-- Deploy-time self-test: proves the reconciler parses and runs. With the flag off it awards nothing
-- and only writes its heartbeat. A failure is recorded, never raised.
do $$
begin
  perform public.reconcile_challenge_xp();
exception when others then
  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'challenge_selftest_failed', jsonb_build_object('error', sqlerrm, 'at', now()));
end $$;
