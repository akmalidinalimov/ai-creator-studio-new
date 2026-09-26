-- WORDING: the HTTP-timeout alert names the right cause and the callers; the daily digest reports
-- failed bot sign-in links. Two admin texts, nothing else about either function changes.
--
-- 1. ops_http_failure_watchdog — the timeout line.
--    BEFORE:  • ⏱ Timeouts: 133 in 45m (pg_net congestion?)
--    AFTER:   • ⏱ Slow edge responses (over the wait limit): 133 in 45m — unattributed ×102,
--             notify-hw-submission ×24, broadcast-drainer ×4, canary-15min ×2, cron-engagement-every-30-min ×1
--    (rendered read-only from live data with the window forced to 24h and the threshold to -1; the
--    real line uses the configured 45 min window.)
--    WHY. A read-only investigation on 2026-09-26 (edge logs + ops_http_failures) found these timeouts
--    are slow-but-successful edge responses at the :00/:30 burst, not pg_net congestion: the edge
--    function keeps running and returns 200 after pg_net has stopped waiting. pg_net's error text
--    ("DNS time: 5000 ms") is misleading too — a "DNS time: 30000" row was a call that ran 38 s and
--    returned 200 — so the line never classifies on the DNS/TCP/HTTP split. The old text also named no
--    caller, although ops_http_failures.purpose has been filled for every SQL-originated POST since
--    20260926210000. The new line lists the top 5 purposes in the window ('unattributed' when a failure
--    has no ops_http_calls row, i.e. no purpose; ", +N more" when there are over 5). With #193
--    (ops_net_post waits 30 s by default), a timeout that remains on the default wait is a call that
--    ran past 30 s. The line keeps the message's language (this alert is in English), and everything
--    around it — the count, the >timeout_threshold test, the 3 h cooldown, the 'timeout-burst'
--    signature, the real-fault lines — is byte-identical.
--    NOTE: this line has never fired (0 of the 162 watchdog alerts on record; the busiest hour in the
--    last 3 days had 11 timeouts, the threshold is >20 in 45 min). This fixes what a future burst says.
--
-- 2. ops_daily_digest — one new line in "⚙️ Tizim salomatligi", before "Xatolar jurnali":
--       Kirish havolasi xatolari: 7 allaqachon ishlatilgan · 0 muddati o'tgan · 0 noma'lum
--    (rendered read-only for 26.09.2026). Source: the admin_actions rows magic-link-redeem has written
--    since #164 and that nothing read until now — 2026-09-14..26: 180 magic_link_replay (173 REFUSED: the
--    student saw "This link has already been used"; 7 re-granted inside the 2-min grace, so the
--    student got in and they are not counted), 0 magic_link_expired_open, 4 magic_link_unknown_token
--    (logged at a 10% sample, so shown ×10 with ≈), 0 magic_link_stamp_failed (shown only if non-zero,
--    with ⚠️: a link that could not be marked used stays reusable until it expires).
--    Window: the PREVIOUS Tashkent calendar day, like every other count in that message (its header
--    says "o'tgan kun statistikasi"), not a rolling 24 h.
--    ALWAYS printed, not only when non-zero: refused replays were non-zero on all 13 days since
--    2026-09-14 (2 to 22 a day), so "only if non-zero" would print it almost daily anyway, and its
--    rare absence would read as a missing line rather than a zero. It sits with the other
--    always-printed health lines, so the reader learns its baseline, and shows ✅ when everything is
--    0. It does NOT change the "Umumiy" verdict: a reopened old link is a baseline, not an incident.
--    The line is added with coalesce(_ml_line, '') so a NULL can never blank the whole digest.
--
-- HOW, and why it is safe (the pinned-rewrite pattern of 20260926210000). Each function is edited
-- FROM ITS LIVE DEFINITION (pg_get_functiondef — the repo copies are stale), and only if that text is
-- byte-for-byte the one read on 2026-09-26 (md5 pinned); anything else aborts with "regenerate". Each
-- edit is an exact string replace whose old text must occur exactly once, and the edited text must
-- have the md5 the read-only dry-run produced. After CREATE OR REPLACE (body validation forced on),
-- the stored definition must equal the text executed, and owner, ACL and SECURITY DEFINER must be
-- unchanged (anon/authenticated still cannot execute). The checks read the catalog only — neither
-- function is called, since both send Telegram messages.
--
-- DRY-RUN, read-only against production on 2026-09-26: both md5 pins matched, all 5 edits matched
-- exactly once, the old and new bodies both compile (run as DO blocks whose first statement is
-- RETURN), and both messages were rendered from live data with every send and write cut off. The DO
-- block below was then run read-only with its EXECUTE replaced by CONTINUE: both pins, all 5 edits
-- and both result md5s passed, and it stopped only at the audit INSERT (read-only transaction).
--
-- IDEMPOTENT + REPLAY-SAFE: a function whose definition already has the edited md5 is skipped; the
-- audit row is guarded by NOT EXISTS.

