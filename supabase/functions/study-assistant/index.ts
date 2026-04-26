// Streams an AI tutor response with retry, model fallback, error logging, multilingual + admin-trainable prompts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Primary: OpenAI GPT-5 mini via direct OpenAI API (uses OpenAI_AIStudentSupport secret).
// Fallbacks: Lovable AI gateway models (use LOVABLE_API_KEY) if OpenAI fails.
type ModelEntry = { provider: "openai" | "lovable"; model: string };
const MODEL_CHAIN: ModelEntry[] = [
  { provider: "openai", model: "gpt-5-mini" },
  { provider: "lovable", model: "google/gemini-3-flash-preview" },
  { provider: "lovable", model: "google/gemini-2.5-flash" },
];

const LANG_NAMES: Record<string, string> = {
  en: "English", ru: "Russian", uz: "Uzbek", es: "Spanish", pt: "Portuguese",
  ar: "Arabic", fr: "French", de: "German", hi: "Hindi", zh: "Chinese",
};

const DEFAULT_PROMPT =
  "You are a friendly study assistant for {course_title}. Answer in the student's chosen language. Use the lesson context when helpful: {transcript}. Be concise, encouraging, and ask follow-up questions when appropriate.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function logError(admin: any, row: any) {
  try { await admin.from("ai_chat_errors").insert(row); } catch (_) {}
}

async function recordMetric(admin: any, row: any) {
  try { await admin.from("ai_chat_metrics").insert(row); } catch (_) {}
}

async function embedQuery(apiKey: string, query: string): Promise<number[] | null> {
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "google/text-embedding-004", input: query }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data?.[0]?.embedding ?? null;
  } catch { return null; }
}

async function retrieveKnowledge(admin: any, apiKey: string, query: string, courseId: string | null): Promise<string> {
  const emb = await embedQuery(apiKey, query);
  if (!emb) return "";
  const { data, error } = await admin.rpc("match_ai_knowledge", {
    _query_embedding: emb as any,
    _course_id: courseId,
    _limit: 6,
  });
  if (error || !data || data.length === 0) return "";
  return data
    .map((r: any) => `[source: ${r.file_name}, chunk ${r.chunk_index}]\n${r.content}`)
    .join("\n\n---\n\n");
}

