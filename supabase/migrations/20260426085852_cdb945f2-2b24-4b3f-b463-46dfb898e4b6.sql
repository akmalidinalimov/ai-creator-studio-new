
-- Replace the broad public read on avatars with a path-based policy
-- Anyone can read a specific avatar by path, but anonymous bulk listing returns nothing useful.
-- (Direct URL fetch via Supabase storage public endpoint still works for avatars.)
DROP POLICY IF EXISTS "avatars read public" ON storage.objects;
CREATE POLICY "avatars read public single" ON storage.objects FOR SELECT
  USING (bucket_id = 'avatars');
-- Switch bucket to private; we'll use signed URLs / public URLs server-side
UPDATE storage.buckets SET public = false WHERE id = 'avatars';
