# Remove certificates, add per-module shareable rewards

## Goal
- Stop the platform from auto-issuing course-completion certificates (we'll hand out custom ones manually, off-platform).
- Reward students after each module with a celebratory in-app modal + a downloadable branded share image they can post to Instagram tagging us.

## Part 1 — Remove certificate system (entirely)

### Frontend
- `src/pages/Settings.tsx`: remove `<CertificateSection />` import and render.
- `src/pages/Dashboard.tsx`: remove `<CertificateCelebrationModal />` import and render.
- `src/pages/CoursePage.tsx`: remove the "View Certificate" button shown at 100% progress.
- `src/components/Layout.tsx`: remove the "🏆 Sertifikatlar" admin nav item (sidebar + dropdown).
- `src/App.tsx`: remove `/verify/:token` route, `/admin/certificates` route, `VerifyCertificate` and `AdminCertificates` imports.
- Delete files: `src/components/CertificateSection.tsx`, `src/components/CertificateCelebrationModal.tsx`, `src/pages/VerifyCertificate.tsx`, `src/pages/admin/AdminCertificates.tsx`.
- `src/pages/Leaderboard.tsx`: remove the certificates query and any cert-based badge column.
- `src/pages/admin/AdminDashboard.tsx`: replace the "course completions = certificates count" tile with a query that counts students who have completed every published lesson (no certificates table dependency).
- i18n: remove `certificate` / `viewCertificate` keys from `uz.json` / `ru.json` / `en.json`.

### Backend
- `supabase/functions/notify-completion/index.ts`: delete the PDF certificate dispatch block (the `generate-certificate` fetch + `sendDocument`). Keep the course-complete Telegram message and the share image (or remove that too — see Part 2 share-image cleanup).
- Delete edge functions: `supabase/functions/generate-certificate/`, `supabase/functions/generate-share-image/` (the latter is course-level; we replace it with a per-module variant). Remove their `[functions.generate-certificate]` block from `supabase/config.toml`.
- DB migration: drop `public.certificates` table (and its policies). Confirm with user before destructive drop — fallback option below.

### Migration safety fallback
If the user wants to retain history of who finished the course, instead of dropping the table we can simply leave it untouched and rely on UI removal. Default in this plan: **drop the table** since the user said remove entirely.

## Part 2 — Per-module shareable reward

### Trigger
Already exists: `notify-completion` runs on lesson completion and detects `isLastLessonInModule`. We hook into that path.

### New edge function: `generate-module-share-image`
- Input: `{ user_id, module_id, locale }`.
- Generates a 1080x1080 PNG via Lovable AI Gateway (`google/gemini-2.5-flash-image`) using a prompt like:
  > "Create a celebratory Instagram-square card. Brand: AI Creators (purple/violet gradient, modern). Big headline: 'Module {N} completed!'. Subhead: student full name. Footer: '@aicreators_uz' handle. Clean, bold typography, no extra text."
- Returns the PNG bytes (same pattern as old `generate-share-image`).
- Deployed with `verify_jwt = false`; called server-side from `notify-completion` and from the frontend modal via `supabase.functions.invoke`.

### Telegram side (in `notify-completion` module-complete branch)
- After the existing module-complete text message, send the generated PNG with a caption:
  - UZ: "Modul {N} tamomlandi! Instagram'da @aicreators_uz ni tag qiling 🎉"
  - RU/EN equivalents.
- Include an inline button: "📸 Instagram'da ulashish" linking to `https://www.instagram.com/` (Instagram has no prefilled web share — best effort: copy caption to clipboard via the in-app modal).

### Frontend celebration
- New table `module_celebrations` (`id, user_id, module_id, image_url, created_at, seen_at`) so the modal pops once per module per user. Image uploaded to a new public storage bucket `module-shares` after generation.
- New component `ModuleCelebrationModal.tsx` mounted in `Dashboard.tsx` (replaces the deleted `CertificateCelebrationModal`):
  - Polls `module_celebrations` where `seen_at IS NULL` for the current user.
  - On open: shows the PNG, copy-caption button (caption pre-written with hashtags + tag), download button, "Open Instagram" button (deep link `instagram://library?AssetPath=` on mobile, fallback to web), "Share to Telegram" button.
  - Sets `seen_at` on close.
- Storage migration: create public bucket `module-shares` with read-anon policy, insert by service role only.

### CoursePage UI
- Replace the removed certificate button with a small "🎉 Modul X tugatildi" badge / link to re-open the celebration modal for that module.

## Part 3 — Verification
- Build passes (no broken imports after deletions).
- Manually complete the last lesson of a module in test → check edge logs for `module-share` generation, modal renders, image downloadable.
- Confirm `/verify/:token` and `/admin/certificates` return 404 in the SPA.

## Technical notes (for the dev)
- Storage upload from the edge function: `supabase.storage.from('module-shares').upload(\`${user_id}/${module_id}.png\`, bytes, { upsert: true, contentType: 'image/png' })`, then `getPublicUrl`.
- Re-use the existing `magicLink()` helper for any deep links inside Telegram.
- Keep `nudge_module_celebrations` (separate weekly DM nudge) as-is; it's unrelated.
- All new colors/styling for the modal must use semantic tokens from `index.css`.

## Open items needing user confirmation
1. **Drop `certificates` table?** If yes, all historical issued certs are gone. Confirm before running the destructive migration.
2. **Instagram handle** to bake into the share image and caption (e.g. `@aicreators_uz`)?
3. **Image style/branding** — happy with AI-generated card, or should we use a fixed PNG template + overlay student name via canvas/svg in the edge function (more deterministic)?
