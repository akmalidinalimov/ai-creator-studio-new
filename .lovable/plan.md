## Problem

The "Loggedin" column shows inflated numbers like `19/4099` because the current `admin_group_engagement_stats` RPC does `COUNT(*)` after LEFT JOINing `auth_events` and `lesson_progress`. Each profile gets multiplied by the number of its sign-in events and recent lesson_progress rows, so `total_active` (the denominator) explodes far beyond the real student count.

Additionally, the user wants the "logged in" metric to mean: **student has either signed in to the platform OR linked/used the Telegram bot at least once**.

## Fix

Rewrite `admin_group_engagement_stats` using per-profile subqueries (no row multiplication), and broaden the "logged in" definition to include Telegram bot usage.

### New RPC logic

```sql
CREATE OR REPLACE FUNCTION public.admin_group_engagement_stats(
  p_window_days int DEFAULT 3,
  p_caller_profile_id uuid DEFAULT NULL
)
RETURNS TABLE(group_id uuid, total_active int, logged_in_count int, active_count int)
-- ... auth checks unchanged ...
RETURN QUERY
SELECT
  p.group_id,
  COUNT(*)::int AS total_active,
  COUNT(*) FILTER (
    WHERE EXISTS (SELECT 1 FROM auth_events ae WHERE ae.user_id = p.id AND ae.event = 'sign_in')
       OR p.telegram_id IS NOT NULL
       OR EXISTS (SELECT 1 FROM bot_sessions bs WHERE bs.user_id = p.id)
  )::int AS logged_in_count,
  COUNT(*) FILTER (
    WHERE EXISTS (
      SELECT 1 FROM lesson_progress lp
      WHERE lp.user_id = p.id AND lp.updated_at >= now() - make_interval(days => v_days)
    )
  )::int AS active_count
FROM profiles p
WHERE p.group_id IS NOT NULL AND p.archived_at IS NULL
GROUP BY p.group_id;
```

This guarantees `total_active` equals the real number of non-archived students per group, and `logged_in_count` = students who either signed into the web platform **or** linked / used the Telegram bot at least once.

## Files

- New migration: replace `admin_group_engagement_stats`.
- No frontend changes needed — `AdminGroups.tsx` already renders `logged_in_count / total_active` and the Faol % using the same fields.
