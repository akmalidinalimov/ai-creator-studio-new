-- Intake / new-signup wrong-course fix (2026-07-25, owner report: the /intake sales form enrolls
-- students into AI CREATORS 5.0 but they also land in the FINISHED 4.0 course).
--
-- Root cause: the handle_new_user trigger auto-enrolls EVERY new auth user into the
-- is_default_for_signup course — and that flag was still on the finished "AI CREATORS 4.0". So any
-- new-user path (intake, self-signup, admin-create) got a stray 4.0 enrollment on top of the course
-- the form actually assigned. The 2026-07-05 tier-invariant migration cleaned the strays that existed
-- then, but it was a ONE-TIME backfill — new students since kept re-accumulating them. The intake
-- function itself is correct (it enrolls only the chosen course); the bug is the default flag + trigger.
--
-- Fix the class (not the case): heal the current strays, then point the signup default at the ACTIVE
-- (published) course so the auto-enrollment coincides with the assigned course instead of adding 4.0.

-- 1) HEAL: drop stray FINISHED-course enrollments from students whose GROUP is an active (tiered,
--    published) course — the exact, safe set the 2026-07-05 backfill used. Real 4.0 students (4.0
--    group / no group) are untouched. Two safety rails on an irreversible prod DELETE:
--      * only delete the stray if the student ALSO has their real (group-course) enrollment, so no
--        one is ever left with zero enrollments;
--      * capture full row detail (user_id, course_id, tier_id, enrolled_at) into the audit so any
--        row could be restored if the 24-student assumption were ever wrong.
--    Idempotent (only matches strays; a re-run finds none).
do $$
declare _n int; _rows jsonb;
begin
  with del as (
    delete from public.enrollments e
    using public.profiles p, public.groups g
    where e.user_id = p.id
      and g.id = p.group_id
      and e.course_id <> g.course_id
      and exists (select 1 from public.course_tiers ct where ct.course_id = g.course_id)      -- group course is active/tiered
      and exists (select 1 from public.courses fc where fc.id = e.course_id and fc.published = false)  -- stray course is finished
      and exists (select 1 from public.enrollments e2 where e2.user_id = p.id and e2.course_id = g.course_id)  -- has the real one
    returning e.user_id, e.course_id, e.tier_id, e.enrolled_at
  )
  select count(*), coalesce(jsonb_agg(jsonb_build_object(
      'user_id', user_id, 'course_id', course_id, 'tier_id', tier_id, 'enrolled_at', enrolled_at)), '[]'::jsonb)
    into _n, _rows from del;
  begin
    insert into public.admin_actions (actor_user_id, action, details)
    values (null, 'stray_enrollment_heal', jsonb_build_object('removed', _n, 'rows', _rows, 'at', now()));
  exception when others then null;  -- audit best-effort
  end;
end $$;

-- 2) FIX THE CLASS: the signup default must be the ACTIVE (published) course. Unflag every finished
--    course, then promote the newest published course if nothing is flagged. (One published course
--    today = 5.0.) New users now auto-enroll into 5.0, which coincides with the intake's assignment.
update public.courses set is_default_for_signup = false where published = false;
update public.courses set is_default_for_signup = true
 where id = (select id from public.courses where published order by created_at desc limit 1)
   and not exists (select 1 from public.courses where is_default_for_signup);

-- 3) DETECTOR: fire BEFORE the next complaint. A watchdog that DMs admins if a stray finished-course
--    enrollment ever reappears for an active-group student (would mean the default got misconfigured
--    again, or a new course was added without moving the default). Alert-only (no auto-delete — a
--    human confirms), de-duped via app_settings, daily. Independent SQL + pg_net leg. Same "has the
--    real enrollment" guard as the heal, so it never counts a soon-to-be-orphaned row.
create or replace function public.stray_enrollment_count()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(distinct e.user_id)::int
  from enrollments e
  join profiles p on p.id = e.user_id
  join groups g on g.id = p.group_id
  where e.course_id <> g.course_id
    and exists (select 1 from course_tiers ct where ct.course_id = g.course_id)
    and exists (select 1 from courses fc where fc.id = e.course_id and fc.published = false)
    and exists (select 1 from enrollments e2 where e2.user_id = p.id and e2.course_id = g.course_id);
$$;
revoke execute on function public.stray_enrollment_count() from public, anon, authenticated;
grant execute on function public.stray_enrollment_count() to service_role;

create or replace function public.enrollment_watchdog()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  _tok text; _admin record; _stray int;
  _state jsonb; _alerting boolean; _last_ms bigint;
  _now_ms bigint := (extract(epoch from now())*1000)::bigint;
  _should_alert boolean := false; _recovered boolean := false; _msg text;
begin
  _stray := public.stray_enrollment_count();

  select value into _state from app_settings where key = 'enrollment_watchdog_state';
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  _last_ms  := coalesce((_state->>'last_alert_ms')::bigint, 0);

  if _stray > 0 then
    if (not _alerting) or (_now_ms - _last_ms > 86400000) then _should_alert := true; end if;  -- daily re-alert
  elsif _alerting then _recovered := true; end if;

  if _should_alert or _recovered then
    select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
    if _tok is not null and _tok <> '' then
      _msg := case when _recovered then '✅ Stray kurs yozuvlari tozalandi.'
        else '⚠️ ' || _stray || ' ta talaba noto''g''ri (tugagan) kursga yozilgan — is_default_for_signup ni tekshiring.' end;
      for _admin in
        select distinct p.telegram_id from profiles p
        join user_roles r on r.user_id = p.id and r.role in ('admin','superadmin')
        where p.telegram_id is not null limit 3
      loop
        begin
          perform net.http_post(
            url := 'https://api.telegram.org/bot' || _tok || '/sendMessage',
            headers := jsonb_build_object('Content-Type','application/json'),
            body := jsonb_build_object('chat_id', _admin.telegram_id, 'text', _msg));
        exception when others then null;
        end;
      end loop;
    end if;
  end if;

  insert into app_settings (key, value) values ('enrollment_watchdog_state', jsonb_build_object(
    'alerting', (_stray > 0), 'last_alert_ms', case when _should_alert then _now_ms else _last_ms end,
    'stray', _stray, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('stray', _stray, 'alerted', _should_alert, 'recovered', _recovered);
end;
$fn$;
revoke execute on function public.enrollment_watchdog() from public, anon, authenticated;
grant execute on function public.enrollment_watchdog() to service_role;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'enrollment-watchdog') then perform cron.unschedule('enrollment-watchdog'); end if;
  perform cron.schedule('enrollment-watchdog', '30 5 * * *', $cmd$ select public.enrollment_watchdog() $cmd$);
end $$;
