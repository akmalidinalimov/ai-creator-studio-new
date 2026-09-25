-- Challenge reconciler: the pre-activation tuning pass.
--
-- WHY NOW, AND ONLY NOW. reconcile_challenge_xp is INERT (challenge.enabled=false, empty scope, zero
-- challenge xp_events ever written). Changing its logic today costs nothing and risks nothing. The
-- moment the owner switches the challenge on, the same edit becomes a live-points change with prize
-- money attached and students watching a leaderboard. This is the last cheap moment, so everything
-- found in the pre-activation audit lands together.
--
-- ═══ THE TWO DEFECTS NOBODY WENT LOOKING FOR ═══
--
-- D1 (CRITICAL) THE "SELF-HEALING" LOOKBACK IS SELF-WEDGING.
--   webhook_inbox has indexes on chat_id, from_user_id and received_at, but NO (chat_id, message_id)
--   composite -- so the join from group_message_events has no usable access path. Measured cost of the
--   catch-up scan: 40 min = 0.7 ms, 24 h = 16 ms, 5 days = full seq scan of group_message_events,
--   30 days = 98,444 ms. statement_timeout is 120 s and the pg_cron role has no override, so past the
--   cliff the run is KILLED. And the kill is what makes it permanent: the heartbeat INSERT is the last
--   statement in the same transaction, so a kill rolls it back, `_since` never advances, and the next
--   tick is strictly more expensive. It would burn 120 s of CPU every 10 minutes forever, and
--   webhook_inbox is never pruned (148,797 rows / 203 MB) so it only worsens.
--   FIXED three ways: the missing index; a hard 24h clamp on the lookback; and a TRY-lock so slow runs
--   never queue behind each other. The clamp is a real trade -- an outage longer than 24h no longer
--   back-fills silently -- so truncation is RECORDED in the heartbeat (`lookback_clamped`) instead of
--   being invisible. An admin can still back-fill deliberately by calling with an explicit _since.
--
-- D2 (HIGH) AN OWNER-TYPED CONFIG VALUE COULD BRICK THE ENGINE PERMANENTLY.
--   xp_events carries CHECK (amount > 0). The config is explicitly advertised as "tunable with no
--   deploy", so it WILL be hand-edited -- and `"group_media": 0` made every insert raise 23514, while
--   `"group_media": "5 ball"` raised 22P02, aborting the whole function on every tick thereafter.
--   FIXED: the read is parsed defensively. Unparseable -> fall back to the default AND record
--   `challenge_config_invalid`. Zero or negative -> treat the signal as deliberately SWITCHED OFF
--   (award nothing) rather than aborting, which is the only reading of "0" that isn't a crash.
--
-- ═══ THE FOUR OWNER DECISIONS ═══
--
-- 1. ONE ALBUM = ONE POST, DAILY CAP RAISED 2 -> 3.
--    Telegram splits an album into N messages sharing a media_group_id, and the old cap counted
--    MESSAGES -- so a 3-photo album spent both slots and paid the full daily maximum for one share,
--    then blocked everything else that day (13.8% of media-days). Note this over-credited rather than
--    under-credited: album-awareness ALONE would have been a 4.3% pay cut (38 student-days worse, zero
--    better). Pairing it with cap 3 makes it a net +8.4%: 112 student-days better, 38 worse. The model
--    is now honest ("three separate shares beat one burst") and the board means what students think.
--    media_group_id is verified reliable: 321 albums / 1,339 parts over 60 days, present on 100% of
--    members, never reused across chats, so (chat, media_group_id) is a stable album identity visible
--    to EVERY run. Max observed size is 11 -- above Telegram's documented 10, so no size assumption.
--
-- 2. "SEND AS FILE" COUNTS AS OWN WORK.
--    The old predicate matched only Telegram-COMPRESSED media, so a student using the quality-
--    preserving path sent a `document` and earned nothing: 502 of 1,992 media posts (25.2%), and FOUR
--    students posted media only that way -- zero media points for an entire cohort while posting work
--    every week. Now an image/* or video/* document counts.
--
-- 3. A FORWARD FROM SOMEONE ELSE IS NOT OWN WORK -- BUT A SELF-FORWARD IS.
--    Verified shapes over 60 days: forward_origin and forward_date always co-occur (493 each, zero
--    legacy-only rows), and 180 forwards are the student re-sending their OWN message. A blanket ban
--    would have punished a student for moving their own post between topics, so the test is
--    "forwarded from someone else". Both fields are checked so that if a future Bot API stopped
--    sending forward_origin, this fails CLOSED rather than silently paying for every forwarded meme.
--
-- 4. THE QUESTION BRANCH IS REMOVED ENTIRELY.
--    The rule did not detect questions, it detected the character "?": of 1,304 matches over 60 days
--    only 97 (7.4%) were teacher-directed, and 192 (14.7%) matched on a "?" inside a URL QUERY STRING
--    (instagram.com/reel/...?igsi=...). An Instagram-themed cohort floods the chat with exactly those.
--    Removal also fixes a live ordering defect: this job runs */10 and reconcile_community_xp runs :20,
--    so the challenge claimed the shared `cq:<day>` key first on 39% of days where both qualified,
--    silently relabelling a real teacher question as `challenge_question`. Nothing real is lost --
--    community still pays +2/day for a genuine teacher-directed question, and the whole branch was
--    worth 1.1% of these students' XP.
--    SEPARATE BUG FOUND, NOT FIXED HERE (it needs a bot change of its own): the capture-side
--    `hasUstoz` in telegram-bot-webhook is `_txt.includes("ustoz")` -- a Latin substring match that
--    matched 660/660 Latin spellings and 0/79 Cyrillic "устоз", and knows nothing about "#savol"
--    (217 uses, only 100 flagged). That weakens community's question detection and deserves its own PR.
--
-- SAFETY: awards nothing on its own; the flag is off and the scope is empty. No history to heal --
-- zero challenge points have ever been written, in either the ch_img: or the new ch_alb: namespace.
-- Idempotent + replay-safe: create-or-replace plus create-index-if-not-exists.

