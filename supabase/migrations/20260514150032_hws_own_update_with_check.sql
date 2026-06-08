-- Recreate the "hws own update" RLS policy on public.homework_submissions to add a
-- WITH CHECK clause mirroring its USING clause. Without WITH CHECK, a student could
-- PATCH their own row to set a score (USING gates the rows that may be targeted by an
-- UPDATE, but the NEW row was unrestricted). Mirroring the predicate in WITH CHECK
-- enforces `score IS NULL` on the student branch for the post-update row as well.

DROP POLICY IF EXISTS "hws own update" ON public.homework_submissions;

CREATE POLICY "hws own update" ON public.homework_submissions FOR UPDATE TO authenticated
  USING (
    (auth.uid() = user_id AND score IS NULL)
    OR has_role(auth.uid(),'admin'::app_role)
    OR has_role(auth.uid(),'teacher'::app_role)
  )
  WITH CHECK (
    (auth.uid() = user_id AND score IS NULL)
    OR has_role(auth.uid(),'admin'::app_role)
    OR has_role(auth.uid(),'teacher'::app_role)
  );
