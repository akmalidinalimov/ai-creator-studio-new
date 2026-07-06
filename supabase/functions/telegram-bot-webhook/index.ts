// Telegram bot webhook. Receives Updates from api.telegram.org via setWebhook.
// Verifies X-Telegram-Bot-Api-Secret-Token, then dispatches commands.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { computeLeaves, pickNextLeaf } from "./homework-routing.ts";
import { effectiveLeafGrades, summarizeHomework } from "./homework-stats.ts";

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
    levelNames: ["Boshlovchi", "O'quvchi", "Bilimdon", "Usta", "Master"],
    statsLevel: (emoji: string, name: string, score: number, barStr: string, isMax: boolean, nextEmoji: string, nextName: string) => `⭐ Daraja: ${emoji} <b>${name}</b> (${score}/100)\n${barStr}${isMax ? " — eng yuqori daraja! 🏆" : ` → ${nextEmoji} ${nextName}`}`,
    statsLessons: (d: number, tot: number, watch: string) => `📚 Darslar: <b>${d}/${tot}</b>${watch ? ` · ${watch} jami` : ""}\n${bar(d, tot)}`,
    statsStreak: (cur: number, best: number, barStr: string, next: number | null, atMilestone: boolean) => `🔥 <b>${cur} kunlik streak</b>${atMilestone ? " 🎉 yangi bosqich!" : ""} · rekord: ${best}\n${barStr}${next ? ` → ${next} kun` : " 🏆 eng yuqori!"}`,
    statsStreakNone: "🔥 Streak: hali boshlanmadi",
    statsStreakBroken: (best: number) => `🔥 Streak uzildi — rekordingiz: <b>${best}</b> kun. Bugun yangi streak boshlang! 💪`,
    statsFreezes: (n: number) => `❄️ Streak himoyasi: <b>${n}</b> ta muzlatish (bir kun o'tkazsangiz, streak saqlanadi)`,
    statsDailyGoal: (d: number, tar: number, ok: boolean) => `🎯 Bugungi maqsad: <b>${d}/${tar}</b>${ok ? " ✅" : ""}\n${bar(d, tar)}`,
    statsHomework: (sub: number, totalLeaves: number, scored: number) => `📝 Uy vazifalari: <b>${sub}/${totalLeaves}</b>${scored ? ` (${scored} ta baholangan)` : ""}\n${bar(sub, totalLeaves)}`,
    statsHomeworkPoints: (earned: number, maxTotal: number) => `📈 Vazifa ballari: <b>${earned}/${maxTotal}</b>`,
    statsHomeworkNone: "📝 Uy vazifalari: hali topshirilmadi",
    statsRanking: (r: number, tot: number, sc: number) => `🏆 Reyting: <b>${r}-o'rin</b> / ${tot} talaba`,
    statsRankingNone: "🏆 Reyting: hali sanalmadi (faollik kerak — kamida 1 ta dars ko'ring)",
    statsGroupTitle: "🏆 <b>Guruh reytingi</b>",
    statsGroupRow: (rankLabel: string, name: string, score: number) => `${rankLabel} ${name} — ${score}`,
    statsGroupRowMe: (rankLabel: string, score: number) => `<b>${rankLabel} 👉 Siz — ${score}</b>`,
    statsGroupSummary: (rank: number, total: number, gap: string) => `📊 Guruhdagi o'rningiz: <b>${rank}/${total}</b>${gap}`,
    statsStar: (name: string) => `⭐ Hafta yulduzi: <b>${name}</b>`,
    statsStarMe: "⭐ <b>Bu hafta siz guruh yulduzisiz!</b> 🎉",
    statsGroupGap: (nextRank: number, gap: number) => ` · ${nextRank}-o'ringa ${gap} ball qoldi`,
    statsBadges: (e: number, tot: number) => `🏅 Nishonlar: <b>${e}/${tot}</b>`,
    statsBadgesShowcase: (icons: string, earned: number, total: number) => `🏅 Nishonlar: <b>${earned}/${total}</b>${icons ? `\n${icons}` : ""}`,
    statsNextBadge: (name: string, desc: string) => `🔒 Keyingi nishon: <b>${name}</b>${desc ? ` — ${desc}` : ""}`,
    statsBadgesAllDone: "🏅 Barcha nishonlar yig'ildi! 🎉",
    statsCta: (met: boolean) => met ? `✨ Zo'r! Bugun maqsadga yetdingiz — streakni saqlab qoldingiz! 🔥` : `👉 Bugun 1 ta dars ko'ring — streakni saqlang va keyingi darajaga yaqinlashing!`,
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
    tKbSwitchGroup: "🔄 Guruhni almashtirish",
    tKbHomework: "📝 Vazifalar",
    tKbGrade: "📝 Baholash",
    tKbGraded: "👥 Talabalar",
    rosterTitle: "👥 <b>Talabalar</b>\nTalabani tanlang:",
    rosterEmpty: "Guruhda talaba topilmadi.",
    rosterStudentRow: (name: string, n: number) => `${name} · ${n}`,
    studentModulesTitle: (name: string) => `👤 <b>${csvEscapeHtml(name)}</b>\n\nModul bo'yicha topshiriqlar:`,
    studentModulesEmpty: "Bu talaba hali hech narsa topshirmagan.",
    moduleRowBtn: (mn: number, count: number, scores: string) => `📦 ${mn}-modul — ${count} topshirildi · ${scores}`,
    backToRoster: "↩️ Talabalar ro'yxati",
    scorePending: "⏳",
    thmTitle: "📝 <b>Modullar bo'yicha vazifalar</b>\nModulni tanlang:",
    thmEmpty: "Sizga hali kurs va guruh biriktirilmagan.",
    thmModuleRow: (pos: number, title: string, sub: number, total: number) =>
      `📦 ${pos}-modul · ${title} — ✅ ${sub}/${total}`.slice(0, 60),
    thmSubmittedTitle: (pos: number, title: string) =>
      `✅ <b>${pos}-modul — ${csvEscapeHtml(title)}</b>\nTopshirganlar:`,
    thmMissingTitle: (pos: number, title: string) =>
      `❌ <b>${pos}-modul — ${csvEscapeHtml(title)}</b>\nTopshirmaganlar:`,
    thmNoneSubmitted: "Hech kim topshirmagan.",
    thmNoneMissing: "🎉 Hammasi topshirgan.",
    thmBackToList: "↩️ Modullar ro'yxati",
    thmStudentLine: (handle: string, name: string) =>
      `• ${handle ? `@${handle}` : ""}${handle && name ? ` (${name})` : name}`.trim(),
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
    tPickGroup: "📚 Qaysi guruh uchun?",
    tActiveGroup: (n: string) => `📌 Faol guruh: <b>${csvEscapeHtml(n)}</b>\n<i>Boshqa guruhga o'tish: /guruh</i>`,
    tGroupSwitched: (n: string) => `✅ Faol guruh: <b>${csvEscapeHtml(n)}</b>`,
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
    gradeOpenSubmissionBtn: (tn: number) => `📌 V${tn} postiga o'tish`,
    gradeOpenSubmissionPostBtn: "📌 Topshirilgan postga o'tish",
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
    hwTaskScored: (tn: number, sc: number, mx: number, fb: string) => `   ✅ V${tn}: ${sc}/${mx}${fb ? `\n      💬 ${csvEscapeHtml(fb)}` : ""}`,
    hwTaskResub: (tn: number, sc: number, mx: number) => `   🔄 V${tn}: ${sc}/${mx} — qayta topshirilgan, yangi baho kutilmoqda`,
    hwTaskUnscored: (tn: number) => `   ⏳ V${tn}: hali baholanmagan`,
    hwTaskSubmitted: (tn: number) => `   📤 V${tn}: topshirilgan, baholashni kuting`,
    hwTaskNotStarted: (tn: number) => `   📝 V${tn}: boshlanmadi`,
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
    hwResubAsk: (sc: number, mx: number, fb: string) =>
      `📊 Sizning oldingi natijangiz: <b>${sc}/${mx}</b>${fb ? `\nIzoh: "${csvEscapeHtml(fb)}"` : ""}\n\nQayta topshirmoqchimisiz?`,
    hwResubYes: "✅ Ha, qayta topshiraman",
    hwResubNo: "❌ Yo'q",
    hwResubCancelled: "OK 👍 Oldingi natija saqlanadi.",
    hwResubError: "❌ Qayta topshirishni boshlab bo'lmadi. Keyinroq urinib ko'ring.",
    hwReceived: (mn: number, tn: number) =>
      `✅ Vazifangiz qabul qilindi · Modul ${mn} · V${tn}\nUstoz baholaganidan keyin natija keladi.`,
    hwTeacherNotify: (name: string, mn: number, tn: number, title: string) =>
      `🆕 <b>Yangi topshiriq</b>\n👤 ${csvEscapeHtml(name)}\n📚 Modul ${mn} · V${tn} — ${csvEscapeHtml(title)}`,
    hwTeacherBtnFile: "📂 Faylni ko'rish",
    hwTeacherBtnGrade: "🎯 Hozir baholash",
    namePrompt: (cur: string) => `👤 Reytingda ismingiz shunday ko'rinadi: <b>${cur}</b>\nTo'g'ri ko'rinishi uchun tasdiqlang:`,
    nameBtnOk: "✅ Ismim to'g'ri",
    nameBtnEdit: "✏️ Ismni kiritish",
    nameBtnLater: "⏭ Keyinroq",
    nameAskInput: "Ism va familiyangizni yozing (masalan: Aziz Karimov):",
    nameInvalid: "Iltimos, faqat harflardan iborat ism kiriting (masalan: Aziz Karimov)",
    namePreview: (f: string, l: string) => `Ism: <b>${f}</b>${l ? ` · Familiya: <b>${l}</b>` : ""} — to'g'rimi?`,
    nameBtnYes: "✅ Ha, saqlash",
    nameBtnRetry: "✏️ Qayta kiritish",
    nameSaved: (d: string) => `✅ Saqlandi! Endi reytingda shunday ko'rinasiz: <b>${d}</b> ⭐`,
    nameConfirmedOk: "✅ Rahmat! Ismingiz tasdiqlandi.",
    nameLater: "OK, keyinroq so'rayman 👍",
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
    levelNames: ["Новичок", "Ученик", "Знаток", "Мастер", "Магистр"],
    statsLevel: (emoji: string, name: string, score: number, barStr: string, isMax: boolean, nextEmoji: string, nextName: string) => `⭐ Уровень: ${emoji} <b>${name}</b> (${score}/100)\n${barStr}${isMax ? " — высший уровень! 🏆" : ` → ${nextEmoji} ${nextName}`}`,
    statsLessons: (d: number, tot: number, watch: string) => `📚 Уроки: <b>${d}/${tot}</b>${watch ? ` · ${watch} всего` : ""}\n${bar(d, tot)}`,
    statsStreak: (cur: number, best: number, barStr: string, next: number | null, atMilestone: boolean) => `🔥 <b>${cur} дн. подряд</b>${atMilestone ? " 🎉 новый рубеж!" : ""} · рекорд: ${best}\n${barStr}${next ? ` → ${next} дн.` : " 🏆 максимум!"}`,
    statsStreakNone: "🔥 Стрик: ещё не начат",
    statsStreakBroken: (best: number) => `🔥 Стрик прерван — ваш рекорд: <b>${best}</b> дн. Начните новый сегодня! 💪`,
    statsFreezes: (n: number) => `❄️ Защита стрика: <b>${n}</b> заморозки (пропущенный день не обнулит стрик)`,
    statsDailyGoal: (d: number, tar: number, ok: boolean) => `🎯 Цель на сегодня: <b>${d}/${tar}</b>${ok ? " ✅" : ""}\n${bar(d, tar)}`,
    statsHomework: (sub: number, totalLeaves: number, scored: number) => `📝 Домашка: <b>${sub}/${totalLeaves}</b>${scored ? ` (${scored} оценено)` : ""}\n${bar(sub, totalLeaves)}`,
    statsHomeworkPoints: (earned: number, maxTotal: number) => `📈 Баллы за задания: <b>${earned}/${maxTotal}</b>`,
    statsHomeworkNone: "📝 Домашка: ещё не сдавали",
    statsRanking: (r: number, tot: number, sc: number) => `🏆 Рейтинг: <b>${r} место</b> / ${tot} студентов`,
    statsRankingNone: "🏆 Рейтинг: пока не учтён (нужна активность — посмотрите хотя бы 1 урок)",
    statsGroupTitle: "🏆 <b>Рейтинг группы</b>",
    statsGroupRow: (rankLabel: string, name: string, score: number) => `${rankLabel} ${name} — ${score}`,
    statsGroupRowMe: (rankLabel: string, score: number) => `<b>${rankLabel} 👉 Вы — ${score}</b>`,
    statsGroupSummary: (rank: number, total: number, gap: string) => `📊 Ваше место в группе: <b>${rank}/${total}</b>${gap}`,
    statsStar: (name: string) => `⭐ Звезда недели: <b>${name}</b>`,
    statsStarMe: "⭐ <b>На этой неделе вы — звезда группы!</b> 🎉",
    statsGroupGap: (nextRank: number, gap: number) => ` · до ${nextRank}-го места ${gap} б.`,
    statsBadges: (e: number, tot: number) => `🏅 Значки: <b>${e}/${tot}</b>`,
    statsBadgesShowcase: (icons: string, earned: number, total: number) => `🏅 Значки: <b>${earned}/${total}</b>${icons ? `\n${icons}` : ""}`,
    statsNextBadge: (name: string, desc: string) => `🔒 Следующий значок: <b>${name}</b>${desc ? ` — ${desc}` : ""}`,
    statsBadgesAllDone: "🏅 Все значки собраны! 🎉",
    statsCta: (met: boolean) => met ? `✨ Отлично! Цель на сегодня выполнена — стрик сохранён! 🔥` : `👉 Посмотрите 1 урок сегодня — сохраните стрик и приблизьтесь к новому уровню!`,
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
    tKbSwitchGroup: "🔄 Сменить группу",
    tKbHomework: "📝 Задания",
    tKbGrade: "📝 Оценить",
    tKbGraded: "👥 Студенты",
    rosterTitle: "👥 <b>Студенты</b>\nВыберите студента:",
    rosterEmpty: "В группе нет студентов.",
    rosterStudentRow: (name: string, n: number) => `${name} · ${n}`,
    studentModulesTitle: (name: string) => `👤 <b>${csvEscapeHtml(name)}</b>\n\nСдачи по модулям:`,
    studentModulesEmpty: "Студент пока ничего не сдавал.",
    moduleRowBtn: (mn: number, count: number, scores: string) => `📦 Модуль ${mn} — сдано ${count} · ${scores}`,
    backToRoster: "↩️ К списку студентов",
    scorePending: "⏳",
    thmTitle: "📝 <b>Задания по модулям</b>\nВыберите модуль:",
    thmEmpty: "К вам пока не прикреплён курс или группа.",
    thmModuleRow: (pos: number, title: string, sub: number, total: number) =>
      `📦 Модуль ${pos} · ${title} — ✅ ${sub}/${total}`.slice(0, 60),
    thmSubmittedTitle: (pos: number, title: string) =>
      `✅ <b>Модуль ${pos} — ${csvEscapeHtml(title)}</b>\nСдали:`,
    thmMissingTitle: (pos: number, title: string) =>
      `❌ <b>Модуль ${pos} — ${csvEscapeHtml(title)}</b>\nНе сдали:`,
    thmNoneSubmitted: "Никто не сдал.",
    thmNoneMissing: "🎉 Все сдали.",
    thmBackToList: "↩️ К списку модулей",
    thmStudentLine: (handle: string, name: string) =>
      `• ${handle ? `@${handle}` : ""}${handle && name ? ` (${name})` : name}`.trim(),
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
    tPickGroup: "📚 Для какой группы?",
    tActiveGroup: (n: string) => `📌 Активная группа: <b>${csvEscapeHtml(n)}</b>\n<i>Сменить: /guruh</i>`,
    tGroupSwitched: (n: string) => `✅ Активная группа: <b>${csvEscapeHtml(n)}</b>`,
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
    gradeOpenSubmissionBtn: (tn: number) => `📌 Перейти к посту З${tn}`,
    gradeOpenSubmissionPostBtn: "📌 Перейти к сданному посту",
    gradeBackList: "↩️ К списку студентов",
    gradeBackHome: "🏠 Главное меню",
    gradeNextPage: "⏭ Следующие 10",
    gradePrevPage: "⏮ Предыдущие 10",
    gradeNoTopic: "Топик для этого модуля не настроен.",
    btnSiteDetail: "📖 Подробнее на сайте",
    btnTopicGo: (n: number) => `📌 Топик модуля ${n}`,
    hwModuleHeader: (n: number, title: string, taskCount: number) => `📚 <b>Модуль ${n} — ${csvEscapeHtml(title)}</b> (${taskCount})`,
    hwTaskScored: (tn: number, sc: number, mx: number, fb: string) => `   ✅ З${tn}: ${sc}/${mx}${fb ? `\n      💬 ${csvEscapeHtml(fb)}` : ""}`,
    hwTaskResub: (tn: number, sc: number, mx: number) => `   🔄 З${tn}: ${sc}/${mx} — отправлено заново, ждёт новой оценки`,
    hwTaskUnscored: (tn: number) => `   ⏳ З${tn}: ещё не оценено`,
    hwTaskSubmitted: (tn: number) => `   📤 З${tn}: сдано, ждёт оценки`,
    hwTaskNotStarted: (tn: number) => `   📝 З${tn}: не начато`,
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
    hwResubAsk: (sc: number, mx: number, fb: string) =>
      `📊 Ваш предыдущий результат: <b>${sc}/${mx}</b>${fb ? `\nКомментарий: "${csvEscapeHtml(fb)}"` : ""}\n\nХотите отправить заново?`,
    hwResubYes: "✅ Да, отправить заново",
    hwResubNo: "❌ Нет",
    hwResubCancelled: "OK 👍 Прежний результат сохранится.",
    hwResubError: "❌ Не удалось начать пересдачу. Попробуйте позже.",
    hwReceived: (mn: number, tn: number) =>
      `✅ Задание принято · Модуль ${mn} · З${tn}\nКак только преподаватель оценит — пришлю результат.`,
    hwTeacherNotify: (name: string, mn: number, tn: number, title: string) =>
      `🆕 <b>Новая сдача</b>\n👤 ${csvEscapeHtml(name)}\n📚 Модуль ${mn} · З${tn} — ${csvEscapeHtml(title)}`,
    hwTeacherBtnFile: "📂 Открыть файл",
    hwTeacherBtnGrade: "🎯 Оценить сейчас",
    namePrompt: (cur: string) => `👤 В рейтинге ваше имя выглядит так: <b>${cur}</b>\nПодтвердите, чтобы оно отображалось правильно:`,
    nameBtnOk: "✅ Имя верное",
    nameBtnEdit: "✏️ Ввести имя",
    nameBtnLater: "⏭ Позже",
    nameAskInput: "Напишите имя и фамилию (например: Азиз Каримов):",
    nameInvalid: "Пожалуйста, введите имя только из букв (например: Азиз Каримов)",
    namePreview: (f: string, l: string) => `Имя: <b>${f}</b>${l ? ` · Фамилия: <b>${l}</b>` : ""} — верно?`,
    nameBtnYes: "✅ Да, сохранить",
    nameBtnRetry: "✏️ Ввести заново",
    nameSaved: (d: string) => `✅ Сохранено! Теперь в рейтинге вы выглядите так: <b>${d}</b> ⭐`,
    nameConfirmedOk: "✅ Спасибо! Ваше имя подтверждено.",
    nameLater: "Хорошо, спрошу позже 👍",
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
    levelNames: ["Beginner", "Learner", "Scholar", "Expert", "Master"],
    statsLevel: (emoji: string, name: string, score: number, barStr: string, isMax: boolean, nextEmoji: string, nextName: string) => `⭐ Level: ${emoji} <b>${name}</b> (${score}/100)\n${barStr}${isMax ? " — top level! 🏆" : ` → ${nextEmoji} ${nextName}`}`,
    statsLessons: (d: number, tot: number, watch: string) => `📚 Lessons: <b>${d}/${tot}</b>${watch ? ` · ${watch} total` : ""}\n${bar(d, tot)}`,
    statsStreak: (cur: number, best: number, barStr: string, next: number | null, atMilestone: boolean) => `🔥 <b>${cur}-day streak</b>${atMilestone ? " 🎉 milestone!" : ""} · best: ${best}\n${barStr}${next ? ` → ${next} days` : " 🏆 maxed!"}`,
    statsStreakNone: "🔥 Streak: not started yet",
    statsStreakBroken: (best: number) => `🔥 Streak broken — your record: <b>${best}</b> days. Start a new one today! 💪`,
    statsFreezes: (n: number) => `❄️ Streak protection: <b>${n}</b> freezes (a missed day won't reset your streak)`,
    statsDailyGoal: (d: number, tar: number, ok: boolean) => `🎯 Today's goal: <b>${d}/${tar}</b>${ok ? " ✅" : ""}\n${bar(d, tar)}`,
    statsHomework: (sub: number, totalLeaves: number, scored: number) => `📝 Homework: <b>${sub}/${totalLeaves}</b>${scored ? ` (${scored} graded)` : ""}\n${bar(sub, totalLeaves)}`,
    statsHomeworkPoints: (earned: number, maxTotal: number) => `📈 Homework points: <b>${earned}/${maxTotal}</b>`,
    statsHomeworkNone: "📝 Homework: nothing submitted yet",
    statsRanking: (r: number, tot: number, sc: number) => `🏆 Ranking: <b>#${r}</b> of ${tot} students`,
    statsRankingNone: "🏆 Ranking: not ranked yet (need activity — watch at least 1 lesson)",
    statsGroupTitle: "🏆 <b>Group ranking</b>",
    statsGroupRow: (rankLabel: string, name: string, score: number) => `${rankLabel} ${name} — ${score}`,
    statsGroupRowMe: (rankLabel: string, score: number) => `<b>${rankLabel} 👉 You — ${score}</b>`,
    statsGroupSummary: (rank: number, total: number, gap: string) => `📊 Your group rank: <b>${rank}/${total}</b>${gap}`,
    statsStar: (name: string) => `⭐ Star of the week: <b>${name}</b>`,
    statsStarMe: "⭐ <b>You're this week's group star!</b> 🎉",
    statsGroupGap: (nextRank: number, gap: number) => ` · ${gap} pts to #${nextRank}`,
    statsBadges: (e: number, tot: number) => `🏅 Badges: <b>${e}/${tot}</b>`,
    statsBadgesShowcase: (icons: string, earned: number, total: number) => `🏅 Badges: <b>${earned}/${total}</b>${icons ? `\n${icons}` : ""}`,
    statsNextBadge: (name: string, desc: string) => `🔒 Next badge: <b>${name}</b>${desc ? ` — ${desc}` : ""}`,
    statsBadgesAllDone: "🏅 All badges collected! 🎉",
    statsCta: (met: boolean) => met ? `✨ Great! You hit today's goal — streak kept! 🔥` : `👉 Watch 1 lesson today — keep your streak and get closer to the next level!`,
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
    tKbSwitchGroup: "🔄 Switch group",
    tKbHomework: "📝 Homework",
    tKbGrade: "📝 Grade",
    tKbGraded: "👥 Students",
    rosterTitle: "👥 <b>Students</b>\nPick a student:",
    rosterEmpty: "No students in this group.",
    rosterStudentRow: (name: string, n: number) => `${name} · ${n}`,
    studentModulesTitle: (name: string) => `👤 <b>${csvEscapeHtml(name)}</b>\n\nSubmissions by module:`,
    studentModulesEmpty: "This student hasn't submitted anything yet.",
    moduleRowBtn: (mn: number, count: number, scores: string) => `📦 Module ${mn} — ${count} submitted · ${scores}`,
    backToRoster: "↩️ Back to students",
    scorePending: "⏳",
    thmTitle: "📝 <b>Homework by module</b>\nPick a module:",
    thmEmpty: "No course or group is assigned to you yet.",
    thmModuleRow: (pos: number, title: string, sub: number, total: number) =>
      `📦 Module ${pos} · ${title} — ✅ ${sub}/${total}`.slice(0, 60),
    thmSubmittedTitle: (pos: number, title: string) =>
      `✅ <b>Module ${pos} — ${csvEscapeHtml(title)}</b>\nSubmitted:`,
    thmMissingTitle: (pos: number, title: string) =>
      `❌ <b>Module ${pos} — ${csvEscapeHtml(title)}</b>\nDid not submit:`,
    thmNoneSubmitted: "Nobody submitted yet.",
    thmNoneMissing: "🎉 Everyone submitted.",
    thmBackToList: "↩️ Back to modules",
    thmStudentLine: (handle: string, name: string) =>
      `• ${handle ? `@${handle}` : ""}${handle && name ? ` (${name})` : name}`.trim(),
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
    tPickGroup: "📚 For which group?",
    tActiveGroup: (n: string) => `📌 Active group: <b>${csvEscapeHtml(n)}</b>\n<i>Switch: /guruh</i>`,
    tGroupSwitched: (n: string) => `✅ Active group: <b>${csvEscapeHtml(n)}</b>`,
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
    gradeOpenSubmissionBtn: (tn: number) => `📌 Open T${tn} post`,
    gradeOpenSubmissionPostBtn: "📌 Open submitted post",
    gradeBackList: "↩️ Back to students",
    gradeBackHome: "🏠 Main menu",
    gradeNextPage: "⏭ Next 10",
    gradePrevPage: "⏮ Previous 10",
    gradeNoTopic: "Topic not configured for this module.",
    btnSiteDetail: "📖 Open on site",
    btnTopicGo: (n: number) => `📌 Module ${n} topic`,
    hwModuleHeader: (n: number, title: string, taskCount: number) => `📚 <b>Module ${n} — ${csvEscapeHtml(title)}</b> (${taskCount})`,
    hwTaskScored: (tn: number, sc: number, mx: number, fb: string) => `   ✅ T${tn}: ${sc}/${mx}${fb ? `\n      💬 ${csvEscapeHtml(fb)}` : ""}`,
    hwTaskResub: (tn: number, sc: number, mx: number) => `   🔄 T${tn}: ${sc}/${mx} — resubmitted, awaiting new score`,
    hwTaskUnscored: (tn: number) => `   ⏳ T${tn}: not graded yet`,
    hwTaskSubmitted: (tn: number) => `   📤 T${tn}: submitted, awaiting score`,
    hwTaskNotStarted: (tn: number) => `   📝 T${tn}: not started`,
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
    hwResubAsk: (sc: number, mx: number, fb: string) =>
      `📊 Your previous result: <b>${sc}/${mx}</b>${fb ? `\nFeedback: "${csvEscapeHtml(fb)}"` : ""}\n\nDo you want to resubmit?`,
    hwResubYes: "✅ Yes, resubmit",
    hwResubNo: "❌ No",
    hwResubCancelled: "OK 👍 Your previous score is kept.",
    hwResubError: "❌ Could not start resubmission. Please try again later.",
    hwReceived: (mn: number, tn: number) =>
      `✅ Submission received · Module ${mn} · T${tn}\nYou'll get the result once your teacher grades it.`,
    hwTeacherNotify: (name: string, mn: number, tn: number, title: string) =>
      `🆕 <b>New submission</b>\n👤 ${csvEscapeHtml(name)}\n📚 Module ${mn} · T${tn} — ${csvEscapeHtml(title)}`,
    hwTeacherBtnFile: "📂 Open file",
    hwTeacherBtnGrade: "🎯 Grade now",
    namePrompt: (cur: string) => `👤 Your name appears in the rating as: <b>${cur}</b>\nConfirm so it displays correctly:`,
    nameBtnOk: "✅ My name is correct",
    nameBtnEdit: "✏️ Enter my name",
    nameBtnLater: "⏭ Later",
    nameAskInput: "Type your first and last name (e.g.: Aziz Karimov):",
    nameInvalid: "Please enter a name with letters only (e.g.: Aziz Karimov)",
    namePreview: (f: string, l: string) => `First name: <b>${f}</b>${l ? ` · Last name: <b>${l}</b>` : ""} — correct?`,
    nameBtnYes: "✅ Yes, save",
    nameBtnRetry: "✏️ Re-enter",
    nameSaved: (d: string) => `✅ Saved! You now appear in the rating as: <b>${d}</b> ⭐`,
    nameConfirmedOk: "✅ Thank you! Your name is confirmed.",
    nameLater: "OK, I'll ask later 👍",
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