-- ───────────────────────── 1. The missing index (D1 root cause) ─────────────────────────
-- Ship this even if nothing else here lands. NOTE: a plain CREATE INDEX takes a SHARE lock that blocks
-- webhook_inbox INSERTs (the Telegram webhook) while it builds -- seconds at 148,797 rows / 203 MB,
-- not zero. CONCURRENTLY cannot be used because the deploy pipeline wraps each file in a transaction.
-- Accepted deliberately: a few seconds of queued webhook writes, once, versus a function that wedges.
create index if not exists webhook_inbox_chat_msg_idx
  on public.webhook_inbox (chat_id, message_id);

-- ───────────────────────── 2. Raise the media cap to 3 ─────────────────────────
-- Paired with album-awareness below: an album is now ONE unit, so without this the change would be a
-- silent pay cut. Inert today (no students in scope); tunable afterwards with no deploy.
update public.platform_settings
   set value = jsonb_set(value, '{caps,group_media_per_day}', '3'::jsonb, true)
 where key = 'challenge'
   and coalesce((value->'caps'->>'group_media_per_day')::int, 2) = 2;

-- ───────────────────────── 3. The reconciler ─────────────────────────
create or replace function public.reconcile_challenge_xp(_since timestamptz default null)
returns table(awarded int, capped int)
language plpgsql
security definer
set search_path = public
as $$
declare
  _p_media int; _cap_media int;
  _cfg_bad boolean := false; _media_off boolean := false;
  _clamped boolean := false; _floor timestamptz := now() - interval '24 hours';
  _rec record;
  _run_media int := 0;
  _key text := '';
  _aw int := 0; _cp int := 0; _sk int := 0;
  _active boolean := public.challenge_active();
