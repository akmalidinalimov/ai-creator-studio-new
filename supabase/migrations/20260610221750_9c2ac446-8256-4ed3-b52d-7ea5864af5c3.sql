
DROP POLICY IF EXISTS "hwimg user read own" ON storage.objects;
CREATE POLICY "hwimg user read own" ON storage.objects FOR SELECT
  USING (
    bucket_id = 'homework_images' AND (
      (auth.uid())::text = (storage.foldername(storage.objects.name))[1]
      OR public.has_role(auth.uid(), 'admin'::public.app_role)
      OR (
        public.has_role(auth.uid(), 'teacher'::public.app_role)
        AND EXISTS (
          SELECT 1
          FROM public.profiles p
          JOIN public.groups g ON g.id = p.group_id
          WHERE p.id::text = (storage.foldername(storage.objects.name))[1]
            AND g.teacher_id = auth.uid()
        )
      )
    )
  );

DROP POLICY IF EXISTS "lesson-videos read auth" ON storage.objects;
CREATE POLICY "lesson-videos staff read" ON storage.objects FOR SELECT
  USING (
    bucket_id = 'lesson-videos' AND (
      public.has_role(auth.uid(), 'admin'::public.app_role)
      OR public.has_role(auth.uid(), 'teacher'::public.app_role)
    )
  );

DROP POLICY IF EXISTS "lesson-resources read auth" ON storage.objects;
CREATE POLICY "lesson-resources staff read" ON storage.objects FOR SELECT
  USING (
    bucket_id = 'lesson-resources' AND (
      public.has_role(auth.uid(), 'admin'::public.app_role)
      OR public.has_role(auth.uid(), 'teacher'::public.app_role)
    )
  );
