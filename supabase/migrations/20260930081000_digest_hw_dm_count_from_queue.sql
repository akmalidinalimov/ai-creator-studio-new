-- DIGEST: "Vazifa bildirishnomalari" counts teacher homework DMs that were DELIVERED, read from the
-- queue that every send path closes, instead of an admin_actions action that means something else.
--
-- ═══ THE BUG (verified read-only against production, 2026-09-30) ═══
-- ops_daily_digest() (cron `ops-daily-digest`, '5 5 * * *' = 10:05 Tashkent) prints, under
-- "📨 Yetkazildi" (delivered), the line "Vazifa bildirishnomalari: N", where N was
--     count(admin_actions where action = 'homework_submission_dm_sent') over the previous Tashkent day.
-- That action does not mean "a teacher was sent a DM":
--   * notify-homework-submission (the every-minute drainer, index.ts:165-181) writes it after a
--     successful send. It is the only writer that does.
--   * telegram-bot-webhook notifyTeachersOfSubmission sends the DM IMMEDIATELY outside quiet hours and
--     only stamps the queue row's sent_at (index.ts:6835-6841); it writes no admin_actions row for it.
--     It writes the action only when nothing was sent: details.reason 'no_group' (index.ts:6686),
--     'no_teacher' (6710) or 'enqueue_failed' (6814), each with queued:false.
--   * submit-homework enqueueTeacherDm (Mini App) writes it only with reason 'no_group' (index.ts:114)
--     or 'no_teacher' (index.ts:141), queued:false. Its DMs are sent by the drainer.
--   * hw_dm_fallback_deliver() (the SQL fallback) stamps sent_at with error 'sql_fallback_delivery' and
--     writes no admin_actions row.
-- So N missed every immediate bot send, and would count every no_group / no_teacher / enqueue_failed
-- event as a delivery. Over the 30 Tashkent days 31.08-29.09 the digest counted 81 while the queue
-- delivered 182 (sent_at in the window, error NULL). 101 of the 182 had no admin_actions row, all of
-- them daytime sends; each of the 55 quiet-hours deliveries (the drainer, at 08:00) was logged. None of
-- the 2,776 homework_submission_dm_sent rows ever written carries a reason (today, 30.09 so far: 2 rows,
-- 2 delivered), so the over-count has not happened yet. It would start with the first homework in a
-- group with no teacher: the 4 AI CREATORS CHALLENGE 6.0 groups have no teacher and no members today.
--
-- ═══ THE FIX: one pinned rewrite of ops_daily_digest ═══
-- N := count(homework_teacher_dm_queue) with sent_at in the previous Tashkent day and error NULL (a
-- drainer send, whose markSent() clears error, or an immediate bot send, which stamps a fresh row) or
-- 'sql_fallback_delivery' (the SQL fallback: it hands the send to pg_net and reports it to admins as
-- delivered). A row closed with any other error (tg_<code>_..., gave_up_after_30_retries,
-- notifications_disabled_or_no_telegram, teacher_no_longer_assigned, e2e markers) was not delivered.
-- One queue row is one DM to one teacher, so a co-taught group's submission counts once per teacher.
-- Homework no teacher was told about (the no_group / no_teacher rows, same window) is now shown after
-- the count, only when non-zero:
--     Vazifa bildirishnomalari: 12 · ⚠️ 1 ta vazifa o'qituvchisiz qoldi
-- teacherless_homework_watchdog() (hourly, :13) is what alarms on it, so the "Umumiy" verdict is
-- unchanged. 'enqueue_failed' is left out of that suffix on purpose: the bot may still have sent that
-- DM immediately, and reconcile_teacher_dm_queue() (every 15 minutes, ungraded homework submitted
-- 10 minutes to 48 hours ago) re-creates the missing queue row.
-- Known limit: reconcile_teacher_dm_queue() re-opens a DELIVERED row (sent_at := NULL) when a later
-- attempt of the same submission keeps its message URL; that row counts once, on its last delivery day.
-- Everything else in the function is byte-identical: each edit must match exactly once.
--
-- ═══ CHECKED, NO CHANGE NEEDED ═══
-- Every reader of 'homework_submission_dm_sent' was searched: pg_proc (prosrc and prosqlbody), views,
-- materialized views, cron.job commands, supabase/functions, src/, scripts/ and .github/. Two function
-- bodies read it: ops_daily_digest() (fixed here) and teacherless_homework_health(), which already counts
-- only details->>'reason' in ('no_teacher', 'no_group'). hw_dm_health_stats() does not read it. The
-- admin audit and dashboard pages list raw admin_actions rows with their details and count nothing.
-- The writers keep the action name: teacherless_homework_health() depends on it.
-- The other two counts in the same "Yetkazildi" block were checked against their sources:
-- "Nishonlar yuborildi" counts 'badge_dm_sent', which notify-badge-award writes only when every badge of
-- a batch landed, and it equalled the delivered badge_award_queue rows on each of the 14 days
-- 16.09-29.09; "Baholash eslatmalari" counts 'ungraded_homework_reminder_sent', which
-- cron-ungraded-homework-reminder writes only when at least one reminder was sent.
--
-- ═══ HOW, and why it is safe (the pinned-rewrite pattern) ═══
-- The function is edited FROM ITS LIVE pg_get_functiondef, and only if its live prosrc (CRs stripped) has
-- the md5 read on 2026-09-30. That text is exactly what 20260926234000 installed: its pg_get_functiondef
-- md5 is that migration's result pin 65e8976bba26776bea35761bd75f82f6. Anything else aborts with
-- "regenerate". After CREATE OR REPLACE (body validation on) the stored definition must equal the
-- executed text; owner, ACL and SECURITY DEFINER must be unchanged, and anon/authenticated still unable
-- to execute it.
-- SELF-TEST WITHOUT CALLING IT (the digest DMs admins): the stored body is cut just before it reads the
-- bot token, so the copy contains no send at all (asserted: no ops_net_post, no bot_token, no advisory
-- lock), and it ends by raising the message it built. It runs inside a sub-block, so the implicit
-- savepoint rolls back anything it did. Everything before the cut is reads: hw_dm_health_stats() and
-- badge_dm_health_stats() are STABLE with no DML. The rendered message must contain the exact line
-- computed independently from the queue for the same day, so a wrong column or a broken concatenation
-- fails this deploy instead of silently killing tomorrow's 05:05 UTC digest.
-- DRY-RUN, read-only against production on 2026-09-30: the pin matched, all 3 edits matched exactly
-- once, the static checks passed, and the self-test rendered the 29.09 digest with the line
-- "Vazifa bildirishnomalari: 0" (= the queue for that day), the two health RPCs stubbed because the
-- read-only role cannot execute them (this migration runs them for real). It stopped only where it
-- would have run CREATE OR REPLACE. The edited definition has md5 206a45ccf703cc890d782a2ee60e4abc.
-- A render of 27.09 printed 4 where the old count printed 2; with every admin_actions row of that day
-- forced into the suffix it printed "Vazifa bildirishnomalari: 4 · ⚠️ 2 ta vazifa o'qituvchisiz qoldi".
-- REPLAY-SAFE: the marker "(20260930081000)" in the body means the rewrite is already in place and is
-- skipped; the static checks and the self-test run either way. The audit row is written once.