// Telegram caps single sendMessage at 4096 chars. Split on line/word boundaries
// so long teacher feedback (>4096) is delivered in full instead of failing or
// being truncated. The reply_markup is attached only to the LAST chunk so the
// inline buttons stay with the final message the user sees.
async function sendLongMessage(chatId: number, text: string, reply_markup?: unknown) {
  const MAX = 3900; // leave headroom for HTML entities + parse_mode safety
  if (text.length <= MAX) return sendMessage(chatId, text, reply_markup);
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX) {
    let cut = remaining.lastIndexOf("\n", MAX);
    if (cut < MAX * 0.5) cut = remaining.lastIndexOf(" ", MAX);
    if (cut < MAX * 0.5) cut = MAX;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^[\n ]+/, "");
  }
  if (remaining.length) chunks.push(remaining);
  let last: any;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    last = await sendMessage(chatId, chunks[i], isLast ? reply_markup : undefined);
  }
  return last;
}

// ===== Profile cards (student + teacher) — spec v1.1 Phase 1 =====
// Localized strings kept separate from T so the giant T literal stays untouched.
const PROF_T = {
  uz: {
    kbProfil: "👤 Profil",
    profGroup: "Guruh", profTeacher: "Ustoz",
    profStreak: "Streak", profRecord: "rekord", profModules: "Modullar", profLessons: "Darslar",
    profHomework: "Vazifalar", profAvg: "o'rt.", profRank: "Guruhda",
    profNextLevel: (need: number, lvl: number) => `${lvl}-darajagacha ${need} XP qoldi`,
    btnProfStats: "📊 Statistika", btnProfBadges: "🏆 Yutuqlarim",
    btnProfGroup: "👥 Guruh reytingi", btnProfOpen: "👤 Profilni ochish",
    profOpenHint: "Statistika, yutuqlar, guruh reytingi va vazifalaringiz — barchasi profilingizda 👇",
    profGroupTitle: (g: string) => `👥 <b>${g} reytingi</b>`,
    profYou: "Siz", profToFirst: (xp: number) => `Birinchi o'ringa ${xp} XP qoldi ↑`,
    profNoGroup: "Siz hali guruhga qo'shilmagansiz.",
    badgesTitle: "🏆 <b>Yutuqlarim</b>", badgesNone: "Hali nishonlar yo'q — birinchi darsni tugatib boshlang! 🚀",
    badgesLocked: (n: number) => `🔒 Yana ${n} ta nishon sizni kutmoqda`,
    tProfTitle: "🧑‍🏫 <b>Ustoz profili</b>",
    tGroups: "Guruhlar", tStudents: "Talabalar", tGraded: "Baholangan", tAvg: "o'rt. baho",
    tMembers: "A'zolar", tActive: "Faol (7 kun)", tCompletion: "Tugallanish", tPending: "Kutilmoqda",
    tTop: "TOP talabalar", tNoStudents: "Guruhda talabalar yo'q", tNoGroups: "Sizga hali guruh biriktirilmagan.",
    tSwitchHint: "Boshqa guruhga o'tish uchun tugmani bosing 👇",
  },
  ru: {
    kbProfil: "👤 Профиль",
    profGroup: "Группа", profTeacher: "Устоз",
    profStreak: "Стрик", profRecord: "рекорд", profModules: "Модули", profLessons: "Уроки",
    profHomework: "Задания", profAvg: "ср.", profRank: "В группе",
    profNextLevel: (need: number, lvl: number) => `До уровня ${lvl}: ${need} XP`,
    btnProfStats: "📊 Статистика", btnProfBadges: "🏆 Достижения",
    btnProfGroup: "👥 Рейтинг группы", btnProfOpen: "👤 Открыть профиль",
    profOpenHint: "Статистика, достижения, рейтинг группы и задания — всё в вашем профиле 👇",
    profGroupTitle: (g: string) => `👥 <b>Рейтинг ${g}</b>`,
    profYou: "Вы", profToFirst: (xp: number) => `До 1-го места ${xp} XP ↑`,
    profNoGroup: "Вы ещё не добавлены в группу.",
    badgesTitle: "🏆 <b>Достижения</b>", badgesNone: "Пока нет значков — завершите первый урок! 🚀",
    badgesLocked: (n: number) => `🔒 Ещё ${n} значков ждут вас`,
    tProfTitle: "🧑‍🏫 <b>Профиль устоза</b>",
    tGroups: "Группы", tStudents: "Студенты", tGraded: "Проверено", tAvg: "ср. балл",
    tMembers: "Участники", tActive: "Активны (7 дн.)", tCompletion: "Завершение", tPending: "Ожидают",
    tTop: "ТОП студенты", tNoStudents: "В группе нет студентов", tNoGroups: "Вам ещё не назначены группы.",
    tSwitchHint: "Нажмите кнопку, чтобы переключить группу 👇",
  },
  en: {
    kbProfil: "👤 Profile",
    profGroup: "Group", profTeacher: "Teacher",
    profStreak: "Streak", profRecord: "best", profModules: "Modules", profLessons: "Lessons",
    profHomework: "Homework", profAvg: "avg", profRank: "In group",
    profNextLevel: (need: number, lvl: number) => `${need} XP to level ${lvl}`,
    btnProfStats: "📊 Statistics", btnProfBadges: "🏆 Achievements",
    btnProfGroup: "👥 Group rating", btnProfOpen: "👤 Open my profile",
    profOpenHint: "Statistics, achievements, group rating and homework — all in your profile 👇",
    profGroupTitle: (g: string) => `👥 <b>${g} rating</b>`,
    profYou: "You", profToFirst: (xp: number) => `${xp} XP to reach #1 ↑`,
    profNoGroup: "You haven't been added to a group yet.",
    badgesTitle: "🏆 <b>Achievements</b>", badgesNone: "No badges yet — finish your first lesson! 🚀",
    badgesLocked: (n: number) => `🔒 ${n} more badges are waiting for you`,
    tProfTitle: "🧑‍🏫 <b>Teacher profile</b>",
    tGroups: "Groups", tStudents: "Students", tGraded: "Graded", tAvg: "avg score",
    tMembers: "Members", tActive: "Active (7d)", tCompletion: "Completion", tPending: "Pending",
    tTop: "TOP students", tNoStudents: "No students in this group", tNoGroups: "No groups assigned to you yet.",
    tSwitchHint: "Tap a button to switch groups 👇",
  },
} as const;

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Student profile: compact greeting + ONE button that opens the web profile
 *  directly (all stats/badges/ratings live there — no in-chat button maze). */
async function buildProfileCard(admin: any, userId: string, locale: Locale): Promise<{ text: string; keyboard: any }> {
  const p = PROF_T[locale];
  const [{ data: prof }, statsRes] = await Promise.all([
    admin.from("profiles").select("name, last_name").eq("id", userId).maybeSingle(),
    admin.rpc("profile_stats", { uid: userId }),
  ]);
  const s: any = Array.isArray(statsRes.data) ? statsRes.data[0] : statsRes.data;
  const name = escHtml(`${prof?.name || ""}`.trim() || "Talaba");

  const bits: string[] = [`L${s?.level ?? 1} ⚡${s?.total_xp ?? 0} XP`];
  if ((s?.current_streak ?? 0) > 0) bits.push(`${s.current_streak}🔥`);
  if (s?.group_rank && s?.group_size) bits.push(`🏆 #${s.group_rank}/${s.group_size}`);

  const text = `👤 <b>${name}</b> · ${bits.join(" · ")}\n\n${p.profOpenHint}`;
  const url = await createMagicLink(admin, userId, "login", "/profile");
  const keyboard = { inline_keyboard: [[{ text: p.btnProfOpen, url }]] };
  return { text, keyboard };
}

/** Badges list for the bot (earned + locked teaser). */
async function buildBadgesMessage(admin: any, userId: string, locale: Locale): Promise<string> {
  const p = PROF_T[locale];
  const lang = locale === "ru" ? "name_ru" : locale === "en" ? "name_en" : "name_uz";
  const [{ data: all }, { data: mine }] = await Promise.all([
    admin.from("badges").select(`id, icon, position, ${lang}`).order("position"),
    admin.from("user_badges").select("badge_id").eq("user_id", userId),
  ]);
  const earned = new Set(((mine || []) as any[]).map((r) => r.badge_id));
  const rows = (all || []) as any[];
  const got = rows.filter((b) => earned.has(b.id));
  const lines = [p.badgesTitle, ""];
  if (!got.length) {
    lines.push(p.badgesNone);
  } else {
    for (const b of got) lines.push(`${b.icon || "🏅"} ${escHtml(b[lang] || "")}`);
  }
  const lockedCount = rows.length - got.length;
  if (lockedCount > 0) lines.push("", p.badgesLocked(lockedCount));
  return lines.join("\n");
}

/** Group XP leaderboard for the bot. */
async function buildGroupBoardMessage(admin: any, userId: string, locale: Locale): Promise<string> {
  const p = PROF_T[locale];
  const { data: prof } = await admin.from("profiles").select("group_id").eq("id", userId).maybeSingle();
  if (!prof?.group_id) return p.profNoGroup;
  const [{ data: g }, boardRes] = await Promise.all([
    admin.from("groups").select("name").eq("id", prof.group_id).maybeSingle(),
    admin.rpc("group_leaderboard", { uid: userId, _limit: 10 }),
  ]);
  const rows = ((boardRes.data || []) as any[]);
  if (!rows.length) return p.profNoGroup;
  const lines = [p.profGroupTitle(escHtml(g?.name || "")), ""];
  const medal = (r: number) => (r === 1 ? "🥇" : r === 2 ? "🥈" : r === 3 ? "🥉" : ` ${r}.`);
  for (const r of rows) {
    const nm = r.is_me ? `<b>${escHtml(r.first_name)} (${p.profYou})</b>` : escHtml(`${r.first_name} ${r.last_initial ? r.last_initial + "." : ""}`.trim());
    lines.push(`${medal(r.rank)} ${nm} — ⚡${r.total_xp}${r.current_streak > 0 ? ` · ${r.current_streak}🔥` : ""}`);
  }
  const me = rows.find((r) => r.is_me);
  const top = rows[0];
  if (me && top && !top.is_me) lines.push("", p.profToFirst(Math.max(top.total_xp - me.total_xp, 0)));
  return lines.join("\n");
}

/** Teacher profile card with per-group stats and one-tap group switching. */
async function buildTeacherProfileCard(
  admin: any, teacherId: string, locale: Locale, groupId?: string | null,
): Promise<{ text: string; keyboard: any }> {
  const p = PROF_T[locale];
  const [{ data: prof }, statsRes, groupsRes] = await Promise.all([
    admin.from("profiles").select("name, last_name, bio, active_teacher_group_id").eq("id", teacherId).maybeSingle(),
    admin.rpc("teacher_profile_stats", { uid: teacherId }),
    admin.rpc("teacher_groups", { uid: teacherId }),
  ]);
  const s: any = Array.isArray(statsRes.data) ? statsRes.data[0] : statsRes.data;
  const groups = ((groupsRes.data || []) as any[]);
  const name = escHtml(`${prof?.name || ""} ${prof?.last_name || ""}`.trim() || "Ustoz");

  const lines: string[] = [];
  lines.push(p.tProfTitle);
  lines.push(`👤 <b>${name}</b>`);
  if (prof?.bio) lines.push(`<i>${escHtml(String(prof.bio))}</i>`);
  lines.push("");
  lines.push(`👥 ${p.tGroups}: <b>${s?.groups_count ?? 0}</b> · ${p.tStudents}: <b>${s?.students_total ?? 0}</b>`);
  lines.push(`✅ ${p.tGraded}: <b>${s?.graded_total ?? 0}</b>${s?.avg_score_given ? ` (${p.tAvg} ${s.avg_score_given}/10)` : ""}`);

  if (!groups.length) {
    lines.push("", p.tNoGroups);
    return { text: lines.join("\n"), keyboard: undefined };
  }

  const sel = groups.find((g) => g.group_id === (groupId || prof?.active_teacher_group_id)) || groups[0];
  lines.push("");
  lines.push(`📍 <b>${escHtml(sel.group_name)}</b>${sel.course_name ? ` · ${escHtml(sel.course_name)}` : ""}`);
  lines.push(`${p.tMembers}: <b>${sel.total_students}</b> · ${p.tActive}: <b>${sel.active_7d}</b>`);
  lines.push(`${p.tCompletion}: <b>${sel.avg_completion_pct}%</b> · ${p.tPending}: <b>${sel.pending_homework}</b>`);

  const { data: topData } = await admin.rpc("teacher_group_top", { uid: teacherId, _group_id: sel.group_id, _limit: 5 });
  const top = ((topData || []) as any[]);
  lines.push("", `🏆 ${p.tTop}:`);
  if (!top.length) {
    lines.push(p.tNoStudents);
  } else {
    const medal = (r: number) => (r === 1 ? "🥇" : r === 2 ? "🥈" : r === 3 ? "🥉" : ` ${r}.`);
    for (const st of top) {
      lines.push(`${medal(st.rank)} ${escHtml(`${st.first_name} ${st.last_initial ? st.last_initial + "." : ""}`.trim())} — ⚡${st.total_xp}${st.current_streak > 0 ? ` · ${st.current_streak}🔥` : ""}`);
    }
  }

  // One-tap group switching: a button per OTHER group re-renders this card in place.
  const others = groups.filter((g) => g.group_id !== sel.group_id);
  const keyboard = others.length
    ? { inline_keyboard: others.map((g) => [{ text: `👥 ${g.group_name}`, callback_data: `tprof:g:${g.group_id}` }]) }
    : undefined;
  if (others.length) lines.push("", p.tSwitchHint);
  return { text: lines.join("\n"), keyboard };
}

// ===== One-off migration broadcast (invoked via x-internal-secret, action=migration_broadcast) =====
const BCAST_T = {
  uz: {
    body: [
      "📢 <b>Muhim yangilik!</b>",
      "",
      "Platformamiz yangi manzilga ko'chdi: <b>aicreator.academy</b>",
      "",
      "Barcha darslaringiz, statistikangiz, vazifalaringiz va yutuqlaringiz <b>to'liq saqlangan</b> — hech narsa yo'qolmagan! ✅",
      "",
      "⚠️ Eski havolalar endi ishlamaydi. Quyidagi tugma orqali kiring va yangi 👤 Profil bo'limini ham ko'ring 👇",
      "",
      "<i>Agar pastdagi tugmalar yangilanmasa, /start ni bosing.</i>",
    ].join("\n"),
    cta: "Kirish va yangi profilingiz 👇",
    btnSite: "🌐 Saytga kirish", btnProfile: "👤 Profilim",
  },
  ru: {
    body: [
      "📢 <b>Важная новость!</b>",
      "",
      "Платформа переехала на новый адрес: <b>aicreator.academy</b>",
      "",
      "Все ваши уроки, статистика, задания и достижения <b>полностью сохранены</b> — ничего не потеряно! ✅",
      "",
      "⚠️ Старые ссылки больше не работают. Войдите по кнопке ниже и загляните в новый раздел 👤 Профиль 👇",
      "",
      "<i>Если кнопки внизу не обновились — нажмите /start.</i>",
    ].join("\n"),
    cta: "Вход и ваш новый профиль 👇",
    btnSite: "🌐 Открыть сайт", btnProfile: "👤 Мой профиль",
  },
  en: {
    body: [
      "📢 <b>Important update!</b>",
      "",
      "Our platform has moved to a new address: <b>aicreator.academy</b>",
      "",
      "All your lessons, statistics, homework and achievements are <b>fully preserved</b> — nothing is lost! ✅",
      "",
      "⚠️ Old links no longer work. Sign in with the button below and check out the new 👤 Profile 👇",
      "",
      "<i>If the buttons below didn't update, tap /start.</i>",
    ].join("\n"),
    cta: "Sign in & your new profile 👇",
    btnSite: "🌐 Open the site", btnProfile: "👤 My profile",
  },
} as const;

