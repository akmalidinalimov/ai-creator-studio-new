-- Course deactivation + cross-course isolation.
--
-- Requirement: setting courses.published = false ("turn off" a finished cohort)
-- must hide that course's lessons and lock its videos for STUDENTS, WITHOUT
-- removing enrollments or group membership (students stay in the bot). Admins
-- keep full access to manage/preview deactivated courses.
--
-- Gaps closed:
--  1. has_module_access ignored course.published -> videos still played when off.
--  2. lessons RLS gated only the lesson's own published flag, not the parent
--     course -> lessons of a deactivated course stayed visible.
--  3. modules had a blanket "modules read = true" policy -> every module visible
--     regardless of course state.

-- (1) Access gate: a module is only accessible if its course is published.
--     Admin/teacher bypass at the top is preserved (they manage inactive courses).
create or replace function public.has_module_access(_user_id uuid, _module_id uuid)
 returns boolean
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  _course uuid;
  _limit int;
  _enrolled boolean := false;
  _rank int;
begin
  if public.has_role(_user_id,'admin'::app_role)
     or public.has_role(_user_id,'superadmin'::app_role)
     or public.has_role(_user_id,'teacher'::app_role) then
    return true;
  end if;

  select course_id into _course from public.modules where id = _module_id;
  if _course is null then return false; end if;

  -- Course must be active (published). Deactivating a course locks it for students.
  if not exists (select 1 from public.courses c where c.id = _course and c.published) then
    return false;
  end if;

  select true, ct.module_limit into _enrolled, _limit
  from public.enrollments e
  left join public.course_tiers ct on ct.id = e.tier_id
  where e.user_id = _user_id and e.course_id = _course
  limit 1;

  if not coalesce(_enrolled, false) then return false; end if;
  if _limit is null then return true; end if;

  select rnk into _rank from (
    select id, row_number() over (order by position, created_at) as rnk
    from public.modules where course_id = _course
  ) r where r.id = _module_id;

  return coalesce(_rank, 999999) <= _limit;
end;
$function$;

-- (2) lessons: readable only when the lesson AND its parent course are published
--     (or the caller is an admin). Hides a deactivated course's lessons.
drop policy if exists "lessons read" on public.lessons;
create policy "lessons read" on public.lessons
  for select
  using (
    (
      published = true
      and exists (
        select 1 from public.modules m
        join public.courses c on c.id = m.course_id
        where m.id = lessons.module_id and c.published = true
      )
    )
    or public.has_role(auth.uid(), 'admin'::app_role)
  );

drop policy if exists "lessons public read published" on public.lessons;
create policy "lessons public read published" on public.lessons
  for select
  to anon
  using (
    published = true
    and exists (
      select 1 from public.modules m
      join public.courses c on c.id = m.course_id
      where m.id = lessons.module_id and c.published = true
    )
  );

-- (3) modules: drop the blanket read; readable only for a published parent course
--     (admins covered by the existing "modules admin write" ALL policy).
drop policy if exists "modules read" on public.modules;
-- ("modules public read published parent" already enforces c.published = true)
