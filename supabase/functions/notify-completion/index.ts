// Sends a Telegram celebration when a lesson is completed for the first time.
// Invoked by the track_video_progress RPC via pg_net.
// verify_jwt = false (public endpoint; payload is server-trusted user_id+lesson_id from RPC).
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

const T = {
  uz: {
    lesson: (title: string, next: string) => `🎬 Darsni tugatdingiz: <b>${title}</b>\n\nKeyingi dars: ${next}`,
    nextBtn: "Keyingi dars →",
    moduleDone: (n: number, done: number, total: number, mins: number) =>
      `🎉 <b>Modul ${n} tugadi!</b>\n\n📊 ${done}/${total} dars\n⏱ ${mins} daqiqa o'rgandingiz\n\nKeyingi modulga o'tasizmi?`,
    nextModuleBtn: "Keyingi modul →",
    courseDone: (name: string) =>
      `🎓 Tabriklaymiz, <b>${name}</b>! Siz AI Creators kursini muvaffaqiyatli tugatdingiz!\n\n📜 Sertifikatingiz tayyor.`,
  },
  ru: {
    lesson: (title: string, next: string) => `🎬 Урок завершён: <b>${title}</b>\n\nСледующий урок: ${next}`,
    nextBtn: "Следующий урок →",
    moduleDone: (n: number, done: number, total: number, mins: number) =>
      `🎉 <b>Модуль ${n} завершён!</b>\n\n📊 ${done}/${total} уроков\n⏱ ${mins} минут обучения\n\nПерейти к следующему модулю?`,
    nextModuleBtn: "Следующий модуль →",
    courseDone: (name: string) =>
      `🎓 Поздравляем, <b>${name}</b>! Вы успешно завершили курс AI Creators!\n\n📜 Ваш сертификат готов.`,
  },
  en: {
    lesson: (title: string, next: string) => `🎬 Lesson completed: <b>${title}</b>\n\nNext lesson: ${next}`,
    nextBtn: "Next lesson →",
    moduleDone: (n: number, done: number, total: number, mins: number) =>
      `🎉 <b>Module ${n} completed!</b>\n\n📊 ${done}/${total} lessons\n⏱ ${mins} minutes studied\n\nMove to the next module?`,
    nextModuleBtn: "Next module →",
    courseDone: (name: string) =>
      `🎓 Congratulations, <b>${name}</b>! You've successfully completed the AI Creators course!\n\n📜 Your certificate is ready.`,
  },
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  let body: { user_id?: string; lesson_id?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400, headers: corsHeaders });
  }
  const { user_id, lesson_id } = body;
  if (!user_id || !lesson_id) {
    return new Response(JSON.stringify({ error: "user_id and lesson_id required" }), { status: 400, headers: corsHeaders });
  }

  if (!BOT_TOKEN) {
    return new Response(JSON.stringify({ error: "bot not configured" }), { status: 200, headers: corsHeaders });
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const { data: profile } = await admin
      .from("profiles")
      .select("id, name, last_name, telegram_id, preferred_locale, notifications_enabled")
      .eq("id", user_id)
      .maybeSingle();
    if (!profile || !profile.telegram_id || profile.notifications_enabled === false) {
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    const locale = normLocale(profile.preferred_locale);
    const t = T[locale];
    const chatId = Number(profile.telegram_id);
    const firstName = profile.name || "";

    const { data: lesson } = await admin
      .from("lessons")
      .select("id, title, position, module_id")
      .eq("id", lesson_id)
      .maybeSingle();
    if (!lesson) return new Response("ok", { status: 200, headers: corsHeaders });

    const { data: module } = await admin
      .from("modules")
      .select("id, title, position, course_id")
      .eq("id", lesson.module_id)
      .maybeSingle();
    if (!module) return new Response("ok", { status: 200, headers: corsHeaders });

    // All lessons in this module (ordered)
    const { data: moduleLessons } = await admin
      .from("lessons")
      .select("id, position")
      .eq("module_id", module.id)
      .eq("published", true)
      .order("position", { ascending: true });
    const moduleLessonIds = (moduleLessons || []).map((l: any) => l.id);
    const isLastLessonInModule =
      moduleLessons && moduleLessons.length > 0 && moduleLessons[moduleLessons.length - 1].id === lesson_id;

    // All modules in course (ordered)
    const { data: allModules } = await admin
      .from("modules")
      .select("id, position, title")
      .eq("course_id", module.course_id)
      .order("position", { ascending: true });
    const moduleIdx = (allModules || []).findIndex((m: any) => m.id === module.id);
    const nextModule = (allModules || [])[moduleIdx + 1] || null;
    const isLastModule = moduleIdx === (allModules || []).length - 1;

    // All published lessons across course
    const allModuleIds = (allModules || []).map((m: any) => m.id);
    const { data: allLessons } = await admin
      .from("lessons")
      .select("id, module_id, position, title")
      .in("module_id", allModuleIds.length ? allModuleIds : ["00000000-0000-0000-0000-000000000000"])
      .eq("published", true);
    const totalLessons = (allLessons || []).length;

    const { data: progressRows } = await admin
      .from("lesson_progress")
      .select("lesson_id, completed_at")
      .eq("user_id", user_id);
    const completedSet = new Set((progressRows || []).filter((p: any) => p.completed_at).map((p: any) => p.lesson_id));
    const totalCompleted = completedSet.size;

    const isCourseComplete = totalLessons > 0 && totalCompleted >= totalLessons;

    // ===== COURSE COMPLETION =====
    if (isCourseComplete && isLastLessonInModule && isLastModule) {
      const fullName = [profile.name, profile.last_name].filter(Boolean).join(" ") || firstName || "Student";
      await tg("sendMessage", {
        chat_id: chatId,
        text: t.courseDone(firstName || fullName),
        parse_mode: "HTML",
      });
      await logNotif(admin, user_id, "course_complete", { lesson_id, course_id: module.course_id });

      // Generate certificate PDF
      try {
        const certResp = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-certificate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id, course_id: module.course_id }),
        });
        if (certResp.ok) {
          const bytes = new Uint8Array(await certResp.arrayBuffer());
          const formData = new FormData();
          formData.append("chat_id", String(chatId));
          formData.append("caption", "AI Creators — Sertifikat");
          formData.append(
            "document",
            new Blob([bytes], { type: "application/pdf" }),
            `AI-Creators-Certificate-${fullName.replace(/\s+/g, "-")}.pdf`,
          );
          await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
            method: "POST",
            body: formData,
          });
        }
      } catch (e) {
        console.error("certificate dispatch failed", e);
      }
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // ===== MODULE COMPLETION =====
    if (isLastLessonInModule) {
      const completedInModule = moduleLessonIds.filter((id: string) => completedSet.has(id)).length;
      const { data: moduleProgress } = await admin
        .from("lesson_progress")
        .select("watch_seconds_total")
        .eq("user_id", user_id)
        .in("lesson_id", moduleLessonIds);
      const minutes = Math.round(
        (moduleProgress || []).reduce((s: number, r: any) => s + Number(r.watch_seconds_total || 0), 0) / 60,
      );
      const inlineButtons: any[][] = [];
      if (nextModule) {
        const { data: nextFirst } = await admin
          .from("lessons")
          .select("id")
          .eq("module_id", nextModule.id)
          .eq("published", true)
          .order("position", { ascending: true })
          .limit(1)
          .maybeSingle();
        if (nextFirst?.id) {
          const url = await magicLink(admin, user_id, `/lesson/${module.course_id}/${nextFirst.id}`);
          inlineButtons.push([{ text: t.nextModuleBtn, url }]);
        }
      }
      await tg("sendMessage", {
        chat_id: chatId,
        text: t.moduleDone(module.position + 1, completedInModule, moduleLessonIds.length, minutes),
        parse_mode: "HTML",
        reply_markup: inlineButtons.length ? { inline_keyboard: inlineButtons } : undefined,
      });
      await logNotif(admin, user_id, "module_complete", { module_id: module.id, lesson_id });
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

    // ===== SINGLE LESSON COMPLETION =====
    // Find next lesson in current module by position
    const sortedModuleLessons = (moduleLessons || []).sort((a: any, b: any) => a.position - b.position);
    const idx = sortedModuleLessons.findIndex((l: any) => l.id === lesson_id);
    const nextLesson = sortedModuleLessons[idx + 1];
    let nextTitle = "";
    let nextUrl = "";
    if (nextLesson) {
      const { data: nl } = await admin.from("lessons").select("title").eq("id", nextLesson.id).maybeSingle();
      nextTitle = nl?.title || "";
      nextUrl = await magicLink(admin, user_id, `/lesson/${module.course_id}/${nextLesson.id}`);
    }

    await tg("sendMessage", {
      chat_id: chatId,
      text: t.lesson(lesson.title, nextTitle || "—"),
      parse_mode: "HTML",
      reply_markup: nextUrl ? { inline_keyboard: [[{ text: t.nextBtn, url: nextUrl }]] } : undefined,
    });
    await logNotif(admin, user_id, "lesson_complete", { lesson_id });
  } catch (e) {
    console.error("notify-completion error", e);
  }

  return new Response("ok", { status: 200, headers: corsHeaders });
});
