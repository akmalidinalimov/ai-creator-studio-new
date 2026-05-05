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

// Default fallbacks if the platform_settings row is missing or a locale field is empty.
const DEFAULT_ENROLL_FORM_URL = "https://forms.gle/o8Dcx1tA8ZBeGk6t9";
const DEFAULT_ENROLL_MESSAGE: Record<Locale, string> = {
  uz: "Sizning ma'lumotingiz platformaga kiritilmagan ko'rinadi. Pastdagi tugmani bosib, ma'lumotingiz qoldiring va sizga 24 soat ichida platformaga dostup beriladi",
  ru: "Похоже, вашей информации нет на платформе. Нажмите кнопку ниже, оставьте свои данные — доступ будет открыт в течение 24 часов",
  en: "Your information doesn't appear to be on the platform. Tap the button below, leave your details, and you'll get access within 24 hours",
};
const DEFAULT_ENROLL_BUTTON: Record<Locale, string> = {
  uz: "📝 Formani to'ldirish",
  ru: "📝 Заполнить форму",
  en: "📝 Fill out the form",
};

async function getEnrollmentSettings(admin: any, locale: Locale): Promise<{ message: string; buttonLabel: string; formUrl: string }> {
  try {
    const { data } = await admin
      .from("platform_settings")
      .select("value")
      .eq("key", "telegram_enrollment")
      .maybeSingle();
    const v = (data?.value || {}) as any;
    const formUrl = (typeof v.form_url === "string" && v.form_url.trim()) || DEFAULT_ENROLL_FORM_URL;
    const message = (v.message?.[locale] && String(v.message[locale]).trim()) || DEFAULT_ENROLL_MESSAGE[locale];
    const buttonLabel = (v.button_label?.[locale] && String(v.button_label[locale]).trim()) || DEFAULT_ENROLL_BUTTON[locale];
    return { message, buttonLabel, formUrl };
  } catch (_e) {
    return {
      message: DEFAULT_ENROLL_MESSAGE[locale],
      buttonLabel: DEFAULT_ENROLL_BUTTON[locale],
      formUrl: DEFAULT_ENROLL_FORM_URL,
    };
  }
}

