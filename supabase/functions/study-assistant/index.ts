// Streams an AI tutor response with retry, model fallback, error logging, multilingual + admin-trainable prompts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MODEL_CHAIN = [
  "google/gemini-3-flash-preview",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
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

async function readKnowledgeText(admin: any, paths: string[]): Promise<string> {
  if (!paths || paths.length === 0) return "";
  const chunks: string[] = [];
  for (const p of paths) {
    try {
      const { data } = await admin.storage.from("ai-knowledge").download(p);
      if (!data) continue;
      const buf = new Uint8Array(await data.arrayBuffer());
      // Best-effort decode (PDFs return mostly binary; we still grab any embedded text strings)
      const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      // Strip control chars; keep first 8 KB
      const cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]+/g, " ").slice(0, 8192);
      chunks.push(`--- ${p} ---\n${cleaned}`);
    } catch (_) { /* ignore */ }
  }
  return chunks.join("\n\n");
}

async function callUpstream(model: string, apiKey: string, messages: any[]) {
  return await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true }),
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
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY missing");

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
    let knowledgePaths: string[] = [];
    const { data: ps } = await admin.from("platform_settings").select("value").eq("key", "ai_assistant").maybeSingle();
    if (ps?.value) {
      const v = ps.value as any;
      if (typeof v.system_prompt === "string" && v.system_prompt.trim()) effectivePrompt = v.system_prompt;
      if (Array.isArray(v.knowledge_paths)) knowledgePaths = v.knowledge_paths;
    }
    if (courseRow?.ai_system_prompt && String(courseRow.ai_system_prompt).trim()) {
      effectivePrompt = courseRow.ai_system_prompt;
    }
    if (Array.isArray(courseRow?.ai_knowledge_paths) && courseRow.ai_knowledge_paths.length > 0) {
      knowledgePaths = courseRow.ai_knowledge_paths;
    }

    const langCode = (language || "en").toString().toLowerCase().slice(0, 5);
    const langName = LANG_NAMES[langCode] || LANG_NAMES[langCode.split("-")[0]] || "English";

    const knowledgeText = await readKnowledgeText(admin, knowledgePaths);

    const systemPrompt = effectivePrompt
      .replaceAll("{course_title}", courseTitle)
      .replaceAll("{transcript}", transcript || "(no transcript available)")
      .replaceAll("{language}", langName)
      + (knowledgeText ? `\n\nAdditional reference material:\n${knowledgeText}` : "")
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
    let upstream: Response | null = null;
    let lastStatus = 0; let lastBody = ""; let usedModel = "";
    outer: for (const model of MODEL_CHAIN) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await callUpstream(model, LOVABLE_API_KEY, messages);
        if (r.ok) { upstream = r; usedModel = model; break outer; }
        lastStatus = r.status;
        lastBody = (await r.text()).slice(0, 500);
        if (r.status === 402) {
          await logError(admin, { user_id: userId, lesson_id: lessonIdGlobal, model, status: 402, error_excerpt: lastBody });
          return new Response(JSON.stringify({ error: "AI credits exhausted. Add credits in workspace settings.", retryable: false }), {
            status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        if (r.status >= 500 || r.status === 429) {
          await sleep([1000, 2000, 4000][attempt]);
          continue;
        }
        // Non-retryable client error
        await logError(admin, { user_id: userId, lesson_id: lessonIdGlobal, model, status: r.status, error_excerpt: lastBody });
        break;
      }
    }

    if (!upstream) {
      await logError(admin, { user_id: userId, lesson_id: lessonIdGlobal, model: "all", status: lastStatus, error_excerpt: lastBody });
      return new Response(JSON.stringify({
        error: "AI tutor is busy",
        hint: "All models returned errors. Please try again in a moment.",
        retryable: true, fallback: true,
      }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

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
    return new Response(JSON.stringify({
      error: e instanceof Error ? e.message : String(e),
      retryable: true, fallback: true,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
