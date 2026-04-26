# v1.2 Plan — AI Creators Production Upgrade

Big release. I'll group the work into 7 phases shipped in a single build, then run the self-test you specified. Below is exactly what changes, with the technical decisions called out so you can sanity-check before approval.

---

## Phase 0 — Database migration (foundation for everything)

One migration adds:

- `lessons.published bool default false`, `lessons.video_provider text` (enum-like: `upload|youtube|vimeo|mux|bunny`), `lessons.provider_video_id text`, `lessons.thumbnail_path text`
- `courses.published` already exists (default `true`) — change default to `false` for new courses; keep existing seed course Published.
- `profiles.telegram_username citext unique nullable`, `profiles.telegram_id bigint unique nullable`. Enable `citext` extension.
- New table `auth_events (id, user_id, event text, created_at, ip text nullable, user_agent text nullable)` with RLS: insert-own + admin-read.
- New table `platform_settings (key text pk, value jsonb, updated_at)` with admin-only RW (used for Telegram bot username; bot token stays in Supabase secrets).
- New storage buckets: `course-covers` (public), `lesson-thumbs` (public, immutable cache 1y).
- **Indexes**: `lesson_progress(user_id, lesson_id)`, `lesson_progress(user_id, completed_at)`, `enrollments(user_id)`, `profiles(telegram_username)`, `user_roles(user_id)`, `lessons(module_id, position)`, `modules(course_id, position)`.
- **RLS update on `lessons`**: students see only `published = true` lessons in published courses; admins see everything (uses `has_role`).
- **RLS update on `courses` SELECT**: already `published OR has_role(admin)` — keep.
- Trigger: on `lesson_progress` upsert, recompute and update `streaks` for that user.

Note: the currently seeded 20 lessons will be backfilled to `published = true` so nothing disappears for existing students.

---

## Phase A — Admin: Course / Module / Lesson editor with video upload

**Nav restructure** (`Layout.tsx`):
- Student nav: `Dashboard` only (Search link removed).
- Admin nav: `Dashboard` · `Courses` · `Users` · avatar.
- Remove `/search` route entirely.

**New pages:**
- `/admin/courses` — card grid of all courses with cover, lesson count, total duration (sum of `lessons.duration_seconds`), Published toggle (instant), last edited, "Edit" button, "+ New course" modal (title, tagline, description, cover upload to `course-covers`). New courses default to Draft and redirect to editor.
- `/admin/courses/:courseId` — the editor:
  - Header: inline-edit title/tagline, rich-text description (using a lightweight Tiptap setup or a markdown textarea + preview — I'll go with **Tiptap StarterKit** since it's already React-friendly and small), cover with crop (using `react-easy-crop`), Published toggle, "View as student" link (opens `/course/:id` in new tab).
  - Modules list: `@dnd-kit/sortable` drag handles, inline-editable titles, expand to show lessons, "+ Add module" appends blank.
  - Lessons list per module: drag-sortable, status badge (Has video / No video / Draft), Edit button.
  - **Lesson editor drawer** (slides from right):
    - Tabs: **Upload video** | **Embed URL** | **Resources** | **Settings**
    - **Upload tab** — dropzone (react-dropzone). Uses `supabase.storage.from('lesson-videos').uploadToSignedUrl()` with a signed upload URL minted via `createSignedUploadUrl()` so chunks go **directly** browser→storage (no edge function in path). Shows filename, size, MB/s, ETA, progress, Cancel. On complete: hidden `<video>` reads `duration` and `canvas.toBlob()` captures a frame at 1s → uploaded to `lesson-thumbs`. Updates `video_storage_path`, `duration_seconds`, `thumbnail_path`, `video_provider='upload'`.
    - **Embed tab** — provider select (YouTube / Vimeo / Mux / Bunny Stream) + URL/ID input. Validates and shows live preview. Saves `video_provider` + `provider_video_id`. Bunny/Mux preview uses **hls.js** with the playback URL pattern documented per provider.
    - **Resources tab** — drag PDFs/slides into `lesson-resources`, list with delete.
    - **Settings tab** — Published toggle, position (read-only auto), Delete (confirm).
  - **Module quiz editor** (collapsible): list of `quiz_questions`, add/edit/delete with options array, correct_index, explanation. 80% pass already enforced.

