-- cron-engagement no longer sends the daily "continue learning?" reminder to a student who has watched every lesson
-- their tier opens (2026-10-11: 83 such students got a ⚡ Continue button that opened a course page with no video).
-- It logs notifications_log 'daily_reminder_caught_up' for each one instead. watch_button_health's coverage leg
-- ("a group with inactive students and NO reminder in 48 h") must count that row as reached — otherwise a group whose
-- inactive students are all caught up (and have no streak to warn about) becomes a false coverage_gap alarm.
--
-- One token added to one IN-list, rewritten from the LIVE definition and pinned to its verified md5 (CLAUDE.md:
-- start from pg_get_functiondef, pin the exact text). A different live body → nothing changes, a notice says so.
do $mig$
declare
  _def text := pg_get_functiondef('public.watch_button_health()'::regprocedure);
  _old constant text := $x$('daily_reminder', 'streak_warning', 'inactive_3', 'inactive_7', 'inactive_14', 'inactive_30')$x$;
  _new constant text := $x$('daily_reminder', 'daily_reminder_caught_up', 'streak_warning', 'inactive_3', 'inactive_7', 'inactive_14', 'inactive_30')$x$;
begin
  if position(_new in _def) > 0 then
    raise notice 'watch_button_health already counts daily_reminder_caught_up';
    return;
  end if;
  if md5(_def) <> '81774bef2773025dc175138270483f18' then
    raise notice 'watch_button_health differs from the verified body (md5 %) — left unchanged', md5(_def);
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'migration_pin_mismatch', jsonb_build_object('migration', '20261011160500', 'function', 'watch_button_health',
            'md5', md5(_def)));
    return;
  end if;
  if (length(_def) - length(replace(_def, _old, ''))) / length(_old) <> 1 then
    raise exception 'watch_button_health: expected the reminder IN-list exactly once';
  end if;
  execute replace(_def, _old, _new);
end
$mig$;