const T = {
  uz: {
    expired: "Kirish havolasining muddati tugagan. Saytga qaytib qaytadan urinib ko'ring.",
    notRegistered:
      "Sizning Telegram hisobingiz hali ro'yxatdan o'tmagan. Ro'yxatdan o'tish uchun quyidagi formani to'ldiring.",
    fillForm: "📝 Formani to'ldirish",
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
    kbHomework: "📝 Mening vazifalarim",
    kbLang: "🌐 Til",
    kbHelp: "❓ Yordam",
    kbHint: "👇 Quyidagi tugmalardan foydalaning",
    kbStreakOld: "📊 Statistikam",
    kbCertOld: "🎓 Sertifikat",
    statsTitle: "📊 <b>Statistikam</b>",
    statsLessons: (d: number, tot: number) => `📚 Darslar: <b>${d}/${tot}</b> ko'rilgan`,
    statsStreak: (c: number, b: number) => `🔥 Streak: <b>${c} kun</b> (eng yaxshisi: ${b})`,
    statsStreakNone: "🔥 Streak: hali boshlanmadi",
    statsDailyGoal: (d: number, tar: number, ok: boolean) => `🎯 Bugungi maqsad: <b>${d}/${tar}</b>${ok ? " ✅" : ""}`,
    statsHomework: (s: number, tot: number, avg: string) => `📝 Uy vazifalari: <b>${s}/${tot}</b> (o'rtacha ${avg}/10)`,
    statsHomeworkNone: "📝 Uy vazifalari: hali topshirilmadi",
    statsRanking: (r: number, tot: number, sc: number) => `🏆 Reyting: <b>${r}-o'rin</b> / ${tot} talaba (faollik bali ${sc}/100)`,
    statsRankingNone: "🏆 Reyting: hali sanalmadi (faollik kerak — kamida 1 ta dars ko'ring)",
    statsBadges: (e: number, tot: number) => `🏅 Nishonlar: <b>${e}/${tot}</b>`,
    btnSiteOpen: "📖 Saytda batafsil",
    hwTitle: "📝 <b>Mening vazifalarim</b>",
    hwEmpty: "Hozircha vazifalar yo'q.",
    hwStatusNotStarted: "📝 boshlanmadi",
    hwStatusSubmitted: "📤 topshirilgan, baholashni kuting",
    hwStatusScored: (s: number, m: number) => `✅ baholandi: ${s}/${m}`,
    btnHwSite: "📝 Saytda topshirish",
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
    // Admin panel
    adminKbAnalytics: "📊 Analitika",
    adminKbInactive3: "😴 3 kun faolsiz",
    adminKbInactive7: "💤 7 kun faolsiz",
    adminKbNever: "🚫 Hech qachon kirmagan",
    adminKbNew: "🆕 Yangi talabalar",
    adminKbStudentMode: "👤 Talaba rejimi",
    adminAnalyticsTitle: "📊 <b>Platforma analitikasi</b>",
    adminLine: (label: string, val: string | number) => `${label}: <b>${val}</b>`,
    adminTotalStudents: "Jami talabalar",
    adminLoggedOnce: "Kamida bir marta kirgan",
    adminNeverLogged: "Hech qachon kirmagan",
    adminActive7d: "7 kunda faol",
    adminInactive3d: "3+ kun faolsiz",
    adminInactive7d: "7+ kun faolsiz",
    adminNew7d: "Oxirgi 7 kunda qo'shilgan",
    adminCompletions7d: "7 kunda tugatilgan darslar",
    adminCsvCaption: (kind: string, n: number) => `📎 ${kind}: ${n} ta talaba`,
    adminCsvEmpty: (kind: string) => `✅ ${kind}: hech kim yo'q`,
    adminInactive3Title: "3+ kun faolsiz talabalar",
    adminInactive7Title: "7+ kun faolsiz talabalar",
    adminNeverTitle: "Hech qachon kirmagan talabalar",
    adminNewTitle: "Oxirgi 7 kunda qo'shilgan talabalar",
    adminStudentModeOn: "Talaba rejimi yoqildi. Admin paneli uchun /admin yozing.",
    adminBackToAdmin: "Admin paneli",
    // Teacher panel
    tKbStats: "📊 Guruh statistikasi",
    tKbStudents: "👥 Mening talabalarim",
    tKbInactive: "😴 Faolsizlar",
    tKbTop: "🏆 TOP talabalar",
    tKbBroadcast: "📣 Guruhga xabar",
    tKbSettings: "⚙️ Sozlamalar",
    tKbHomework: "📝 Vazifalar",
    tKbGrade: "📝 Baholash",
    tKbGraded: "📑 Baholar",
    tKbHealth: "🩺 Guruh holati",
    tHealthOpenSite: "🌐 Saytda batafsil",
    tHealthEmpty: "Sizga hali guruh biriktirilmagan.",
    tHealthLine: (gn: string, logged: number, active: number, never: number, total: number, pct: number) =>
      `📊 <b>${csvEscapeHtml(gn)}</b>\n✅ Kirgan: <b>${logged}/${active}</b> (${pct}%)\n🚫 Hech qachon kirmagan: <b>${never}</b>\n👥 Faol talabalar: <b>${active}</b>\n📦 Jami (arxiv bilan): <b>${total}</b>`,
    teacherPanel: "👩‍🏫 O'qituvchi paneli",
    teacherNoGroups: "Sizga hali guruh biriktirilmagan. Admin bilan bog'laning.",
    teacherBroadcastPrompt: "Guruhingizga yubormoqchi bo'lgan xabarni yozing (300 belgigacha). Bekor qilish uchun /cancel.",
    teacherBroadcastSent: (n: number) => `✅ ${n} ta talabaga yuborildi.`,
    teacherBroadcastEmpty: "Guruhingizda talaba yo'q.",
    teacherBroadcastTooLong: "Xabar 300 belgidan oshmasligi kerak.",
    teacherBroadcastRate: "Soatiga 1 ta xabar yuborish mumkin. Iltimos keyinroq urinib ko'ring.",
    teacherCancelled: "Bekor qilindi.",
    teacherFromTeacher: (n: string) => `📣 <b>O'qituvchidan xabar — ${n}</b>\n\n`,
    gradePending: "📝 <b>Baholash kutmoqda</b>",
    gradeNoneP: "Hozircha baholash uchun vazifa yo'q.",
    gradeListItem: (i: number, name: string, title: string, when: string) => `${i}. <b>${name}</b>\n   ${title} · ${when}`,
    gradeOpenBtn: "Ochish",
    gradedRecent: "📑 <b>So'nggi baholar</b>",
    gradedNone: "Hali baholangan vazifa yo'q.",
    gradedItem: (i: number, name: string, title: string, sc: number, mx: number) => `${i}. <b>${name}</b> — ${title} · <b>${sc}/${mx}</b>`,
    gradeAskScore: (max: number) => `Baho kiriting (0–${max}):`,
    gradeAskComment: "Izoh yozing (yoki /skip):",
    gradeBadScore: (max: number) => `Bal 0–${max} oralig'ida bo'lishi kerak.`,
    gradeSaved: (sc: number, mx: number) => `✅ Saqlandi: ${sc}/${mx}. Talaba xabardor qilindi.`,
    gradeStudentDM: (title: string, sc: number, mx: number, fb: string) =>
      `🎉 Vazifangiz baholandi!\n\n📝 <b>${title}</b>\nBaho: <b>${sc}/${mx}</b>${fb ? `\nIzoh: ${fb}` : ""}`,
    gradeCancelled: "Bekor qilindi.",
    gradeNotFound: "Vazifa topilmadi.",
    gradePickStudent: "📝 <b>Talabani tanlang:</b>",
    gradeStudentRow: (name: string, n: number) => `${csvEscapeHtml(name)} — ${n === 0 ? "✓ hammasi" : `${n} vazifa baholanmagan`}`,
    gradeStudentBreakdown: (name: string) => `📝 <b>${csvEscapeHtml(name)}</b>`,
    gradeOpenTopicBtn: (n: number) => `📌 Modul ${n} topikga o'tish`,
    gradeBackList: "↩️ Talabalar ro'yxatiga",
    gradeBackHome: "🏠 Bosh menyu",
    gradeNextPage: "⏭ Keyingi 10",
    gradePrevPage: "⏮ Oldingi 10",
    gradeAskScoreInline: (max: number) => `Baho qo'ying (0–${max}):`,
    gradeAskCommentReq: "Izoh yozing (majburiy):",
    gradeAskCommentOpt: "Izoh yozing yoki /skip:",
    gradeNoTopic: "Bu modul uchun topik sozlanmagan.",
    gradeSavedFull: (name: string, mn: number, tn: number, sc: number, mx: number, comment: string, avg: string) =>
      `✅ Saqlandi: <b>${csvEscapeHtml(name)}</b> · M${mn}·V${tn} = <b>${sc}/${mx}</b> (${Math.round((sc / mx) * 100)}%)\nIzoh: "${csvEscapeHtml(comment || "—")}"\nModul o'rtachasi: <b>${avg}/10</b>\nTalaba xabar oladi: ✓`,
    gradedFooterUngraded: (n: number) => `\n\nHali baholanmagan: <b>${n}</b> ta vazifa`,
    studentDmGraded: (mn: number, tn: number, sc: number, mx: number, comment: string, avg: string) =>
      `✅ Sizning vazifangiz baholandi:\n\nModul ${mn} · Vazifa ${tn}: <b>${sc}/${mx}</b> (${Math.round((sc / mx) * 100)}%)\nIzoh: "${csvEscapeHtml(comment || "—")}"\nModul o'rtachasi: <b>${avg}/10</b>`,
    btnSiteDetail: "📖 Saytda batafsil",
    btnTopicGo: (n: number) => `📌 Modul ${n} topikga`,
    hwModuleHeader: (n: number, title: string, taskCount: number) => `📚 <b>Modul ${n} — ${csvEscapeHtml(title)}</b> (${taskCount} ta)`,
    hwTaskScored: (tn: number, sc: number, mx: number, fb: string) => `   ✅ V${tn}: ${sc}/${mx}${fb ? ` — "${csvEscapeHtml(fb).slice(0, 40)}"` : ""}`,
    hwTaskUnscored: (tn: number) => `   ⏳ V${tn}: hali baholanmagan`,
    hwSubmitHint: (mn: number, tn: number) => `   👇 Topshirish uchun pastdagi "📤 Topshirish — M${mn}·V${tn}" tugmasini bosing.`,
    hwModuleAllDone: "   ✅ Bu modul vazifalari topshirilgan.",
    hwTopicMissing: "   ⚠️ Topik sozlanmagan — ustozingizga murojaat qiling.",
    hwSubmitBtn: (mn: number, tn: number) => `📤 Topshirish — M${mn}·V${tn}`,
    hwIntentReady: (mn: number, tn: number) =>
      `📤 <b>Modul ${mn} · Vazifa ${tn}</b>\n\nQuyidagi tugmani bosib topikga o'ting va rasm yoki video yuboring. Bot avtomatik qabul qiladi (10 daqiqa ichida).`,
    hwIntentNoTopic: "Bu modul uchun topik sozlanmagan. Iltimos, ustozingizga murojaat qiling.",
    hwIntentNoGroup: "Sizga guruh biriktirilmagan. Ustozingiz bilan bog'laning.",
    hwIntentBtnGoTopic: "📌 Topikga o'tish",
    hwIntentAlreadyScored: "Bu vazifa allaqachon baholangan ✅",
    hwReceived: (mn: number, tn: number) =>
      `✅ Vazifangiz qabul qilindi · Modul ${mn} · V${tn}\nUstoz baholaganidan keyin natija keladi.`,
    hwTeacherNotify: (name: string, mn: number, tn: number, title: string) =>
      `🆕 <b>Yangi topshiriq</b>\n👤 ${csvEscapeHtml(name)}\n📚 Modul ${mn} · V${tn} — ${csvEscapeHtml(title)}`,
    hwTeacherBtnFile: "📂 Faylni ko'rish",
    hwTeacherBtnGrade: "🎯 Hozir baholash",
  },
  ru: {
    expired: "Срок действия ссылки истёк. Вернитесь на сайт и попробуйте ещё раз.",
    notRegistered:
      "Ваш Telegram аккаунт ещё не зарегистрирован. Заполните форму ниже для регистрации.",
    fillForm: "📝 Заполнить форму",
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
    kbHomework: "📝 Мои задания",
    kbCert: "📋 Модули курса",
    kbLang: "🌐 Язык",
    kbHelp: "❓ Помощь",
    kbHint: "👇 Используйте кнопки ниже",
    kbStreakOld: "📊 Моя статистика",
    kbCertOld: "🎓 Сертификат",
    statsTitle: "📊 <b>Моя статистика</b>",
    statsLessons: (d: number, tot: number) => `📚 Уроки: <b>${d}/${tot}</b> просмотрено`,
    statsStreak: (c: number, b: number) => `🔥 Стрик: <b>${c} дн.</b> (рекорд: ${b})`,
    statsStreakNone: "🔥 Стрик: ещё не начат",
    statsDailyGoal: (d: number, tar: number, ok: boolean) => `🎯 Цель на сегодня: <b>${d}/${tar}</b>${ok ? " ✅" : ""}`,
    statsHomework: (s: number, tot: number, avg: string) => `📝 Домашка: <b>${s}/${tot}</b> (средняя ${avg}/10)`,
    statsHomeworkNone: "📝 Домашка: ещё не сдавали",
    statsRanking: (r: number, tot: number, sc: number) => `🏆 Рейтинг: <b>${r} место</b> / ${tot} студентов (балл активности ${sc}/100)`,
    statsRankingNone: "🏆 Рейтинг: пока не учтён (нужна активность — посмотрите хотя бы 1 урок)",
    statsBadges: (e: number, tot: number) => `🏅 Значки: <b>${e}/${tot}</b>`,
    btnSiteOpen: "📖 Подробнее на сайте",
    hwTitle: "📝 <b>Мои задания</b>",
    hwEmpty: "Пока заданий нет.",
    hwStatusNotStarted: "📝 не начато",
    hwStatusSubmitted: "📤 сдано, ждёт оценки",
    hwStatusScored: (s: number, m: number) => `✅ оценено: ${s}/${m}`,
    btnHwSite: "📝 Сдать на сайте",
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
    adminKbAnalytics: "📊 Аналитика",
    adminKbInactive3: "😴 Неактивны 3 дн",
    adminKbInactive7: "💤 Неактивны 7 дн",
    adminKbNever: "🚫 Ни разу не входили",
    adminKbNew: "🆕 Новые студенты",
    adminKbStudentMode: "👤 Режим студента",
    adminAnalyticsTitle: "📊 <b>Аналитика платформы</b>",
    adminLine: (label: string, val: string | number) => `${label}: <b>${val}</b>`,
    adminTotalStudents: "Всего студентов",
    adminLoggedOnce: "Входили хотя бы раз",
    adminNeverLogged: "Ни разу не входили",
    adminActive7d: "Активны за 7 дн",
    adminInactive3d: "Неактивны 3+ дн",
    adminInactive7d: "Неактивны 7+ дн",
    adminNew7d: "Новых за 7 дн",
    adminCompletions7d: "Уроков завершено за 7 дн",
    adminCsvCaption: (kind: string, n: number) => `📎 ${kind}: ${n} студентов`,
    adminCsvEmpty: (kind: string) => `✅ ${kind}: никого нет`,
    adminInactive3Title: "Неактивны 3+ дней",
    adminInactive7Title: "Неактивны 7+ дней",
    adminNeverTitle: "Ни разу не входили",
    adminNewTitle: "Добавлены за последние 7 дн",
    adminStudentModeOn: "Режим студента включён. Для админ-панели — /admin.",
    adminBackToAdmin: "Админ-панель",
    tKbStats: "📊 Статистика группы",
    tKbStudents: "👥 Мои студенты",
    tKbInactive: "😴 Неактивные",
    tKbTop: "🏆 ТОП студенты",
    tKbBroadcast: "📣 Сообщение группе",
    tKbSettings: "⚙️ Настройки",
    tKbHomework: "📝 Задания",
    tKbGrade: "📝 Оценить",
    tKbGraded: "📑 Оценки",
    tKbHealth: "🩺 Состояние группы",
    tHealthOpenSite: "🌐 Подробнее на сайте",
    tHealthEmpty: "К вам пока не прикреплена группа.",
    tHealthLine: (gn: string, logged: number, active: number, never: number, total: number, pct: number) =>
      `📊 <b>${csvEscapeHtml(gn)}</b>\n✅ Вошли: <b>${logged}/${active}</b> (${pct}%)\n🚫 Ни разу не входили: <b>${never}</b>\n👥 Активных: <b>${active}</b>\n📦 Всего (с архивом): <b>${total}</b>`,
    teacherPanel: "👩‍🏫 Панель преподавателя",
    teacherNoGroups: "К вам пока не прикреплена группа. Свяжитесь с админом.",
    teacherBroadcastPrompt: "Напишите сообщение для вашей группы (до 300 символов). /cancel — отменить.",
    teacherBroadcastSent: (n: number) => `✅ Отправлено ${n} студентам.`,
    teacherBroadcastEmpty: "В вашей группе нет студентов.",
    teacherBroadcastTooLong: "Сообщение не должно превышать 300 символов.",
    teacherBroadcastRate: "Можно отправлять 1 сообщение в час. Попробуйте позже.",
    teacherCancelled: "Отменено.",
    teacherFromTeacher: (n: string) => `📣 <b>Сообщение от преподавателя — ${n}</b>\n\n`,
    gradePending: "📝 <b>Ждут оценки</b>",
    gradeNoneP: "Сейчас нечего оценивать.",
    gradeListItem: (i: number, name: string, title: string, when: string) => `${i}. <b>${name}</b>\n   ${title} · ${when}`,
    gradeOpenBtn: "Открыть",
    gradedRecent: "📑 <b>Последние оценки</b>",
    gradedNone: "Пока нет оценённых работ.",
    gradedItem: (i: number, name: string, title: string, sc: number, mx: number) => `${i}. <b>${name}</b> — ${title} · <b>${sc}/${mx}</b>`,
    gradeAskScore: (max: number) => `Введите балл (0–${max}):`,
    gradeAskComment: "Напишите комментарий (или /skip):",
    gradeBadScore: (max: number) => `Балл должен быть от 0 до ${max}.`,
    gradeSaved: (sc: number, mx: number) => `✅ Сохранено: ${sc}/${mx}. Студенту отправлено уведомление.`,
    gradeStudentDM: (title: string, sc: number, mx: number, fb: string) =>
      `🎉 Ваша работа оценена!\n\n📝 <b>${title}</b>\nОценка: <b>${sc}/${mx}</b>${fb ? `\nКомментарий: ${fb}` : ""}`,
    gradeCancelled: "Отменено.",
    gradeNotFound: "Работа не найдена.",
    gradePickStudent: "📝 <b>Выберите студента:</b>",
    gradeStudentRow: (name: string, n: number) => `${csvEscapeHtml(name)} — ${n === 0 ? "✓ всё" : `${n} не оценено`}`,
    gradeStudentBreakdown: (name: string) => `📝 <b>${csvEscapeHtml(name)}</b>`,
    gradeOpenTopicBtn: (n: number) => `📌 Перейти в топик модуля ${n}`,
    gradeBackList: "↩️ К списку студентов",
    gradeBackHome: "🏠 Главное меню",
    gradeNextPage: "⏭ Следующие 10",
    gradePrevPage: "⏮ Предыдущие 10",
    gradeNoTopic: "Топик для этого модуля не настроен.",
    btnSiteDetail: "📖 Подробнее на сайте",
    btnTopicGo: (n: number) => `📌 Топик модуля ${n}`,
    hwModuleHeader: (n: number, title: string, taskCount: number) => `📚 <b>Модуль ${n} — ${csvEscapeHtml(title)}</b> (${taskCount})`,
    hwTaskScored: (tn: number, sc: number, mx: number, fb: string) => `   ✅ З${tn}: ${sc}/${mx}${fb ? ` — "${csvEscapeHtml(fb).slice(0, 40)}"` : ""}`,
    hwTaskUnscored: (tn: number) => `   ⏳ З${tn}: ещё не оценено`,
    hwSubmitHint: (mn: number, tn: number) => `   👇 Нажмите кнопку ниже "📤 Сдать — М${mn}·З${tn}".`,
    hwModuleAllDone: "   ✅ Задания этого модуля сданы.",
    hwTopicMissing: "   ⚠️ Топик не настроен — обратитесь к преподавателю.",
    hwSubmitBtn: (mn: number, tn: number) => `📤 Сдать — М${mn}·З${tn}`,
    hwIntentReady: (mn: number, tn: number) =>
      `📤 <b>Модуль ${mn} · Задание ${tn}</b>\n\nНажмите кнопку ниже, перейдите в топик и отправьте фото или видео. Бот примет автоматически (в течение 10 минут).`,
    hwIntentNoTopic: "Топик для этого модуля не настроен. Свяжитесь с преподавателем.",
    hwIntentNoGroup: "Вам не назначена группа. Свяжитесь с преподавателем.",
    hwIntentBtnGoTopic: "📌 Перейти в топик",
    hwIntentAlreadyScored: "Это задание уже оценено ✅",
    hwReceived: (mn: number, tn: number) =>
      `✅ Задание принято · Модуль ${mn} · З${tn}\nКак только преподаватель оценит — пришлю результат.`,
    hwTeacherNotify: (name: string, mn: number, tn: number, title: string) =>
      `🆕 <b>Новая сдача</b>\n👤 ${csvEscapeHtml(name)}\n📚 Модуль ${mn} · З${tn} — ${csvEscapeHtml(title)}`,
    hwTeacherBtnFile: "📂 Открыть файл",
    hwTeacherBtnGrade: "🎯 Оценить сейчас",
  },
  en: {
    expired: "Login link expired. Return to the site and try again.",
    notRegistered:
      "Your Telegram account isn't registered yet. Fill out the form below to register.",
    fillForm: "📝 Fill out the form",
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
    kbHomework: "📝 My homework",
    kbCert: "📋 Course modules",
    kbLang: "🌐 Language",
    kbHelp: "❓ Help",
    kbHint: "👇 Use the buttons below",
    kbStreakOld: "📊 My stats",
    kbCertOld: "🎓 Certificate",
    statsTitle: "📊 <b>My stats</b>",
    statsLessons: (d: number, tot: number) => `📚 Lessons: <b>${d}/${tot}</b> watched`,
    statsStreak: (c: number, b: number) => `🔥 Streak: <b>${c} days</b> (best: ${b})`,
    statsStreakNone: "🔥 Streak: not started yet",
    statsDailyGoal: (d: number, tar: number, ok: boolean) => `🎯 Today's goal: <b>${d}/${tar}</b>${ok ? " ✅" : ""}`,
    statsHomework: (s: number, tot: number, avg: string) => `📝 Homework: <b>${s}/${tot}</b> (avg ${avg}/10)`,
    statsHomeworkNone: "📝 Homework: nothing submitted yet",
    statsRanking: (r: number, tot: number, sc: number) => `🏆 Ranking: <b>#${r}</b> of ${tot} students (activity score ${sc}/100)`,
    statsRankingNone: "🏆 Ranking: not ranked yet (need activity — watch at least 1 lesson)",
    statsBadges: (e: number, tot: number) => `🏅 Badges: <b>${e}/${tot}</b>`,
    btnSiteOpen: "📖 More on site",
    hwTitle: "📝 <b>My homework</b>",
    hwEmpty: "No homework yet.",
    hwStatusNotStarted: "📝 not started",
    hwStatusSubmitted: "📤 submitted, awaiting score",
    hwStatusScored: (s: number, m: number) => `✅ scored: ${s}/${m}`,
    btnHwSite: "📝 Submit on site",
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
    adminKbAnalytics: "📊 Analytics",
    adminKbInactive3: "😴 Inactive 3d",
    adminKbInactive7: "💤 Inactive 7d",
    adminKbNever: "🚫 Never logged in",
    adminKbNew: "🆕 New students",
    adminKbStudentMode: "👤 Student mode",
    adminAnalyticsTitle: "📊 <b>Platform analytics</b>",
    adminLine: (label: string, val: string | number) => `${label}: <b>${val}</b>`,
    adminTotalStudents: "Total students",
    adminLoggedOnce: "Logged in at least once",
    adminNeverLogged: "Never logged in",
    adminActive7d: "Active in 7d",
    adminInactive3d: "Inactive 3+ days",
    adminInactive7d: "Inactive 7+ days",
    adminNew7d: "Joined in last 7d",
    adminCompletions7d: "Lessons completed (7d)",
    adminCsvCaption: (kind: string, n: number) => `📎 ${kind}: ${n} students`,
    adminCsvEmpty: (kind: string) => `✅ ${kind}: no one`,
    adminInactive3Title: "Inactive 3+ days",
    adminInactive7Title: "Inactive 7+ days",
    adminNeverTitle: "Never logged in",
    adminNewTitle: "Joined in last 7 days",
    adminStudentModeOn: "Student mode on. Type /admin for admin panel.",
    adminBackToAdmin: "Admin panel",
    tKbStats: "📊 Group stats",
    tKbStudents: "👥 My students",
    tKbInactive: "😴 Inactive",
    tKbTop: "🏆 Top students",
    tKbBroadcast: "📣 Broadcast",
    tKbSettings: "⚙️ Settings",
    tKbHomework: "📝 Homework",
    tKbGrade: "📝 Grade",
    tKbGraded: "📑 Grades",
    tKbHealth: "🩺 Group health",
    tHealthOpenSite: "🌐 Open dashboard",
    tHealthEmpty: "No group is assigned to you yet.",
    tHealthLine: (gn: string, logged: number, active: number, never: number, total: number, pct: number) =>
      `📊 <b>${csvEscapeHtml(gn)}</b>\n✅ Logged in: <b>${logged}/${active}</b> (${pct}%)\n🚫 Never logged in: <b>${never}</b>\n👥 Active: <b>${active}</b>\n📦 Total (incl. archived): <b>${total}</b>`,
    teacherPanel: "👩‍🏫 Teacher panel",
    teacherNoGroups: "No group assigned to you yet. Please contact the admin.",
    teacherBroadcastPrompt: "Type the message to send to your group (up to 300 chars). /cancel to abort.",
    teacherBroadcastSent: (n: number) => `✅ Sent to ${n} students.`,
    teacherBroadcastEmpty: "Your group has no students.",
    teacherBroadcastTooLong: "Message must be 300 chars or less.",
    teacherBroadcastRate: "Only 1 broadcast per hour allowed. Try again later.",
    teacherCancelled: "Cancelled.",
    teacherFromTeacher: (n: string) => `📣 <b>Message from teacher — ${n}</b>\n\n`,
    gradePending: "📝 <b>Awaiting grading</b>",
    gradeNoneP: "Nothing to grade right now.",
    gradeListItem: (i: number, name: string, title: string, when: string) => `${i}. <b>${name}</b>\n   ${title} · ${when}`,
    gradeOpenBtn: "Open",
    gradedRecent: "📑 <b>Recent grades</b>",
    gradedNone: "No graded work yet.",
    gradedItem: (i: number, name: string, title: string, sc: number, mx: number) => `${i}. <b>${name}</b> — ${title} · <b>${sc}/${mx}</b>`,
    gradeAskScore: (max: number) => `Enter score (0–${max}):`,
    gradeAskComment: "Write a comment (or /skip):",
    gradeBadScore: (max: number) => `Score must be between 0 and ${max}.`,
    gradeSaved: (sc: number, mx: number) => `✅ Saved: ${sc}/${mx}. Student notified.`,
    gradeStudentDM: (title: string, sc: number, mx: number, fb: string) =>
      `🎉 Your homework was graded!\n\n📝 <b>${title}</b>\nScore: <b>${sc}/${mx}</b>${fb ? `\nFeedback: ${fb}` : ""}`,
    gradeCancelled: "Cancelled.",
    gradeNotFound: "Submission not found.",
    gradePickStudent: "📝 <b>Pick a student:</b>",
    gradeStudentRow: (name: string, n: number) => `${csvEscapeHtml(name)} — ${n === 0 ? "✓ all done" : `${n} ungraded`}`,
    gradeStudentBreakdown: (name: string) => `📝 <b>${csvEscapeHtml(name)}</b>`,
    gradeOpenTopicBtn: (n: number) => `📌 Open module ${n} topic`,
    gradeBackList: "↩️ Back to students",
    gradeBackHome: "🏠 Main menu",
    gradeNextPage: "⏭ Next 10",
    gradePrevPage: "⏮ Previous 10",
    gradeNoTopic: "Topic not configured for this module.",
    btnSiteDetail: "📖 Open on site",
    btnTopicGo: (n: number) => `📌 Module ${n} topic`,
    hwModuleHeader: (n: number, title: string, taskCount: number) => `📚 <b>Module ${n} — ${csvEscapeHtml(title)}</b> (${taskCount})`,
    hwTaskScored: (tn: number, sc: number, mx: number, fb: string) => `   ✅ T${tn}: ${sc}/${mx}${fb ? ` — "${csvEscapeHtml(fb).slice(0, 40)}"` : ""}`,
    hwTaskUnscored: (tn: number) => `   ⏳ T${tn}: not graded yet`,
    hwSubmitHint: (mn: number, tn: number) => `   👇 Tap "📤 Submit — M${mn}·T${tn}" below.`,
    hwModuleAllDone: "   ✅ All tasks for this module submitted.",
    hwTopicMissing: "   ⚠️ Topic not configured — contact your teacher.",
    hwSubmitBtn: (mn: number, tn: number) => `📤 Submit — M${mn}·T${tn}`,
    hwIntentReady: (mn: number, tn: number) =>
      `📤 <b>Module ${mn} · Task ${tn}</b>\n\nTap the button below to open the topic and post your photo or video. The bot will accept it automatically (within 10 minutes).`,
    hwIntentNoTopic: "Topic not configured for this module. Please contact your teacher.",
    hwIntentNoGroup: "You are not assigned to a group. Please contact your teacher.",
    hwIntentBtnGoTopic: "📌 Open topic",
    hwIntentAlreadyScored: "This task has already been graded ✅",
    hwReceived: (mn: number, tn: number) =>
      `✅ Submission received · Module ${mn} · T${tn}\nYou'll get the result once your teacher grades it.`,
    hwTeacherNotify: (name: string, mn: number, tn: number, title: string) =>
      `🆕 <b>New submission</b>\n👤 ${csvEscapeHtml(name)}\n📚 Module ${mn} · T${tn} — ${csvEscapeHtml(title)}`,
    hwTeacherBtnFile: "📂 Open file",
    hwTeacherBtnGrade: "🎯 Grade now",
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
      [{ text: t.kbStreak }, { text: t.kbHomework }],
      [{ text: t.kbCert }, { text: t.kbLang }],
      [{ text: t.kbHelp }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function getAdminKeyboard(locale: Locale) {
  const t = T[locale] as any;
  return {
    keyboard: [
      [{ text: t.adminKbAnalytics }],
      [{ text: t.tKbGrade }, { text: t.tKbGraded }],
      [{ text: t.adminKbInactive3 }, { text: t.adminKbInactive7 }],
      [{ text: t.adminKbNever }, { text: t.adminKbNew }],
      [{ text: t.adminKbStudentMode }, { text: t.kbLang }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function getTeacherKeyboard(locale: Locale) {
  const t = T[locale] as any;
  return {
    keyboard: [
      [{ text: t.tKbGrade }, { text: t.tKbGraded }],
      [{ text: t.tKbStats }, { text: t.tKbHealth }],
      [{ text: t.tKbStudents }, { text: t.tKbInactive }],
      [{ text: t.tKbTop }, { text: t.tKbBroadcast }],
      [{ text: t.tKbSettings }, { text: t.kbLang }],
      [{ text: t.kbLang }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

type Persona = "student" | "admin" | "teacher";

function keyboardFor(locale: Locale, persona: Persona) {
  if (persona === "admin") return getAdminKeyboard(locale);
  if (persona === "teacher") return getTeacherKeyboard(locale);
  return getMainKeyboard(locale);
}

// Send a message that always carries the persistent reply keyboard.
async function sendWithKeyboard(chatId: number, text: string, locale: Locale, isAdmin = false, persona?: Persona) {
  const p: Persona = persona || (isAdmin ? "admin" : "student");
  return sendMessage(chatId, text, keyboardFor(locale, p));
}

// Send a Telegram document (e.g., CSV) via multipart upload.
async function sendDocument(chatId: number, filename: string, content: string, caption?: string) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) {
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
  }
  form.append("document", new Blob([content], { type: "text/csv;charset=utf-8" }), filename);
  return fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: form,
  });
}

async function isAdminUser(admin: any, userId: string): Promise<boolean> {
  const { data } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  return !!data;
}

async function isTeacherUser(admin: any, userId: string): Promise<boolean> {
  const { data } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "teacher")
    .maybeSingle();
  return !!data;
}

async function getPersona(admin: any, userId: string): Promise<Persona> {
  if (await isAdminUser(admin, userId)) return "admin";
  if (await isTeacherUser(admin, userId)) return "teacher";
  return "student";
}

// After sending an inline-keyboard message, follow up with a tiny hint that
// re-applies the persistent reply keyboard (since you can't combine both).
async function sendKeyboardHint(_chatId: number, _locale: Locale, _isAdmin = false, _persona?: Persona) {
  // No-op: the persistent reply keyboard stays visible from prior sends,
  // so we don't need to send a redundant "use the buttons below" hint.
  return null;
}

// Map ANY localized keyboard label to a canonical command, regardless of user's
// current locale (a student might tap a button rendered in their old locale).
function buttonTextToCommand(text: string): string | null {
  const trimmed = text.trim();
  for (const loc of ["uz", "ru", "en"] as Locale[]) {
    const t = T[loc] as any;
    if (trimmed === t.kbDavom) return "/davom";
    if (trimmed === t.kbStreak) return "/galaba";
    if (t.kbStreakOld && trimmed === t.kbStreakOld) return "/galaba";
    if (t.kbHomework && trimmed === t.kbHomework) return "/vazifalar";
    if (trimmed === t.kbCert) return "/dars";
    if (t.kbCertOld && trimmed === t.kbCertOld) return "/sertifikat";
    if (trimmed === t.kbLang) return "/til";
    if (trimmed === t.kbHelp) return "/yordam";
    // Admin keyboard buttons
    if (trimmed === t.adminKbAnalytics) return "/analitika";
    if (trimmed === t.adminKbInactive3) return "/inactive3";
    if (trimmed === t.adminKbInactive7) return "/inactive7";
    if (trimmed === t.adminKbNever) return "/nevr";
    if (trimmed === t.adminKbNew) return "/yangilar";
    if (trimmed === t.adminKbStudentMode) return "/talaba";
    // Teacher keyboard buttons
    if (t.tKbStats && trimmed === t.tKbStats) return "/tstats";
    if (t.tKbStudents && trimmed === t.tKbStudents) return "/tstudents";
    if (t.tKbInactive && trimmed === t.tKbInactive) return "/tinactive";
    if (t.tKbTop && trimmed === t.tKbTop) return "/ttop";
    if (t.tKbBroadcast && trimmed === t.tKbBroadcast) return "/tbroadcast";
    if (t.tKbSettings && trimmed === t.tKbSettings) return "/sozlamalar";
    if (t.tKbGrade && trimmed === t.tKbGrade) return "/baholash";
    if (t.tKbGraded && trimmed === t.tKbGraded) return "/baholar";
    if (t.tKbHealth && trimmed === t.tKbHealth) return "/thealth";
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
  // Reuse non-expired link created within last 5 minutes for same (user, purpose, target_path)
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    let q = admin.from("telegram_magic_links")
      .select("token, expires_at, target_path")
      .eq("user_id", user_id).eq("purpose", purpose)
      .gte("created_at", fiveMinAgo).is("used_at", null)
      .order("created_at", { ascending: false }).limit(1);
    const { data: existing } = await q;
    const row = existing?.[0];
    if (row && new Date(row.expires_at).getTime() > Date.now() + 60_000 && (row.target_path || null) === (target_path || null)) {
      return `${SITE_URL}/auth/magic?t=${row.token}`;
    }
  } catch (_e) { /* fall through to insert */ }
  const token = randomToken(32);
  const { error } = await admin
    .from("telegram_magic_links")
    .insert({ token, user_id, purpose, target_path });
  if (error) throw error;
  return `${SITE_URL}/auth/magic?t=${token}`;
}

// ===== In-memory response cache for hot bot replies (per Edge Function instance) =====
type CacheEntry = { text: string; expiresAt: number };
const REPLY_CACHE = new Map<string, CacheEntry>();
const REPLY_CACHE_TTL_MS = 30_000;
function cacheGet(key: string): string | null {
  const e = REPLY_CACHE.get(key);
  if (!e) return null;
  if (e.expiresAt < Date.now()) { REPLY_CACHE.delete(key); return null; }
  return e.text;
}
function cacheSet(key: string, text: string) {
  REPLY_CACHE.set(key, { text, expiresAt: Date.now() + REPLY_CACHE_TTL_MS });
}
function cacheInvalidateUser(userId: string) {
  for (const k of REPLY_CACHE.keys()) if (k.includes(`:${userId}:`)) REPLY_CACHE.delete(k);
}

async function findProfileByTelegramId(admin: any, tgId: number) {
  const { data } = await admin
    .from("profiles")
    .select("id, name, last_name, telegram_username, telegram_id, telegram_onboarded_at, preferred_locale, group_id")
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

async function buildStatsMessage(admin: any, userId: string, locale: Locale): Promise<string> {
  const t = T[locale] as any;
  const lines: string[] = [t.statsTitle, ""];
  try {
    const courseId = await getDefaultCourseId(admin);

    // Lessons total + completed
    let lessonIds: string[] = [];
    if (courseId) {
      const { data: ms } = await admin.from("modules").select("id").eq("course_id", courseId);
      const mids = (ms || []).map((m: any) => m.id);
      if (mids.length) {
        const { data: ls } = await admin
          .from("lessons").select("id").in("module_id", mids).eq("published", true);
        lessonIds = (ls || []).map((l: any) => l.id);
      }
    }
    const totalLessons = lessonIds.length;

    const [
      progressRes, streakRes, todayRes, hwSubRes, hwTotalRes,
      lbRes, totalStudentsRes, badgesEarnedRes, badgesTotalRes, prefRes,
    ] = await Promise.all([
      lessonIds.length
        ? admin.from("lesson_progress").select("lesson_id, completed_at").eq("user_id", userId).in("lesson_id", lessonIds).not("completed_at", "is", null)
        : Promise.resolve({ data: [] as any[] }),
      admin.from("streaks").select("current_streak, longest_streak").eq("user_id", userId).maybeSingle(),
      admin.from("lesson_progress").select("completed_at").eq("user_id", userId).gte("completed_at", new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").toISOString()).not("completed_at", "is", null),
      admin.from("homework_submissions").select("score").eq("user_id", userId),
      admin.from("homework_assignments").select("id", { count: "exact", head: true }),
      admin.from("leaderboard_cache").select("rank, score").eq("user_id", userId).maybeSingle(),
      admin.from("leaderboard_cache").select("user_id", { count: "exact", head: true }),
      admin.from("user_badges").select("badge_id", { count: "exact", head: true }).eq("user_id", userId),
      admin.from("badges").select("id", { count: "exact", head: true }),
      admin.from("profiles").select("weekly_goal_lessons").eq("id", userId).maybeSingle(),
    ]);

    const completedLessons = (progressRes.data || []).length;
    lines.push(t.statsLessons(completedLessons, totalLessons));

    const sk = streakRes.data;
    if (sk && (sk.current_streak || sk.longest_streak)) {
      lines.push(t.statsStreak(sk.current_streak || 0, sk.longest_streak || 0));
    } else {
      lines.push(t.statsStreakNone);
    }

    const todayDone = (todayRes.data || []).length;
    const weeklyGoal = prefRes.data?.weekly_goal_lessons || 5;
    const dailyTarget = Math.max(1, Math.round(weeklyGoal / 7));
    lines.push(t.statsDailyGoal(todayDone, dailyTarget, todayDone >= dailyTarget));

    const subs = hwSubRes.data || [];
    const hwTotal = hwTotalRes.count || 0;
    if (subs.length === 0) {
      lines.push(t.statsHomeworkNone);
    } else {
      // Use normalized per-module average (0–10) from vw_module_homework_score
      const { data: vw } = await admin
        .from("vw_module_homework_score" as any)
        .select("avg_score_normalized")
        .eq("profile_id", userId);
      const vals = (vw || []).map((r: any) => Number(r.avg_score_normalized)).filter((n: number) => Number.isFinite(n));
      const avg = vals.length ? (vals.reduce((a: number, b: number) => a + b, 0) / vals.length).toFixed(1) : "—";
      lines.push(t.statsHomework(subs.length, hwTotal, avg));
    }

    const lb = lbRes.data;
    if (lb && lb.rank) {
      lines.push(t.statsRanking(lb.rank, totalStudentsRes.count || 0, lb.score || 0));
    } else {
      lines.push(t.statsRankingNone);
    }

    lines.push(t.statsBadges(badgesEarnedRes.count || 0, badgesTotalRes.count || 0));
  } catch (e) {
    console.error("buildStatsMessage error", e);
  }
  return lines.join("\n");
}

async function buildHomeworkMessage(
  admin: any,
  userId: string,
  locale: Locale,
): Promise<{ text: string; keyboard: { inline_keyboard: any[][] } | null }> {
  const t = T[locale] as any;
  const lines: string[] = [t.hwTitle, ""];
  const buttons: any[][] = [];
  try {
    // Parallel: profile (group_id) + active assignments
    const [profRes, assignsRes] = await Promise.all([
      admin.from("profiles").select("group_id").eq("id", userId).maybeSingle(),
      admin.from("homework_assignments")
        .select("id, title, max_score, task_number, module_id, is_active, modules(id, title, position, course_id)")
        .eq("is_active", true).order("task_number", { ascending: true }),
    ]);
    const groupId = (profRes as any).data?.group_id || null;
    const list = ((assignsRes as any).data || []) as any[];
    if (!list.length) { lines.push(t.hwEmpty); return { text: lines.join("\n"), keyboard: null }; }
    list.sort((a, b) => (a.modules?.position ?? 0) - (b.modules?.position ?? 0) || (a.task_number ?? 1) - (b.task_number ?? 1));

    const aIds = list.map((a) => a.id);
    const moduleIds = Array.from(new Set(list.map((a) => a.module_id)));
    const [{ data: subs }, { data: topics }] = await Promise.all([
      admin.from("homework_submissions").select("assignment_id, score, score_feedback").eq("user_id", userId).in("assignment_id", aIds),
      groupId
        ? admin.from("group_module_topics").select("module_id, telegram_topic_url").eq("group_id", groupId).in("module_id", moduleIds)
        : Promise.resolve({ data: [] }),
    ]);
    const subMap = new Map((subs || []).map((s: any) => [s.assignment_id, s]));
    const topicMap = new Map((topics || []).map((tp: any) => [tp.module_id, tp.telegram_topic_url]));

    // Group by module
    const byModule = new Map<string, any[]>();
    for (const a of list) {
      const arr = byModule.get(a.module_id) || [];
      arr.push(a);
      byModule.set(a.module_id, arr);
    }

    const modulesOrdered = Array.from(byModule.entries())
      .map(([mid, arr]) => ({ mid, arr, position: arr[0]?.modules?.position ?? 0, title: arr[0]?.modules?.title || "—" }))
      .sort((a, b) => a.position - b.position);

    for (const m of modulesOrdered) {
      lines.push(t.hwModuleHeader(m.position + 1, m.title, m.arr.length));
      for (const a of m.arr) {
        const s: any = subMap.get(a.id);
        const tn = a.task_number || 1;
        if (s && s.score != null) {
          lines.push(t.hwTaskScored(tn, s.score, a.max_score || 10, s.score_feedback || ""));
        } else {
          lines.push(t.hwTaskUnscored(tn));
          // Add a submit button for unscored assignments (only if topic + group exist)
          if (groupId && topicMap.get(m.mid)) {
            buttons.push([{ text: t.hwSubmitBtn(m.position + 1, tn), callback_data: `hw:start:${a.id}` }]);
          }
        }
      }
      const topic = topicMap.get(m.mid);
      const ungraded = m.arr.filter((a: any) => !(subMap.get(a.id) && (subMap.get(a.id) as any).score != null));
      if (groupId && !topic) {
        lines.push(t.hwTopicMissing);
      } else if (ungraded.length === 0) {
        lines.push(t.hwModuleAllDone);
      } else if (topic) {
        lines.push(t.hwSubmitHint(m.position + 1, ungraded[0].task_number || 1));
      }
      lines.push("");
    }
  } catch (e) {
    console.error("buildHomeworkMessage error", e);
    lines.push(t.hwEmpty);
  }
  return { text: lines.join("\n"), keyboard: buttons.length ? { inline_keyboard: buttons } : null };
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

  // v2.1.1: hybrid match — by Telegram numeric user_id OR by @username (case-insensitive).
  // After first match by username, we permanently bind telegram_id so future logins are id-matched.
  let profile = await findProfileByTelegramId(admin, tgId);
  if (!profile && tgUsername) {
    profile = await findProfileByUsername(admin, tgUsername);
  }

  if (!profile) {
    const enroll = await getEnrollmentSettings(admin, locale);
    await sendMessage(chatId, enroll.message, {
      inline_keyboard: [[{ text: enroll.buttonLabel, url: enroll.formUrl }]],
    });
    return;
  }

  // Permanently bind telegram_id on first successful match (was NULL before).
  if (!profile.telegram_id) {
    await admin.from("profiles").update({ telegram_id: tgId }).eq("id", profile.id);
    profile.telegram_id = tgId;
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
  const personaAfterLogin = await getPersona(admin, profile.id);
  await sendKeyboardHint(chatId, locale, personaAfterLogin === "admin", personaAfterLogin);
}

// =================== ADMIN ANALYTICS HELPERS ===================

type StudentRow = {
  id: string;
  name: string | null;
  last_name: string | null;
  email: string | null;
  telegram_username: string | null;
  telegram_id: number | null;
  created_at: string;
  last_sign_in_at: string | null;
  last_lesson_at: string | null;
  last_auth_event_at: string | null;
};

// Build the master list of students with their latest activity timestamps.
// "activity" = auth_events.created_at OR lesson_progress.updated_at (per spec).
async function loadStudentActivity(admin: any): Promise<StudentRow[]> {
  // 1) All students via admin_list_users RPC (gives last_sign_in_at + is_admin)
  const { data: users, error: usersErr } = await admin.rpc("admin_list_users_internal");
  if (usersErr) {
    console.error("admin_list_users_internal failed", usersErr);
    return [];
  }
  const students = (users || []).filter((u: any) => !u.is_admin);
  if (!students.length) return [];

  const ids = students.map((u: any) => u.id);

  // 2) Batched: fetch per-user max(updated_at) from lesson_progress.
  const lessonMap = new Map<string, string>();
  // Chunk to avoid URL/IN limits
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data: lp } = await admin
      .from("lesson_progress")
      .select("user_id, updated_at")
      .in("user_id", chunk)
      .order("updated_at", { ascending: false });
    for (const r of lp || []) {
      if (!lessonMap.has(r.user_id)) lessonMap.set(r.user_id, r.updated_at);
    }
  }

  // 3) Batched: fetch per-user max(created_at) from auth_events.
  const authMap = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data: ae } = await admin
      .from("auth_events")
      .select("user_id, created_at")
      .in("user_id", chunk)
      .order("created_at", { ascending: false });
    for (const r of ae || []) {
      if (!authMap.has(r.user_id)) authMap.set(r.user_id, r.created_at);
    }
  }

  // 4) Need full names — admin_list_users only returns single 'name' field.
  // Pull last_name from profiles in the same chunked manner.
  const lastNameMap = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data: profs } = await admin
      .from("profiles")
      .select("id, last_name")
      .in("id", chunk);
    for (const r of profs || []) {
      lastNameMap.set(r.id, r.last_name ?? null);
    }
  }

  return students.map((u: any) => ({
    id: u.id,
    name: u.name ?? null,
    last_name: lastNameMap.get(u.id) ?? null,
    email: u.email ?? null,
    telegram_username: u.telegram_username ?? null,
    telegram_id: u.telegram_id ?? null,
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at ?? null,
    last_lesson_at: lessonMap.get(u.id) ?? null,
    last_auth_event_at: authMap.get(u.id) ?? null,
  }));
}

// Last activity = max(last_auth_event_at, last_lesson_at).
function lastActivityOf(s: StudentRow): Date | null {
  const candidates = [s.last_auth_event_at, s.last_lesson_at]
    .filter(Boolean)
    .map((d) => new Date(d as string).getTime());
  if (!candidates.length) return null;
  return new Date(Math.max(...candidates));
}

function daysSince(d: Date | null, now = Date.now()): number | null {
  if (!d) return null;
  return Math.floor((now - d.getTime()) / 86400_000);
}

function csvEscape(v: any): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildStudentsCsv(rows: StudentRow[]): string {
  const header = [
    "id",
    "name",
    "last_name",
    "email",
    "telegram_username",
    "telegram_id",
    "enrolled_at",
    "last_sign_in_at",
    "last_activity_at",
    "days_since_activity",
    "days_since_enrollment",
  ];
  const now = Date.now();
  const lines = [header.join(",")];
  for (const s of rows) {
    const last = lastActivityOf(s);
    lines.push(
      [
        s.id,
        s.name,
        s.last_name,
        s.email,
        s.telegram_username,
        s.telegram_id,
        s.created_at,
        s.last_sign_in_at,
        last ? last.toISOString() : "",
        daysSince(last, now) ?? "",
        daysSince(new Date(s.created_at), now) ?? "",
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  return lines.join("\n");
}

function fullName(s: StudentRow): string {
  return [s.name, s.last_name].filter(Boolean).join(" ") || "—";
}

// Render a short Telegram-friendly preview (top N) for a list.
function renderListPreview(rows: StudentRow[], maxRows = 10): string {
  if (!rows.length) return "";
  const lines: string[] = [];
  const top = rows.slice(0, maxRows);
  for (const s of top) {
    const handle = s.telegram_username ? `@${s.telegram_username}` : "—";
    const last = lastActivityOf(s);
    const ds = daysSince(last);
    const dsTxt = ds === null ? "∞" : `${ds}d`;
    lines.push(`• <b>${csvEscapeHtml(fullName(s))}</b> ${csvEscapeHtml(handle)} (${dsTxt})`);
  }
  if (rows.length > maxRows) {
    lines.push(`… +${rows.length - maxRows}`);
  }
  return lines.join("\n");
}

function csvEscapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function handleAdminCommand(
  admin: any,
  chatId: number,
  locale: Locale,
  cmd: string,
): Promise<boolean> {
  const t = T[locale] as any;

  if (cmd === "/admin") {
    await sendWithKeyboard(chatId, t.adminBackToAdmin, locale, true);
    return true;
  }

  if (cmd === "/talaba") {
    await sendWithKeyboard(chatId, t.adminStudentModeOn, locale, false);
    return true;
  }

  if (cmd === "/analitika") {
    const rows = await loadStudentActivity(admin);
    const now = Date.now();
    const total = rows.length;
    const loggedOnce = rows.filter((s) => !!s.last_sign_in_at).length;
    const neverLogged = total - loggedOnce;
    const sevenDayMs = 7 * 86400_000;
    const threeDayMs = 3 * 86400_000;
    const active7d = rows.filter((s) => {
      const la = lastActivityOf(s);
      return la && now - la.getTime() <= sevenDayMs;
    }).length;
    const inactive3d = rows.filter((s) => {
      if (!s.last_sign_in_at) return false; // never-logged-in handled separately
      const la = lastActivityOf(s);
      return !la || now - la.getTime() > threeDayMs;
    }).length;
    const inactive7d = rows.filter((s) => {
      if (!s.last_sign_in_at) return false;
      const la = lastActivityOf(s);
      return !la || now - la.getTime() > sevenDayMs;
    }).length;
    const new7d = rows.filter(
      (s) => now - new Date(s.created_at).getTime() <= sevenDayMs,
    ).length;

    // Lessons completed in last 7d
    const sevenAgoIso = new Date(now - sevenDayMs).toISOString();
    const { count: completions7d } = await admin
      .from("lesson_progress")
      .select("user_id", { count: "exact", head: true })
      .gte("completed_at", sevenAgoIso);

    const lines = [
      t.adminAnalyticsTitle,
      "",
      t.adminLine(t.adminTotalStudents, total),
      t.adminLine(t.adminLoggedOnce, loggedOnce),
      t.adminLine(t.adminNeverLogged, neverLogged),
      t.adminLine(t.adminActive7d, active7d),
      t.adminLine(t.adminInactive3d, inactive3d),
      t.adminLine(t.adminInactive7d, inactive7d),
      t.adminLine(t.adminNew7d, new7d),
      t.adminLine(t.adminCompletions7d, completions7d ?? 0),
    ];
    await sendWithKeyboard(chatId, lines.join("\n"), locale, true);
    return true;
  }

  // Drill-down list commands → preview + CSV upload
  const listKind: Record<string, { title: string; filter: (s: StudentRow, now: number) => boolean; filename: string }> = {
    "/inactive3": {
      title: t.adminInactive3Title,
      filename: "inactive_3d.csv",
      filter: (s, now) => {
        if (!s.last_sign_in_at) return false;
        const la = lastActivityOf(s);
        return !la || now - la.getTime() > 3 * 86400_000;
      },
    },
    "/inactive7": {
      title: t.adminInactive7Title,
      filename: "inactive_7d.csv",
      filter: (s, now) => {
        if (!s.last_sign_in_at) return false;
        const la = lastActivityOf(s);
        return !la || now - la.getTime() > 7 * 86400_000;
      },
    },
    "/nevr": {
      title: t.adminNeverTitle,
      filename: "never_logged_in.csv",
      filter: (s) => !s.last_sign_in_at,
    },
    "/yangilar": {
      title: t.adminNewTitle,
      filename: "new_students_7d.csv",
      filter: (s, now) => now - new Date(s.created_at).getTime() <= 7 * 86400_000,
    },
  };

  if (listKind[cmd]) {
    const cfg = listKind[cmd];
    const all = await loadStudentActivity(admin);
    const now = Date.now();
    const filtered = all.filter((s) => cfg.filter(s, now));
    // Sort: most-stale-first for inactive lists; most-recent enrollment first for /yangilar
    if (cmd === "/yangilar") {
      filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    } else {
      filtered.sort((a, b) => {
        const da = lastActivityOf(a)?.getTime() ?? 0;
        const db = lastActivityOf(b)?.getTime() ?? 0;
        return da - db;
      });
    }

    if (!filtered.length) {
      await sendWithKeyboard(chatId, t.adminCsvEmpty(cfg.title), locale, true);
      return true;
    }

    const preview = renderListPreview(filtered, 10);
    const header = `<b>${csvEscapeHtml(cfg.title)}</b> — ${filtered.length}`;
    await sendMessage(chatId, `${header}\n\n${preview}`);
    const csv = buildStudentsCsv(filtered);
    await sendDocument(chatId, cfg.filename, csv, t.adminCsvCaption(cfg.title, filtered.length));
    await sendKeyboardHint(chatId, locale, true);
    return true;
  }

  // Grading commands work for admins too
  const g = await handleGradingCommand(admin, chatId, /*graderId*/ "", locale, cmd, true);
  if (g) return true;

  return false;
}

async function teacherGroups(admin: any, teacherId: string): Promise<{ id: string; name: string }[]> {
  const { data } = await admin.from("groups").select("id, name").eq("teacher_id", teacherId);
  return (data || []) as any[];
}

async function teacherStudentIds(admin: any, teacherId: string): Promise<string[]> {
  const groups = await teacherGroups(admin, teacherId);
  if (!groups.length) return [];
  const { data } = await admin.from("profiles").select("id").in("group_id", groups.map((g) => g.id));
  return ((data || []) as any[]).map((r) => r.id);
}

async function handleTeacherCommand(admin: any, chatId: number, teacherId: string, locale: Locale, cmd: string): Promise<boolean> {
  const t = T[locale] as any;

  if (cmd === "/cancel") {
    await admin.from("bot_sessions").delete().eq("user_id", teacherId);
    await sendWithKeyboard(chatId, t.teacherCancelled, locale, false, "teacher");
    return true;
  }

  if (cmd === "/tstats") {
    const groups = await teacherGroups(admin, teacherId);
    if (!groups.length) {
      await sendWithKeyboard(chatId, t.teacherNoGroups, locale, false, "teacher");
      return true;
    }
    const lines: string[] = [t.teacherPanel];
    for (const g of groups) {
      const { data: ov } = await admin.rpc("staff_group_overview", { _group_id: g.id });
      const o = (ov && ov[0]) || { total: 0, active_7d: 0, completion_pct: 0, avg_score: 0, health: 0 };
      lines.push(`\n<b>${csvEscapeHtml(g.name)}</b>`);
      lines.push(`👥 ${o.total} · 🟢 ${o.active_7d} (7d) · 📈 ${o.completion_pct}% · 🎯 ${o.avg_score} · ❤️ ${o.health}`);
    }
    await sendWithKeyboard(chatId, lines.join("\n"), locale, false, "teacher");
    return true;
  }

  if (cmd === "/tstudents" || cmd === "/tinactive") {
    const ids = await teacherStudentIds(admin, teacherId);
    if (!ids.length) {
      await sendWithKeyboard(chatId, t.teacherNoGroups, locale, false, "teacher");
      return true;
    }
    const { data: profs } = await admin.from("profiles").select("id, name, last_name, telegram_username, telegram_id, created_at").in("id", ids);
    const { data: lp } = await admin.from("lesson_progress").select("user_id, updated_at").in("user_id", ids).order("updated_at", { ascending: false }).limit(5000);
    const lastMap = new Map<string, number>();
    for (const r of lp || []) {
      if (!lastMap.has(r.user_id)) lastMap.set(r.user_id, new Date(r.updated_at).getTime());
    }
    const now = Date.now();
    let rows = (profs || []).map((p: any) => {
      const rawHandle = (p.telegram_username || "").toString().trim();
      const handle = rawHandle ? (rawHandle.startsWith("@") ? rawHandle : `@${rawHandle}`) : (p.telegram_id ? `(id:${p.telegram_id})` : "—");
      const name = [p.name, p.last_name].filter(Boolean).join(" ").trim() || handle.replace(/^@/, "") || "—";
      return {
        name,
        handle,
        days: lastMap.has(p.id) ? Math.floor((now - lastMap.get(p.id)!) / 86400_000) : null,
      };
    });
    if (cmd === "/tinactive") rows = rows.filter((r) => r.days === null || r.days >= 3);
    rows.sort((a: any, b: any) => (b.days ?? 9999) - (a.days ?? 9999));
    const headerLabel = cmd === "/tinactive" ? t.tKbInactive : t.tKbStudents;
    const header = `<b>${headerLabel}</b> — ${rows.length}`;
    if (!rows.length) {
      await sendWithKeyboard(chatId, `${header}\n\n—`, locale, false, "teacher");
      return true;
    }
    const lines = rows.map((r) => `• <b>${csvEscapeHtml(r.name)}</b> ${csvEscapeHtml(r.handle)} (${r.days === null ? "∞" : r.days + "d"})`);
    // Telegram hard cap is 4096 chars; pack into chunks under ~3500 for safety, repeating header.
    const MAX = 3500;
    const chunks: string[] = [];
    let cur = header + "\n\n";
    for (const line of lines) {
      if ((cur.length + line.length + 1) > MAX) {
        chunks.push(cur.trimEnd());
        cur = header + "\n\n";
      }
      cur += line + "\n";
    }
    if (cur.trim().length) chunks.push(cur.trimEnd());
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      if (isLast) await sendWithKeyboard(chatId, chunks[i], locale, false, "teacher");
      else await sendMessage(chatId, chunks[i]);
    }
    return true;
  }

  if (cmd === "/ttop") {
    const { data } = await admin.rpc("staff_top_students", { _lim: 10 });
    const rows = (data || []) as any[];
    if (!rows.length) {
      await sendWithKeyboard(chatId, t.teacherNoGroups, locale, false, "teacher");
      return true;
    }
    const lines = rows.map((r, i) => `${i + 1}. <b>${csvEscapeHtml(r.name || "—")}</b> ${r.telegram_username ? "@" + r.telegram_username : ""} — ✅ ${r.completed_lessons} · 🎯 ${r.avg_score}`);
    await sendWithKeyboard(chatId, `<b>${t.tKbTop}</b>\n\n${lines.join("\n")}`, locale, false, "teacher");
    return true;
  }

  if (cmd === "/tbroadcast") {
    const groups = await teacherGroups(admin, teacherId);
    if (!groups.length) {
      await sendWithKeyboard(chatId, t.teacherNoGroups, locale, false, "teacher");
      return true;
    }
    // Rate-limit: 1 per hour
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await admin.from("bot_broadcast_rate").select("id", { count: "exact", head: true }).eq("actor_user_id", teacherId).eq("scope", "teacher").gte("created_at", since);
    if ((count || 0) >= 1) {
      await sendWithKeyboard(chatId, t.teacherBroadcastRate, locale, false, "teacher");
      return true;
    }
    await admin.from("bot_sessions").upsert({ user_id: teacherId, state: "teacher_broadcast", data: {}, updated_at: new Date().toISOString() });
    await sendWithKeyboard(chatId, t.teacherBroadcastPrompt, locale, false, "teacher");
    return true;
  }

  // Grading commands shared with admin
  const g = await handleGradingCommand(admin, chatId, teacherId, locale, cmd, false);
  if (g) return true;

  return false;
}

// =================== GRADING (teacher + admin) ===================

// Returns submissions in scope for grader. teacher=group students, admin=all.
async function gradingScopeIds(admin: any, graderId: string, isAdmin: boolean): Promise<string[] | null> {
  if (isAdmin) return null; // null = no scope filter
  const groups = await teacherGroups(admin, graderId);
  if (!groups.length) return [];
  const { data } = await admin.from("profiles").select("id").in("group_id", groups.map((g) => g.id));
  return ((data || []) as any[]).map((r) => r.id);
}

async function loadGradingSubmissions(admin: any, graderId: string, isAdmin: boolean, opts: { scored: boolean; limit?: number }) {
  const ids = await gradingScopeIds(admin, graderId, isAdmin);
  if (ids && ids.length === 0) return [];
  let q = admin.from("homework_submissions").select("id, assignment_id, user_id, submitted_at, score, score_feedback, scored_at, is_late");
  if (ids) q = q.in("user_id", ids);
  q = opts.scored ? q.not("score", "is", null).order("scored_at", { ascending: false }) : q.is("score", null).order("submitted_at", { ascending: true });
  if (opts.limit) q = q.limit(opts.limit);
  const { data: subs } = await q;
  const list = (subs || []) as any[];
  if (!list.length) return [];
  const aIds = Array.from(new Set(list.map((s) => s.assignment_id)));
  const uIds = Array.from(new Set(list.map((s) => s.user_id)));
  const [{ data: assigns }, { data: profs }] = await Promise.all([
    admin.from("homework_assignments").select("id, title, max_score, task_number").in("id", aIds),
    admin.from("profiles").select("id, name, last_name, telegram_id, preferred_locale").in("id", uIds),
  ]);
  const aMap = new Map((assigns || []).map((a: any) => [a.id, a]));
  const pMap = new Map((profs || []).map((p: any) => [p.id, p]));
  return list.map((s) => ({ ...s, assignment: aMap.get(s.assignment_id) || {}, profile: pMap.get(s.user_id) || {} }));
}

async function handleGradingCommand(
  admin: any, chatId: number, graderId: string, locale: Locale, cmd: string, isAdmin: boolean,
): Promise<boolean> {
  const t = T[locale] as any;

  if (cmd === "/baholash" || cmd === "/grade") {
    await renderStudentPicker(admin, chatId, graderId, locale, isAdmin, 0);
    return true;
  }

  if (cmd === "/baholar" || cmd === "/grades") {
    const items = await loadGradingSubmissions(admin, graderId, isAdmin, { scored: true, limit: 10 });
    if (!items.length) {
      await sendWithKeyboard(chatId, `${t.gradedRecent}\n\n${t.gradedNone}`, locale, isAdmin, isAdmin ? "admin" : "teacher");
      return true;
    }
    const lines = [t.gradedRecent, ""];
    items.forEach((s: any, i: number) => {
      const name = [s.profile?.name, s.profile?.last_name].filter(Boolean).join(" ") || "—";
      const tn = s.assignment?.task_number ? ` #${s.assignment.task_number}` : "";
      const title = `${s.assignment?.title || "—"}${tn}`;
      const mx = s.assignment?.max_score || 10;
      lines.push(t.gradedItem(i + 1, csvEscapeHtml(name), csvEscapeHtml(title), s.score, mx));
    });
    await sendWithKeyboard(chatId, lines.join("\n"), locale, isAdmin, isAdmin ? "admin" : "teacher");
    return true;
  }

  return false;
}

// =================== STUDENT-FIRST PICKER ===================

const PICKER_PAGE_SIZE = 10;

async function renderStudentPicker(admin: any, chatId: number, graderId: string, locale: Locale, isAdmin: boolean, page: number) {
  const t = T[locale] as any;
  const ids = await gradingScopeIds(admin, graderId, isAdmin);
  let q = admin.from("homework_submissions").select("user_id").is("score", null);
  if (ids) {
    if (ids.length === 0) {
      await sendWithKeyboard(chatId, `${t.gradePending}\n\n${t.gradeNoneP}`, locale, isAdmin, isAdmin ? "admin" : "teacher");
      return;
    }
    q = q.in("user_id", ids);
  }
  const { data: subs } = await q;
  const counts = new Map<string, number>();
  for (const s of (subs || []) as any[]) counts.set(s.user_id, (counts.get(s.user_id) || 0) + 1);
  if (counts.size === 0) {
    await sendWithKeyboard(chatId, `${t.gradePending}\n\n${t.gradeNoneP}`, locale, isAdmin, isAdmin ? "admin" : "teacher");
    return;
  }
  const userIds = Array.from(counts.keys());
  const { data: profs } = await admin.from("profiles").select("id, name, last_name").in("id", userIds);
  const rows = ((profs || []) as any[]).map((p: any) => ({
    id: p.id,
    name: [p.name, p.last_name].filter(Boolean).join(" ") || "—",
    n: counts.get(p.id) || 0,
  })).sort((a: any, b: any) => b.n - a.n);

  const totalPages = Math.max(1, Math.ceil(rows.length / PICKER_PAGE_SIZE));
  const pageIdx = Math.min(Math.max(0, page), totalPages - 1);
  const slice = rows.slice(pageIdx * PICKER_PAGE_SIZE, (pageIdx + 1) * PICKER_PAGE_SIZE);

  const buttons: any[][] = slice.map((r) => [{
    text: `${r.name} (${r.n})`.slice(0, 60),
    callback_data: `gs:pick:${r.id}`,
  }]);
  const nav: any[] = [];
  if (pageIdx > 0) nav.push({ text: t.gradePrevPage, callback_data: `gs:list:${pageIdx - 1}` });
  if (pageIdx < totalPages - 1) nav.push({ text: t.gradeNextPage, callback_data: `gs:list:${pageIdx + 1}` });
  if (nav.length) buttons.push(nav);

  await sendMessage(chatId, t.gradePickStudent, { inline_keyboard: buttons });
  await sendKeyboardHint(chatId, locale, isAdmin, isAdmin ? "admin" : "teacher");
}

async function renderStudentBreakdown(admin: any, chatId: number, graderId: string, studentId: string, locale: Locale, isAdmin: boolean) {
  const t = T[locale] as any;
  const ids = await gradingScopeIds(admin, graderId, isAdmin);
  if (ids && !ids.includes(studentId)) {
    await sendMessage(chatId, t.gradeNotFound);
    return;
  }
  const [{ data: prof }, { data: subs }] = await Promise.all([
    admin.from("profiles").select("name, last_name, group_id").eq("id", studentId).maybeSingle(),
    admin.from("homework_submissions").select("id, assignment_id, submitted_at").eq("user_id", studentId).is("score", null).order("submitted_at", { ascending: true }),
  ]);
  const list = (subs || []) as any[];
  const name = [prof?.name, prof?.last_name].filter(Boolean).join(" ") || "—";
  if (!list.length) {
    await sendMessage(chatId, `${t.gradeStudentBreakdown(name)}\n\n${t.gradeNoneP}`, {
      inline_keyboard: [[{ text: t.gradeBackList, callback_data: "gs:list:0" }]],
    });
    return;
  }
  const aIds = Array.from(new Set(list.map((s) => s.assignment_id)));
  const { data: assigns } = await admin.from("homework_assignments").select("id, title, max_score, task_number, module_id, modules(position, title)").in("id", aIds);
  const aMap = new Map(((assigns || []) as any[]).map((a: any) => [a.id, a]));
  const moduleIds = Array.from(new Set(((assigns || []) as any[]).map((a: any) => a.module_id)));
  const topicsRes = prof?.group_id && moduleIds.length
    ? await admin.from("group_module_topics").select("module_id, telegram_topic_url").eq("group_id", prof.group_id).in("module_id", moduleIds)
    : { data: [] as any[] };
  const topicMap = new Map(((topicsRes.data || []) as any[]).map((tp: any) => [tp.module_id, tp.telegram_topic_url]));

  const byModule = new Map<string, { mPos: number; mTitle: string; mid: string; items: any[] }>();
  for (const s of list) {
    const a: any = aMap.get(s.assignment_id);
    if (!a) continue;
    const key = a.module_id;
    if (!byModule.has(key)) byModule.set(key, { mPos: a.modules?.position ?? 0, mTitle: a.modules?.title || "—", mid: key, items: [] });
    byModule.get(key)!.items.push({ sub: s, a });
  }
  const modules = Array.from(byModule.values()).sort((x, y) => x.mPos - y.mPos);

  const lines = [t.gradeStudentBreakdown(name), ""];
  const buttons: any[][] = [];
  for (const m of modules) {
    lines.push(`📚 <b>Modul ${m.mPos + 1} — ${csvEscapeHtml(m.mTitle)}</b>`);
    for (const it of m.items) {
      const tn = it.a.task_number || 1;
      lines.push(`   ⏳ V${tn}: ${csvEscapeHtml(it.a.title || "")}`);
      buttons.push([{ text: `M${m.mPos + 1}·V${tn} — ${it.a.title || ""}`.slice(0, 60), callback_data: `gs:open:${it.sub.id}` }]);
    }
    const url = topicMap.get(m.mid);
    if (url) buttons.push([{ text: t.gradeOpenTopicBtn(m.mPos + 1), url }]);
    lines.push("");
  }
  buttons.push([{ text: t.gradeBackList, callback_data: "gs:list:0" }]);
  await sendMessage(chatId, lines.join("\n"), { inline_keyboard: buttons });
}

async function tgIdFromUserId(admin: any, userId: string): Promise<number | null> {
  const { data } = await admin.from("profiles").select("telegram_id").eq("id", userId).maybeSingle();
  return data?.telegram_id ?? null;
}

// Open a submission for grading: store conversation state and prompt for score.
async function startGradingFlow(admin: any, chatId: number, graderTgId: number, graderId: string, submissionId: string, locale: Locale, isAdmin: boolean) {
  const t = T[locale] as any;
  const { data: sub } = await admin
    .from("homework_submissions")
    .select("id, assignment_id, user_id, submitted_text, submitted_image_url, submitted_at, is_late, score, telegram_message_url, telegram_file_kind")
    .eq("id", submissionId)
    .maybeSingle();
  if (!sub) {
    await sendMessage(chatId, t.gradeNotFound);
    return;
  }
  const { data: a } = await admin.from("homework_assignments").select("id, title, max_score, task_number").eq("id", sub.assignment_id).maybeSingle();
  const { data: p } = await admin.from("profiles").select("id, name, last_name").eq("id", sub.user_id).maybeSingle();
  const name = [p?.name, p?.last_name].filter(Boolean).join(" ") || "—";
  const tn = a?.task_number ? ` #${a.task_number}` : "";
  const header = `<b>${csvEscapeHtml(name)}</b> — ${csvEscapeHtml(a?.title || "")}${tn}`;
  const body = sub.submitted_text ? csvEscapeHtml(sub.submitted_text) : "<i>(no text)</i>";
  await sendMessage(chatId, `${header}\n\n${body}`);
  // Telegram-source submission: surface the original message link
  if (sub.telegram_message_url) {
    const tt = T[locale] as any;
    await sendMessage(chatId, `📂 ${sub.telegram_file_kind || "file"}`, {
      inline_keyboard: [[{ text: tt.hwTeacherBtnFile, url: sub.telegram_message_url }]],
    });
  }
  // Legacy web-source submission: show signed image URL
  if (sub.submitted_image_url) {
    try {
      const { data: signed } = await admin.storage.from("homework_images").createSignedUrl(sub.submitted_image_url, 600);
      if (signed?.signedUrl) await sendMessage(chatId, `🖼 ${signed.signedUrl}`);
    } catch (_e) { /* ignore */ }
  }
  await admin.from("bot_conversation_state").upsert({
    telegram_id: graderTgId,
    state: "grade_score",
    context: { submission_id: submissionId, max_score: a?.max_score || 10, grader_id: graderId, is_admin: isAdmin },
    updated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  await sendMessage(chatId, t.gradeAskScore(a?.max_score || 10));
}

// Handle text replies for an in-progress grading conversation. Returns true if consumed.
async function handleGradingSession(admin: any, msg: any, profileId: string, locale: Locale, isAdmin: boolean): Promise<boolean> {
  const t = T[locale] as any;
  const tgId = msg.from.id as number;
  const { data: state } = await admin
    .from("bot_conversation_state")
    .select("state, context, expires_at")
    .eq("telegram_id", tgId)
    .maybeSingle();
  if (!state) return false;
  if (new Date(state.expires_at).getTime() < Date.now()) {
    await admin.from("bot_conversation_state").delete().eq("telegram_id", tgId);
    return false;
  }

  const text: string = (msg.text || "").trim();
  const ctx = (state.context || {}) as any;

  if (state.state === "grade_score") {
    if (text === "/cancel") {
      await admin.from("bot_conversation_state").delete().eq("telegram_id", tgId);
      await sendWithKeyboard(msg.chat.id, t.gradeCancelled, locale, isAdmin, isAdmin ? "admin" : "teacher");
      return true;
    }
    const max = Number(ctx.max_score || 10);
    const score = parseInt(text, 10);
    if (!Number.isFinite(score) || score < 0 || score > max) {
      await sendMessage(msg.chat.id, t.gradeBadScore(max));
      return true;
    }
    ctx.score = score;
    await admin.from("bot_conversation_state").update({
      state: "grade_comment", context: ctx, updated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    }).eq("telegram_id", tgId);
    await sendMessage(msg.chat.id, t.gradeAskComment);
    return true;
  }

  if (state.state === "grade_comment") {
    if (text === "/cancel") {
    await admin.from("bot_conversation_state").delete().eq("telegram_id", tgId);
    if (sub) cacheInvalidateUser(sub.user_id);
      await sendWithKeyboard(msg.chat.id, t.gradeCancelled, locale, isAdmin, isAdmin ? "admin" : "teacher");
      return true;
    }
    const feedback = text === "/skip" ? null : text;
    const submissionId = ctx.submission_id as string;
    const score = Number(ctx.score);

    const { data: sub } = await admin.from("homework_submissions")
      .select("user_id, assignment_id").eq("id", submissionId).maybeSingle();
    const { error: upErr } = await admin.from("homework_submissions").update({
      score, score_feedback: feedback, scored_by: profileId, scored_at: new Date().toISOString(),
    }).eq("id", submissionId);
    if (upErr) {
      await sendMessage(msg.chat.id, `❌ ${upErr.message}`);
      return true;
    }
    await admin.from("bot_conversation_state").delete().eq("telegram_id", tgId);

    // Auto-DM the student (always)
    if (sub) {
      const { data: a } = await admin.from("homework_assignments").select("title, max_score, task_number").eq("id", sub.assignment_id).maybeSingle();
      const { data: stu } = await admin.from("profiles").select("telegram_id, preferred_locale, name").eq("id", sub.user_id).maybeSingle();
      const max = a?.max_score || 10;
      if (stu?.telegram_id) {
        const stuLocale: Locale = normLocale(stu.preferred_locale);
        const tt = T[stuLocale] as any;
        const tn = a?.task_number ? ` #${a.task_number}` : "";
        const title = `${a?.title || ""}${tn}`;
        try {
          const url = await createMagicLink(admin, sub.user_id, "login", "/profile");
          await sendMessage(stu.telegram_id, tt.gradeStudentDM(csvEscapeHtml(title), score, max, csvEscapeHtml(feedback || "")), {
            inline_keyboard: [[{ text: tt.btnSiteOpen, url }]],
          });
        } catch (e) {
          console.error("auto-DM student failed", e);
        }
      }
      await sendWithKeyboard(msg.chat.id, t.gradeSaved(score, max), locale, isAdmin, isAdmin ? "admin" : "teacher");
    }
    return true;
  }

  return false;
}
async function handleTeacherSession(admin: any, msg: any, profileId: string, locale: Locale): Promise<boolean> {
  const t = T[locale] as any;
  const { data: sess } = await admin.from("bot_sessions").select("state, data").eq("user_id", profileId).maybeSingle();
  if (!sess || sess.state !== "teacher_broadcast") return false;
  const text: string = (msg.text || "").trim();
  if (!text || text.startsWith("/")) return false;
  if (text.length > 300) {
    await sendWithKeyboard(msg.chat.id, t.teacherBroadcastTooLong, locale, false, "teacher");
    return true;
  }
  const groups = await teacherGroups(admin, profileId);
  const groupName = groups.map((g: any) => g.name).join(", ");
  const ids = await teacherStudentIds(admin, profileId);
  const { data: profs } = ids.length
    ? await admin.from("profiles").select("id, telegram_id, name").in("id", ids)
    : { data: [] };
  const recipients = (profs || []).filter((p: any) => p.telegram_id);
  if (!recipients.length) {
    await admin.from("bot_sessions").delete().eq("user_id", profileId);
    await sendWithKeyboard(msg.chat.id, t.teacherBroadcastEmpty, locale, false, "teacher");
    return true;
  }
  const body = `${t.teacherFromTeacher(groupName || "—")}${csvEscapeHtml(text)}`;
  let sent = 0;
  for (const r of recipients) {
    try {
      await sendMessage(r.telegram_id, body);
      await admin.from("bot_broadcast_rate").insert({ actor_user_id: profileId, recipient_user_id: r.id, scope: "recipient" });
      sent++;
    } catch (_e) { /* ignore */ }
  }
  await admin.from("bot_broadcast_rate").insert({ actor_user_id: profileId, scope: "teacher" });
  await admin.from("bot_sessions").delete().eq("user_id", profileId);
  await sendWithKeyboard(msg.chat.id, t.teacherBroadcastSent(sent), locale, false, "teacher");
  return true;
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
    if (cmd === "/start") {
      const enroll = await getEnrollmentSettings(admin, locale);
      await sendMessage(chatId, enroll.message, {
        inline_keyboard: [[{ text: enroll.buttonLabel, url: enroll.formUrl }]],
      });
    } else {
      await sendMessage(chatId, t.noProfile);
    }
    return;
  }

  // Admin / teacher routing
  const persona = await getPersona(admin, profile.id);
  if (persona === "admin") {
    const handled = await handleAdminCommand(admin, chatId, locale, cmd);
    if (handled) return;
  } else if (persona === "teacher") {
    const handled = await handleTeacherCommand(admin, chatId, profile.id, locale, cmd);
    if (handled) return;
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
    console.time(`bot:stats:${profile.id}`);
    const cacheKey = `stats:${profile.id}:${locale}`;
    let text = cacheGet(cacheKey);
    if (!text) { text = await buildStatsMessage(admin, profile.id, locale); cacheSet(cacheKey, text); }
    const url = await createMagicLink(admin, profile.id, "login", "/dashboard");
    await sendMessage(chatId, text, { inline_keyboard: [[{ text: t.btnSiteOpen, url }]] });
    await sendKeyboardHint(chatId, locale);
    console.timeEnd(`bot:stats:${profile.id}`);
    return;
  }

  if (cmd === "/vazifalar" || cmd === "/homework") {
    console.time(`bot:hw:${profile.id}`);
    // No cache: message contains personalized inline submit buttons.
    const { text, keyboard } = await buildHomeworkMessage(admin, profile.id, locale);
    const url = await createMagicLink(admin, profile.id, "login", "/dashboard");
    const submitRows = keyboard?.inline_keyboard || [];
    const inline_keyboard = [...submitRows, [{ text: t.btnHwSite, url }]];
    await sendMessage(chatId, text, { inline_keyboard });
    console.timeEnd(`bot:hw:${profile.id}`);
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

// =================== HOMEWORK SUBMISSION (BOT-FIRST) ===================

// Parse a Telegram topic URL like:
//   https://t.me/c/2123456789/15           → { chatId: -1002123456789, threadId: 15 }
//   https://t.me/c/2123456789/15/42        → same (extra is message id, ignored)
// Returns null if it can't parse a private (c/) supergroup topic URL.
function parseTopicUrl(url: string): { chatId: number; threadId: number } | null {
  try {
    const m = (url || "").match(/^https:\/\/t\.me\/c\/(\d+)\/(\d+)(?:\/\d+)?/);
    if (!m) return null;
    const stripped = m[1];
    const threadId = parseInt(m[2], 10);
    if (!Number.isFinite(threadId)) return null;
    // Telegram supergroup chat ids are -100 + the public id
    const chatId = -1 * Number("100" + stripped);
    return { chatId, threadId };
  } catch {
    return null;
  }
}

// Build a re-openable link to a specific message inside a private supergroup topic.
function buildMessageLink(chatId: number, threadId: number, messageId: number): string {
  // chatId is -100xxxxxxxxxx → strip -100 → xxxxxxxxxx
  const s = String(chatId).replace(/^-100/, "");
  return `https://t.me/c/${s}/${threadId}/${messageId}`;
}

async function setMessageReaction(chatId: number, messageId: number, emoji = "✅") {
  try {
    await tgApi("setMessageReaction", {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji }],
      is_big: false,
    });
  } catch (_e) { /* best-effort */ }
}

// Student tapped "📤 Topshirish" in /vazifalar — open intent and point to topic.
async function startHomeworkIntent(
  admin: any, chatId: number, profile: any, locale: Locale, assignmentId: string,
) {
  const t = T[locale] as any;

  // 1. Load assignment + module
  const { data: a } = await admin
    .from("homework_assignments")
    .select("id, title, max_score, task_number, module_id, modules(id, title, position)")
    .eq("id", assignmentId)
    .maybeSingle();
  if (!a) { await sendMessage(chatId, t.gradeNotFound); return; }

  // 2. Already graded? Block.
  const { data: existing } = await admin
    .from("homework_submissions")
    .select("id, score")
    .eq("user_id", profile.id).eq("assignment_id", assignmentId)
    .maybeSingle();
  if (existing && existing.score != null) {
    await sendMessage(chatId, t.hwIntentAlreadyScored);
    return;
  }

  // 3. Resolve student group + topic
  if (!profile.group_id) { await sendMessage(chatId, t.hwIntentNoGroup); return; }
  const { data: gmt } = await admin
    .from("group_module_topics")
    .select("telegram_topic_url")
    .eq("group_id", profile.group_id).eq("module_id", a.module_id)
    .maybeSingle();
  const topicUrl = gmt?.telegram_topic_url;
  if (!topicUrl) { await sendMessage(chatId, t.hwIntentNoTopic); return; }

  const parsed = parseTopicUrl(topicUrl);
  if (!parsed) { await sendMessage(chatId, t.hwIntentNoTopic); return; }

  // 4. Upsert intent (10 min TTL)
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  await admin.from("bot_homework_intents").upsert({
    user_id: profile.id,
    assignment_id: assignmentId,
    module_id: a.module_id,
    group_id: profile.group_id,
    telegram_chat_id: parsed.chatId,
    telegram_thread_id: parsed.threadId,
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
  }, { onConflict: "user_id,assignment_id" });

  const mn = (a.modules?.position ?? 0) + 1;
  const tn = a.task_number || 1;
  await sendMessage(chatId, t.hwIntentReady(mn, tn), {
    inline_keyboard: [[{ text: t.hwIntentBtnGoTopic, url: topicUrl }]],
  });
}

// Group/supergroup post inside a topic — try to attach it to a pending intent.
async function handleGroupTopicMessage(admin: any, msg: any) {
  try {
    const chatId = msg.chat?.id;
    const threadId = msg.message_thread_id;
    const fromId = msg.from?.id;
    const senderChatId = msg.sender_chat?.id;
    const messageId = msg.message_id;
    // Telegram's anonymous-admin proxy bot id (when an admin posts "as the group")
    const ANON_ADMIN_BOT_ID = 1087968824;
    const isAnon = fromId === ANON_ADMIN_BOT_ID;
    console.log("hw:group:enter", JSON.stringify({ chatId, threadId, fromId, senderChatId, messageId, isAnon }));
    if (!chatId || !threadId || !messageId) {
      console.log("hw:group:skip-missing-fields");
      return;
    }

    // Try to identify the student (only useful when not anonymous)
    let profile: any = null;
    if (fromId && !isAnon) {
      profile = await findProfileByTelegramId(admin, fromId);
    }

    // Find a non-expired matching intent for this topic.
    // If we know the user, scope by user_id; otherwise (anonymous admin post) match by topic alone — the most recent intent in this exact topic wins.
    const nowIso = new Date().toISOString();
    let q = admin
      .from("bot_homework_intents")
      .select("id, user_id, assignment_id, module_id, group_id")
      .eq("telegram_chat_id", chatId)
      .eq("telegram_thread_id", threadId)
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: false })
      .limit(1);
    if (profile) q = q.eq("user_id", profile.id);
    const { data: intents, error: intentErr } = await q;
    if (intentErr) console.error("hw:group:intent-query-err", intentErr);
    const intent = (intents && intents[0]) as any;
    if (!intent) {
      console.log("hw:group:no-matching-intent", JSON.stringify({ user_id: profile?.id, chatId, threadId, isAnon }));
      return; // silent — no pending submission for this topic
    }

    // If we didn't have a profile (anonymous post), resolve it from the intent
    if (!profile) {
      const { data: p } = await admin
        .from("profiles")
        .select("id, name, last_name, telegram_username, telegram_id, telegram_onboarded_at, preferred_locale, group_id")
        .eq("id", intent.user_id)
        .maybeSingle();
      profile = p;
      if (!profile) {
        console.log("hw:group:intent-user-not-found", intent.user_id);
        return;
      }
    }
    // Extract media
    let fileId: string | null = null;
    let kind = "text";
    if (Array.isArray(msg.photo) && msg.photo.length) {
      fileId = msg.photo[msg.photo.length - 1].file_id;
      kind = "photo";
    } else if (msg.document) {
      fileId = msg.document.file_id;
      kind = "document";
    } else if (msg.video) {
      fileId = msg.video.file_id;
      kind = "video";
    } else if (msg.voice) {
      fileId = msg.voice.file_id;
      kind = "voice";
    } else if (msg.video_note) {
      fileId = msg.video_note.file_id;
      kind = "video_note";
    } else if (!msg.text && !msg.caption) {
      return; // unsupported message type, no media, no text
    }

    const messageUrl = buildMessageLink(chatId, threadId, messageId);
    const submittedText = (msg.caption || msg.text || "").slice(0, 4000);

    // Upsert submission. Unique key (user_id, assignment_id) — idempotent.
    const { data: upserted, error: upErr } = await admin
      .from("homework_submissions")
      .upsert({
        user_id: profile.id,
        assignment_id: intent.assignment_id,
        submitted_text: submittedText,
        submitted_at: new Date().toISOString(),
        score: null,
        score_feedback: null,
        scored_by: null,
        scored_at: null,
        is_late: false,
        telegram_chat_id: chatId,
        telegram_thread_id: threadId,
        telegram_message_id: messageId,
        telegram_message_url: messageUrl,
        telegram_file_id: fileId,
        telegram_file_kind: kind,
        source: "telegram_topic",
      }, { onConflict: "user_id,assignment_id" })
      .select("id")
      .maybeSingle();
    if (upErr) {
      console.error("hw upsert error", upErr);
      return;
    }

    // Consume intent
    await admin.from("bot_homework_intents").delete().eq("id", intent.id);

    // ✅ React to confirm in-thread
    await setMessageReaction(chatId, messageId, "✅");

    // Locale + assignment meta for messages
    const locale: Locale = normLocale(profile.preferred_locale);
    const t = T[locale] as any;
    const { data: a } = await admin
      .from("homework_assignments")
      .select("title, task_number, module_id, modules(position)")
      .eq("id", intent.assignment_id)
      .maybeSingle();
    const mn = ((a?.modules?.position ?? 0) as number) + 1;
    const tn = (a?.task_number ?? 1) as number;
    const aTitle = a?.title || "";
    const moduleId = a?.module_id || intent.module_id;

    // Private DM to student
    if (profile.telegram_id) {
      try { await sendMessage(profile.telegram_id, t.hwReceived(mn, tn)); } catch (_e) {}
    }

    // Queue teacher DM (handles RBAC, throttling, quiet hours)
    const subId = upserted?.id;
    await notifyTeachersOfSubmission(admin, profile, intent.group_id, mn, tn, aTitle, messageUrl, subId, moduleId);

    // Invalidate any cached "stats" for the student so next /galaba is fresh
    cacheInvalidateUser(profile.id);
  } catch (e) {
    console.error("handleGroupTopicMessage error", e);
  }
}

async function notifyTeachersOfSubmission(
  admin: any,
  studentProfile: any,
  groupId: string | null,
  mn: number, tn: number, aTitle: string,
  messageUrl: string,
  submissionId: string | undefined,
  assignmentId: string,
  moduleId: string,
) {
  try {
    if (!submissionId) return;
    if (!groupId) {
      // NO_TEACHER edge case (no group) — log to audit so admin sees ungraded submissions accumulating
      try {
        await admin.from("admin_actions").insert({
          actor_user_id: studentProfile.id,
          action: "homework_submission_dm_sent",
          target_user_id: null,
          target_resource_type: "homework_submission",
          target_resource_id: submissionId,
          details: { reason: "no_group", student_id: studentProfile.id, message_url: messageUrl, queued: false },
        });
      } catch { /* ignore */ }
      return;
    }
    const { data: g } = await admin.from("groups").select("teacher_id").eq("id", groupId).maybeSingle();
    const teacherId = g?.teacher_id;
    if (!teacherId) {
      try {
        await admin.from("admin_actions").insert({
          actor_user_id: studentProfile.id,
          action: "homework_submission_dm_sent",
          target_user_id: null,
          target_resource_type: "homework_submission",
          target_resource_id: submissionId,
          details: { reason: "no_teacher", student_id: studentProfile.id, group_id: groupId, module_id: moduleId, message_url: messageUrl, queued: false },
        });
      } catch { /* ignore */ }
      return;
    }

    // Throttle: skip if we already queued/sent a DM for this same student+assignment in the last 24h
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recent } = await admin
      .from("homework_teacher_dm_queue")
      .select("id")
      .eq("student_id", studentProfile.id)
      .eq("assignment_id", assignmentId)
      .gte("created_at", since)
      .limit(1);
    if (recent && recent.length) return;

    // Quiet hours 22:00–08:00 Tashkent
    const now = new Date();
    const tashHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tashkent", hour: "2-digit", hour12: false }).format(now));
    let scheduled = now;
    let quiet = false;
    if (tashHour >= 22 || tashHour < 8) {
      quiet = true;
      // Compute next 08:00 Tashkent (UTC+5, no DST)
      const utcMs = now.getTime();
      const tashMs = utcMs + 5 * 60 * 60 * 1000;
      const tashDate = new Date(tashMs);
      const y = tashDate.getUTCFullYear(); const m = tashDate.getUTCMonth(); const d = tashDate.getUTCDate();
      const targetTashMs = Date.UTC(y, m, d + (tashHour >= 22 ? 1 : 0), 8, 0, 0);
      scheduled = new Date(targetTashMs - 5 * 60 * 60 * 1000);
    }

    const studentName = [studentProfile.name, studentProfile.last_name].filter(Boolean).join(" ") || "—";

    await admin.from("homework_teacher_dm_queue").insert({
      submission_id: submissionId,
      teacher_id: teacherId,
      student_id: studentProfile.id,
      group_id: groupId,
      module_id: moduleId,
      assignment_id: assignmentId,
      module_number: mn,
      task_number: tn,
      assignment_title: aTitle,
      student_name: studentName,
      message_url: messageUrl,
      scheduled_for: scheduled.toISOString(),
      queued_for_quiet_hours: quiet,
    });
  } catch (e) {
    console.error("notifyTeachersOfSubmission error", e);
  }
}

async function handleCallback(admin: any, cq: any) {
  const data: string = cq.data || "";
  const tgId = cq.from.id as number;
  const chatId = cq.message?.chat?.id;

  if (data === "ack:not_today") {
    await answerCallback(cq.id, "OK 👍");
    return;
  }

  // Student tapped "📤 Topshirish" in /vazifalar
  if (data.startsWith("hw:start:") && chatId) {
    const assignmentId = data.slice("hw:start:".length);
    const profile = await findProfileByTelegramId(admin, tgId);
    if (!profile) { await answerCallback(cq.id); return; }
    const locale: Locale = normLocale(profile.preferred_locale);
    await answerCallback(cq.id);
    await startHomeworkIntent(admin, chatId, profile, locale, assignmentId);
    return;
  }

  if (data.startsWith("grade:open:") && chatId) {
    const submissionId = data.slice("grade:open:".length);
    const profile = await findProfileByTelegramId(admin, tgId);
    if (!profile) { await answerCallback(cq.id); return; }
    const persona = await getPersona(admin, profile.id);
    if (persona !== "admin" && persona !== "teacher") { await answerCallback(cq.id); return; }
    const locale: Locale = normLocale(profile.preferred_locale);
    await answerCallback(cq.id);
    await startGradingFlow(admin, chatId, tgId, profile.id, submissionId, locale, persona === "admin");
    return;
  }

  if ((data.startsWith("gs:list:") || data.startsWith("gs:pick:") || data.startsWith("gs:open:")) && chatId) {
    const profile = await findProfileByTelegramId(admin, tgId);
    if (!profile) { await answerCallback(cq.id); return; }
    const persona = await getPersona(admin, profile.id);
    if (persona !== "admin" && persona !== "teacher") { await answerCallback(cq.id); return; }
    const locale: Locale = normLocale(profile.preferred_locale);
    const isAdmin = persona === "admin";
    await answerCallback(cq.id);
    if (data.startsWith("gs:list:")) {
      const page = parseInt(data.slice("gs:list:".length), 10) || 0;
      await renderStudentPicker(admin, chatId, profile.id, locale, isAdmin, page);
    } else if (data.startsWith("gs:pick:")) {
      const sid = data.slice("gs:pick:".length);
      await renderStudentBreakdown(admin, chatId, profile.id, sid, locale, isAdmin);
    } else if (data.startsWith("gs:open:")) {
      const subId = data.slice("gs:open:".length);
      await startGradingFlow(admin, chatId, tgId, profile.id, subId, locale, isAdmin);
    }
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
  // Warmth ping (GET) — keeps Edge Function warm via pg_cron net.http_get
  if (req.method === "GET") {
    return new Response(JSON.stringify({ ok: true, warm: true }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
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

  // Diagnostic: log every incoming update shape (top-level keys + chat type/thread)
  try {
    const topKeys = Object.keys(update).filter((k) => k !== "update_id");
    const m = update.message || update.channel_post || update.edited_message;
    console.log("tg:update", JSON.stringify({
      keys: topKeys,
      chat_type: m?.chat?.type,
      chat_id: m?.chat?.id,
      thread_id: m?.message_thread_id,
      from_id: m?.from?.id,
      has_photo: !!m?.photo,
      has_doc: !!m?.document,
      has_video: !!m?.video,
      text_preview: (m?.text || m?.caption || "").slice(0, 40),
    }));
  } catch (_e) { /* noop */ }

  try {
    // Treat both message and channel_post as inbound for group topics (forum supergroups can deliver either)
    const inbound = update.message || update.channel_post;
    if (inbound) {
      const msg = inbound;
      // Group/supergroup posts (e.g. inside a forum topic) → homework intake only
      const chatType = msg.chat?.type;
      if (chatType === "supergroup" || chatType === "group" || chatType === "channel") {
        await handleGroupTopicMessage(admin, msg);
        return new Response("ok", { status: 200, headers: corsHeaders });
      }
    }
    if (update.message) {
      const msg = update.message;
      const text: string = msg.text || "";
      const profileForLocale = await findProfileByTelegramId(admin, msg.from.id);
      const locale: Locale = profileForLocale?.preferred_locale
        ? normLocale(profileForLocale.preferred_locale)
        : normLocale(msg.from.language_code);

      const persona: Persona = profileForLocale ? await getPersona(admin, profileForLocale.id) : "student";
      const adminFlag = persona === "admin";

      if (text.startsWith("/start ")) {
        const arg = text.slice(7).trim();
        if (arg.startsWith("login_")) {
          const tok = arg.slice(6);
          await handleStartLogin(admin, msg, tok, locale);
        } else if (profileForLocale) {
          await sendWithKeyboard(msg.chat.id, T[locale].helpReply, locale, adminFlag, persona);
        } else {
          const enroll = await getEnrollmentSettings(admin, locale);
          await sendMessage(msg.chat.id, enroll.message, {
            inline_keyboard: [[{ text: enroll.buttonLabel, url: enroll.formUrl }]],
          });
        }
      } else if (text === "/start") {
        if (profileForLocale) {
          await sendWithKeyboard(msg.chat.id, T[locale].helpReply, locale, adminFlag, persona);
        } else {
          const enroll = await getEnrollmentSettings(admin, locale);
          await sendMessage(msg.chat.id, enroll.message, {
            inline_keyboard: [[{ text: enroll.buttonLabel, url: enroll.formUrl }]],
          });
        }
      } else if (text.startsWith("/")) {
        // Grading session intercepts /skip and /cancel for the in-progress flow
        if ((persona === "teacher" || persona === "admin") && profileForLocale) {
          const cmd0 = text.split(/\s+/)[0].toLowerCase();
          if (cmd0 === "/skip" || cmd0 === "/cancel") {
            const consumed = await handleGradingSession(admin, msg, profileForLocale.id, locale, persona === "admin");
            if (consumed) { /* done */ }
            else { await handleCommand(admin, msg, cmd0); }
          } else {
            await handleCommand(admin, msg, cmd0);
          }
        } else {
          await handleCommand(admin, msg, text.split(/\s+/)[0]);
        }
      } else {
        // Grading conversation captures plain text replies first
        let consumed = false;
        if ((persona === "teacher" || persona === "admin") && profileForLocale) {
          consumed = await handleGradingSession(admin, msg, profileForLocale.id, locale, persona === "admin");
        }
        if (!consumed && persona === "teacher" && profileForLocale) {
          consumed = await handleTeacherSession(admin, msg, profileForLocale.id, locale);
        }
        if (!consumed) {
          const mapped = buttonTextToCommand(text);
          if (mapped) await handleCommand(admin, msg, mapped);
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
