-- Fix: placing a student into a group did NOT enroll them in the group's course.
--
-- Root cause of the 2026-07-05 "Bu dars sizning tarifingizda mavjud emas" bug:
-- content scoping (bot + web) resolves the student's course via
-- profiles.group_id -> groups.course_id, but access control
-- (has_module_access) checks the enrollments table. Students added to
-- "1-GURUH VIP 5.0" kept only their signup-default 4.0 enrollment, so every
-- 5.0 lesson the bot linked them to was denied.
--
-- This trigger keeps the two models consistent at the source: whenever
-- profiles.group_id is set (insert or update), upsert an enrollment in the
-- group's course carrying the group's tier. Additive only — it never deletes
-- other enrollments (removals stay a deliberate admin action).
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
    -- moving into a tiered group grants that tier; a tierless group keeps
    -- whatever tier the enrollment already had
    set tier_id = coalesce(excluded.tier_id, public.enrollments.tier_id);

  return new;
end;
$$;

revoke execute on function public.sync_group_enrollment() from public, anon, authenticated;

drop trigger if exists trg_profiles_sync_group_enrollment on public.profiles;
create trigger trg_profiles_sync_group_enrollment
  after insert or update of group_id on public.profiles
  for each row
  when (new.group_id is not null)
  execute function public.sync_group_enrollment();
