// Notify admins (via Telegram) when a new student enrolls.
// Trigger: invoke from client after successful signup, or call manually.
// Body: { user_id: string }
// Uses notification_templates(admin_new_student, locale).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { sendTelegram } from "../_shared/telegram-send.ts";

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

const FALLBACK: Record<Locale, string> = {
  uz: "🆕 Yangi talaba: {{student_name}}\n📧 {{student_email}}\n📊 Jami talabalar: {{total_students}}",
  ru: "🆕 Новый студент: {{student_name}}\n📧 {{student_email}}\n📊 Всего студентов: {{total_students}}",
  en: "🆕 New student: {{student_name}}\n📧 {{student_email}}\n📊 Total students: {{total_students}}",
};

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";

const interpolate = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => String(vars[k] ?? ""));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (!BOT_TOKEN) return new Response(JSON.stringify({ error: "bot not configured" }), { status: 200, headers: corsHeaders });

  try {
    const { user_id } = await req.json().catch(() => ({}));
    if (!user_id || typeof user_id !== "string") {
      return new Response(JSON.stringify({ error: "user_id required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Look up the new student profile
    const { data: student } = await admin
      .from("profiles")
      .select("id, name, email")
      .eq("id", user_id)
      .maybeSingle();
    if (!student) {
      return new Response(JSON.stringify({ error: "profile not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Don't notify when an admin "signs up" again
    const { data: roleRows } = await admin.from("user_roles").select("role").eq("user_id", user_id);
    if ((roleRows || []).some((r: any) => r.role === "admin")) {
      return new Response(JSON.stringify({ ok: true, skipped: "admin user" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Total student count = profiles minus admins (matches dashboard definition)
    const { data: allUsers } = await admin.rpc("admin_list_users_internal");
    const total = ((allUsers || []) as any[]).filter((u) => !u.is_admin).length;

    // Load admin recipients
    const { data: roles } = await admin.from("user_roles").select("user_id").eq("role", "admin");
    const adminIds = (roles || []).map((r: any) => r.user_id);
    if (adminIds.length === 0) {
      return new Response(JSON.stringify({ ok: true, sent: 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: admins } = await admin
      .from("profiles")
      .select("id, telegram_id, preferred_locale, notifications_enabled")
      .in("id", adminIds)
      .eq("notifications_enabled", true)
      .not("telegram_id", "is", null);

    // Load templates once
    const { data: tplRows } = await admin
      .from("notification_templates")
      .select("locale, body")
      .eq("template_key", "admin_new_student");
    const tplMap = new Map<string, string>();
    for (const r of (tplRows || []) as any[]) tplMap.set(r.locale, r.body);
    const pickTpl = (l: Locale) => tplMap.get(l) || tplMap.get("uz") || FALLBACK[l];

    let sent = 0;
    for (const a of admins || []) {
      try {
        // Per-admin de-dup: don't notify same admin twice for the same student
        const { data: prior } = await admin
          .from("admin_notification_log")
          .select("id")
          .eq("user_id", a.id)
          .eq("notification_type", "admin_new_student")
          .contains("payload", { student_id: user_id } as any)
          .limit(1);
        if (prior && prior.length > 0) continue;

        const locale = normLocale(a.preferred_locale);
        const text = interpolate(pickTpl(locale), {
          student_name: student.name || student.email || "—",
          student_email: student.email || "—",
          total_students: total || 0,
        });
        const out = await sendTelegram(BOT_TOKEN, "sendMessage", { chat_id: Number(a.telegram_id), text }, { admin, purpose: "admin_new_student", recipientId: Number(a.telegram_id) });
        if (!out.ok) continue;
        await admin.from("admin_notification_log").insert({
          user_id: a.id,
          notification_type: "admin_new_student",
          payload: { student_id: user_id, student_name: student.name, student_email: student.email },
        });
        sent++;
      } catch (e) {
        console.error("admin notify loop", a.id, e);
      }
    }

    return new Response(JSON.stringify({ ok: true, sent, eligible: (admins || []).length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
