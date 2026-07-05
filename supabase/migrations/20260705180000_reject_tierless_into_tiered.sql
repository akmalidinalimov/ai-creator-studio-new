-- Safeguard: never allow a tierless (= unlimited) enrollment into a course that
-- sells tiers. The group-force still runs first, so a normal add/move (which
-- goes through a group) gets the group's tier and passes. The only thing this
-- rejects is an enrollment into a tiered course (e.g. AI CREATORS 5.0) with no
-- tier and no group to derive one — exactly the ambiguous "unlimited leak" case.
--
-- Non-tiered courses (the default 4.0, which has no course_tiers rows) are
-- unaffected: a NULL tier there means "full course", which is correct, so
-- handle_new_user's default-course enrollment for every new signup still works.
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

  -- 2) Hard safeguard: a tiered course requires an explicit tier.
  if new.tier_id is null
     and exists (select 1 from public.course_tiers ct where ct.course_id = new.course_id) then
    raise exception
      'tierless enrollment into tiered course % is not allowed — assign the student to a group (or pass a tier)', new.course_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_enrollment_tier_from_group() from public, anon, authenticated;
