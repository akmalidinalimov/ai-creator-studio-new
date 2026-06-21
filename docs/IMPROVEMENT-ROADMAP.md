# Improvement Roadmap & Build Spec — 2026-06-22

_Companion to `docs/PLATFORM-ASSESSMENT-2026-06-22.md`. Every task is scoped to be independently **testable, deployable, and verifiable**. Phases are ordered so each one rests on a stable foundation. Per the owner's decision, **robustness comes first**; features and the hosting migration come after the foundation is trustworthy._

**Guiding principle (the cure for "fix one → break another"):** for every duplicated business rule, collapse it to **one server-authoritative implementation**, then **lock it with a test + merge-blocking CI** so a future change can't silently desync the copies.

---

## Phase 0 — Stop-the-bleeding security & config (2–4 days)

Close the highest-severity, lowest-effort holes (account takeover, free access to paid content, production lockout on redeploy) before touching features. Each task ships independently.

| # | Task | Verify |
|---|---|---|
| 0.1 | **Kill the paid-tier self-enrollment bypass** (M04): make the `enrollments` INSERT RLS policy admin-only (or force the lowest tier via BEFORE-INSERT trigger); change `has_module_access` so a NULL tier on a **non-admin** enrollment is **not** "unlimited." | As a low-tier student, `insert` a paid-course enrollment → rejected; `has_module_access` returns false for a locked module. Add an RLS test asserting both. |
| 0.2 | **Stop leaking lesson video identifiers** (M05): remove `provider_video_id`/`video_url` from the broad `lessons` SELECT (separate table or SECURITY DEFINER view); route playback exclusively through the `lesson-video-url` edge function. | As anon/unenrolled, query `lessons` via REST → video columns absent; enrolled student still plays via the edge function only. |
| 0.3 | **Fix `config.toml`** (M11): delete the duplicate `admin-create-students` block; add explicit `verify_jwt` for `login-guard`/`telegram-auth`/`log-auth-event`; add a CI script asserting unique `[functions.*]` keys + an explicit `verify_jwt` per function. | CI script passes on the fixed file, fails if a duplicate/missing entry returns; redeploy a function and confirm password login still works. |
| 0.4 | **Block the superadmin lockout** (M13): make AuthContext + RequireAuth treat `superadmin` as ≥ admin (or remove it from role pickers + the `admin-change-role` whitelist). | Promote a test user to `superadmin` only → they still load `/admin/*`. Parity unit test: every assignable role is handled by both the resolver and the route guard. |
| 0.5 | **Stop admin-creation privilege escalation** (M12): `admin-create-students` rejects `role='admin'` unless caller is superadmin (route grants through `admin-change-role`). | As a plain admin, attempt to create/promote an admin → 403; as superadmin → succeeds. Deno test covers both. |
| 0.6 | **Remove the `bunny-sign` verify/debug oracle** (M19); standardize the internal secret on Vault `internal_fn_secret()` (fail closed on empty). | No `secret_*` fields in any response; `generate-module-share-image` still authorizes via the Vault secret; Deno test asserts 403 without the secret. |
| 0.7 | **Get the create-student secret out of the browser** (M18): gate `/intake` behind `RequireAuth` staffOnly using the admin-JWT path; keep `x-sheet-secret` only for the server-side Apps Script; add per-IP rate limiting to public `sheet-sync`. | `/intake` requires a staff session; `admin_actions.actor_user_id` is populated for intake creates; load-test `sheet-sync` → rate limiting triggers. |

---

## Phase 1 — ROBUSTNESS FIRST: single sources of truth + tests + CI (3–4 weeks)

Stabilize exactly the systems that "break when you fix something else" — homework grading, student stats, streaks/rewards — by collapsing every duplicated rule to one server-authoritative implementation, then locking it with CI.

