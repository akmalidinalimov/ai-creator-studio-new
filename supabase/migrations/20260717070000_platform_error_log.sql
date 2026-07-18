-- DB-visible platform error log (2026-07-17, owner request: classify system-error vs user-fumble).
-- Genuine code errors currently live only in Supabase FUNCTION logs — invisible to the detectors
-- and to the ops agent, and gone in days. This table captures REAL errors (caught exceptions /
-- failed operations) durably so they can be watched, classified, and turned into fix PRs.
--
-- The system-vs-user line is drawn at CAPTURE time, in the code: a caught exception / unexpected
-- failure calls logError() → lands here. Expected member behaviour (wrong button → a friendly
-- message) is NOT an error and is NOT logged — preserving the "forgiving sandbox" principle.

create table if not exists public.platform_error_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  source text not null,               -- edge function / surface, e.g. 'telegram-bot-webhook'
  action text,                        -- where in it, e.g. 'update_handler', 'grade_save'
  message text,                       -- the error message (truncated)
  user_id uuid,                       -- affected profile, if known
  telegram_id bigint,                 -- affected telegram user, if known
  context jsonb not null default '{}',
  resolved_at timestamptz             -- reserved: mark handled/triaged
);
alter table public.platform_error_log enable row level security;
-- service_role only (edge functions); invisible to anon/authenticated
create index if not exists idx_platform_error_log_recent on public.platform_error_log (occurred_at desc);

-- Compact recent-error summary for the health endpoint + the agent: grouped by a stable
-- signature (source · action · normalized message) so a repeating bug shows as one row with a
-- count, not N lines. Digits are masked so "id 123 not found" and "id 456 not found" group.
create or replace function public.recent_platform_errors(_hours int default 24)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  with recent as (
    select source, action,
      regexp_replace(coalesce(message,''), '\d+', '#', 'g') as sig,
      max(message) as sample, count(*) as n, max(occurred_at) as last_at
    from platform_error_log
    where occurred_at > now() - make_interval(hours => greatest(_hours, 1))
    group by 1, 2, 3
  )
  select jsonb_build_object(
    'window_hours', greatest(_hours, 1),
    'total', coalesce((select sum(n) from recent), 0),
    'distinct_classes', (select count(*) from recent),
    'top', coalesce((
      select jsonb_agg(jsonb_build_object(
               'source', source, 'action', action, 'count', n,
               'sample', left(sample, 300), 'last_at', last_at)
             order by n desc)
      from (select * from recent order by n desc limit 15) t
    ), '[]'::jsonb)
  );
$fn$;

revoke execute on function public.recent_platform_errors(int) from public, anon, authenticated;
grant execute on function public.recent_platform_errors(int) to service_role;
