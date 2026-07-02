-- Webhook idempotency (M10 / audit BOT-1).
--
-- Telegram retries any update it doesn't receive a 200 for within ~60s. The
-- bot's stats/homework handlers make many sequential round-trips and can exceed
-- that window, so a single user action could be processed twice (double
-- /galaba send, double broadcast, double analytics event). This table lets the
-- webhook record each update_id exactly once and short-circuit on a retry.
--
-- Only the service-role edge function touches this table (which bypasses RLS);
-- RLS is enabled with no policies so no client role can read or write it.

CREATE TABLE IF NOT EXISTS public.bot_processed_updates (
  update_id     bigint PRIMARY KEY,
  processed_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bot_processed_updates ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.bot_processed_updates IS
  'Telegram webhook idempotency: one row per processed update_id. Written only by the telegram-bot-webhook service-role function. Prune rows older than a few days via cron.';

-- Index to make retention pruning cheap (DELETE WHERE processed_at < now() - interval '7 days').
CREATE INDEX IF NOT EXISTS idx_bot_processed_updates_processed_at
  ON public.bot_processed_updates (processed_at);
