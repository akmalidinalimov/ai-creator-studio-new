-- Claude Code agent — task queue (2026-08-04, PR1). A Telegram-driven queue for the owner's laptop
-- helper: the owner types a task in the bot → it lands here (queued) → a laptop poller holding a
-- scoped CLAUDE_AGENT_SECRET (NOT the service key) claims it via the claude-agent edge fn, runs
-- `claude -p`, and reports the result back (DM'd to the owner). The laptop's liveness heartbeat and
-- the kill-switch live in platform_settings (keys 'claude_agent_heartbeat' / 'claude_agent'), so no
-- extra tables. Service-role only — RLS on, no client policies (the bot + edge fn use service role).
create table if not exists public.claude_code_tasks (
  id uuid primary key default gen_random_uuid(),
  prompt text not null,
  status text not null default 'queued',                 -- queued | running | done | error
  requested_by uuid references public.profiles(id) on delete set null,
  requested_tg bigint,                                   -- Telegram id to DM the result to
  host text,
  result text,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
alter table public.claude_code_tasks enable row level security;  -- service-role only; no client policies
create index if not exists idx_cct_status_created on public.claude_code_tasks (status, created_at);
