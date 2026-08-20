# Voice Homework Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. This repo has **no frontend unit-test harness** — the verification bar is `npm run typecheck` (tsc, the real gate) + `npm run build`, `deno check` for edge functions, and prod E2E. "Verify" steps use those.

**Goal:** Let a teacher grading homework in the **web app or Teacher Mini App** leave feedback as a **voice note** (in addition to / instead of text); the student plays it in-app and — if they've started the bot — receives it as a Telegram audio message. Extends voice feedback (already in the bot) to the app surfaces.

**Architecture:** App-recorded audio is MP3-encoded client-side, uploaded to a new private `homework-audio` bucket, pointed to by a new `score_feedback_voice_path` column (additive to the fidelity-critical grade write). A `hw-audio-url` edge function (near-clone of `hw-image-url`) resolves either the bucket path (signed URL) or the existing Telegram `score_feedback_voice_file_id` (server-side fetch → token-free data URL) behind junction-aware RBAC, feeding an `<audio>` player in the student's graded-homework view. A `notify-grade-voice` edge function pushes the note to the student via bot `sendAudio`.

**Tech Stack:** React 18 + Vite + TS + Tailwind + `ui-kit`; Web Audio (`getUserMedia` + `AudioContext` PCM) + a client MP3 encoder; Supabase Storage/RLS/edge (Deno); Telegram Bot API (server-side token).

**Spec:** `docs/superpowers/specs/2026-08-20-voice-homework-feedback-design.md` (read it — it carries the rationale, esp. the MP3-format decision and the Telegram-webview mic risk).

## Global Constraints