async function runMigrationBroadcast(admin: any, mode: "test" | "all") {
  // Register slash commands once (discoverability of /profil in the "/" menu).
  try {
    await tgApi("setMyCommands", {
      commands: [
        { command: "start", description: "Boshlash / Menyu" },
        { command: "profil", description: "👤 Profil va statistika" },
        { command: "davom", description: "📚 Darsni davom ettirish" },
        { command: "vazifalar", description: "📝 Uy vazifalarim" },
        { command: "til", description: "🌐 Til / Язык / Language" },
        { command: "yordam", description: "❓ Yordam" },
      ],
    });
  } catch (e) { console.error("setMyCommands failed", e); }

  // Targets: active, telegram-linked. Test mode → admins/superadmins only.
  const { data: profs } = await admin
    .from("profiles")
    .select("id, telegram_id, preferred_locale, status, archived_at")
    .not("telegram_id", "is", null)
    .eq("status", "active")
    .is("archived_at", null);
  let targets = (profs || []) as any[];
  if (mode === "test") {
    const { data: adminRoles } = await admin
      .from("user_roles").select("user_id").in("role", ["admin", "superadmin"]);
    const adminIds = new Set(((adminRoles || []) as any[]).map((r) => r.user_id));
    targets = targets.filter((p) => adminIds.has(p.id));
  }

  // Resumable: skip anyone already marked sent (dedup via notifications_log),
  // and process at most BATCH per invocation so the gateway's 150s idle
  // timeout can't kill a long run mid-flight. Caller re-invokes until remaining=0.
  const { data: sentRows } = await admin
    .from("notifications_log").select("user_id").eq("notification_type", "migration_broadcast");
  const already = new Set(((sentRows || []) as any[]).map((r) => r.user_id));
  const pending = targets.filter((p) => !already.has(p.id));
  const BATCH = 100;
  const batch = pending.slice(0, BATCH);

  let ok = 0, fail = 0;
  const failures: string[] = [];
  for (const p of batch) {
    try {
      const locale: Locale = normLocale(p.preferred_locale);
      const b = BCAST_T[locale];
      const persona = await getPersona(admin, p.id);
      // Msg 1: announcement carrying the NEW persistent keyboard (passive refresh).
      const r1 = await sendMessage(Number(p.telegram_id), b.body, keyboardFor(locale, persona));
      const j1 = await r1.json().catch(() => ({}));
      if (!j1?.ok) throw new Error(j1?.description || `sendMessage failed`);
      // Msg 2: personal login button + profile shortcut.
      const url = await createMagicLink(admin, p.id, "login", "/dashboard");
      await sendMessage(Number(p.telegram_id), b.cta, {
        inline_keyboard: [[{ text: b.btnSite, url }], [{ text: b.btnProfile, callback_data: "prof:card" }]],
      });
      await admin.from("notifications_log").insert({
        user_id: p.id, notification_type: "migration_broadcast",
        payload: { mode }, sent_at: new Date().toISOString(),
      });
      ok++;
    } catch (e) {
      fail++;
      if (failures.length < 8) failures.push(`${p.telegram_id}: ${e instanceof Error ? e.message : e}`);
    }
    await new Promise((r) => setTimeout(r, 40)); // ~25 msg-pairs/sec, under Telegram's cap
  }

  const report = {
    mode, targets: targets.length, batch: batch.length, ok, fail,
    remaining: Math.max(pending.length - batch.length, 0), failures, at: new Date().toISOString(),
  };
  try {
    await admin.from("app_settings").upsert(
      { key: `migration_broadcast_${mode}`, value: report }, { onConflict: "key" });
  } catch (_e) { /* best-effort */ }
  console.log("migration_broadcast", JSON.stringify(report));
  return report;
}

