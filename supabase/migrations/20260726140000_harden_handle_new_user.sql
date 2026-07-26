-- Hardening (2026-07-26, follow-up to #44): isolate handle_new_user's side-effect inserts so a fault
-- in ANY one of them can never again abort account creation platform-wide. That was the exact failure
-- mode behind the ~24h signup outage: the enrollment guard raised inside the createUser transaction
-- and took down ALL signups. Each insert now runs in its own exception block (implicit savepoint —
-- a failed insert rolls back to the savepoint and we continue). If any step is swallowed, ONE row is
-- written to platform_error_log so the daily digest + anomaly watchdog see it within the hour: a
-- degraded account (missing a role/streak/enrollment) is recoverable and reconcilable; a hard signup
-- outage is not. Preserves the untiered-only default-enrollment fix from #44 (tiered courses enroll
-- via group assignment, which supplies the tier).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  default_course uuid;
  _fail text := '';
begin
  begin
    insert into public.profiles (id, email, name, last_name, avatar_url)
    values (
      new.id, new.email,
      coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
      nullif(new.raw_user_meta_data->>'last_name', ''),
      new.raw_user_meta_data->>'avatar_url'
    ) on conflict (id) do nothing;
  exception when others then _fail := _fail || 'profiles;';
  end;

  begin
    insert into public.user_roles (user_id, role) values (new.id, 'student') on conflict do nothing;
  exception when others then _fail := _fail || 'user_roles;';
  end;

  begin
    insert into public.streaks (user_id) values (new.id) on conflict do nothing;
  exception when others then _fail := _fail || 'streaks;';
  end;

  -- Auto-enroll ONLY into an UNTIERED default (see #44: a tierless student enrollment into a tiered
  -- course is rejected by enforce_enrollment_tier_from_group; tiered courses enroll via the group).
  begin
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
  exception when others then _fail := _fail || 'enrollment;';
  end;

  -- Any swallowed side-effect failure becomes a DB-visible signal (never blocks account creation).
  if _fail <> '' then
    begin
      insert into public.platform_error_log (source, action, message, user_id, context)
      values ('handle_new_user', 'signup_side_effect_failed', _fail, new.id,
              jsonb_build_object('email', new.email));
    exception when others then null;  -- the signal itself is best-effort; must never abort the signup
    end;
  end if;

  return new;
end;
$$;
