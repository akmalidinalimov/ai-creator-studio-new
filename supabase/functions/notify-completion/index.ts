// Sends a Telegram celebration when a lesson is completed for the first time.
// v2.0.1: copy from public.notification_templates; course completion also sends 1080x1080 share PNG.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Locale = "uz" | "ru" | "en";
const normLocale = (c?: string | null): Locale => {
  const l = (c || "").toLowerCase().slice(0, 2);
  if (l === "ru") return "ru";
  if (l === "en") return "en";
  return "uz";
};

const FALLBACK: Record<string, { body: string; button_label?: string }> = {
  lesson_complete: { body: "🎬 Lesson completed: <b>{{lesson_title}}</b>\n\nNext: {{next_lesson_title}}", button_label: "Next lesson →" },
  module_complete: { body: "🎉 <b>Module {{module_number}} completed!</b>\n📊 {{lessons_done}}/{{lessons_total}} • ⏱ {{minutes}} min", button_label: "Next module →" },
  course_complete: { body: "🎓 Congratulations, <b>{{first_name}}</b>! You've completed AI Creators!", button_label: "📤 Share" },
};

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const SITE_URL = (Deno.env.get("SITE_URL") || "").replace(/\/$/, "");

function tg(method: string, body: unknown) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function randomToken(len = 32): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}

async function magicLink(admin: any, user_id: string, target_path: string): Promise<string> {
  const token = randomToken(32);
  await admin.from("telegram_magic_links").insert({ token, user_id, purpose: "deeplink_lesson", target_path });
  return `${SITE_URL}/auth/magic?t=${token}`;
}

async function logNotif(admin: any, user_id: string, type: string, payload: Record<string, unknown>) {
  await admin.from("notifications_log").insert({ user_id, notification_type: type, payload });
}

type TplRow = { template_key: string; locale: string; body: string; button_label: string | null };
async function loadTemplate(admin: any, key: string, locale: Locale): Promise<{ body: string; button_label?: string }> {
  const { data } = await admin.from("notification_templates")
    .select("locale, body, button_label")
    .eq("template_key", key).in("locale", [locale, "uz"]);
  const exact = (data || []).find((r: any) => r.locale === locale);
  if (exact) return { body: exact.body, button_label: exact.button_label || undefined };
  const uz = (data || []).find((r: any) => r.locale === "uz");
  if (uz) return { body: uz.body, button_label: uz.button_label || undefined };
  console.warn(`[notify-completion] hardcoded fallback for ${key}`);
  return FALLBACK[key] || { body: "" };
}
function interpolate(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => String(vars[k] ?? ""));
}