do $mig$
declare
  _pin    constant text := '5b7bfaf64636bd02e36fde6ad57c67ee';  -- md5(replace(prosrc, CR, '')), live, 2026-09-30
  _marker constant text := '(20260930081000)';

  _old1 constant text := E'  _hw_dm int; _badge_dm int; _reminders int;\n';
  _new1 constant text := E'  _hw_dm int; _badge_dm int; _reminders int;\n  _hw_unrouted int;\n';

  _old2 constant text :=
       E'  select count(*) into _hw_dm from admin_actions where action=''homework_submission_dm_sent'' and created_at >= _day_start and created_at < _day_end;\n';
  _new2 constant text :=
       E'  -- Teacher homework DMs DELIVERED (20260930081000). One homework_teacher_dm_queue row is one DM to\n'
    || E'  -- one teacher, and every send path closes its row: delivered = sent_at in the window and error\n'
    || E'  -- NULL (drainer or immediate bot send) or ''sql_fallback_delivery'' (hw_dm_fallback_deliver). Any\n'
    || E'  -- other error closed the row undelivered. Not admin_actions ''homework_submission_dm_sent'': the\n'
    || E'  -- bot''s immediate send and the SQL fallback write no such row, and both enqueue paths write it,\n'
    || E'  -- with a reason and queued:false, when nothing was sent.\n'
    || E'  select count(*) into _hw_dm from homework_teacher_dm_queue\n'
    || E'   where sent_at >= _day_start and sent_at < _day_end\n'
    || E'     and (error is null or error = ''sql_fallback_delivery'');\n'
    || E'  -- Homework no teacher was told about (student with no group / group with no teacher). Shown after\n'
    || E'  -- the count when non-zero; teacherless_homework_watchdog() is what alarms on it.\n'
    || E'  select count(*) into _hw_unrouted from admin_actions\n'
    || E'   where action = ''homework_submission_dm_sent''\n'
    || E'     and details->>''reason'' in (''no_group'', ''no_teacher'')\n'
    || E'     and created_at >= _day_start and created_at < _day_end;\n';

  _old3 constant text := E'    ''   Vazifa bildirishnomalari: '' || _hw_dm || E''\\n'' ||\n';
  _new3 constant text :=
       E'    ''   Vazifa bildirishnomalari: '' || _hw_dm ||\n'
    || E'      (case when _hw_unrouted > 0 then '' · ⚠️ '' || _hw_unrouted || '' ta vazifa o''''qituvchisiz qoldi'' else '''' end) || E''\\n'' ||\n';

  -- The self-test cuts the body here: everything from this line on is the send.
  _tokline constant text := E'  select value->>''bot_token'' into _tok from platform_settings where key=''telegram'';\n';

  _olds text[];
  _news text[];
  _fn regprocedure;
  _src text; _def text; _new text;
  _acl text; _owner oid; _secdef boolean;
  _n int;
  _body text; _do text; _err text;
  _day_start timestamptz; _day_end timestamptz;
  _exp_dm int; _exp_unrouted int; _exp_line text;
