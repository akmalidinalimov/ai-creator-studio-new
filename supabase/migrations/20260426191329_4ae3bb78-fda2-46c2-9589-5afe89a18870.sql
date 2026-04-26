-- Vector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Scope enum
DO $$ BEGIN
  CREATE TYPE public.knowledge_scope AS ENUM ('platform', 'course');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.knowledge_status AS ENUM ('pending', 'processing', 'ready', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Documents
CREATE TABLE IF NOT EXISTS public.ai_knowledge_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope public.knowledge_scope NOT NULL,
  course_id UUID REFERENCES public.courses(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  page_count INT,
  status public.knowledge_status NOT NULL DEFAULT 'pending',
  error TEXT,
  chunk_count INT NOT NULL DEFAULT 0,
  preview TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_knowledge_documents_scope_idx ON public.ai_knowledge_documents(scope);
CREATE INDEX IF NOT EXISTS ai_knowledge_documents_course_idx ON public.ai_knowledge_documents(course_id);

CREATE TRIGGER trg_ai_knowledge_documents_updated_at
  BEFORE UPDATE ON public.ai_knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.ai_knowledge_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_knowledge_documents admin all"
  ON public.ai_knowledge_documents FOR ALL
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Chunks
CREATE TABLE IF NOT EXISTS public.ai_knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES public.ai_knowledge_documents(id) ON DELETE CASCADE,
  scope public.knowledge_scope NOT NULL,
  course_id UUID,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  tokens INT,
  embedding vector(768),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_doc_idx ON public.ai_knowledge_chunks(document_id);
CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_scope_idx ON public.ai_knowledge_chunks(scope, course_id);
CREATE INDEX IF NOT EXISTS ai_knowledge_chunks_embedding_idx
  ON public.ai_knowledge_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

ALTER TABLE public.ai_knowledge_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ai_knowledge_chunks admin all"
  ON public.ai_knowledge_chunks FOR ALL
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Search function (security definer; usable by any authenticated user via study-assistant)
CREATE OR REPLACE FUNCTION public.match_ai_knowledge(
  _query_embedding vector,
  _course_id UUID,
  _limit INT DEFAULT 6
)
RETURNS TABLE (
  chunk_id UUID,
  document_id UUID,
  file_name TEXT,
  scope public.knowledge_scope,
  chunk_index INT,
  content TEXT,
  similarity REAL
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
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

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.ai_knowledge_documents;