-- No existing chunks to migrate (count = 0); safe to alter column type directly.
ALTER TABLE public.ai_knowledge_chunks
  ALTER COLUMN embedding TYPE vector(1536);

-- Recreate match function with the new vector dimension
DROP FUNCTION IF EXISTS public.match_ai_knowledge(vector, uuid, integer);

CREATE OR REPLACE FUNCTION public.match_ai_knowledge(
  _query_embedding vector(1536),
  _course_id uuid,
  _limit integer DEFAULT 6
)
RETURNS TABLE (
  chunk_id uuid,
  document_id uuid,
  file_name text,
  scope knowledge_scope,
  chunk_index integer,
  content text,
  similarity real
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT
    c.id AS chunk_id,
    c.document_id,
    d.file_name,
    c.scope,
    c.chunk_index,
    c.content,
    1 - (c.embedding <=> _query_embedding) AS similarity
  FROM public.ai_knowledge_chunks c
  JOIN public.ai_knowledge_documents d ON d.id = c.document_id
  WHERE d.status = 'ready'
    AND (
      c.scope = 'platform'
      OR (c.scope = 'course' AND _course_id IS NOT NULL AND c.course_id = _course_id)
    )
  ORDER BY c.embedding <=> _query_embedding
  LIMIT GREATEST(_limit, 1);
$$;