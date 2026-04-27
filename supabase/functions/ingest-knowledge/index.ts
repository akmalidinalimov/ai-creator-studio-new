// Parses an uploaded knowledge file, chunks it, embeds chunks, and stores them.
// Triggered by the admin UI immediately after upload, or as a re-index.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { extractText, getDocumentProxy } from "https://esm.sh/unpdf@0.12.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// OpenAI embeddings (Lovable AI Gateway no longer exposes an embedding model).
// 1536-dim, matches ai_knowledge_chunks.embedding column.
const EMBED_MODEL = "text-embedding-3-small";
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;

function chunkText(text: string): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const out: string[] = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + CHUNK_SIZE, clean.length);
    if (end < clean.length) {
      // try to break on a sentence boundary
      const slice = clean.slice(i, end);
      const lastPeriod = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("? "), slice.lastIndexOf("! "));
      if (lastPeriod > CHUNK_SIZE * 0.5) end = i + lastPeriod + 1;
    }
    out.push(clean.slice(i, end).trim());
    if (end >= clean.length) break;
    i = Math.max(end - CHUNK_OVERLAP, i + 1);
  }
  return out.filter((c) => c.length > 20);
}

async function parseDocument(bytes: Uint8Array, mime: string, name: string): Promise<{ text: string; pageCount: number | null }> {
  const lower = name.toLowerCase();
  if (lower.endsWith(".txt") || lower.endsWith(".md") || mime.startsWith("text/")) {
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), pageCount: null };
  }
  if (lower.endsWith(".pdf") || mime === "application/pdf") {
    const pdf = await getDocumentProxy(bytes);
    const { text, totalPages } = await extractText(pdf, { mergePages: true });
    return { text: Array.isArray(text) ? text.join("\n\n") : String(text), pageCount: totalPages ?? null };
  }
  if (lower.endsWith(".docx")) {
    const mammoth: any = await import("https://esm.sh/mammoth@1.8.0/mammoth.browser.js");
    const result = await mammoth.extractRawText({ arrayBuffer: bytes.buffer });
    return { text: String(result.value || ""), pageCount: null };
  }
  // Fallback: try utf-8
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), pageCount: null };
}

async function embedBatch(apiKey: string, inputs: string[]): Promise<number[][]> {
  // OpenAI embeddings API. Batch up to 16 inputs per call (matches caller).
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`embed ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  return (json.data ?? []).map((d: any) => d.embedding as number[]);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const OPENAI_API_KEY = Deno.env.get("OpenAI_AIStudentSupport") || Deno.env.get("OPENAI_API_KEY");
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    if (!OPENAI_API_KEY) throw new Error("OpenAI API key missing (OpenAI_AIStudentSupport)");

    // Auth: require an admin caller
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await userClient.auth.getUser(authHeader.replace("Bearer ", ""));
    const user = userData?.user;
    if (!user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { data: roleRow } = await admin.from("user_roles").select("role").eq("user_id", user.id).eq("role", "admin").maybeSingle();
    if (!roleRow) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { documentId } = await req.json();
    if (!documentId) return new Response(JSON.stringify({ error: "documentId required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    const { data: doc, error: docErr } = await admin
      .from("ai_knowledge_documents")
      .select("*")
      .eq("id", documentId)
      .maybeSingle();
    if (docErr || !doc) throw new Error(docErr?.message || "document not found");

    await admin.from("ai_knowledge_documents").update({ status: "processing", error: null }).eq("id", documentId);

    // Wipe any prior chunks (idempotent re-index)
    await admin.from("ai_knowledge_chunks").delete().eq("document_id", documentId);

    // Download file
    const { data: blob, error: dlErr } = await admin.storage.from("ai-knowledge").download(doc.file_path);
    if (dlErr || !blob) throw new Error(dlErr?.message || "download failed");
    const bytes = new Uint8Array(await blob.arrayBuffer());

    // Parse + chunk
    const { text, pageCount } = await parseDocument(bytes, doc.mime_type || "", doc.file_name);
    const chunks = chunkText(text);
    if (chunks.length === 0) throw new Error("no extractable text — is this a scanned image PDF?");

    // Embed in batches of 16
    const BATCH = 16;
    const rows: any[] = [];
    for (let i = 0; i < chunks.length; i += BATCH) {
      const slice = chunks.slice(i, i + BATCH);
      const embeddings = await embedBatch(LOVABLE_API_KEY, slice);
      for (let j = 0; j < slice.length; j++) {
        rows.push({
          document_id: documentId,
          scope: doc.scope,
          course_id: doc.course_id,
          chunk_index: i + j,
          content: slice[j],
          tokens: Math.ceil(slice[j].length / 4),
          embedding: embeddings[j] as any,
        });
      }
    }

    // Insert chunks
    const { error: insErr } = await admin.from("ai_knowledge_chunks").insert(rows);
    if (insErr) throw new Error(insErr.message);

    await admin.from("ai_knowledge_documents").update({
      status: "ready",
      page_count: pageCount,
      chunk_count: rows.length,
      preview: text.slice(0, 600),
      error: null,
    }).eq("id", documentId);

    return new Response(JSON.stringify({ ok: true, chunks: rows.length, pages: pageCount }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("ingest-knowledge error", e);
    try {
      const body = await req.clone().json().catch(() => ({}));
      if (body?.documentId) {
        await admin.from("ai_knowledge_documents").update({
          status: "failed",
          error: String(e instanceof Error ? e.message : e).slice(0, 500),
        }).eq("id", body.documentId);
      }
    } catch (_) {}
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