begin
  -- TRY-lock, not a blocking lock. A slow run must not make the next tick queue behind it; that is how
  -- a single expensive catch-up turns into a permanent backlog. Skipping is safe because the lookback
  -- overlaps and every award is idempotent.
  if not pg_try_advisory_xact_lock(hashtext('reconcile_challenge_xp')) then
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'challenge_xp_reconciled',
              jsonb_build_object('awarded', 0, 'capped', 0, 'active', _active,
                                 'skipped', 'locked', 'at', now()));
    exception when others then null; end;
    return query values (0, 0);
    return;
  end if;

  -- Self-healing lookback: normally the last heartbeat minus a 30-minute overlap. CLAMPED to 24h --
  -- see D1. An explicit _since argument is an admin's deliberate back-fill and is NOT clamped.
  if _since is null then
    _since := coalesce(
      (select max(created_at) - interval '30 minutes'
         from admin_actions where action = 'challenge_xp_reconciled'),
      now() - interval '2 hours');
    if _since < _floor then
      _since := _floor;
      _clamped := true;   -- recorded in the heartbeat: points older than this were NOT back-filled
    end if;
  end if;

  if _active then
    -- Defensive config read (D2). Never let a hand-typed value abort the engine.
    begin
      _p_media   := (public.challenge_config()->'points'->>'group_media')::int;
      _cap_media := (public.challenge_config()->'caps'->>'group_media_per_day')::int;
    exception when others then
      _cfg_bad := true; _p_media := null; _cap_media := null;
    end;
    if _p_media is null then _p_media := 5; _cfg_bad := _cfg_bad or true; end if;
    if _cap_media is null then _cap_media := 3; end if;
    -- 0 or negative means "this signal is switched off", not "crash on every insert".
    if _p_media <= 0 or _cap_media <= 0 then _media_off := true; end if;

    if _cfg_bad then
      begin
        insert into public.admin_actions (actor_user_id, action, details)
        values (null, 'challenge_config_invalid',
                jsonb_build_object('config', public.challenge_config(),
                                   'note', 'unparseable points/caps; defaults used', 'at', now()));
      exception when others then null; end;
    end if;

    if not _media_off then
    for _rec in
      with staff as (
        select distinct ur.user_id
        from user_roles ur
        where ur.role in ('teacher'::app_role, 'admin'::app_role, 'superadmin'::app_role)
      ),
      base as (
        -- Driven from webhook_inbox.received_at (indexed), joined to group_message_events by its
        -- UNIQUE (chat, message) key -- now backed by webhook_inbox_chat_msg_idx. The sent_at bound
        -- gives the planner a second usable path; observed received_at - sent_at skew maxes at 132 s,
        -- so a full day of slack cannot drop a real row.
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
          and g.sent_at >= _since - interval '1 day'
          and w.update_type = 'message'
          and g.group_id in (select public.challenge_group_ids())
          and g.group_id = sender.group_id                  -- current-group gate
          and coalesce(g.is_anon_admin, false) = false
          and g.profile_id not in (select user_id from staff)
      ),
      typed as (
        select b.*,
          -- The album this message belongs to, if any. Present on EVERY part and never reused across
          -- chats, so (chat, media_group_id) identifies one share to every run that sees any part of it.
          nullif(b.m->>'media_group_id', '') as mgid,
          case
            -- Own work shared in the group. The homework topic is excluded: homework already has its
            -- own points, and paying twice for one upload would be the easiest farm in the system.
            -- A group with NO homework topic configured earns NO media points rather than paying for
            -- every homework upload -- safe by construction, and surfaced by challenge_health().
            when ( (b.m->'photo') is not null
                   or (b.m->'video') is not null
                   -- "Send as file": the quality-preserving path a design student naturally uses.
                   or (b.m->'document'->>'mime_type') like 'image/%'
                   or (b.m->'document'->>'mime_type') like 'video/%' )
                 and b.homework_topic_id is not null
                 and b.thread_id is distinct from b.homework_topic_id
                 -- Not a relay of someone else's work. A SELF-forward still counts: it is their own
                 -- post moved between topics. Checking both forward fields fails CLOSED if a future
                 -- Bot API drops forward_origin.
                 and not (
                   ( (b.m->'forward_origin') is not null or (b.m->'forward_date') is not null )
                   and coalesce(b.m->'forward_origin'->'sender_user'->>'id', '')
                       is distinct from coalesce(b.m->'from'->>'id', '')
                 )
              then 'media'
          end as kind
        from base b
      ),
      scored as (
        select t.student, t.sent_at, t.day, t.kind, _p_media as amount,
               -- One ref_key per SHARE. An album keys on its media_group_id, so whichever run sees
               -- whichever parts, the first pays and every later run's `not exists` (and the UNIQUE
               -- (user_id, ref_key)) blocks a second. 0.3% of albums straddle a 10-minute tick, and
               -- this is what makes that harmless.
               case when t.mgid is not null
                    then 'ch_alb:' || t.chat_id::text || ':' || t.mgid
                    else 'ch_img:' || t.chat_id::text || ':' || t.msg_id::text
               end as ref_key
        from typed t
        where t.kind is not null
      ),
      deduped as (
        select s.*,
               row_number() over (partition by s.student, s.day, s.ref_key order by s.sent_at) as rn
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
        -- One award row per share, so counting rows counts shares.
        select count(*) into _run_media
        from xp_events x
        where x.user_id = _rec.student
          and x.reason = 'challenge_group_media'
          and (x.created_at at time zone 'Asia/Tashkent')::date = _rec.day;
      end if;

      if _run_media >= _cap_media then
        _cp := _cp + 1;
        continue;
      end if;

      insert into xp_events (user_id, amount, reason, ref_key, created_at)
      values (_rec.student, _rec.amount, 'challenge_group_media', _rec.ref_key, _rec.sent_at)
      on conflict (user_id, ref_key) do nothing;
      if found then
        _run_media := _run_media + 1;
        _aw := _aw + 1;
      end if;
    end loop;
    end if;

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
  -- self-healing lookback above reads. `lookback_clamped` makes a truncated catch-up visible rather
  -- than silent, and `media_off`/`config_invalid` surface a bad hand-edit of the config.
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_xp_reconciled',
            jsonb_build_object('awarded', _aw, 'capped', _cp, 'active', _active, 'since', _since,
                               'lookback_clamped', _clamped, 'config_invalid', _cfg_bad,
                               'media_off', _media_off, 'at', now()));
  exception when others then null; end;

  return query values (_aw, _cp);
