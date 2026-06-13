DROP POLICY IF EXISTS "enrollments insert own or admin" ON public.enrollments;
CREATE POLICY "enrollments insert own or admin" ON public.enrollments
  FOR INSERT TO authenticated
  WITH CHECK (
    has_role(auth.uid(), 'admin'::app_role)
    OR (
      auth.uid() = user_id
      AND EXISTS (
        SELECT 1 FROM public.courses c
        WHERE c.id = enrollments.course_id AND c.published = true
      )
    )
  );