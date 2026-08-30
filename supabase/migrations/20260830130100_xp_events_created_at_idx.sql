-- Support xp_throughput_watchdog (20260830130000): its 24h + 7-day window queries filter xp_events by
-- created_at ALONE, but the only index was xp_events_user_created_idx (user_id, created_at desc) —
-- leading-column mismatch means those range scans can't use it and would sequential-scan all of
-- xp_events every 6h. This (created_at) index keeps the recurring cron cheap as the table grows.
--
-- xp_events is ~22k rows / ~11 MB today, so a plain CREATE INDEX is effectively instant and its brief
-- lock is negligible — no CONCURRENTLY needed (and CONCURRENTLY can't run inside the migration txn).
-- Idempotent (IF NOT EXISTS); safe to re-apply under the deploy-concurrency re-run quirk.
create index if not exists xp_events_created_at_idx on public.xp_events (created_at);
