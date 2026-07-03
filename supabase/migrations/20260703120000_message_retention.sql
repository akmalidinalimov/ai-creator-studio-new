-- Message retention: keep AI-tutor chat messages for 60 days, then purge.
-- Requested: "messages written stored [in our DB], deleted every 2 months."
-- Uses pg_cron (available on Supabase Pro). Weekly sweep, hard delete.
--
-- NOTE: this HARD-DELETES ai_chat_messages older than 60 days. If you later
-- want to archive instead of delete, change purge_old_chat_messages() to move
-- rows into an archive table before deleting.

create extension if not exists pg_cron;

create or replace function public.purge_old_chat_messages()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  delete from public.ai_chat_messages
  where created_at < now() - interval '60 days';
  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function public.purge_old_chat_messages() is
  'Hard-deletes ai_chat_messages older than 60 days. Scheduled weekly via pg_cron (job: purge_old_chat_messages).';

-- Schedule weekly (Sunday 03:00 UTC). Guarded so re-running the migration
-- doesn't create duplicate jobs.
do $$
begin
  if not exists (select 1 from cron.job where jobname = 'purge_old_chat_messages') then
    perform cron.schedule('purge_old_chat_messages', '0 3 * * 0', $cron$ select public.purge_old_chat_messages(); $cron$);
  end if;
end;
$$;
