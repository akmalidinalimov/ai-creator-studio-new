
-- Restrict quiz_questions reads to admins; expose safe fields via RPC.
DROP POLICY IF EXISTS "quiz_q read" ON public.quiz_questions;
CREATE POLICY "quiz_q admin read" ON public.quiz_questions
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE OR REPLACE FUNCTION public.get_quiz_questions_for_module(_module_id uuid)
RETURNS TABLE(id uuid, module_id uuid, question text, options jsonb, "position" int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT q.id, q.module_id, q.question, q.options, q."position"
  FROM public.quiz_questions q
  WHERE q.module_id = _module_id
  ORDER BY q."position";
$$;

CREATE OR REPLACE FUNCTION public.grade_quiz_attempt(_module_id uuid, _answers jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  total int := 0;
  correct int := 0;
  pq jsonb := '[]'::jsonb;
  r record;
  uid uuid := auth.uid();
  ans int;
  is_correct boolean;
  pct int;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'unauthorized'; END IF;
  FOR r IN SELECT id, correct_index, explanation FROM public.quiz_questions WHERE module_id = _module_id LOOP
    total := total + 1;
    ans := NULLIF(_answers->>(r.id::text), '')::int;
    is_correct := ans IS NOT NULL AND ans = r.correct_index;
    IF is_correct THEN correct := correct + 1; END IF;
    pq := pq || jsonb_build_object(
      'id', r.id,
      'correct_index', r.correct_index,
      'explanation', r.explanation,
      'is_correct', is_correct
    );
  END LOOP;
  pct := CASE WHEN total > 0 THEN round(correct::numeric * 100 / total) ELSE 0 END;
  INSERT INTO public.quiz_attempts(user_id, module_id, score, answers) VALUES (uid, _module_id, pct, _answers);
  RETURN jsonb_build_object('score', pct, 'total', total, 'correct', correct, 'questions', pq);
END;
$$;

REVOKE ALL ON FUNCTION public.get_quiz_questions_for_module(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.grade_quiz_attempt(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_quiz_questions_for_module(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.grade_quiz_attempt(uuid, jsonb) TO authenticated;

-- Stop broadcasting admin-only document processing events to all subscribers.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'ai_knowledge_documents'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE public.ai_knowledge_documents';
  END IF;
END $$;
