
-- Public-anon read of published courses for the landing page
CREATE POLICY "courses public read published"
  ON public.courses
  FOR SELECT
  TO anon
  USING (published = true);

-- Public-anon read of modules whose parent course is published
CREATE POLICY "modules public read published parent"
  ON public.modules
  FOR SELECT
  TO anon
  USING (
    EXISTS (
      SELECT 1 FROM public.courses c
      WHERE c.id = modules.course_id AND c.published = true
    )
  );

-- Public-anon read of published lessons
CREATE POLICY "lessons public read published"
  ON public.lessons
  FOR SELECT
  TO anon
  USING (published = true);

-- Storage buckets
INSERT INTO storage.buckets (id, name, public)
VALUES ('instructor', 'instructor', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('showcase', 'showcase', true)
ON CONFLICT (id) DO NOTHING;

-- Public read for instructor bucket
CREATE POLICY "instructor public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'instructor');

CREATE POLICY "instructor admin write"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'instructor' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "instructor admin update"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'instructor' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "instructor admin delete"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'instructor' AND public.has_role(auth.uid(), 'admin'));

-- Public read for showcase bucket
CREATE POLICY "showcase public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'showcase');

CREATE POLICY "showcase admin write"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'showcase' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "showcase admin update"
  ON storage.objects FOR UPDATE
  USING (bucket_id = 'showcase' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "showcase admin delete"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'showcase' AND public.has_role(auth.uid(), 'admin'));
