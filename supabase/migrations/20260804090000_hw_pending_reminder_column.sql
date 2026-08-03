-- Pick reminder (2026-08-04): a one-time "choose your task" nudge ~10s after the picker appears, if
-- the student hasn't engaged. `reminder_at` doubles as the dedup + suppression flag — it's set when
-- the reminder is sent OR when the student taps a module (engaged). Either way the pending
-- "send a reminder" action is resolved, so it fires at most once and never nags an active picker.
-- Nullable, no default → instant add (no table rewrite).
alter table public.hw_pending_posts add column if not exists reminder_at timestamptz;
