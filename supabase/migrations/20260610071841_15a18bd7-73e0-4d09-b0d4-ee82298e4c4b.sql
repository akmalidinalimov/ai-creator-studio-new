CREATE TABLE IF NOT EXISTS public.weekly_group_star (
  group_id uuid NOT NULL,
  week_start date NOT NULL,
  user_id uuid NOT NULL,
  score int NOT NULL DEFAULT 0,
  dm_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, week_start)
);
GRANT SELECT ON public.weekly_group_star TO authenticated;
GRANT ALL ON public.weekly_group_star TO service_role;
ALTER TABLE public.weekly_group_star ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wgs admin read" ON public.weekly_group_star FOR SELECT TO authenticated
  USING (has_role(auth.uid(),'admin'::app_role));

CREATE OR REPLACE FUNCTION public.pick_weekly_group_stars()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.weekly_group_star (group_id, week_start, user_id, score)
  SELECT DISTINCT ON (p.group_id)
    p.group_id,
    (date_trunc('week', (now() AT TIME ZONE 'Asia/Tashkent'))::date),
    p.id,
    COALESCE(lc.score, 0)
  FROM profiles p
  JOIN leaderboard_cache lc ON lc.user_id = p.id
  WHERE p.group_id IS NOT NULL
  ORDER BY p.group_id, COALESCE(lc.score,0) DESC, COALESCE(lc.lessons_30d,0) DESC
  ON CONFLICT (group_id, week_start) DO NOTHING;
$$;

SELECT public.pick_weekly_group_stars();

CREATE OR REPLACE FUNCTION public.current_group_star(uid uuid)
RETURNS TABLE(first_name text, last_initial text, is_me boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(NULLIF(p.name,''),'Talaba'),
    COALESCE(LEFT(NULLIF(p.last_name,''),1),''),
    (wgs.user_id = uid)
  FROM weekly_group_star wgs
  JOIN profiles p ON p.id = wgs.user_id
  WHERE wgs.group_id = (SELECT group_id FROM profiles WHERE id = uid)
    AND wgs.week_start = (date_trunc('week', (now() AT TIME ZONE 'Asia/Tashkent'))::date)
  LIMIT 1;
$$;