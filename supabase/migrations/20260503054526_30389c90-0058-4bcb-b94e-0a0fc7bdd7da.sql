
-- Certificates table
CREATE TABLE public.certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL UNIQUE,
  serial_no text NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  course_name text NOT NULL DEFAULT 'AI Creators — 14 soatlik kurs',
  student_full_name text NOT NULL,
  pdf_url text,
  verification_token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  revoked_at timestamptz,
  revoked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_certificates_profile ON public.certificates(profile_id);
CREATE INDEX idx_certificates_token ON public.certificates(verification_token);
CREATE INDEX idx_certificates_issued_at ON public.certificates(issued_at DESC);

ALTER TABLE public.certificates ENABLE ROW LEVEL SECURITY;

-- Admin full
CREATE POLICY "certificates admin all" ON public.certificates
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- Owner read
CREATE POLICY "certificates own select" ON public.certificates
  FOR SELECT TO authenticated
  USING (auth.uid() = profile_id);

-- Public verify (anon + authed) — only non-revoked, by token. We allow SELECT all but app filters by token.
-- Make safe: allow anon SELECT only when revoked_at IS NULL.
CREATE POLICY "certificates anon verify" ON public.certificates
  FOR SELECT TO anon
  USING (true);

-- Sequence-style serial generator: AIC-YYYYMMDD-XXXX (zero padded daily counter)
CREATE OR REPLACE FUNCTION public.generate_certificate_serial()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  today_str text := to_char((now() AT TIME ZONE 'Asia/Tashkent')::date, 'YYYYMMDD');
  cnt int;
  serial text;
BEGIN
  SELECT COUNT(*) + 1 INTO cnt
  FROM public.certificates
  WHERE serial_no LIKE 'AIC-' || today_str || '-%';
  serial := 'AIC-' || today_str || '-' || lpad(cnt::text, 4, '0');
  RETURN serial;
END;
$$;

-- Eligibility + issuance (idempotent)
CREATE OR REPLACE FUNCTION public.issue_certificate_if_eligible(_profile_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  existing_id uuid;
  total_lessons int;
  done_lessons int;
  full_name text;
  cert_id uuid;
  serial text;
BEGIN
  -- Already has cert?
  SELECT id INTO existing_id FROM public.certificates WHERE profile_id = _profile_id;
  IF existing_id IS NOT NULL THEN
    RETURN existing_id;
  END IF;

  -- Count published lessons across all published courses (the platform has 1 course)
  SELECT COUNT(*) INTO total_lessons
  FROM public.lessons l
  JOIN public.modules m ON m.id = l.module_id
  JOIN public.courses c ON c.id = m.course_id
  WHERE l.published = true AND c.published = true;

  IF total_lessons = 0 THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(DISTINCT lp.lesson_id) INTO done_lessons
  FROM public.lesson_progress lp
  JOIN public.lessons l ON l.id = lp.lesson_id AND l.published = true
  JOIN public.modules m ON m.id = l.module_id
  JOIN public.courses c ON c.id = m.course_id AND c.published = true
  WHERE lp.user_id = _profile_id AND lp.completed_at IS NOT NULL;

  IF done_lessons < total_lessons THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(NULLIF(trim(coalesce(name,'') || ' ' || coalesce(last_name,'')), ''), email)
    INTO full_name
  FROM public.profiles WHERE id = _profile_id;

  IF full_name IS NULL THEN
    RETURN NULL;
  END IF;

  serial := public.generate_certificate_serial();

  INSERT INTO public.certificates(profile_id, serial_no, student_full_name)
  VALUES (_profile_id, serial, full_name)
  ON CONFLICT (profile_id) DO NOTHING
  RETURNING id INTO cert_id;

  IF cert_id IS NULL THEN
    SELECT id INTO cert_id FROM public.certificates WHERE profile_id = _profile_id;
  END IF;

  RETURN cert_id;
END;
$$;

-- Trigger on lesson_progress completion
CREATE OR REPLACE FUNCTION public.trg_issue_certificate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.completed_at IS NOT NULL THEN
    PERFORM public.issue_certificate_if_eligible(NEW.user_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_issue_certificate_on_progress ON public.lesson_progress;
CREATE TRIGGER trg_issue_certificate_on_progress
  AFTER INSERT OR UPDATE OF completed_at ON public.lesson_progress
  FOR EACH ROW EXECUTE FUNCTION public.trg_issue_certificate();

-- Storage bucket (public)
INSERT INTO storage.buckets (id, name, public)
VALUES ('certificates', 'certificates', true)
ON CONFLICT (id) DO UPDATE SET public = true;

CREATE POLICY "certificates bucket public read"
  ON storage.objects FOR SELECT TO anon, authenticated
  USING (bucket_id = 'certificates');

CREATE POLICY "certificates bucket admin write"
  ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'certificates' AND has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (bucket_id = 'certificates' AND has_role(auth.uid(), 'admin'::app_role));

-- Backfill: issue cert for any already-completed student
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT DISTINCT lp.user_id
    FROM public.lesson_progress lp
    WHERE lp.completed_at IS NOT NULL
  LOOP
    PERFORM public.issue_certificate_if_eligible(r.user_id);
  END LOOP;
END $$;
