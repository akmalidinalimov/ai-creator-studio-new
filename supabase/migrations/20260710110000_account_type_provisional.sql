-- Provisional (trial) account type (2026-07-10).
-- Two account types: 'paid' (full access) and 'provisional' (trial). A provisional user gets
-- homework submission, XP/points, profile and statistics — but NO lessons (web + bot). When they
-- pay, an admin flips them to 'paid' and lessons unlock instantly, with all history intact.
--
-- CRITICAL SAFETY: DEFAULT 'paid' + NOT NULL means every EXISTING user is set to 'paid' by this
-- ALTER — no current student loses lesson access. Only accounts explicitly set to 'provisional'
-- (auto-onboarded posters, or flipped by an admin) are gated.

alter table public.profiles
  add column if not exists account_type text not null default 'paid';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_account_type_chk') then
    alter table public.profiles
      add constraint profiles_account_type_chk check (account_type in ('provisional', 'paid'));
  end if;
end $$;

create index if not exists idx_profiles_account_type on public.profiles (account_type);

-- Admin-only setter (audited). Toggling access is privileged, so route it through a guarded RPC
-- rather than a raw client update. Flipping to 'paid' is what unlocks lessons after payment.
create or replace function public.admin_set_account_type(_user uuid, _type text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (public.has_role(auth.uid(), 'admin'::app_role) or public.has_role(auth.uid(), 'superadmin'::app_role)) then
    raise exception 'admin only';
  end if;
  if _type not in ('provisional', 'paid') then
    raise exception 'invalid account_type: %', _type;
  end if;
  update public.profiles set account_type = _type where id = _user;
  begin
    insert into public.admin_actions (actor_user_id, action, target_user_id, target_resource_type, target_resource_id, details)
    values (auth.uid(), 'account_type_changed', _user, 'profile', _user, jsonb_build_object('account_type', _type));
  exception when others then /* audit best-effort */ null;
  end;
end;
$$;
grant execute on function public.admin_set_account_type(uuid, text) to authenticated;
