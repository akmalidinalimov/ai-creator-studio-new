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
    notRegistered:
      "Sizning Telegram ID hali ro'yxatdan o'tmagan. Adminga murojaat qilib, ID raqamingizni yuboring. ID olish uchun: /myid",
    myidResponse: (id: number) =>
      `Sizning Telegram ID: <code>${id}</code>\n\nUshbu raqamni adminga yuboring.`,
    notEnrolled: (u: string) =>
      `Sizning <b>@${u}</b> akkauntingiz hali ro'yxatdan o'tmagan. Yordam uchun adminga murojaat qiling.`,
    contactAdmin: "💬 Admin bilan bog'lanish",
    noUsername:
      "Telegram'da @username o'rnatishingiz kerak. Settings → Username. Keyin qaytadan urinib ko'ring.",
    howTo: "❓ Qanday qilish kerak?",
    success: "✅ Siz muvaffaqiyatli saytga kirdingiz. Endi saytga qaytib yoki shu telegram orqali darsliklarni ko'rishingiz mumkin.",
    backToSite: "Saytga qaytish →",
    welcome: (n: string) =>
      `Xush kelibsiz, ${n}! Kursimizga qo'shilganingiz uchun rahmat. Quyidagi tugmalar orqali boshlashingiz mumkin:`,
    btnFirstLesson: "📚 Darsni Ko'rish",
    btnCourse: "📋 Kurs sahifasi",
    btnHelp: "💬 Yordam",
    streakReply: (s: number, w: number, p: number) =>
      `🏆 G'alabangiz: <b>${s}</b> kun ketma-ket\n⏱ Bu hafta: <b>${w}</b> daqiqa\n📈 Kurs: <b>${p}%</b>`,
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
    kbCert: "📋 Kurs Modullari",
    kbLang: "🌐 Til",
    kbHelp: "❓ Yordam",
    kbHint: "👇 Quyidagi tugmalardan foydalaning",
    kbStreakOld: "📊 Statistikam",
    kbCertOld: "🎓 Sertifikat",
    settingsTitle: "⚙️ Bildirishnoma sozlamalari",
    settingsBell: (on: boolean) => `🔔 Kunlik eslatma: ${on ? "YOQILGAN" : "O'CHIRILGAN"}`,
    settingsTime: (t: string) => `⏰ Eslatma vaqti: ${t}`,
    settingsTz: (tz: string) => `🌍 Vaqt zonasi: ${tz}`,
    settingsDisableAll: "❌ Barcha bildirishnomalarni o'chirish",
    settingsPickHour: "Eslatma soatini tanlang:",
    settingsPickTz: "Vaqt zonasini tanlang:",
    settingsBellOn: "✅ Eslatmalar yoqildi",
    settingsBellOff: "🔕 Eslatmalar o'chirildi",
    settingsTimeSet: (t: string) => `⏰ Eslatma vaqti: ${t}`,
    settingsTzSet: (tz: string) => `🌍 Vaqt zonasi: ${tz}`,
    settingsAllOff: "🔕 Barcha bildirishnomalar o'chirildi",
    back: "← Orqaga",
  },
  ru: {
    expired: "Срок действия ссылки истёк. Вернитесь на сайт и попробуйте ещё раз.",
    notRegistered:
      "Ваш Telegram ID ещё не зарегистрирован. Свяжитесь с администратором и отправьте ему свой ID. Чтобы узнать ID: /myid",
    myidResponse: (id: number) =>
      `Ваш Telegram ID: <code>${id}</code>\n\nОтправьте этот номер администратору.`,
    notEnrolled: (u: string) =>
      `Аккаунт <b>@${u}</b> ещё не зарегистрирован. Свяжитесь с администратором.`,
    contactAdmin: "💬 Связаться с админом",
    noUsername:
      "Установите @username в Telegram: Settings → Username. Затем попробуйте снова.",
    howTo: "❓ Как это сделать?",
    success: "✅ Вы успешно вошли в систему. Можете вернуться на сайт или продолжить обучение прямо здесь, в Telegram.",
    backToSite: "Вернуться на сайт →",
    welcome: (n: string) =>
      `Добро пожаловать, ${n}! Спасибо, что присоединились к курсу. Кнопки ниже помогут начать:`,
    btnFirstLesson: "📚 Посмотреть урок",
    btnCourse: "📋 Страница курса",
    btnHelp: "💬 Помощь",
    streakReply: (s: number, w: number, p: number) =>
      `🏆 Ваша победа: <b>${s}</b> дней подряд\n⏱ За неделю: <b>${w}</b> мин.\n📈 Курс: <b>${p}%</b>`,
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
    kbCert: "📋 Модули курса",
    kbLang: "🌐 Язык",
    kbHelp: "❓ Помощь",
    kbHint: "👇 Используйте кнопки ниже",
    kbStreakOld: "📊 Моя статистика",
    kbCertOld: "🎓 Сертификат",
    settingsTitle: "⚙️ Настройки уведомлений",
    settingsBell: (on: boolean) => `🔔 Ежедневное напоминание: ${on ? "ВКЛ" : "ВЫКЛ"}`,
    settingsTime: (t: string) => `⏰ Время напоминания: ${t}`,
    settingsTz: (tz: string) => `🌍 Часовой пояс: ${tz}`,
    settingsDisableAll: "❌ Отключить все уведомления",
    settingsPickHour: "Выберите час напоминания:",
    settingsPickTz: "Выберите часовой пояс:",
    settingsBellOn: "✅ Напоминания включены",
    settingsBellOff: "🔕 Напоминания отключены",
    settingsTimeSet: (t: string) => `⏰ Время напоминания: ${t}`,
    settingsTzSet: (tz: string) => `🌍 Часовой пояс: ${tz}`,
    settingsAllOff: "🔕 Все уведомления отключены",
    back: "← Назад",
  },
  en: {
    expired: "Login link expired. Return to the site and try again.",
    notRegistered:
      "Your Telegram ID is not registered yet. Contact the admin and send them your ID. To get your ID: /myid",
    myidResponse: (id: number) =>
      `Your Telegram ID: <code>${id}</code>\n\nSend this number to the admin.`,
    notEnrolled: (u: string) =>
      `Your account <b>@${u}</b> is not enrolled yet. Please contact the admin.`,
    contactAdmin: "💬 Contact admin",
    noUsername:
      "Please set a @username in Telegram: Settings → Username. Then try again.",
    howTo: "❓ How to do this?",
    success: "✅ You're logged in. You can return to the site or continue learning right here in Telegram.",
    backToSite: "Back to site →",
    welcome: (n: string) =>
      `Welcome, ${n}! Thanks for joining the course. Use the buttons below to get started:`,
    btnFirstLesson: "📚 Watch lesson",
    btnCourse: "📋 Course page",
    btnHelp: "💬 Help",
    streakReply: (s: number, w: number, p: number) =>
      `🏆 Your streak: <b>${s}</b> days in a row\n⏱ This week: <b>${w}</b> min\n📈 Course: <b>${p}%</b>`,
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
    kbDavom: "📚 Continue",
    kbStreak: "📊 My stats",
    kbCert: "📋 Course modules",
    kbLang: "🌐 Language",
    kbHelp: "❓ Help",
    kbHint: "👇 Use the buttons below",
    kbStreakOld: "📊 My stats",
    kbCertOld: "🎓 Certificate",
    settingsTitle: "⚙️ Notification settings",
    settingsBell: (on: boolean) => `🔔 Daily reminder: ${on ? "ON" : "OFF"}`,
    settingsTime: (t: string) => `⏰ Reminder time: ${t}`,
    settingsTz: (tz: string) => `🌍 Timezone: ${tz}`,
    settingsDisableAll: "❌ Disable all notifications",
    settingsPickHour: "Pick the reminder hour:",
    settingsPickTz: "Pick a timezone:",
    settingsBellOn: "✅ Reminders enabled",
    settingsBellOff: "🔕 Reminders disabled",
    settingsTimeSet: (t: string) => `⏰ Reminder time: ${t}`,
    settingsTzSet: (tz: string) => `🌍 Timezone: ${tz}`,
    settingsAllOff: "🔕 All notifications disabled",
    back: "← Back",
  },
};

