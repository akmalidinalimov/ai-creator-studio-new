// One-tap teacher nudge: sends a warm "we miss you" DM to an inactive student
// via the bot. Teacher-scoped (is_teacher_of) + rate-limited to 1/day/student.
//
// 2026-09-30: with the student Mini App on (platform_settings.student_miniapp) the DM carries a "📚 Davom
// etish" web_app button that opens the Mini App at the student's next unfinished lesson (/continue). Flag
// off → no button, exactly as before (the text points at the reply keyboard's 📚 Davom etish).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { sendTelegram } from "../_shared/telegram-send.ts";
import { loadStudentMiniAppFlag, sendWithWatchFallback, watchButton } from "../_shared/miniapp-button.ts";
import { continuePath } from "../_shared/miniapp-links.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const BTN: Record<string, string> = { uz: "📚 Davom etish", ru: "📚 Продолжить", en: "📚 Continue" };

const MSG: Record<string, (teacher: string) => string> = {
  uz: (t) => `👋 Salom! Ustozingiz ${t} sizni sog'indi — darslar sizni kutmoqda!\n\nBugun 1 dars ko'rib, ritmga qaytamizmi? 🚀\n👇 "📚 Davom etish" tugmasini bosing.`,
  ru: (t) => `👋 Привет! Ваш устоз ${t} скучает — уроки ждут вас!\n\nВернёмся в ритм с одного урока сегодня? 🚀\n👇 Нажмите «📚 Davom etish».`,
  en: (t) => `👋 Hi! Your teacher ${t} misses you — the lessons are waiting!\n\nShall we get back on track with one lesson today? 🚀\n👇 Tap "📚 Davom etish".`,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const anon = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") || "" } },
    });
    const { data: who } = await anon.auth.getUser();
    if (!who?.user) return json({ error: "unauthorized" }, 401);

    const { student_id } = await req.json();
    if (!student_id) return json({ error: "student_id required" }, 400);

    // Caller must be a teacher (or admin) of this student.
    const [{ data: isTeacher }, { data: roles }] = await Promise.all([
      admin.rpc("is_teacher_of", { _student: student_id, _teacher: who.user.id }),
      admin.from("user_roles").select("role").eq("user_id", who.user.id),
    ]);
    const roleSet = new Set(((roles || []) as any[]).map((r) => r.role));
    if (!isTeacher && !roleSet.has("admin") && !roleSet.has("superadmin")) return json({ error: "forbidden" }, 403);

    // Rate limit: one nudge per student per 24h (any sender).
    const since = new Date(Date.now() - 86400_000).toISOString();
    const { count } = await admin.from("notifications_log")
      .select("id", { count: "exact", head: true })
      .eq("user_id", student_id).eq("notification_type", "teacher_nudge").gte("sent_at", since);
    if ((count || 0) > 0) return json({ error: "already_nudged_today" }, 429);

    const [{ data: st }, { data: tp }] = await Promise.all([
      admin.from("profiles").select("telegram_id, preferred_locale").eq("id", student_id).maybeSingle(),
      admin.from("profiles").select("name").eq("id", who.user.id).maybeSingle(),
    ]);
    if (!st?.telegram_id) return json({ error: "no_telegram" }, 400);

    const locale = ["uz", "ru", "en"].includes(st.preferred_locale) ? st.preferred_locale : "uz";
    const w = await watchButton({
      chat: "private", text: BTN[locale], flag: await loadStudentMiniAppFlag(admin), fn: "teacher-nudge-student", admin,
      miniPath: continuePath(), legacyPath: "/dashboard", track: { src: "teacher_nudge" },
      // no magicLink: flag off → no button, today's message exactly
    });
    const base = { chat_id: Number(st.telegram_id), text: MSG[locale](tp?.name || "ustoz") };
    const { result: out } = await sendWithWatchFallback(
      (p) => sendTelegram(Deno.env.get("TELEGRAM_BOT_TOKEN")!, "sendMessage", p, { admin, purpose: "teacher_nudge", recipientId: Number(st.telegram_id) }),
      w.button ? { ...base, reply_markup: { inline_keyboard: [[w.button]] } } : base,
      () => Promise.resolve(base), // a rejected web_app button → the plain message, as before
      { fn: "teacher-nudge-student", admin },
    );
    if (!out.ok) return json({ error: out.error || "send_failed" }, 502);

    await admin.from("notifications_log").insert({
      user_id: student_id, notification_type: "teacher_nudge",
      payload: { by: who.user.id, button_mode: w.mode }, sent_at: new Date().toISOString(),
    });
    return json({ ok: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "unknown" }, 500);
  }
});
