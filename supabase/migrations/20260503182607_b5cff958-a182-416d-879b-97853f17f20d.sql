
-- Homework schema
ALTER TABLE public.homework_assignments DROP CONSTRAINT IF EXISTS homework_assignments_module_id_key;
ALTER TABLE public.homework_assignments DROP CONSTRAINT IF EXISTS homework_assignments_max_score_check;
ALTER TABLE public.homework_assignments
  ADD COLUMN IF NOT EXISTS task_number int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE public.homework_assignments
  ADD CONSTRAINT homework_assignments_max_score_range CHECK (max_score >= 1 AND max_score <= 100);
CREATE UNIQUE INDEX IF NOT EXISTS homework_assignments_module_task_uniq
  ON public.homework_assignments(module_id, task_number);
CREATE UNIQUE INDEX IF NOT EXISTS homework_submissions_assign_user_uniq
  ON public.homework_submissions(assignment_id, user_id);

-- View
CREATE OR REPLACE VIEW public.vw_module_homework_score AS
SELECT
  hs.user_id AS profile_id,
  ha.module_id,
  COUNT(*) FILTER (WHERE hs.score IS NOT NULL) AS scored_tasks,
  COUNT(*) AS total_submitted_tasks,
  (SELECT COUNT(*) FROM public.homework_assignments ha2
    WHERE ha2.module_id = ha.module_id AND ha2.is_active = true) AS total_active_tasks_in_module,
  ROUND(
    (SUM(hs.score::numeric / NULLIF(ha.max_score, 0)) FILTER (WHERE hs.score IS NOT NULL)
      / NULLIF(COUNT(*) FILTER (WHERE hs.score IS NOT NULL), 0)) * 10,
    1
  ) AS avg_score_normalized
FROM public.homework_submissions hs
JOIN public.homework_assignments ha ON ha.id = hs.assignment_id
GROUP BY hs.user_id, ha.module_id;

-- app_settings
CREATE TABLE IF NOT EXISTS public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  description text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "app_settings admin select" ON public.app_settings;
CREATE POLICY "app_settings admin select" ON public.app_settings
  FOR SELECT TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));
DROP POLICY IF EXISTS "app_settings admin write" ON public.app_settings;
CREATE POLICY "app_settings admin write" ON public.app_settings
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Audit trigger: only record when an actor is known (skips seed)
CREATE OR REPLACE FUNCTION public.app_settings_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor uuid := COALESCE(NEW.updated_by, auth.uid());
BEGIN
  IF actor IS NOT NULL THEN
    INSERT INTO public.audit_log (actor_user_id, action, target_user_id, old_value, new_value)
    VALUES (
      actor, 'app_settings.update', NULL,
      CASE WHEN TG_OP = 'UPDATE' THEN jsonb_build_object('key', OLD.key, 'value', OLD.value) ELSE '{}'::jsonb END,
      jsonb_build_object('key', NEW.key, 'value', NEW.value)
    );
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS app_settings_audit_trg ON public.app_settings;
CREATE TRIGGER app_settings_audit_trg
  BEFORE INSERT OR UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.app_settings_audit();

INSERT INTO public.app_settings (key, value, description) VALUES
  ('homework.default_max_score', '10'::jsonb, 'Default max score for new homework tasks'),
  ('homework.default_tasks_per_module', '3'::jsonb, 'Suggested task count per module'),
  ('homework.allow_per_task_max_score', 'true'::jsonb, 'Allow admins to set custom max_score per task'),
  ('homework.comment_mode', '"off"'::jsonb, 'Teacher comment when scoring: off | optional | required'),
  ('engagement.daily_goal_default', '1'::jsonb, 'Default daily lesson goal'),
  ('engagement.streak_warning_after_days', '3'::jsonb, 'Days of inactivity before streak warning'),
  ('engagement.activity_score_weights', '{"lessons":0.4,"homework":0.3,"streak":0.2,"minutes":0.1}'::jsonb, 'Weights for activity score'),
  ('engagement.group_health_weights', '{"active":0.4,"completion":0.4,"score":0.2}'::jsonb, 'Weights for group health'),
  ('notifications.quiet_hours_start', '"22:00"'::jsonb, 'No notifications after this hour'),
  ('notifications.quiet_hours_end', '"08:00"'::jsonb, 'No notifications before this hour'),
  ('notifications.weekly_nudge_limit', '3'::jsonb, 'Max nudges per user per week'),
  ('notifications.broadcast_per_teacher_per_hour', '1'::jsonb, 'Teacher group broadcast rate limit'),
  ('re_engagement.default_cadence_days', '[0,3,7,14]'::jsonb, 'Default re-engagement cadence in days'),
  ('leaderboard.top_n', '10'::jsonb, 'Top N students on public leaderboard'),
  ('leaderboard.anonymize_last_name', 'true'::jsonb, 'Show only first letter of last name'),
  ('bot.test_recipient_username', '"alikhanova_admin"'::jsonb, 'Telegram username for "Test on me" buttons'),
  ('bot.magic_link_expiry_days', '7'::jsonb, 'How long magic links remain valid')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.get_setting(_key text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT value FROM public.app_settings WHERE key = _key;
$$;
CREATE OR REPLACE FUNCTION public.get_settings(_keys text[])
RETURNS TABLE(key text, value jsonb) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT key, value FROM public.app_settings WHERE key = ANY(_keys);
$$;
GRANT EXECUTE ON FUNCTION public.get_setting(text) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.get_settings(text[]) TO authenticated, anon;

-- bot_conversation_state
CREATE TABLE IF NOT EXISTS public.bot_conversation_state (
  telegram_id bigint PRIMARY KEY,
  state text NOT NULL,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);
ALTER TABLE public.bot_conversation_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bcs admin read" ON public.bot_conversation_state;
CREATE POLICY "bcs admin read" ON public.bot_conversation_state
  FOR SELECT TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));