| # | Task | Verify |
|---|---|---|
| 1.1 | **Stand up CI** (M01): GitHub Actions on PR+main running `npm ci`, lint, `tsc --noEmit`, `vitest`, `deno test` for edge functions, and build — all merge-blocking. Wire in the two orphaned Deno tests. | Open a PR with a failing test + a type error → CI blocks merge. Bot homework Deno tests run in CI. |
| 1.2 | **Add a typecheck script** + enable `strictNullChecks` behind a ratcheting baseline. | `npm run typecheck` passes on baseline; introduce a null-deref → it fails. |
| 1.3 | **Consolidate lesson completion** behind ONE server RPC `mark_lesson_complete(lessonId)` that owns the threshold + fires the completion/cert/celebration hook (M02); delete the 4 direct `lesson_progress` upserts in `LessonPage.tsx`; treat client signals as advisory. | Unit-test `watchedEnough()` + a client/server threshold-parity test; complete a lesson via each former path → exactly one `completed_at` write + one celebration; `daily_watch_summary` still accumulates. |
| 1.4 | **Unify homework grading** behind ONE SECURITY DEFINER RPC `grade_homework_submission` that atomically writes `score` (re-validating ≤ max), resets `score_is_stale`, sets `stats_dirty_at`, writes audit, enqueues the student notification (M09); call from BOTH web and bot; revoke direct client UPDATE on score columns. | Integration test: grade via web → `stats_dirty_at` set + notification enqueued (catches today's bug); `score=999` → rejected. |
| 1.5 | **One source of truth for effective grade/leaf** (M08): make the SQL view canonical; web + bot + `/ttop` read it via RPC; delete the 3 hand-synced copies + 4 inline bot copies + legacy raw views; repoint the 3 teacher-stats views. | Extend `homework-stats-parity` into a 3-way lock (web == bot == SQL) over fixtures, in CI; `/ttop` and `/galaba` give identical rankings for a resubmitting student. |
| 1.6 | **Build the stats propagation backbone** (M07): triggers set `profiles.stats_dirty_at` on grade/completion/group/archive/enrollment changes; add `recalc_user(uid)` UPSERT + a 2–5 min incremental cron + nightly full recalc; switch `recalc_leaderboard` off full-DELETE to UPSERT. | Grade one student → `leaderboard_cache` updates within the incremental interval (not 15 min), never momentarily empty; `verify_stats_parity` passes. |
| 1.7 | **Rebuild the streak engine** as a pure recompute-from-genuine-activity function (M20): fix freeze-fakes-continuity + the UTC-write/Tashkent-read off-by-one; collapse to one advance function; stamp `watch_date` in Tashkent + backfill. | SQL unit tests for 2-day-gap-with-1-freeze, 00:00–05:00 activity, and the tz boundary; a genuinely inactive student's streak decays correctly. |
| 1.8 | **Add `update_id` idempotency** to the bot webhook (M10): UNIQUE table + `ON CONFLICT DO NOTHING` → early 200; route the 4 inline leaf/grade reimplementations through shared helpers. | Replay the same `update_id` twice → attempt bumped once, teacher notified once, `group_message_events` increments once. |
| 1.9 | **Capture all live crons into idempotent migrations** (M06): dump `cron.job` from prod first; jobname-guarded; add a CI diff asserting committed == scheduled. | Rebuild the DB from migrations on ephemeral Postgres → every required cron + final function bodies exist; CI diff green. |
| 1.10 | **Add the 7 missing foreign keys** (ON DELETE CASCADE) after a one-time orphan cleanup (M14); fix system-path audit logging (nullable actor + system sentinel; log before destructive ops; alert instead of swallow). | Delete a test student → no orphan rows remain; run a `sheet-sync` import → an audit row is written. |
| 1.11 | **Make notifications reliable** (M17): send only after checking Telegram `resp.ok` (auto-disable on 403, back off on 429); enqueue no-teacher submissions to admins immediately; reserve the delivery row before sending in `re-engagement-send`. | Mock a 403 → `last_*_at` not stamped, `notifications_enabled` flips false; submit in a teacher-less group → admin DM'd within a minute; double-invoke a campaign → no duplicate sends. |
| 1.12 | **Harden `study-assistant`** (M15): whitelist chat roles to user/assistant; cap message + history size; add `max_completion_tokens`; per-user rate limit; enrollment check before knowledge retrieval (via `auth.uid()` inside `match_ai_knowledge`). | POST `role:'system'` → stripped; request another course's `lessonId` → no cross-course chunks; exceed rate limit → throttled. |
| 1.13 | **Extract a `supabase/functions/_shared` module** (M27): cors, `requireAdmin`/`requireSuperadmin`, internal-secret guard, tg-send-with-`resp.ok`, mint-session, grade helpers; adopt across functions; per-function 403-without-secret/JWT Deno tests. | All functions import `_shared`; Deno contract tests assert 403 on bad secret + correct CORS per function. |

---

## Phase 2 — Make impersonation & access truly server-side (1 week)

Convert the remaining client-trust boundaries to server invariants — a prerequisite for safely issuing certificates/rewards.

| # | Task | Verify |
|---|---|---|
| 2.1 | **Impersonation as a server concept** (M03): mint the session with an `impersonated_by` JWT claim; mark the magic-link row as impersonation; enforce read-only in RLS/edge functions (reject writes when the claim is present); audit-log every attempted write; demote the client guard to UX-only. | While impersonating, attempt a write via `functions.invoke` and via storage (paths the client guard misses today) → SERVER rejects; clear the localStorage flag → writes still blocked. |
| 2.2 | **One shared `clearImpersonation()`** called from `signOut()`, banner Exit, and error paths; stop persisting the admin refresh token in `localStorage`. | Exit via normal logout → `impersonating` + `imp_admin_backup` cleared, next user not read-only; no admin token in `localStorage`. |
| 2.3 | **Route destructive admin mutations** (M25) (group delete, course reassign, member remove, assignment delete, publish toggle, bulk role/archive) through SECURITY DEFINER RPCs/edge functions that write `admin_actions` server-side. | Reassign a group's course + delete a group → both appear in the audit log; client can't perform them without the logged RPC. |

---

## Phase 3 — Certificates on module completion (1–1.5 weeks)

Owner requirement #2, built on the now-reliable single completion signal, server-authored so it can't be forged or skipped.

> **Note:** a full certificate system was previously **built then deleted** (`20260503054526` created it; `20260508085820` + `20260510083957` dropped it "per user request"). We reuse the proven `generate_certificate_serial()` (Tashkent-dated, `AIC-YYYYMMDD-NNNN`) but model **per-module**, not one-per-profile.

| # | Task | Verify |
|---|---|---|
| 3.1 | Add a per-`(user, module)` `certificates` table (sequence-backed serial, `verification_token`, `issued_at`, `updated_at`/version for renew, `revoked_at`, `image_url`, `pdf_url`) with `UNIQUE(user_id, module_id)` and a token-scoped anon verify policy (no `USING(true)` PII leak). | Insert two certs for the same user/different modules → UNIQUE holds, serials don't collide under concurrent issuance (parallel-insert test). |
| 3.2 | Issue/renew from the consolidated `mark_lesson_complete`/`notify-completion` module-complete branch (tier-aware module count) + a daily reconciliation cron that backfills any missed cert (reuse the old backfill loop). **Prefer the edge-function hook + reconciliation cron over a raw DB trigger** (the trigger is what got it dropped before). | Complete a module's last lesson → exactly one cert issued; re-complete → renew (version bumps), not a duplicate; delete a cert → reconciliation cron re-issues it. |
| 3.3 | Build a **deterministic** certificate renderer (SVG/HTML → PNG via `satori`/`resvg`, **not** the generative model) + a `/verify/:token` public page + a "My certificates" list in the app. | Generate a cert → name/serial render legibly and identically across runs; `/verify/<token>` validates; revoke → shows revoked. |

**Open product decision:** "renew" = one evolving progress certificate, or one cert per module? (Spec assumes one per module.) Also: certs print `profiles.name`, which is `"Talaba"` for many students (audit H5) — **fix names first** or certs are unusable.

---

## Phase 4 — 9×16 image rewards + more gamification (2–3 weeks)

Owner requirements #3 and #4, once the reward asset model is versioned and the stats it reads are reliable.

> **Current state:** badges are bare **emoji icons**; the only image reward (`module_celebrations`) is a hardcoded **1:1 square 1080×1080** AI image. The audit's "7 share-card templates" **do not exist in the repo** — only one hardcoded AI prompt. Recommended: a **deterministic template system**, not non-deterministic AI (which mis-renders names/text at 9×16 — bad for something students share publicly).

| # | Task | Verify |
|---|---|---|
| 4.1 | Make the reward pipeline **format-aware** (M22): add `format`/`aspect`/`template_version` columns + cache key to `module_celebrations`; parameterize the generator to **9×16 (1080×1920)**; lock the modal/Badges containers to `aspect-[9/16] object-cover` with skeleton + broken-image fallback. | Generate a reward after the change → a new 9×16 asset (not the frozen square); modal renders portrait without overflow. |
| 4.2 | **Unify badges + rewards** under one asset concept (badges gain optional `image_url`; grid renders image-or-emoji); switch `notify-badge-award` to `sendPhoto` for image rewards. | Add an `image_url` to one badge → renders as image in `Badges.tsx` + DM'd as a photo; emoji fallback still works for others. |
| 4.3 | Extract shared gamification hooks (`useBadges`/`useStreak`/`useLeaderboard`) + one `pickLocalized()` helper (kills 3+ duplicate fetches); add a scoped **quest/XP layer** (quests + `user_quest_progress` + xp ledger) evaluated off the **reliable** signals, respecting `nudge_preferences`/rate limits. | All gamification pages read one cached source; award a quest → progress + a single DM; opted-out users get no DM. |
| 4.4 | Make leaderboard reads safe + motivational: remove `as any` RPC casts (regenerate types), add error/loading/empty states, lock direct `leaderboard_cache` reads to admin-only, add "N points behind next rank." | Force the RPC to error → error state (not fake "no data"); a student can't directly select `leaderboard_cache`. |

**Scope note:** "more gamification" is open-ended — narrow to **2–3 mechanics first** (the `docs/gamification-plan.md` top-10). Building progression on stale stats feels broken, so this **depends on Phase 1.6**.

---

## Phase 5 — Video engagement + i18n + UX polish (1–2 weeks)

Owner requirement #5, plus the cross-cutting UX/i18n debt — now that the data underneath is trustworthy.

| # | Task | Verify |
|---|---|---|
| 5.1 | Fix the Bunny tracking contract (route purely through `onBunnyTime`/`onBunnyEnded`, pass `duration_seconds` fallback, gate player mount until stored progress resolves for correct resume); add a Dashboard "Continue watching" resume card + per-lesson progress bars + autoplay-next. | Resume a lesson → starts at saved position; completion fires even when `player.js` never reports duration; resume card deep-links correctly. |
| 5.2 | Localize the hardcoded-Uzbek student surfaces (M24) (bottom nav, gamification, homework, nudge, digest, celebration, settings) into uz/ru/en; add a CI i18n-parity + no-hardcoded-literal lint gate. | Switch to RU → nav, badges, homework, celebration translated; CI fails if a new hardcoded literal is added. |
| 5.3 | Add route-level error boundaries + try/catch + retry to learning/dashboard effects; replace N+1 sequential queries with batched RPCs; standardize loading/empty/error states across Quiz/Badges/Leaderboard/Homework. | Mock a Supabase error → error+retry (not infinite skeleton); dashboard issues one batched query, not 2×N. |

---

## Phase 6 — Managed-hosting migration off Lovable (1 week, optional/later)

Remove the shallow Lovable lock-in and move to owned managed hosting once the platform is stable and test-covered.

| # | Task | Verify |
|---|---|---|
| 6.1 | Remove the 4 Lovable hooks: delete `lovable-tagger`; replace Signup Google OAuth with native `supabase.auth.signInWithOAuth` (register a Google client in Supabase Auth); re-point `generate-module-share-image` + `study-assistant` fallback to a direct AI provider; re-point `weekly-digest` to `api.telegram.org`. | Build with no `lovable-*` deps; Google sign-in works end-to-end; generate a share image + send a weekly digest via the new providers. |
| 6.2 | Provision Supabase Pro + Vercel/Cloudflare; `supabase db push` all migrations; migrate data in a maintenance window; deploy all edge functions with `verify_jwt` flags; **reproduce every live cron job from committed migrations**. | On the new project: smoke-test login (email/Google/Telegram), video playback, homework submit → teacher notify, leaderboard recalc, weekly digest dry-run, AI tutor; `cron.job` matches the committed set; keep the old project read-only for rollback. |

---

## Feature specs (scaffolding · gap · approach · effort)

| Feature | Already there | Gap | Approach | Effort |
|---|---|---|---|---|
| **1. Certificates (issue + renew per module)** | Full system built then **dropped** (`20260503054526` → dropped `20260508085820`/`20260510083957`); proven `generate_certificate_serial()`; `module_celebrations` + `course_complete` badge are the live analog | No cert table/trigger/render/verify/UI today; old design was one-per-profile, you want per-module | Re-introduce per-`(user, module)` table; `issue_or_renew_certificate()` UPSERT driven from `notify-completion`'s module-complete branch (where share-image already fires); deterministic render; `/verify/:token`; reconciliation cron | 5–8 d |
| **2. Rewards as 9×16 images** | `module_celebrations` AI share image (but **1:1 square**); badges are **emoji**; "7 templates" **do not exist** | No portrait asset anywhere; reward visuals split (emoji vs square AI) | Short path: switch generator to 9×16. Robust path: a `reward_templates` catalog rendered deterministically via `satori`+`@resvg/resvg-js`, reused across badges/modules/certs; backfill | 4–7 d |
| **3. More gamification (quests/levels)** | Cosmetic level **labels** on the score, streak milestones, 8 badges + award engine, daily goal, `docs/gamification-plan.md` (unbuilt) | No quests/missions, no real XP/level table, no point store, web is a static badge grid; bot-only & read-only | Add `quests` + `user_quest_progress` + xp ledger evaluated off existing triggers/crons; formalize level bands; web Quests page + mini-leaderboard context; respect `nudge_preferences` | 8–14 d |
| **4. Higher video engagement** | Bunny signed iframe + resume + 5s tick + auto-complete; `track_video_progress` RPC; engagement crons; AI in-lesson chat | 3 client paths bypass the canonical RPC (skip watch-time + cert hook); hardcoded anon JWT in the RPC; no resume surface, no quiz-gate, no rewatch incentive | First HARDEN the signal (route all completion through the RPC, vault the secret), then add: prominent "Continue watching," post-lesson micro-quiz gate, progress bars, watch-streak quests, smarter `/davom` resume nudges | 5–9 d |
| **5. Hardened homework verify/submit** | Strict Telegram media gate + per-student intent attribution + already-graded short-circuit + resubmission RPC; canonical effective-grade lib; hardened RLS | No in-app submission, no mime/size/duration validation; `/vazifalar` shows raw not effective (H1); teacher-less groups notify nobody (M2); web lacks shared-topic fallback (M4) | Align `/vazifalar` to effective; validate Telegram file mime/size/duration at ingest; fix silent failures (M2/M7/M4); optional in-app upload fallback; clear submission state machine; drift test pinning bot==web | 4–7 d |
| **6. Hardened student statistics** | Effective homework avg unified (web/bot/SQL); `recalc_leaderboard` corrected (UPSERT-by-rank, exclude archived); `verify_stats_parity` shadow tooling; streak tz partly fixed | The auto-propagation backbone (`stats_dirty_at` read by nothing) was never built → everything ≤15 min stale + momentarily empty; teacher stats divergent; cron drift; no parity in CI | Build dirty-flag triggers + `recalc_user(uid)` + incremental cron; switch off full-DELETE; converge teacher stats onto the effective lib; reconcile crons into migrations; land `verify_stats_parity` in CI | 6–10 d |

---

## Open product decisions (needed before the dependent phase)

1. **Certificate "renew" semantics** (blocks Phase 3): one evolving progress certificate, or one per module? _Recommend: one per module._
2. **Default access tier for self-signups** (blocks tier enforcement in Phase 0.1): which tier does a self-registered student land on? _Depends on your sales funnel._
3. **Student-name quality** (blocks Phase 3 + social features): many `profiles.name` are `"Talaba"`. A one-time name-confirmation flow is needed before certificates/share-cards are usable.
4. **Gamification scope** (Phase 4): pick the first 2–3 mechanics from `docs/gamification-plan.md` rather than "everything."
5. **Who maintains the code long-term** (informs how much de-monolithing/tests to front-load).

## Suggested execution order

**Phase 0 → Phase 1 → Phase 2** are the robustness foundation and should ship in order. **Phase 6 (hosting)** can happen any time after Phase 1. **Phases 3–5 (features)** can be re-ordered to your priorities once the foundation is in place — e.g. if certificates are the most business-critical, do Phase 3 right after Phase 2.