async function callUpstream(entry: ModelEntry, lovableKey: string, openaiKey: string | undefined, messages: any[]) {
  if (entry.provider === "openai") {
    if (!openaiKey) {
      return new Response("OpenAI key missing", { status: 401 });
    }
    return await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: entry.model, messages, stream: true }),
    });
  }
  return await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${lovableKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: entry.model, messages, stream: true }),
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  let userId: string | null = null;
  let lessonIdGlobal: string | null = null;

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY") || "";
    const OPENAI_API_KEY = Deno.env.get("OpenAI_AIStudentSupport") || Deno.env.get("OPENAI_API_KEY") || "";
    if (!LOVABLE_API_KEY && !OPENAI_API_KEY) throw new Error("No AI provider key configured");

    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await userClient.auth.getUser(jwt);
    const user = userData?.user;
    if (!user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    userId = user.id;

    const { lessonId, message, history, language } = await req.json();
    lessonIdGlobal = lessonId ?? null;
    if (!message || typeof message !== "string") {
      return new Response(JSON.stringify({ error: "message required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Lesson + course context
    let courseTitle = "this course";
    let transcript = "";
    let courseRow: any = null;
    if (lessonId) {
      const { data: lesson } = await admin
        .from("lessons")
        .select("title, description, transcript, modules(title, course_id, courses(id, title, ai_system_prompt, ai_knowledge_paths))")
        .eq("id", lessonId).maybeSingle();
      if (lesson) {
        courseTitle = (lesson as any).modules?.courses?.title ?? courseTitle;
        transcript = String(lesson.transcript ?? lesson.description ?? "").slice(0, 4000);
        courseRow = (lesson as any).modules?.courses ?? null;
      }
    }

    // Effective prompt: course override > platform default > built-in
    let effectivePrompt = DEFAULT_PROMPT;
    const { data: ps } = await admin.from("platform_settings").select("value").eq("key", "ai_assistant").maybeSingle();
    if (ps?.value) {
      const v = ps.value as any;
      if (typeof v.system_prompt === "string" && v.system_prompt.trim()) effectivePrompt = v.system_prompt;
    }
    if (courseRow?.ai_system_prompt && String(courseRow.ai_system_prompt).trim()) {
      effectivePrompt = courseRow.ai_system_prompt;
    }

    const langCode = (language || "en").toString().toLowerCase().slice(0, 5);
    const langName = LANG_NAMES[langCode] || LANG_NAMES[langCode.split("-")[0]] || "English";

    // Semantic retrieval: embed the user question, fetch top chunks across platform + course scope.
    const courseId: string | null = courseRow?.id ?? null;
    const knowledgeText = await retrieveKnowledge(admin, LOVABLE_API_KEY, message, courseId);

    const systemPrompt = effectivePrompt
      .replaceAll("{course_title}", courseTitle)
      .replaceAll("{transcript}", transcript || "(no transcript available)")
      .replaceAll("{language}", langName)
      + (knowledgeText ? `\n\n--- Reference material (cite by [source: filename] when used) ---\n${knowledgeText}` : "")
      + `\n\nIMPORTANT: Respond in ${langName}.`;

    // Persist user turn (best-effort)
    admin.from("ai_chat_messages").insert({
      user_id: user.id, lesson_id: lessonId ?? null, role: "user", content: message,
    }).then(() => {});

    const recent = Array.isArray(history) ? history.slice(-10) : [];
    const messages = [
      { role: "system", content: systemPrompt },
      ...recent.map((m: any) => ({ role: m.role, content: m.content })),
      { role: "user", content: message },
    ];

    // Try each model; for each model, retry up to 3 times with backoff on 5xx/429
    const startedAt = Date.now();
    let upstream: Response | null = null;
    let lastStatus = 0; let lastBody = ""; let usedModel = "";
    let totalAttempts = 0;
    outer: for (const entry of MODEL_CHAIN) {
      if (entry.provider === "openai" && !OPENAI_API_KEY) continue;
      if (entry.provider === "lovable" && !LOVABLE_API_KEY) continue;
      const modelLabel = `${entry.provider}:${entry.model}`;
      for (let attempt = 0; attempt < 3; attempt++) {
        totalAttempts++;
        const r = await callUpstream(entry, LOVABLE_API_KEY, OPENAI_API_KEY, messages);
        if (r.ok) { upstream = r; usedModel = modelLabel; break outer; }
        lastStatus = r.status;
        lastBody = (await r.text()).slice(0, 500);
        if (r.status === 402) {
          await logError(admin, { user_id: userId, lesson_id: lessonIdGlobal, model: modelLabel, status: 402, error_excerpt: lastBody });
          await recordMetric(admin, {
            user_id: userId, lesson_id: lessonIdGlobal, model: modelLabel, attempts: totalAttempts,
            fallback_used: entry !== MODEL_CHAIN[0], success: false, status: 402,
            latency_ms: Date.now() - startedAt, language: langCode,
          });
          return new Response(JSON.stringify({ error: "AI credits exhausted. Add credits in workspace settings.", retryable: false }), {
            status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        if (r.status >= 500 || r.status === 429) {
          await sleep([1000, 2000, 4000][attempt]);
          continue;
        }
        // Non-retryable client error
        await logError(admin, { user_id: userId, lesson_id: lessonIdGlobal, model: modelLabel, status: r.status, error_excerpt: lastBody });
        break;
      }
    }

    if (!upstream) {
      await logError(admin, { user_id: userId, lesson_id: lessonIdGlobal, model: "all", status: lastStatus, error_excerpt: lastBody });
      await recordMetric(admin, {
        user_id: userId, lesson_id: lessonIdGlobal, model: MODEL_CHAIN[MODEL_CHAIN.length - 1],
        attempts: totalAttempts, fallback_used: true, success: false, status: lastStatus,
        latency_ms: Date.now() - startedAt, language: langCode,
      });
      return new Response(JSON.stringify({
        error: "AI tutor is busy",
        hint: "All models returned errors. Please try again in a moment.",
        retryable: true, fallback: true,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Success metric (latency = time to first byte / headers)
    await recordMetric(admin, {
      user_id: userId, lesson_id: lessonIdGlobal, model: usedModel,
      attempts: totalAttempts, fallback_used: usedModel !== `${MODEL_CHAIN[0].provider}:${MODEL_CHAIN[0].model}`, success: true,
      status: 200, latency_ms: Date.now() - startedAt, language: langCode,
    });

    // Tee stream: one to client, one for capture + persistence
    const [streamA, streamB] = upstream.body!.tee();

    // Persist assistant turn (background)
    (async () => {
      try {
        const reader = streamB.getReader();
        const decoder = new TextDecoder();
        let buf = ""; let full = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) !== -1) {
            let line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            if (!line.startsWith("data: ")) continue;
            const json = line.slice(6).trim();
            if (json === "[DONE]") continue;
            try {
              const parsed = JSON.parse(json);
              const c = parsed.choices?.[0]?.delta?.content;
              if (c) full += c;
            } catch { /* partial */ }
          }
        }
        if (full) {
          await admin.from("ai_chat_messages").insert({
            user_id: user.id, lesson_id: lessonId ?? null, role: "assistant", content: full,
          });
        }
      } catch (e) { console.error("persist error", e); }
    })();

    // Wrap streamA with a defensive transformer that handles mid-stream errors gracefully
    const safeStream = new ReadableStream({
      async start(controller) {
        const reader = streamA.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (e) {
          console.error("stream interrupted", e);
          // Inject a final SSE chunk with the interruption note so the client renders it cleanly
          const interrupted = `data: ${JSON.stringify({
            choices: [{ delta: { content: "\n\n_(response interrupted)_" } }],
          })}\n\ndata: [DONE]\n\n`;
          controller.enqueue(new TextEncoder().encode(interrupted));
          controller.close();
          await logError(admin, { user_id: userId, lesson_id: lessonIdGlobal, model: usedModel, status: 0, error_excerpt: String(e).slice(0, 500) });
        }
      },
    });

    return new Response(safeStream, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("study-assistant error", e);
    await logError(admin, { user_id: userId, lesson_id: lessonIdGlobal, model: "n/a", status: 0, error_excerpt: String(e).slice(0, 500) });
    await recordMetric(admin, {
      user_id: userId, lesson_id: lessonIdGlobal, model: "n/a",
      attempts: 0, fallback_used: false, success: false, status: 0,
      latency_ms: 0, language: null,
    });
    return new Response(JSON.stringify({
      error: e instanceof Error ? e.message : String(e),
      retryable: true, fallback: true,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
