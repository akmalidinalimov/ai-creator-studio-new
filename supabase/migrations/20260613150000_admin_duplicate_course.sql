-- Admin "Duplicate course": deep-copies a course's CONTENT (course -> modules ->
-- lessons -> homework (incl. SAP children) -> quizzes) into a brand-new HIDDEN course
-- with new IDs. Video fields are copied verbatim so the copy references the SAME
-- video asset (no re-upload). Copies NO student/runtime data (enrollments, progress,
-- submissions, notes, etc.) -> the duplicate has zero students and is fully isolated.
-- The source course and its students are never touched (INSERT-only).
CREATE OR REPLACE FUNCTION public.admin_duplicate_course(
  _source_course_id uuid,
  _new_title text DEFAULT NULL
)
RETURNS TABLE(
  new_course_id uuid,
  modules_count int,
  lessons_count int,
  homework_count int,
  quiz_count int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _new_id uuid := gen_random_uuid();
  _src_title text;
  _mc int; _lc int; _hc int; _qc int; _hc2 int;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'admin'::app_role)
          OR public.has_role(auth.uid(), 'superadmin'::app_role)) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  SELECT title INTO _src_title FROM public.courses WHERE id = _source_course_id;
  IF _src_title IS NULL THEN RAISE EXCEPTION 'source course not found'; END IF;

  -- 1) Course (hidden; never the signup default)
  INSERT INTO public.courses (id, title, tagline, description, cover_url, duration_hours,
                              published, is_default_for_signup, ai_system_prompt, ai_knowledge_paths)
  SELECT _new_id, COALESCE(NULLIF(btrim(_new_title), ''), 'Copy of ' || _src_title),
         tagline, description, cover_url, duration_hours,
         false, false, ai_system_prompt, ai_knowledge_paths
  FROM public.courses WHERE id = _source_course_id;

  -- 2) Modules (old->new id map)
  CREATE TEMP TABLE _modmap (old_id uuid PRIMARY KEY, new_id uuid NOT NULL) ON COMMIT DROP;
  INSERT INTO _modmap (old_id, new_id)
  SELECT id, gen_random_uuid() FROM public.modules WHERE course_id = _source_course_id;

  INSERT INTO public.modules (id, course_id, title, summary, position)
  SELECT mm.new_id, _new_id, m.title, m.summary, m.position
  FROM public.modules m JOIN _modmap mm ON mm.old_id = m.id
  WHERE m.course_id = _source_course_id;
  GET DIAGNOSTICS _mc = ROW_COUNT;

  -- 3) Lessons (video fields verbatim = shared asset)
  INSERT INTO public.lessons (id, module_id, title, description, video_url, video_storage_path,
                              provider_video_id, video_provider, thumbnail_path, duration_seconds,
                              position, published, transcript, resources)
  SELECT gen_random_uuid(), mm.new_id, l.title, l.description, l.video_url, l.video_storage_path,
         l.provider_video_id, l.video_provider, l.thumbnail_path, l.duration_seconds,
         l.position, l.published, l.transcript, l.resources
  FROM public.lessons l
  JOIN public.modules m ON m.id = l.module_id
  JOIN _modmap mm ON mm.old_id = m.id
  WHERE m.course_id = _source_course_id;
  GET DIAGNOSTICS _lc = ROW_COUNT;

  -- 4) Quiz questions
  INSERT INTO public.quiz_questions (id, module_id, question, options, correct_index, explanation, position)
  SELECT gen_random_uuid(), mm.new_id, q.question, q.options, q.correct_index, q.explanation, q.position
  FROM public.quiz_questions q JOIN _modmap mm ON mm.old_id = q.module_id;
  GET DIAGNOSTICS _qc = ROW_COUNT;

  -- 5) Homework assignments (two-pass: roots first, then SAP children with parent remap)
  CREATE TEMP TABLE _hwmap (old_id uuid PRIMARY KEY, new_id uuid NOT NULL) ON COMMIT DROP;
  INSERT INTO _hwmap (old_id, new_id)
  SELECT ha.id, gen_random_uuid()
  FROM public.homework_assignments ha JOIN _modmap mm ON mm.old_id = ha.module_id;

  -- pass 1: roots (parent_id IS NULL)
  INSERT INTO public.homework_assignments (id, module_id, title, description, prompt_uz, prompt_ru, prompt_en,
                                           max_score, due_days_after_module_unlock, task_number, is_active,
                                           parent_id, sap_number, created_by)
  SELECT hm.new_id, mm.new_id, ha.title, ha.description, ha.prompt_uz, ha.prompt_ru, ha.prompt_en,
         ha.max_score, ha.due_days_after_module_unlock, ha.task_number, ha.is_active,
         NULL, ha.sap_number, ha.created_by
  FROM public.homework_assignments ha
  JOIN _modmap mm ON mm.old_id = ha.module_id
  JOIN _hwmap hm ON hm.old_id = ha.id
  WHERE ha.parent_id IS NULL;
  GET DIAGNOSTICS _hc = ROW_COUNT;

  -- pass 2: SAP children (parent_id remapped to the new parent)
  INSERT INTO public.homework_assignments (id, module_id, title, description, prompt_uz, prompt_ru, prompt_en,
                                           max_score, due_days_after_module_unlock, task_number, is_active,
                                           parent_id, sap_number, created_by)
  SELECT hm.new_id, mm.new_id, ha.title, ha.description, ha.prompt_uz, ha.prompt_ru, ha.prompt_en,
         ha.max_score, ha.due_days_after_module_unlock, ha.task_number, ha.is_active,
         pm.new_id, ha.sap_number, ha.created_by
  FROM public.homework_assignments ha
  JOIN _modmap mm ON mm.old_id = ha.module_id
  JOIN _hwmap hm ON hm.old_id = ha.id
  JOIN _hwmap pm ON pm.old_id = ha.parent_id
  WHERE ha.parent_id IS NOT NULL;
  GET DIAGNOSTICS _hc2 = ROW_COUNT;
  _hc := _hc + _hc2;

  RETURN QUERY SELECT _new_id, _mc, _lc, _hc, _qc;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_duplicate_course(uuid, text) TO authenticated;