begin
  -- The CREATE OR REPLACE below must validate the edited body, whatever the session default is.
  perform set_config('check_function_bodies', 'on', true);

  _fn := to_regprocedure('public.ops_daily_digest()');
  if _fn is null then
    raise exception 'ABORT: public.ops_daily_digest() does not exist';
  end if;
  select prosrc, coalesce(array_to_string(proacl, ','), ''), proowner, prosecdef
    into _src, _acl, _owner, _secdef
    from pg_proc where oid = _fn;

  if position(_marker in _src) > 0 then
    raise notice 'ops_daily_digest already counts delivered DMs from the queue -- rewrite skipped';
  else
    if md5(replace(_src, E'\r', '')) <> _pin then
      raise exception 'ABORT: ops_daily_digest changed since it was verified on 2026-09-30 (md5 %); re-read the live definition and regenerate this migration',
        md5(replace(_src, E'\r', ''));
    end if;

    _olds := array[_old1, _old2, _old3];
    _news := array[_new1, _new2, _new3];
    _def := pg_get_functiondef(_fn);
    _new := _def;
    for i in 1 .. array_length(_olds, 1) loop
      _n := (length(_new) - length(replace(_new, _olds[i], ''))) / length(_olds[i]);
      if _n <> 1 then
        raise exception 'ABORT: ops_daily_digest edit % matched % times (want exactly 1); regenerate this migration', i, _n;
      end if;
      _new := replace(_new, _olds[i], _news[i]);
    end loop;

    execute _new;

    -- Post-conditions, from the catalog only.
    if pg_get_functiondef(_fn) is distinct from _new then
      raise exception 'ABORT: ops_daily_digest -- the stored definition differs from the one executed';
    end if;
    if (select coalesce(array_to_string(proacl, ','), '') from pg_proc where oid = _fn) <> _acl
       or (select proowner from pg_proc where oid = _fn) <> _owner
       or (select prosecdef from pg_proc where oid = _fn) <> _secdef then
      raise exception 'ABORT: ops_daily_digest -- owner, ACL or SECURITY DEFINER changed';
    end if;
    if has_function_privilege('anon', _fn, 'EXECUTE') or has_function_privilege('authenticated', _fn, 'EXECUTE') then
      raise exception 'ABORT: ops_daily_digest became executable by anon or authenticated';
    end if;
  end if;

  -- Static checks of what now runs.
  select prosrc into _src from pg_proc where oid = _fn;
  if position(E'select count(*) into _hw_dm from homework_teacher_dm_queue\n' in _src) = 0
     or position('into _hw_dm from admin_actions' in _src) > 0
     or position(E'select count(*) into _hw_unrouted from admin_actions\n' in _src) = 0
     or position('(case when _hw_unrouted > 0 then' in _src) = 0 then
    raise exception 'ABORT: ops_daily_digest -- the queue-based count is not in the stored body';
  end if;

  -- Self-test: render the digest from the STORED body, cut before the send (see the header).
  _body := split_part(pg_get_functiondef(_fn), E'AS $function$\n', 2);
  _body := left(_body, position('$function$' in _body) - 1);
  _n := (length(_body) - length(replace(_body, _tokline, ''))) / length(_tokline);
  if _n <> 1 then
    raise exception 'ABORT: self-test -- the bot-token line matched % times in ops_daily_digest (want exactly 1)', _n;
  end if;
  _do := left(_body, position(_tokline in _body) - 1)
      || E'  raise exception ''digest_selftest_render:%'', _msg;\nend;\n';
  if position('ops_net_post' in _do) > 0 or position('net.http' in _do) > 0
     or position('bot_token' in _do) > 0 or position('advisory' in _do) > 0
     or position('$selftest$' in _do) > 0 then
    raise exception 'ABORT: self-test -- the cut copy of ops_daily_digest still contains a send, a lock or the quote tag';
  end if;

  -- The expected line, computed independently for the same day (the previous Tashkent calendar day).
  _day_end := (date_trunc('day', now() at time zone 'Asia/Tashkent')) at time zone 'Asia/Tashkent';
  _day_start := _day_end - interval '1 day';
  select count(*) into _exp_dm from public.homework_teacher_dm_queue
   where sent_at >= _day_start and sent_at < _day_end
     and (error is null or error = 'sql_fallback_delivery');
  select count(*) into _exp_unrouted from public.admin_actions
   where action = 'homework_submission_dm_sent'
     and details->>'reason' in ('no_group', 'no_teacher')
     and created_at >= _day_start and created_at < _day_end;
  _exp_line := '   Vazifa bildirishnomalari: ' || _exp_dm
            || case when _exp_unrouted > 0 then ' · ⚠️ ' || _exp_unrouted || ' ta vazifa o''qituvchisiz qoldi' else '' end
            || E'\n';

  begin
    execute 'do $selftest$' || _do || '$selftest$';
    _err := 'the cut copy returned without raising its message';
  exception when others then
    _err := sqlerrm;   -- the sub-block's savepoint has rolled back whatever the copy did
  end;
  if _err not like 'digest_selftest_render:%' then
    raise exception 'ABORT: self-test -- the rewritten ops_daily_digest does not run: %', _err;
  end if;
  if position(_exp_line in _err) = 0 then
    raise exception 'ABORT: self-test -- expected line [%] not in the rendered digest: %', _exp_line, _err;
  end if;

  insert into public.admin_actions (actor_user_id, action, details)
  select null, 'ops_digest_hw_dm_count_from_queue',
         jsonb_build_object('function', 'public.ops_daily_digest()',
                            'why', 'the homework-DM count read an admin_actions action that the bot''s immediate send never writes and that the enqueue paths also write when nothing was sent',
                            'at', now())
  where not exists (select 1 from public.admin_actions where action = 'ops_digest_hw_dm_count_from_queue');
end $mig$;
