// Telegram bot webhook. Receives Updates from api.telegram.org via setWebhook.
// Verifies X-Telegram-Bot-Api-Secret-Token, then dispatches commands.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-telegram-bot-api-secret-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Locale = "uz" | "ru" | "en";

function normLocale(code?: string | null): Locale {
  const l = (code || "").toLowerCase().slice(0, 2);
  if (l === "ru") return "ru";
  if (l === "en") return "en";
  return "uz";
}

const T = {
  uz: {
    expired: "Kirish havolasining muddati tugagan. Saytga qaytib qaytadan urinib ko'ring.",
    notEnrolled: (u: string) =>
      `Sizning <b>@${u}</b> akkauntingiz hali ro'yxatdan o'tmagan. Yordam uchun adminga murojaat qiling.`,
    contactAdmin: "💬 Admin bilan bog'lanish",
    noUsername:
      "Telegram'da @username o'rnatishingiz kerak. Settings → Username. Keyin qaytadan urinib ko'ring.",
    howTo: "❓ Qanday qilish kerak?",
    success: "Siz muvaffaqiyatli saytga kirdingiz. Endi saytga qaytib darsliklarni ko'rishingiz mumkin.",
    backToSite: "Saytga qaytish →",
    welcome: (n: string) =>
      `Xush kelibsiz, ${n}! Kursimizga qo'shilganingiz uchun rahmat. Quyidagi tugmalar orqali boshlashingiz mumkin:`,
    btnFirstLesson: "📚 Birinchi darsni ochish",
    btnCourse: "📋 Kurs sahifasi",
    btnHelp: "💬 Yordam",
    streakReply: (s: number, w: number, p: number) =>
      `🔥 Streak: <b>${s}</b> kun\n⏱ Bu hafta: <b>${w}</b> daqiqa\n📈 Kurs: <b>${p}%</b>`,
    nextLesson: "Keyingi dars sizni kutmoqda 👇",
    coursePage: "Kurs sahifasi 👇",
    certNotYet: "Sertifikatni kursni tugatgach yuboraman.",
    certReady: "Sertifikat tayyor! Yuklab oling 👇",
    helpReply: "Savollaringiz bo'lsa, biz bilan bog'laning:",
    chooseLang: "Tilni tanlang:",
    langSet: "Til o'zgartirildi ✅",
    noProfile: "Akkauntingiz topilmadi. Avval saytda ro'yxatdan o'tishingiz kerak.",
    noNextLesson: "Yangi dars yo'q. Keyinroq qayta urinib ko'ring.",
    noCourse: "Kurs topilmadi.",
    kbDavom: "📚 Davom etish",
    kbStreak: "📊 Statistikam",
    kbCert: "🎓 Sertifikat",
    kbLang: "🌐 Til",
    kbHelp: "❓ Yordam",
    kbHint: "👇 Quyidagi tugmalardan foydalaning",
  },
  ru: {
    expired: "Срок действия ссылки истёк. Вернитесь на сайт и попробуйте ещё раз.",
    notEnrolled: (u: string) =>
      `Аккаунт <b>@${u}</b> ещё не зарегистрирован. Свяжитесь с администратором.`,
    contactAdmin: "💬 Связаться с админом",
    noUsername:
      "Установите @username в Telegram: Settings → Username. Затем попробуйте снова.",
    howTo: "❓ Как это сделать?",
    success: "Вы успешно вошли в систему. Можете вернуться на сайт и продолжить обучение.",
    backToSite: "Вернуться на сайт →",
    welcome: (n: string) =>
      `Добро пожаловать, ${n}! Спасибо, что присоединились к курсу. Кнопки ниже помогут начать:`,
    btnFirstLesson: "📚 Открыть первый урок",
    btnCourse: "📋 Страница курса",
    btnHelp: "💬 Помощь",
    streakReply: (s: number, w: number, p: number) =>
      `🔥 Стрик: <b>${s}</b> дн.\n⏱ За неделю: <b>${w}</b> мин.\n📈 Курс: <b>${p}%</b>`,
    nextLesson: "Следующий урок ждёт 👇",
    coursePage: "Страница курса 👇",
    certNotYet: "Сертификат отправлю после завершения курса.",
    certReady: "Сертификат готов! Скачайте ниже 👇",
    helpReply: "Если есть вопросы — напишите нам:",
    chooseLang: "Выберите язык:",
    langSet: "Язык изменён ✅",
    noProfile: "Аккаунт не найден. Сначала зарегистрируйтесь на сайте.",
    noNextLesson: "Новых уроков нет. Попробуйте позже.",
    noCourse: "Курс не найден.",
    kbDavom: "📚 Продолжить",
    kbStreak: "📊 Моя статистика",
    kbCert: "🎓 Сертификат",
    kbLang: "🌐 Язык",
    kbHelp: "❓ Помощь",
    kbHint: "👇 Используйте кнопки ниже",
  },
  en: {
    expired: "Login link expired. Return to the site and try again.",
    notEnrolled: (u: string) =>
      `Your account <b>@${u}</b> is not enrolled yet. Please contact the admin.`,
    contactAdmin: "💬 Contact admin",
    noUsername:
      "Please set a @username in Telegram: Settings → Username. Then try again.",
    howTo: "❓ How to do this?",
    success: "You're logged in. Return to the site and continue learning.",
    backToSite: "Back to site →",
    welcome: (n: string) =>
      `Welcome, ${n}! Thanks for joining the course. Use the buttons below to get started:`,
    btnFirstLesson: "📚 Open first lesson",
    btnCourse: "📋 Course page",
    btnHelp: "💬 Help",
    streakReply: (s: number, w: number, p: number) =>
      `🔥 Streak: <b>${s}</b> days\n⏱ This week: <b>${w}</b> min\n📈 Course: <b>${p}%</b>`,
    nextLesson: "Your next lesson awaits 👇",
    coursePage: "Course page 👇",
    certNotYet: "I'll send your certificate once you finish the course.",
    certReady: "Certificate is ready! Download below 👇",
    helpReply: "Have questions? Reach out to us:",
    chooseLang: "Choose language:",
    langSet: "Language updated ✅",
    noProfile: "Account not found. Please sign up on the site first.",
    noNextLesson: "No new lesson. Check back later.",
    noCourse: "Course not found.",
  },
};

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const WEBHOOK_SECRET = Deno.env.get("BOT_WEBHOOK_SECRET") || "";
const SITE_URL = (Deno.env.get("SITE_URL") || "").replace(/\/$/, "");
const SUPPORT_HANDLE = Deno.env.get("TELEGRAM_SUPPORT_HANDLE") || ""; // e.g. "aicreators_support"

