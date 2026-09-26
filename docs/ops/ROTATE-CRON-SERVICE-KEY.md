# Runbook: rotate `CRON_SERVICE_KEY` (exposed 2026-07-05 → 2026-09-25)

**Status: the door is closed, the key is not yet rotated.** Written 2026-09-26.

## What happened, in one paragraph

`public.cron_service_key()` is a `SECURITY DEFINER` function whose whole body is
`select decrypted_secret from vault.decrypted_secrets where name='CRON_SERVICE_KEY'`. The `anon`
role had `EXECUTE` on it. PostgREST exposes every executable function in the `public` schema at
`/rest/v1/rpc/<name>`, and the anon key is public by design — it ships in the browser bundle. So for
roughly **83 days** anyone at all could fetch that secret with one HTTP request.

The vault's own description for it reads **"service_role key for pg_cron edge-function calls"**, and
`20260705200000_canary_cron.sql:25-26` uses it as both the `apikey` and the `Authorization: Bearer`
header, and **18 active cron jobs depend on it** (see step 1). So the exposed value is a **service_role credential: it bypasses every RLS policy and has
full read/write on the whole database.**

Closed by PR #175 (migration `20260925201000`). Reconciled into version control by PR #176
(`20260926060000`), which also ships the correct ACL so a rebuild cannot re-open it.

### Was it used?

**No call to `/rest/v1/rpc/cron_service_key` appears in the last 24 hours of request logs.** That is a
real negative, not an empty query — the same query returns thousands of hits for other RPCs
(`track_video_progress`, `internal_fn_secret`, …). But **Supabase caps log queries at 24 hours**, so
the preceding ~82 days cannot be checked with the tooling available. Vault `updated_at` equals
`created_at` (2026-07-05), so the key has never been rotated. **Treat it as exposed.**

---

## Before you start: pick the right rotation path

This project has **both** key systems live (checked 2026-09-26):

| Key | Type | Enabled |
|---|---|---|
| `anon` | legacy JWT | yes |
| `default` (`sb_publishable_…`) | modern publishable | yes |

That matters because it decides which path you take:

- ✅ **Preferred — rotate the modern secret key.** If a modern secret key (`sb_secret_…`) exists under
  **Project Settings → API Keys**, roll it there. Modern keys rotate **independently**, so signed-in
  users are not affected.
- ⚠️ **Avoid unless forced — rotating the legacy JWT secret.** The legacy `service_role` key is a JWT
  signed with the project's JWT secret. Rotating that secret invalidates **every** JWT signed with it,
  **including every logged-in student's session** — everyone gets logged out mid-lesson. Only take this
  path if the legacy service_role key is genuinely what the crons use and no modern key can replace it.

If you are unsure which the crons are actually using, that is answerable: see step 1.

---

## Steps

### 1. See what the crons currently send

```sql
-- Which jobs call cron_service_key(), i.e. which break if the value is wrong
select jobname, schedule, active
from cron.job
where command like '%cron_service_key%'
order by jobname;
```

**Expect 18 active jobs** (measured 2026-09-26). An earlier draft of this runbook said 9 — that was
the number of migration FILES that reference the function, not the number of jobs they schedule.
The real list, and why step 3 is the dangerous one to skip:

| every minute | every 15-30 min | daily / weekly |
|---|---|---|
| broadcast-drainer-every-minute | canary-15min | teacher-daily-digest (16:00) |
| notify-badge-award-every-minute | bitrix-lead-sync | student-of-week (Mon) |
| notify-homework-submission-every-minute | grade-card-reconcile | teacher-weekly-digest (Mon) |
| | cron-admin-digest-30min | weekly_digest (Sun) |
| | cron-engagement-every-30-min | weekly-admin-topic-check (Sun) |
| | import-digest-30min | reputation-check-12h |
| | detect_and_nudge (hourly) | |
| | teacher-engagement-nudge-hourly | |
| | ungraded-homework-reminder-hourly | |

