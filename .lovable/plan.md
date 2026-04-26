
# AI Creators — Online Course Platform

A modern, minimalist course SaaS in the spirit of Stripe / Kajabi / Skool. Light mode only, Inter typeface, neutral palette (white, near-black `#0a0a0c`, greys), soft shadows, generous spacing, mobile-first (375 / 768 / 1280).

Built on the default stack: React + TypeScript + Vite + Tailwind + shadcn/ui + Lovable Cloud (Supabase). AI features use Lovable AI. Emails use Lovable Emails.

---

## Phase 1 — Core build (this plan)

### 1. Database & security (Lovable Cloud)
- Tables: `profiles`, `courses`, `modules`, `lessons`, `enrollments`, `lesson_progress`, `lesson_notes`, `lesson_bookmarks`, `lesson_ratings`, `lesson_comments`, `quiz_questions`, `quiz_attempts`, `ai_chat_messages`, `streaks`, `email_events`.
- Roles in a separate `user_roles` table with `app_role` enum (`admin`, `student`) and a `has_role()` security-definer function — never on profiles (prevents privilege escalation).
- RLS on every table: students can only read/write their own data; admins can read everything via `has_role()`.
- Auto-create profile + default `student` role + auto-enroll into AI CREATORS via trigger on `auth.users` insert.
- Private storage buckets: `lesson-videos`, `lesson-resources`, `avatars`. Signed URLs for video playback.

### 2. Authentication
- Email + password, Google OAuth, magic link toggle on login/signup.
- Email verification required; resend link from /login.
- /forgot-password → /reset-password flow.
- Remember-me checkbox; rate-limit failed logins client-side + edge function.
- Post-login routing: admin → /admin, student → /dashboard.
- 5-step onboarding for new students (name confirm → goals → weekly study target → timezone → start first lesson).
- Seed accounts auto-created on first run: `admin@aicreators.io` / `admin123`, `student@aicreators.io` / `student123`. (Note: convenience-only — change before sharing.)

### 3. Public pages
- `/login`, `/signup` — split layout, dark left brand panel, right form. Google + magic link + forgot password.
- `/forgot-password`, `/reset-password`, `/verify-email`.

### 4. Student experience
- **/dashboard** — welcome + 🔥 streak, enrolled course grid with progress %, "Pick up where you left off" jumping to last video timestamp, weekly study target widget, recent activity feed, account summary.
- **/course/:courseId** — hero, sticky right sidebar (circular progress, stats, Continue CTA, certificate when 100%), expandable module list with checkmarks, end-of-module quiz buttons, reviews section.
- **/lesson/:courseId/:lessonId** —
  - HTML5 video player with signed URL, 0.5x–2x speed, captions, resume from saved position, autosave position every 5s, auto-complete at 90% / end / Next.
  - Tabs: Description · Notes (autosave, "Insert timestamp" button) · Bookmarks (jump-to) · Resources · Discussion (threaded comments, edit/delete own) · Transcript (synced highlight, click-to-jump).
  - Star rating, prev/next, manual mark complete, breadcrumb.
  - Sticky right sidebar: full course outline with checkmarks + collapsible **AI Study Assistant** chat (lesson-aware, quick-action chips: explain / 3 practice questions / summarize / I'm stuck). Powered by a `study-assistant` edge function calling Lovable AI Gateway. History saved per lesson.
- **/quiz/:moduleId** — multiple choice, instant feedback, score, retry, 80% pass.
- **/settings** — profile, password, notifications, study schedule, timezone, danger zone.
- **/search** — full-text search across lessons/notes/comments.
- **/certificate/:courseId** — basic printable certificate page (full PDF generation deferred to Phase 2).

### 5. Admin (`/admin`, role=admin)
Tabs: Overview · Students · Courses · Settings (Analytics deferred to Phase 2).
- **Overview** — stat cards (total students, active 7d, new signups 7d, enrollments, completions, avg rating, avg streak) + signup/active/completed-per-day charts + at-risk students table with one-click re-engagement email.
- **Students** — table (avatar, email, course badges, progress %, last active, streak, status) with:
  - "+ Add student" modal (auto temp password, copy button, assign course, send welcome email).
  - **CSV import** — drag-and-drop, preview parsed rows with validation (duplicate/malformed email), valid/invalid counts, progress bar during import. Creates accounts via an admin edge function using the service role + auto-enrolls + optional credentials email.
  - Bulk actions (assign course, deactivate, send email).
  - Row actions: Manage, Reset password, Toggle access, View progress, Activate/Deactivate, Remove (cascade).
- **Courses** — list with publish toggle. Per-course editor with drag-and-drop module/lesson reordering, inline add. Lesson editor: title/description/position, video source toggle (Upload to `lesson-videos` with progress + auto-detect duration | Embed YouTube/Vimeo URL), resources upload, quiz editor (questions, options, correct answer, explanation). Auto-transcript button stubbed in Phase 1 (button + manual paste field; Whisper integration in Phase 2 — Lovable AI doesn't expose Whisper).
- **Settings** — basic course-platform name + default-course-on-signup. (Branding/email-template editor deferred to Phase 2.)

### 6. Emails (Lovable Emails)
Auth emails (verification, magic link, password reset) handled by built-in auth templates. Transactional templates via the built-in system:
- Welcome email after signup (points to first lesson).
- New-student-added (admin creates account → credentials + login link).
- Lesson reminder (when study schedule set).
- Re-engagement nudge (sent via the at-risk one-click button in admin).
- (Weekly digest, scheduled re-engagement at 7/14/30d, certificate-completion email — deferred to Phase 2 since they need scheduled jobs.)

### 7. AI Study Assistant
Edge function `study-assistant` calls Lovable AI Gateway (`google/gemini-3-flash-preview`) with the lesson title + description + transcript as system context. Streams responses. Saves history in `ai_chat_messages` per lesson. Quick-action chips above the input. Handles 429/402 with friendly toasts.

### 8. Seed content
The full **AI CREATORS** course: 5 modules × 4 lessons (titles per spec), 14 hours, every lesson uses the BigBuckBunny placeholder MP4 until real video is uploaded, 3 sample quiz questions per module.

### 9. Quality bars
- Mobile responsive at 375 / 768 / 1280 (verified on dashboard, course, lesson, admin students, CSV import, AI chat).
- Loading skeletons on every fetch, optimistic mutations, toast notifications, empty states with next action, inline form validation, accessible labels/focus rings/keyboard nav, captions on video.
- Subtle motion: fade-in on route change, smooth progress fills.

### 10. Ship
- Self-test the spec'd flows (signup, complete a lesson, ask AI a question, admin add student, CSV import, video upload).
- Publish to a free `*.lovable.app` subdomain.
- Reply with the live URL, both seed credentials, and a one-paragraph summary.

---

## Phase 2 — Advanced (next message after Phase 1 ships)
Certificate PDF generation · Analytics tab (cohort retention, watch-retention curves, funnel, heatmap, search analytics) · 2FA TOTP · PWA installable + offline shell · Branding settings (logo, primary color) · Email template editor with live preview · Whisper auto-transcripts (needs OpenAI key) · Scheduled email jobs (weekly digest, 7/14/30-day re-engagement, certificate completion) · Welcome email + first-lesson nudge if not in Phase 1 transactional setup.

---

**You'll want to try first:** sign in as `student@aicreators.io / student123`, click into the AI CREATORS course, play a lesson and watch progress save, then ask the AI Study Assistant "give me 3 practice questions". Then sign in as `admin@aicreators.io / admin123` and try the CSV import in /admin → Students.
