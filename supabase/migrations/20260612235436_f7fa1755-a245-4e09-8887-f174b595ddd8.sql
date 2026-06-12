-- Recreate leaderboard_group_window with active-only member filter.
-- Same function from migration 20260609224813; only the WHERE clause is extended.

CREATE OR REPLACE FUNCTION public.leaderboard_group_window(uid uuid, _around int DEFAULT 2)
RETURNS TABLE(group_rank int, user_id uuid, first_name text, last_initial text, score int, is_me boolean, group_total int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH members AS (
    SELECT p.id,
           COALESCE(NULLIF(p.name,''), 'Talaba') AS first_name,
           COALESCE(LEFT(NULLIF(p.last_name,''),1), '') AS last_initial,
           COALESCE(lc.score, 0) AS score,
           ROW_NUMBER() OVER (ORDER BY COALESCE(lc.score,0) DESC, COALESCE(lc.lessons_30d,0) DESC) AS grank
    FROM profiles p
    LEFT JOIN leaderboard_cache lc ON lc.user_id = p.id
    WHERE p.group_id = (SELECT group_id FROM profiles WHERE id = uid)
      AND p.group_id IS NOT NULL
      AND p.status = 'active'
      AND p.archived_at IS NULL
  ),
  me AS (SELECT grank FROM members WHERE id = uid),
  total AS (SELECT COUNT(*)::int AS c FROM members)
  SELECT m.grank::int, m.id, m.first_name, m.last_initial, m.score::int,
         (m.id = uid), (SELECT c FROM total)
  FROM members m, me
  WHERE m.grank BETWEEN me.grank - _around AND me.grank + _around
  ORDER BY m.grank;
$$;