# Daily Group Board — design

**Goal:** Every day at 21:00 Tashkent, send each teacher (their groups) and admins (all groups) a
readable group-stats summary + a per-group student leaderboard they can screenshot into their
Telegram groups to drive friendly competition. Plus a one-tap Telegram Mini App for the full,
screenshot-optimized view.

**Status:** approved by owner 2026-08-10. Ships in one PR (frontend + 2 edge fns + 1 migration).

## Surfaces

1. **`group_student_leaderboard(_group_id, _limit=10)` RPC** — two boards per group:
   - `alltime` — `public.user_group_rating_xp(uid, course)` (**not** `user_course_xp`).
   - `weekly` — `public.user_group_rating_xp_since(uid, course, monday_00_tashkent)`, a new windowed
     analog. Resets every Monday → keeps the race fresh. Only students with `weekly_xp > 0` appear.
   - Names = first + last-initial. Guard = service role OR admin/superadmin OR the group's teacher.
2. **`teacher-daily-digest` (extended)** — after the existing per-teacher report, sends a **separate**
   board message (their groups; weekly + all-time top-5, copy-paste-ready) with a Mini App button.
   Admins get the teacher roll-up (unchanged) + a separate groups roll-up message + Mini App button.
3. **`tg-group-board` edge fn + `/tg/group-board` Mini App** — opened from the DM button. Reuses the
   `validateInitData()` HMAC pattern from `tg-broadcast`. Teacher sees only their groups; admin gets a
   course picker + all groups. Renders stats + both boards, screenshot-optimized.

## Key decisions (the ones a future session will trip on)

- **XP primitive MUST be `user_group_rating_xp`, never `user_course_xp`.** `group_leaderboard()` and
  `profile_stats().group_rank` were switched to `user_group_rating_xp` in `20260711150000` precisely
  because `user_course_xp` drops daily_active + streak XP (the "555 in account, 390 on board"
  incident). Any student-facing board that shows a *different* number than `/leaderboard` re-opens
  that incident. The weekly board uses the windowed analog so weekly and all-time stay consistent
  (`weekly ≤ all-time`, verified 0 violations on prod).
- **Board is a separate message from the core report.** A `web_app` button or an over-length board
  must never suppress the teacher's core daily report (the `20260711130000` 100%-delivery precedent).
  Core report keeps only the `url` Profil button (byte-identical to pre-feature); the board send is
  isolated with its own `boardSent`/`boardFailed` counters.
- **Web view = Telegram Mini App, not a public signed link.** The teacher/admin opens it to view +
  screenshot; students receive the screenshot, they don't click. Mini App auth (Telegram identity)
  is airtight and reuses existing infra — no new anonymous-link surface to secure.
- **Top-N only, never a bottom list.** Celebratory framing (member-forgiveness rule).

## Safety / health signals

- Kill-switch: `platform_settings.group_board.digest_enabled=false` disables the digest board with no
  deploy; absence of the row (migration not applied) also disables it, so the digest degrades cleanly.
- Read-only: no XP writes anywhere; pure aggregation over `xp_events`.
- DB-visible signals: digest run marker carries `board_sent`/`board_failed`/`groups`;
  `group_board_build_error` (digest) and `group_board_rpc_error` (Mini App) rows on RPC failure.

## Known limitations / follow-ups

- Mini App page (`TgGroupBoard.tsx`) is Uzbek-only; the digest DM is trilingual. Locale parity is a
  follow-up, not a blocker.
- Per-group RPC calls scale linearly with group count (fine for the current ~dozen groups; revisit if
  groups grow into the hundreds).