const SHARE_CAPTION: Record<Locale, string> = {
  uz: "Sertifikatingiz va ulashish uchun rasm tayyor!",
  ru: "Ваш сертификат и картинка для шаринга готовы!",
  en: "Your certificate and shareable image are ready!",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  let body: { user_id?: string; lesson_id?: string };
  try { body = await req.json(); } catch { return new Response("Bad JSON", { status: 400, headers: corsHeaders }); }
  const { user_id, lesson_id } = body;
  if (!user_id || !lesson_id) {
    return new Response(JSON.stringify({ error: "user_id and lesson_id required" }), { status: 400, headers: corsHeaders });
  }
  if (!BOT_TOKEN) return new Response(JSON.stringify({ error: "bot not configured" }), { status: 200, headers: corsHeaders });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const { data: profile } = await admin.from("profiles")
      .select("id, name, last_name, telegram_id, preferred_locale, notifications_enabled")
      .eq("id", user_id).maybeSingle();
    if (!profile || !profile.telegram_id || profile.notifications_enabled === false) {
      return new Response("ok", { status: 200, headers: corsHeaders });
    }
    const locale = normLocale(profile.preferred_locale);
    const chatId = Number(profile.telegram_id);
    const firstName = profile.name || "";

    const { data: lesson } = await admin.from("lessons").select("id, title, position, module_id").eq("id", lesson_id).maybeSingle();
    if (!lesson) return new Response("ok", { status: 200, headers: corsHeaders });
    const { data: module } = await admin.from("modules").select("id, title, position, course_id").eq("id", lesson.module_id).maybeSingle();
    if (!module) return new Response("ok", { status: 200, headers: corsHeaders });

    const { data: moduleLessons } = await admin.from("lessons")
      .select("id, position, title").eq("module_id", module.id).eq("published", true)
      .order("position", { ascending: true });
    const moduleLessonIds = (moduleLessons || []).map((l: any) => l.id);
    const isLastLessonInModule = moduleLessons && moduleLessons.length > 0 && moduleLessons[moduleLessons.length - 1].id === lesson_id;

    const { data: allModules } = await admin.from("modules")
      .select("id, position, title").eq("course_id", module.course_id).order("position", { ascending: true });
    const moduleIdx = (allModules || []).findIndex((m: any) => m.id === module.id);
    const nextModule = (allModules || [])[moduleIdx + 1] || null;
    const isLastModule = moduleIdx === (allModules || []).length - 1;

    const allModuleIds = (allModules || []).map((m: any) => m.id);
    const { data: allLessons } = await admin.from("lessons")
      .select("id, module_id, position, title")
      .in("module_id", allModuleIds.length ? allModuleIds : ["00000000-0000-0000-0000-000000000000"])
      .eq("published", true);
    const totalLessons = (allLessons || []).length;

    const { data: progressRows } = await admin.from("lesson_progress")
      .select("lesson_id, completed_at").eq("user_id", user_id);
    const completedSet = new Set((progressRows || []).filter((p: any) => p.completed_at).map((p: any) => p.lesson_id));
    const totalCompleted = completedSet.size;
    const isCourseComplete = totalLessons > 0 && totalCompleted >= totalLessons;

    // ===== COURSE COMPLETION =====
    if (isCourseComplete && isLastLessonInModule && isLastModule) {
      const fullName = [profile.name, profile.last_name].filter(Boolean).join(" ") || firstName || "Student";
      const { data: course } = await admin.from("courses").select("title").eq("id", module.course_id).maybeSingle();
      const tpl = await loadTemplate(admin, "course_complete", locale);
      const text = interpolate(tpl.body, { first_name: firstName || fullName, full_name: fullName, course_title: course?.title || "AI Creators" });
      await tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
      await logNotif(admin, user_id, "course_complete", { lesson_id, course_id: module.course_id });

      const baseUrl = Deno.env.get("SUPABASE_URL");
      // PDF certificate
      try {
        const certResp = await fetch(`${baseUrl}/functions/v1/generate-certificate`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id, course_id: module.course_id }),
        });
        if (certResp.ok) {
          const bytes = new Uint8Array(await certResp.arrayBuffer());
          const fd = new FormData();
          fd.append("chat_id", String(chatId));
          fd.append("caption", "AI Creators — Sertifikat");
          fd.append("document", new Blob([bytes], { type: "application/pdf" }), `AI-Creators-Certificate-${fullName.replace(/\s+/g, "-")}.pdf`);
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, { method: "POST", body: fd });
        }
      } catch (e) { console.error("certificate dispatch failed", e); }

      // 1080x1080 shareable PNG
      try {
        const shareResp = await fetch(`${baseUrl}/functions/v1/generate-share-image`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id, course_id: module.course_id, locale }),
        });
        if (shareResp.ok) {
          const bytes = new Uint8Array(await shareResp.arrayBuffer());
          const fd = new FormData();
          fd.append("chat_id", String(chatId));
          fd.append("caption", SHARE_CAPTION[locale]);
          fd.append("reply_markup", JSON.stringify({ inline_keyboard: [[{ text: tpl.button_label || "📤 Share", callback_data: "share_intent" }]] }));
          fd.append("photo", new Blob([bytes], { type: "image/png" }), `AI-Creators-Share-${fullName.replace(/\s+/g, "-")}.png`);
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method: "POST", body: fd });
        }
      } catch (e) { console.error("share image dispatch failed", e); }

      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // ===== MODULE COMPLETION =====
    if (isLastLessonInModule) {
      const completedInModule = moduleLessonIds.filter((id: string) => completedSet.has(id)).length;
      const { data: moduleProgress } = await admin.from("lesson_progress")
        .select("watch_seconds_total").eq("user_id", user_id).in("lesson_id", moduleLessonIds);
      const minutes = Math.round((moduleProgress || []).reduce((s: number, r: any) => s + Number(r.watch_seconds_total || 0), 0) / 60);
      const tpl = await loadTemplate(admin, "module_complete", locale);
      const text = interpolate(tpl.body, {
        first_name: firstName,
        module_number: module.position + 1,
        lessons_done: completedInModule,
        lessons_total: moduleLessonIds.length,
        minutes,
      });
      const inline: any[][] = [];
      if (nextModule && tpl.button_label) {
        const { data: nextFirst } = await admin.from("lessons")
          .select("id").eq("module_id", nextModule.id).eq("published", true)
          .order("position", { ascending: true }).limit(1).maybeSingle();
        if (nextFirst?.id) {
          const url = await magicLink(admin, user_id, `/lesson/${module.course_id}/${nextFirst.id}`);
          inline.push([{ text: tpl.button_label, url }]);
        }
      }
      await tg("sendMessage", {
        chat_id: chatId, text, parse_mode: "HTML",
        reply_markup: inline.length ? { inline_keyboard: inline } : undefined,
      });
      await logNotif(admin, user_id, "module_complete", { module_id: module.id, lesson_id });
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // ===== SINGLE LESSON COMPLETION =====
    const sortedModuleLessons = (moduleLessons || []).sort((a: any, b: any) => a.position - b.position);
    const idx = sortedModuleLessons.findIndex((l: any) => l.id === lesson_id);
    const nextLesson = sortedModuleLessons[idx + 1];
    let nextTitle = "—";
    let nextUrl = "";
    if (nextLesson) {
      nextTitle = nextLesson.title || "—";
      nextUrl = await magicLink(admin, user_id, `/lesson/${module.course_id}/${nextLesson.id}`);
    }
    const tpl = await loadTemplate(admin, "lesson_complete", locale);
    const text = interpolate(tpl.body, { first_name: firstName, lesson_title: lesson.title, next_lesson_title: nextTitle });
    await tg("sendMessage", {
      chat_id: chatId, text, parse_mode: "HTML",
      reply_markup: nextUrl && tpl.button_label ? { inline_keyboard: [[{ text: tpl.button_label, url: nextUrl }]] } : undefined,
    });
    await logNotif(admin, user_id, "lesson_complete", { lesson_id });
  } catch (e) {
    console.error("notify-completion error", e);
  }

  return new Response("ok", { status: 200, headers: corsHeaders });
});
