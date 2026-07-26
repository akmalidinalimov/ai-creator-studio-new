-- HOTFIX (2026-07-26): "Database error creating new user" on the intake/signup path.
--
-- Regression from 20260725120000 (which pointed is_default_for_signup at 5.0 to fix the intake→4.0
-- bug). handle_new_user auto-enrolls every new user into the default course TIERLESS. 5.0 is a TIERED
-- course, and enforce_enrollment_tier_from_group hard-rejects a *student* being enrolled tierless into
-- a tiered course → the whole createUser transaction aborts → "Database error creating new user".
-- This blocked ALL new-student creation (intake, self-signup, admin) since that deploy.
--
-- Root fix: only auto-enroll into an UNTIERED default. A tiered course requires a tier, which a
-- brand-new user doesn't have yet (no group) — those are enrolled a moment later via group assignment
-- (sync_group_enrollment), WITH the group's tier. So the tiered-default auto-enroll was redundant AND
-- fatal. No history to heal: the failed creations aborted fully (transactional), leaving no orphans;
-- students that couldn't be added simply need re-adding now that the path works.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  default_course uuid;
begin
  insert into public.profiles (id, email, name, last_name, avatar_url)
  values (
    new.id, new.email,
    coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
    nullif(new.raw_user_meta_data->>'last_name', ''),
    new.raw_user_meta_data->>'avatar_url'
  ) on conflict (id) do nothing;

  insert into public.user_roles (user_id, role) values (new.id, 'student') on conflict do nothing;
  insert into public.streaks (user_id) values (new.id) on conflict do nothing;

  -- Auto-enroll into the signup default ONLY when it is an UNTIERED course. A tiered default (e.g.
  -- 5.0) is skipped here — a tierless student enrollment into it would be rejected by
  -- enforce_enrollment_tier_from_group and abort user creation. Tiered courses are enrolled via the
  -- group assignment (sync_group_enrollment), which supplies the group's tier.
  select c.id into default_course
  from public.courses c
  where c.is_default_for_signup
    and not exists (select 1 from public.course_tiers ct where ct.course_id = c.id)
  limit 1;

  if default_course is not null then
    insert into public.enrollments (user_id, course_id)
    values (new.id, default_course)
    on conflict do nothing;
  end if;

  return new;
end;
$$;

-- DETECTOR: extend the enrollment watchdog to also alert if a TIERED course is flagged
-- is_default_for_signup — the exact misconfiguration that broke signup here. This would have caught
-- 20260725120000 the same day. Alert-only, de-duped via app_settings, daily (existing cron).
create or replace function public.enrollment_watchdog()
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  _tok text; _admin record; _stray int; _bad_default int;
  _state jsonb; _alerting boolean; _last_ms bigint;
  _now_ms bigint := (extract(epoch from now())*1000)::bigint;
  _should_alert boolean := false; _recovered boolean := false; _bad boolean; _msg text;
begin
  _stray := public.stray_enrollment_count();
  -- A tiered course as the signup default breaks new-student creation (tierless enrollment rejected).
  select count(*) into _bad_default from public.courses c
   where c.is_default_for_signup
     and exists (select 1 from public.course_tiers ct where ct.course_id = c.id);
  _bad := (_stray > 0 or _bad_default > 0);

  select value into _state from app_settings where key = 'enrollment_watchdog_state';
  _alerting := coalesce((_state->>'alerting')::boolean, false);
  _last_ms  := coalesce((_state->>'last_alert_ms')::bigint, 0);

  if _bad then
    if (not _alerting) or (_now_ms - _last_ms > 86400000) then _should_alert := true; end if;
  elsif _alerting then _recovered := true; end if;

  if _should_alert or _recovered then
    select value->>'bot_token' into _tok from platform_settings where key = 'telegram';
    if _tok is not null and _tok <> '' then
      _msg := case
        when _recovered then '✅ Yozuvlar/signup default holati normallashdi.'
        when _bad_default > 0 then '🚨 KRITIK: signup default kursi TARIFLI — yangi talaba yaratish ISHLAMAYDI! is_default_for_signup ni tarifsiz kursga o''tkazing yoki olib tashlang.'
        else '⚠️ ' || _stray || ' ta talaba noto''g''ri (tugagan) kursga yozilgan — is_default_for_signup ni tekshiring.'
      end;
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
    'alerting', _bad, 'last_alert_ms', case when _should_alert then _now_ms else _last_ms end,
    'stray', _stray, 'bad_default', _bad_default, 'checked_at', now()))
  on conflict (key) do update set value = excluded.value;

  return jsonb_build_object('stray', _stray, 'bad_default', _bad_default, 'alerted', _should_alert, 'recovered', _recovered);
end;
$fn$;
revoke execute on function public.enrollment_watchdog() from public, anon, authenticated;
grant execute on function public.enrollment_watchdog() to service_role;
