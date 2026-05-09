# Plan: Make pasted Bunny GUID actually play

## What you're doing in the screenshots — and what's wrong

Your inputs are correct:

- **Image 2 (Bunny):** the Video ID `0f474de8-f023-411f-bc69-5e110c77bf5b` is the right thing to copy. It is the Video GUID. ✅
- **Image 3 (Lesson editor):** Provider = `Bunny Stream (HLS)`, Video ID = the GUID, Save. That is exactly what the hint asks for. ✅
- **Image 1 (player):** "Bu Bunny videosida noto'g'ri Library ID / Video GUID" — this is misleading. Your data is fine; the **player code can't find the Library ID**.

So you are populating things correctly. The bug is on our side.

## Root cause

`src/pages/LessonPage.tsx` (lines 227–239) plays Bunny videos by splitting `provider_video_id` on `/`:

```ts
const bunnyRaw = lesson.provider_video_id || lesson.video_url || "";
const [bunnyLib, bunnyGuid] = bunnyRaw.includes("/") ? bunnyRaw.split("/") : ["", ""];
if (!bunnyLib || !bunnyGuid) return <div>...invalidId...</div>;
```

When you paste the bare GUID (`0f474de8-...`), there is no `/`, so `bunnyLib` is empty and the player short-circuits to the error message — **without ever calling the `lesson-video-url` edge function** that already knows how to prepend `BUNNY_LIBRARY_ID`. The fix I made earlier in `lesson-video-url` is correct but unused on this code path.

Lesson 3.3 only worked because at some point its row was saved with the full `<library>/<guid>` form.

## Fix (frontend only, two small changes)

### 1. `src/components/admin/LessonDrawer.tsx` — normalize on save

In the Bunny embed `onBlur` handler, when the input is a bare GUID, fetch the library ID once and store the canonical `${libraryId}/${guid}` in `provider_video_id`. Library ID comes from a tiny new endpoint (see step 3) — or, simpler, reuse `bunny-upload-init` which already has access to `BUNNY_LIBRARY_ID` and add a `{ action: "config" }` branch that returns `{ libraryId }`. Cache the value in component state so we only fetch once per drawer open.

This makes every newly-saved Bunny lesson carry the full `<lib>/<guid>` form that `LessonPage` already understands.

### 2. `src/pages/LessonPage.tsx` — fall back when the slash is missing

Replace the inline split with: if `provider === "bunny"` and there is no `/`, call `lesson-video-url` (which already prepends the library ID) and parse `<lib>/<guid>` back out of the returned `iframe.mediadelivery.net/embed/<lib>/<guid>` URL, then pass them to `<BunnyVideoPlayer>`. Show the error only if that call also fails.

This unblocks the lessons you've already saved with the bare GUID (3.1, 3.2, 3.3) without you needing to re-edit them.

### 3. Tiny backend addition

Add a `GET /libraryId` branch (or `?action=config`) to `supabase/functions/bunny-upload-init/index.ts` that returns `{ libraryId: Deno.env.get("BUNNY_LIBRARY_ID") }` to authenticated users. No new secrets; no schema changes.

## Verification

- Open lesson 3.3 as a student → Bunny iframe plays, no "invalidId" error.
- Open the editor for 3.1 / 3.2, the GUID is shown; click into the field and tab out → DB row becomes `<lib>/<guid>`; player works.
- Re-pasting just a GUID into a new lesson saves the full `<lib>/<guid>` form automatically.

## Files touched

- `src/pages/LessonPage.tsx`
- `src/components/admin/LessonDrawer.tsx`
- `supabase/functions/bunny-upload-init/index.ts` (one extra branch)

No DB migrations. No new secrets.
