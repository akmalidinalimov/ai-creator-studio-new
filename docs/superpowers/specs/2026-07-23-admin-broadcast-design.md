# Admin Broadcast — design spec (2026-07-23)

## Purpose
Give admins a first-class way to send an announcement (image + message, optional button) to
**all students of one selected course** as a **private Telegram DM**, composed in the platform's
admin panel. Replaces the ad-hoc, hardcoded `runMigrationBroadcast` (which only ever sends the old
"we've moved" migration text).

## Decisions (locked with owner)
- **Delivery model:** composed in the platform → delivered as a **Telegram bot DM only** (no in-app
  notification inbox).
- **Audience:** one course at a time (dropdown), targeting **enrolled + active + Telegram-linked**
  students of that course.
- **Language:** one **primary Uzbek** body, with **optional** Russian/English overrides (student's
  `preferred_locale` picks; missing override → Uzbek). Rationale: 96% of reachable students are `uz`
  (500 uz / 17 ru / 5 en).
- **Engine:** **queue + once-a-minute cron drainer**, mirroring `badge_award_queue` — inherits the
  hardened reliability model (atomic claim, terminal-vs-transient classification, retry cap, honest
  per-recipient reporting) from PR #36.
- **Out of scope (YAGNI):** scheduling for later, multiple images, saved drafts, in-app delivery.

## Data model (service-role only; RLS on, no policies)
**`broadcasts`** — one row per broadcast:
`id`, `course_id` (fk courses), `created_by` (fk profiles), `image_path` (nullable, storage key),
`body_uz` (not null), `body_ru`/`body_en` (nullable overrides), `button_label`/`button_url`
(nullable), `mode` (`test`|`all`), `status` (`sending`|`done`), `total`/`sent`/`failed` (int),
`created_at`/`started_at`/`finished_at`.

**`broadcast_deliveries`** — one row per recipient (mirrors `badge_award_queue`):
`id`, `broadcast_id` (fk), `user_id`, `telegram_id`, `status` (`pending`|`sent`|`failed`),
`error` (text), `attempts` (int default 0), `last_attempt_at`, `sent_at`.
Indexes: `(broadcast_id)`, partial `(scheduled/created)` where `status='pending'`.

## Admin screen — `/admin/broadcast` (new `AdminSidebar` item, `adminOnly`)
- **Course** dropdown (from `courses`), showing live "→ N reachable" for the picked course.
- **Image** upload (optional) → public `broadcast-images` bucket → public URL (same pattern as
  `course-covers`). Preview thumbnail.
- **Message (Uzbek)** textarea with a live character counter enforcing Telegram's limit
  (**1024 with an image**, **4096 text-only**). Collapsible "Add Russian / English versions".
- **Button** (optional): label + URL.
- **Actions:** `[Send test to me]` and `[Send to N →]` (confirm dialog shows the real count).
- **Progress** panel polling the `broadcasts` row: `sent / failed / remaining`, final report lists
  failures with reasons.

## Send flow
1. Compose; image uploads to `broadcast-images` → URL stored as `image_path`.
2. **Send test to me** → creates a `mode='test'` broadcast with a single delivery row (the admin) →
   drainer delivers within ~1 min → admin sees the exact message in Telegram.
3. **Send to N** → confirm dialog (real count) → an admin-JWT-gated edge function
   (`admin-broadcast`) creates the `broadcasts` row and fans out one `pending` `broadcast_deliveries`
   row per enrolled/active/Telegram-linked student → `status='sending'`.
4. **Drainer** (`broadcast-drainer`, cron every minute): atomically claims a batch of `pending`
   rows, sends `sendPhoto` (image+caption) or `sendMessage` (text-only) via the bot token, marks
   each `sent`/`failed`, updates `broadcasts` counts; sets `status='done'` when drained.

## Reliability & honesty rails
- **Reach truth:** only enrolled+active+Telegram-linked are targeted. A student who never pressed
  Start lands as `failed: bot_not_started` in the report — **never a silent success** (the badge-bug
  lesson). `tg()` checks the Telegram `ok` field; failures are classified.
- **Rate limit:** ~25 msg/sec, backs off on Telegram 429 (transient → retry).
- **Retry:** transient failures retried (cap 5); terminal (blocked / not-started / bad content) not
  retried, recorded with reason.
- **Dedup:** one delivery row per (broadcast, user); drainer only sends `pending`; atomic claim
  (last_attempt_at lease) prevents double-send across overlapping ticks.
- **Quiet hours:** if the admin sends between 22:00–08:00 Tashkent, the UI warns and offers to defer
  the first send to 08:00.
- **Guards:** admin/superadmin only (edge auth + RLS); at most one `sending` broadcast per course at
  a time; kill-switch flag in `platform_settings` (`broadcast.enabled`); every send audited in
  `admin_actions` (`broadcast_created`, `broadcast_finished` with counts).
- **Health:** broadcast delivery health folds into the daily `ops_daily_digest` and a stuck-broadcast
  watchdog (consistent with the incident doctrine).

## Verification
- Deno unit test for the send/classification logic (terminal vs transient; image vs text path).
- Reviewers before merge: `telegram-flow-reviewer` (send path, member-forgiveness, rate limits) +
  `migration-safety-reviewer` (tables, RLS, cron, digest superset).
- E2E on prod: **test-send to the owner first**; then a small controlled real send to a handful of
  synthetic students; assert delivered/failed counts; DELETE synthetic residue.

## Rollout
Feature ships dormant-safe: the sidebar item + page appear, but `broadcast.enabled=false` until the
owner flips it on. First real use is the owner's own test send.