function tgApi(method: string, body: unknown) {
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function sendMessage(chatId: number, text: string, reply_markup?: unknown) {
  return tgApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(reply_markup ? { reply_markup } : {}),
  });
}

async function answerCallback(id: string, text?: string) {
  return tgApi("answerCallbackQuery", { callback_query_id: id, text: text || "" });
}

function randomToken(len = 32): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}

async function createMagicLink(
  admin: any,
  user_id: string,
  purpose: string,
  target_path?: string,
): Promise<string> {
  const token = randomToken(32);
  const { error } = await admin
    .from("telegram_magic_links")
    .insert({ token, user_id, purpose, target_path });
  if (error) throw error;
  return `${SITE_URL}/auth/magic?t=${token}`;
}

async function findProfileByTelegramId(admin: any, tgId: number) {
  const { data } = await admin
    .from("profiles")
    .select("id, name, last_name, telegram_username, telegram_id, telegram_onboarded_at, preferred_locale")
    .eq("telegram_id", tgId)
    .maybeSingle();
  return data;
}

async function findProfileByUsername(admin: any, username: string) {
  const { data } = await admin
    .from("profiles")
    .select("id, name, last_name, telegram_username, telegram_id, telegram_onboarded_at, preferred_locale")
    .ilike("telegram_username", username)
    .maybeSingle();
  return data;
}