const TIMEZONES = [
  "Asia/Tashkent",
  "Asia/Almaty",
  "Asia/Bishkek",
  "Asia/Dushanbe",
  "Asia/Ashgabat",
  "Europe/Moscow",
  "Europe/Kiev",
  "Europe/Istanbul",
  "UTC",
];

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

function getMainKeyboard(locale: Locale) {
  const t = T[locale];
  return {
    keyboard: [
      [{ text: t.kbDavom }],
      [{ text: t.kbStreak }, { text: t.kbCert }],
      [{ text: t.kbLang }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

// Send a message that always carries the persistent reply keyboard.
async function sendWithKeyboard(chatId: number, text: string, locale: Locale) {
  return sendMessage(chatId, text, getMainKeyboard(locale));
}

// After sending an inline-keyboard message, follow up with a tiny hint that
// re-applies the persistent reply keyboard (since you can't combine both).
async function sendKeyboardHint(chatId: number, locale: Locale) {
  return sendMessage(chatId, T[locale].kbHint, getMainKeyboard(locale));
}

// Map ANY localized keyboard label to a canonical command, regardless of user's
// current locale (a student might tap a button rendered in their old locale).
function buttonTextToCommand(text: string): string | null {
  const trimmed = text.trim();
  for (const loc of ["uz", "ru", "en"] as Locale[]) {
    const t = T[loc] as any;
    if (trimmed === t.kbDavom) return "/davom";
    // New canonical g'alaba button + old "stats" labels as aliases.
    if (trimmed === t.kbStreak) return "/galaba";
    if (t.kbStreakOld && trimmed === t.kbStreakOld) return "/galaba";
    // New "Course modules" button routes to /dars; old cert label as alias.
    if (trimmed === t.kbCert) return "/dars";
    if (t.kbCertOld && trimmed === t.kbCertOld) return "/sertifikat";
    if (trimmed === t.kbLang) return "/til";
    if (trimmed === t.kbHelp) return "/yordam";
  }
  return null;
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

  // v2.1: strict match by Telegram numeric user_id only.
  // No more username matching — admin must pre-enter telegram_user_id for every student.
  const profile = await findProfileByTelegramId(admin, tgId);

  if (!profile) {
    const buttons: any[][] = [];
    if (SUPPORT_HANDLE) {
      buttons.push([{ text: t.contactAdmin, url: `https://t.me/${SUPPORT_HANDLE}` }]);
    }
    await sendMessage(chatId, t.notRegistered, buttons.length ? { inline_keyboard: buttons } : undefined);
    return;
  }

  // Refresh @username metadata for admin display only (does NOT affect login).
  if (tgUsername && profile.telegram_username !== tgUsername) {
    await admin.from("profiles").update({ telegram_username: tgUsername }).eq("id", profile.id);
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

  // Always introduce/refresh the persistent reply keyboard after login.
  await sendKeyboardHint(chatId, locale);
}

async function handleCommand(admin: any, msg: any, cmdRaw: string) {
  const chatId = msg.chat.id;
  const tgId = msg.from.id as number;
  const profile = await findProfileByTelegramId(admin, tgId);
  const locale: Locale = profile?.preferred_locale
    ? normLocale(profile.preferred_locale)
    : normLocale(msg.from.language_code);
  const t = T[locale];

  const cmd = cmdRaw.split("@")[0].toLowerCase();

  // /myid works for ANY user (registered or not). Handle before profile gate.
  if (cmd === "/myid") {
    await sendMessage(chatId, t.myidResponse(tgId));
    return;
  }

  if (!profile) {
    await sendMessage(chatId, cmd === "/start" ? t.notRegistered : t.noProfile);
    return;
  }

  if (cmd === "/davom") {
    const courseId = await getDefaultCourseId(admin);
    if (!courseId) {
      await sendWithKeyboard(chatId, t.noCourse, locale);
      return;
    }
    const next = await getNextIncompleteLesson(admin, profile.id, courseId);
    if (!next) {
      await sendWithKeyboard(chatId, t.noNextLesson, locale);
      return;
    }
    const url = await createMagicLink(admin, profile.id, "deeplink_lesson", `/lesson/${courseId}/${next.id}`);
    await sendMessage(chatId, t.nextLesson, { inline_keyboard: [[{ text: t.btnFirstLesson, url }]] });
    return;
  }

  if (cmd === "/dars") {
    const courseId = await getDefaultCourseId(admin);
    if (!courseId) {
      await sendWithKeyboard(chatId, t.noCourse, locale);
      return;
    }
    const url = await createMagicLink(admin, profile.id, "deeplink_course", `/course/${courseId}`);
    await sendMessage(chatId, t.coursePage, { inline_keyboard: [[{ text: t.btnCourse, url }]] });
    return;
  }

  if (cmd === "/galaba" || cmd === "/streak") {
    const s = await computeStats(admin, profile.id);
    await sendWithKeyboard(chatId, t.streakReply(s.streak, s.weekMin, s.pct), locale);
    return;
  }

  if (cmd === "/sertifikat") {
    const s = await computeStats(admin, profile.id);
    if (s.pct >= 100) {
      await sendWithKeyboard(chatId, t.certReady, locale);
    } else {
      await sendWithKeyboard(chatId, t.certNotYet, locale);
    }
    return;
  }

  if (cmd === "/yordam") {
    if (SUPPORT_HANDLE) {
      await sendMessage(chatId, t.helpReply, {
        inline_keyboard: [[{ text: t.btnHelp, url: `https://t.me/${SUPPORT_HANDLE}` }]],
      });
    } else {
      await sendWithKeyboard(chatId, t.helpReply, locale);
    }
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

  if (cmd === "/sozlamalar" || cmd === "/settings") {
    await renderSettings(admin, chatId, profile.id, locale);
    return;
  }
}

function settingsKeyboard(locale: Locale, prefs: { notifications_enabled: boolean; reminder_time: string; timezone: string }) {
  const t = T[locale];
  const time = (prefs.reminder_time || "20:00:00").slice(0, 5);
  const tz = prefs.timezone || "Asia/Tashkent";
  return {
    inline_keyboard: [
      [{ text: t.settingsBell(prefs.notifications_enabled), callback_data: "settings:toggle_bell" }],
      [{ text: t.settingsTime(time), callback_data: "settings:pick_time" }],
      [{ text: t.settingsTz(tz), callback_data: "settings:pick_tz" }],
      [{ text: t.settingsDisableAll, callback_data: "settings:disable_all" }],
    ],
  };
}

async function renderSettings(admin: any, chatId: number, userId: string, locale: Locale) {
  const { data: prefs } = await admin
    .from("profiles")
    .select("notifications_enabled, reminder_time, timezone")
    .eq("id", userId)
    .maybeSingle();
  const t = T[locale];
  await sendMessage(chatId, t.settingsTitle, settingsKeyboard(locale, prefs || { notifications_enabled: true, reminder_time: "20:00:00", timezone: "Asia/Tashkent" }));
}

async function handleCallback(admin: any, cq: any) {
  const data: string = cq.data || "";
  const tgId = cq.from.id as number;
  const chatId = cq.message?.chat?.id;

  if (data === "ack:not_today") {
    await answerCallback(cq.id, "OK 👍");
    return;
  }

  if (data.startsWith("setlang:") && chatId) {
    const lang = data.split(":")[1] as Locale;
    if (["uz", "ru", "en"].includes(lang)) {
      const profile = await findProfileByTelegramId(admin, tgId);
      if (profile) {
        await admin.from("profiles").update({ preferred_locale: lang }).eq("id", profile.id);
      }
      await answerCallback(cq.id);
      await sendWithKeyboard(chatId, T[lang].langSet, lang);
      return;
    }
  }

  if (data.startsWith("settings:") && chatId) {
    const profile = await findProfileByTelegramId(admin, tgId);
    if (!profile) {
      await answerCallback(cq.id);
      return;
    }
    const locale: Locale = normLocale(profile.preferred_locale);
    const t = T[locale];
    const action = data.slice("settings:".length);

    if (action === "toggle_bell") {
      const { data: cur } = await admin
        .from("profiles")
        .select("notifications_enabled")
        .eq("id", profile.id)
        .maybeSingle();
      const newVal = !(cur?.notifications_enabled ?? true);
      await admin.from("profiles").update({ notifications_enabled: newVal }).eq("id", profile.id);
      await answerCallback(cq.id, newVal ? t.settingsBellOn : t.settingsBellOff);
      await renderSettings(admin, chatId, profile.id, locale);
      return;
    }

    if (action === "disable_all") {
      await admin.from("profiles").update({ notifications_enabled: false }).eq("id", profile.id);
      await answerCallback(cq.id, t.settingsAllOff);
      await renderSettings(admin, chatId, profile.id, locale);
      return;
    }

    if (action === "pick_time") {
      // Render hour picker 00-23 in 4 rows of 6
      const rows: any[][] = [];
      for (let r = 0; r < 4; r++) {
        const row: any[] = [];
        for (let c = 0; c < 6; c++) {
          const hh = (r * 6 + c).toString().padStart(2, "0");
          row.push({ text: `${hh}:00`, callback_data: `settings:set_time:${hh}` });
        }
        rows.push(row);
      }
      rows.push([{ text: t.back, callback_data: "settings:back" }]);
      await answerCallback(cq.id);
      await sendMessage(chatId, t.settingsPickHour, { inline_keyboard: rows });
      return;
    }

    if (action.startsWith("set_time:")) {
      const hh = action.slice("set_time:".length);
      const time = `${hh}:00:00`;
      await admin.from("profiles").update({ reminder_time: time }).eq("id", profile.id);
      await answerCallback(cq.id, t.settingsTimeSet(`${hh}:00`));
      await renderSettings(admin, chatId, profile.id, locale);
      return;
    }

    if (action === "pick_tz") {
      const rows = TIMEZONES.map((tz) => [{ text: tz, callback_data: `settings:set_tz:${tz}` }]);
      rows.push([{ text: t.back, callback_data: "settings:back" }]);
      await answerCallback(cq.id);
      await sendMessage(chatId, t.settingsPickTz, { inline_keyboard: rows });
      return;
    }

    if (action.startsWith("set_tz:")) {
      const tz = action.slice("set_tz:".length);
      await admin.from("profiles").update({ timezone: tz }).eq("id", profile.id);
      await answerCallback(cq.id, t.settingsTzSet(tz));
      await renderSettings(admin, chatId, profile.id, locale);
      return;
    }

    if (action === "back") {
      await answerCallback(cq.id);
      await renderSettings(admin, chatId, profile.id, locale);
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
        } else if (profileForLocale) {
          await sendWithKeyboard(msg.chat.id, T[locale].helpReply, locale);
        } else {
          await sendMessage(msg.chat.id, T[locale].notRegistered);
        }
      } else if (text === "/start") {
        if (profileForLocale) {
          await sendWithKeyboard(msg.chat.id, T[locale].helpReply, locale);
        } else {
          await sendMessage(msg.chat.id, T[locale].notRegistered);
        }
      } else if (text.startsWith("/")) {
        await handleCommand(admin, msg, text.split(/\s+/)[0]);
      } else {
        // Reply-keyboard button text router — match across all locales.
        const mapped = buttonTextToCommand(text);
        if (mapped) {
          await handleCommand(admin, msg, mapped);
        }
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
