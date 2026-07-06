-- Teachers/admins are tier-exempt (owner rule: "teachers don't have a tier
-- dependency"). The tierless-into-tiered safeguard was unconditional, so
-- assigning a teacher to the tiered 5.0 course in the admin UI failed —
-- the checkbox appeared un-selectable. Students remain strictly guarded.

create or replace function public.enforce_enrollment_tier_from_group()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  _grp_course uuid;
  _grp_tier uuid;
begin
  -- 1) The student's own group course is dictated by the group's tier.
  select g.course_id, g.tier_id into _grp_course, _grp_tier
  from public.profiles p
  join public.groups g on g.id = p.group_id
  where p.id = new.user_id;

  if _grp_course is not null and _grp_course = new.course_id then
    new.tier_id := _grp_tier;
  end if;

  -- 2) Hard safeguard: a tiered course requires an explicit tier — for
  --    STUDENTS. Staff (teacher/admin/superadmin) enroll tierless: their
  --    access is role-based (has_module_access bypass), tiers don't apply.
  if new.tier_id is null
     and exists (select 1 from public.course_tiers ct where ct.course_id = new.course_id)
     and not (
       public.has_role(new.user_id, 'teacher'::app_role)
       or public.has_role(new.user_id, 'admin'::app_role)
       or public.has_role(new.user_id, 'superadmin'::app_role)
     ) then
    raise exception
      'tierless enrollment into tiered course % is not allowed — assign the student to a group (or pass a tier)', new.course_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_enrollment_tier_from_group() from public, anon, authenticated;
