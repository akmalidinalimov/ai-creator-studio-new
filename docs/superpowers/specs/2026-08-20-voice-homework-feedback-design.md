# Voice homework feedback (web + Mini App) — design

**Status:** approved in chat 2026-08-20. Author: agent. Owner: product lead.

## Goal

When a teacher grades homework, let them leave feedback as **text, a voice note, or both**. A voice note recorded in the **web app or the Teacher Mini App** is stored, delivered to the student, and playable by the student in-app; if the student has started the bot, it is also pushed to them as a Telegram audio message. This closes the gap where voice feedback exists **only** in the Telegram bot grading flow today.

## Existing foundation (reused, not rebuilt)

- **Bot voice feedback already works.** The webhook grading flow accepts a Telegram voice/audio note (`msg.voice?.file_id || msg.audio?.file_id`), stores it in `homework_submissions.score_feedback_voice_file_id`, and re-sends it to the student as a Telegram voice message (`telegram-bot-webhook/index.ts` ~L4247 capture, ~L1516 re-send, `gradeAskComment` copy). This feature extends voice feedback to the **web + Mini App**; the bot path is untouched.
- **`hw-image-url` is the media-resolution pattern to mirror.** It resolves a submission's media into a browser-loadable URL — a **storage-bucket key → signed URL**, or a **Telegram `file_id` → server-side getFile → token-free `data:` URL** (bot token contained server-side) — behind junction-aware RBAC (`is_group_teacher` OR admin/superadmin; self for the student). The student audio resolver is a near-clone for audio.
- **`teacherApi.submitScore`** is the fidelity-critical grade write (score / score_feedback / scored_by=auth.uid() / scored_at=now() / score_is_stale=false) that XP triggers + the `homework_submissions_guard` depend on. Voice is **additive** — it must not alter the existing grade-write columns or their semantics.
- **`homework_images`** private bucket + `submit-homework` upload flow are the storage/upload pattern to mirror for audio.

## Scope

**In:** a shared voice-recorder in the Mini App grading (`TeacherGrade`) and web grading (`TeacherProfile` / `TeacherHomework`); MP3 client-side encoding; a `homework-audio` private bucket + a `score_feedback_voice_path` column; a `hw-audio-url` edge function; an in-app `<audio>` player in the student's graded-homework view (web `Homework.tsx` + Mini App); a Telegram audio push to the student on app-grading-with-voice.

**Out (v1):** transcoding/waveform editing; voice-to-text; voice on the STUDENT submission side (this is feedback only); changing the existing bot voice flow; Bunny/CDN for audio.

## Data model (one migration; label: migration-approved)

1. `ALTER TABLE public.homework_submissions ADD COLUMN score_feedback_voice_path text;` — the `homework-audio` bucket key for app-recorded audio. Nullable. The existing `score_feedback_voice_file_id` (bot/Telegram) is unchanged. **A submission's voice feedback = `score_feedback_voice_path` (app) OR `score_feedback_voice_file_id` (bot), whichever is set.**
2. New **private** storage bucket `homework-audio`. RLS policies mirror `homework_images`:
   - a student may read objects under their own `<uid>/…` prefix;
   - a teacher may read objects for submissions of a student in a group they teach (junction-aware) — but since RLS on storage.objects is prefix-based, the authoritative teacher/student read path is the `hw-audio-url` edge fn (service-role); direct bucket reads are self-only + admin. (Mirror exactly whatever `homework_images` does.)
   - service-role: all.
   - Path convention: `<student_user_id>/<submission_id>.mp3`.
3. No change to XP, guard triggers, or the grade-write columns.

## Component: `VoiceRecorder` (shared, web + Mini App)

