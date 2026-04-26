# v1.3 Plan

## A. Fix AI Study Assistant 503

**Edge function `study-assistant`** — rewrite for resilience:
- Wrap upstream Lovable AI call in retry helper: 3 attempts, exponential backoff (1s/2s/4s) on `5xx` and `429`.
- Model fallback chain: `google/gemini-3-flash-preview` → `google/gemini-2.5-flash` → `google/gemini-2.5-flash-lite`. Switch to next model after one full retry cycle still fails.
- If all fail: return `200 { error, hint, retryable: true, fallback: true }` (not 5xx) so the client can render a clean "Retry" toast instead of `Failed to fetch`.
- Stream wrapper: catch mid-stream errors, append `\n\n_(response interrupted)_` token to the SSE stream, then close cleanly.
- Log every failure to new `ai_chat_errors` table.

**Migration**: create `ai_chat_errors (id, user_id, lesson_id, model, status, error_excerpt, created_at)` with RLS allowing only admins to SELECT, edge function (service role) to INSERT.

**Client (`LessonPage.tsx`)**:
- On non-streaming error or `fallback: true` payload, replace the orphan empty assistant bubble with a "AI tutor is busy" notice and show toast with **Retry** action that re-sends the last user message.

## B. Multilingual + Admin-Trainable Assistant

**Schema**:
- `profiles.preferred_language text default 'en'`
- `courses.ai_system_prompt text`, `courses.ai_knowledge_paths text[] default '{}'`
- `platform_settings` row `key='ai_assistant'` → `{ system_prompt, knowledge_paths[] }`
- New private storage bucket `ai-knowledge` (admin write, edge function service-role read).

**Student UI** — AI panel header in `LessonPage.tsx`:
- Add language `<Select>` with 10 languages (en, ru, uz, es, pt, ar, fr, de, hi, zh).
- Default = `profiles.preferred_language` || `navigator.language.split('-')[0]` || `'en'`.
- On change → `update profiles set preferred_language`.
- Pass `language` in request body to edge function.

**Admin UI** — new card on `/admin/settings`:
- "AI Study Assistant" card: system prompt textarea (with default text & variable hint `{course_title} {transcript} {language}`), knowledge file upload zone (PDF/TXT to `ai-knowledge` bucket), list with delete.
- Per-course override: in `AdminCourseEditor`, add collapsible "AI Assistant (course override)" section with textarea + knowledge upload writing to `courses.ai_system_prompt` and `courses.ai_knowledge_paths`.

**Edge function**:
- Resolve effective prompt: course override → platform default → built-in fallback.
- Read first 8 KB of each referenced knowledge file (use storage `download` + decode text; for PDFs, use lightweight text extraction — parse with `pdf-parse` via esm.sh, falling back to filename if extract fails).
- Substitute `{course_title}`, `{transcript}`, `{language}` placeholders.
- Append `Respond in ${language}.` at the end of the system prompt.

## C. Persistent Telegram Button

Refactor `TelegramLoginButton.tsx`:
- Always render. Two states:
  - **Configured** (RPC returns `bot_username`): mount the official widget as today.
  - **Not configured**: render a styled disabled `<Button variant="outline">` with the Telegram icon, label "Continue with Telegram", `<Tooltip>` "Telegram login isn't configured yet — admin can set it up in Settings → Telegram Login." On click → toast same message.
- Apply on `/login`, `/signup`, `/settings` "Link Telegram" button. Update those three callsites to render the new always-visible variant.

## D. Screen-Recording Protection (lesson page only)

New file `src/components/lesson/ProtectedVideo.tsx` wrapping the `<video>` element. Used **only** by `LessonPage.tsx` (admin lesson preview keeps native controls).

**Schema**: `platform_settings` row `key='content_protection'` → `{ watermark, no_right_click, pause_on_blur, devtools_detect, hardened_controls }` all default `true`. New "Content Protection" card on `/admin/settings` with 5 toggles + the warning text about Mux/Bunny DRM being the only true block.

**ProtectedVideo features (gated by settings)**:
1. **Forensic watermark** — absolutely-positioned `<div>` over the video showing `${user.email} • ${Date.now()}`, opacity 0.35, 13px white with text-shadow, `pointer-events:none`, `z-50`. `setInterval` every 2000ms randomizes one of 4 corners and refreshes the timestamp.
2. **Right-click block** — `onContextMenu` on wrapper + video.
3. **Hardened video** — `controlsList="nodownload noremoteplayback noplaybackrate"`, `disablePictureInPicture`, `disableRemotePlayback`.
4. **Pause on blur** — `window.blur` + `document.visibilitychange` listeners → `video.pause()`.
5. **DevTools detection** — 1s interval comparing outer/inner dims; if delta > 200, pause + render full-cover overlay "Please close developer tools to continue."
6. **Keyboard shortcuts** — keydown listener on document scoped to the lesson route: block Ctrl/Cmd+S, Ctrl/Cmd+P, Ctrl+Shift+S, Cmd+Shift+3/4/5.
7. **CSS** — `select-none` and `-webkit-touch-callout:none` on wrapper.
8. **Signed-URL refresh** — for `video_provider='upload'`, edge function `lesson-video-url` already issues signed URLs; bump expiry to 1800s and add a 25-min `setInterval` that re-invokes the function and swaps `video.src` while preserving `currentTime` + play state.
9. **rAF fps watchdog** — measure frame deltas; if avg fps < 30 for 5 consecutive seconds, fire a one-time toast "Performance drop detected — screen recording or another heavy process may be running." (Don't pause.)

All toggles fetched from `platform_settings` via the `get_public_setting('content_protection')` whitelist (extend RPC to expose this key — non-secret booleans).

## E. Small fixes

- `index.html`: title + og:title + twitter:title → `AI Creators` (also fix description if needed).

## Self-test (after build)

Run the 7-step checklist from the request. Report results inline.

## Files (created / edited)

**Created**: `src/components/lesson/ProtectedVideo.tsx`, migration for `ai_chat_errors`, `profiles.preferred_language`, `courses.ai_system_prompt/ai_knowledge_paths`, `ai-knowledge` bucket, extended `get_public_setting` RPC.

**Edited**: `supabase/functions/study-assistant/index.ts`, `src/pages/LessonPage.tsx`, `src/components/TelegramLoginButton.tsx`, `src/pages/Login.tsx`, `src/pages/Signup.tsx`, `src/pages/Settings.tsx`, `src/pages/admin/AdminSettings.tsx`, `src/pages/admin/AdminCourseEditor.tsx`, `index.html`.

## Blocked on you

Nothing required to start — your Telegram bot already configured. Bunny/Mux DRM only if you want true screen-recording block (paid).