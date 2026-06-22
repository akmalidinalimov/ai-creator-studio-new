-- Anonymous-admin capture (2026-06-23).
-- Teachers answer in the groups ANONYMOUSLY ("as the group"). Telegram delivers those messages via its
-- GroupAnonymousBot, with sender_chat == the group itself and from.is_bot == true. The bot's
-- recordGroupMessageEvent dropped them via the is_bot guard, so EVERY anonymous teacher answer was
-- invisible to Teacher Statistics (teachers looked silent / "don't chat" — they actually do).
--
-- Fix: the bot now keeps anonymous-admin messages (sender_chat == chat.id) and attributes them to the
-- group's assigned teacher (groups.teacher_id). These two additive columns let us flag them and keep the
-- admin's custom title (author_signature, e.g. "Kurator") for multi-staff disambiguation later.
ALTER TABLE public.group_message_events
  ADD COLUMN IF NOT EXISTS is_anon_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS author_signature text;

-- helps the stats RPC slice teacher (anon) activity vs student chatter
CREATE INDEX IF NOT EXISTS idx_gme_anon ON public.group_message_events (group_id, is_anon_admin)
  WHERE is_anon_admin;
