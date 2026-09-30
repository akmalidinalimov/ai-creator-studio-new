-- Challenge: points are paid only for posts made INSIDE the challenge window.
--
-- ═══ THE BUG (verified read-only against production, 2026-09-29) ═══
-- reconcile_challenge_xp() runs every 10 minutes (cron job `challenge-xp-reconcile`, */10). It gates on
-- challenge_active() evaluated at RUN time, then scans webhook_inbox rows with
--     received_at >= _since,   _since = (last 'challenge_xp_reconciled' heartbeat) - 30 minutes
-- and the heartbeat is written on EVERY tick, including while the challenge is off (all 1,224 heartbeats
-- since the first on 2026-09-21 are active=false, never more than 601 s apart, zero lock-skips). Nothing
-- bounded the scanned messages by the window itself.
--
-- platform_settings.challenge: enabled=true, window.start = 2026-10-01T00:00:00+05:00
-- (= 2026-09-30 19:00 UTC), window.end = null. So the first active tick, 2026-09-30 19:00 UTC, would scan
-- from the 18:50 heartbeat minus 30 minutes = 18:20 UTC and pay media posted 23:20-24:00 Tashkent on
-- 09-30 -- up to 40 minutes BEFORE the challenge starts, dated (xp_events.created_at = sent_at) on 09-30.
-- 20260928100713's header says "the reconciler never looks back more than 24 h, so nothing pre-start is
-- paid". That sentence is wrong: the 24 h clamp bounds how far a lookback can reach, not where the window
-- begins, and on a healthy tick the whole 40-minute lookback of the first active run is pre-start.
--
-- The mirror image at a future window.end: the last active tick runs up to 10 minutes before the end, and
-- a post made after it is only ever scanned by a tick that runs after the end -- where the gate is false.
-- The deadline rush would never be paid.
--
-- ═══ THE FIX: one pinned rewrite of reconcile_challenge_xp ═══
-- W1  window.start / window.end are parsed ONCE per run into variables, each in its own guarded block
--     like the D2 config fields, and every scanned message is bounded to g.sent_at within
--     [start, end] -- inclusive at both ends, exactly as challenge_active() compares. A malformed value
--     does not crash the run: it FAILS CLOSED (nothing is scanned -- there is no safe default for when a
--     challenge starts) and sets the heartbeat's config_invalid like a bad D2 field, plus a new
--     window_invalid. (The challenge_config_invalid audit row stays D2's: only a run that scans writes
--     it.) challenge_active() already reads a malformed window as "off"; the heartbeat makes it visible.
--     Bounding on sent_at is safe: sent_at is Telegram's own message date (telegram-bot-webhook:
--     `sent_at: msg.date ? new Date(msg.date * 1000)…`), and received_at - sent_at over 60 days /
--     22,475 group messages was min 0.17 s, p50 0.9 s, p99 4.6 s, max 147 s -- never negative. The
--     lookback stays bounded on received_at only (review note c of 20260925071000 still holds).
--     EXPLAIN (prod, read-only, scope inlined as its group list): the scan still drives from
--     webhook_inbox_received_at_idx; the sent_at bound is a filter on the (chat, message) unique-key
--     probe, like the other g.* predicates.
-- W2  For 24 h after window.end (the same horizon as the D1 lookback clamp) a run still scans, and W1
--     keeps it to posts sent at or before the end, so the final minutes are paid. The tail requires
--     challenge_active(window.end) -- i.e. enabled=true and a non-empty window -- so the kill-switch
--     still stops it. The heartbeat's `active` stays exactly challenge_active(): challenge_xp_watchdog()
--     reads it (min created_at where active='true') and returns early whenever challenge_active() is
--     false, so a tail run can neither start its 8-day clock nor make it fire. A new `tail` field marks a
--     post-end run, so "active=false, awarded=3" is explained instead of looking like a bug.
--     The scan reads the scope from challenge_scope_group_ids() instead of challenge_group_ids(). The
--     live definitions differ ONLY in challenge_group_ids()'s `where public.challenge_active()`, which is
--     now-based and would empty the scope for a tail run; whenever the challenge is active the two sets
--     are identical.
-- Everything else in the function is byte-identical: each edit is asserted to match exactly once.
--
-- ═══ CHECKED, NO CHANGE NEEDED ═══
-- * Only reconcile_challenge_xp writes challenge_* xp reasons (every function's prosrc, supabase/functions
--   and src searched). Cron calls it with no argument; an admin back-fill with an explicit _since is now
--   window-bounded too, which is the correct semantics.
-- * freeze_challenge_week / user_group_rating_xp_since / challenge_team_board read xp_events.created_at
--   within a Monday-to-Monday week. A challenge media row is inserted with created_at = sent_at, which W1
--   now keeps inside the window, so they need no change for this.
--   A SIBLING, NOT FIXED HERE: for a partial first/last week they count ALL rating XP of the whole
--   Mon-Mon week, including non-challenge XP (lessons, homework) earned before window.start or after
--   window.end. Zero students are affected today (6.0 has no enrollments and its four groups no members
--   yet); it is a leaderboard-semantics decision for a follow-up.
-- * To END the challenge with its final minutes paid, set window.end. Setting enabled=false is the
--   kill-switch: every leg stops at once -- the W2 tail, and also the final week's freeze and team
--   board, which gate on challenge_active(<that week>) and so on the same flag.
--
-- ═══ HISTORY ═══
-- Zero challenge xp_events have ever been written and no heartbeat has ever been active=true, so there is
-- nothing to heal today. Section 2 still removes any challenge_group_media row dated before window.start,
-- so the fix is complete even if this lands after the first active tick (it deletes 0 rows before then).
--
-- Pinned-rewrite pattern: start from the LIVE pg_get_functiondef, require the body md5 verified today,
-- apply asserted replace()s, EXECUTE, then assert the stored definition equals what was executed and
-- owner / ACL / SECURITY DEFINER are unchanged. A replay (already rewritten) is detected by marker and
-- skipped. The reconciler is NOT called here: it awards real XP once the challenge is live.
-- Kill-switch (unchanged): platform_settings.challenge.enabled = false.

