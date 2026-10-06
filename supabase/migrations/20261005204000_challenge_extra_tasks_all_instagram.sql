-- REFUSED, NEVER APPLIED (2026-10-05 20:55 UTC): this file converted draft tasks only, and #6 / #10 had been
-- approved meanwhile, so its own guard aborted it (one transaction, nothing applied). The same migration, also
-- converting approved-but-unposted tasks, ships as 20261005210000. Kept as a no-op so a replay applies it once.
select 1;
