-- Track C1 — HTTP-call observability: foundational tables + secret-safe net.http_post wrapper.
--
-- Why: pg_net's net.http_post is async — it returns success once the request is QUEUED, and the
-- outcome lands in net._http_response which (a) no code reads back and (b) self-deletes after ~6h
-- (measured retention 5.98h on prod 2026-08-10). So every failed alert / dropped DM / bad-secret 403
-- is invisible. Live evidence (6h window, 2026-08-10): 31 timeouts + 2x real 403 {"error":"forbidden"}.
-- net._http_response has no URL column and net.http_request_queue is emptied on completion, so
-- attribution requires capturing request_id -> url/purpose AT CALL TIME (this wrapper).
--
-- Design: docs/superpowers/specs/2026-08-10-http-call-observability-design.md
-- Regex (token redaction + query strip), redactor, and classifier validated read-only on prod 2026-08-10.
-- RLS on / no policies = service-role-only, matching the other ops_* tables.

-- 1. Durable failure log. One row per failed net._http_response; response_id PK makes capture idempotent.
create table if not exists public.ops_http_failures (
  response_id    bigint primary key,          -- = net._http_response.id
  status_code    int,                         -- null when timed out / transport error
  timed_out      boolean not null default false,
  error_msg      text,                        -- pg_net transport error (redacted + truncated)
  content_snip   text,                        -- response body, redacted + truncated <= 240 chars
  url            text,                         -- sanitized (token-stripped); null if caller not wrapped
  purpose        text,                         -- caller label; null if not wrapped
  classification text,                         -- 'expected' | 'real' | 'timeout' | 'unknown' (set at capture)
  occurred_at    timestamptz not null,        -- = net._http_response.created
  captured_at    timestamptz not null default now()
);
alter table public.ops_http_failures enable row level security;
create index if not exists ops_http_failures_occurred_idx on public.ops_http_failures (occurred_at desc);
create index if not exists ops_http_failures_class_idx    on public.ops_http_failures (classification, occurred_at desc);

-- 2. Call attribution map (request_id -> sanitized url + purpose), written at call time by ops_net_post.
create table if not exists public.ops_http_calls (
  request_id bigint primary key,               -- = value returned by net.http_post
  url        text not null,                    -- SANITIZED before insert (never a raw token)
  purpose    text,
  created_at timestamptz not null default now()
);
alter table public.ops_http_calls enable row level security;
create index if not exists ops_http_calls_created_idx on public.ops_http_calls (created_at desc);

-- 3. URL sanitizer. MUST strip the Telegram bot token from the path (Telegram URLs are
--    https://api.telegram.org/bot<TOKEN>/method) and drop query strings, so no secret is ever stored.
--    Pure/immutable. Validated on prod: token redacted, query stripped, non-token URLs untouched.
create or replace function public.ops_sanitize_url(p_url text)
returns text
language sql immutable
set search_path = public
as $$
  select regexp_replace(
           regexp_replace(coalesce(p_url, ''), '/bot[0-9]+:[A-Za-z0-9_-]+', '/bot<redacted>', 'g'),
           '\?.*$', '')
$$;

-- 3b. Secret redactor for stored response bodies / transport-error strings. Strips bot tokens,
--     bearer tokens, bare JWTs (Supabase service keys start eyJ...), and long hex — so no secret is
--     ever persisted even if an upstream error string echoes a full URL/credential. Pure/immutable.
--     Validated on prod 2026-08-10 (all four token shapes redacted; normal words untouched).
create or replace function public.ops_redact_secrets(p_text text)
returns text
language sql immutable
set search_path = public
as $$
  select regexp_replace(coalesce(p_text, ''),
    '(bot[0-9]+:[A-Za-z0-9_-]{20,}|[Bb]earer\s+[A-Za-z0-9._-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.?[A-Za-z0-9_-]*|[A-Fa-f0-9]{40,})',
    '<redacted>', 'g')
$$;

-- 4. Logging wrapper around net.http_post. Returns the pg_net request_id and records the SANITIZED
--    url + purpose so failures are attributable. Logging is best-effort and must NEVER break the send.
--    Deliberately does not persist headers/body (they carry the bot token / service-role key).
create or replace function public.ops_net_post(
  p_url       text,
  p_body      jsonb default '{}'::jsonb,
  p_headers   jsonb default '{}'::jsonb,
  p_purpose   text  default null,
  p_timeout_ms int  default 5000
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  _id bigint;
begin
  _id := net.http_post(url := p_url, body := p_body, headers := p_headers, timeout_milliseconds := p_timeout_ms);
  begin
    insert into public.ops_http_calls (request_id, url, purpose)
    values (_id, public.ops_sanitize_url(p_url), p_purpose)
    on conflict (request_id) do nothing;
  exception when others then
    null;  -- attribution is best-effort; a logging failure must not break the underlying send
  end;
  return _id;
end
$$;

-- 5. SSRF hardening: ops_net_post can make arbitrary outbound POSTs, so only service_role / postgres
--    may invoke it. Revoke the default PUBLIC execute grant (covers anon + authenticated).
revoke all on function public.ops_net_post(text, jsonb, jsonb, text, int) from public;
revoke all on function public.ops_sanitize_url(text) from public;
revoke all on function public.ops_redact_secrets(text) from public;
grant execute on function public.ops_net_post(text, jsonb, jsonb, text, int) to service_role;
grant execute on function public.ops_sanitize_url(text) to service_role;
grant execute on function public.ops_redact_secrets(text) to service_role;

comment on table public.ops_http_failures is
  'Durable capture of failed net._http_response rows (which pg_net GCs at ~6h). Fed by ops_http_failure_sweep(). Service-role only.';
comment on function public.ops_net_post(text, jsonb, jsonb, text, int) is
  'Secret-safe wrapper over net.http_post: logs sanitized url+purpose (request_id) for failure attribution. Never stores headers/body/tokens.';
