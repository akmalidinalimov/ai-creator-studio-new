-- Phase 0 (M05): protect raw lesson video identifiers and serve all playback
-- through the access-gated lesson-video-url edge function.
--
-- Today the lessons table is world-readable to any authenticated user
-- ("lessons read" USING(true)), so a student can SELECT provider_video_id /
-- video_url for ANY lesson (incl. locked / higher-tier modules) and play it,
-- bypassing has_module_access. This revokes column-level SELECT on the raw
-- pointers from students/anon; the only way to get a playable URL is now
-- lesson-video-url, which enforces has_module_access + published + enrollment.
--
-- REVERSIBLE: to undo, GRANT SELECT (video_url, provider_video_id,
-- video_storage_path) ON public.lessons TO authenticated, anon;  (and drop the
-- helpers / has_video column). No data is moved or dropped.
--
-- NOTE: column-level REVOKE can't distinguish admins from students (both are the
-- `authenticated` role), so staff read the raw values via the SECURITY DEFINER
-- helpers below. The service_role (used by edge functions) keeps full access.

-- Non-sensitive boolean for the admin course tree ("does this lesson have a video?").
ALTER TABLE public.lessons
  ADD COLUMN IF NOT EXISTS has_video boolean
  GENERATED ALWAYS AS (
    video_url IS NOT NULL OR provider_video_id IS NOT NULL OR video_storage_path IS NOT NULL
  ) STORED;

REVOKE SELECT (video_url, provider_video_id, video_storage_path)
  ON public.lessons FROM anon, authenticated;

-- Staff helper: the full lesson row (incl. media pointers) for the lesson editor.
CREATE OR REPLACE FUNCTION public.staff_get_lesson(_lesson_id uuid)
RETURNS SETOF public.lessons
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM public.lessons
  WHERE id = _lesson_id
    AND (public.has_role(auth.uid(),'admin'::app_role)
      OR public.has_role(auth.uid(),'superadmin'::app_role)
      OR public.has_role(auth.uid(),'teacher'::app_role));
$$;
GRANT EXECUTE ON FUNCTION public.staff_get_lesson(uuid) TO authenticated;

-- Staff helper: upload-provider lessons still pending Bunny migration (diagnostics).
CREATE OR REPLACE FUNCTION public.staff_list_pending_bunny()
RETURNS TABLE (id uuid, title text, video_storage_path text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT l.id, l.title, l.video_storage_path
  FROM public.lessons l
  WHERE l.video_provider = 'upload' AND l.video_storage_path IS NOT NULL
    AND (public.has_role(auth.uid(),'admin'::app_role)
      OR public.has_role(auth.uid(),'superadmin'::app_role)
      OR public.has_role(auth.uid(),'teacher'::app_role))
  ORDER BY l.title;
$$;
GRANT EXECUTE ON FUNCTION public.staff_list_pending_bunny() TO authenticated;

-- Staff helper: count lessons sharing a storage path (safe file deletion check).
CREATE OR REPLACE FUNCTION public.staff_count_lessons_by_storage_path(_path text, _exclude uuid)
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::int FROM public.lessons
  WHERE video_storage_path = _path AND id <> _exclude
    AND (public.has_role(auth.uid(),'admin'::app_role)
      OR public.has_role(auth.uid(),'superadmin'::app_role)
      OR public.has_role(auth.uid(),'teacher'::app_role));
$$;
GRANT EXECUTE ON FUNCTION public.staff_count_lessons_by_storage_path(text, uuid) TO authenticated;