function getMainKeyboard(locale: Locale) {
  const t = T[locale];
  const p = PROF_T[locale];
  // 👤 Profil replaced 📊 Statistikam — all stats now live inside the profile
  // web app. The old kbStreak button (cached keyboards) still routes to /galaba.
  return {
    keyboard: [
      [{ text: t.kbDavom }],
      [{ text: p.kbProfil }, { text: t.kbHomework }],
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
      [{ text: t.tKbGrade }, { text: t.tKbHomework }],
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
      [{ text: t.tKbGrade }, { text: t.tKbHomework }],
      [{ text: t.tKbStats }, { text: t.tKbTop }],
      [{ text: t.tKbStudents }, { text: t.tKbInactive }],
      [{ text: t.tKbBroadcast }, { text: t.tKbSettings }],
      [{ text: t.tKbSwitchGroup }, { text: PROF_T[locale].kbProfil }],
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
    if (trimmed === PROF_T[loc].kbProfil) return "/profil";
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
    if (t.tKbSwitchGroup && trimmed === t.tKbSwitchGroup) return "/guruh";
    if (t.tKbGrade && trimmed === t.tKbGrade) return "/baholash";
    if (t.tKbHealth && trimmed === t.tKbHealth) return "/thealth";
    // "📝 Vazifalar" opens module-grouped homework view.
    if (t.tKbHomework && trimmed === t.tKbHomework) return "/modulvazifalar";
    // Back-compat: old "👥 Talabalar" label still routes to the student roster.
    if (t.tKbGraded && trimmed === t.tKbGraded) return "/baholar";
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
  // Reuse non-expired, unused link for same (user, purpose, target_path) — links live 7 days.
  try {
    let q = admin.from("telegram_magic_links")
      .select("token, expires_at, target_path")
      .eq("user_id", user_id).eq("purpose", purpose)
      .is("used_at", null)
      .order("created_at", { ascending: false }).limit(1);
    const { data: existing } = await q;
    const row = existing?.[0];
    if (row && new Date(row.expires_at).getTime() > Date.now() + 60_000 && (row.target_path || null) === (target_path || null)) {
      return `${SITE_URL}/auth/magic?t=${row.token}`;
    }
  } catch (_e) { /* fall through to insert */ }
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
  const { error } = await admin
    .from("telegram_magic_links")
    .insert({ token, user_id, purpose, target_path, expires_at: expiresAt });
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
    .select("id, name, last_name, telegram_username, telegram_id, telegram_onboarded_at, preferred_locale, group_id, status")
    .eq("telegram_id", tgId)
    .maybeSingle();
  return data;
}

async function findProfileByUsername(admin: any, username: string) {
  // Step 2 fallback: only match profiles WITHOUT a telegram_id yet (case-insensitive, strip leading @).
  const cleaned = (username || "").replace(/^@+/, "").toLowerCase();
  if (!cleaned) return null;
  const { data } = await admin
    .from("profiles")
    .select("id, name, last_name, telegram_username, telegram_id, telegram_onboarded_at, preferred_locale, group_id, status")
    .is("telegram_id", null)
    .ilike("telegram_username", cleaned)
    .order("updated_at", { ascending: false })
    .limit(2);
  if (!data || data.length === 0) return null;
  if (data.length > 1) {
    console.warn("[telegram-auth] multiple username-only profiles matched", { username: cleaned, count: data.length });
  }
  return data[0];
}

// v3.14.27: in-memory throttle for unregistered users (1 reply / 60s per telegram_id).
const UNREGISTERED_REPLY_TTL_MS = 60_000;
const unregisteredLastReplyAt = new Map<number, number>();

async function sendUnregisteredReply(
  admin: any,
  chatId: number,
  from: { id: number; username?: string; first_name?: string; language_code?: string } | null | undefined,
  localeOverride?: Locale,
) {
  const tgId = from?.id ?? chatId;
  console.log("[bot:unregistered]", { telegram_id: tgId, username: from?.username || null, first_name: from?.first_name || null });
  const now = Date.now();
  const last = unregisteredLastReplyAt.get(tgId) || 0;
  if (now - last < UNREGISTERED_REPLY_TTL_MS) return;
  unregisteredLastReplyAt.set(tgId, now);
  const locale: Locale = localeOverride || normLocale(from?.language_code);
  const enroll = await getEnrollmentSettings(admin, locale);
  await sendMessage(chatId, enroll.message, {
    inline_keyboard: [[{ text: enroll.buttonLabel, url: enroll.formUrl }]],
  });
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

// Resolve which course(s) "belong" to a student for stats purposes:
//   1. profile.group_id -> groups.course_id (preferred)
//   2. enrollments table
//   3. fallback to platform default course
async function getCourseIdsForUser(admin: any, userId: string): Promise<string[]> {
  try {
    // The bot runs service-role (bypasses RLS), so deactivation must be enforced
    // here: only PUBLISHED courses are ever in scope. A student in a deactivated
    // course's group keeps their enrollment (not kicked) but sees no lessons.
    const { data: prof } = await admin
      .from("profiles").select("group_id").eq("id", userId).maybeSingle();
    if (prof?.group_id) {
      const { data: g } = await admin
        .from("groups").select("course_id, courses(published)").eq("id", prof.group_id).maybeSingle();
      if (g?.course_id && (g as any).courses?.published) return [g.course_id];
      // group's course is deactivated → fall through to any other published enrollment
    }
    const { data: enr } = await admin
      .from("enrollments").select("course_id, courses!inner(published)").eq("user_id", userId).eq("courses.published", true);
    const ids = (enr || []).map((r: any) => r.course_id).filter(Boolean);
    if (ids.length) return Array.from(new Set(ids));
  } catch (_e) { /* fall through */ }
  const def = await getDefaultCourseId(admin);
  return def ? [def] : [];
}

// The single "current" course a student is studying (Architecture A: one course at a time).
// = their group's course, else first enrollment, else platform default. Use this instead of
// getDefaultCourseId() for all student-facing course content so a student enrolled in a
// duplicated course (e.g. "AI CREATORS 5.0") sees THEIR course, not the platform default.
async function getPrimaryCourseIdForUser(admin: any, userId: string): Promise<string | null> {
  const ids = await getCourseIdsForUser(admin, userId);
  return ids[0] ?? null;
}

async function resolveProfileForTelegramUser(
  admin: any,
  tgId: number,
  tgUsernameRaw: string | null | undefined,
  source: "bot" | "web" = "bot",
) {
  const tgUsername = (tgUsernameRaw || "").replace(/^@+/, "").toLowerCase();
  let profile = await findProfileByTelegramId(admin, tgId);
  let matchedBy: "telegram_id" | "telegram_username" = "telegram_id";
  if (!profile && tgUsername) {
    profile = await findProfileByUsername(admin, tgUsername);
    if (profile) matchedBy = "telegram_username";
  }
  if (!profile) return null;
  // v3.14.27: archived profiles are treated as unregistered for the bot.
  if (profile.status && profile.status !== "active") return null;
  if (!profile.telegram_id) {
    await admin
      .from("profiles")
      .update({ telegram_id: tgId, updated_at: new Date().toISOString() })
      .eq("id", profile.id)
      .is("telegram_id", null);
    profile.telegram_id = tgId;
    console.log("[telegram-auth] backfilled telegram_id", { profile_id: profile.id, telegram_id: tgId, matched_by: matchedBy, source });
    try {
      await admin.from("audit_log").insert({
        actor_user_id: profile.id,
        target_user_id: profile.id,
        action: "profile_telegram_id_backfilled",
        new_value: { profile_id: profile.id, telegram_id: tgId, telegram_username: tgUsername, source },
      });
    } catch (_e) { /* ignore */ }
  }
  if (tgUsername && (profile.telegram_username || "").toLowerCase() !== tgUsername) {
    await admin.from("profiles").update({ telegram_username: tgUsername }).eq("id", profile.id);
    profile.telegram_username = tgUsername;
  }
  return profile;
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

// --- Tier access helpers (Phase 2) -------------------------------------------
// A student's module_limit for a course: NULL = unlimited (every AI CREATORS 4.0
// student, plus any VIP/Full tier) → callers skip ALL filtering, so behavior is
// byte-identical for the 489. A number N = only the first N modules (by position)
// are accessible.
async function moduleLimitFor(admin: any, userId: string, courseId: string): Promise<number | null> {
  if (!userId || !courseId) return null;
  const { data } = await admin
    .from("enrollments")
    .select("course_tiers(module_limit)")
    .eq("user_id", userId).eq("course_id", courseId)
    .maybeSingle();
  const lim = (data as any)?.course_tiers?.module_limit;
  return typeof lim === "number" ? lim : null;
}

// Module IDs the student CANNOT access, across all their tiered enrollments.
// Empty for any student whose every enrollment is NULL-tier (the 489) → no filtering.
async function getBlockedModuleIds(admin: any, userId: string): Promise<Set<string>> {
  const blocked = new Set<string>();
  const { data: enrs } = await admin
    .from("enrollments")
    .select("course_id, course_tiers(module_limit)")
    .eq("user_id", userId);
  for (const e of (enrs || []) as any[]) {
    const lim = e?.course_tiers?.module_limit;
    if (typeof lim !== "number") continue; // unlimited → nothing blocked
    const { data: mods } = await admin
      .from("modules")
      .select("id")
      .eq("course_id", e.course_id)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });
    (mods || []).slice(lim).forEach((m: any) => blocked.add(m.id)); // beyond the cap
  }
  return blocked;
}

// True if this single module is beyond the student's tier (always false for NULL-tier).
async function isModuleBlocked(admin: any, userId: string, moduleId: string): Promise<boolean> {
  if (!moduleId) return false;
  const { data: m } = await admin.from("modules").select("course_id").eq("id", moduleId).maybeSingle();
  const courseId = (m as any)?.course_id;
  if (!courseId) return false;
  const limit = await moduleLimitFor(admin, userId, courseId);
  if (limit == null) return false; // unlimited → not blocked
  const { data: mods } = await admin
    .from("modules").select("id").eq("course_id", courseId)
    .order("position", { ascending: true }).order("created_at", { ascending: true });
  const accessible = new Set((mods || []).slice(0, limit).map((x: any) => x.id));
  return !accessible.has(moduleId);
}

const tierLockedMsg = (locale: Locale): string =>
  locale === "ru" ? "Этот модуль недоступен в вашем тарифе."
  : locale === "en" ? "This module is not included in your plan."
  : "Bu modul sizning tarifingizda mavjud emas.";

async function getNextIncompleteLesson(admin: any, userId: string, courseId: string) {
  // All published lessons in the course in order
  const { data: modulesRaw } = await admin
    .from("modules")
    .select("id, position")
    .eq("course_id", courseId)
    .order("position", { ascending: true });
  if (!modulesRaw?.length) return null;
  // Tier clamp (Phase 2): never recommend a lesson in a module past the student's cap.
  const limit = await moduleLimitFor(admin, userId, courseId);
  const modules = (limit == null) ? modulesRaw : modulesRaw.slice(0, limit);
  if (!modules.length) return null;
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
  const courseId = await getPrimaryCourseIdForUser(admin, userId);
  let pct = 0;
  if (courseId) {
    // Tier cap: only the modules the student can actually reach count toward %,
    // otherwise a tier-capped (Premium/VIP) student can never hit 100% and the
    // certificate stays unreachable. Modules ranked by position, first `limit`.
    const { data: modules } = await admin.from("modules").select("id")
      .eq("course_id", courseId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });
    let modList = (modules || []) as any[];
    const _limit = await moduleLimitFor(admin, userId, courseId);
    if (typeof _limit === "number") modList = modList.slice(0, _limit);
    const mids = modList.map((m: any) => m.id);
    let total = 0;
    let done = 0;
    if (mids.length) {
      // Published lesson ids for THIS course; progress is then scoped to them so the % is
      // for the student's own course (not blended across any other course they've touched).
      const { data: lessonRows } = await admin
        .from("lessons")
        .select("id")
        .in("module_id", mids)
        .eq("published", true);
      const lids = new Set((lessonRows || []).map((l: any) => l.id));
      total = lids.size;
      const { data: progress } = await admin
        .from("lesson_progress")
        .select("lesson_id, completed_at")
        .eq("user_id", userId);
      done = (progress || []).filter((p: any) => p.completed_at && lids.has(p.lesson_id)).length;
    }
    pct = total ? Math.round((done / total) * 100) : 0;
  }
  return {
    streak: streak?.current_streak || 0,
    weekMin: Math.round(weekSec / 60),
    pct,
  };
}

function fmtWatchDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  if (s < 60) return "";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Renders a 10-char progress bar like ██████░░░░ from a done/total fraction.
function bar(done: number, total: number, width = 10): string {
  const frac = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  const filled = Math.round(frac * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// Normalize a typed name: fold stylized unicode, keep letters/apostrophe/hyphen,
// Title Case, split into first + rest. Returns null if not a plausible name.
function normalizeNameInput(raw: string): { first: string; last: string } | null {
  const cleaned = (raw || "").normalize("NFKC")
    .replace(/[^\p{L}\p{M}'’\- ]/gu, " ")
    .replace(/\s+/g, " ").trim();
  if (cleaned.length < 2 || cleaned.length > 80) return null;
  const words = cleaned.split(" ").slice(0, 4);
  const tc = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  const first = tc(words[0]);
  if (first.replace(/[^\p{L}]/gu, "").length < 2) return null;
  const last = words.slice(1).map(tc).join(" ");
  return { first, last };
}



// Named levels mapped from the 0–100 activity score. Early bands are short so
// beginners level up fast (competence for the bottom 80%); the number always goes up.
const LEVELS = [
  { min: 0, emoji: "🌱" },
  { min: 10, emoji: "📗" },
  { min: 25, emoji: "📘" },
  { min: 45, emoji: "🎓" },
  { min: 70, emoji: "🏆" },
];

function levelInfo(score: number) {
  const s = Math.max(0, Math.min(100, Math.round(score || 0)));
  let i = 0;
  for (let k = 0; k < LEVELS.length; k++) if (s >= LEVELS[k].min) i = k;
  const isMax = i === LEVELS.length - 1;
  const floor = LEVELS[i].min;
  const ceil = isMax ? 100 : LEVELS[i + 1].min;
  return { i, isMax, emoji: LEVELS[i].emoji, score: s, into: s - floor, span: Math.max(1, ceil - floor), nextEmoji: isMax ? "" : LEVELS[i + 1].emoji };
}

// Streak milestones. Shows progress toward the next badge-worthy milestone and
// celebrates when the user is exactly on one (loss-aversion + accomplishment).
const STREAK_MILES = [3, 7, 14, 30, 60, 100];
function streakInfo(c: number) {
  const cur = Math.max(0, c || 0);
  const next = STREAK_MILES.find((m) => m > cur) ?? null;
  const prev = [...STREAK_MILES].reverse().find((m) => m <= cur) ?? 0;
  const atMilestone = STREAK_MILES.includes(cur) && cur > 0;
  return { cur, next, prev, atMilestone };
}

async function buildStatsMessage(admin: any, userId: string, locale: Locale): Promise<string> {
  const t = T[locale] as any;
  const lines: string[] = [t.statsTitle, ""];
  try {
    const courseIds = await getCourseIdsForUser(admin, userId);

    // Lessons total + completed (scoped to the student's course[s])
    let lessonIds: string[] = [];
    let moduleIds: string[] = [];
    if (courseIds.length) {
      const { data: ms } = await admin.from("modules").select("id").in("course_id", courseIds);
      moduleIds = (ms || []).map((m: any) => m.id);
      if (moduleIds.length) {
        const { data: ls } = await admin
          .from("lessons").select("id").in("module_id", moduleIds).eq("published", true);
        lessonIds = (ls || []).map((l: any) => l.id);
      }
    }
    const totalLessons = lessonIds.length;

    // Refresh leaderboard cache if older than 1 hour, so ranking line is current.
    try {
      const { data: lbAge } = await admin
        .from("leaderboard_cache").select("computed_at").order("computed_at", { ascending: false }).limit(1).maybeSingle();
      const ageMs = lbAge?.computed_at ? Date.now() - new Date(lbAge.computed_at).getTime() : Infinity;
      if (ageMs > 60 * 60 * 1000) {
        await admin.rpc("recalc_leaderboard");
      }
    } catch (_e) { /* best-effort */ }

    const [
      progressRes, streakRes, todayRes, hwAssignsRes, hwSubsRes,
      lbRes, totalStudentsRes, userBadgesRes, badgesAllRes, prefRes, watchRes,
    ] = await Promise.all([
      lessonIds.length
        ? admin.from("lesson_progress").select("lesson_id, completed_at").eq("user_id", userId).in("lesson_id", lessonIds).not("completed_at", "is", null)
        : Promise.resolve({ data: [] as any[] }),
      admin.from("streaks").select("current_streak, longest_streak, freezes_remaining").eq("user_id", userId).maybeSingle(),
      admin.from("lesson_progress").select("completed_at").eq("user_id", userId).gte("completed_at", new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent" }).format(new Date()) + "T00:00:00+05:00").not("completed_at", "is", null),
      moduleIds.length
        ? admin.from("homework_assignments").select("id, max_score, parent_id, is_active").eq("is_active", true).in("module_id", moduleIds)
        : Promise.resolve({ data: [] as any[] }),
      admin.from("homework_submissions").select("assignment_id, score, score_feedback, scored_at, previous_attempts").eq("user_id", userId),
      admin.from("leaderboard_cache").select("rank, score").eq("user_id", userId).maybeSingle(),
      admin.from("leaderboard_cache").select("user_id", { count: "exact", head: true }),
      admin.from("user_badges").select("badge_id").eq("user_id", userId),
      admin.from("badges").select("id, icon, name_uz, name_ru, name_en, description_uz, description_ru, description_en, position").order("position", { ascending: true }),
      admin.from("profiles").select("weekly_goal_lessons").eq("id", userId).maybeSingle(),
      admin.from("daily_watch_summary").select("total_seconds").eq("user_id", userId),
    ]);

    const lbForLevel = lbRes.data;
    if (lbForLevel && typeof lbForLevel.score === "number") {
      const lv = levelInfo(lbForLevel.score);
      const names = (t.levelNames || []) as string[];
      lines.push(t.statsLevel(lv.emoji, names[lv.i] || "", lv.score, bar(lv.into, lv.span), lv.isMax, lv.nextEmoji, lv.isMax ? "" : (names[lv.i + 1] || "")));
      lines.push("");
    }

    const completedLessons = (progressRes.data || []).length;
    const totalWatchSeconds = (watchRes.data || []).reduce((acc: number, r: any) => acc + Number(r.total_seconds || 0), 0);
    lines.push(t.statsLessons(completedLessons, totalLessons, fmtWatchDuration(totalWatchSeconds)));
    lines.push("");

    const sk = streakRes.data;
    if (sk && sk.current_streak && sk.current_streak > 0) {
      const si = streakInfo(sk.current_streak);
      const barStr = si.next ? bar(si.cur - si.prev, si.next - si.prev) : bar(1, 1);
      lines.push(t.statsStreak(si.cur, sk.longest_streak || 0, barStr, si.next, si.atMilestone));
      if (typeof sk.freezes_remaining === "number") lines.push(t.statsFreezes(sk.freezes_remaining));
    } else if (sk && (sk.longest_streak || 0) > 0) {
      // Streak broken but the student has a record — celebrate it and nudge a restart
      lines.push(t.statsStreakBroken(sk.longest_streak || 0));
      if (typeof sk.freezes_remaining === "number") lines.push(t.statsFreezes(sk.freezes_remaining));
    } else {
      lines.push(t.statsStreakNone);
    }
    lines.push("");

    const todayDone = (todayRes.data || []).length;
    const weeklyGoal = prefRes.data?.weekly_goal_lessons || 5;
    const dailyTarget = Math.max(1, Math.round(weeklyGoal / 7));
    lines.push(t.statsDailyGoal(todayDone, dailyTarget, todayDone >= dailyTarget));
    lines.push("");

    // Homework: leaves only, with effective grade (current score ?? latest previous_attempts.score).
    const allAssigns = (hwAssignsRes.data || []) as any[];
    const parentIdsWithChildren = new Set(allAssigns.filter((a) => a.parent_id).map((a) => a.parent_id));
    const leaves = allAssigns
      .filter((a) => a.is_active !== false && (a.parent_id || !parentIdsWithChildren.has(a.id)))
      .map((a) => ({ id: a.id, max_score: Number(a.max_score) || 0 }));
    const summary = summarizeHomework(effectiveLeafGrades(leaves, (hwSubsRes.data || []) as any[]));
    if (summary.totalLeaves === 0 || (summary.submittedCount === 0 && summary.scoredCount === 0)) {
      lines.push(t.statsHomeworkNone);
    } else {
      lines.push(t.statsHomework(summary.submittedCount, summary.totalLeaves, summary.scoredCount));
      if (summary.maxTotal > 0) {
        lines.push(t.statsHomeworkPoints(summary.earned, summary.maxTotal));
      }
    }
    lines.push("");

    let groupRows: any[] = [];
    try {
      const { data: gw } = await admin.rpc("leaderboard_group_window", { uid: userId, _around: 2 });
      groupRows = (gw || []) as any[];
    } catch (_e) { groupRows = []; }
    if (groupRows.length > 0) {
      const meRow = groupRows.find((r: any) => r.is_me);
      const total = meRow?.group_total || groupRows[0]?.group_total || groupRows.length;
      lines.push(t.statsGroupTitle);
      for (const r of groupRows) {
        const medal = r.group_rank === 1 ? "🥇" : r.group_rank === 2 ? "🥈" : r.group_rank === 3 ? "🥉" : `${r.group_rank}.`;
        const nm = `${r.first_name}${r.last_initial ? " " + r.last_initial + "." : ""}`;
        if (r.is_me) lines.push(t.statsGroupRowMe(medal, r.score));
        else lines.push(t.statsGroupRow(medal, nm, r.score));
      }
      let gapTxt = "";
      if (meRow) {
        const above = groupRows.find((r: any) => r.group_rank === meRow.group_rank - 1);
        if (above) gapTxt = t.statsGroupGap(above.group_rank, Math.max(0, above.score - meRow.score));
      }
      lines.push("");
      lines.push(t.statsGroupSummary(meRow?.group_rank || 0, total, gapTxt));
      try {
        const { data: starRows } = await admin.rpc("current_group_star", { uid: userId });
        const star = ((starRows || []) as any[])[0];
        if (star) {
          const sname = `${star.first_name}${star.last_initial ? " " + star.last_initial + "." : ""}`;
          lines.push(star.is_me ? t.statsStarMe : t.statsStar(sname));
        }
      } catch (_e) { /* best-effort */ }
    } else {
      const lb = lbRes.data;
      if (lb && lb.rank) lines.push(t.statsRanking(lb.rank, totalStudentsRes.count || 0, lb.score || 0));
      else lines.push(t.statsRankingNone);
    }
    lines.push("");

    const allBadges = (badgesAllRes.data || []) as any[];
    const earnedIds = new Set(((userBadgesRes.data || []) as any[]).map((r) => r.badge_id));
    const earnedBadges = allBadges.filter((b) => earnedIds.has(b.id));
    const lockedBadges = allBadges.filter((b) => !earnedIds.has(b.id));
    const earnedIcons = earnedBadges.map((b) => b.icon || "🏅").join(" ");
    lines.push(t.statsBadgesShowcase(earnedIcons, earnedBadges.length, allBadges.length));
    if (lockedBadges.length > 0) {
      const nb = lockedBadges[0];
      const nm = nb["name_" + locale] || nb.name_uz || "";
      const ds = nb["description_" + locale] || nb.description_uz || "";
      lines.push(t.statsNextBadge(nm, ds));
    } else {
      lines.push(t.statsBadgesAllDone);
    }
    lines.push("");
    lines.push(t.statsCta(todayDone >= dailyTarget));
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
    // Resolve the student's course scope FIRST (group's course, else enrollments).
    // Without this, the query returned every course's homework, so students in a
    // 2-course catalog saw each module's homework twice (one per course).
    const [profRes, courseIds] = await Promise.all([
      admin.from("profiles").select("group_id").eq("id", userId).maybeSingle(),
      getCourseIdsForUser(admin, userId),
    ]);
    const groupId = (profRes as any).data?.group_id || null;
    let assignsQuery = admin.from("homework_assignments")
      .select("id, title, max_score, task_number, sap_number, parent_id, module_id, is_active, modules!inner(id, title, position, course_id)")
      .eq("is_active", true)
      .order("task_number", { ascending: true })
      .order("sap_number", { ascending: true, nullsFirst: true });
    if (courseIds.length) assignsQuery = assignsQuery.in("modules.course_id", courseIds);
    const assignsRes = await assignsQuery;
    const allList = ((assignsRes as any).data || []) as any[];
    if (!allList.length) { lines.push(t.hwEmpty); return { text: lines.join("\n"), keyboard: null }; }
    // Compute leaves: a parent without children OR every SAP
    const parentIdsWithSap = new Set(allList.filter((a) => a.parent_id).map((a) => a.parent_id));
    // Tier filter (Phase 2): hide assignments in modules beyond the student's tier.
    // Empty set for every NULL-tier (4.0) student → unchanged.
    const blockedModules = await getBlockedModuleIds(admin, userId);
    const list = allList
      .filter((a) => a.parent_id || !parentIdsWithSap.has(a.id))
      .filter((a) => !blockedModules.has(a.module_id));
    // Map parent task_number for label rendering
    const parentTaskNum = new Map<string, number>();
    allList.filter((a) => !a.parent_id).forEach((p) => parentTaskNum.set(p.id, p.task_number || 1));
    list.sort((a, b) => (a.modules?.position ?? 0) - (b.modules?.position ?? 0)
      || (a.task_number ?? 1) - (b.task_number ?? 1)
      || ((a.sap_number ?? 0) - (b.sap_number ?? 0)));

    const aIds = list.map((a) => a.id);
    const moduleIds = Array.from(new Set(list.map((a) => a.module_id)));
    const [{ data: subs }, { data: topics }, { data: groupRow }] = await Promise.all([
      admin.from("homework_submissions").select("assignment_id, score, score_feedback, score_is_stale, previous_attempts").eq("user_id", userId).in("assignment_id", aIds),
      groupId
        ? admin.from("group_module_topics").select("module_id, telegram_topic_url").eq("group_id", groupId).in("module_id", moduleIds)
        : Promise.resolve({ data: [] }),
      groupId
        ? admin.from("groups").select("homework_topic_url").eq("id", groupId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const subMap = new Map((subs || []).map((s: any) => [s.assignment_id, s]));
    const sharedTopicUrl: string | null = (groupRow as any)?.homework_topic_url || null;
    const topicMap = new Map<string, string>();
    for (const tp of (topics || []) as any[]) {
      if (tp.telegram_topic_url) topicMap.set(tp.module_id, tp.telegram_topic_url);
    }
    if (sharedTopicUrl) {
      for (const mid of moduleIds) if (!topicMap.has(mid)) topicMap.set(mid, sharedTopicUrl);
    }


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
        const parentTn = a.parent_id ? (parentTaskNum.get(a.parent_id) || 1) : (a.task_number || 1);
        const tnLabel: any = a.parent_id ? `${parentTn}.S${a.sap_number ?? "?"}` : parentTn;
        const prevScore = (() => {
          const arr = Array.isArray(s?.previous_attempts) ? s.previous_attempts : [];
          for (let i = arr.length - 1; i >= 0; i--) {
            const v = Number(arr[i]?.score);
            if (Number.isFinite(v)) return v;
          }
          return null;
        })();
        if (s && s.score != null) {
          lines.push(t.hwTaskScored(tnLabel, s.score, a.max_score || 10, s.score_feedback || ""));
        } else if (s && prevScore != null) {
          lines.push(t.hwTaskResub(tnLabel, prevScore, a.max_score || 10));
        } else if (s) {
          lines.push(t.hwTaskSubmitted(tnLabel));
        } else {
          lines.push(t.hwTaskNotStarted(tnLabel));
        }
      }
      const topic = topicMap.get(m.mid);
      const ungraded = m.arr.filter((a: any) => !(subMap.get(a.id) && (subMap.get(a.id) as any).score != null));
      if (groupId && !topic) {
        lines.push(t.hwTopicMissing);
      } else if (ungraded.length === 0) {
        lines.push(t.hwModuleAllDone);
      } else if (topic) {
        const u0 = ungraded[0];
        const u0Tn: any = u0.parent_id ? `${parentTaskNum.get(u0.parent_id) || 1}.S${u0.sap_number ?? "?"}` : (u0.task_number || 1);
        lines.push(t.hwSubmitHint(m.position + 1, u0Tn));
      }
      lines.push("");

      // One button per module (expands to per-leaf buttons via hw:mod callback).
      // Always shown when group+topic exist, so students can resubmit graded work.
      if (groupId && topic) {
        const allGraded = ungraded.length === 0;
        const label = allGraded
          ? `📝 ${m.position + 1}-MODUL VAZIFASI · qayta topshirish`
          : `📝 ${m.position + 1}-MODUL VAZIFASI`;
        buttons.push([{ text: label, callback_data: `hw:mod:${m.mid}` }]);
      }
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
  let matchedBy: "telegram_id" | "telegram_username" = "telegram_id";
  let profile = await findProfileByTelegramId(admin, tgId);
  if (!profile && tgUsername) {
    profile = await findProfileByUsername(admin, tgUsername);
    if (profile) matchedBy = "telegram_username";
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
    await admin.from("profiles").update({ telegram_id: tgId, updated_at: new Date().toISOString() }).eq("id", profile.id).is("telegram_id", null);
    profile.telegram_id = tgId;
    console.log("[telegram-auth] backfilled telegram_id", { profile_id: profile.id, telegram_id: tgId, matched_by: matchedBy, source: "bot" });
    try {
      await admin.from("audit_log").insert({
        actor_user_id: profile.id,
        target_user_id: profile.id,
        action: "profile_telegram_id_backfilled",
        new_value: { profile_id: profile.id, telegram_id: tgId, telegram_username: tgUsername, source: "bot" },
      });
    } catch (_e) { /* audit_log may not exist or insert blocked — ignore */ }
  } else if (matchedBy === "telegram_username") {
    console.log("[telegram-auth] matched_by username (no backfill needed)", { profile_id: profile.id, telegram_id: tgId });
  }

  // Refresh @username metadata for admin display only (does NOT affect login).
  if (tgUsername && (profile.telegram_username || "").toLowerCase() !== tgUsername) {
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
    const courseId = await getPrimaryCourseIdForUser(admin, profile.id);
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
  adminProfileId: string,
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
  const g = await handleGradingCommand(admin, chatId, /*graderId*/ adminProfileId, locale, cmd, true);
  if (g) return true;

  return false;
}

async function teacherGroups(admin: any, teacherId: string): Promise<{ id: string; name: string }[]> {
  const { data } = await admin.from("groups").select("id, name").eq("teacher_id", teacherId);
  return (data || []) as any[];
}

async function teacherStudentIds(admin: any, teacherId: string, groupId?: string | null): Promise<string[]> {
  if (groupId) {
    const { data } = await admin.from("profiles").select("id").eq("group_id", groupId);
    return ((data || []) as any[]).map((r) => r.id);
  }
  const groups = await teacherGroups(admin, teacherId);
  if (!groups.length) return [];
  const { data } = await admin.from("profiles").select("id").in("group_id", groups.map((g) => g.id));
  return ((data || []) as any[]).map((r) => r.id);
}

// Resolve which group the teacher is currently acting on.
// Returns: { mode: "none" } if zero groups, { mode: "ok", group } if 1 owned or active set,
// { mode: "pick", groups } when 2+ and no valid active group.
async function resolveActiveGroup(admin: any, teacherId: string): Promise<
  | { mode: "none" }
  | { mode: "ok"; group: { id: string; name: string }; groups: { id: string; name: string }[] }
  | { mode: "pick"; groups: { id: string; name: string }[] }
> {
  const groups = await teacherGroups(admin, teacherId);
  groups.sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
  if (!groups.length) return { mode: "none" };
  if (groups.length === 1) {
    const only = groups[0];
    await admin.from("profiles").update({ active_teacher_group_id: only.id }).eq("id", teacherId);
    return { mode: "ok", group: only, groups };
  }
  const { data: prof } = await admin.from("profiles").select("active_teacher_group_id").eq("id", teacherId).maybeSingle();
  const activeId = prof?.active_teacher_group_id;
  const found = activeId ? groups.find((g) => g.id === activeId) : null;
  if (found) return { mode: "ok", group: found, groups };
  return { mode: "pick", groups };
}

async function showGroupPicker(chatId: number, locale: Locale, action: string, groups: { id: string; name: string }[]) {
  const t = T[locale] as any;
  const buttons = groups.map((g) => [{ text: g.name, callback_data: `tg:pick:${action}:${g.id}` }]);
  await sendMessage(chatId, t.tPickGroup, { inline_keyboard: buttons });
}

// Map a teacher command to an "action" key used in tg:pick callback.
const TEACHER_ACTION_CMD: Record<string, string> = {
  tstats: "/tstats",
  thealth: "/thealth",
  thomework: "/thomework",
  tstudents: "/tstudents",
  tinactive: "/tinactive",
  tbroadcast: "/tbroadcast",
  baholash: "/baholash",
  baholar: "/baholar",
  ttop: "/ttop",
};

async function handleTeacherCommand(admin: any, chatId: number, teacherId: string, locale: Locale, cmd: string, explicitGroupId?: string): Promise<boolean> {
  const t = T[locale] as any;

  if (cmd === "/cancel") {
    await admin.from("bot_sessions").delete().eq("user_id", teacherId);
    await sendWithKeyboard(chatId, t.teacherCancelled, locale, false, "teacher");
    return true;
  }

  // Show / re-show group picker on demand
  if (cmd === "/guruh" || cmd === "/group") {
    const r = await resolveActiveGroup(admin, teacherId);
    if (r.mode === "none") { await sendWithKeyboard(chatId, t.teacherNoGroups, locale, false, "teacher"); return true; }
    const allGroups = r.mode === "ok" ? r.groups : r.groups;
    if (allGroups.length === 1) { await sendWithKeyboard(chatId, t.tActiveGroup(allGroups[0].name), locale, false, "teacher"); return true; }
    await showGroupPicker(chatId, locale, "switch", allGroups);
    return true;
  }

  // Group-scoped commands
  const scopedCmds = new Set(["/tstats", "/thealth", "/thomework", "/tstudents", "/tinactive", "/tbroadcast", "/baholash", "/baholar", "/ttop", "/modulvazifalar", "/modhomework"]);
  let activeGroup: { id: string; name: string } | null = null;
  if (scopedCmds.has(cmd)) {
    if (explicitGroupId) {
      const groups = await teacherGroups(admin, teacherId);
      const g = groups.find((x) => x.id === explicitGroupId);
      if (!g) { await sendWithKeyboard(chatId, t.teacherNoGroups, locale, false, "teacher"); return true; }
      await admin.from("profiles").update({ active_teacher_group_id: g.id }).eq("id", teacherId);
      activeGroup = g;
    } else {
      const r = await resolveActiveGroup(admin, teacherId);
      if (r.mode === "none") { await sendWithKeyboard(chatId, t.teacherNoGroups, locale, false, "teacher"); return true; }
      if (r.mode === "pick") {
        const action = cmd.replace(/^\//, "");
        await showGroupPicker(chatId, locale, action, r.groups);
        return true;
      }
      activeGroup = r.group;
    }
  }

  if (cmd === "/tstats") {
    const g = activeGroup!;
    try {
      const { data, error } = await admin.rpc("teacher_group_statistics", { p_group_id: g.id, p_caller_profile_id: teacherId });
      if (error) throw error;
      const s: any = data || {};
      const m = s.messages || {};
      const a = s.active_students || {};
      const total = s.total_students ?? 0;
      const groupName = csvEscapeHtml(s.group_name || g.name);
      const avg = s.avg_module_score;
      const avgLine = (avg === null || avg === undefined)
        ? "📊 O'rtacha modul bahosi: hali baholanmagan"
        : `📊 O'rtacha modul bahosi: ${avg}/10`;
      const text = [
        `📊 <b>${groupName}</b> · Statistika`,
        ``,
        `📨 <b>Xabarlar</b>`,
        `   Bugun:    ${m.today ?? 0}`,
        `   7 kun:   ${m.last_7d ?? 0}`,
        `   30 kun:  ${m.last_30d ?? 0}`,
        ``,
        `👥 <b>Eng aktiv talabalar</b>`,
        `   Bugun:   ${a.today ?? 0} / ${total}`,
        `   7 kun:   ${a.last_7d ?? 0} / ${total}`,
        `   30 kun: ${a.last_30d ?? 0} / ${total}`,
        ``,
        `📝 Baholanmagan vazifalar: ${s.pending_homework_count ?? 0} ta`,
        avgLine,
      ].join("\n");
      const groupsAll = await teacherGroups(admin, teacherId);
      const rows: any[] = [[
        { text: t.tKbGrade, callback_data: `tg:pick:baholash:${g.id}` },
        { text: t.tKbStudents, callback_data: `tg:pick:tstudents:${g.id}` },
      ]];
      if (groupsAll.length >= 2) {
        rows.push([{ text: "🔄 Guruhni o'zgartirish", callback_data: `tg:switch` }]);
      }
      await sendMessage(chatId, text, { inline_keyboard: rows });
    } catch (e: any) {
      console.error("[bot:/tstats] failed", e?.message || e);
      await sendWithKeyboard(chatId, `⚠️ Statistikani yuklashda xato: ${e?.message || e}`, locale, false, "teacher");
    }
    return true;
  }

  if (cmd === "/thealth") {
    const g = activeGroup!;
    try {
      let logged = 0;
      let total = 0;
      const { data: stats, error: rpcErr } = await admin.rpc("admin_group_login_stats", { p_caller_profile_id: teacherId });
      if (rpcErr) throw rpcErr;
      const row = ((stats || []) as any[]).find((r) => r.group_id === g.id);
      if (row) {
        total = Number(row.total_active) || 0;
        logged = Number(row.logged_in_count) || 0;
      } else {
        const { count } = await admin.from("profiles").select("id", { count: "exact", head: true }).eq("group_id", g.id);
        total = count || 0;
      }
      const never = Math.max(0, total - logged);
      const pct = total > 0 ? Math.round((logged / total) * 100) : 0;
      const link = await createMagicLink(admin, teacherId, "teacher_dashboard", "/teacher/dashboard");
      await sendMessage(chatId, t.tHealthLine(g.name, logged, total, never, total, pct), {
        inline_keyboard: [[{ text: t.tHealthOpenSite, url: link }]],
      });
    } catch (e: any) {
      console.error("[bot:/thealth] failed", e?.message || e);
      await sendWithKeyboard(chatId, `⚠️ Holatni yuklashda xato: ${e?.message || e}`, locale, false, "teacher");
    }
    return true;
  }

  if (cmd === "/thomework") {
    const g = activeGroup!;
    try {
      const { data: rows, error: rpcErr } = await admin.rpc("admin_group_module_submissions", { p_caller_profile_id: teacherId });
      if (rpcErr) throw rpcErr;
      const mods = ((rows || []) as any[])
        .filter((r) => r.group_id === g.id)
        .sort((a, b) => (a.module_position ?? 0) - (b.module_position ?? 0));
      const total = mods[0]?.total_students ?? 0;
      const lines: string[] = [`📚 <b>Vazifa topshirilishi — ${csvEscapeHtml(g.name)}</b> (${total} talaba)`, ""];
      const buttons: any[] = [];
      if (!mods.length) {
        lines.push("—");
      } else {
        for (const m of mods) {
          const pct = m.total_students > 0 ? Math.round((m.submitted_count / m.total_students) * 100) : 0;
          const pctStr = m.total_students > 0 ? `${pct}%` : "—";
          const tag = `M${(m.module_position ?? 0) + 1}`;
          const title = (m.module_title || "").slice(0, 30);
          lines.push(`<code>${tag}</code> ${csvEscapeHtml(title)} — <b>${m.submitted_count}/${m.total_students}</b> (${pctStr})`);
          buttons.push([
            { text: `${tag} ✅ Topshirgan`, callback_data: `thw:sub:${g.id}:${m.module_id}` },
            { text: `${tag} ❌ Topshirmagan`, callback_data: `thw:not:${g.id}:${m.module_id}` },
          ]);
        }
      }
      await sendMessage(chatId, lines.join("\n"), { inline_keyboard: buttons });
    } catch (e: any) {
      console.error("[bot:/thomework] failed", e?.message || e);
      await sendWithKeyboard(chatId, `⚠️ Vazifalarni yuklashda xato: ${e?.message || e}`, locale, false, "teacher");
    }
    return true;
  }

  if (cmd === "/tstudents" || cmd === "/tinactive") {
    const g = activeGroup!;
    const ids = await teacherStudentIds(admin, teacherId, g.id);
    if (!ids.length) {
      await sendWithKeyboard(chatId, `${t.tActiveGroup(g.name)}\n\n—`, locale, false, "teacher");
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
    const header = `<b>${headerLabel}</b> · ${csvEscapeHtml(g.name)} — ${rows.length}`;
    if (!rows.length) {
      await sendWithKeyboard(chatId, `${header}\n\n—`, locale, false, "teacher");
      return true;
    }
    const lines = rows.map((r) => `• <b>${csvEscapeHtml(r.name)}</b> ${csvEscapeHtml(r.handle)} (${r.days === null ? "∞" : r.days + "d"})`);
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
    const g = activeGroup!;
    try {
      const { data: profs } = await admin.from("profiles").select("id, name, last_name").eq("group_id", g.id);
      const profIds = ((profs || []) as any[]).map((p) => p.id);
      const profMap = new Map<string, any>(((profs || []) as any[]).map((p) => [p.id, p]));
      if (!profIds.length) {
        await sendWithKeyboard(chatId, `🏆 Top talabalar — ${csvEscapeHtml(g.name)}\n\nHali hech kim baholanmagan.`, locale, false, "teacher");
        return true;
      }
      const { data: subs } = await admin
        .from("homework_submissions")
        .select("user_id, score, assignment_id")
        .in("user_id", profIds)
        .not("score", "is", null);
      const subRows = (subs || []) as any[];
      if (!subRows.length) {
        await sendWithKeyboard(chatId, `🏆 Top talabalar — ${csvEscapeHtml(g.name)}\n\nHali hech kim baholanmagan.`, locale, false, "teacher");
        return true;
      }
      const aIds = Array.from(new Set(subRows.map((r) => r.assignment_id)));
      const { data: asgs } = await admin.from("homework_assignments").select("id, max_score").in("id", aIds);
      const maxMap = new Map<string, number>(((asgs || []) as any[]).map((a) => [a.id, Number(a.max_score) || 10]));
      const totals = new Map<string, { score: number; max: number }>();
      for (const s of subRows) {
        const cur = totals.get(s.user_id) || { score: 0, max: 0 };
        cur.score += Number(s.score) || 0;
        cur.max += maxMap.get(s.assignment_id) || 10;
        totals.set(s.user_id, cur);
      }
      const ranked = Array.from(totals.entries())
        .map(([uid, v]) => ({ uid, ...v, p: profMap.get(uid) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
      const lines = ranked.map((r, i) => {
        const nm = [r.p?.name, r.p?.last_name].filter(Boolean).join(" ").trim() || "—";
        const pct = r.max > 0 ? Math.round((r.score / r.max) * 100) : 0;
        return `${i + 1}. <b>${csvEscapeHtml(nm)}</b> — ${r.score}/${r.max} (${pct}%)`;
      });
      await sendWithKeyboard(chatId, `🏆 Top talabalar — ${csvEscapeHtml(g.name)}\n\n${lines.join("\n")}\n\n<i>Faqat baholangan vazifalar hisoblanadi.</i>`, locale, false, "teacher");
    } catch (e: any) {
      console.error("[bot:/ttop] failed", e?.message || e);
      await sendWithKeyboard(chatId, `⚠️ Top talabalarni yuklashda xato: ${e?.message || e}`, locale, false, "teacher");
    }
    return true;
  }

  if (cmd === "/tbroadcast") {
    const g = activeGroup!;
    // Rate-limit: 1 per hour
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await admin.from("bot_broadcast_rate").select("id", { count: "exact", head: true }).eq("actor_user_id", teacherId).eq("scope", "teacher").gte("created_at", since);
    if ((count || 0) >= 1) {
      await sendWithKeyboard(chatId, t.teacherBroadcastRate, locale, false, "teacher");
      return true;
    }
    await admin.from("bot_sessions").upsert({ user_id: teacherId, state: "teacher_broadcast", data: { group_id: g.id }, updated_at: new Date().toISOString() });
    await sendWithKeyboard(chatId, `${t.tActiveGroup(g.name)}\n\n${t.teacherBroadcastPrompt}`, locale, false, "teacher");
    return true;
  }

  // Grading commands shared with admin (scoped to active group for teachers)
  const g2 = await handleGradingCommand(admin, chatId, teacherId, locale, cmd, false, activeGroup?.id);
  if (g2) return true;

  return false;
}

// =================== GRADING (teacher + admin) ===================

// Returns submissions in scope for grader. teacher=group students, admin=all.
async function gradingScopeIds(admin: any, graderId: string, isAdmin: boolean, groupId?: string | null): Promise<string[] | null> {
  if (isAdmin) return null; // null = no scope filter
  if (groupId) {
    const { data } = await admin.from("profiles").select("id").eq("group_id", groupId);
    return ((data || []) as any[]).map((r) => r.id);
  }
  const groups = await teacherGroups(admin, graderId);
  if (!groups.length) return [];
  const { data } = await admin.from("profiles").select("id").in("group_id", groups.map((g) => g.id));
  return ((data || []) as any[]).map((r) => r.id);
}

async function loadGradingSubmissions(admin: any, graderId: string, isAdmin: boolean, opts: { scored: boolean; limit?: number; groupId?: string | null }) {
  const ids = await gradingScopeIds(admin, graderId, isAdmin, opts.groupId);
  if (ids && ids.length === 0) return [];
  let q = admin.from("homework_submissions").select("id, assignment_id, user_id, submitted_at, score, score_feedback, scored_at, is_late");
  if (ids) q = q.in("user_id", ids);
  // Pending = ungraded OR re-opened (score_is_stale); scored excludes stale, so
  // resubmissions resurface for grading instead of hiding in "graded".
  q = opts.scored
    ? q.not("score", "is", null).not("score_is_stale", "is", true).order("scored_at", { ascending: false })
    : q.or("score.is.null,score_is_stale.is.true").order("submitted_at", { ascending: true });
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
  admin: any, chatId: number, graderId: string, locale: Locale, cmd: string, isAdmin: boolean, groupId?: string | null,
): Promise<boolean> {
  const t = T[locale] as any;

  if (cmd === "/baholash" || cmd === "/grade") {
    await renderStudentPicker(admin, chatId, graderId, locale, isAdmin, 0, groupId);
    return true;
  }

  if (cmd === "/baholar" || cmd === "/grades" || cmd === "/talabalar" || cmd === "/students") {
    await renderTeacherRoster(admin, chatId, graderId, locale, isAdmin, 0, groupId);
    return true;
  }

  if (cmd === "/modulvazifalar" || cmd === "/modhomework") {
    await renderTeacherModulePicker(admin, chatId, graderId, locale, isAdmin, 0, groupId);
    return true;
  }

  return false;
}

// =================== STUDENT-FIRST PICKER ===================

const PICKER_PAGE_SIZE = 10;

async function renderStudentPicker(admin: any, chatId: number, graderId: string, locale: Locale, isAdmin: boolean, page: number, groupId?: string | null) {
  const t = T[locale] as any;
  const ids = await gradingScopeIds(admin, graderId, isAdmin, groupId);
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
    admin.from("homework_submissions").select("id, assignment_id, submitted_at, telegram_message_url").eq("user_id", studentId).is("score", null).order("submitted_at", { ascending: true }),
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
  const groupTopicRes = prof?.group_id
    ? await admin.from("groups").select("homework_topic_url").eq("id", prof.group_id).maybeSingle()
    : { data: null as any };
  const sharedTopicUrl: string | null = (groupTopicRes.data as any)?.homework_topic_url || null;
  const topicMap = new Map<string, string>();
  for (const tp of ((topicsRes.data || []) as any[])) {
    if (tp.telegram_topic_url) topicMap.set(tp.module_id, tp.telegram_topic_url);
  }
  if (sharedTopicUrl) {
    for (const mid of moduleIds) if (!topicMap.has(mid)) topicMap.set(mid, sharedTopicUrl);
  }


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
    let anyPostUrl = false;
    for (const it of m.items) {
      const tn = it.a.task_number || 1;
      lines.push(`   ⏳ V${tn}: ${csvEscapeHtml(it.a.title || "")}`);
      buttons.push([{ text: `M${m.mPos + 1}·V${tn} — ${it.a.title || ""}`.slice(0, 60), callback_data: `gs:open:${it.sub.id}` }]);
      const postUrl = it.sub.telegram_message_url;
      if (postUrl) {
        anyPostUrl = true;
        buttons.push([{ text: t.gradeOpenSubmissionBtn(tn), url: postUrl }]);
      }
    }
    const url = topicMap.get(m.mid);
    if (url && !anyPostUrl) buttons.push([{ text: t.gradeOpenTopicBtn(m.mPos + 1), url }]);
    lines.push("");
  }
  buttons.push([{ text: t.gradeBackList, callback_data: "gs:list:0" }]);
  await sendMessage(chatId, lines.join("\n"), { inline_keyboard: buttons });
}

// =================== TEACHER ROSTER (students -> modules -> detail) ===================

const ROSTER_PAGE_SIZE = 10;

async function renderTeacherRoster(
  admin: any, chatId: number, graderId: string, locale: Locale, isAdmin: boolean, page: number, groupId?: string | null,
) {
  const t = T[locale] as any;
  const ids = await gradingScopeIds(admin, graderId, isAdmin, groupId);
  if (ids && ids.length === 0) {
    await sendWithKeyboard(chatId, t.rosterEmpty, locale, isAdmin, isAdmin ? "admin" : "teacher");
    return;
  }
  // Roster = all students in scope (even those with zero submissions, so teacher sees who's idle).
  let pq = admin.from("profiles").select("id, name, last_name, telegram_username").is("archived_at", null);
  if (ids) pq = pq.in("id", ids);
  const { data: profs } = await pq;
  const profList = ((profs || []) as any[]);
  if (!profList.length) {
    await sendWithKeyboard(chatId, t.rosterEmpty, locale, isAdmin, isAdmin ? "admin" : "teacher");
    return;
  }

  // Submission counts per student (any score state).
  const userIds = profList.map((p) => p.id);
  const { data: subs } = await admin.from("homework_submissions").select("user_id").in("user_id", userIds);
  const counts = new Map<string, number>();
  for (const s of (subs || []) as any[]) counts.set(s.user_id, (counts.get(s.user_id) || 0) + 1);

  const rows = profList.map((p) => {
    const handle = (p.telegram_username || "").toString().trim();
    const fullName = [p.name, p.last_name].filter(Boolean).join(" ") || "—";
    const label = handle ? `@${handle}` : fullName;
    return { id: p.id, label, n: counts.get(p.id) || 0, sortName: fullName.toLowerCase() };
  }).sort((a, b) => (b.n - a.n) || a.sortName.localeCompare(b.sortName));

  const totalPages = Math.max(1, Math.ceil(rows.length / ROSTER_PAGE_SIZE));
  const pageIdx = Math.min(Math.max(0, page), totalPages - 1);
  const slice = rows.slice(pageIdx * ROSTER_PAGE_SIZE, (pageIdx + 1) * ROSTER_PAGE_SIZE);

  const buttons: any[][] = slice.map((r) => [{
    text: t.rosterStudentRow(r.label, r.n).slice(0, 60),
    callback_data: `tr:stu:${r.id}`,
  }]);
  const nav: any[] = [];
  if (pageIdx > 0) nav.push({ text: t.gradePrevPage, callback_data: `tr:list:${pageIdx - 1}` });
  if (pageIdx < totalPages - 1) nav.push({ text: t.gradeNextPage, callback_data: `tr:list:${pageIdx + 1}` });
  if (nav.length) buttons.push(nav);

  await sendMessage(chatId, t.rosterTitle, { inline_keyboard: buttons });
  await sendKeyboardHint(chatId, locale, isAdmin, isAdmin ? "admin" : "teacher");
}

async function renderStudentModules(
  admin: any, chatId: number, graderId: string, studentId: string, locale: Locale, isAdmin: boolean,
) {
  const t = T[locale] as any;
  const ids = await gradingScopeIds(admin, graderId, isAdmin);
  if (ids && !ids.includes(studentId)) {
    await sendMessage(chatId, t.gradeNotFound);
    return;
  }
  const [{ data: prof }, { data: subs }] = await Promise.all([
    admin.from("profiles").select("name, last_name, telegram_username").eq("id", studentId).maybeSingle(),
    admin.from("homework_submissions").select("id, assignment_id, score, submitted_at").eq("user_id", studentId).order("submitted_at", { ascending: true }),
  ]);
  const fullName = [prof?.name, prof?.last_name].filter(Boolean).join(" ") || "—";
  const handle = (prof?.telegram_username || "").toString().trim();
  const headerName = handle ? `@${handle} (${fullName})` : fullName;

  const list = (subs || []) as any[];
  if (!list.length) {
    await sendMessage(chatId, `${t.studentModulesTitle(headerName)}\n\n${t.studentModulesEmpty}`, {
      inline_keyboard: [[{ text: t.backToRoster, callback_data: "tr:list:0" }]],
    });
    return;
  }
  const aIds = Array.from(new Set(list.map((s) => s.assignment_id)));
  const { data: assigns } = await admin
    .from("homework_assignments")
    .select("id, max_score, module_id, modules(position)")
    .in("id", aIds);
  const aMap = new Map(((assigns || []) as any[]).map((a: any) => [a.id, a]));

  const byModule = new Map<string, { mPos: number; mid: string; latest: number; items: { score: number | null; max: number }[] }>();
  for (const s of list) {
    const a: any = aMap.get(s.assignment_id);
    if (!a) continue;
    const key = a.module_id;
    if (!byModule.has(key)) byModule.set(key, { mPos: a.modules?.position ?? 0, mid: key, latest: 0, items: [] });
    const bucket = byModule.get(key)!;
    bucket.items.push({ score: s.score, max: a.max_score || 10 });
    const ts = s.submitted_at ? new Date(s.submitted_at).getTime() : 0;
    if (ts > bucket.latest) bucket.latest = ts;
  }
  const modules = Array.from(byModule.values()).sort((x, y) => x.mPos - y.mPos);

  const fmtDate = (ms: number) => ms ? new Date(ms).toISOString().slice(0, 10) : "";
  const lines = [t.studentModulesTitle(headerName), ""];
  const buttons: any[][] = modules.map((m) => {
    const scoresStr = m.items
      .map((it) => it.score == null ? t.scorePending : `${it.score}/${it.max}`)
      .join(", ");
    const dateStr = fmtDate(m.latest);
    lines.push(`📦 <b>${m.mPos + 1}-MODUL</b> — ${m.items.length} ta · ${csvEscapeHtml(scoresStr)}${dateStr ? ` · 📅 ${dateStr}` : ""}`);
    return [{
      text: `${m.mPos + 1}-MODUL · ${m.items.length} ta · ${scoresStr}${dateStr ? ` · ${dateStr}` : ""}`.slice(0, 60),
      callback_data: `tr:mod:${studentId}:${m.mid}`,
    }];
  });
  buttons.push([{ text: t.backToRoster, callback_data: "tr:list:0" }]);
  await sendMessage(chatId, lines.join("\n"), { inline_keyboard: buttons });
}

async function renderStudentModuleDetail(
  admin: any, chatId: number, graderId: string, studentId: string, moduleId: string, locale: Locale, isAdmin: boolean,
) {
  const t = T[locale] as any;
  const ids = await gradingScopeIds(admin, graderId, isAdmin);
  if (ids && !ids.includes(studentId)) {
    await sendMessage(chatId, t.gradeNotFound);
    return;
  }
  const [{ data: prof }, { data: mod }] = await Promise.all([
    admin.from("profiles").select("name, last_name, telegram_username, group_id").eq("id", studentId).maybeSingle(),
    admin.from("modules").select("position, title").eq("id", moduleId).maybeSingle(),
  ]);
  const fullName = [prof?.name, prof?.last_name].filter(Boolean).join(" ") || "—";
  const handle = (prof?.telegram_username || "").toString().trim();
  const headerName = handle ? `@${handle} (${fullName})` : fullName;
  const mPos = (mod?.position ?? 0) + 1;

  const { data: assigns } = await admin
    .from("homework_assignments")
    .select("id, title, max_score, task_number, sap_number, parent_id")
    .eq("module_id", moduleId);
  const aIds = ((assigns || []) as any[]).map((a: any) => a.id);
  const aMap = new Map(((assigns || []) as any[]).map((a: any) => [a.id, a]));
  const { data: subs } = aIds.length
    ? await admin.from("homework_submissions")
        .select("id, assignment_id, score, score_feedback, submitted_at, telegram_message_url")
        .eq("user_id", studentId).in("assignment_id", aIds).order("submitted_at", { ascending: true })
    : { data: [] as any[] };

  const list = (subs || []) as any[];
  const lines = [`👤 <b>${csvEscapeHtml(headerName)}</b>`, `📦 <b>${mPos}-modul — ${csvEscapeHtml(mod?.title || "—")}</b>`, ""];
  const buttons: any[][] = [];
  if (!list.length) {
    lines.push(t.studentModulesEmpty);
  } else {
    for (const s of list) {
      const a: any = aMap.get(s.assignment_id);
      if (!a) continue;
      const tn = a.task_number || 1;
      const label = a.parent_id ? `V${tn}.S${a.sap_number ?? "?"}` : `V${tn}`;
      const scoreStr = s.score == null ? `⏳ ${t.scorePending || ""}`.trim() : `<b>${s.score}/${a.max_score || 10}</b>`;
      const dateStr = s.submitted_at ? new Date(s.submitted_at).toISOString().slice(0, 10) : "";
      lines.push(`• ${label} — ${csvEscapeHtml(a.title || "")}${dateStr ? ` · 📅 ${dateStr}` : ""} · ${scoreStr}`);
      if (s.score_feedback) lines.push(`   💬 ${csvEscapeHtml(s.score_feedback)}`);
      if (s.score == null) {
        buttons.push([{ text: `📝 ${label} — baholash`.slice(0, 60), callback_data: `gs:open:${s.id}` }]);
      }
      if (s.telegram_message_url) {
        buttons.push([{ text: t.gradeOpenSubmissionBtn(tn), url: s.telegram_message_url }]);
      }
    }
  }
  buttons.push([{ text: t.backToRoster, callback_data: `tr:stu:${studentId}` }]);
  await sendMessage(chatId, lines.join("\n"), { inline_keyboard: buttons });
}

// =================== TEACHER MODULE-GROUPED HOMEWORK ===================

const THM_MODULE_PAGE_SIZE = 10;
const THM_STUDENT_CHUNK = 40;

// Resolve which modules are visible to the grader: union of courses across owned groups
// (or the active group). Admins see every module.
async function thmListModules(
  admin: any, graderId: string, isAdmin: boolean, groupId?: string | null,
): Promise<{ id: string; position: number; title: string }[]> {
  if (isAdmin) {
    const { data } = await admin.from("modules").select("id, position, title").order("position", { ascending: true });
    return ((data || []) as any[]);
  }
  let courseIds: string[] = [];
  if (groupId) {
    const { data: g } = await admin.from("groups").select("course_id").eq("id", groupId).maybeSingle();
    if (g?.course_id) courseIds = [g.course_id];
  } else {
    const groups = await teacherGroups(admin, graderId);
    if (!groups.length) return [];
    const { data: gs } = await admin.from("groups").select("course_id").in("id", groups.map((x) => x.id));
    courseIds = Array.from(new Set(((gs || []) as any[]).map((r) => r.course_id).filter(Boolean)));
  }
  if (!courseIds.length) return [];
  const { data } = await admin.from("modules").select("id, position, title").in("course_id", courseIds).order("position", { ascending: true });
  return ((data || []) as any[]);
}

async function renderTeacherModulePicker(
  admin: any, chatId: number, graderId: string, locale: Locale, isAdmin: boolean, page: number, groupId?: string | null,
) {
  const t = T[locale] as any;
  const studentIds = await gradingScopeIds(admin, graderId, isAdmin, groupId);
  const modules = await thmListModules(admin, graderId, isAdmin, groupId);
  if (!modules.length) {
    await sendWithKeyboard(chatId, t.thmEmpty, locale, isAdmin, isAdmin ? "admin" : "teacher");
    return;
  }
  // Total students in scope (admins: count distinct profiles attached to a group).
  let totalStudents = 0;
  if (isAdmin) {
    const { count } = await admin.from("profiles").select("id", { count: "exact", head: true }).is("archived_at", null).not("group_id", "is", null);
    totalStudents = count || 0;
  } else {
    totalStudents = (studentIds || []).length;
  }

  // Per-module submitted count (distinct user_id with any submission for that module's leaves).
  const modIds = modules.map((m) => m.id);
  const { data: assigns } = await admin
    .from("homework_assignments")
    .select("id, module_id, parent_id, task_number, sap_number, is_active")
    .in("module_id", modIds);
  const assignsByModule = new Map<string, any[]>();
  for (const a of ((assigns || []) as any[])) {
    if (!assignsByModule.has(a.module_id)) assignsByModule.set(a.module_id, []);
    assignsByModule.get(a.module_id)!.push(a);
  }
  const allLeafIds: string[] = [];
  const leafToModule = new Map<string, string>();
  for (const m of modules) {
    const arr = assignsByModule.get(m.id) || [];
    const leaves = computeLeaves(arr);
    for (const l of leaves) {
      allLeafIds.push(l.id);
      leafToModule.set(l.id, m.id);
    }
  }
  const submittersByModule = new Map<string, Set<string>>();
  if (allLeafIds.length) {
    let sq = admin.from("homework_submissions").select("user_id, assignment_id").in("assignment_id", allLeafIds);
    if (studentIds) sq = sq.in("user_id", studentIds);
    const { data: subs } = await sq;
    for (const s of ((subs || []) as any[])) {
      const mid = leafToModule.get(s.assignment_id);
      if (!mid) continue;
      if (!submittersByModule.has(mid)) submittersByModule.set(mid, new Set());
      submittersByModule.get(mid)!.add(s.user_id);
    }
  }

  const totalPages = Math.max(1, Math.ceil(modules.length / THM_MODULE_PAGE_SIZE));
  const pageIdx = Math.min(Math.max(0, page), totalPages - 1);
  const slice = modules.slice(pageIdx * THM_MODULE_PAGE_SIZE, (pageIdx + 1) * THM_MODULE_PAGE_SIZE);

  const buttons: any[][] = slice.map((m) => {
    const sub = submittersByModule.get(m.id)?.size || 0;
    return [{
      text: t.thmModuleRow((m.position || 0) + 1, m.title || "", sub, totalStudents),
      callback_data: `thm:mod:${m.id}`,
    }];
  });
  const nav: any[] = [];
  if (pageIdx > 0) nav.push({ text: t.gradePrevPage, callback_data: `thm:list:${pageIdx - 1}` });
  if (pageIdx < totalPages - 1) nav.push({ text: t.gradeNextPage, callback_data: `thm:list:${pageIdx + 1}` });
  if (nav.length) buttons.push(nav);

  await sendMessage(chatId, t.thmTitle, { inline_keyboard: buttons });
  await sendKeyboardHint(chatId, locale, isAdmin, isAdmin ? "admin" : "teacher");
}

async function renderTeacherModuleDetail(
  admin: any, chatId: number, graderId: string, moduleId: string, locale: Locale, isAdmin: boolean, groupId?: string | null,
) {
  const t = T[locale] as any;
  const studentIds = await gradingScopeIds(admin, graderId, isAdmin, groupId);

  const { data: mod } = await admin.from("modules").select("id, position, title, course_id").eq("id", moduleId).maybeSingle();
  if (!mod) { await sendMessage(chatId, t.gradeNotFound || "Not found"); return; }
  const mPos = (mod.position || 0) + 1;

  // Load profiles in scope
  let pq = admin.from("profiles").select("id, name, last_name, telegram_username, telegram_id").is("archived_at", null);
  if (studentIds) {
    if (!studentIds.length) {
      await sendMessage(chatId, t.thmEmpty);
      return;
    }
    pq = pq.in("id", studentIds);
  } else {
    // Admin: bound to students in groups attached to this module's course
    const { data: gs } = await admin.from("groups").select("id").eq("course_id", mod.course_id);
    const gids = ((gs || []) as any[]).map((g) => g.id);
    if (!gids.length) {
      await sendMessage(chatId, t.thmEmpty);
      return;
    }
    pq = pq.in("group_id", gids);
  }
  const { data: profs } = await pq;
  const profMap = new Map(((profs || []) as any[]).map((p) => [p.id, p]));

  // Load this module's leaf assignments
  const { data: assigns } = await admin
    .from("homework_assignments")
    .select("id, max_score, task_number, sap_number, parent_id, is_active, title")
    .eq("module_id", moduleId);
  const aArr = ((assigns || []) as any[]);
  const leaves = computeLeaves(aArr);
  const aMap = new Map(aArr.map((a) => [a.id, a]));

  // Submissions for the module
  const leafIds = leaves.map((l) => l.id);
  let subs: any[] = [];
  if (leafIds.length) {
    let sq = admin
      .from("homework_submissions")
      .select("user_id, assignment_id, score, score_feedback, submitted_at")
      .in("assignment_id", leafIds);
    if (studentIds) sq = sq.in("user_id", studentIds);
    const { data } = await sq;
    subs = (data || []) as any[];
  }

  // Group by user
  const subsByUser = new Map<string, any[]>();
  for (const s of subs) {
    if (!subsByUser.has(s.user_id)) subsByUser.set(s.user_id, []);
    subsByUser.get(s.user_id)!.push(s);
  }

  const fmtName = (p: any) => [p?.name, p?.last_name].filter(Boolean).join(" ") || "—";

  // ----- Message A: submitted -----
  const submittedHeader = t.thmSubmittedTitle(mPos, mod.title || "");
  const submittedLines: string[] = [];
  const submittedUsers = Array.from(subsByUser.keys())
    .map((uid) => profMap.get(uid))
    .filter(Boolean)
    .sort((x: any, y: any) => fmtName(x).toLowerCase().localeCompare(fmtName(y).toLowerCase()));
  if (!submittedUsers.length) {
    submittedLines.push(t.thmNoneSubmitted);
  } else {
    for (const p of submittedUsers as any[]) {
      const handle = (p.telegram_username || "").toString().trim();
      const name = fmtName(p);
      const head = handle ? `@${handle}${name && name !== "—" ? ` (${csvEscapeHtml(name)})` : ""}` : `<b>${csvEscapeHtml(name)}</b>`;
      submittedLines.push(`• ${head}`);
      const userSubs = (subsByUser.get(p.id) || []).slice().sort((a: any, b: any) =>
        ((aMap.get(a.assignment_id) as any)?.task_number || 0) - ((aMap.get(b.assignment_id) as any)?.task_number || 0)
      );
      for (const s of userSubs) {
        const a: any = aMap.get(s.assignment_id);
        if (!a) continue;
        const tn = a.task_number || 1;
        const lbl = a.parent_id ? `V${tn}.S${a.sap_number ?? "?"}` : `V${tn}`;
        const scoreStr = s.score == null ? `⏳ ${t.scorePending || ""}`.trim() : `<b>${s.score}/${a.max_score || 10}</b>`;
        const fbStr = s.score_feedback ? ` · 💬 ${csvEscapeHtml(String(s.score_feedback))}` : "";
        submittedLines.push(`   ${lbl} — ${scoreStr}${fbStr}`);
      }
    }
  }

  // Send (chunk if too long)
  await thmSendChunked(chatId, submittedHeader, submittedLines, {
    inline_keyboard: [[{ text: t.thmBackToList, callback_data: "thm:list:0" }]],
  });

  // ----- Message B: missing -----
  const missingHeader = t.thmMissingTitle(mPos, mod.title || "");
  const missingProfiles = Array.from(profMap.values())
    .filter((p: any) => !subsByUser.has(p.id))
    .sort((x: any, y: any) => fmtName(x).toLowerCase().localeCompare(fmtName(y).toLowerCase()));
  const missingLines: string[] = [];
  if (!missingProfiles.length) {
    missingLines.push(t.thmNoneMissing);
  } else {
    for (const p of missingProfiles as any[]) {
      const handle = (p.telegram_username || "").toString().trim();
      const name = fmtName(p);
      if (handle) missingLines.push(`• @${handle}${name && name !== "—" ? ` (${csvEscapeHtml(name)})` : ""}`);
      else missingLines.push(`• <b>${csvEscapeHtml(name)}</b>`);
    }
  }
  await thmSendChunked(chatId, missingHeader, missingLines, {
    inline_keyboard: [[{ text: t.thmBackToList, callback_data: "thm:list:0" }]],
  });
}

async function thmSendChunked(chatId: number, header: string, lines: string[], finalKeyboard: any) {
  // Telegram messages cap ~4096 chars. Chunk by ~40 lines (~3.5KB) to be safe.
  const chunks: string[][] = [];
  for (let i = 0; i < lines.length; i += THM_STUDENT_CHUNK) {
    chunks.push(lines.slice(i, i + THM_STUDENT_CHUNK));
  }
  if (!chunks.length) chunks.push([]);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const body = `${i === 0 ? header + "\n\n" : ""}${chunks[i].join("\n")}`;
    await sendMessage(chatId, body, isLast ? finalKeyboard : undefined);
  }
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
  // C2: a teacher may only grade students in their own groups. The grading LIST
  // functions scope by gradingScopeIds, but this open-by-id path (reached from
  // forgeable / stale callback buttons) did not — so a teacher could grade
  // another group's students. The bot runs service-role, bypassing RLS, so this
  // check must be explicit.
  if (!isAdmin) {
    const scope = await gradingScopeIds(admin, graderId, false);
    if (!scope || !scope.includes(sub.user_id)) {
      await sendMessage(chatId, t.gradeNotFound);
      return;
    }
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
      inline_keyboard: [[
        { text: tt.hwTeacherBtnFile, url: sub.telegram_message_url },
        { text: tt.gradeOpenSubmissionPostBtn, url: sub.telegram_message_url },
      ]],
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
    const submissionId = ctx.submission_id as string;
    const { data: sub } = await admin.from("homework_submissions")
      .select("user_id, assignment_id").eq("id", submissionId).maybeSingle();
    if (text === "/cancel") {
    await admin.from("bot_conversation_state").delete().eq("telegram_id", tgId);
    if (sub) cacheInvalidateUser(sub.user_id);
      await sendWithKeyboard(msg.chat.id, t.gradeCancelled, locale, isAdmin, isAdmin ? "admin" : "teacher");
      return true;
    }
    // C2: re-check scope at commit time (teachers only) — the submission owner
    // must still be in the grader's groups.
    if (sub && !isAdmin) {
      const scope = await gradingScopeIds(admin, profileId, false);
      if (!scope || !scope.includes(sub.user_id)) {
        await admin.from("bot_conversation_state").delete().eq("telegram_id", tgId);
        await sendMessage(msg.chat.id, t.gradeNotFound);
        return true;
      }
    }
    const feedback = text === "/skip" ? null : text;
    const score = Number(ctx.score);

    const { error: upErr } = await admin.from("homework_submissions").update({
      score, score_feedback: feedback, scored_by: profileId, scored_at: new Date().toISOString(), score_is_stale: false,
    }).eq("id", submissionId);
    if (upErr) {
      await sendMessage(msg.chat.id, `❌ ${upErr.message}`);
      return true;
    }
    await admin.from("bot_conversation_state").delete().eq("telegram_id", tgId);
    if (sub) {
      cacheInvalidateUser(sub.user_id);
      try {
        await admin.from("profiles").update({ stats_dirty_at: new Date().toISOString() }).eq("id", sub.user_id);
      } catch (e) {
        console.error("mark stats dirty failed", e);
      }
    }

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
          await sendLongMessage(stu.telegram_id, tt.gradeStudentDM(csvEscapeHtml(title), score, max, csvEscapeHtml(feedback || "")), {
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
  const sessGroupId: string | undefined = (sess as any)?.data?.group_id;
  const groups = await teacherGroups(admin, profileId);
  const sessGroup = sessGroupId ? groups.find((g: any) => g.id === sessGroupId) : null;
  const groupName = sessGroup ? sessGroup.name : groups.map((g: any) => g.name).join(", ");
  const ids = await teacherStudentIds(admin, profileId, sessGroupId || null);
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
  const tgUsername = (msg.from.username || "").toLowerCase();
  const profile = await resolveProfileForTelegramUser(admin, tgId, tgUsername, "bot");
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
    await sendUnregisteredReply(admin, chatId, msg.from, locale);
    return;
  }

  // Admin / teacher routing (with impersonation override for admins)
  const realPersona = await getPersona(admin, profile.id);

  // --- Admin "act as" entry: /asteacher or /aststudent <@username|tg_id> ---
  if (realPersona === "admin") {
    const rawLower = cmdRaw.trim().toLowerCase();
    if (rawLower.startsWith("/asteacher") || rawLower.startsWith("/aststudent")) {
      const argRaw = cmdRaw.trim().split(/\s+/).slice(1).join(" ").trim();
      if (!argRaw) {
        await sendMessage(chatId, "Foydalanish: /asteacher @username yoki Telegram ID");
        return;
      }
      let target: any = null;
      let ambiguous = false;
      if (/^\d+$/.test(argRaw)) {
        const { data } = await admin
          .from("profiles")
          .select("id, name, last_name, telegram_username")
          .eq("telegram_id", Number(argRaw))
          .maybeSingle();
        target = data || null;
      } else {
        const uname = argRaw.replace(/^@+/, "").toLowerCase();
        const { data } = await admin
          .from("profiles")
          .select("id, name, last_name, telegram_username")
          .ilike("telegram_username", uname)
          .limit(2);
        if (data && data.length === 1) target = data[0];
        else if (data && data.length > 1) ambiguous = true;
      }
      if (ambiguous) {
        await sendMessage(chatId, "Bir nechta foydalanuvchi topildi, aniqroq kiriting.");
        return;
      }
      if (!target) {
        await sendMessage(chatId, "Foydalanuvchi topilmadi.");
        return;
      }
      const { data: tRoles } = await admin.from("user_roles").select("role").eq("user_id", target.id);
      const roleSet = new Set((tRoles || []).map((r: any) => r.role));
      if (roleSet.has("admin") || roleSet.has("superadmin")) {
        await sendMessage(chatId, "Admin impersonatsiya qilinmaydi");
        return;
      }
      const asPersona: Persona = roleSet.has("teacher") ? "teacher" : "student";
      const asName =
        [target.name, target.last_name].filter(Boolean).join(" ") ||
        (target.telegram_username ? `@${target.telegram_username}` : "user");
      await admin.from("bot_sessions").upsert({
        user_id: profile.id,
        state: "impersonate",
        data: { as_user_id: target.id, as_persona: asPersona, as_name: asName },
        updated_at: new Date().toISOString(),
      });
      await sendWithKeyboard(
        chatId,
        `👁 ${asName} sifatida ko'ryapsiz (faqat o'qish). Chiqish uchun /admin yozing.`,
        locale,
        false,
        asPersona,
      );
      return;
    }
  }

  // --- Active impersonation override (admins only) ---
  let effectivePersona: Persona | null = null;
  let effectiveProfileId: string | null = null;
  let impAsName = "";
  if (realPersona === "admin") {
    const { data: sess } = await admin
      .from("bot_sessions")
      .select("state, data")
      .eq("user_id", profile.id)
      .maybeSingle();
    if (sess?.state === "impersonate" && sess?.data?.as_user_id) {
      if (cmd === "/admin") {
        // Exit impersonation, then fall through to normal admin routing.
        await admin.from("bot_sessions").delete().eq("user_id", profile.id);
      } else {
        effectivePersona = sess.data.as_persona as Persona;
        effectiveProfileId = sess.data.as_user_id as string;
        impAsName = sess.data.as_name || "user";
      }
    }
  }

  if (effectivePersona && effectiveProfileId) {
    const WRITE_BLOCKED = new Set(["/baholash", "/grade", "/tbroadcast"]);
    if (WRITE_BLOCKED.has(cmd)) {
      await sendWithKeyboard(
        chatId,
        "👁 Faqat o'qish rejimi. Chiqish: /admin",
        locale,
        false,
        effectivePersona,
      );
      return;
    }
    if (effectivePersona === "teacher") {
      const handled = await handleTeacherCommand(admin, chatId, effectiveProfileId, locale, cmd);
      if (handled) return;
      // Unknown teacher command while impersonating — keep keyboard and exit.
      await sendWithKeyboard(chatId, `👁 ${impAsName} (read-only)`, locale, false, "teacher");
      return;
    }
    // Student impersonation: rebind profile to target and fall through to student handlers.
    const { data: tProfile } = await admin
      .from("profiles")
      .select(
        "id, name, last_name, telegram_username, telegram_id, telegram_onboarded_at, preferred_locale, group_id, status",
      )
      .eq("id", effectiveProfileId)
      .maybeSingle();
    if (tProfile) Object.assign(profile as any, tProfile);
    // Skip admin/teacher branches below — proceed straight to normal student command routing.
  } else {
    if (realPersona === "admin") {
      const handled = await handleAdminCommand(admin, chatId, profile.id, locale, cmd);
      if (handled) return;
    } else if (realPersona === "teacher") {
      const handled = await handleTeacherCommand(admin, chatId, profile.id, locale, cmd);
      if (handled) return;
    }
  }


  if (cmd === "/davom") {
    const courseId = await getPrimaryCourseIdForUser(admin, profile.id);
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
    const courseIds = await getCourseIdsForUser(admin, profile.id);
    if (!courseIds.length) {
      await sendWithKeyboard(chatId, t.noCourse, locale);
      return;
    }
    if (courseIds.length === 1) {
      const url = await createMagicLink(admin, profile.id, "deeplink_course", `/course/${courseIds[0]}`);
      await sendMessage(chatId, t.coursePage, { inline_keyboard: [[{ text: t.btnCourse, url }]] });
      return;
    }
    // Rare: student enrolled in more than one course → one button per course (by title).
    const { data: crows } = await admin.from("courses").select("id, title").in("id", courseIds);
    const titleById = new Map((crows || []).map((c: any) => [c.id, c.title]));
    const buttons: any[][] = [];
    for (const cid of courseIds) {
      const url = await createMagicLink(admin, profile.id, "deeplink_course", `/course/${cid}`);
      buttons.push([{ text: titleById.get(cid) || t.btnCourse, url }]);
    }
    await sendMessage(chatId, t.coursePage, { inline_keyboard: buttons });
    return;
  }

  if (cmd === "/profil" || cmd === "/profile") {
    console.time(`bot:profile:${profile.id}`);
    // Teachers/admins get the mentor card with per-group stats + group switching;
    // students (incl. student impersonation) get the student profile card.
    const persona = effectivePersona || realPersona;
    if (persona === "teacher" || persona === "admin") {
      const { text, keyboard } = await buildTeacherProfileCard(admin, profile.id, locale);
      await sendMessage(chatId, text, keyboard);
    } else {
      const { text, keyboard } = await buildProfileCard(admin, profile.id, locale);
      await sendMessage(chatId, text, keyboard);
    }
    console.timeEnd(`bot:profile:${profile.id}`);
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
    // One-time "confirm your name" prompt — real students only, not while impersonating.
    try {
      if (realPersona === "student" && !effectivePersona) {
        const { data: np } = await admin
          .from("profiles")
          .select("name_confirmed_at, name_prompt_last_at")
          .eq("id", profile.id)
          .maybeSingle();
        if (np && !np.name_confirmed_at) {
          const lastP = np.name_prompt_last_at ? new Date(np.name_prompt_last_at).getTime() : 0;
          if (Date.now() - lastP > 3 * 86400_000) {
            await admin.from("profiles").update({ name_prompt_last_at: new Date().toISOString() }).eq("id", profile.id);
            const disp = `${profile.name || ""} ${profile.last_name || ""}`.trim() || "—";
            await sendMessage(chatId, t.namePrompt(disp), { inline_keyboard: [[
              { text: t.nameBtnOk, callback_data: "name:ok" },
              { text: t.nameBtnEdit, callback_data: "name:edit" },
            ], [
              { text: t.nameBtnLater, callback_data: "name:later" },
            ]] });
          }
        }
      }
    } catch (_e) { /* best-effort */ }
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

// Resolve the submission topic URL for a (group, module) pair.
// Per-module override in `group_module_topics` wins; otherwise fall back to
// the group's shared `homework_topic_url` (Admin → Groups setting).
async function resolveModuleTopicUrl(
  admin: any,
  groupId: string | null | undefined,
  moduleId: string,
): Promise<{ url: string | null; source: "per_module" | "shared" | null }> {
  if (!groupId) return { url: null, source: null };
  try {
    const { data: gmt } = await admin
      .from("group_module_topics")
      .select("telegram_topic_url")
      .eq("group_id", groupId).eq("module_id", moduleId)
      .maybeSingle();
    if (gmt?.telegram_topic_url) return { url: gmt.telegram_topic_url, source: "per_module" };
  } catch (_e) { /* fall through */ }
  try {
    const { data: g } = await admin
      .from("groups")
      .select("homework_topic_url")
      .eq("id", groupId)
      .maybeSingle();
    if (g?.homework_topic_url) return { url: g.homework_topic_url, source: "shared" };
  } catch (_e) { /* noop */ }
  return { url: null, source: null };
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

  // 1b. Tier gate (Phase 2): block opening an intent for a module beyond the student's tier.
  if (await isModuleBlocked(admin, profile.id, a.module_id)) { await sendMessage(chatId, tierLockedMsg(locale)); return; }

  // 2. Already graded? Block — unless the score is stale (student already started a resubmission).
  const { data: existing } = await admin
    .from("homework_submissions")
    .select("id, score, score_is_stale")
    .eq("user_id", profile.id).eq("assignment_id", assignmentId)
    .maybeSingle();
  if (existing && existing.score != null && !existing.score_is_stale) {
    await sendMessage(chatId, t.hwIntentAlreadyScored);
    return;
  }

  // 3. Resolve student group + topic (per-module override → group shared topic)
  if (!profile.group_id) { await sendMessage(chatId, t.hwIntentNoGroup); return; }
  const { url: topicUrl } = await resolveModuleTopicUrl(admin, profile.group_id, a.module_id);
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

// v3.14.33: resolve group from supergroup chat_id by trying multiple URL patterns.
// Returns { groupId, pattern } or null. Bug fix: groups.telegram_group_url stores
// invite links like https://t.me/+abc, NOT /c/{id}/ links. So we have to look at
// group_module_topics.telegram_topic_url which DOES contain /c/{stripped}/{thread}.
async function resolveGroupFromChatId(
  admin: any,
  chatId: number,
): Promise<{ groupId: string | null; pattern: string }> {
  const stripped = String(chatId).replace(/^-100/, "");
  const needle = `/c/${stripped}/`;

  // Pattern 1: group_module_topics.telegram_topic_url contains /c/{stripped}/
  try {
    const { data: gmt } = await admin
      .from("group_module_topics")
      .select("group_id")
      .ilike("telegram_topic_url", `%${needle}%`)
      .limit(1);
    if (gmt?.[0]?.group_id) return { groupId: gmt[0].group_id, pattern: "gmt_topic_url" };
  } catch (_e) { /* noop */ }

  // Pattern 1b: groups.homework_topic_url contains /c/{stripped}/ (shared topic config)
  try {
    const { data: gh } = await admin
      .from("groups")
      .select("id")
      .ilike("homework_topic_url", `%${needle}%`)
      .limit(1);
    if (gh?.[0]?.id) return { groupId: gh[0].id, pattern: "group_homework_topic_url" };
  } catch (_e) { /* noop */ }

  // Pattern 2: groups.telegram_group_url contains /c/{stripped}/ (legacy/manual)

  try {
    const { data: g2 } = await admin
      .from("groups")
      .select("id")
      .ilike("telegram_group_url", `%${needle}%`)
      .limit(1);
    if (g2?.[0]?.id) return { groupId: g2[0].id, pattern: "group_url_c" };
  } catch (_e) { /* noop */ }

  // Pattern 3: groups.telegram_group_url contains raw chat_id
  try {
    const { data: g3 } = await admin
      .from("groups")
      .select("id")
      .ilike("telegram_group_url", `%${chatId}%`)
      .limit(1);
    if (g3?.[0]?.id) return { groupId: g3[0].id, pattern: "group_url_raw" };
  } catch (_e) { /* noop */ }

  return { groupId: null, pattern: "none" };
}

// v3.14.33: log every incoming update to webhook_inbox. Best-effort.
async function logWebhookInbox(admin: any, update: any): Promise<number | null> {
  try {
    const m = update.message || update.channel_post || update.edited_message || update.callback_query?.message;
    const cb = update.callback_query;
    let updateType = "unknown";
    if (update.message) updateType = "message";
    else if (update.edited_message) updateType = "edited_message";
    else if (update.channel_post) updateType = "channel_post";
    else if (update.callback_query) updateType = "callback_query";
    const fromUser = update.callback_query?.from || update.message?.from || update.channel_post?.from || update.edited_message?.from;
    const text = update.message?.text || update.message?.caption || update.channel_post?.text || cb?.data || "";
    const { data, error } = await admin.from("webhook_inbox").insert({
      update_type: updateType,
      chat_id: m?.chat?.id ?? null,
      chat_type: m?.chat?.type ?? null,
      chat_title: m?.chat?.title ?? null,
      message_thread_id: m?.message_thread_id ?? null,
      message_id: m?.message_id ?? null,
      from_user_id: fromUser?.id ?? null,
      from_username: fromUser?.username ?? null,
      text_preview: String(text).slice(0, 200),
      raw_update: update,
      resolution: null,
    }).select("id").maybeSingle();
    if (error) { console.error("webhook_inbox insert err", error); return null; }
    return data?.id ?? null;
  } catch (e) {
    console.error("logWebhookInbox failed", e);
    return null;
  }
}

async function updateInboxResolution(admin: any, inboxId: number | null, patch: Record<string, any>) {
  if (!inboxId) return;
  try {
    // Merge with existing resolution
    const { data: row } = await admin.from("webhook_inbox").select("resolution").eq("id", inboxId).maybeSingle();
    const merged = { ...(row?.resolution || {}), ...patch };
    await admin.from("webhook_inbox").update({ resolution: merged }).eq("id", inboxId);
  } catch (e) { console.error("updateInboxResolution failed", e); }
}

// Group/supergroup post inside a topic — try to attach it to a pending intent.
// v3.14.29: persist topic message event for teacher statistics. Best-effort, never throws.
async function recordGroupMessageEvent(admin: any, msg: any) {
  const chatType = msg.chat?.type;
  if (chatType !== "supergroup" && chatType !== "group") return;
  const chatId: number = msg.chat?.id;
  // v2: teachers answer ANONYMOUSLY ("as the group"). Telegram delivers those via GroupAnonymousBot
  // with sender_chat == the group itself, so the is_bot guard below was silently dropping EVERY
  // anonymous teacher answer. Detect anonymous-admin and keep it; all other bot messages still drop.
  const isAnonAdmin: boolean = !!(msg.sender_chat && chatId && msg.sender_chat.id === chatId);
  if (!isAnonAdmin && (!msg.from || msg.from.is_bot)) return;
  // capture ALL group messages, not only topic threads (General/main chat has no message_thread_id).
  const threadId: number | null = msg.message_thread_id ?? null;
  const messageId: number = msg.message_id;
  const tgUserId: number | null = msg.from?.id ?? null;
  const authorSignature: string | null = msg.author_signature ?? null;
  if (!chatId || !messageId) return;

  // v3.14.33: use multi-pattern resolver (groups.telegram_group_url is invite-link only)
  const { groupId } = await resolveGroupFromChatId(admin, chatId);
  if (!groupId) return; // unknown group, skip

  // Resolve module via topic mapping (only for topic messages; General/main chat has no thread)
  let moduleId: string | null = null;
  if (threadId != null) {
    const { data: topicRow } = await admin
      .from("group_module_topics")
      .select("module_id")
      .eq("group_id", groupId)
      .eq("telegram_topic_id", threadId)
      .maybeSingle();
    moduleId = topicRow?.module_id || null;
  }

  // Resolve profile. Anonymous admin = the group's staff answering → attribute to the group's teacher.
  let profileId: string | null = null;
  if (isAnonAdmin) {
    const { data: gRow } = await admin.from("groups").select("teacher_id").eq("id", groupId).maybeSingle();
    profileId = (gRow as any)?.teacher_id ?? null;
  } else {
    const tgUsername = (msg.from?.username || "").toLowerCase();
    const byId = tgUserId != null ? await findProfileByTelegramId(admin, tgUserId) : null;
    if (byId) profileId = byId.id;
    else if (tgUsername) {
      const byU = await findProfileByUsername(admin, tgUsername);
      if (byU) profileId = byU.id;
    }
  }

  // v2 teacher-stats signals: identify questions DIRECTED at the group's teacher (reply / @tag /
  // "ustoz") so we can measure if/when they're answered. Best-effort, never throws.
  const replyMsgId = msg.reply_to_message?.message_id ?? null;
  const replyUserId = msg.reply_to_message?.from?.id ?? null;
  const _txt = ((msg.text || msg.caption || "") + "").toLowerCase();
  const hasUstoz = _txt.includes("ustoz");
  let mentionsTeacher = false;
  const _ents = [...(msg.entities || []), ...(msg.caption_entities || [])]
    .filter((e: any) => e.type === "mention" || e.type === "text_mention");
  if (_ents.length) {
    try {
      const { data: _g } = await admin.from("groups").select("teacher_id").eq("id", groupId).maybeSingle();
      const _tid = (_g as any)?.teacher_id;
      if (_tid) {
        const { data: _tp } = await admin.from("profiles").select("telegram_id, telegram_username").eq("id", _tid).maybeSingle();
        const _ttg = (_tp as any)?.telegram_id != null ? Number((_tp as any).telegram_id) : null;
        const _tuser = ((_tp as any)?.telegram_username || "").toLowerCase();
        const _full = msg.text || msg.caption || "";
        for (const e of _ents) {
          if (e.type === "text_mention" && e.user?.id && _ttg != null && Number(e.user.id) === _ttg) { mentionsTeacher = true; break; }
          if (e.type === "mention" && _tuser) {
            const mu = String(_full).slice(e.offset, e.offset + e.length).replace(/^@/, "").toLowerCase();
            if (mu === _tuser) { mentionsTeacher = true; break; }
          }
        }
      }
    } catch (_e) { /* best-effort */ }
  }

  await admin
    .from("group_message_events")
    .upsert({
      group_id: groupId,
      module_id: moduleId,
      profile_id: profileId,
      telegram_user_id: tgUserId,
      telegram_chat_id: chatId,
      telegram_message_id: messageId,
      telegram_thread_id: threadId,
      sent_at: msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString(),
      reply_to_message_id: replyMsgId,
      reply_to_user_id: replyUserId,
      mentions_teacher: mentionsTeacher,
      has_ustoz: hasUstoz,
      is_anon_admin: isAnonAdmin,
      author_signature: authorSignature,
    }, { onConflict: "telegram_chat_id,telegram_message_id" });
}

// v3.14.40: Resolve an active leaf assignment for a sender posting in a homework topic.
// Used when a student posts without an explicit /vazifalar → 📤 Topshirish intent.
// Strict per-sender: each call resolves the next un-graded leaf for THIS profile only.
async function resolveAssignmentForTopic(
  admin: any,
  group: { id: string; course_id: string | null; homework_topic_id: number | bigint | null },
  threadId: number,
  profileId: string,
): Promise<{ moduleId: string; assignment: any; resolvedVia: "shared_topic" | "group_module_topic" } | null> {
  // Path A: shared-topic mode (groups.homework_topic_id matches the thread).
  if (group.homework_topic_id != null && Number(group.homework_topic_id) === Number(threadId)) {
    if (!group.course_id) return null;
    const { data: mods } = await admin.from("modules").select("id").eq("course_id", group.course_id);
    const modIds = ((mods as any[]) || []).map((m: any) => m.id);
    if (!modIds.length) return null;
    const { data: courseAsgs } = await admin
      .from("homework_assignments")
      .select("id, title, task_number, sap_number, max_score, module_id, parent_id, is_active, created_at, due_days_after_module_unlock")
      .in("module_id", modIds)
      .eq("is_active", true)
      .order("created_at", { ascending: false });
    const leaves = computeLeaves((courseAsgs || []) as any);
    if (!leaves.length) return null;
    const leafIds = leaves.map((l: any) => l.id);
    const { data: existingSubs } = await admin
      .from("homework_submissions")
      .select("assignment_id, score")
      .eq("user_id", profileId)
      .in("assignment_id", leafIds);
    const asg =
      pickNextLeaf(leaves as any, (existingSubs || []) as any) ||
      // All graded: fall back to the most recent leaf so a resubmission still attaches somewhere.
      [...leaves].sort((a: any, b: any) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0];
    if (!asg) return null;
    return { moduleId: asg.module_id, assignment: asg, resolvedVia: "shared_topic" };
  }
  // Path B: legacy per-module topic mapping.
  const { data: topicRow } = await admin
    .from("group_module_topics")
    .select("module_id")
    .eq("group_id", group.id)
    .eq("telegram_topic_id", threadId)
    .maybeSingle();
  if (!topicRow?.module_id) return null;
  const moduleId = topicRow.module_id as string;
  const { data: allAssignsForModule } = await admin
    .from("homework_assignments")
    .select("id, title, task_number, sap_number, max_score, module_id, parent_id, is_active, created_at, due_days_after_module_unlock")
    .eq("module_id", moduleId)
    .eq("is_active", true);
  const leaves = computeLeaves(((allAssignsForModule || []) as any));
  if (!leaves.length) return null;
  const leafIds = leaves.map((l: any) => l.id);
  const { data: existingSubs } = await admin
    .from("homework_submissions")
    .select("assignment_id, score")
    .eq("user_id", profileId)
    .in("assignment_id", leafIds);
  const asg =
    pickNextLeaf(leaves as any, (existingSubs || []) as any) ||
    [...leaves].sort((a: any, b: any) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0];
  if (!asg) return null;
  return { moduleId, assignment: asg, resolvedVia: "group_module_topic" };
}

// v3.14.41: Teacher-DM dedupe is now enforced inside notifyTeachersOfSubmission
// by message_url (per-submission), so resubmissions always notify.

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

    // STRICT MEDIA GATE: homework must be a photo, a video, or an uploaded file
    // (document) — e.g. a video sent "as a file" to preserve quality. Any other
    // message type (text, caption-only, voice, video_note, sticker, animation,
    // audio, poll, etc.) is ignored silently — casual chat in the topic must
    // never become a submission.
    let fileId: string | null = null;
    let kind: "photo" | "video" | "document" | null = null;
    if (Array.isArray(msg.photo) && msg.photo.length) {
      fileId = msg.photo[msg.photo.length - 1].file_id;
      kind = "photo";
    } else if (msg.video) {
      fileId = msg.video.file_id;
      kind = "video";
    } else if (msg.document) {
      fileId = msg.document.file_id;
      kind = "document";
    }
    if (!kind) {
      console.log("hw:group:non-media-ignored", JSON.stringify({ chatId, threadId, messageId }));
      return;
    }

    // Try to identify the student (only useful when not anonymous)
    let profile: any = null;
    if (fromId && !isAnon) {
      profile = await findProfileByTelegramId(admin, fromId);
    }

    // Strict per-student attribution. Submissions are only created by the
    // identified student who opened an intent via /vazifalar → 📤 Topshirish.
    if (!profile) {
      console.log("hw:group:unknown-sender-ignored", JSON.stringify({ fromId, isAnon, chatId, threadId, messageId }));
      return;
    }

    const nowIso = new Date().toISOString();
    const { data: intents, error: intentErr } = await admin
      .from("bot_homework_intents")
      .select("id, user_id, assignment_id, module_id, group_id")
      .eq("telegram_chat_id", chatId)
      .eq("telegram_thread_id", threadId)
      .eq("user_id", profile.id)
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: false })
      .limit(1);
    if (intentErr) console.error("hw:group:intent-query-err", intentErr);
    let intent = (intents && intents[0]) as any;

    // STRICT INTENT GATE: A submission requires an active intent created via
    // /vazifalar → 📤 Topshirish. Direct posts in the topic without going
    // through the bot are ignored — no synthesis, no submission, no DM.
    if (!intent) {
      console.log("hw:group:no-active-intent-ignored", JSON.stringify({
        profile_id: profile.id, chatId, threadId, messageId,
      }));
      return;
    }
    // Defensive — never attribute a message to a user other than the intent owner.
    if (intent.user_id !== profile.id) {
      console.log("hw:group:intent-user-mismatch", JSON.stringify({ intent_user: intent.user_id, sender_user: profile.id, chatId, threadId, messageId }));
      return;
    }

    // Already-graded short-circuit: react ✅ and DM "already scored", no resubmission row, no teacher DM.
    const { data: prior } = await admin
      .from("homework_submissions")
      .select("id, score, score_is_stale")
      .eq("user_id", profile.id)
      .eq("assignment_id", intent.assignment_id)
      .maybeSingle();
    if (prior && prior.score != null && !prior.score_is_stale) {
      try { await setMessageReaction(chatId, messageId, "✅"); } catch (_e) { /* ignore */ }
      if (profile.telegram_id) {
        const loc: Locale = normLocale(profile.preferred_locale);
        try { await sendMessage(profile.telegram_id, (T[loc] as any).hwIntentAlreadyScored); } catch (_e) { /* ignore */ }
      }
      console.log("hw:group:already-graded", JSON.stringify({ profile_id: profile.id, assignment_id: intent.assignment_id }));
      if (intent.id) await admin.from("bot_homework_intents").delete().eq("id", intent.id);
      return;
    }

    // Tier gate (Phase 2): never record a submission for a module beyond the student's tier
    // (defense-in-depth — the intent path already blocks this). Consume intent and stop.
    if (await isModuleBlocked(admin, profile.id, intent.module_id)) {
      console.log("hw:group:tier-locked-ignored", JSON.stringify({ profile_id: profile.id, module_id: intent.module_id }));
      if (intent.id) await admin.from("bot_homework_intents").delete().eq("id", intent.id);
      return;
    }


    const messageUrl = buildMessageLink(chatId, threadId, messageId);
    const submittedText = (msg.caption || msg.text || "").slice(0, 4000);

    // v3.14.39: bump attempt_number on every consumed-intent post so the
    // homework_submissions_guard trigger permits clearing a previously-set
    // score. Without this bump, a resubmission post is silently rolled back
    // to keep the old score, hiding the new attempt from the teacher's
    // pending list (both /galaba and the web dashboard filter by score IS NULL).
    const { data: existingSub } = await admin
      .from("homework_submissions")
      .select("attempt_number")
      .eq("user_id", profile.id)
      .eq("assignment_id", intent.assignment_id)
      .maybeSingle();
    const nextAttempt = ((existingSub?.attempt_number as number | null) ?? 0) + 1;

    // Upsert submission. Unique key (user_id, assignment_id) — idempotent.
    const { data: upserted, error: upErr } = await admin
      .from("homework_submissions")
      .upsert({
        user_id: profile.id,
        assignment_id: intent.assignment_id,
        submitted_text: submittedText,
        submitted_at: new Date().toISOString(),
        attempt_number: nextAttempt,
        score: null,
        score_feedback: null,
        scored_by: null,
        scored_at: null,
        score_is_stale: false,
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

    // Consume intent (only if it was persisted; synthesized intents have no row)
    if (intent.id) {
      await admin.from("bot_homework_intents").delete().eq("id", intent.id);
    }

    // ✅ React to confirm in-thread
    await setMessageReaction(chatId, messageId, "✅");

    // Locale + assignment meta for messages
    const locale: Locale = normLocale(profile.preferred_locale);
    const t = T[locale] as any;
    const { data: a } = await admin
      .from("homework_assignments")
      .select("title, task_number, sap_number, parent_id, module_id, modules(position)")
      .eq("id", intent.assignment_id)
      .maybeSingle();
    const mn = ((a?.modules?.position ?? 0) as number) + 1;
    const tn = (a?.task_number ?? 1) as number;
    let aTitle = a?.title || "";
    if (a?.parent_id) {
      const { data: par } = await admin.from("homework_assignments").select("task_number").eq("id", a.parent_id).maybeSingle();
      aTitle = `V${par?.task_number ?? "?"}.S${a?.sap_number ?? "?"} — ${a?.title || ""}`;
    }
    const moduleId = a?.module_id || intent.module_id;

    // Private DM to student (confirmation). Log Telegram errors so failures are visible.
    if (profile.telegram_id) {
      try {
        const resp = await sendMessage(profile.telegram_id, t.hwReceived(mn, tn));
        if (!resp.ok) {
          const errTxt = await resp.text().catch(() => "");
          console.error("hw:group:student-dm-fail", JSON.stringify({ profile_id: profile.id, status: resp.status, err: errTxt.slice(0, 200) }));
        } else {
          console.log("hw:group:student-dm-ok", JSON.stringify({ profile_id: profile.id, mn, tn }));
        }
      } catch (e) {
        console.error("hw:group:student-dm-exc", JSON.stringify({ profile_id: profile.id, err: String(e) }));
      }
    } else {
      console.log("hw:group:student-no-telegram-id", JSON.stringify({ profile_id: profile.id }));
    }

    // Teacher DM. Idempotency is enforced inside notifyTeachersOfSubmission by
    // message_url (Telegram webhook retries won't duplicate). New posts and
    // resubmissions always notify because they carry a fresh message URL.

    const subId = upserted?.id;
    await notifyTeachersOfSubmission(admin, profile, intent.group_id, mn, tn, aTitle, messageUrl, subId, intent.assignment_id, moduleId);

    // Invalidate any cached "stats" for the student so next /galaba is fresh
    cacheInvalidateUser(profile.id);
  } catch (e) {
    console.error("handleGroupTopicMessage error", e);
  }
}

// v3.14.40: auto-detect path removed — handleGroupTopicMessage now auto-synthesizes
// intents for sender-attributed topic posts. hwTeacherBody is still used by
// notifyTeachersOfSubmission below.
function hwTeacherBody(studentName: string, groupName: string, moduleName: string, assignmentTitle: string): string {
  return `🆕 <b>Yangi vazifa topshirildi</b>\n👤 Talaba: <b>${csvEscapeHtml(studentName)}</b>\n👥 Guruh: <b>${csvEscapeHtml(groupName)}</b>\n📚 Modul: <b>${csvEscapeHtml(moduleName)}</b>\n📝 Vazifa: <b>${csvEscapeHtml(assignmentTitle)}</b>\n\nXabarni topikda ko'ring va baholang.`;
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

    // Throttle: only dedupe DMs for the EXACT same submission row (e.g. webhook retries).
    // Resubmissions reuse the submission row but get a fresh telegram_message_url + reset score,
    // so they must always queue a new DM — see plan v3.14.38.
    const { data: recent } = await admin
      .from("homework_teacher_dm_queue")
      .select("id, message_url")
      .eq("submission_id", submissionId)
      .limit(5);
    if (recent && recent.some((r: any) => r.message_url === messageUrl)) return;

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

    const { data: queued } = await admin.from("homework_teacher_dm_queue").insert({
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
    }).select("id").maybeSingle();

    // Immediate teacher DM (skip during quiet hours so cron delivers at 08:00)
    if (!quiet) {
      const { data: teacher } = await admin
        .from("profiles")
        .select("id, telegram_id, notifications_enabled, name, last_name")
        .eq("id", teacherId)
        .maybeSingle();
      if (!teacher?.telegram_id || teacher.notifications_enabled === false) {
        console.log("hw:group:teacher-skip", JSON.stringify({ teacher_id: teacherId, has_tg: !!teacher?.telegram_id, notif: teacher?.notifications_enabled }));
      } else {
        const { data: grp } = await admin.from("groups").select("name").eq("id", groupId).maybeSingle();
        const moduleName = `Modul ${mn}`;
        const body = hwTeacherBody(studentName, grp?.name || "—", moduleName, aTitle || "");
        const inlineKb = [
          [{ text: "🎯 Baholash", callback_data: `grade_task:${assignmentId}:${studentProfile.id}` }],
          [{ text: "📌 Topikga o'tish", url: messageUrl }],
        ];
        try {
          const resp = await sendMessage(Number(teacher.telegram_id), body, { inline_keyboard: inlineKb });
          let okBody: any = null;
          try { okBody = await resp.clone().json(); } catch { /* ignore */ }
          if (resp.ok && okBody?.ok) {
            if (queued?.id) {
              await admin.from("homework_teacher_dm_queue").update({ sent_at: new Date().toISOString() }).eq("id", queued.id);
            }
            console.log("hw:group:teacher-dm-ok", JSON.stringify({ teacher_id: teacherId, submission_id: submissionId }));
          } else {
            const errTxt = okBody ? JSON.stringify(okBody).slice(0, 200) : await resp.text().catch(() => "");
            console.error("hw:group:teacher-dm-fail", JSON.stringify({ teacher_id: teacherId, status: resp.status, err: String(errTxt).slice(0, 200) }));
            // leave queue row unsent so cron retries
          }
        } catch (e) {
          console.log("teacher_dm_immediate_failed", JSON.stringify({ teacher_id: teacherId, err: String(e) }));
          // leave queue row unsent so cron retries
        }
      }
    }
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

  // Resolve effective actor (honor admin impersonation via bot_sessions)
  const _clicker = await findProfileByTelegramId(admin, tgId);
  let _effId: string | null = _clicker?.id ?? null;
  let _effPersona: any = _clicker ? await getPersona(admin, _clicker.id) : null;
  let _isImp = false;
  if (_clicker && _effPersona === "admin") {
    const { data: _imp } = await admin.from("bot_sessions").select("state, data").eq("user_id", _clicker.id).maybeSingle();
    if (_imp?.state === "impersonate" && _imp?.data?.as_user_id) {
      _effId = _imp.data.as_user_id;
      _effPersona = _imp.data.as_persona;
      _isImp = true;
    }
  }
  if (_isImp && (/^grade_task:|^grade:open:|^gs:open:|^settings:|^setlang:/.test(data) || /^hw:(start|resub_yes):/.test(data))) {
    await answerCallback(cq.id, "👁 Faqat o'qish — /admin");
    return;
  }

  // --- Profile card callbacks (student: prof:*, teacher group switch: tprof:g:*) ---
  if (data.startsWith("prof:") && chatId) {
    if (!_effId) { await answerCallback(cq.id); return; }
    const locale: Locale = normLocale(_clicker?.preferred_locale);
    const action = data.slice("prof:".length);
    await answerCallback(cq.id);
    if (action === "card") {
      const { text, keyboard } = await buildProfileCard(admin, _effId, locale);
      await sendMessage(chatId, text, keyboard);
    } else if (action === "stats") {
      const text = await buildStatsMessage(admin, _effId, locale);
      const url = await createMagicLink(admin, _effId, "login", "/profile");
      await sendMessage(chatId, text, { inline_keyboard: [[{ text: PROF_T[locale].btnProfOpen, url }]] });
    } else if (action === "badges") {
      await sendMessage(chatId, await buildBadgesMessage(admin, _effId, locale));
    } else if (action === "group") {
      await sendMessage(chatId, await buildGroupBoardMessage(admin, _effId, locale));
    }
    return;
  }

  if (data.startsWith("tprof:g:") && chatId) {
    // One-tap group switch: re-render the teacher profile card in place.
    if (!_effId || (_effPersona !== "teacher" && _effPersona !== "admin")) { await answerCallback(cq.id); return; }
    const locale: Locale = normLocale(_clicker?.preferred_locale);
    const gid = data.slice("tprof:g:".length);
    // Persist as the active group so other teacher flows follow along.
    if (!_isImp) await admin.from("profiles").update({ active_teacher_group_id: gid }).eq("id", _effId);
    const { text, keyboard } = await buildTeacherProfileCard(admin, _effId, locale, gid);
    await answerCallback(cq.id);
    await tgApi("editMessageText", {
      chat_id: chatId,
      message_id: cq.message?.message_id,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
    return;
  }

  // --- "Confirm your name" flow callbacks ---
  if (data.startsWith("name:") && chatId) {
    if (!_clicker) { await answerCallback(cq.id); return; }
    if (_isImp) { await answerCallback(cq.id); return; }
    const locale: Locale = normLocale(_clicker.preferred_locale);
    const t = T[locale] as any;
    const action = data.slice("name:".length);

    if (action === "ok") {
      await admin.from("profiles").update({ name_confirmed_at: new Date().toISOString() }).eq("id", _clicker.id);
      await answerCallback(cq.id);
      await sendMessage(chatId, t.nameConfirmedOk);
      return;
    }
    if (action === "edit" || action === "retry") {
      await admin.from("bot_conversation_state").upsert({
        telegram_id: tgId,
        state: "awaiting_name",
        context: {},
        updated_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      await answerCallback(cq.id);
      await sendMessage(chatId, t.nameAskInput);
      return;
    }
    if (action === "later") {
      await answerCallback(cq.id);
      await sendMessage(chatId, t.nameLater);
      return;
    }
    if (action === "yes") {
      const { data: st } = await admin
        .from("bot_conversation_state")
        .select("state, context, expires_at")
        .eq("telegram_id", tgId)
        .maybeSingle();
      const ctx = (st?.context || {}) as any;
      const notExpired = st?.expires_at ? new Date(st.expires_at).getTime() > Date.now() : false;
      if (st?.state === "confirm_name" && notExpired && typeof ctx.first === "string" && ctx.first) {
        await admin.from("profiles").update({
          name: ctx.first,
          last_name: ctx.last || null,
          name_confirmed_at: new Date().toISOString(),
        }).eq("id", _clicker.id);
        await admin.from("bot_conversation_state").delete().eq("telegram_id", tgId);
        cacheInvalidateUser(_clicker.id);
        await answerCallback(cq.id);
        const disp = `${ctx.first}${ctx.last ? " " + String(ctx.last).charAt(0) + "." : ""}`;
        await sendMessage(chatId, t.nameSaved(disp));
      } else {
        await answerCallback(cq.id);
      }
      return;
    }
    await answerCallback(cq.id);
    return;
  }



  // Student tapped a per-module button in /vazifalar — show per-SAP submit buttons for that module.
  if (data.startsWith("hw:mod:") && chatId) {
    const moduleId = data.slice("hw:mod:".length);
    if (!_clicker) { await answerCallback(cq.id); return; }
    await answerCallback(cq.id);
    const { data: allList } = await admin
      .from("homework_assignments")
      .select("id, title, max_score, task_number, sap_number, parent_id, module_id, is_active, modules(id, title, position)")
      .eq("module_id", moduleId)
      .eq("is_active", true);
    const list = (allList || []) as any[];
    if (!list.length) { await sendMessage(chatId, "Vazifa topilmadi."); return; }
    const parentIdsWithSap = new Set(list.filter((a) => a.parent_id).map((a) => a.parent_id));
    const leaves = list.filter((a) => a.parent_id || !parentIdsWithSap.has(a.id));
    const parentTaskNum = new Map<string, number>();
    list.filter((a) => !a.parent_id).forEach((p) => parentTaskNum.set(p.id, p.task_number || 1));
    leaves.sort((a, b) => (a.task_number ?? 1) - (b.task_number ?? 1) || ((a.sap_number ?? 0) - (b.sap_number ?? 0)));
    const leafIds = leaves.map((a) => a.id);
    const { data: subs } = await admin
      .from("homework_submissions")
      .select("id, assignment_id, score")
      .eq("user_id", _effId)
      .in("assignment_id", leafIds);
    const subMap = new Map((subs || []).map((s: any) => [s.assignment_id, s]));
    const modulePos = (list[0]?.modules?.position ?? 0) + 1;
    const moduleTitle = list[0]?.modules?.title || "";
    const buttons: any[][] = [];
    let seq = 0;
    for (const a of leaves) {
      seq++;
      const tnLabel = `Vazifa ${a.sap_number ?? a.task_number ?? seq}`;
      const title = (a.title || "").slice(0, 30);
      const s: any = subMap.get(a.id);
      if (s && s.score != null) {
        buttons.push([{ text: `🔁 ${tnLabel} — ${s.score}/${a.max_score} — qayta topshirish`, callback_data: `hw:resub_ask:${a.id}` }]);
      } else if (s) {
        buttons.push([{ text: `⏳ ${tnLabel} — kutilmoqda`, callback_data: `hw:start:${a.id}` }]);
      } else {
        buttons.push([{ text: `📤 ${tnLabel} — ${title}`, callback_data: `hw:start:${a.id}` }]);
      }
    }
    await sendMessage(chatId, `📝 ${modulePos}-MODUL — ${moduleTitle}\n\nVazifani qayta topshirish uchun, pastdagi tugmalardan birini bosib, topshiring`, { inline_keyboard: buttons });
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

  // Student tapped "🔁 qayta topshirish" — confirm with Yes/No before resetting score.
  if (data.startsWith("hw:resub_ask:") && chatId) {
    const assignmentId = data.slice("hw:resub_ask:".length);
    if (!_clicker) { await answerCallback(cq.id); return; }
    const locale: Locale = normLocale(_clicker.preferred_locale);
    const t = T[locale] as any;
    await answerCallback(cq.id);
    const { data: a } = await admin
      .from("homework_assignments")
      .select("id, max_score")
      .eq("id", assignmentId).maybeSingle();
    const { data: sub } = await admin
      .from("homework_submissions")
      .select("id, score, score_feedback")
      .eq("user_id", _effId).eq("assignment_id", assignmentId)
      .maybeSingle();
    if (!a || !sub || sub.score == null) {
      await sendMessage(chatId, t.gradeNotFound);
      return;
    }
    await sendMessage(chatId, t.hwResubAsk(sub.score, a.max_score, sub.score_feedback || ""), {
      inline_keyboard: [[
        { text: t.hwResubYes, callback_data: `hw:resub_yes:${assignmentId}` },
        { text: t.hwResubNo, callback_data: `hw:resub_no:${assignmentId}` },
      ]],
    });
    return;
  }

  if (data.startsWith("hw:resub_no:") && chatId) {
    const locale: Locale = normLocale(_clicker?.preferred_locale);
    const t = T[locale] as any;
    await answerCallback(cq.id, "OK");
    await sendMessage(chatId, t.hwResubCancelled);
    return;
  }

  if (data.startsWith("hw:resub_yes:") && chatId) {
    const assignmentId = data.slice("hw:resub_yes:".length);
    const profile = await findProfileByTelegramId(admin, tgId);
    if (!profile) { await answerCallback(cq.id); return; }
    const locale: Locale = normLocale(profile.preferred_locale);
    const t = T[locale] as any;
    await answerCallback(cq.id);
    const { data: sub } = await admin
      .from("homework_submissions")
      .select("id")
      .eq("user_id", profile.id).eq("assignment_id", assignmentId)
      .maybeSingle();
    if (!sub?.id) {
      await sendMessage(chatId, t.gradeNotFound);
      return;
    }
    const { error: rpcErr } = await admin.rpc("start_homework_resubmission", { p_submission_id: sub.id });
    if (rpcErr) {
      console.error("start_homework_resubmission failed", rpcErr);
      await sendMessage(chatId, t.hwResubError);
      return;
    }
    cacheInvalidateUser(profile.id);
    await startHomeworkIntent(admin, chatId, profile, locale, assignmentId);
    return;
  }


  // v3.14.32: teacher taps "🎯 Baholash" on auto-detected submission DM.
  if (data.startsWith("grade_task:") && chatId) {
    const parts = data.split(":");
    const assignmentId = parts[1];
    const studentProfileId = parts[2];
    const profile = await findProfileByTelegramId(admin, tgId);
    if (!profile) { await answerCallback(cq.id); return; }
    const persona = await getPersona(admin, profile.id);
    if (persona !== "admin" && persona !== "teacher") { await answerCallback(cq.id); return; }
    const { data: sub } = await admin
      .from("homework_submissions")
      .select("id")
      .eq("user_id", studentProfileId)
      .eq("assignment_id", assignmentId)
      .maybeSingle();
    await answerCallback(cq.id);
    if (!sub?.id) {
      await sendMessage(chatId, "Topshiriq topilmadi.");
      return;
    }
    const locale: Locale = normLocale(profile.preferred_locale);
    await startGradingFlow(admin, chatId, tgId, profile.id, sub.id, locale, persona === "admin");
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

  // Teacher: re-show group picker
  // Teacher: per-module homework drilldown (thw:sub / thw:not : <groupId> : <moduleId>)
  if ((data.startsWith("thw:sub:") || data.startsWith("thw:not:")) && chatId) {
    if (!_clicker) { await answerCallback(cq.id); return; }
    if (_effPersona !== "teacher" && _effPersona !== "admin") { await answerCallback(cq.id); return; }
    const isSubmitted = data.startsWith("thw:sub:");
    const rest = data.slice(isSubmitted ? "thw:sub:".length : "thw:not:".length);
    const sep = rest.indexOf(":");
    if (sep <= 0) { await answerCallback(cq.id); return; }
    const groupId = rest.slice(0, sep);
    const moduleId = rest.slice(sep + 1);
    // Validate teacher owns group (admins ok)
    if (_effPersona === "teacher") {
      const groups = await teacherGroups(admin, _effId);
      if (!groups.find((x) => x.id === groupId)) { await answerCallback(cq.id, "⛔"); return; }
    }
    await answerCallback(cq.id);
    // Load group, module, students, submissions
    const [{ data: grp }, { data: mod }, { data: profs }, { data: asgs }] = await Promise.all([
      admin.from("groups").select("id,name").eq("id", groupId).maybeSingle(),
      admin.from("modules").select("id,position,title").eq("id", moduleId).maybeSingle(),
      admin.from("profiles").select("id,name,last_name,telegram_username,telegram_id").eq("group_id", groupId).is("archived_at", null),
      admin.from("homework_assignments").select("id,title,task_number").eq("module_id", moduleId).eq("is_active", true),
    ]);
    const students = (profs || []) as any[];
    const asgIds = ((asgs || []) as any[]).map((a) => a.id);
    const asgMap = new Map(((asgs || []) as any[]).map((a) => [a.id, a]));
    const { data: subs } = asgIds.length
      ? await admin.from("homework_submissions").select("user_id, assignment_id, telegram_message_url").in("assignment_id", asgIds).in("user_id", students.map((s) => s.id))
      : { data: [] as any[] };
    const byUser = new Map<string, any[]>();
    ((subs || []) as any[]).forEach((s) => {
      const arr = byUser.get(s.user_id) || [];
      arr.push(s);
      byUser.set(s.user_id, arr);
    });
    const tag = `M${(mod?.position ?? 0) + 1}`;
    const title = (mod?.title || "").slice(0, 40);
    const groupName = grp?.name || "";
    const submitted = students.filter((s) => byUser.has(s.id));
    const notSubmitted = students.filter((s) => !byUser.has(s.id));
    const list = isSubmitted ? submitted : notSubmitted;
    const fmtName = (p: any) => {
      const handle = (p.telegram_username || "").toString().trim();
      const h = handle ? (handle.startsWith("@") ? handle : `@${handle}`) : (p.telegram_id ? `(id:${p.telegram_id})` : "—");
      const n = [p.name, p.last_name].filter(Boolean).join(" ").trim();
      return n ? `<b>${csvEscapeHtml(n)}</b> ${csvEscapeHtml(h)}` : csvEscapeHtml(h);
    };
    const header = `${isSubmitted ? "✅" : "❌"} <b>${tag} — ${isSubmitted ? "Topshirgan" : "Topshirmagan"}</b> (${list.length}/${students.length})\n<i>${csvEscapeHtml(groupName)} · ${csvEscapeHtml(title)}</i>`;
    if (!list.length) {
      await sendMessage(chatId, `${header}\n\n—`);
      return;
    }
    const lines = list.map((p) => {
      if (isSubmitted) {
        const items = (byUser.get(p.id) || []).map((s) => {
          const a = asgMap.get(s.assignment_id) as any;
          const label = a ? `${tag}·V${a.task_number}` : "vazifa";
          return s.telegram_message_url ? `<a href="${s.telegram_message_url}">${label}</a>` : label;
        }).join(", ");
        return `• ${fmtName(p)} — ${items}`;
      }
      return `• ${fmtName(p)}`;
    });
    const MAX = 3500;
    let buf = header + "\n\n";
    for (const ln of lines) {
      if ((buf + ln + "\n").length > MAX) {
        await sendMessage(chatId, buf);
        buf = "";
      }
      buf += ln + "\n";
    }
    if (buf.trim().length) await sendMessage(chatId, buf);
    return;
  }

  if (data === "tg:switch" && chatId) {
    if (!_clicker || _effPersona !== "teacher") { await answerCallback(cq.id); return; }
    const locale: Locale = normLocale(_clicker.preferred_locale);
    const groups = await teacherGroups(admin, _effId);
    await answerCallback(cq.id);
    if (groups.length >= 2) await showGroupPicker(chatId, locale, "switch", groups);
    return;
  }
  // Teacher group picker: tg:pick:<action>:<groupId>  (action = "switch" or a teacher cmd key)
  if (data.startsWith("tg:pick:") && chatId) {
    const rest = data.slice("tg:pick:".length);
    const idx = rest.lastIndexOf(":");
    if (idx <= 0) { await answerCallback(cq.id); return; }
    const action = rest.slice(0, idx);
    const groupId = rest.slice(idx + 1);
    if (!_clicker || _effPersona !== "teacher") { await answerCallback(cq.id); return; }
    const locale: Locale = normLocale(_clicker.preferred_locale);
    const t = T[locale] as any;
    if (_isImp && action === "baholash") { await answerCallback(cq.id, "👁 Faqat o'qish — /admin"); return; }
    const groups = await teacherGroups(admin, _effId);
    const g = groups.find((x) => x.id === groupId);
    if (!g) { await answerCallback(cq.id); return; }
    await admin.from("profiles").update({ active_teacher_group_id: g.id }).eq("id", _effId);
    await answerCallback(cq.id);
    if (action === "switch") {
      await sendWithKeyboard(chatId, t.tGroupSwitched(g.name), locale, false, "teacher");
    } else {
      const cmd = TEACHER_ACTION_CMD[action];
      if (cmd) await handleTeacherCommand(admin, chatId, _effId, locale, cmd, g.id);
    }
    return;
  }
  if ((data.startsWith("gs:list:") || data.startsWith("gs:pick:") || data.startsWith("gs:open:") || data.startsWith("tr:") || data.startsWith("thm:")) && chatId) {
    if (!_clicker) { await answerCallback(cq.id); return; }
    if (_effPersona !== "admin" && _effPersona !== "teacher") { await answerCallback(cq.id); return; }
    const locale: Locale = normLocale(_clicker.preferred_locale);
    const isAdmin = _effPersona === "admin";
    let groupIdScope: string | null = null;
    if (!isAdmin) {
      const { data: pr } = await admin.from("profiles").select("active_teacher_group_id").eq("id", _effId).maybeSingle();
      groupIdScope = pr?.active_teacher_group_id || null;
    }
    await answerCallback(cq.id);
    if (data.startsWith("gs:list:")) {
      const page = parseInt(data.slice("gs:list:".length), 10) || 0;
      await renderStudentPicker(admin, chatId, _effId, locale, isAdmin, page, groupIdScope);
    } else if (data.startsWith("gs:pick:")) {
      const sid = data.slice("gs:pick:".length);
      await renderStudentBreakdown(admin, chatId, _effId, sid, locale, isAdmin);
    } else if (data.startsWith("gs:open:")) {
      const subId = data.slice("gs:open:".length);
      await startGradingFlow(admin, chatId, tgId, _effId, subId, locale, isAdmin);
    } else if (data.startsWith("tr:list:")) {
      const page = parseInt(data.slice("tr:list:".length), 10) || 0;
      await renderTeacherRoster(admin, chatId, _effId, locale, isAdmin, page, groupIdScope);
    } else if (data.startsWith("tr:stu:")) {
      const sid = data.slice("tr:stu:".length);
      await renderStudentModules(admin, chatId, _effId, sid, locale, isAdmin);
    } else if (data.startsWith("tr:mod:")) {
      const rest = data.slice("tr:mod:".length);
      const [sid, mid] = rest.split(":");
      if (sid && mid) await renderStudentModuleDetail(admin, chatId, _effId, sid, mid, locale, isAdmin);
    } else if (data.startsWith("thm:list:")) {
      const page = parseInt(data.slice("thm:list:".length), 10) || 0;
      await renderTeacherModulePicker(admin, chatId, _effId, locale, isAdmin, page, groupIdScope);
    } else if (data.startsWith("thm:mod:")) {
      const mid = data.slice("thm:mod:".length);
      if (mid) await renderTeacherModuleDetail(admin, chatId, _effId, mid, locale, isAdmin, groupIdScope);
    }
    return;
  }

  if (data.startsWith("setlang:") && chatId) {
    const lang = data.split(":")[1] as Locale;
    if (["uz", "ru", "en"].includes(lang)) {
      const profile = await findProfileByTelegramId(admin, tgId);
      let persona: Persona = "student";
      if (profile) {
        await admin.from("profiles").update({ preferred_locale: lang }).eq("id", profile.id);
        persona = await getPersona(admin, profile.id);
      }
      await answerCallback(cq.id);
      await sendWithKeyboard(chatId, T[lang].langSet, lang, persona === "admin", persona);
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

  // Internal ops branch (not from Telegram): migration broadcast, guarded by
  // INTERNAL_FN_SECRET — same pattern as the canary/cron functions.
  const internalSecret = req.headers.get("x-internal-secret") || "";
  const INTERNAL = Deno.env.get("INTERNAL_FN_SECRET") || "";
  if (internalSecret && INTERNAL && internalSecret === INTERNAL) {
    let body: any = {};
    try { body = await req.json(); } catch { /* ignore */ }
    if (body?.action === "migration_broadcast") {
      const adminC = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const report = await runMigrationBroadcast(adminC, body.mode === "all" ? "all" : "test");
      return new Response(JSON.stringify(report), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "unknown action" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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

  // v3.14.33: persist EVERY incoming update to webhook_inbox (best-effort, never fails request).
  const inboxId = await logWebhookInbox(admin, update);

  try {
    // Treat both message and channel_post as inbound for group topics (forum supergroups can deliver either)
    const inbound = update.message || update.channel_post;
    if (inbound) {
      const msg = inbound;
      // Group/supergroup posts (e.g. inside a forum topic) → homework intake only
      const chatType = msg.chat?.type;
      if (chatType === "supergroup" || chatType === "group" || chatType === "channel") {
        // v3.14.29: passively record topic messages for Statistika analytics.
        try { await recordGroupMessageEvent(admin, msg); } catch (e) { console.error("recordGroupMessageEvent failed", e); }
        // v3.14.40: handleGroupTopicMessage now auto-synthesizes an intent for the
        // sender when there's no pending /vazifalar intent. Strict per-sender
        // attribution is preserved inside the handler (anon/bot/unknown senders
        // are ignored; one student's post can never overwrite another's row).
        await updateInboxResolution(admin, inboxId, { skip_reason: "delegated_to_handler", homework_detector_fired: false });
        await handleGroupTopicMessage(admin, msg);
        return new Response("ok", { status: 200, headers: corsHeaders });
      }
    }
    if (update.message) {
      const msg = update.message;
      const text: string = msg.text || "";
      const tgUsername = (msg.from.username || "").toLowerCase();
      // v3.14.32: identity gate ONLY runs for private chats. Group/supergroup/channel
      // posts are handled above and must not be short-circuited here.
      const isPrivateChat = msg.chat?.type === "private";
      // v3.14.27: identity gate. Login deeplinks are the ONE exception (token carries identity).
      const isStartLogin = text.startsWith("/start ") && text.slice(7).trim().startsWith("login_");
      let profileForLocale: any = null;
      if (!isStartLogin) {
        profileForLocale = await resolveProfileForTelegramUser(admin, msg.from.id, tgUsername, "bot");
        if (!profileForLocale) {
          if (!isPrivateChat) {
            // Non-private and unregistered: silently ignore (no rate-limited reply).
            return new Response("ok", { status: 200, headers: corsHeaders });
          }
          // /myid is allowed for unregistered users so they can share their id with admin.
          if (text === "/myid") {
            const loc: Locale = normLocale(msg.from.language_code);
            await sendMessage(msg.chat.id, T[loc].myidResponse(msg.from.id));
          } else {
            await sendUnregisteredReply(admin, msg.chat.id, msg.from);
          }
          return new Response("ok", { status: 200, headers: corsHeaders });
        }
      }
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
        } else {
          await sendWithKeyboard(msg.chat.id, T[locale].helpReply, locale, adminFlag, persona);
        }
      } else if (text === "/start") {
        await sendWithKeyboard(msg.chat.id, T[locale].helpReply, locale, adminFlag, persona);
      } else if (text.startsWith("/")) {
        // Grading session intercepts /skip and /cancel for the in-progress flow
        if ((persona === "teacher" || persona === "admin") && profileForLocale) {
          const cmd0 = text.split(/\s+/)[0].toLowerCase();
          const passCmd = (cmd0 === "/asteacher" || cmd0 === "/aststudent") ? text.trim() : cmd0;
          if (cmd0 === "/skip" || cmd0 === "/cancel") {
            const consumed = await handleGradingSession(admin, msg, profileForLocale.id, locale, persona === "admin");
            if (consumed) { /* done */ }
            else { await handleCommand(admin, msg, passCmd); }
          } else {
            await handleCommand(admin, msg, passCmd);
          }
        } else {
          const cmd0 = text.split(/\s+/)[0].toLowerCase();
          const passCmd = (cmd0 === "/asteacher" || cmd0 === "/aststudent") ? text.trim() : cmd0;
          await handleCommand(admin, msg, passCmd);
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
        if (!consumed && profileForLocale && persona === "student") {
          // "Confirm your name" text capture (awaiting_name → confirm_name)
          try {
            const { data: nst } = await admin
              .from("bot_conversation_state")
              .select("state, expires_at")
              .eq("telegram_id", msg.from.id)
              .maybeSingle();
            if (nst?.state === "awaiting_name" && nst.expires_at && new Date(nst.expires_at).getTime() > Date.now()) {
              const t = T[locale] as any;
              const parsed = normalizeNameInput(text);
              if (!parsed) {
                await sendMessage(msg.chat.id, t.nameInvalid);
              } else {
                await admin.from("bot_conversation_state").upsert({
                  telegram_id: msg.from.id,
                  state: "confirm_name",
                  context: { first: parsed.first, last: parsed.last },
                  updated_at: new Date().toISOString(),
                  expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
                });
                await sendMessage(msg.chat.id, t.namePreview(parsed.first, parsed.last), { inline_keyboard: [[
                  { text: t.nameBtnYes, callback_data: "name:yes" },
                  { text: t.nameBtnRetry, callback_data: "name:retry" },
                ]] });
              }
              consumed = true;
            }
          } catch (_e) { /* best-effort */ }
        }
        if (!consumed) {
          const mapped = buttonTextToCommand(text);
          if (mapped) await handleCommand(admin, msg, mapped);
          else if (isPrivateChat) await sendWithKeyboard(msg.chat.id, T[locale].kbHint, locale, adminFlag, persona);
        }
      }
    } else if (update.callback_query) {
      // v3.14.27: gate every callback on registered profile.
      const cq = update.callback_query;
      const tgUsername = (cq.from.username || "").toLowerCase();
      const cbProfile = await resolveProfileForTelegramUser(admin, cq.from.id, tgUsername, "bot");
      if (!cbProfile) {
        try { await answerCallback(cq.id); } catch (_e) {}
        if (cq.message?.chat?.id) {
          await sendUnregisteredReply(admin, cq.message.chat.id, cq.from);
        }
        return new Response("ok", { status: 200, headers: corsHeaders });
      }
      await handleCallback(admin, cq);
    }
  } catch (e) {
    console.error("update handler error", e);
  }

  // Always 200 OK so Telegram doesn't retry
  return new Response("ok", { status: 200, headers: corsHeaders });
});
