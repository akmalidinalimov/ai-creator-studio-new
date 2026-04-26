// Streams an AI tutor response that knows the current lesson context.
// Uses the Lovable AI Gateway. Persists user + assistant turns in ai_chat_messages.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY missing");

    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace("Bearer ", "");
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await userClient.auth.getUser(jwt);
    const user = userData?.user;
    if (!user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { lessonId, message, history } = await req.json();
    if (!message || typeof message !== "string") {
      return new Response(JSON.stringify({ error: "message required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch lesson context with service role
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    let lessonCtx = "";
    if (lessonId) {
      const { data: lesson } = await admin
        .from("lessons")
        .select("title, description, transcript, modules(title, courses(title))")
        .eq("id", lessonId)
        .maybeSingle();
      if (lesson) {
        lessonCtx = `Course: ${(lesson as any).modules?.courses?.title ?? ""}
Module: ${(lesson as any).modules?.title ?? ""}
Lesson: ${lesson.title}
Description: ${lesson.description ?? ""}
${lesson.transcript ? `Transcript excerpt:\n${String(lesson.transcript).slice(0, 4000)}` : ""}`;
      }
    }

    const systemPrompt = `You are the AI Study Assistant for the AI Creators course platform. You help students learn by being clear, concise, and encouraging. Use markdown. Keep answers under ~250 words unless the student asks for depth. When asked for practice questions, return numbered questions and clearly mark answers below.

${lessonCtx ? `Current lesson context:\n${lessonCtx}` : "No specific lesson context provided."}`;

    // Persist user turn (best-effort; do not block on error)
    admin.from("ai_chat_messages").insert({
      user_id: user.id,
      lesson_id: lessonId ?? null,
      role: "user",
      content: message,
    }).then(() => {});

    const recent = Array.isArray(history) ? history.slice(-10) : [];

    const upstream = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: systemPrompt },
          ...recent.map((m: any) => ({ role: m.role, content: m.content })),
          { role: "user", content: message },
        ],
        stream: true,
      }),
    });

    if (!upstream.ok) {
      if (upstream.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit. Try again in a moment." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (upstream.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Add credits in workspace settings." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const t = await upstream.text();
      console.error("AI gateway error", upstream.status, t);
      return new Response(JSON.stringify({ error: "AI gateway error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Tee the stream so we can capture full assistant text and persist it.
    const [a, b] = upstream.body!.tee();
    (async () => {
      try {
        const reader = b.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let full = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) !== -1) {
            let line = buf.slice(0, i);
            buf = buf.slice(i + 1);
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
            user_id: user.id,
            lesson_id: lessonId ?? null,
            role: "assistant",
            content: full,
          });
        }
      } catch (e) {
        console.error("persist stream error", e);
      }
    })();

    return new Response(a, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("study-assistant error", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