-- ─────────────── 1. reconcile_challenge_xp: bound the scan to the window ───────────────
do $$
declare
  _pin constant text := '156153ca36bb425b379b3110c1eebb47';   -- live body md5, 2026-09-29

  _old1 constant text := E'  _active boolean := public.challenge_active();\nbegin\n';
  _new1 constant text :=
       E'  _active boolean := public.challenge_active();\n'
    || E'  -- W1/W2 (20260929193000): the challenge window, parsed once per run below.\n'
    || E'  _w_start timestamptz; _w_end timestamptz; _win_bad boolean := false; _tail boolean := false;\n'
    || E'begin\n';

  _old2 constant text := E'  if _active then\n    -- Defensive config read (D2).';
  _new2 constant text :=
       E'  -- W1. THE WINDOW BOUNDS WHAT IS PAID, NOT ONLY WHEN THE JOB RUNS. The gate is evaluated at RUN\n'
    || E'  -- time, but the scan reaches back to the last heartbeat minus 30 minutes, and heartbeats are\n'
    || E'  -- written while the challenge is off -- so the first active tick would pay media posted up to\n'
    || E'  -- 40 minutes BEFORE window.start. Every scanned message is bounded to sent_at within\n'
    || E'  -- [window.start, window.end], inclusive at both ends exactly like challenge_active().\n'
    || E'  -- Parsed like the D2 fields, each in its own block, so a malformed value cannot crash the run.\n'
    || E'  -- A malformed window FAILS CLOSED (nothing is scanned: there is no safe default for when a\n'
    || E'  -- challenge starts) and is flagged: config_invalid, plus window_invalid in the heartbeat.\n'
    || E'  begin\n'
    || E'    _w_start := nullif(public.challenge_config()->''window''->>''start'', '''')::timestamptz;\n'
    || E'  exception when others then _w_start := null; _win_bad := true;\n'
    || E'  end;\n'
    || E'  begin\n'
    || E'    _w_end := nullif(public.challenge_config()->''window''->>''end'', '''')::timestamptz;\n'
    || E'  exception when others then _w_end := null; _win_bad := true;\n'
    || E'  end;\n'
    || E'  if _win_bad then _cfg_bad := true; end if;\n'
    || E'\n'
    || E'  -- W2. THE FINAL MINUTES. The last active tick runs up to 10 minutes before window.end, and a\n'
    || E'  -- post made after it is only ever scanned by a tick that runs after the end, where the gate is\n'
    || E'  -- false. For 24 h after the end (the D1 clamp''s horizon) a run still scans, and W1 keeps it to\n'
    || E'  -- posts sent at or before the end. `active` in the heartbeat stays exactly challenge_active(),\n'
    || E'  -- which challenge_xp_watchdog() reads; `tail` marks a post-end run. challenge_active(_w_end)\n'
    || E'  -- carries the enabled flag, so the kill-switch still stops a tail run.\n'
    || E'  _tail := not _active and not _win_bad and _w_end is not null\n'
    || E'           and now() > _w_end and _w_end >= _floor\n'
    || E'           and public.challenge_active(_w_end);\n'
    || E'\n'
    || E'  if (_active or _tail) and not _win_bad then\n'
    || E'    -- Defensive config read (D2).';

  _old3 constant text :=
       E'        -- this cheap. Deliberately NOT also bounded on g.sent_at: that helped the planner but was a\n'
    || E'        -- real filter that could silently drop a row with unusual clock skew (see review note c).\n';
  _new3 constant text :=
       E'        -- this cheap. The LOOKBACK is deliberately NOT also bounded on g.sent_at: that helped the\n'
    || E'        -- planner but was a real filter that could silently drop a row with unusual clock skew (see\n'
    || E'        -- review note c). The WINDOW is bounded on g.sent_at (W1): when the student posted is the\n'
    || E'        -- rule itself, and sent_at is Telegram''s own message date.\n';

  _old4 constant text := E'          and g.group_id in (select public.challenge_group_ids())\n';
  _new4 constant text :=
       E'          -- The scope WITHOUT challenge_group_ids()''s now-based challenge_active() gate, which would\n'
    || E'          -- empty it for a W2 tail run; the gate above has already decided whether to scan.\n'
    || E'          and g.group_id in (select public.challenge_scope_group_ids())\n'
    || E'          and (_w_start is null or g.sent_at >= _w_start)   -- W1: nothing posted before the start\n'
    || E'          and (_w_end is null or g.sent_at <= _w_end)       -- W1: nothing posted after the end\n';

  _old5 constant text := E'  -- `config_invalid` surface a bad hand-edit of the config.\n';
  _new5 constant text :=
       E'  -- `config_invalid` surface a bad hand-edit of the config (`window_invalid` when it is the\n'
    || E'  -- window); `tail` marks a W2 run after window.end, when `active` is truthfully false.\n';

  _old6 constant text := E'                               ''media_off'', _media_off, ''at'', now()));\n';
  _new6 constant text :=
       E'                               ''media_off'', _media_off, ''tail'', _tail,\n'
    || E'                               ''window_invalid'', _win_bad, ''at'', now()));\n';

  _olds text[];
  _news text[];
  _fn oid;
  _src text; _def text; _new text;
  _acl text; _owner oid; _secdef boolean;
  _n int;
