-- Voice homework feedback (Task 1 of the 2026-08-20 voice-homework-feedback feature): storage
-- foundation for teacher-recorded voice feedback on graded homework, uploaded from the web app
-- and the Teacher Mini App (client-encoded MP3). ADDITIVE to the existing bot voice-feedback
-- path (score_feedback_voice_file_id, added 20260716140000_grade_voice_feedback.sql) — that
-- path, and the bot's capture/re-send logic, are untouched. A submission's voice feedback is
-- score_feedback_voice_path (this column, app-recorded) OR score_feedback_voice_file_id (bot),
-- whichever is set. No change to XP, the homework_submissions_guard trigger, or any of the
-- existing grade-write columns (score / score_feedback / scored_by / scored_at /
-- score_is_stale). has_role() and is_group_teacher() are referenced only, not redefined, here.
--
-- 1) score_feedback_voice_path: nullable text pointer to the object key
--    "<student_user_id>/<submission_id>.mp3" inside the new `homework-audio` bucket.
-- 2) `homework-audio`: a new PRIVATE storage bucket (public=false).
-- 3) storage.objects RLS for `homework-audio`: four policies mirroring the live
--    `homework_images` policies (confirmed via pg_policies immediately before writing this
--    migration) — same SELECT shape (self OR admin OR teacher-of-the-student's-group,
--    junction-aware via is_group_teacher) — WITH TWO DELIBERATE EXTENSIONS over homework_images:
--    unlike homework_images (where the STUDENT uploads their own submission photo into their own
--    folder, so INSERT/UPDATE are self-folder-only), for voice feedback it is the TEACHER who
--    uploads/replaces audio inside the STUDENT's <student_uid>/ folder. A self-folder-only
--    INSERT/UPDATE would 403 the teacher. So INSERT and UPDATE here additionally grant the
--    teacher-of-group branch (the identical predicate the SELECT policy already uses), on top of
--    self-folder and admin.
--    DELETE (fix round 1, 2026-08-20): initially shipped self-or-admin only, matching
--    homework_images exactly. Task 3's grading screens need to best-effort delete a student's
--    voice object when a teacher removes a note without recording a replacement
--    (src/lib/homeworkAudio.ts#removeFeedbackVoice) — a self-or-admin-only DELETE policy denies
--    every teacher attempt, silently orphaning the object forever. DELETE now carries the SAME
--    teacher-of-group branch as INSERT/UPDATE, for the same reason.

alter table public.homework_submissions
  add column if not exists score_feedback_voice_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('homework-audio', 'homework-audio', false, 4194304, array['audio/mpeg'])
on conflict (id) do nothing;

-- SELECT: self OR admin OR teacher-of-the-student's-group. Byte-identical shape to the live
-- "hwimg user read own" policy on homework_images (bucket id swapped only). No TO clause, to
-- match the live homework_images read policy (roles = {public}; auth.uid() is null for
-- anonymous callers so every branch still requires an authenticated match).
drop policy if exists "hwaudio user read own" on storage.objects;
create policy "hwaudio user read own" on storage.objects for select
  using (
    bucket_id = 'homework-audio' and (
      (auth.uid())::text = (storage.foldername(storage.objects.name))[1]
      or public.has_role(auth.uid(), 'admin'::public.app_role)
      or (
        public.has_role(auth.uid(), 'teacher'::public.app_role)
        and exists (
          select 1 from public.profiles p
          where p.id::text = (storage.foldername(storage.objects.name))[1]
            and public.is_group_teacher(p.group_id, auth.uid())
        )
      )
    )
  );

-- INSERT: self OR admin OR teacher-of-the-student's-group. The teacher branch is the
-- controller-ruled extension over homework_images (self-folder-only there) — required because
-- the TEACHER, not the student, uploads audio into the student's folder.
drop policy if exists "hwaudio user upload own" on storage.objects;
create policy "hwaudio user upload own" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'homework-audio' and (
      (auth.uid())::text = (storage.foldername(storage.objects.name))[1]
      or public.has_role(auth.uid(), 'admin'::public.app_role)
      or (
        public.has_role(auth.uid(), 'teacher'::public.app_role)
        and exists (
          select 1 from public.profiles p
          where p.id::text = (storage.foldername(storage.objects.name))[1]
            and public.is_group_teacher(p.group_id, auth.uid())
        )
      )
    )
  );

-- UPDATE: same three-branch predicate as INSERT — a teacher replacing/upserting a voice note
-- needs UPDATE for the same reason INSERT does.
drop policy if exists "hwaudio user update own" on storage.objects;
create policy "hwaudio user update own" on storage.objects for update to authenticated
  using (
    bucket_id = 'homework-audio' and (
      (auth.uid())::text = (storage.foldername(storage.objects.name))[1]
      or public.has_role(auth.uid(), 'admin'::public.app_role)
      or (
        public.has_role(auth.uid(), 'teacher'::public.app_role)
        and exists (
          select 1 from public.profiles p
          where p.id::text = (storage.foldername(storage.objects.name))[1]
            and public.is_group_teacher(p.group_id, auth.uid())
        )
      )
    )
  );

-- DELETE (fix round 1): same three-branch predicate as INSERT/UPDATE. A teacher must be able to
-- delete a student's feedback audio object when removing a voice note without recording a
-- replacement — a self-or-admin-only DELETE (the original shape here) always denied the teacher,
-- so removeFeedbackVoice's best-effort delete silently failed on every call, accumulating
-- orphaned objects forever. Byte-identical branch to INSERT/UPDATE's teacher-of-group predicate.
drop policy if exists "hwaudio user delete own" on storage.objects;
create policy "hwaudio user delete own" on storage.objects for delete to authenticated
  using (
    bucket_id = 'homework-audio' and (
      (auth.uid())::text = (storage.foldername(storage.objects.name))[1]
      or public.has_role(auth.uid(), 'admin'::public.app_role)
      or (
        public.has_role(auth.uid(), 'teacher'::public.app_role)
        and exists (
          select 1 from public.profiles p
          where p.id::text = (storage.foldername(storage.objects.name))[1]
            and public.is_group_teacher(p.group_id, auth.uid())
        )
      )
    )
  );
