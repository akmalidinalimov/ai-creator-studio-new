
ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS homework_topic_url text,
  ADD COLUMN IF NOT EXISTS homework_topic_id bigint;

CREATE OR REPLACE FUNCTION public.groups_extract_homework_topic_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  m text[];
BEGIN
  IF NEW.homework_topic_url IS NULL OR length(trim(NEW.homework_topic_url)) = 0 THEN
    NEW.homework_topic_url := NULL;
    NEW.homework_topic_id := NULL;
    RETURN NEW;
  END IF;
  -- Match https://t.me/c/<chat>/<topic>[/...]
  m := regexp_match(NEW.homework_topic_url, '^https?://t\.me/c/\d+/(\d+)');
  IF m IS NOT NULL THEN
    NEW.homework_topic_id := (m[1])::bigint;
  ELSE
    NEW.homework_topic_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_groups_extract_homework_topic_id ON public.groups;
CREATE TRIGGER trg_groups_extract_homework_topic_id
BEFORE INSERT OR UPDATE OF homework_topic_url ON public.groups
FOR EACH ROW EXECUTE FUNCTION public.groups_extract_homework_topic_id();

CREATE INDEX IF NOT EXISTS idx_groups_homework_topic
  ON public.groups(homework_topic_id)
  WHERE homework_topic_id IS NOT NULL;

-- Backfill: most recent topic url per group from group_module_topics
WITH latest AS (
  SELECT DISTINCT ON (group_id) group_id, telegram_topic_url, telegram_topic_id
  FROM public.group_module_topics
  ORDER BY group_id, updated_at DESC NULLS LAST, created_at DESC NULLS LAST
)
UPDATE public.groups g
SET homework_topic_url = l.telegram_topic_url
FROM latest l
WHERE g.id = l.group_id
  AND g.homework_topic_url IS NULL
  AND l.telegram_topic_url IS NOT NULL;
