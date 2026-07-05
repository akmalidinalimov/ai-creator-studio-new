-- Security (C1): a plain admin could self-promote to superadmin.
--
-- The "user_roles admin manage" policy was FOR ALL with USING/CHECK =
-- has_role(admin), and enforce_role_exclusivity() returns NEW unchanged for
-- admin/superadmin rows. Because the app writes user_roles with raw client
-- inserts, any admin could run
--     insert into user_roles (user_id, role) values (self, 'superadmin')
-- straight from the browser and bypass every superadmin-only guard.
--
-- Tighten the policy so that writing (or deleting) a 'superadmin' row requires
-- the caller to already BE a superadmin. Admins keep full management of
-- student/teacher/admin rows. Admin SELECT is unaffected (the separate
-- "user_roles select own or admin" policy still grants it).
drop policy if exists "user_roles admin manage" on public.user_roles;

create policy "user_roles admin manage" on public.user_roles
  for all
  using (
    (role <> 'superadmin'::app_role and public.has_role(auth.uid(), 'admin'::app_role))
    or public.has_role(auth.uid(), 'superadmin'::app_role)
  )
  with check (
    (role <> 'superadmin'::app_role and public.has_role(auth.uid(), 'admin'::app_role))
    or public.has_role(auth.uid(), 'superadmin'::app_role)
  );
