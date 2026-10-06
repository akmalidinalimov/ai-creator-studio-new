-- Remove the admin role of @lawyer70 (Bahrom) — owner request, 2026-10-06.
--
-- WHY: the account's Telegram user is deleted: every admin alert sent to it fails with Telegram 403 "Forbidden: user
-- is deactivated" (24 failed new-student alerts on 2026-10-05, plus ops-http-alert and the group-mismatch watchdog
-- on 10-06), each one an entry in ops_http_failures. The last private message from this account to the bot was
-- 2026-05-18. Verified: the Telegram id is not referenced by any setting, function, cron job or group_teachers row.
--
-- Only the 'admin' role row is removed; the profile and its 'student' role stay. @akmalidiin remains an admin
-- (asserted). Replay-safe: a second run finds no row and does nothing.

do $$
declare
  _uid constant uuid := '70d47c3c-578d-41e3-982d-f10027bf05c7';
  _n int;
begin
  if not exists (select 1 from public.profiles p where p.id = _uid and p.telegram_username = 'lawyer70') then
    raise exception 'ABORT: profile % is not @lawyer70', _uid;
  end if;
  if not exists (select 1 from public.user_roles r join public.profiles p on p.id = r.user_id
                  where r.role in ('admin', 'superadmin') and r.user_id <> _uid) then
    raise exception 'ABORT: removing this role would leave no admin';
  end if;

  delete from public.user_roles where user_id = _uid and role = 'admin';
  get diagnostics _n = row_count;

  if _n > 0 then
    insert into public.admin_actions (actor_user_id, action, target_user_id, details)
    values (null, 'admin_role_removed', _uid, jsonb_build_object(
      'migration', '20261006051000', 'username', 'lawyer70',
      'reason', 'Telegram account deactivated (403 user is deactivated); owner request', 'at', now()));
  end if;
end $$;
