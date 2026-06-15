-- Phase 2 — tier ENFORCEMENT (the paywall) at the value-bearing RPCs.
-- Each gate uses has_module_access(uid, module): admin/teacher always pass; a NULL-tier
-- (every AI CREATORS 4.0 student) enrolled student always passes → byte-identical behavior
-- for the 489. Only a tiered (Premium/VIP) student hitting a module beyond their cap is denied.
-- The function bodies below are the CURRENTLY DEPLOYED versions with ONLY the gate added.

-- 1) track_video_progress: do not record progress / fire completion on a locked lesson.
CREATE OR REPLACE FUNCTION public.track_video_progress(
  p_lesson_id uuid, p_current_time numeric, p_duration numeric, p_delta_seconds numeric
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  uid uuid := auth.uid();
  delta numeric := LEAST(GREATEST(COALESCE(p_delta_seconds, 0), 0), 10);
  cur numeric := GREATEST(COALESCE(p_current_time, 0), 0);
  dur numeric := GREATEST(COALESCE(p_duration, 0), 0);
  new_max numeric;
  new_dur numeric;
  is_complete boolean := false;
  was_already_complete boolean := false;
  now_ts timestamptz := now();
  edge_url constant text := 'https://wpdztrijasgmxgliwddr.supabase.co/functions/v1/notify-completion';
  anon_key constant text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndwZHp0cmlqYXNnbXhnbGl3ZGRyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNjM1NDQsImV4cCI6MjA5MjczOTU0NH0.WvupCYAhOryyjpGeoSZBG87jgC6NLRQtHHFB7CoqYAc';
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  -- Tier gate (Phase 2): block recording on a module the student cannot access.
  -- NULL-tier / admin / teacher → has_module_access = true → unchanged for the 489.
  IF NOT public.has_module_access(uid, (SELECT module_id FROM public.lessons WHERE id = p_lesson_id)) THEN
    RAISE EXCEPTION 'module_locked';
  END IF;

  SELECT (completed_at IS NOT NULL) INTO was_already_complete
  FROM public.lesson_progress WHERE user_id = uid AND lesson_id = p_lesson_id;
  was_already_complete := COALESCE(was_already_complete, false);

  INSERT INTO public.lesson_progress (
    user_id, lesson_id, last_position_seconds, max_position_seconds,
    watch_seconds_total, duration_seconds_v2, updated_at
  ) VALUES (
    uid, p_lesson_id, cur, cur, delta, NULLIF(dur, 0), now_ts
  )
  ON CONFLICT (user_id, lesson_id) DO UPDATE SET
    last_position_seconds = cur,
    max_position_seconds = GREATEST(public.lesson_progress.max_position_seconds, cur),
    watch_seconds_total = public.lesson_progress.watch_seconds_total + delta,
    duration_seconds_v2 = CASE
      WHEN NULLIF(dur, 0) IS NULL THEN public.lesson_progress.duration_seconds_v2
      WHEN public.lesson_progress.duration_seconds_v2 IS NULL THEN NULLIF(dur, 0)
      WHEN dur < public.lesson_progress.duration_seconds_v2 * 0.95 THEN dur
      ELSE public.lesson_progress.duration_seconds_v2 END,
    updated_at = now_ts
  RETURNING max_position_seconds, COALESCE(duration_seconds_v2, NULLIF(dur, 0))
  INTO new_max, new_dur;

  IF new_dur IS NOT NULL AND new_dur > 0 AND ((new_max / new_dur) >= 0.85 OR new_max >= new_dur - 20) THEN
    UPDATE public.lesson_progress SET completed_at = COALESCE(completed_at, now_ts)
    WHERE user_id = uid AND lesson_id = p_lesson_id;
    is_complete := true;
  END IF;

  IF delta > 0 THEN
    INSERT INTO public.daily_watch_summary (user_id, watch_date, total_seconds, updated_at)
    VALUES (uid, (now_ts AT TIME ZONE 'Asia/Tashkent')::date, delta, now_ts)
    ON CONFLICT (user_id, watch_date) DO UPDATE SET
      total_seconds = public.daily_watch_summary.total_seconds + EXCLUDED.total_seconds,
      updated_at = now_ts;
  END IF;

  IF is_complete AND NOT was_already_complete THEN
    BEGIN
      PERFORM net.http_post(
        url := edge_url,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', anon_key,
          'Authorization', 'Bearer ' || anon_key,
          'x-internal-secret', public.internal_fn_secret()
        ),
        body := jsonb_build_object('user_id', uid, 'lesson_id', p_lesson_id)
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'notify-completion dispatch failed for user % lesson %: % %', uid, p_lesson_id, SQLERRM, SQLSTATE;
    END;
  END IF;

  RETURN jsonb_build_object(
    'completed', is_complete,
    'last_position_seconds', cur,
    'max_position_seconds', new_max,
    'duration_seconds', new_dur
  );
END;
$function$;

-- 2) get_quiz_questions_for_module: return no rows for a locked module.
CREATE OR REPLACE FUNCTION public.get_quiz_questions_for_module(_module_id uuid)
RETURNS TABLE(id uuid, module_id uuid, question text, options jsonb, "position" int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT q.id, q.module_id, q.question, q.options, q."position"
  FROM public.quiz_questions q
  WHERE q.module_id = _module_id
    AND public.has_module_access(auth.uid(), _module_id)
  ORDER BY q."position";
$$;

-- 3) grade_quiz_attempt: reject grading a locked module.
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
  IF NOT public.has_module_access(uid, _module_id) THEN RAISE EXCEPTION 'module_locked'; END IF;
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
