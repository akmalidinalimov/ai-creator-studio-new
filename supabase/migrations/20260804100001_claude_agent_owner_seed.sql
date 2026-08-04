-- Seed the Claude Code owner allowlist (2026-08-04, PR1). The bot gate (claudeOwnerAllowed) is
-- FAIL-CLOSED — an empty/absent allowlist means NOBODY may queue tasks that run code on the owner's
-- laptop. This seed makes the feature usable for exactly the owner (Admin, telegram_id 6542876935).
-- Kill-switch: set {"enabled": false}. To add/remove an owner: edit the owner_tg_ids array.
insert into public.platform_settings (key, value)
values ('claude_agent', jsonb_build_object('enabled', true, 'owner_tg_ids', jsonb_build_array(6542876935)))
on conflict (key) do update set value = excluded.value;
