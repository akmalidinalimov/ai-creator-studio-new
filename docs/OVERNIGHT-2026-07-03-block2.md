# Improve block #2 — 2026-07-03

Autonomous, all verified (typecheck strict + 39 tests + build), pushed to `main`. **Click Publish in Lovable to deploy.**

| # | Item | Result |
|---|---|---|
| **#8** | Code-split + lazy-load | Main bundle **935 kB → 457 kB** (gzip 286→150). react-vendor / supabase / charts split into cacheable chunks; charts (422 kB) now load only on analytics pages; all authenticated pages lazy behind Suspense. |
| **#1** | Error/retry states | **Dashboard** and **CoursePage** now wrap fetches in try/catch/finally with a cancellation guard + retry button (no more permanent skeletons). Adds to the earlier Leaderboard/Badges/MyActivity/Quiz pass. |
| **#7** | TypeScript strict | Codebase was 4 errors from strict-clean (the 462 `any` are explicit casts strict ignores). Fixed the 4; **`strict` + `noImplicitAny` now ON** in `tsconfig.app.json` → the merge-blocking typecheck enforces strict null checks going forward. |
| **#10** | Auth-gate tests | **9 RequireAuth tests** (loading, unauth redirect, adminOnly/staffOnly matrix). Suite now 39 tests. |

## Deferred (noted, not done)
- **LessonPage / Settings** error-UIs: complex multi-effect pages with existing partial handling — safer to do with review than to restructure unattended.
- **AdminUsers virtualization / pagination**: needs a dep + refactor of a 2,000-line file; too risky unattended.

## Verify caveat
Error/loading-state changes only surface on failure, so they're verified by typecheck + tests + build, not by forcing live errors. The perf win is verifiable in the build output (chunk sizes above).

Still on staging (`genius-loom-space`); the real student platform untouched.
