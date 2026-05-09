## Why your videos aren't in Bunny

`LessonDrawer` has two upload paths:

- **"Upload Video" tab** → uploads to Supabase Storage bucket `lesson-videos` and saves `video_provider='upload'`. **Never touches Bunny.**
- **"Embed" tab → Bunny Stream (HLS)** → uses TUS direct upload to `video.bunnycdn.com` via the existing `bunny-upload-init` edge function.

Recent uploads went through path #1, so they're sitting in Supabase Storage, not your Bunny library. 4 lessons are currently in this state (all the 4.x-MODUL Claude lessons).

## Plan

### 1. Make the "Upload Video" tab upload to Bunny

Rewire `onDrop` in `src/components/admin/LessonDrawer.tsx` to reuse the existing Bunny TUS flow (`bunny-upload-init` + `tus.Upload` to `video.bunnycdn.com`). On success save:
- `video_provider: 'bunny'`
- `provider_video_id: '<libraryId>/<videoGuid>'`
- clear `video_storage_path`

Remove the now-redundant separate "Bunny Stream (HLS)" upload UI in the Embed tab (keep the embed text field for pasting an existing `<library>/<guid>`). Keep duration/thumbnail capture client-side as today.

If `bunny-upload-init` returns an error (Bunny not configured), surface a clear toast — no fallback to Storage.

### 2. One-time migration of the 4 existing videos

Add a new edge function `migrate-storage-to-bunny` (admin-only) that for each lesson with `video_provider='upload'`:

1. Generates a signed download URL from `lesson-videos`.
2. Creates a Bunny video via `POST /library/{lib}/videos`.
3. Streams the file to Bunny via `PUT /library/{lib}/videos/{guid}` (server-to-server fetch, no browser limits).
4. Updates the lesson row: `video_provider='bunny'`, `provider_video_id='{lib}/{guid}'`, clears `video_storage_path`.
5. Deletes the original object from `lesson-videos` storage.

Add a small admin-only button on `AdminBunnyDiagnostics` (or a new tile on `AdminCourses`) that lists the 4 affected lessons and a "Migrate to Bunny" action which invokes the function per lesson and shows progress.

Because uploading 4 large MP4s server-side may exceed a single edge-function timeout, the function processes **one lesson per invocation** (lesson_id in body) and returns the new GUID; the UI loops one-at-a-time.

### 3. No schema changes

Lessons table already supports `provider_video_id`; existing `lesson-video-url` edge function already handles `video_provider='bunny'`. No DB migration needed.

### Files touched

- `src/components/admin/LessonDrawer.tsx` — replace Storage upload with Bunny TUS upload; trim Embed-tab Bunny uploader.
- `supabase/functions/migrate-storage-to-bunny/index.ts` — new admin-only one-shot migration function.
- New small admin UI section (in `AdminBunnyDiagnostics.tsx` or similar) to trigger migration for the 4 pending lessons.

### Requires

`BUNNY_LIBRARY_ID` and `BUNNY_API_KEY` secrets must be set (already used by `bunny-upload-init`). I'll verify before implementing.
