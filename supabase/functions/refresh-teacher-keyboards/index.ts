// One-time push to refresh every teacher's Telegram reply keyboard.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const __admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
let __sec: string | null = null;
async function __internalSecret(): Promise<string> {
  if (__sec) return __sec;
  const { data, error } = await __admin.rpc("internal_fn_secret");
  if (error) throw error;
  __sec = data as string;
  return __sec;
}

const KEYBOARDS = {
  uz: [["📝 Baholash", "📝 Vazifalar"], ["📊 Guruh statistikasi", "🏆 TOP talabalar"], ["👥 Mening talabalarim", "😴 Faolsizlar"], ["📣 Guruhga xabar", "⚙️ Sozlamalar"], ["🔄 Guruhni almashtirish"], ["🌐 Til"]],
  ru: [["📝 Оценить", "📝 Задания"], ["📊 Статистика группы", "🏆 ТОП студенты"], ["👥 Мои студенты", "😴 Неактивные"], ["📣 Сообщение группе", "⚙️ Настройки"], ["🔄 Сменить группу"], ["🌐 Язык"]],
  en: [["📝 Grade", "📝 Homework"], ["📊 Group stats", "🏆 Top students"], ["👥 My students", "😴 Inactive"], ["📣 Broadcast", "⚙️ Settings"], ["🔄 Switch group"], ["🌐 Language"]],
};

const NOTES = {
  uz: "🔄 <b>Yangilik!</b> Endi klaviaturada «🔄 Guruhni almashtirish» tugmasi bor. Bir nechta guruhga mas'ul bo'lsangiz, shu tugma orqali guruhlar o'rtasida almashib har birining statistikasi va talabalarini ko'rishingiz mumkin. /start bosishingiz shart emas.",
  ru: "🔄 <b>Обновление!</b> На клавиатуре появилась кнопка «🔄 Сменить группу». Если вы ведёте несколько групп, переключайтесь между ними этой кнопкой. Нажимать /start не нужно.",
  en: "🔄 <b>Update!</b> A new «🔄 Switch group» button is on your keyboard. If you teach multiple groups, switch between them with it. No need to press /start.",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const __p = req.headers.get("x-internal-secret");
  const __s = await __internalSecret();
  if (!__p || __p !== __s) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: "bot not configured" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const { data: roles, error: rolesErr } = await __admin.from("user_roles").select("user_id").eq("role", "teacher");
  if (rolesErr) {
    return new Response(JSON.stringify({ ok: false, error: rolesErr.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const ids = (roles || []).map((r: any) => r.user_id);
  if (!ids.length) {
    return new Response(JSON.stringify({ ok: true, sent: 0, failed: 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const { data: profs, error: profErr } = await __admin
    .from("profiles")
    .select("telegram_id, preferred_locale")
    .in("id", ids)
    .not("telegram_id", "is", null);
  if (profErr) {
    return new Response(JSON.stringify({ ok: false, error: profErr.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  let sent = 0, failed = 0;
  for (const p of (profs || []) as any[]) {
    const pl = String(p.preferred_locale || "").toLowerCase();
    const locale: "uz" | "ru" | "en" = pl.startsWith("ru") ? "ru" : pl.startsWith("en") ? "en" : "uz";
    try {
      const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: Number(p.telegram_id),
          parse_mode: "HTML",
          text: NOTES[locale],
          reply_markup: { keyboard: KEYBOARDS[locale], resize_keyboard: true, is_persistent: true },
        }),
      });
      if (!resp.ok) { failed++; const t = await resp.text().catch(() => ""); console.error("refresh kb fail", p.telegram_id, resp.status, t); }
      else { sent++; }
    } catch (e) {
      failed++;
      console.error("refresh kb exception", p.telegram_id, e);
    }
  }

  return new Response(JSON.stringify({ ok: true, sent, failed }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
