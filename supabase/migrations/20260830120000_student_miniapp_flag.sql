-- student_miniapp kill-switch flag — mirrors platform_settings.teacher_miniapp (20260819000000:100).
--
-- Seeds DISABLED. The student Telegram Mini App entry (the ☰ menu button + the reply-keyboard
-- button, wired in a follow-up bot-webhook change) stays OFF until an admin flips this to
-- {"enabled": true}. In the bot, loadStudentMiniAppEnabled() reads DEFAULT-OFF: an ABSENT row and
-- any non-`true` value BOTH read as disabled, so a missing/malformed value can never open the entry.
-- Flipping it back to false clears the menu button and drops the keyboard button to today's plain
-- student keyboard (byte-identical) — the instant, redeploy-free kill switch.
--
-- platform_settings PK=key, value jsonb (20260426101239:72-77). Insert-only; on conflict do nothing,
-- so this never clobbers an owner-set value and is safe to re-run.
insert into public.platform_settings (key, value)
values ('student_miniapp', '{"enabled": false}'::jsonb)
on conflict (key) do nothing;
