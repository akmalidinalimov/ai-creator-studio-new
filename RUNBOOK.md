# AI Creators — Operations Runbook

When an automated alert fires in the admin Telegram, find its row below: **what it means → how to
confirm → how to fix → how to silence** if it's a false alarm. Kill-switches are indexed at the top.

All times are UTC unless noted; the platform's day-math is Asia/Tashkent (UTC+5).

---

## Kill-switch index

| Lever | Effect | How |
|---|---|---|
| `platform_settings.ops_http_watchdog → {"enabled": false}` | Stops HTTP-fault alerting (capture may keep running) | `update platform_settings set value = jsonb_set(value,'{enabled}','false') where key='ops_http_watchdog';` |
| `platform_settings.ops_agent → {"enabled": false}` | Halts autonomous-ops dispatch (Phase 4) | same idiom, key `ops_agent` |
| `platform_settings.claude_agent → {"enabled": false}` | Stops the Claude Code laptop helper claiming tasks | same idiom, key `claude_agent` |
| Unschedule a cron | Stops that job | `select cron.unschedule('<jobname>');` |
| Remove a Vault secret | Disables the flow that reads it (fails safe/dormant) | Supabase Dashboard → Vault |
| Disable a GitHub workflow | Stops that pipeline (deploy / verifier) | GitHub → Actions → workflow → Disable |
| Deploy pipeline | No migration applies without the `migration-approved` PR label | (structural — no action needed to be safe) |

---

## Alert playbook

### ⚠️ "HTTP faults (last 45m)" — `ops_http_failure_watchdog`
**Means:** one or more automated HTTP calls returned a real fault (5xx, our-own `{"error":"forbidden"}`,
401, a Telegram payload 4xx, a DNS/connection error) or timeouts spiked above threshold. Expected
Telegram "user blocked the bot" noise is already suppressed.
**Confirm / triage:**
```sql
select occurred_at, status_code, timed_out, classification, coalesce(purpose,url,'unattributed') as who,
       left(error_msg,80) as err, left(content_snip,120) as body
from public.ops_http_failures
where classification in ('real','timeout') and occurred_at > now() - interval '2 hours'
order by occurred_at desc;
select public.ops_http_health();
```
**Fix by signature:**
- **`403 {"error":"forbidden"}` from one of our functions** → a cron/caller is using a stale/missing
  secret. Identify the caller (its `purpose`, or match the time to a cron schedule), then re-set the
  correct Vault secret. *Secret values are owner-entered — never printed.*
- **`5xx` from an edge function** → check that function's logs (`/analytics/endpoints/logs.all`) and
  `platform_error_log`; fix the function; redeploy via merge.
- **`400` to `api.telegram.org`** → malformed payload (too long / bad parse mode / bad file id) in the
  calling code; fix and redeploy.
- **`Could not resolve host` / connection errors** → transient network, or a wrong hostname in a caller.
  If it recurs for one `who`, correct that URL.
- **Timeout burst** → usually pg_net queue congestion when many crons fire at `:00`/`:30`; benign unless
  sustained. If sustained for one endpoint, that endpoint is slow — consider staggering its cron or
  raising its `timeout_milliseconds`.
**Silence (false alarm):** raise `timeout_threshold`, add a phrase to `tg_expected_regex`, or set
`enabled=false` (all in `platform_settings.ops_http_watchdog`). Cooldown is `cooldown_hours` (3h).

### 📨 hw-dm / homework delivery — `hw-dm-watchdog`, `platform-anomaly-digest`
**Means:** teacher/student homework DMs are overdue, the drainer stalled, or delivery errors grew.
**Confirm:** `select public.hw_dm_health_stats();` and `select * from homework_teacher_dm_queue where error is not null order by created_at desc limit 20;`
**Fix:** the minute drainer + 15-min reconciler + SQL fallback usually self-heal; if `drainer_age_sec > 300`,
check the `broadcast-drainer`/`notify-*` crons and the edge functions they invoke. External verifier
`hw-dm-health.yml` fails loudly if unsent_overdue≠0.

### 🏅 badge delivery — `badge-dm-watchdog`
**Confirm:** `select public.badge_dm_health_stats();` and `select * from badge_award_queue where sent_at is null and attempts > 2;`
**Fix:** the minute drainer re-sends; if stuck, inspect `notify-badge-award` logs.

### 👤 enrollment anomalies — `enrollment-watchdog`
**Means:** a student is in a tiered group but carries a stray/duplicate enrollment, or a signup path broke.
**Confirm:** `select public.stray_enrollment_count();` and the watchdog's own DM detail.
**Fix:** stray heals are **guarded, audited DELETEs** shipped as one-shot migrations (see
`20260808120000_heal_stray_enrollment.sql`) — never delete enrollments by hand; write an idempotent,
audited heal.

### 🌐 reputation / traffic — `reputation-check`, `web-traffic-watchdog`
**Means:** a security vendor flagged the domain, or web traffic dropped anomalously.
**Confirm:** `select * from domain_reputation_checks order by checked_at desc limit 10;`
**Fix:** run the vendor dispute (VirusTotal / Kaspersky / Fortinet); the SB-level re-alerts hourly,
VT daily, until cleared.

### 🛠 cron failures — `platform-anomaly-digest` (cron-failure leg)
**Means:** a pg_cron job's `job_run_details.status` = failed.
**Caveat:** this only catches SQL/exec failures — it does **not** catch `net.http_post` HTTP failures
(that's exactly what `ops_http_failure_watchdog` above now covers).
**Confirm:** `select * from cron.job_run_details where status <> 'succeeded' order by start_time desc limit 20;`

---

## Health-signal quick reference

| Function | Surfaces |
|---|---|
| `ops_http_health()` | HTTP-call faults/timeouts, last sweep freshness, open real signatures |
| `hw_dm_health_stats()` | homework-DM delivery, drainer freshness, uncaptured posts |
| `badge_dm_health_stats()` | badge delivery |
| `broadcast_health_stats()` | admin broadcast delivery |
| `homework_attribution_health()` | SAP homework step-attribution |
| `stray_enrollment_count()` | enrollment integrity |

**Independent legs (design invariant):** triggers (instant) → reconcilers (re-derive from source of
truth) → SQL fallbacks → DB watchdogs (DM admins) → the **external GitHub verifier**
(`.github/workflows/hw-dm-health.yml`, daily) which audits from *outside* Supabase and survives total
backend death. Every leg must stay independent of the thing it watches.
