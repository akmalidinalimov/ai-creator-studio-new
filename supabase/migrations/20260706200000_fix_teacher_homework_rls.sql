-- FIX: teachers couldn't see/grade their students' submissions via the web.
--
-- The "hws own select/update" policies scoped teachers via
--   EXISTS (profiles p JOIN groups g ...) — but that subquery runs under the
-- CALLER's RLS, and groups is admin-only readable, so the teacher branch never
-- matched (same failure class as the 20260706160000 modules fix). The bot
-- worked (service role bypasses RLS), masking the web breakage.
--
-- Fix: a SECURITY DEFINER helper for the relationship check, used in the
-- policies — robust regardless of profiles/groups visibility.

create or replace function public.is_teacher_of(_student uuid, _teacher uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from profiles p join groups g on g.id = p.group_id
    where p.id = _student and g.teacher_id = _teacher
  )
$$;
revoke execute on function public.is_teacher_of(uuid, uuid) from public, anon;
grant execute on function public.is_teacher_of(uuid, uuid) to authenticated;

drop policy if exists "hws own select" on public.homework_submissions;
create policy "hws own select" on public.homework_submissions for select
  using (
    auth.uid() = user_id
    or has_role(auth.uid(), 'admin'::app_role)
    or (has_role(auth.uid(), 'teacher'::app_role) and public.is_teacher_of(user_id, auth.uid()))
  );

drop policy if exists "hws own update" on public.homework_submissions;
create policy "hws own update" on public.homework_submissions for update
  using (
    (auth.uid() = user_id and score is null)
    or has_role(auth.uid(), 'admin'::app_role)
    or (has_role(auth.uid(), 'teacher'::app_role) and public.is_teacher_of(user_id, auth.uid()))
  );