**Player update** (`LessonPage.tsx`):
- Resolve video source by `video_provider`:
  - `upload` → mint a signed URL via existing `lesson-video-url` edge function
  - `youtube` / `vimeo` → iframe embed
  - `mux` / `bunny` → hls.js with provider playback URL
- Falls back to BigBuckBunny only in dev/empty state.

**Dependencies added**: `@dnd-kit/core`, `@dnd-kit/sortable`, `react-dropzone`, `@tiptap/react @tiptap/starter-kit`, `react-easy-crop`, `hls.js`.

---

## Phase B — Admin: Users page with role assignment

Replace the "Students" tab with `/admin/users`:

- Table columns: avatar/name, email, telegram_username, role badge, status, last login (`auth.users.last_sign_in_at` exposed via a SECURITY DEFINER RPC `get_users_admin()` that joins `profiles` + `user_roles` + `auth.users.last_sign_in_at` — safer than exposing `auth.users` directly), course access badges, progress %, joined.
- Toolbar: search input (filters name/email/telegram_username — replaces broken /search), status filter, role filter, "+ Add user" modal, "Import CSV".
- **Add user modal**: name, email, password (auto-gen + copy), telegram_username (with @ prefix normalizer), **role select**, course multi-select, send welcome email checkbox.
- **CSV import** — extends existing `admin-create-students` function to accept `name,email,password,telegram_username,role`. Live preview table with validation (dupe email, malformed email, invalid role). Per-row success/fail with progress bar.
- **Manage drawer** per row: edit profile, reset password, **role change** (insert/delete `user_roles` row) with confirm modal, course access toggles, activate/deactivate, remove user (cascade via existing FKs — verify cascade is set on enrollments/progress/comments/notes; add ON DELETE CASCADE in migration if missing).

---

## Phase C — Remove broken Search

- Delete `/search` route registration, delete page file, remove nav link in both student and admin views. Search lives only inside the Users table.

---

## Phase D — Telegram login

**Config UI** at `/admin/settings` → Integrations card:
- Field 1: bot username (saved to `platform_settings.telegram_bot_username`, public).
- Field 2: bot token (NOT saved in DB — saved to Supabase secret `TELEGRAM_BOT_TOKEN` via a small admin-only edge function `set-telegram-token` that calls the secrets API). Masked input.
- Help block with @BotFather setup steps and the live domain.

**Login flow:**
- `/login` and `/signup` render 3 buttons: Google · Telegram · email/password.
- Telegram button only renders when `telegram_bot_username` is set in `platform_settings` (fetched once on page load).
- Mounts the official Telegram Login Widget script with `data-telegram-login`, `data-onauth="onTelegramAuth(user)"`. Global handler posts payload to edge function `telegram-auth`.

**Edge function `telegram-auth`** (verify_jwt = false, public):
1. Verify HMAC-SHA256 hash with `SHA-256(BOT_TOKEN)` as key over the data-check-string per Telegram docs. Reject if invalid or `auth_date` > 24h.
2. Lookup `profiles` by `telegram_username` (citext, strip `@`).
3. If found → save `telegram_id`, mint a magic link via `supabase.auth.admin.generateLink({ type: 'magiclink', email })`, return JSON `{ url }`. Frontend does `window.location = url` so the user lands signed in on `/dashboard`.
4. If not found → return `{ error: "No account linked to @username — ask your admin to add you." }` shown as toast on the login page.