begin
  _olds := array[_old1, _old2, _old3, _old4, _old5, _old6];
  _news := array[_new1, _new2, _new3, _new4, _new5, _new6];

  select p.oid into _fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'reconcile_challenge_xp';
  if _fn is null then
    raise exception 'ABORT: public.reconcile_challenge_xp not found (or overloaded)';
  end if;
  select prosrc, coalesce(array_to_string(proacl, ','), ''), proowner, prosecdef
    into _src, _acl, _owner, _secdef
    from pg_proc where oid = _fn;

  -- Replay: the marker only exists after this rewrite.
  if position('_w_start timestamptz' in _src) > 0 then
    raise notice 'reconcile_challenge_xp already window-bounded -- skipped';
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

  -- Static checks of what now runs (the function itself is never called here).
  select prosrc into _src from pg_proc where oid = _fn;
  if position('(_w_start is null or g.sent_at >= _w_start)' in _src) = 0
     or position('(_w_end is null or g.sent_at <= _w_end)' in _src) = 0
     or position('if (_active or _tail) and not _win_bad then' in _src) = 0
     or position('select public.challenge_scope_group_ids()' in _src) = 0
     or position('select public.challenge_group_ids()' in _src) > 0 then
    raise exception 'ABORT: reconcile_challenge_xp -- window bound not in the stored body';
  end if;
  -- The (SECURITY DEFINER, postgres-owned) reconciler must be able to call its new scope source.
  if not has_function_privilege((select proowner from pg_proc where oid = _fn),
                                'public.challenge_scope_group_ids()', 'EXECUTE') then
    raise exception 'ABORT: reconcile_challenge_xp owner cannot EXECUTE challenge_scope_group_ids()';
  end if;
end $$;

-- ─────────────── 2. History: remove any challenge media points dated before the start ───────────────
-- A no-op unless this lands after the first active tick (2026-09-30 19:00 UTC). created_at is the post's
-- sent_at, so `created_at < window.start` is exactly "posted before the challenge began". Totals are
-- rebuilt for the affected students the same way admin_void_challenge_points() does it.
do $$
declare
  _start timestamptz;
  _users uuid[] := '{}';
  _removed int := 0;
begin
  begin
    _start := nullif(public.challenge_config()->'window'->>'start', '')::timestamptz;
  exception when others then
    _start := null;
    raise notice 'challenge window.start unparseable -- history heal skipped';
  end;

  if _start is not null then
    with gone as (
      delete from public.xp_events
       where reason = 'challenge_group_media'
         and created_at < _start
      returning user_id
    )
    select coalesce(array_agg(distinct user_id), '{}'), count(*) into _users, _removed from gone;

    if _removed > 0 then
      insert into public.user_xp (user_id, total_xp, level, updated_at)
      select u.id,
             coalesce((select sum(e.amount) from public.xp_events e where e.user_id = u.id), 0)::int,
             public.xp_level_for(coalesce((select sum(e.amount) from public.xp_events e where e.user_id = u.id), 0)::int),
             now()
      from unnest(_users) as u(id)
      on conflict (user_id) do update
        set total_xp = excluded.total_xp, level = excluded.level, updated_at = now();
    end if;
  end if;

  -- Audit once, even if a racing deploy replays this file.
  if not exists (select 1 from public.admin_actions where action = 'challenge_window_bound_applied') then
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'challenge_window_bound_applied', jsonb_build_object(
      'window_start', _start,
      'pre_start_points_removed', _removed,
      'students_rebuilt', coalesce(array_length(_users, 1), 0),
      'weekly_rows_existing', (select count(*) from public.challenge_weekly_results),
      'reconciler_body_md5', (select md5(replace(prosrc, E'\r', '')) from pg_proc
                               where oid = 'public.reconcile_challenge_xp(timestamptz)'::regprocedure),
      'at', now()));
  end if;
end $$;
