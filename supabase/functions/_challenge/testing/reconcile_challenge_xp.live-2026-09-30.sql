CREATE OR REPLACE FUNCTION public.reconcile_challenge_xp(_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(awarded integer, capped integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  _p_media int; _cap_media int;
  _cfg_bad boolean := false; _media_off boolean := false;
  _clamped boolean := false; _floor timestamptz := now() - interval '24 hours';
  _rec record;
  _run_media int := 0;
  _key text := '';
  _aw int := 0; _cp int := 0;
  _active boolean := public.challenge_active();
  -- W1/W2 (20260929193000): the challenge window, parsed once per run below.
  _w_start timestamptz; _w_end timestamptz; _win_bad boolean := false; _tail boolean := false;
begin
  -- TRY-lock, not a blocking lock. A slow run must not make the next tick queue behind it; that is how
  -- a single expensive catch-up turns into a permanent backlog. Skipping is safe because the lookback
  -- overlaps and every award is idempotent.
  -- The skip writes its OWN action. It must NOT write 'challenge_xp_reconciled': that row is what the
  -- lookback reads to compute _since, so counting skips as runs would advance the window past data
  -- nothing ever scanned, and it would also keep challenge_xp_watchdog() quiet while no real scan
  -- completes.
  if not pg_try_advisory_xact_lock(hashtext('reconcile_challenge_xp')) then
    begin
      insert into public.admin_actions (actor_user_id, action, details)
      values (null, 'challenge_xp_reconcile_skipped',
              jsonb_build_object('reason', 'locked', 'active', _active, 'at', now()));
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

  -- W1. THE WINDOW BOUNDS WHAT IS PAID, NOT ONLY WHEN THE JOB RUNS. The gate is evaluated at RUN
  -- time, but the scan reaches back to the last heartbeat minus 30 minutes, and heartbeats are
  -- written while the challenge is off -- so the first active tick would pay media posted up to
  -- 40 minutes BEFORE window.start. Every scanned message is bounded to sent_at within
  -- [window.start, window.end], inclusive at both ends exactly like challenge_active().
  -- Parsed like the D2 fields, each in its own block, so a malformed value cannot crash the run.
  -- A malformed window FAILS CLOSED (nothing is scanned: there is no safe default for when a
  -- challenge starts) and is flagged: config_invalid, plus window_invalid in the heartbeat.
  begin
    _w_start := nullif(public.challenge_config()->'window'->>'start', '')::timestamptz;
  exception when others then _w_start := null; _win_bad := true;
  end;
  begin
    _w_end := nullif(public.challenge_config()->'window'->>'end', '')::timestamptz;
  exception when others then _w_end := null; _win_bad := true;
  end;
  if _win_bad then _cfg_bad := true; end if;

  -- W2. THE FINAL MINUTES. The last active tick runs up to 10 minutes before window.end, and a
  -- post made after it is only ever scanned by a tick that runs after the end, where the gate is
  -- false. For 24 h after the end (the D1 clamp's horizon) a run still scans, and W1 keeps it to
  -- posts sent at or before the end. `active` in the heartbeat stays exactly challenge_active(),
  -- which challenge_xp_watchdog() reads; `tail` marks a post-end run. challenge_active(_w_end)
  -- carries the enabled flag, so the kill-switch still stops a tail run.
  _tail := not _active and not _win_bad and _w_end is not null
           and now() > _w_end and _w_end >= _floor
           and public.challenge_active(_w_end);

  if (_active or _tail) and not _win_bad then
    -- Defensive config read (D2). Each field in its OWN block, so one bad value cannot discard the
    -- other, and an absent key is flagged just like an unparseable one.
    begin
      _p_media := (public.challenge_config()->'points'->>'group_media')::int;
    exception when others then _p_media := null;
    end;
    begin
      _cap_media := (public.challenge_config()->'caps'->>'group_media_per_day')::int;
    exception when others then _cap_media := null;
    end;
    if _p_media is null then _p_media := 5; _cfg_bad := true; end if;
    if _cap_media is null then _cap_media := 3; _cfg_bad := true; end if;
    -- 0 or negative means "this signal is switched off", not "crash on every insert".
    if _p_media <= 0 or _cap_media <= 0 then _media_off := true; end if;

    if _cfg_bad then
      begin
        insert into public.admin_actions (actor_user_id, action, details)
        values (null, 'challenge_config_invalid',
                jsonb_build_object('config', public.challenge_config(),
                                   'note', 'unparseable or absent points/caps; defaults used',
                                   'at', now()));
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
        -- UNIQUE (chat, message) key -- now backed by webhook_inbox_chat_msg_idx, which is what makes
        -- this cheap. The LOOKBACK is deliberately NOT also bounded on g.sent_at: that helped the
        -- planner but was a real filter that could silently drop a row with unusual clock skew (see
        -- review note c). The WINDOW is bounded on g.sent_at (W1): when the student posted is the
        -- rule itself, and sent_at is Telegram's own message date.
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
          -- The scope WITHOUT challenge_group_ids()'s now-based challenge_active() gate, which would
          -- empty it for a W2 tail run; the gate above has already decided whether to scan.
          and g.group_id in (select public.challenge_scope_group_ids())
          and (_w_start is null or g.sent_at >= _w_start)   -- W1: nothing posted before the start
          and (_w_end is null or g.sent_at <= _w_end)       -- W1: nothing posted after the end
          and g.group_id = sender.group_id                  -- current-group gate
          and coalesce(g.is_anon_admin, false) = false
          and g.profile_id not in (select user_id from staff)
      ),
      typed as (
        select b.*,
          -- The album this message belongs to, if any. Present on EVERY part and never reused across
          -- chats, so (chat, media_group_id) identifies one share to every run that sees any part.
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
               -- this is exactly what makes that harmless.
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

  -- Heartbeat on EVERY real tick, including while the challenge is off, and it records which. The
  -- watchdog can then tell "switched off" apart from "the job died" instead of guessing. It is also
  -- what the self-healing lookback above reads -- which is why a lock-skip must NOT write this action.
  -- `lookback_clamped` makes a truncated catch-up visible rather than silent; `media_off` and
  -- `config_invalid` surface a bad hand-edit of the config (`window_invalid` when it is the
  -- window); `tail` marks a W2 run after window.end, when `active` is truthfully false.
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_xp_reconciled',
            jsonb_build_object('awarded', _aw, 'capped', _cp, 'active', _active, 'since', _since,
                               'lookback_clamped', _clamped, 'config_invalid', _cfg_bad,
                               'media_off', _media_off, 'tail', _tail,
                               'window_invalid', _win_bad, 'at', now()));
  exception when others then null; end;

  return query values (_aw, _cp);
end;
$function$
