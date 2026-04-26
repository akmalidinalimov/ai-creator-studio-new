## Problem with the current setup

The v1.3 update added an `ai-knowledge` bucket and a single-file picker, but the actual "training" is broken:

- **PDFs become garbage.** The function does `new TextDecoder("utf-8").decode(buf)` on raw PDF bytes — that's binary, not text.
- **Hard 8 KB cap per file.** A 30-hour course handbook gets truncated to ~2 pages.
- **Re-downloads + re-decodes every chat request.** Slow, wasteful, hits storage on every keystroke.
- **No retrieval.** Every file is concatenated into every prompt regardless of the question — wastes tokens and dilutes context.
- **Minimal admin UI.** No file size, upload date, page count, parse status, preview, or replace. No bulk upload, no drag-and-drop.

## What we'll build

### 1. Database — proper knowledge store

New migration adding:

- **`ai_knowledge_documents`** — one row per uploaded file
  - `id`, `scope` (`'platform'` | `'course'`), `course_id` (nullable), `file_path`, `file_name`, `mime_type`, `size_bytes`, `page_count`, `status` (`pending` | `processing` | `ready` | `failed`), `error`, `chunk_count`, `created_by`, `created_at`, `updated_at`
- **`ai_knowledge_chunks`** — searchable chunks
  - `id`, `document_id` (FK), `scope`, `course_id`, `chunk_index`, `content` (text, ~1200 chars), `tokens`, `embedding` (vector(768)), `created_at`
  - Enable `pgvector` extension; ivfflat index on `embedding`
- **RLS:** admin full access; `study-assistant` edge function reads via service role.
- **RPC `match_ai_knowledge(_query_embedding vector, _course_id uuid, _limit int)`** returns top-K chunks across platform-scope ∪ course-scope, ordered by cosine distance.

### 2. Edge function — `ingest-knowledge` (new)

Triggered after upload. For each document:

1. Download from `ai-knowledge` bucket.
2. Parse text:
   - `.txt` / `.md` → UTF-8 decode
   - `.pdf` → `unpdf` (Deno-compatible, pure JS, no native deps) → text + page count
   - `.docx` → `mammoth` via esm.sh
3. Chunk: ~1200 chars with 150-char overlap, split on paragraphs/sentences.
4. Embed each chunk via Lovable AI Gateway `text-embedding-004` (Google) — free tier, 768-dim.
5. Insert chunks; mark document `ready`. On failure, store `error` and mark `failed`.

Idempotent: re-running deletes old chunks for the document first.

### 3. Edge function — `study-assistant` (rewrite knowledge step)

Replace the broken "download + decode + slice 8KB" block with:

1. Embed the **user's question** (same model).
2. Call `match_ai_knowledge(query_embedding, course_id, 6)` → top 6 chunks (platform + course scope, course scope wins ties).
3. Inject only those chunks into the system prompt under `--- Reference material ---` with `[source: filename, chunk N]` citations.
4. Falls back gracefully to the old "no knowledge" path if pgvector returns nothing.

Result: PDFs actually work, large libraries work, and only the **relevant** ~5 KB is sent per query instead of crammed 40 KB.

### 4. Admin UI — full Knowledge Base manager

Rebuild the **AI Study Assistant** card on `/admin/settings` and the **CourseAIOverride** card to share a new `<KnowledgeManager scope="platform" />` / `<KnowledgeManager scope="course" courseId={id} />` component:

- **Drag-and-drop multi-file upload zone** (`.pdf`, `.docx`, `.txt`, `.md`) up to 20 MB each.
- Table of files with: name, size, pages, chunk count, status badge (`Processing…` / `Ready` / `Failed — retry`), uploaded date, uploader.
- Per-row actions: **Preview** (first 500 chars of extracted text in a dialog), **Re-index** (re-runs ingest), **Download original**, **Delete** (removes file + chunks).
- Live status: subscribe to `ai_knowledge_documents` realtime so badges flip from "Processing" to "Ready" without refresh.
- Footer stats: "12 documents · 847 chunks · 1.2 MB indexed".
- Help text explaining: "The assistant retrieves the 6 most relevant chunks per question — upload as much as you want."

### 5. Wiring + cleanup

- After upload, immediately invoke `ingest-knowledge` with the new document id (fire-and-forget; UI shows `Processing…`).
- Drop the old `knowledge_paths` array reads in the edge function (keep the column for back-compat for one release; auto-migrate any existing entries into `ai_knowledge_documents` rows on first admin visit).
- Update `src/integrations/supabase/types.ts` will regenerate automatically.

### 6. Self-test (after build)

1. As admin → `/admin/settings` → drag in a multi-page PDF course handbook → status flips to **Ready** within ~10 s, chunk count > 5.
2. Click **Preview** → see actual extracted text (not gibberish).
3. As student → ask "What does the handbook say about the refund policy?" → assistant answers using PDF content with a `[source: handbook.pdf]` citation.
4. As admin → `/admin/courses/<id>` → upload a course-specific `.docx` → that course's students get its content prioritized; other courses don't.
5. Delete a document → its chunks vanish; assistant stops citing it on next question.

### Files to touch

- **New migration**: `pgvector` ext, `ai_knowledge_documents`, `ai_knowledge_chunks`, RLS, `match_ai_knowledge` RPC.
- **New edge function**: `supabase/functions/ingest-knowledge/index.ts`.
- **Edit edge function**: `supabase/functions/study-assistant/index.ts` — swap knowledge step to embeddings retrieval.
- **New component**: `src/components/admin/KnowledgeManager.tsx`.
- **Edit**: `src/pages/admin/AdminSettings.tsx` (replace `AIAssistantCard` knowledge section) and `src/pages/admin/AdminCourseEditor.tsx` (replace `CourseAIOverride` knowledge section).

### Out of scope (call-outs)

- No OCR for image-only PDFs in this pass — text-layer PDFs only. We can add Tesseract-WASM later if needed.
- Embeddings use Google's `text-embedding-004` via Lovable AI Gateway (free, no extra key). If you'd rather use OpenAI's `text-embedding-3-small`, say so and I'll swap.

Approve and I'll build it in one pass.