- **Branch:** `feat/voice-homework-feedback` off `main`. Never merge to `main` without the owner's explicit "merge it".
- **Never `git add -A`** (chronically dirty `.env`/`deno.lock`/`scripts/`) — stage explicit paths only.
- **Never log, commit, or return the Telegram bot token** or any `api.telegram.org/…bot<token>…` URL. Token stays server-side; student playback of a Telegram-sourced note uses the token-free `data:` URL pattern (`hw-image-url`).
- **Grade-write fidelity (critical):** voice is **additive**. Do NOT change the existing grade columns/semantics (`score`, `score_feedback`, `scored_by=auth.uid()`, `scored_at=now()`, `score_is_stale=false`) — XP triggers + the `homework_submissions_guard` depend on them. A raw `score→null` clear is still forbidden (the undo-corruption class).
- **Junction-aware RBAC everywhere:** teacher-of-a-group = `groups.teacher_id ∪ group_teachers`, via `is_group_teacher(_group_id,_uid)` (SECURITY DEFINER). Students see only their own; unrelated users get 403.
- **DB-visible health signals** (incident doctrine): the Telegram push (and `hw-audio-url` degradations) record to `admin_actions` (mirror `hw-image-url`'s `logHealth`), never log-only.
- **Design:** dark, mobile-first, `max-w-2xl`, ui-kit by name, EXACTLY ONE `Button variant="primary"` (`bg-cta`) per screen, `truncate`/`min-w-0`, Telegram safe-area (shells handle it), loading/empty/offline states (copy sibling screens).
- **Limits:** voice ≤ **2:00** duration, ≤ **~4 MB** MP3. Bucket private (signed URLs, ~1h TTL like `hw-image-url`).
- **`.rpc("fn" as any)` / `.from("t" as any)`** casts where generated types lack the new column/RPC (frontend-typecheck-verify convention).

## Confirmed patterns to mirror (verified live)

- **`homework_images` storage policies (mirror for `homework-audio`, swapping the bucket id):** `SELECT` (role `public`): `bucket_id='homework_images' AND ((auth.uid())::text = (storage.foldername(name))[1] OR has_role(auth.uid(),'admin') OR (has_role(auth.uid(),'teacher') AND EXISTS(SELECT 1 FROM profiles p WHERE (p.id)::text=(storage.foldername(objects.name))[1] AND is_group_teacher(p.group_id, auth.uid()))))`. `INSERT`/`UPDATE`/`DELETE` (role `authenticated`): self-folder (`(auth.uid())::text=(storage.foldername(name))[1]`), delete also allows admin.
- **`hw-image-url`** (`supabase/functions/hw-image-url/index.ts`): `BUCKET`, `SIGNED_TTL=3600`, `resolveTelegramFileUrl(fileId)` (getFile → fetch bytes server-side → `data:<mime>;base64` URL, size guard, token never returned), `logHealth(admin, actor, action, details, submissionId)` → `admin_actions`, and the RBAC gate (self OR `is_group_teacher` OR admin/superadmin). Read it fully before Task 4.
- **`teacherApi.submitScore`** (`src/lib/teacherApi.ts:94`) writes `score, score_feedback, scored_by, scored_at, score_is_stale=false`. Its web siblings: `TeacherProfile.tsx` (~L164 saveScore) and `TeacherHomework.tsx` (`saveScore`).
- **Bot grade DM** (`telegram-bot-webhook/index.ts`): `gradeStudentDM(title,sc,mx,fb,xp?)` text + `sendVoice(chatId, fileId, caption)` (L1518, `tgApi("sendVoice",{chat_id,voice:fileId,caption})`) — the bot re-sends its own voice notes. **App grades do NOT currently DM the student** — Task 6's push is new.

---

## Task 1: Migration — `score_feedback_voice_path` column + `homework-audio` bucket

**Files:**
- Create: `supabase/migrations/20260820140000_voice_feedback_storage.sql`

**Interfaces — Produces:** `homework_submissions.score_feedback_voice_path text` (nullable, the bucket key `<student_uid>/<submission_id>.mp3`); a private `homework-audio` bucket with `homework_images`-parity policies.

- [ ] **Step 1:** Read `homework_images`'s bucket creation + policies (grep migrations for `homework_images` and `storage.buckets`) and the current live policies (in "Confirmed patterns" above) so the new bucket matches exactly.
- [ ] **Step 2:** Write the migration:
  - `ALTER TABLE public.homework_submissions ADD COLUMN IF NOT EXISTS score_feedback_voice_path text;`
  - `INSERT INTO storage.buckets (id, name, public) VALUES ('homework-audio','homework-audio', false) ON CONFLICT (id) DO NOTHING;`
  - Four `storage.objects` policies for `bucket_id='homework-audio'`, byte-mirroring the four `homework_images` policies (SELECT public self-or-admin-or-teacher-of-group via `is_group_teacher`; INSERT/UPDATE/DELETE authenticated self-folder, delete+admin). Use distinct policy names (`hwaudio user read own`, etc.). `CREATE POLICY IF NOT EXISTS` is not valid SQL — use `DROP POLICY IF EXISTS … ; CREATE POLICY …` for idempotency.
  - Header comment: what/why; no XP/guard/grade-column change.
- [ ] **Step 3 (verify):** Read the migration back: the `ALTER` is additive+nullable; the bucket is `public=false`; the 4 policies match `homework_images` with only the bucket id + policy names changed; `is_group_teacher` referenced (not redefined); balanced. Reason: adds the storage + pointer with no behavior change to existing grade/XP paths.
- [ ] **Step 4:** Commit (explicit path). This migration needs the `migration-approved` label on the PR.

---

## Task 2: `VoiceRecorder` shared component (record → MP3 → preview)

**Files:**
- Create: `src/components/homework/VoiceRecorder.tsx`
- Create/Add dep: a client MP3 encoder (e.g. `@breezystack/lamejs`, a maintained lamejs fork) via `package.json` — OR vendor a small encoder under `src/lib/`. Prefer the npm dep; confirm it builds under Vite.

**Interfaces — Produces:** `<VoiceRecorder value={Blob|null} onChange={(mp3: Blob|null)=>void} disabled?={boolean} />` — a self-contained recorder that yields an MP3 `Blob` (or null when cleared). Consumed by Task 3.

- [ ] **Step 1:** Read `TeacherGrade.tsx` + `src/components/teacher/GradePhoto.tsx` for the ui-kit conventions + how the grade screen composes controls.
- [ ] **Step 2:** Build the capture path: `navigator.mediaDevices.getUserMedia({audio:true})` → `AudioContext` → `MediaStreamAudioSourceNode` → a processor (AudioWorklet if simple, else `ScriptProcessorNode`) that accumulates Float32 PCM. On stop, downsample/convert PCM to 16-bit and encode to MP3 with the encoder (mono, 22.05–44.1 kHz, ~64–96 kbps — small + clear for speech). Produce a single `audio/mpeg` `Blob`.
- [ ] **Step 3:** UI + states: a record button (mic), a live elapsed timer, a **2:00 hard cap** (auto-stop), a stop button; after stop → a `<audio controls src={URL.createObjectURL(blob)}>` preview + **Re-record** + **Delete** (clears → `onChange(null)`). Enforce **≤ ~4 MB** (if exceeded, show an error + discard). Emit the blob via `onChange` when a recording is finalized.
- [ ] **Step 4:** Permission/availability fallback: if `getUserMedia` is missing or rejected (Telegram webview may block mic — see spec risk), render a disabled state with a short reason ("Mikrofon mavjud emas — matn yozing yoki botdan yuboring") and never throw. The parent's text feedback still works.
- [ ] **Step 5 (verify):** `npm run typecheck` + `npm run build` clean. Manually confirm (in a desktop browser) record → preview → re-record → delete works and yields an `audio/mpeg` blob under the caps. Commit (explicit paths incl. `package.json`/lockfile if a dep was added — note: `deno.lock` stays unstaged; `package-lock.json` IS staged).

---

## Task 3: Wire recorder + voice upload into the grade write (Mini App + web)

**Files:**
- Modify: `src/lib/teacherApi.ts` (`submitScore` — add optional `voicePath`)
- Modify: `src/pages/teacher/TeacherGrade.tsx` (Mini App grading — mount `VoiceRecorder`, upload on save)
- Modify: `src/components/profile/TeacherProfile.tsx` + `src/pages/TeacherHomework.tsx` (web grading — same)

**Interfaces — Consumes:** `VoiceRecorder` (Task 2), `homework-audio` bucket + `score_feedback_voice_path` (Task 1). **Produces:** an uploaded MP3 at `homework-audio/<student_uid>/<submission_id>.mp3` and `score_feedback_voice_path` set on the graded submission.

- [ ] **Step 1:** Read `teacherApi.submitScore` (`src/lib/teacherApi.ts:94`) and the two web `saveScore` sites. Note the EXACT existing columns written (score/score_feedback/scored_by/scored_at/score_is_stale) — you will ADD `score_feedback_voice_path` to the same update, changing nothing else.
- [ ] **Step 2:** Add an upload helper (in `teacherApi.ts` or a small `src/lib/homeworkAudio.ts`): `uploadFeedbackVoice(studentUserId, submissionId, mp3: Blob): Promise<string>` → `supabase.storage.from("homework-audio").upload("<studentUserId>/<submissionId>.mp3", mp3, { upsert: true, contentType: "audio/mpeg" })`, returns the path. (Teacher's own auth session; the bucket INSERT policy is student-folder-scoped — see Step 3 note.)
- [ ] **Step 3 (RLS note — resolve during build):** the mirrored INSERT policy is `self-folder` (`auth.uid() = foldername[1]`), so a TEACHER uploading into the STUDENT's `<student_uid>/…` folder would be **denied** by that policy. Resolve by EITHER (a) adding a teacher-of-group INSERT/UPDATE policy on `homework-audio` (junction-aware, mirroring the SELECT policy's teacher branch) in Task 1's migration, OR (b) doing the upload via a SECURITY DEFINER path. **Prefer (a):** update Task 1 to give `homework-audio` an INSERT+UPDATE policy that also allows a teacher-of-the-student's-group (not just self) — since teachers, not students, write feedback audio. Verify the teacher can upload into the student's folder.
- [ ] **Step 4:** Extend `submitScore(...)` with an optional `voicePath?: string | null`; include `score_feedback_voice_path: voicePath ?? <existing value>` in the SAME update. In each grading screen: mount `<VoiceRecorder>` beside the text field; on Save, if a blob exists → `uploadFeedbackVoice(...)` first, then pass the returned path to `submitScore`. Text + voice independent (either/both/neither). On delete/replace of a prior note, set the path to null (best-effort remove the old object). Preserve the exact existing save flow otherwise (undo stays a safe re-open — never a raw `score→null`).
- [ ] **Step 5 (verify):** `npm run typecheck` + `npm run build` clean. Reason: a teacher can record + save a note with a grade on the Mini App and on the web; the submission gets `score_feedback_voice_path`; score/XP columns unchanged (fidelity); text-only grading unregressed. Commit (explicit paths).

---

## Task 4: `hw-audio-url` edge function (student/teacher audio resolver)

**Files:**
- Create: `supabase/functions/hw-audio-url/index.ts`
- Modify: `supabase/config.toml` (add `[functions.hw-audio-url]` with `verify_jwt = true`, mirroring `hw-image-url`)

**Interfaces — Produces:** `POST { submission_id } → { url }` (browser-playable audio URL) | `{ url: null, reason }` | `{ error: "forbidden" }` (403). Consumed by Task 5.

- [ ] **Step 1:** Read `hw-image-url/index.ts` fully (RBAC gate, `resolveTelegramFileUrl`, `logHealth`, `bytesToBase64`, size guard, response shapes).
- [ ] **Step 2:** Clone it as `hw-audio-url`, changing: `BUCKET="homework-audio"`; resolve order — if the submission has `score_feedback_voice_path` → `createSignedUrl(path, 3600)` → `{ url }`; else if `score_feedback_voice_file_id` → `resolveTelegramFileUrl(fileId)` adapted for **audio** MIME (`contentTypeFromPath`: `.oga/.ogg→audio/ogg`, `.mp3→audio/mpeg`, `.m4a→audio/mp4`, else fall back to the response content-type, else `audio/ogg`); else `{ url:null, reason:"no_voice" }`. Keep the ~6 MB guard (rename to audio). RBAC identical: caller is the submission's **student (self)** OR `is_group_teacher(studentGroup, caller)` OR admin/superadmin — else 403. Token never returned; `logHealth` on real degradations (`action:"hw_audio_resolve_degraded"`).
- [ ] **Step 3:** Add the `config.toml` block (verify_jwt true). Note: any `config.toml` change redeploys ALL functions — expected for a new function.
- [ ] **Step 4 (verify):** `deno check supabase/functions/hw-audio-url/index.ts` clean (or note deno-unavailable → CI). Re-read: no token in any return/log; RBAC self-or-teacher-or-admin; both sources resolved; audio MIME. Commit (explicit paths).

---

## Task 5: Student `<audio>` player in the graded-homework view

**Files:**
- Modify: `src/pages/Homework.tsx` (student web graded view — add the player)
- Modify: the Mini App student homework-detail view (find it: grep `Homework` under `src/pages`/`src/components` for where a student sees their graded submission + `score_feedback`)

**Interfaces — Consumes:** `hw-audio-url` (Task 4). The submission row must expose whether a voice exists (`score_feedback_voice_path` OR `score_feedback_voice_file_id` non-null) — add these to the submission select if absent.

- [ ] **Step 1:** Read `Homework.tsx` where `score_feedback` (text feedback) renders for a graded submission. Confirm the submission query selects (or add) `score_feedback_voice_path` + `score_feedback_voice_file_id` so the UI knows a voice exists.
- [ ] **Step 2:** When a graded submission has a voice, show a compact "🎧 Ovozli izoh" control beside the text feedback: on first play (or mount), call `supabase.functions.invoke("hw-audio-url", { body: { submission_id } })`; read `{ url }` (or the error via `error.context`, per `HomeworkSubmit.tsx:207-215`); render `<audio controls src={url}>`. States: loading (spinner), `no_voice`/`url:null` (hide), error/offline ("Ovozni yuklab bo'lmadi — qayta urining"), forbidden (hide — shouldn't happen for the owner).
- [ ] **Step 3:** Mirror the same player into the Mini App student homework-detail view.
- [ ] **Step 4 (verify):** `npm run typecheck` + `npm run build` clean. Reason: a student with a voice note sees + plays it (both bucket- and Telegram-sourced) in web + Mini App; a submission with no voice shows nothing new; a non-owner can't resolve it (403). Commit.

---

## Task 6: Telegram audio push on app-grade-with-voice

**Files:**
- Create: `supabase/functions/notify-grade-voice/index.ts`
- Modify: `supabase/config.toml` (add `[functions.notify-grade-voice]`, `verify_jwt = true`)
- Modify: `src/lib/teacherApi.ts` (or the grade-save flow in the 3 grading screens) — fire-and-forget call after a successful grade-with-voice save.

**Interfaces — Consumes:** `homework-audio` (Task 1), the grade-save flow (Task 3). **Produces:** a Telegram audio DM to the student (best-effort) + a `admin_actions` health row.

- [ ] **Step 1:** Read the bot `sendVoice`/`gradeStudentDM` (`telegram-bot-webhook/index.ts` ~L1518, ~L4315) for the Telegram send + caption shape, and `hw-image-url` for the auth/service-role client skeleton + `logHealth`.
- [ ] **Step 2:** Build `notify-grade-voice`: `POST { submission_id }`, authed (verify_jwt). Authorize the caller is a **teacher of the submission's student's group** (junction-aware) OR admin — else 403 (this triggers a DM to a student, so gate it). Load the submission + student (`telegram_id`, `preferred_locale`) + assignment title. If no `score_feedback_voice_path` OR no `student.telegram_id` → `{ ok:true, sent:false, reason }` (200; the ~70% who never started the bot). Else: create a `createSignedUrl(path, 600)` on `homework-audio` and `tgApi("sendAudio", { chat_id, audio: <signedUrl>, caption, title })` (Telegram fetches the URL). On ok → `{ ok:true, sent:true }` + `logHealth("grade_voice_dm_sent")`; on non-ok/throw → `{ ok:true, sent:false }` + `logHealth("grade_voice_dm_failed", { desc })` (a blocked-bot / never-started user must not surface as a hard error — mirror the member-forgiveness + hw-dm health conventions). Bot token server-side only.
- [ ] **Step 3:** In the grade-save flow (Task 3 screens), after `submitScore` succeeds AND a voice was saved, call `supabase.functions.invoke("notify-grade-voice", { body: { submission_id } })` fire-and-forget (do not block the UI or fail the grade on a push error).
- [ ] **Step 4 (verify):** `deno check` clean. Reason: grading with a voice on the app sends the student a Telegram audio DM when reachable, records a health row, and never breaks the grade on a send failure; a student with no telegram_id is a graceful no-send. Commit (explicit paths).

---

## Verification (whole feature, on prod after merge)

E2E with a real teacher (Rano) + a student: teacher records a note on the Mini App grading and on the web grading → the submission gets `score_feedback_voice_path` + an object in `homework-audio` → the student opens their graded homework (web + Mini App) and plays it → a bot-started student also receives the Telegram audio DM (check the `admin_actions` `grade_voice_dm_sent` row). Confirm: a non-teacher calling `hw-audio-url`/`notify-grade-voice` gets 403; the bot token appears in no client response; the existing **bot** voice flow + text-only grading are unregressed; grade/XP fidelity holds (scored_by/scored_at/score_is_stale correct, no orphaned scores, XP settles). Delete the synthetic audio object after; assert no residue.

## Self-review (done at write time)

- **Spec coverage:** data model (T1) / VoiceRecorder + MP3 (T2) / record-write on all app surfaces (T3) / hw-audio-url resolver (T4) / student player web+MiniApp (T5) / Telegram push + health (T6) — every spec section mapped. The Telegram-webview mic risk is handled by T2 Step 4's graceful fallback + prod E2E.
- **Placeholder scan:** the one genuine open decision (teacher-upload-into-student-folder RLS) is called out in T3 Step 3 with the concrete resolution (add a teacher-of-group INSERT/UPDATE policy to T1), not a TODO. MP3 encoder is a named dep choice.
- **Type consistency:** `score_feedback_voice_path` (T1) is written in T3, read in T4/T5; `hw-audio-url`'s `{ url }`/`{ error }` (T4) is consumed in T5; `VoiceRecorder`'s `onChange(Blob|null)` (T2) is consumed in T3; `notify-grade-voice { submission_id }` (T6) matches its caller.