do $mig$
declare
  _sigs constant text[] := array['public.ops_http_failure_watchdog()', 'public.ops_daily_digest()'];
  -- md5(pg_get_functiondef) of the LIVE definitions, read on 2026-09-26. Nothing else may be edited.
  _from constant text[] := array['90feeed55ab80e706e9fb1dcd6f99d40', '8d4184dad2d989b102161448a5a00fa4'];
  -- md5 of the result of the edits below applied to exactly that text (from the read-only dry-run).
  _to   constant text[] := array['b02addb91fb39f49f9451971b790147d', '65e8976bba26776bea35761bd75f82f6'];
  -- Each edit: which function (1-based into _sigs), the exact text it replaces, and its replacement.
  -- Every old text must occur EXACTLY once in the text being edited. CRs are stripped first, so a
  -- CRLF checkout of this file produces the same bytes.
  _efn  constant int[]  := array[1, 1, 2, 2, 2];
  _eold constant text[] := array[
    $o1$E'\n• ⏱ Timeouts: '$o1$,
    $o2$|| 'm (pg_net congestion?)';$o2$,
    $o3$  _msg text;$o3$,
    $o4$  _msg :=$o4$,
    $o5$    '   Xatolar jurnali (o''tgan kun): ' || _errors ||$o5$
  ];
  _enew constant text[] := array[
    $n1$E'\n• ⏱ Slow edge responses (over the wait limit): '$n1$,
    $n2$|| 'm'
                            -- which callers: top 5 purposes in the window ('unattributed' = no ops_http_calls row)
                            || coalesce(' — ' || (
                                 select string_agg(case when t.rn <= 5 then left(t.who, 40) || ' ×' || t.n end, ', ' order by t.rn)
                                        || case when count(*) > 5 then ', +' || (count(*) - 5) || ' more' else '' end
                                   from (select coalesce(purpose, 'unattributed') as who, count(*) as n,
                                                row_number() over (order by count(*) desc, coalesce(purpose, 'unattributed')) as rn
                                           from public.ops_http_failures
                                          where classification = 'timeout' and occurred_at > _now - _window
                                          group by 1) t), '');$n2$,
    $n3$  _msg text;
  _ml_refused int; _ml_expired int; _ml_unknown int; _ml_stamp int; _ml_line text;$n3$,
    $n4$  -- Bot sign-in links (magic links) that FAILED for the student — PREVIOUS CALENDAR DAY, like the
  -- counts above. magic-link-redeem logs each outcome to admin_actions. A reopen inside its 2-minute
  -- grace is re-granted (the student got in), so only refused replays count. Unknown tokens are logged
  -- for 1 in 10 (sampled: 0.1), so that count is scaled x10 and marked ≈.
  select count(*) filter (where action = 'magic_link_replay' and (details->'regranted') is distinct from 'true'::jsonb),
         count(*) filter (where action = 'magic_link_expired_open'),
         count(*) filter (where action = 'magic_link_unknown_token'),
         count(*) filter (where action = 'magic_link_stamp_failed')
    into _ml_refused, _ml_expired, _ml_unknown, _ml_stamp
  from admin_actions
  where action in ('magic_link_replay', 'magic_link_expired_open', 'magic_link_unknown_token', 'magic_link_stamp_failed')
    and created_at >= _day_start and created_at < _day_end;
  _ml_line := '   Kirish havolasi xatolari: ' || _ml_refused || ' allaqachon ishlatilgan · '
    || _ml_expired || ' muddati o''tgan · '
    || (case when _ml_unknown > 0 then '≈' || (_ml_unknown * 10) else '0' end) || ' noma''lum'
    || (case when _ml_stamp > 0 then ' · ⚠️ ' || _ml_stamp || ' ishlatildi deb belgilanmadi' else '' end)
    || (case when _ml_refused + _ml_expired + _ml_unknown + _ml_stamp = 0 then ' ✅' else '' end) || E'\n';

  _msg :=$n4$,
    $n5$    coalesce(_ml_line, '') ||
    '   Xatolar jurnali (o''tgan kun): ' || _errors ||$n5$
  ];
  _fn regprocedure; _def text; _cur text; _needle text; _repl text; _hits int;
  _acl text; _owner oid; _f int; _i int;
