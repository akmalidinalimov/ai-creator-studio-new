---
name: new-edge-function
description: Scaffold a new Supabase edge function following the platform's least-privilege template. Use when creating any new edge function.
---

Create a new edge function: $ARGUMENTS

Follow the platform's converged least-privilege shape (reference implementations:
`supabase/functions/hw-dm-health/index.ts` and `supabase/functions/ops-notify/index.ts`).

## Checklist — every item, in order

1. **Directory**: `supabase/functions/<name>/index.ts` (kebab-case name).
2. **Auth model** — pick ONE, no mixing:
   - Internal/cron caller → dedicated secret header (`x-<name>-secret`) compared with
     constant-time `ctEq` against a Vault accessor RPC (returns NULL until the owner
     inserts the value → the function is gracefully dormant, 403s everyone).
   - User-facing → `verify_jwt = true` and derive the user from the JWT; never trust
     client-supplied user ids.
3. **config.toml**: add `[functions.<name>]` with the correct `verify_jwt` — CI's
   `check:config` gate FAILS the build if the entry is missing. Do NOT touch project_id.
4. **Vault accessor** (if a new secret is needed): new migration cloning the
   `ops_notify_secret()` pattern — `security definer`, `set search_path = public, vault`,
   revoked from public/anon/authenticated, granted to service_role. Secret VALUE is
   owner-inserted in the SQL editor, never committed.
5. **Health signal (mandatory)**: the function must emit DB-visible signals — a queue
   table with an `error` column, a counter field surfaced by `hw_dm_health_stats()`, or
   `admin_actions` rows. Errors that live only in function logs are invisible to the
   watchdog layer and violate CLAUDE.md.
6. **Quiet hours**: outbound student/teacher Telegram messages respect 22:00–08:00
   Tashkent (UTC+5); queue for morning delivery instead of dropping.
7. **CORS**: copy the standard corsHeaders block; include any custom auth header in
   Access-Control-Allow-Headers.
8. **Deploy path**: never deploy manually — commit, PR, merge; the pipeline deploys
   changed functions automatically.
9. **Tests**: pure logic goes in a separate module with a `.test.ts` next to it (the
   telegram-bot-webhook/ops-approve.ts pattern) so CI's Deno job runs it.

## Verify before PR

- `npx esbuild supabase/functions/<name>/index.ts --loader:.ts=ts --outfile=NUL` parses.
- `npm run check:config` passes.
- The dormant path is safe: with no secret in Vault, every caller gets 403 and nothing
  crashes.