async function getDefaultCourseId(admin: any): Promise<string | null> {
  const { data } = await admin
    .from("courses")
    .select("id, is_default_for_signup, created_at")
    .eq("published", true)
    .order("is_default_for_signup", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

async function getFirstLesson(admin: any, courseId: string) {
  const { data: modules } = await admin
    .from("modules")
    .select("id, position")
    .eq("course_id", courseId)
    .order("position", { ascending: true })
    .limit(1);
  if (!modules?.[0]) return null;
  const { data: lessons } = await admin
    .from("lessons")
    .select("id, position")
    .eq("module_id", modules[0].id)
    .eq("published", true)
    .order("position", { ascending: true })
    .limit(1);
  return lessons?.[0]?.id ?? null;
}

async function getNextIncompleteLesson(admin: any, userId: string, courseId: string) {
  // All published lessons in the course in order
  const { data: modules } = await admin
    .from("modules")
    .select("id, position")
    .eq("course_id", courseId)
    .order("position", { ascending: true });
  if (!modules?.length) return null;
  const moduleIds = modules.map((m: any) => m.id);
  const { data: lessons } = await admin
    .from("lessons")
    .select("id, module_id, position")
    .in("module_id", moduleIds)
    .eq("published", true);
  if (!lessons?.length) return null;
  const positionMap = new Map(modules.map((m: any, i: number) => [m.id, i]));
  lessons.sort((a: any, b: any) => {
    const pa = (positionMap.get(a.module_id) ?? 0) * 10000 + a.position;
    const pb = (positionMap.get(b.module_id) ?? 0) * 10000 + b.position;
    return pa - pb;
  });
  const { data: progress } = await admin
    .from("lesson_progress")
    .select("lesson_id, completed_at")
    .eq("user_id", userId);
  const completed = new Set((progress || []).filter((p: any) => p.completed_at).map((p: any) => p.lesson_id));
  const next = lessons.find((l: any) => !completed.has(l.id));
  return next ?? lessons[0];
}

async function computeStats(admin: any, userId: string) {
  const { data: streak } = await admin
    .from("streaks")
    .select("current_streak")
    .eq("user_id", userId)
    .maybeSingle();
  const sevenAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const { data: dws } = await admin
    .from("daily_watch_summary")
    .select("total_seconds, watch_date")
    .eq("user_id", userId)
    .gte("watch_date", sevenAgo);
  const weekSec = (dws || []).reduce((s: number, r: any) => s + Number(r.total_seconds || 0), 0);
  const courseId = await getDefaultCourseId(admin);
  let pct = 0;
  if (courseId) {
    const { data: modules } = await admin.from("modules").select("id").eq("course_id", courseId);
    const mids = (modules || []).map((m: any) => m.id);
    let total = 0;
    if (mids.length) {
      const { count } = await admin
        .from("lessons")
        .select("id", { count: "exact", head: true })
        .in("module_id", mids)
        .eq("published", true);
      total = count || 0;
    }
    const { data: progress } = await admin
      .from("lesson_progress")
      .select("lesson_id, completed_at")
      .eq("user_id", userId);
    const done = (progress || []).filter((p: any) => p.completed_at).length;
    pct = total ? Math.round((done / total) * 100) : 0;
  }
  return {
    streak: streak?.current_streak || 0,
    weekMin: Math.round(weekSec / 60),
    pct,
  };
}

async function handleStartLogin(admin: any, msg: any, token: string, locale: Locale) {
  const t = T[locale];
  const chatId = msg.chat.id;
  const tgId = msg.from.id as number;
  const tgUsername = (msg.from.username || "").toLowerCase();
  const firstName = msg.from.first_name || "";

  const { data: tokenRow } = await admin
    .from("telegram_login_tokens")
    .select("token, status, expires_at")
    .eq("token", token)
    .maybeSingle();
  if (!tokenRow || tokenRow.status !== "pending" || new Date(tokenRow.expires_at).getTime() < Date.now()) {
    await sendMessage(chatId, t.expired);
    return;
  }

  // Match: prefer telegram_id, fall back to username
  let profile = await findProfileByTelegramId(admin, tgId);
  if (!profile && tgUsername) {
    profile = await findProfileByUsername(admin, tgUsername);
  }

  if (!profile) {
    if (!tgUsername) {
      await sendMessage(chatId, t.noUsername, {
        inline_keyboard: [[{ text: t.howTo, url: "https://telegram.org/faq#usernames-and-t-me" }]],
      });
    } else {
      const adminBtn = SUPPORT_HANDLE
        ? [[{ text: t.contactAdmin, url: `https://t.me/${SUPPORT_HANDLE}` }]]
        : [];
      await sendMessage(chatId, t.notEnrolled(tgUsername), { inline_keyboard: adminBtn });
    }
    return;
  }

  // Persist telegram_id on first link
  const updates: Record<string, unknown> = {};
  if (!profile.telegram_id) updates.telegram_id = tgId;
  if (tgUsername && profile.telegram_username !== tgUsername) updates.telegram_username = tgUsername;
  if (Object.keys(updates).length) {
    await admin.from("profiles").update(updates).eq("id", profile.id);
  }

  // Mark token authenticated
  await admin
    .from("telegram_login_tokens")
    .update({ status: "authenticated", user_id: profile.id, authenticated_at: new Date().toISOString() })
    .eq("token", token);

  // Confirmation message with magic-link button
  const loginUrl = await createMagicLink(admin, profile.id, "login", "/dashboard");
  await sendMessage(chatId, t.success, {
    inline_keyboard: [[{ text: t.backToSite, url: loginUrl }]],
  });

  // Welcome onboarding (first time only)
  if (!profile.telegram_onboarded_at) {
    const courseId = await getDefaultCourseId(admin);
    const buttons: any[][] = [];
    if (courseId) {
      const firstLessonId = await getFirstLesson(admin, courseId);
      if (firstLessonId) {
        const url = await createMagicLink(admin, profile.id, "deeplink_lesson", `/lesson/${courseId}/${firstLessonId}`);
        buttons.push([{ text: t.btnFirstLesson, url }]);
      }
      const courseUrl = await createMagicLink(admin, profile.id, "deeplink_course", `/course/${courseId}`);
      buttons.push([{ text: t.btnCourse, url: courseUrl }]);
    }
    if (SUPPORT_HANDLE) {
      buttons.push([{ text: t.btnHelp, url: `https://t.me/${SUPPORT_HANDLE}` }]);
    }
    await sendMessage(chatId, t.welcome(firstName), { inline_keyboard: buttons });
    await admin.from("profiles").update({ telegram_onboarded_at: new Date().toISOString() }).eq("id", profile.id);
  }
}

async function handleCommand(admin: any, msg: any, cmdRaw: string) {
  const chatId = msg.chat.id;
  const tgId = msg.from.id as number;
  const profile = await findProfileByTelegramId(admin, tgId);
  const locale: Locale = profile?.preferred_locale
    ? normLocale(profile.preferred_locale)
    : normLocale(msg.from.language_code);
  const t = T[locale];

  if (!profile) {
    await sendMessage(chatId, t.noProfile);
    return;
  }

  const cmd = cmdRaw.split("@")[0].toLowerCase();

  if (cmd === "/davom") {
    const courseId = await getDefaultCourseId(admin);
    if (!courseId) {
      await sendMessage(chatId, t.noCourse);
      return;
    }
    const next = await getNextIncompleteLesson(admin, profile.id, courseId);
    if (!next) {
      await sendMessage(chatId, t.noNextLesson);
      return;
    }
    const url = await createMagicLink(admin, profile.id, "deeplink_lesson", `/lesson/${courseId}/${next.id}`);
    await sendMessage(chatId, t.nextLesson, { inline_keyboard: [[{ text: t.btnFirstLesson, url }]] });
    return;
  }

  if (cmd === "/dars") {
    const courseId = await getDefaultCourseId(admin);
    if (!courseId) {
      await sendMessage(chatId, t.noCourse);
      return;
    }
    const url = await createMagicLink(admin, profile.id, "deeplink_course", `/course/${courseId}`);
    await sendMessage(chatId, t.coursePage, { inline_keyboard: [[{ text: t.btnCourse, url }]] });
    return;
  }

  if (cmd === "/streak") {
    const s = await computeStats(admin, profile.id);
    await sendMessage(chatId, t.streakReply(s.streak, s.weekMin, s.pct));
    return;
  }

  if (cmd === "/sertifikat") {
    const s = await computeStats(admin, profile.id);
    if (s.pct >= 100) {
      await sendMessage(chatId, t.certReady);
    } else {
      await sendMessage(chatId, t.certNotYet);
    }
    return;
  }

  if (cmd === "/yordam") {
    const buttons = SUPPORT_HANDLE
      ? [[{ text: t.btnHelp, url: `https://t.me/${SUPPORT_HANDLE}` }]]
      : [];
    await sendMessage(chatId, t.helpReply, { inline_keyboard: buttons });
    return;
  }

  if (cmd === "/til") {
    await sendMessage(chatId, t.chooseLang, {
      inline_keyboard: [
        [
          { text: "🇺🇿 O'zbek", callback_data: "setlang:uz" },
          { text: "🇷🇺 Русский", callback_data: "setlang:ru" },
          { text: "🇬🇧 English", callback_data: "setlang:en" },
        ],
      ],
    });
    return;
  }
}

async function handleCallback(admin: any, cq: any) {
  const data: string = cq.data || "";
  const tgId = cq.from.id as number;
  const chatId = cq.message?.chat?.id;
  if (data.startsWith("setlang:") && chatId) {
    const lang = data.split(":")[1] as Locale;
    if (["uz", "ru", "en"].includes(lang)) {
      const profile = await findProfileByTelegramId(admin, tgId);
      if (profile) {
        await admin.from("profiles").update({ preferred_locale: lang }).eq("id", profile.id);
      }
      await answerCallback(cq.id);
      await sendMessage(chatId, T[lang].langSet);
      return;
    }
  }
  await answerCallback(cq.id);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  // Verify Telegram secret
  const incomingSecret = req.headers.get("x-telegram-bot-api-secret-token") || "";
  if (!WEBHOOK_SECRET || incomingSecret !== WEBHOOK_SECRET) {
    console.warn("webhook secret mismatch");
    return new Response("Forbidden", { status: 403, headers: corsHeaders });
  }
  if (!BOT_TOKEN) {
    return new Response("Bot not configured", { status: 500, headers: corsHeaders });
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400, headers: corsHeaders });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    if (update.message) {
      const msg = update.message;
      const text: string = msg.text || "";
      const profileForLocale = await findProfileByTelegramId(admin, msg.from.id);
      const locale: Locale = profileForLocale?.preferred_locale
        ? normLocale(profileForLocale.preferred_locale)
        : normLocale(msg.from.language_code);

      if (text.startsWith("/start ")) {
        const arg = text.slice(7).trim();
        if (arg.startsWith("login_")) {
          const tok = arg.slice(6);
          await handleStartLogin(admin, msg, tok, locale);
        } else {
          await sendMessage(msg.chat.id, T[locale].helpReply);
        }
      } else if (text === "/start") {
        await sendMessage(msg.chat.id, T[locale].helpReply);
      } else if (text.startsWith("/")) {
        await handleCommand(admin, msg, text.split(/\s+/)[0]);
      }
    } else if (update.callback_query) {
      await handleCallback(admin, update.callback_query);
    }
  } catch (e) {
    console.error("update handler error", e);
  }

  // Always 200 OK so Telegram doesn't retry
  return new Response("ok", { status: 200, headers: corsHeaders });
});
