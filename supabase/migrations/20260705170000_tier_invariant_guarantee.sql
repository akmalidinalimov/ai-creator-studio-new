-- Tier-separation robustness guarantee.
--
-- Model: a group defines the course AND the tier (Premium=5 modules, VIP=7).
-- A student's access = enrollment.tier_id -> course_tiers.module_limit. The risk
-- is enrollment.tier_id drifting from the group's tier (crossing) — a Premium
-- student ending up unlimited/VIP, or vice versa. Previously this was only kept
-- consistent by the profiles group-change trigger, and only via COALESCE, so a
-- direct enrollment write (CSV import, staff-intake, manual) could still set a
-- wrong or NULL tier. This makes the invariant structural.

-- (1) The group-change sync is now AUTHORITATIVE: moving a student into a group
--     sets their enrollment tier to exactly that group's tier (VIP->VIP,
--     Premium->Premium, tierless->NULL), not "keep old if new is null".
create or replace function public.sync_group_enrollment()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  _course uuid;
  _tier uuid;
begin
  if new.group_id is null then
    return new;
  end if;
  select g.course_id, g.tier_id into _course, _tier
  from public.groups g where g.id = new.group_id;
  if _course is null then
    return new;
  end if;
  insert into public.enrollments (user_id, course_id, tier_id)
  values (new.id, _course, _tier)
  on conflict (user_id, course_id) do update
    set tier_id = excluded.tier_id;  -- group tier is authoritative for its course
  return new;
end;
$$;

-- (2) THE GUARANTEE: any INSERT/UPDATE on enrollments for a student's own group
--     course is forced to the group's tier. No path can cross tiers for the
--     group course; extra (non-group) course enrollments are left untouched.
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
  select g.course_id, g.tier_id into _grp_course, _grp_tier
  from public.profiles p
  join public.groups g on g.id = p.group_id
  where p.id = new.user_id;

  if _grp_course is not null and _grp_course = new.course_id then
    new.tier_id := _grp_tier;
  end if;
  return new;
end;
$$;

revoke execute on function public.enforce_enrollment_tier_from_group() from public, anon, authenticated;

drop trigger if exists trg_enrollments_tier_from_group on public.enrollments;
create trigger trg_enrollments_tier_from_group
  before insert or update on public.enrollments
  for each row
  execute function public.enforce_enrollment_tier_from_group();

-- (3) Backfill: enforce the invariant on all existing rows, and drop stray
--     default-course (4.0) enrollments from any student whose group is a
--     tiered (5.0) course, so paid students are "their course only".
update public.enrollments e
set tier_id = g.tier_id
from public.profiles p
join public.groups g on g.id = p.group_id
where e.user_id = p.id
  and e.course_id = g.course_id
  and e.tier_id is distinct from g.tier_id;

delete from public.enrollments e
using public.profiles p
join public.groups g on g.id = p.group_id
join public.courses gc on gc.id = g.course_id
join public.course_tiers gct on gct.course_id = gc.id  -- group's course is tiered
where e.user_id = p.id
  and e.course_id <> g.course_id
  and exists (select 1 from public.courses dc where dc.id = e.course_id and dc.is_default_for_signup);
