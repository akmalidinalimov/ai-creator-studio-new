-- Redact Telegram bot tokens (and the other secret shapes) from the two error logs that can receive
-- them — and scrub the rows that already leaked.
--
-- WHY (found 2026-09-11, during the post-deploy check of the Mini App voice bridge): Deno's fetch
-- transport errors embed the FULL request URL, and a Telegram API URL carries the bot token in its
-- path. The webhook's catch-all error logger stored those messages verbatim, so 11 rows of
-- platform_error_log held the LIVE bot token in plaintext (2026-07-20 → 2026-08-01), plus 1 row of
-- homework_teacher_dm_queue.error (2026-06-16, written by the pre-sendTelegram drainer). A scan of
-- every error-shaped text/jsonb column in `public` found the token in no other table (ops_http_failures
-- already redacts via ops_redact_secrets since 20260810130000).
--
-- Neither table is client-readable — platform_error_log has RLS ON with NO policies (service-role
-- only), homework_teacher_dm_queue allows SELECT only to admins — so exposure was limited to admins
-- and service-role holders. A credential still must never sit in a log table.
--
-- The edge tier stops producing these strings (supabase/functions/_shared/redact.ts, applied in the
-- webhook's tgApi + logError and in detect-and-nudge's tgSend + error response). THIS migration is the
-- DB-side invariant (prevention hierarchy layer 2): even a future code path that hands a raw transport
-- error to these columns cannot persist a secret. It reuses public.ops_redact_secrets(), already
-- validated on prod.
--
-- Idempotent + replay-safe (deploy-concurrency doctrine): triggers are drop-if-exists + create, and
-- the scrub is a no-op once the rows are clean.

-- 1. The invariant. NULL-safe on purpose: ops_redact_secrets() coalesces NULL to '', so it may only be
--    applied to non-NULL values — `error IS NULL` is a meaningful state in the DM queue ("no failure")
--    that hw_dm_health_stats() and the retry watchdog both count on.
create or replace function public.redact_platform_error_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.message is not null then
    new.message := public.ops_redact_secrets(new.message);
  end if;
  if new.context is not null then
    new.context := public.ops_redact_secrets(new.context::text)::jsonb;
  end if;
  return new;
end;
$$;

revoke all on function public.redact_platform_error_log() from public;

drop trigger if exists trg_platform_error_log_redact on public.platform_error_log;
create trigger trg_platform_error_log_redact
  before insert or update on public.platform_error_log
  for each row execute function public.redact_platform_error_log();

create or replace function public.redact_hw_dm_queue_error()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.error is not null then
    new.error := public.ops_redact_secrets(new.error);
  end if;
  return new;
end;
$$;

revoke all on function public.redact_hw_dm_queue_error() from public;

drop trigger if exists trg_hw_dm_queue_redact on public.homework_teacher_dm_queue;
create trigger trg_hw_dm_queue_redact
  before insert or update on public.homework_teacher_dm_queue
  for each row execute function public.redact_hw_dm_queue_error();

-- 2. Heal history — scrub what already leaked (incident doctrine, step 4). Both statements are
--    no-ops on a clean table, and the triggers above re-apply the same function, so a replay is safe.
update public.platform_error_log
   set message = public.ops_redact_secrets(message)
 where message is not null
   and message is distinct from public.ops_redact_secrets(message);

update public.platform_error_log
   set context = public.ops_redact_secrets(context::text)::jsonb
 where context is not null
   and context::text is distinct from public.ops_redact_secrets(context::text);

update public.homework_teacher_dm_queue
   set error = public.ops_redact_secrets(error)
 where error is not null
   and error is distinct from public.ops_redact_secrets(error);