end;
$$;
revoke execute on function public.reconcile_challenge_xp(timestamptz) from public, anon, authenticated;

-- ───────────────────────── 4. Deploy self-test (guarded) ─────────────────────────
-- Runs the real function once. It is inert because challenge_active() is false, so the whole award
-- block is skipped -- but that is asserted, not assumed. Recorded, never raised: a failed self-test
-- must not roll back a migration that already applied.
do $selftest$
declare _aw int; _cp int; _n int;
begin
  select r.awarded, r.capped into _aw, _cp from public.reconcile_challenge_xp() r;

  if public.challenge_active() = false and (_aw <> 0 or _cp <> 0) then
    raise exception 'challenge reconciler not inert while disabled: awarded=% capped=%', _aw, _cp;
  end if;

  -- The index must exist, or D1 is still live.
  select count(*) into _n from pg_indexes
   where schemaname = 'public' and indexname = 'webhook_inbox_chat_msg_idx';
  if _n <> 1 then raise exception 'webhook_inbox_chat_msg_idx missing'; end if;

  insert into public.admin_actions (actor_user_id, action, details)
  values (null, 'challenge_reconciler_tuning_selftest',
          jsonb_build_object('awarded', _aw, 'capped', _cp, 'index_ok', _n,
                             'cap', public.challenge_config()->'caps'->>'group_media_per_day',
                             'at', now()));
exception when others then
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_reconciler_tuning_selftest_failed',
            jsonb_build_object('error', sqlerrm, 'at', now()));
  exception when others then null; end;
end $selftest$;