**Settings page**: add "Link Telegram" button that mounts the widget for the current user and just saves `telegram_id` + `telegram_username` to their profile (no magic link, since they're already signed in).

---

## Phase E — VPS deploy guide

New page `/admin/deploy`:
- Top: "Connect to GitHub" CTA (links to Lovable's GitHub integration in project settings; we can't initiate it programmatically — the button opens the right Lovable dialog/URL).
- Tabs: **Vercel** · **Netlify** · **Hostinger VPS (Coolify)** · **Cloudflare Pages**.
- Each tab: ordered steps with copy-to-clipboard code blocks. Hostinger tab gets the full Coolify/Dokploy + Cloudflare-in-front recipe with env var list and the Caddy/nginx static-serve fallback.
- Footer note: backend (auth, DB, storage, edge functions) stays on Lovable Cloud; only the React frontend is portable.

Pure docs page — no backend changes.

---

## Phase F — Performance for 500+ students, 30h video

- Indexes (in Phase 0 migration).
- React Query everywhere with `staleTime: 60_000` for course/module/lesson lists; mutations invalidate just the touched query.
- Lesson sidebar fetches only the current course's modules (already does — verified; will keep with React Query).
- Code-split admin routes via `React.lazy` + `Suspense` so students never download the editor bundle.
- Bunny Stream / Mux HLS playback via `hls.js` (Phase A).
- `lesson-thumbs` bucket gets `cacheControl: '31536000, immutable'` on upload.
- Replace the N+1 in `Dashboard.tsx` (loops `await` per enrollment) with a single batched query using `in()` on lesson IDs grouped by course.

---

## Phase G — Admin analytics dashboard

`/admin/dashboard` becomes the new admin landing (replaces Overview tab). Built with **recharts**.

Top stat row: Total students · Logins last 30d · Active (7d) · Course completions.

Charts (all responsive grid):
1. **Daily logins** area chart (last 30d) from `auth_events` where `event='sign_in'`. AuthContext appends a row on every successful `SIGNED_IN` event.
2. **Daily active learners** line chart — distinct `user_id` from `lesson_progress.updated_at` per day.
3. **Module engagement pie** — slice per module of selected course; size = distinct students with ≥1 completed lesson in that module. Soft palette, hover tooltip with % of enrolled.
4. **Module completion funnel** bar chart — students who completed ALL lessons in each module, with red drop-off delta labels between bars.
5. **Lessons completed per day** bar chart (last 30d).
6. **Stuck students table** — last `lesson_progress` > 7 days AND course progress < 100%. Columns: name, last completed lesson, days idle, progress %, "Send re-engagement email" button (calls a new `send-reengagement-email` edge function using Lovable Emails / Resend default — will use the Lovable email-domain default sender; if none configured, button shows tooltip "Configure email domain first" and links to Cloud → Emails).
7. **Per-module stuck-count** bar — count of students stuck on each module.

Course selector at top filters all charts. All queries go through admin-scoped RPCs (SECURITY DEFINER) to avoid client-side aggregation against RLS.

---

## Quality bars & self-test

- Mobile-responsive at 375 / 768 / 1280 — verified on the new course editor, lesson drawer, Users table, dashboard charts.
- Loading skeletons + sonner toasts on every mutation.
- Inline form validation (zod where it matters).
- `@dnd-kit` activates with touch sensors + 200ms long-press for mobile drag.
- Existing seed course untouched — only `published` defaults change for *new* courses.
- Existing auth and progress tracking unchanged.

After build: I run the 9-step self-test you wrote (create Test Course Beta as draft → upload mp4 → publish → verify as student → promote to admin → CSV import with role+telegram → analytics renders → Telegram settings UI → deploy page renders), then publish.

---

## What I'll need from you (after build, not blocking)

- **Telegram bot token** — only if you want to actually test Telegram login end-to-end. UI will work without it.
- **Bunny Stream or Mux account** — only if you want HLS streaming live now. The Embed tab works without it.
- **Custom email sender domain** — only if you want re-engagement emails to send from your domain instead of the Lovable default.

If you approve, I'll build it all in one go and then run the self-test.