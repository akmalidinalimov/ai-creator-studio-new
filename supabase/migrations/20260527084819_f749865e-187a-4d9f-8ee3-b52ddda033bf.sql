
-- Tighten lesson_comments SELECT
DROP POLICY IF EXISTS "comments read" ON public.lesson_comments;
CREATE POLICY "comments read own or admin"
ON public.lesson_comments
FOR SELECT
TO authenticated
USING (auth.uid() = user_id OR has_role(auth.uid(), 'admin'::app_role));

-- Tighten lesson_ratings SELECT
DROP POLICY IF EXISTS "ratings read" ON public.lesson_ratings;
CREATE POLICY "ratings read own or admin"
ON public.lesson_ratings
FOR SELECT
TO authenticated
USING (auth.uid() = user_id OR has_role(auth.uid(), 'admin'::app_role));

-- Explicit admin-only SELECT on token tables (defense in depth)
DROP POLICY IF EXISTS "telegram_magic_links admin read" ON public.telegram_magic_links;
CREATE POLICY "telegram_magic_links admin read"
ON public.telegram_magic_links
FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role));

DROP POLICY IF EXISTS "telegram_login_tokens admin read" ON public.telegram_login_tokens;
CREATE POLICY "telegram_login_tokens admin read"
ON public.telegram_login_tokens
FOR SELECT
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role));
