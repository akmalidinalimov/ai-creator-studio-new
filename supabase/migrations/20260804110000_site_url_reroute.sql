-- URGENT (2026-08-04): aicreator.academy was re-flagged malicious by 8 VirusTotal vendors, so it's
-- blocked on many students' networks — the bot's webapp links ("Davom etish" → /auth/magic → lesson)
-- won't open. The backend is healthy; only the domain is blocked. Reroute the bot's links to the clean
-- Vercel stopgap via the getSiteUrl() override until the VT flag is disputed + cleared.
-- REVERT: set url back to 'https://aicreator.academy' (or delete this key) — takes effect within ~60s.
insert into public.platform_settings (key, value)
values ('site_url', jsonb_build_object('url', 'https://ai-creator-studio-new.vercel.app'))
on conflict (key) do update set value = excluded.value;