One reusable component used by all app grading surfaces. Responsibilities:
- Request mic via `getUserMedia`; if denied/unavailable, show a clear disabled state + reason (no crash) — the teacher can still type text.
- Record with `MediaRecorder`; show elapsed time + a simple level/recording indicator; enforce a **2-minute** hard cap (auto-stop).
- On stop, **encode the captured audio to MP3 client-side** (a small pure-JS encoder, e.g. `lamejs`-style, bundled + inlined-safe). MP3 is chosen so playback is universal (iOS Safari cannot play `webm/opus`, which Chrome/Android's MediaRecorder produces) and Telegram-compatible. Enforce a **~4 MB** size cap after encode.
- Let the teacher **preview** (play back), **re-record**, or **discard** before saving.
- Expose the encoded MP3 `Blob` to the grading screen; the screen uploads it on grade-save.
- Dark, mobile-first, ui-kit; matches the teacher-miniapp conventions.

## Teacher grade write (all app surfaces)

On grade save, in addition to the existing score/text write:
- If a voice blob is present: upload it to `homework-audio` at `<student_uid>/<submission_id>.mp3` (upsert), then set `score_feedback_voice_path` on the submission in the SAME update as `score_feedback` (text) — one atomic grade write, preserving the exact existing columns/semantics (`scored_by`, `scored_at`, `score_is_stale=false`).
- Text and voice are independent: either, both, or neither.
- If the teacher removes/replaces a prior voice note, clear/overwrite the path (and best-effort delete the old object).
- Wired into: `TeacherGrade` (Mini App), `TeacherProfile` + `TeacherHomework` (web). The grade-write helper (`teacherApi.submitScore` and its web sibling) gains an optional `voicePath` param; fidelity of the existing columns is unchanged.

## Student playback (web + Mini App)

- **`hw-audio-url` edge function** (mirror `hw-image-url`): `POST { submission_id }` → `{ url }` (a browser-playable audio URL) or `{ url: null, reason }` / `{ error: "forbidden" }` (403). RBAC: the caller must be the submission's **student (self)** OR a **teacher of that student's group** (junction-aware) OR admin/superadmin. Resolution: `score_feedback_voice_path` → signed URL from `homework-audio`; else `score_feedback_voice_file_id` → Telegram getFile → token-free `data:` audio URL (bot token never returned). `verify_jwt = true`.
- The student's graded-homework view (web `Homework.tsx` + the Mini App homework detail) shows an `<audio controls>` player when a voice note exists, beside the text feedback. Loading/empty/error states; offline-aware.

## Telegram delivery (proactive push)

- When a teacher grades **with a voice note in the app**, push the MP3 to the student as a Telegram **audio** message via the bot (`sendAudio`), reusing the grade-notification path (the same place the text grade DM / `homework_teacher_dm_queue` is emitted). This unifies with the existing bot voice delivery. Students who never started the bot (~70%) won't receive the DM — the in-app player covers them.
- **DB-visible health signal (mandatory):** the audio-DM send + any failure is recorded in the existing grade-DM health surface (mirror `homework_teacher_dm_queue` / the grade-DM error path), so failures are visible to the watchdog layer, not just function logs.

## Limits, format, safety

- **Format:** MP3 (client-encoded). Rationale: universal `<audio>` playback (iOS/Android/desktop) + Telegram `sendAudio` compatibility, with no server transcoding. Rejected: raw `webm/opus` (iOS can't play), server ffmpeg (heavy in edge).
- **Limits:** ≤ 2:00 duration, ≤ ~4 MB after encode.
- **Privacy/security:** `homework-audio` is private (signed URLs only, ~10-min TTL like `hw-image-url`). The bot token stays server-side (the `data:`-URL containment pattern from `hw-image-url`). RBAC on every resolve. Voice objects are per-student-prefixed.
- **Members-vs-nonmembers / forgiving-sandbox** conventions unchanged; no new owner-facing anomaly flags from normal use.

## Risks

- **Mic in the Telegram Mini App webview:** `getUserMedia` availability there is version/device-dependent. Mitigation: the recorder degrades gracefully (disabled + reason) if mic is blocked, and the teacher can still type text or record on the web app / bot. Verify on a real device early in implementation; if broadly blocked, the Mini App recorder is a no-op fallback while web + bot carry voice. (Does not block the rest.)
- **Client MP3 encoder** bundle/CPU: acceptable for ≤2-min notes; verify encode time on a mid-range phone.

## Verification bar

- `npm run typecheck` + `npm run build` clean; `deno check` on the new edge fn.
- Prod E2E with a real teacher + student: teacher records a note on the Mini App and on the web → student sees + plays it in the graded-homework view (web + Mini App) → and receives the Telegram audio DM (if bot-started). A non-teacher / unrelated user calling `hw-audio-url` gets 403. The bot token appears in no client response. The existing bot voice flow + text-only grading are unregressed; grade/XP fidelity holds (scored_by/scored_at/score_is_stale correct; no orphaned scores).

## Global constraints

- Isolated branch; never merge to `main` without the owner's explicit "merge it". Never `git add -A` (dirty `.env`/`deno.lock`/`scripts/`). Migration files append-only; the migration needs the `migration-approved` label. Never log/commit/return the bot token or initData. Junction-aware RBAC everywhere. Dark, mobile-first, ui-kit, one primary button per screen. Frontend verified by `typecheck` (tsc), not just `build`.
