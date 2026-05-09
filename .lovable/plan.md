# Fix Bunny URL embed in Lesson editor

## What's broken

I reproduced the issue in code and confirmed in the database. Lessons 3.1 and 3.2 are saved as `video_provider = 'youtube'` with an empty `provider_video_id` even though you typed Bunny + a GUID. Lesson 3.3 saved correctly. Two bugs in `src/components/admin/LessonDrawer.tsx` cause this:

### Bug 1 — Tab auto-switching wipes the provider
The `<Tabs>` `value` is computed from the saved data:
```
value = (provider === "upload" || (provider === "bunny" && provider_video_id)) ? "upload" : "embed"
```
So the moment a Bunny GUID is saved, the UI jumps from "URL orqali joylash" back to "Video yuklash". That's the "interface jumped to upload view" you saw.

### Bug 2 — Switching tabs resets the provider to YouTube
The Tabs `onValueChange` runs:
```
v === "upload"  → update({ video_provider: "upload",   provider_video_id: null })
v === "embed"   → update({ video_provider: "youtube",  provider_video_id: null, video_storage_path: null })
```
When Bug 1 force-switches the tab back to "upload", this writes `video_provider = "upload"` and clears `provider_video_id`. Then when you switch back to "URL orqali joylash" manually, it overwrites with `youtube` and clears the ID again. That's exactly the row state we see for 3.1 and 3.2.

A third smaller issue: the provider `<Select>` calls `update({ video_provider: v })` but does not clear `provider_video_id`, so a stale ID from a different provider can linger.

## Fix

Edit only `src/components/admin/LessonDrawer.tsx`:

1. **Decouple the active tab from saved data.** Add local state `const [tab, setTab] = useState<"upload" | "embed">(...)` initialised from the lesson once on load: `embed` when `video_provider` is one of `youtube | vimeo | mux | bunny`, otherwise `upload`. Use it as `<Tabs value={tab} onValueChange={setTab}>`. Switching tabs no longer writes to the database.

2. **Don't mutate provider on tab switch.** Remove the `update({ video_provider: ... })` calls from `onValueChange`. The provider is only changed by the explicit `<Select>` in the embed tab, or by a successful Bunny upload in the upload tab.

3. **After a successful Bunny upload, force `tab = "upload"`** so the "Video uploaded" card stays visible (current behaviour, just driven by local state now).

4. **Provider Select cleans stale id.** When the user changes provider in the embed tab, call `update({ video_provider: v, provider_video_id: null, video_storage_path: null, video_url: null })` so old IDs from a different provider can't leak into playback.

5. **Bunny embed onBlur stays as-is** (already accepts bare GUID, `<lib>/<guid>`, `iframe.mediadelivery.net/...`, `vz-*.b-cdn.net/...`). The edge function `lesson-video-url` already prepends `BUNNY_LIBRARY_ID` for bare GUIDs, so playback will work.

6. **Re-save 3.1 and 3.2.** After the fix is in, you re-open each lesson, choose Bunny, paste the GUID, and Save — the row will then carry `video_provider='bunny'` and the GUID, and the player resolves through `lesson-video-url` exactly like 3.3 does today.

## Verification

- Open lesson 3.1 → embed tab stays selected, provider stays "Bunny", GUID stays in the input after Save.
- DB row shows `video_provider='bunny'`, `provider_video_id='<guid>'`.
- Student-facing player loads the Bunny iframe and the "Bu dars uchun video mavjud emas" message disappears.
- Switching between Upload and URL tabs no longer mutates the saved provider or clears the GUID.

## Files touched

- `src/components/admin/LessonDrawer.tsx` (only)

No schema or edge-function changes required.