**Three of these run every minute.** If you rotate the dashboard key and forget the Vault copy, those
three start failing within 60 seconds and the other fifteen follow. That is loud rather than silent —
`ops_http_failure_watchdog` will DM you — but it is avoidable by doing step 3 in the same sitting.

To see the key's *shape* without printing it (tells you legacy JWT vs modern `sb_secret_`):

```sql
-- length + first 3 chars only. A legacy key is a long JWT starting "eyJ";
-- a modern one starts "sb_".
select length(public.cron_service_key()) as len,
       left(public.cron_service_key(), 3) as shape
from (select 1) x;
```

Run this in the **Supabase SQL editor** (it runs as `postgres`, which still has EXECUTE). It will not
work from the REST API any more — that is the point of the fix.

### 2. Rotate in the Supabase dashboard

**Project Settings → API Keys.** Roll the secret/service key using the preferred path above. Copy the
new value once — you will need it in step 3.

> Edge functions receive `SUPABASE_SERVICE_ROLE_KEY` injected by the platform, so they pick up the new
> value without a redeploy. The **Vault copy does not** — that is step 3, and it is the step people forget.

### 3. Update the Vault copy (the manual one)

In the SQL editor:

```sql
-- Replace the secret in place. Do NOT paste the key into a migration, a PR, or a chat.
select vault.update_secret(
  (select id from vault.secrets where name = 'CRON_SERVICE_KEY'),
  '<PASTE NEW KEY HERE>',
  'CRON_SERVICE_KEY',
  'service_role key for pg_cron edge-function calls'
);
```

Then confirm it changed **without printing it**:

```sql
select name, created_at, updated_at
from vault.secrets
where name = 'CRON_SERVICE_KEY';
-- updated_at must now be NEWER than created_at. Before rotation they were identical.
```

### 4. Verify the crons still work

The fastest real signal is the canary, which runs every 15 minutes:

```sql
-- Recent HTTP failures attributed to cron callers. Should stay empty.
select purpose, count(*), max(created_at)
from ops_http_failures
where created_at > now() - interval '30 minutes'
group by purpose
order by 2 desc;

-- And the canary's own state
select value from app_settings where key = 'canary_state';
```

If a cron is now unauthorised you will see failures appear here within ~15 minutes, and
`ops_http_failure_watchdog` will DM the admins. **Wait through one canary cycle before calling it done.**

### 5. Confirm the leak stays closed

```sql
select
  has_function_privilege('anon','public.cron_service_key()','EXECUTE')          as anon_must_be_false,
  has_function_privilege('authenticated','public.cron_service_key()','EXECUTE') as authed_must_be_false,
  has_function_privilege('service_role','public.cron_service_key()','EXECUTE')  as service_must_be_true;
-- expect: false, false, true
```

---

## Also outstanding (separate from this rotation)

1. **Rotate the Telegram bot token.** Still owed from the September log-leak incident. It lives in
   **two** places: the `TELEGRAM_BOT_TOKEN` edge-function secret **and**
   `platform_settings.telegram.bot_token`. Both must change together.
2. **64 anon-executable `SECURITY DEFINER` functions remain.** Each needs its own caller audit —
   revoking blind breaks the product. In progress.
3. **The live database has drifted from this repo.** Four functions carried an explicit `anon` grant
   even though their migrations revoked it, and `cron_service_key()` existed live with no migration at
   all. **A repo grep is not authoritative for security state** — query live `pg_proc` / `proacl`.

## The lesson worth keeping

The grant that leaked was to **`PUBLIC`**, not to `anon`. `REVOKE EXECUTE … FROM anon` alone is a
**no-op** against an inherited `PUBLIC` grant, and it looks exactly like a fix. Always:

```sql
revoke execute on function public.f(...) from public, anon, authenticated;
grant  execute on function public.f(...) to service_role;
```

Same shape as the video-source-column leak, where a column-level `REVOKE` was a no-op against a
table-level `GRANT`.