begin
  -- The CREATE OR REPLACE below must validate the edited body, whatever the session default is.
  perform set_config('check_function_bodies', 'on', true);

  for _f in 1 .. array_length(_sigs, 1) loop
    _fn := to_regprocedure(_sigs[_f]);
    if _fn is null then
      raise exception 'ABORT: % does not exist', _sigs[_f];
    end if;
    select pg_get_functiondef(p.oid), coalesce(array_to_string(p.proacl, ','), ''), p.proowner
      into _def, _acl, _owner
    from pg_proc p where p.oid = _fn;

    if md5(_def) = _to[_f] then
      continue;                                               -- already applied (replay-safe)
    end if;
    if md5(_def) <> _from[_f] then
      raise exception 'ABORT: % changed since it was verified on 2026-09-26 (md5 %); re-read the live definition and regenerate this migration', _sigs[_f], md5(_def);
    end if;

    _cur := _def;
    for _i in 1 .. array_length(_eold, 1) loop
      continue when _efn[_i] <> _f;
      _needle := replace(_eold[_i], chr(13), '');
      _repl   := replace(_enew[_i], chr(13), '');
      _hits   := (length(_cur) - length(replace(_cur, _needle, ''))) / length(_needle);
      if _hits <> 1 then
        raise exception 'ABORT: edit % must match exactly once in %, but matched % times; re-read the live definition and regenerate this migration', _i, _sigs[_f], _hits;
      end if;
      _cur := replace(_cur, _needle, _repl);
    end loop;
    if md5(_cur) <> _to[_f] then
      raise exception 'ABORT: the edited % is not the text dry-run on 2026-09-26 (md5 %); regenerate this migration', _sigs[_f], md5(_cur);
    end if;

    execute _cur;

    -- Post-conditions, from the catalog only (nothing is called: both functions send Telegram messages).
    if pg_get_functiondef(_fn) is distinct from _cur then
      raise exception 'ABORT: the stored definition of % differs from the one executed', _sigs[_f];
    end if;
    if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
       or (select proowner from pg_proc where oid = _fn) <> _owner
       or not (select prosecdef from pg_proc where oid = _fn) then
      raise exception 'ABORT: owner, ACL or SECURITY DEFINER of % changed', _sigs[_f];
    end if;
    if has_function_privilege('anon', _fn, 'EXECUTE') or has_function_privilege('authenticated', _fn, 'EXECUTE') then
      raise exception 'ABORT: % became executable by anon or authenticated', _sigs[_f];
    end if;
  end loop;

  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'ops_alert_wording_timeouts_magic_links',
         jsonb_build_object('functions', to_jsonb(_sigs),
                            'why', 'timeout alert blamed pg_net congestion and named no caller; magic-link failures reached no admin',
                            'at', now())
  where not exists (select 1 from public.admin_actions where action = 'ops_alert_wording_timeouts_magic_links');
end $mig$;
