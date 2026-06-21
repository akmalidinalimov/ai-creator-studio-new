-- Phase 0 (M18): fixed-window per-IP rate-limit store for edge functions.
-- Used by the public sheet-sync endpoint (now server-to-server only, but kept
-- rate-limited as defense-in-depth). Touched only by the service role.

CREATE TABLE IF NOT EXISTS public.edge_rate_limits (
  bucket text NOT NULL,                 -- e.g. 'sheet-sync:<ip>'
  window_start timestamptz NOT NULL,    -- start of the fixed window
  count int NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
ALTER TABLE public.edge_rate_limits ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: no authenticated/anon access. The service role bypasses RLS.
CREATE INDEX IF NOT EXISTS idx_edge_rate_limits_window ON public.edge_rate_limits(window_start);

-- Atomic increment-and-return for the current fixed window. Returns the new count.
CREATE OR REPLACE FUNCTION public.bump_rate_limit(_bucket text, _window_seconds int)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _ws timestamptz := to_timestamp(floor(extract(epoch from now()) / _window_seconds) * _window_seconds);
  _count int;
BEGIN
  INSERT INTO public.edge_rate_limits (bucket, window_start, count)
  VALUES (_bucket, _ws, 1)
  ON CONFLICT (bucket, window_start) DO UPDATE SET count = public.edge_rate_limits.count + 1
  RETURNING count INTO _count;
  RETURN _count;
END;
$$;
REVOKE ALL ON FUNCTION public.bump_rate_limit(text, int) FROM public, anon, authenticated;
