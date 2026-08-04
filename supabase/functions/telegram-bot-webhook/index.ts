// Telegram bot webhook. Receives Updates from api.telegram.org via setWebhook.
// Verifies X-Telegram-Bot-Api-Secret-Token, then dispatches commands.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { computeLeaves, displayStepNumber, pickNextLeaf } from "./homework-routing.ts";
import { effectiveLeafGrades, summarizeHomework } from "./homework-stats.ts";
import {
  checksAllGreen, ghAddLabel, ghClosePr, ghFetchChecks, ghFetchPr, ghMergePr,
  OPS_REPO, parseOpsCallback, verifyOpsPr,
} from "./ops-approve.ts";

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

// Homework capture config (platform_settings key 'homework_capture'):
//   {"mode":"auto"}  (DEFAULT) — auto-synthesize a submission from any qualifying media post in the
//     homework topic. Frictionless; catches direct posts. Today's behavior.
//   {"mode":"require_intent","course_ids":[...]} — ENFORCE the bot flow for students in the listed
//     courses (empty/omitted list = ALL courses): only posts made AFTER /vazifalar → 📤 Topshirish
//     count; un-initiated posts get a one-time hint and are NOT captured (no submission, no teacher
//     ping). Kills question/chat false-positives. Scoped so e.g. only 5.0 is affected, not finished 4.0.
//   {"mode":"picker","course_ids":[...]} — ASK, THEN GUESS: a media post is held in hw_pending_posts
//     and the bot replies in-thread with module→task inline buttons (owner-locked). On pick the
//     submission is created for the chosen task; if the student ignores it (~10 min) the smart
//     auto-tag fallback files it anyway — work is never lost. Explicit /vazifalar intents bypass
//     the picker entirely (the student already chose).
//   "auto_register": true — an UNKNOWN Telegram member posting valid homework media in a
//     registered homework topic is auto-registered as a PROVISIONAL student (name/username/id
//     taken from their Telegram profile — no form to fill) and their work is accepted normally.
//     Existing platform students matched by username just gain their telegram_id — their
//     account type is NEVER touched.
// Missing/malformed row ⇒ auto, so deploying this code changes nothing until the flag is flipped.
async function getHomeworkCaptureConfig(admin: any): Promise<{ mode: "auto" | "require_intent" | "picker"; courseIds: string[]; autoRegister: boolean }> {
  try {
    const { data } = await admin.from("platform_settings").select("value").eq("key", "homework_capture").maybeSingle();
    const v = (data?.value as any) || {};
    const mode = v.mode === "require_intent" ? "require_intent" : (v.mode === "picker" ? "picker" : "auto");
    const courseIds = Array.isArray(v.course_ids) ? v.course_ids.filter((x: any) => typeof x === "string") : [];
    return { mode, courseIds, autoRegister: v.auto_register === true };
  } catch (_e) {
    return { mode: "auto", courseIds: [], autoRegister: false };
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
    nmNotMember: "Bu bot faqat AI Creators talabalari uchun.",
    nmWelcome: (name: string) => `👋 <b>${name}</b>, xush kelibsiz! Akkountingiz yaratildi (sinov hisobi) — vazifalaringiz qabul qilinadi, ball va statistika yuritiladi. Darsliklar to'liq to'lovdan so'ng ochiladi. Quyidagi menyudan foydalaning 👇`,
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
    adminKbAnalytics: "📊 Statistika",
    adminKbBroadcast: "📣 Ommaviy xabar",
    adminKbClaude: "🤖 Claude Code",
    ccPrompt: "✍️ Claude Code bajaradigan vazifani yozing (bitta xabar).\nBekor qilish: /cancel",
    ccQueuedOnline: "⚙️ Qabul qilindi — Claude Code ishlayapti. Natija shu yerga keladi.",
    ccQueuedOffline: (n: number) => `⚠️ Noutbuk hozir o'chiq. Vazifa navbatga qo'yildi (navbatda ${n} ta) — noutbuk yoqilganda bajariladi.`,
    ccCancelled: "Bekor qilindi 👍",
    ccDenied: "⛔ Bu funksiya faqat platforma egasi uchun.",
    astGroupsHint: "👇 Guruh bo'yicha batafsil:",
    astBack: "← Umumiy",
    astRefresh: "🔄 Yangilash",
    adminHw7d: "7 kunda topshirilgan vazifalar",
    adminHwPending: "Baholanmagan vazifalar",
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
    tKbHomework: "📚 Vazifalar",
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
    gradeAskComment: "Izoh yozing yoki 🎤 ovozli xabar yuboring (yoki /skip):",
    gradeVoiceNote: "🎧 O'qituvchidan ovozli izoh:",
    gradeBadScore: (max: number) => `Bal 0–${max} oralig'ida bo'lishi kerak.`,
    gradeSaved: (sc: number, mx: number) => `✅ Saqlandi: ${sc}/${mx}. Talaba xabardor qilindi.`,
    gradeStudentDM: (title: string, sc: number, mx: number, fb: string) =>
      `🎉 Vazifangiz baholandi!\n\n📝 <b>${title}</b>\nBaho: <b>${sc}/${mx}</b>${fb ? `\nIzoh: ${fb}` : ""}`,
    gradeCancelled: "Bekor qilindi.",
    gradeNotFound: "Vazifa topilmadi.",
    gradePickStudent: "📝 <b>Talabani tanlang:</b>",
    gradePickGroup: "📝 <b>Qaysi guruhni baholaysiz?</b>",
    gradeAllGroupsBtn: (n: number) => `🌐 Hammasi (${n})`,
    gradePendingPickers: (n: number) => `⏳ ${n} ta talaba vazifa tanlamoqda — birozdan so'ng avtomatik qo'shiladi.`,
    retagBtn: "✏️ Vazifani o'zgartirish",
    retagPickModule: "✏️ Qaysi modulga o'tkazamiz?",
    retagPickTask: (m: string) => `✏️ ${m} — qaysi vazifa?`,
    retagDone: (lbl: string) => `✅ O'tkazildi: <b>${lbl}</b>. Endi baho qo'yishingiz mumkin.`,
    retagGraded: "Baholangan ishni o'zgartirib bo'lmaydi",
    retagTargetGraded: "U vazifada allaqachon baholangan ish bor",
    retagSame: "Bu o'sha vazifaning o'zi",
    retagNoTasks: "Bu modulda faol vazifa yo'q.",
    retagStudentNote: (lbl: string) => `✏️ O'qituvchi topshirig'ingizni <b>${lbl}</b> vazifasiga o'tkazdi. Ball va tarix saqlanadi.`,
    pkAsk: "📋 Bu qaysi vazifa? Quyidan tanlang.\n<i>Tanlamasangiz ham qabul qilinadi — 10 daqiqadan so'ng avtomatik belgilanadi.</i>",
    pkRemind: "☝️ Rasm/videongiz qabul qilindi. Iltimos, bu qaysi vazifa ekanini tanlang 👇",
    pkAskTask: (m: string) => `📋 ${m} — qaysi vazifa?`,
    pkBack: "⬅️ Modullar",
    pkDone: (lbl: string) => `✅ ${lbl} qabul qilindi`,
    pkNotYours: "Bu boshqa talabaning topshirig'i 🙂",
    pkExpired: "Muddati o'tgan — vazifa avtomatik belgilangan.",
    pkGradedAlready: "Bu vazifa allaqachon baholangan. Boshqasini tanlang.",
    pkTierLocked: "Bu modul sizning tarifingizda yopiq.",
    pkWrongTopic: (url: string) => `⚠️ Bu boshqa guruh topigi. Vazifangizni o'z guruhingiz topigiga yuboring: ${url}`,
    pkResubAsk: (lbl: string, sc: number, mx: number) => `⚠️ ${lbl} allaqachon baholangan: <b>${sc}/${mx}</b>.\nQayta topshirsangiz, eski baho bekor qilinadi va o'qituvchi qaytadan baholaydi.`,
    pkResubYes: "🔄 Ha, qayta topshirish",
    pkDoneMsg: (lbl: string) => `✅ <b>${lbl}</b> qabul qilindi — o'qituvchi tekshiradi.`,
    pkPrevGrade: (sc: number, mx: number) => `📊 Oldingi baho: <b>${sc}/${mx}</b>`,
    pkExistingAsk: (lbl: string, n: number, gradeLine: string) => `📎 <b>${lbl}</b> — bu vazifaga allaqachon topshirilgan (${n} ta fayl).${gradeLine}\nNima qilamiz?`,
    pkAddFiles: "➕ Fayl qo'shish (avvalgisiga)",
    pkAppended: (lbl: string, n: number) => `✅ <b>${lbl}</b> — fayl qo'shildi (jami ${n} ta).`,
    pkWelcome: (name: string) => `👋 <b>${name}</b>, siz AI Creators platformasiga qo'shildingiz (sinov hisobi). Vazifalaringiz qabul qilinadi, ball va statistika yuritiladi. Darsliklar to'liq to'lovdan so'ng ochiladi — administrator bilan bog'laning.`,
    pkWelcomeBtn: "🤖 Botga ulanish",
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
    hwRequireIntentHint: "📤 Vazifani topshirish uchun avval botda /vazifalar bo'limiga kiring va kerakli vazifa uchun \"📤 Topshirish\" tugmasini bosing — so'ngra rasm/video/hujjatingizni shu topikka yuboring. Aks holda ish avtomatik qabul qilinmaydi.",
    hwResubAsk: (sc: number, mx: number, fb: string) =>
      `📊 Sizning oldingi natijangiz: <b>${sc}/${mx}</b>${fb ? `\nIzoh: "${csvEscapeHtml(fb)}"` : ""}\n\nQayta topshirmoqchimisiz?`,
    hwResubYes: "✅ Ha, qayta topshiraman",
    hwResubNo: "❌ Yo'q",
    hwResubCancelled: "OK 👍 Oldingi natija saqlanadi.",
    hwResubError: "❌ Qayta topshirishni boshlab bo'lmadi. Keyinroq urinib ko'ring.",
    hwReceived: (mn: number, tn: number, preview?: string, expect?: string) =>
      `✅ <b>Vazifangiz qabul qilindi</b> · Modul ${mn} · V${tn}` +
      (preview ? `\n📄 ${preview}` : "") +
      `\n⏳ Ustozlar odatda ${expect || "1–2 kun"} ichida baholaydi — natija shu yerga keladi.`,
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
    nameSaveError: "Saqlashda xato — qayta urinib ko'ring",
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
    nmNotMember: "Этот бот только для студентов AI Creators.",
    nmWelcome: (name: string) => `👋 <b>${name}</b>, добро пожаловать! Ваш аккаунт создан (пробный) — задания принимаются, баллы и статистика ведутся. Уроки откроются после полной оплаты. Пользуйтесь меню ниже 👇`,
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
    adminKbAnalytics: "📊 Статистика",
    adminKbBroadcast: "📣 Массовое сообщение",
    adminKbClaude: "🤖 Claude Code",
    ccPrompt: "✍️ Напишите задачу для Claude Code (одним сообщением).\nОтмена: /cancel",
    ccQueuedOnline: "⚙️ Принято — Claude Code работает. Результат придёт сюда.",
    ccQueuedOffline: (n: number) => `⚠️ Ноутбук сейчас выключен. Задача в очереди (в очереди ${n}) — выполнится, когда ноутбук включат.`,
    ccCancelled: "Отменено 👍",
    ccDenied: "⛔ Функция только для владельца платформы.",
    astGroupsHint: "👇 Подробно по группам:",
    astBack: "← Общая",
    astRefresh: "🔄 Обновить",
    adminHw7d: "Сдано заданий за 7 дней",
    adminHwPending: "Непроверенные задания",
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
    tKbHomework: "📚 Задания",
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
    gradeAskComment: "Напишите комментарий или 🎤 отправьте голосовое (или /skip):",
    gradeVoiceNote: "🎧 Голосовой комментарий преподавателя:",
    gradeBadScore: (max: number) => `Балл должен быть от 0 до ${max}.`,
    gradeSaved: (sc: number, mx: number) => `✅ Сохранено: ${sc}/${mx}. Студенту отправлено уведомление.`,
    gradeStudentDM: (title: string, sc: number, mx: number, fb: string) =>
      `🎉 Ваша работа оценена!\n\n📝 <b>${title}</b>\nОценка: <b>${sc}/${mx}</b>${fb ? `\nКомментарий: ${fb}` : ""}`,
    gradeCancelled: "Отменено.",
    gradeNotFound: "Работа не найдена.",
    gradePickStudent: "📝 <b>Выберите студента:</b>",
    gradePickGroup: "📝 <b>Какую группу оцениваем?</b>",
    gradeAllGroupsBtn: (n: number) => `🌐 Все группы (${n})`,
    gradePendingPickers: (n: number) => `⏳ ${n} студент(ов) выбирают задание — скоро добавятся автоматически.`,
    retagBtn: "✏️ Изменить задание",
    retagPickModule: "✏️ В какой модуль перенести?",
    retagPickTask: (m: string) => `✏️ ${m} — какое задание?`,
    retagDone: (lbl: string) => `✅ Перенесено: <b>${lbl}</b>. Теперь можно ставить оценку.`,
    retagGraded: "Оценённую работу нельзя переносить",
    retagTargetGraded: "По тому заданию уже есть оценённая работа",
    retagSame: "Это то же самое задание",
    retagNoTasks: "В этом модуле нет активных заданий.",
    retagStudentNote: (lbl: string) => `✏️ Учитель перенёс вашу работу на задание <b>${lbl}</b>. Баллы и история сохраняются.`,
    pkAsk: "📋 Какое это задание? Выберите ниже.\n<i>Если не выберете — всё равно примем: через 10 минут отметим автоматически.</i>",
    pkRemind: "☝️ Ваше фото/видео получено. Пожалуйста, выберите, какое это задание 👇",
    pkAskTask: (m: string) => `📋 ${m} — какое задание?`,
    pkBack: "⬅️ Модули",
    pkDone: (lbl: string) => `✅ ${lbl} принято`,
    pkNotYours: "Это работа другого студента 🙂",
    pkExpired: "Время вышло — задание отмечено автоматически.",
    pkGradedAlready: "Это задание уже оценено. Выберите другое.",
    pkTierLocked: "Этот модуль закрыт в вашем тарифе.",
    pkWrongTopic: (url: string) => `⚠️ Это топик другой группы. Отправьте работу в топик своей группы: ${url}`,
    pkResubAsk: (lbl: string, sc: number, mx: number) => `⚠️ ${lbl} уже оценено: <b>${sc}/${mx}</b>.\nПри повторной сдаче старая оценка сбросится, и учитель оценит заново.`,
    pkResubYes: "🔄 Да, пересдать",
    pkDoneMsg: (lbl: string) => `✅ <b>${lbl}</b> принято — учитель проверит.`,
    pkPrevGrade: (sc: number, mx: number) => `📊 Прежняя оценка: <b>${sc}/${mx}</b>`,
    pkExistingAsk: (lbl: string, n: number, gradeLine: string) => `📎 <b>${lbl}</b> — по этому заданию уже сдано (${n} файл(ов)).${gradeLine}\nЧто делаем?`,
    pkAddFiles: "➕ Добавить файл (к прежней сдаче)",
    pkAppended: (lbl: string, n: number) => `✅ <b>${lbl}</b> — файл добавлен (всего ${n}).`,
    pkWelcome: (name: string) => `👋 <b>${name}</b>, вы добавлены на платформу AI Creators (пробный аккаунт). Ваши работы принимаются, баллы и статистика ведутся. Уроки откроются после полной оплаты — свяжитесь с администратором.`,
    pkWelcomeBtn: "🤖 Подключить бота",
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
    hwRequireIntentHint: "📤 Чтобы сдать работу, сначала откройте в боте /vazifalar и нажмите \"📤 Сдать\" для нужного задания — затем отправьте фото/видео/документ в этот топик. Иначе работа не будет принята автоматически.",
    hwResubAsk: (sc: number, mx: number, fb: string) =>
      `📊 Ваш предыдущий результат: <b>${sc}/${mx}</b>${fb ? `\nКомментарий: "${csvEscapeHtml(fb)}"` : ""}\n\nХотите отправить заново?`,
    hwResubYes: "✅ Да, отправить заново",
    hwResubNo: "❌ Нет",
    hwResubCancelled: "OK 👍 Прежний результат сохранится.",
    hwResubError: "❌ Не удалось начать пересдачу. Попробуйте позже.",
    hwReceived: (mn: number, tn: number, preview?: string, expect?: string) =>
      `✅ <b>Задание принято</b> · Модуль ${mn} · З${tn}` +
      (preview ? `\n📄 ${preview}` : "") +
      `\n⏳ Преподаватели обычно проверяют за ${expect || "1–2 дня"} — результат придёт сюда.`,
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
    nameSaveError: "Ошибка сохранения — попробуйте ещё раз",
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
    nmNotMember: "This bot is for AI Creators students only.",
    nmWelcome: (name: string) => `👋 <b>${name}</b>, welcome! Your account has been created (trial) — homework is accepted, points and stats are tracked. Lessons unlock after full payment. Use the menu below 👇`,
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
    adminKbAnalytics: "📊 Statistics",
    adminKbBroadcast: "📣 Broadcast",
    adminKbClaude: "🤖 Claude Code",
    ccPrompt: "✍️ Type the task for Claude Code (one message).\nCancel: /cancel",
    ccQueuedOnline: "⚙️ Queued — Claude Code is working. The result will arrive here.",
    ccQueuedOffline: (n: number) => `⚠️ Laptop is off right now. Task queued (${n} in queue) — it'll run when the laptop is back on.`,
    ccCancelled: "Cancelled 👍",
    ccDenied: "⛔ This feature is owner-only.",
    astGroupsHint: "👇 Per-group detail:",
    astBack: "← Overall",
    astRefresh: "🔄 Refresh",
    adminHw7d: "Homework submitted in 7 days",
    adminHwPending: "Ungraded homework",
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
    tKbHomework: "📚 Homework",
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
    gradeAskComment: "Write a comment or 🎤 send a voice message (or /skip):",
    gradeVoiceNote: "🎧 Voice feedback from your teacher:",
    gradeBadScore: (max: number) => `Score must be between 0 and ${max}.`,
    gradeSaved: (sc: number, mx: number) => `✅ Saved: ${sc}/${mx}. Student notified.`,
    gradeStudentDM: (title: string, sc: number, mx: number, fb: string) =>
      `🎉 Your homework was graded!\n\n📝 <b>${title}</b>\nScore: <b>${sc}/${mx}</b>${fb ? `\nFeedback: ${fb}` : ""}`,
    gradeCancelled: "Cancelled.",
    gradeNotFound: "Submission not found.",
    gradePickStudent: "📝 <b>Pick a student:</b>",
    gradePickGroup: "📝 <b>Which group are you grading?</b>",
    gradeAllGroupsBtn: (n: number) => `🌐 All groups (${n})`,
    gradePendingPickers: (n: number) => `⏳ ${n} student(s) are choosing a task — they'll be filed automatically shortly.`,
    retagBtn: "✏️ Change task",
    retagPickModule: "✏️ Move to which module?",
    retagPickTask: (m: string) => `✏️ ${m} — which task?`,
    retagDone: (lbl: string) => `✅ Moved to <b>${lbl}</b>. You can grade it now.`,
    retagGraded: "A graded submission can't be moved",
    retagTargetGraded: "That task already has a graded submission",
    retagSame: "That's the same task",
    retagNoTasks: "No active tasks in that module.",
    retagStudentNote: (lbl: string) => `✏️ Your teacher moved your submission to <b>${lbl}</b>. Points and history are kept.`,
    pkAsk: "📋 Which task is this? Pick below.\n<i>No pick needed — it's accepted either way and auto-tagged in 10 minutes.</i>",
    pkRemind: "☝️ Your photo/video was received. Please choose which task it is 👇",
    pkAskTask: (m: string) => `📋 ${m} — which task?`,
    pkBack: "⬅️ Modules",
    pkDone: (lbl: string) => `✅ ${lbl} accepted`,
    pkNotYours: "That's another student's submission 🙂",
    pkExpired: "Expired — the task was tagged automatically.",
    pkGradedAlready: "That task is already graded. Pick another.",
    pkTierLocked: "That module is locked on your plan.",
    pkWrongTopic: (url: string) => `⚠️ This is another group's topic. Post your homework in your own group's topic: ${url}`,
    pkResubAsk: (lbl: string, sc: number, mx: number) => `⚠️ ${lbl} is already graded: <b>${sc}/${mx}</b>.\nResubmitting resets the old score and your teacher will regrade it.`,
    pkResubYes: "🔄 Yes, resubmit",
    pkDoneMsg: (lbl: string) => `✅ <b>${lbl}</b> accepted — your teacher will review it.`,
    pkPrevGrade: (sc: number, mx: number) => `📊 Previous grade: <b>${sc}/${mx}</b>`,
    pkExistingAsk: (lbl: string, n: number, gradeLine: string) => `📎 <b>${lbl}</b> — you already submitted this task (${n} file(s)).${gradeLine}\nWhat shall we do?`,
    pkAddFiles: "➕ Add file (to the existing one)",
    pkAppended: (lbl: string, n: number) => `✅ <b>${lbl}</b> — file added (${n} total).`,
    pkWelcome: (name: string) => `👋 <b>${name}</b>, you've been added to the AI Creators platform (trial account). Your homework is accepted and your points/statistics are tracked. Lessons unlock after full payment — contact the administrator.`,
    pkWelcomeBtn: "🤖 Connect the bot",
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
    hwRequireIntentHint: "📤 To submit, first open /vazifalar in the bot and tap \"📤 Submit\" for the task — then post your photo/video/document in this topic. Otherwise it won't be captured automatically.",
    hwResubAsk: (sc: number, mx: number, fb: string) =>
      `📊 Your previous result: <b>${sc}/${mx}</b>${fb ? `\nFeedback: "${csvEscapeHtml(fb)}"` : ""}\n\nDo you want to resubmit?`,
    hwResubYes: "✅ Yes, resubmit",
    hwResubNo: "❌ No",
    hwResubCancelled: "OK 👍 Your previous score is kept.",
    hwResubError: "❌ Could not start resubmission. Please try again later.",
    hwReceived: (mn: number, tn: number, preview?: string, expect?: string) =>
      `✅ <b>Submission received</b> · Module ${mn} · T${tn}` +
      (preview ? `\n📄 ${preview}` : "") +
      `\n⏳ Teachers usually grade within ${expect || "1–2 days"} — the result will arrive here.`,
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
    nameSaveError: "Save failed — please try again",
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
    btnEditName: "✏️ Ismni o'zgartirish",
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
    tLevelNames: ["Yangi ustoz", "Ustoz", "Katta ustoz", "Tajribali ustoz", "Top ustoz"],
    tBoardTitle: "🏆 Ustozlar reytingi (hafta)", tTeam: "Jamoa",
    tWeekLine: (g: number, ot: number | null, ar: number | null) =>
      `📈 Bu hafta: <b>${g}</b> baholandi${ot != null ? ` · ${ot}% vaqtida` : ""}${ar != null ? ` · ${ar}% javob` : ""}`,
  },
  ru: {
    kbProfil: "👤 Профиль",
    profGroup: "Группа", profTeacher: "Устоз",
    profStreak: "Стрик", profRecord: "рекорд", profModules: "Модули", profLessons: "Уроки",
    profHomework: "Задания", profAvg: "ср.", profRank: "В группе",
    profNextLevel: (need: number, lvl: number) => `До уровня ${lvl}: ${need} XP`,
    btnProfStats: "📊 Статистика", btnProfBadges: "🏆 Достижения",
    btnProfGroup: "👥 Рейтинг группы", btnProfOpen: "👤 Открыть профиль",
    btnEditName: "✏️ Изменить имя",
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
    tLevelNames: ["Молодой педагог", "Педагог", "Старший педагог", "Опытный педагог", "Топ-педагог"],
    tBoardTitle: "🏆 Рейтинг устозов (неделя)", tTeam: "Команда",
    tWeekLine: (g: number, ot: number | null, ar: number | null) =>
      `📈 За неделю: <b>${g}</b> проверено${ot != null ? ` · ${ot}% вовремя` : ""}${ar != null ? ` · ${ar}% ответ` : ""}`,
  },
  en: {
    kbProfil: "👤 Profile",
    profGroup: "Group", profTeacher: "Teacher",
    profStreak: "Streak", profRecord: "best", profModules: "Modules", profLessons: "Lessons",
    profHomework: "Homework", profAvg: "avg", profRank: "In group",
    profNextLevel: (need: number, lvl: number) => `${need} XP to level ${lvl}`,
    btnProfStats: "📊 Statistics", btnProfBadges: "🏆 Achievements",
    btnProfGroup: "👥 Group rating", btnProfOpen: "👤 Open my profile",
    btnEditName: "✏️ Edit my name",
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
    tLevelNames: ["Rising teacher", "Teacher", "Senior teacher", "Expert teacher", "Top teacher"],
    tBoardTitle: "🏆 Teacher rating (week)", tTeam: "Team",
    tWeekLine: (g: number, ot: number | null, ar: number | null) =>
      `📈 This week: <b>${g}</b> graded${ot != null ? ` · ${ot}% on time` : ""}${ar != null ? ` · ${ar}% answered` : ""}`,
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
  // ✏️ Edit name → reuses the confirm-your-name flow (name:edit → awaiting_name → preview →
  // name:yes writes profiles.name/last_name). Lets any student fix their own display name so
  // the rating/leaderboard shows it correctly.
  const keyboard = { inline_keyboard: [
    [{ text: p.btnProfOpen, url }],
    [{ text: p.btnEditName, callback_data: "name:edit" }],
  ] };
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
  const [{ data: prof }, statsRes, groupsRes, xpRes, weekRes, lbRes] = await Promise.all([
    admin.from("profiles").select("name, last_name, bio, active_teacher_group_id").eq("id", teacherId).maybeSingle(),
    admin.rpc("teacher_profile_stats", { uid: teacherId }),
    admin.rpc("teacher_groups", { uid: teacherId }),
    admin.rpc("teacher_xp", { uid: teacherId }),
    admin.rpc("teacher_weekly_self", { uid: teacherId, p_days: 7 }),
    admin.rpc("teacher_leaderboard", { uid: teacherId, _limit: 30 }),
  ]);
  const s: any = Array.isArray(statsRes.data) ? statsRes.data[0] : statsRes.data;
  const groups = ((groupsRes.data || []) as any[]);
  const xp: any = Array.isArray(xpRes.data) ? xpRes.data[0] : xpRes.data;
  const week: any = Array.isArray(weekRes.data) ? weekRes.data[0] : weekRes.data;
  const board = ((lbRes.data || []) as any[]);
  const name = escHtml(`${prof?.name || ""} ${prof?.last_name || ""}`.trim() || "Ustoz");

  const lines: string[] = [];
  lines.push(p.tProfTitle);
  lines.push(`👤 <b>${name}</b>`);
  // Level + XP badge (recognition/mastery), reusing the generic XP curve; ladder tops at "Top ustoz".
  const LVL_EMOJI = ["🌱", "📗", "🎓", "🏅", "🏆"];
  const tLvl = xp?.level ?? 1;
  const tLvlName = p.tLevelNames[Math.min(tLvl, p.tLevelNames.length) - 1] || `L${tLvl}`;
  const tLvlEmoji = LVL_EMOJI[Math.min(tLvl, LVL_EMOJI.length) - 1] || "🎓";
  lines.push(`${tLvlEmoji} <b>${tLvlName}</b> · ⚡${xp?.total_xp ?? 0} XP`);
  if (prof?.bio) lines.push(`<i>${escHtml(String(prof.bio))}</i>`);
  lines.push("");
  lines.push(`👥 ${p.tGroups}: <b>${s?.groups_count ?? 0}</b> · ${p.tStudents}: <b>${s?.students_total ?? 0}</b>`);
  lines.push(`✅ ${p.tGraded}: <b>${s?.graded_total ?? 0}</b>${s?.avg_score_given ? ` (${p.tAvg} ${s.avg_score_given}/10)` : ""}`);
  // Your week — throughput + responsiveness, framed as impact (only when there's something to show).
  if (week && (Number(week.graded) > 0 || Number(week.questions) > 0)) {
    lines.push(p.tWeekLine(
      Number(week.graded) || 0,
      week.on_time_pct == null ? null : Number(week.on_time_pct),
      week.answer_rate == null ? null : Number(week.answer_rate),
    ));
  }

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

  // Weekly teacher leaderboard (friendly competition): top 3 + you + team total, with movement.
  if (board.length && board.some((b) => (b.week_xp || 0) > 0)) {
    const teamXp = board.reduce((sum, b) => sum + (b.week_xp || 0), 0);
    const bmedal = (r: number) => (r === 1 ? "🥇" : r === 2 ? "🥈" : r === 3 ? "🥉" : ` ${r}.`);
    const move = (b: any) => (b.prev_rank && b.rank < b.prev_rank ? " ↑" : b.prev_rank && b.rank > b.prev_rank ? " ↓" : "");
    lines.push("", p.tBoardTitle);
    for (const b of board.filter((x) => x.rank <= 3 || x.is_me)) {
      const nm = b.is_me ? `<b>${p.profYou}</b>` : escHtml(`${b.first_name} ${b.last_initial ? b.last_initial + "." : ""}`.trim());
      lines.push(`${bmedal(b.rank)} ${nm} — ⚡${b.week_xp}${move(b)}`);
    }
    lines.push(`👥 ${p.tTeam}: <b>${teamXp}</b> XP`);
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
  // Slimmed 2026-07-12 per owner: statistics-first. Grading/Homeworks/inactive/never-active
  // buttons removed — their slash commands (/baholash, /inactive3, /nevr, …) still work, and
  // per-group detail lives behind inline buttons under 📊 Statistika.
  return {
    keyboard: [
      [{ text: t.adminKbAnalytics }],
      // Mini App: opens the broadcast composer inside Telegram (auth via signed initData, admin-only).
      [{ text: t.adminKbBroadcast, web_app: { url: "https://www.aicreator.academy/tg/broadcast" } }],
      [{ text: t.adminKbClaude }],
      [{ text: t.adminKbNew }],
      [{ text: t.adminKbStudentMode }, { text: t.kbLang }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

function getTeacherKeyboard(locale: Locale, pendingCount?: number) {
  const t = T[locale] as any;
  // "Data-Six" layout — ranked by 2 months of real taps (Baholash 848 ≫
  // Statistika 148 > Vazifalar 73 > Talabalarim 38 > Xabar 15). Occasional
  // items (TOP, Faolsizlar, Sozlamalar, Til, group switching) live in 👤 Profil.
  const grade = pendingCount && pendingCount > 0 ? `${t.tKbGrade} (${pendingCount})` : t.tKbGrade;
  return {
    keyboard: [
      [{ text: grade }],
      [{ text: t.tKbStats }, { text: t.tKbHomework }],
      [{ text: t.tKbStudents }, { text: t.tKbBroadcast }],
      [{ text: PROF_T[locale].kbProfil }],
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

// Re-send a Telegram voice note by its file_id (grade voice feedback). file_id-based → the audio
// stays on Telegram's servers, no download/upload, robust re-delivery. Returns true on success.
async function sendVoice(chatId: number, fileId: string, caption?: string): Promise<boolean> {
  try {
    const resp = await tgApi("sendVoice", {
      chat_id: chatId, voice: fileId,
      ...(caption ? { caption, parse_mode: "HTML" } : {}),
    });
    const j: any = await resp.json().catch(() => null);
    return !!j?.ok;
  } catch (_e) { return false; }
}

// DB-visible error capture — a caught exception / genuine failure lands in platform_error_log so
// the detectors + ops agent can see and classify it. NEVER called for expected member behaviour
// (wrong button, stale tap) — those are handled gracefully and are not errors. Logging must never
// throw or block the request.
async function logError(
  admin: any, source: string, message: unknown,
  ctx: { action?: string; user_id?: string | null; telegram_id?: number | null; context?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    await admin.from("platform_error_log").insert({
      source,
      action: ctx.action ?? null,
      message: String(message instanceof Error ? message.message : message).slice(0, 1000),
      user_id: ctx.user_id ?? null,
      telegram_id: ctx.telegram_id ?? null,
      context: ctx.context ?? {},
    });
  } catch (_e) { /* error logging must never throw */ }
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

// Claude Code is owner-gated: an admin AND on the explicit allowlist of telegram_ids in
// platform_settings.claude_agent.owner_tg_ids. FAIL-CLOSED — an empty/absent allowlist means NOBODY
// (this queues code that runs with real permissions on the owner's laptop, so it must never fall open
// to every admin account). The migration seeds the owner's own telegram_id.
async function claudeOwnerAllowed(admin: any, userProfileId: string, tgId: number): Promise<boolean> {
  if (!(await isAdminUser(admin, userProfileId))) return false;
  const { data: cfg } = await admin.from("platform_settings").select("value").eq("key", "claude_agent").maybeSingle();
  const allow = (((cfg?.value as any)?.owner_tg_ids) as unknown[]) || [];
  return allow.map(Number).includes(Number(tgId));
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
    if (trimmed === t.adminKbClaude) return "/claude";
    // Legacy cached label (pre-2026-07-12 keyboards still show "Analitika")
    if (trimmed === "📊 Analitika" || trimmed === "📊 Аналитика" || trimmed === "📊 Analytics") return "/analitika";
    if (trimmed === t.adminKbInactive3) return "/inactive3";
    if (trimmed === t.adminKbInactive7) return "/inactive7";
    if (trimmed === t.adminKbNever) return "/nevr";
    if (trimmed === t.adminKbNew) return "/yangilar";
    if (trimmed === t.adminKbStudentMode) return "/talaba";
    // Teacher keyboard buttons
    // Data-Six: Baholash may carry a live "(N)" suffix; legacy 📝 Vazifalar
    // labels from cached keyboards still route.
    if (t.tKbGrade && trimmed.startsWith(t.tKbGrade)) return "/baholash";
    if (trimmed === "📝 Vazifalar" || trimmed === "📝 Задания" || trimmed === "📝 Homework") return "/modulvazifalar";
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

// Runtime-overridable site domain for the bot's webapp links: platform_settings.site_url =
// {"url":"https://..."} takes precedence over the SITE_URL env, so we can reroute the webapp to a
// clean domain (e.g. while aicreator.academy's VirusTotal reputation flag is disputed and blocked on
// students' networks) with a single DB flip — no secret change, instantly revertible. Cached ~60s.
let __siteUrlCache: { url: string; at: number } | null = null;
async function getSiteUrl(admin: any): Promise<string> {
  if (__siteUrlCache && Date.now() - __siteUrlCache.at < 60_000) return __siteUrlCache.url;
  let url = SITE_URL;
  try {
    const { data } = await admin.from("platform_settings").select("value").eq("key", "site_url").maybeSingle();
    const override = (data?.value as any)?.url;
    if (typeof override === "string" && /^https?:\/\//.test(override)) url = override.replace(/\/$/, "");
  } catch (_e) { /* fall back to the SITE_URL env value */ }
  __siteUrlCache = { url, at: Date.now() };
  return url;
}

async function createMagicLink(
  admin: any,
  user_id: string,
  purpose: string,
  target_path?: string,
): Promise<string> {
  const base = await getSiteUrl(admin); // runtime-overridable site domain (clean-domain reroute)
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
      return `${base}/auth/magic?t=${row.token}`;
    }
  } catch (_e) { /* fall through to insert */ }
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
  const { error } = await admin
    .from("telegram_magic_links")
    .insert({ token, user_id, purpose, target_path, expires_at: expiresAt });
  if (error) throw error;
  return `${base}/auth/magic?t=${token}`;
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

// Provisional (trial) accounts: homework/points/stats yes, lessons no. Shown when they try /dars//davom.
const TRIAL_LOCKED: Record<string, string> = {
  uz: "🔒 Darsliklar sinov (trial) hisobida ochiq emas. To'liq to'lovdan so'ng ochiladi — uy vazifalaringiz va ballaringiz saqlanib qoladi. To'lov uchun administrator bilan bog'laning.",
  ru: "🔒 Уроки недоступны на пробном аккаунте. Откроются после полной оплаты — ваши домашние задания и баллы сохранятся. По оплате свяжитесь с администратором.",
  en: "🔒 Lessons aren't available on a trial account. They unlock after full payment — your homework and points are kept. Contact the admin to pay.",
};

async function findProfileByTelegramId(admin: any, tgId: number) {
  const { data } = await admin
    .from("profiles")
    .select("id, name, last_name, telegram_username, telegram_id, telegram_onboarded_at, preferred_locale, group_id, status, account_type")
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
    .select("id, name, last_name, telegram_username, telegram_id, telegram_onboarded_at, preferred_locale, group_id, status, account_type")
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

// MEMBERSHIP GATE (owner directive 2026-07-13): the Telegram GROUP is the trust boundary.
// Unknown users who ARE members of an active-course group chat get onboarded (provisional,
// same engine + kill-switch flag as in-topic auto-register); everyone else gets ONE plain
// sentence — no keyboards, no buttons, no links, no account. Membership answers are cached
// in bot_conversation_state (state 'nm_cache', 30 min) so spam can't turn into getChatMember
// sweeps; replies are additionally throttled to 1/min in-memory.
const NM_CACHE_TTL_MIN = 30;

type MembershipResult = {
  member: boolean;
  staff: boolean;
  // true when EVERY chat probe errored (Telegram 429 storm / outage) — the answer is unknown,
  // callers must NOT cache it and must fail toward the least destructive behavior.
  indeterminate: boolean;
  group: { id: string; course_id: string } | null;
};

// Sweep the distinct Telegram chats behind all published-course groups and ask each whether
// tgId is a member. Chat ids come from groups.homework_topic_url / telegram_group_url AND
// group_module_topics.telegram_topic_url (telegram_group_url is usually an invite link with
// no chat id — per-module topic URLs are where /c/<id>/ reliably lives). Short-circuits on
// the first hit; 'administrator'/'creator' means staff — member:true but never auto-registered
// as a student (U4 rule).
async function resolveMembershipGroup(admin: any, tgId: number): Promise<MembershipResult> {
  const [groupsRes, gmtRes] = await Promise.all([
    admin.from("groups")
      .select("id, course_id, homework_topic_url, telegram_group_url, homework_topic_id, created_at, courses:course_id(published)")
      .not("course_id", "is", null),
    admin.from("group_module_topics").select("group_id, telegram_topic_url"),
  ]);
  const published = new Map<string, any>();
  for (const g of (groupsRes.data || []) as any[]) {
    if ((g as any).courses?.published) published.set(g.id, g);
  }
  const chats = new Map<string, Map<string, any>>();
  const addChat = (url: string | null | undefined, g: any) => {
    const m = /\/c\/(\d+)\//.exec(String(url || ""));
    if (!m) return;
    const chatId = `-100${m[1]}`;
    if (!chats.has(chatId)) chats.set(chatId, new Map());
    chats.get(chatId)!.set(g.id, g);
  };
  for (const g of published.values()) {
    addChat(g.homework_topic_url, g);
    addChat(g.telegram_group_url, g);
  }
  for (const r of (gmtRes.data || []) as any[]) {
    const g = published.get(r.group_id);
    if (g) addChat(r.telegram_topic_url, g);
  }

  let errors = 0;
  let checked = 0;
  for (const [chatId, groupMap] of chats) {
    checked++;
    try {
      const resp = await tgApi("getChatMember", { chat_id: Number(chatId), user_id: tgId });
      const cm: any = await resp.json().catch(() => null);
      if (!cm || cm.ok !== true) {
        // 429 / bot kicked / chat gone — distinguish from a clean "not a member".
        errors++;
        console.warn("[membership-gate] getChatMember failed", { chatId, code: cm?.error_code, desc: cm?.description });
        continue;
      }
      const st = cm.result?.status;
      const isMember = st === "member" || st === "administrator" || st === "creator" ||
        (st === "restricted" && cm.result?.is_member === true);
      if (!isMember) continue;
      const staff = st === "administrator" || st === "creator";
      const groups = Array.from(groupMap.values());
      groups.sort((a: any, b: any) =>
        (b.homework_topic_id != null ? 1 : 0) - (a.homework_topic_id != null ? 1 : 0) ||
        String(b.created_at).localeCompare(String(a.created_at)));
      return { member: true, staff, indeterminate: false, group: groups[0] ? { id: groups[0].id, course_id: groups[0].course_id } : null };
    } catch (e) {
      errors++;
      console.warn("[membership-gate] getChatMember threw", { chatId, err: String(e) });
    }
  }
  const indeterminate = checked > 0 && errors === checked;
  if (indeterminate) {
    // DB-visible signal (doctrine): a probe storm must be discoverable before complaints.
    try {
      await admin.from("admin_actions").insert({
        actor_user_id: null, action: "membership_gate_indeterminate",
        details: { telegram_id: tgId, chats_checked: checked, errors },
      });
    } catch (_e) { /* best-effort */ }
  }
  return { member: false, staff: false, indeterminate, group: null };
}

type NmCache = { member: boolean; staff: boolean; group_id: string | null; course_id: string | null };

async function getNmCache(admin: any, tgId: number): Promise<NmCache | null> {
  const { data } = await admin.from("bot_conversation_state")
    .select("state, context, expires_at").eq("telegram_id", tgId).maybeSingle();
  if (!data || data.state !== "nm_cache") return null;
  if (!data.expires_at || new Date(data.expires_at).getTime() < Date.now()) return null;
  const c = (data.context || {}) as any;
  return { member: !!c.member, staff: !!c.staff, group_id: c.group_id ?? null, course_id: c.course_id ?? null };
}

async function setNmCache(admin: any, tgId: number, m: MembershipResult) {
  try {
    // NEVER clobber an active conversation flow (awaiting_name / confirm_name / grading):
    // only write over nothing, an expired row, or a previous nm_cache row.
    const { data: existing } = await admin.from("bot_conversation_state")
      .select("state, expires_at").eq("telegram_id", tgId).maybeSingle();
    if (existing && existing.state !== "nm_cache" &&
        existing.expires_at && new Date(existing.expires_at).getTime() > Date.now()) {
      return;
    }
    await admin.from("bot_conversation_state").upsert({
      telegram_id: tgId, state: "nm_cache",
      context: { member: m.member, staff: m.staff, group_id: m.group?.id ?? null, course_id: m.group?.course_id ?? null },
      updated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + NM_CACHE_TTL_MIN * 60_000).toISOString(),
    });
  } catch (_e) { /* cache best-effort */ }
}

// Cached membership check shared by every username-linking / unknown-user path.
// Returns null when the answer is indeterminate (probe storm) — callers decide the safe fallback.
async function membershipCheckCached(admin: any, tgId: number): Promise<MembershipResult | null> {
  const cached = await getNmCache(admin, tgId);
  if (cached) {
    return {
      member: cached.member, staff: cached.staff, indeterminate: false,
      group: cached.group_id && cached.course_id ? { id: cached.group_id, course_id: cached.course_id } : null,
    };
  }
  const m = await resolveMembershipGroup(admin, tgId);
  if (m.indeterminate) return null;
  await setNmCache(admin, tgId, m);
  return m;
}

// GATE for first-time username-based account linking (bot commands AND website login):
// usernames are not owned — anyone can rename to a pre-created student's username and claim
// the account. Staff profiles (created deliberately by admins) bypass the group requirement.
// Refusals are audited (DB-visible). Returns false when linking must be refused.
async function usernameLinkAllowed(admin: any, profile: any, tgId: number): Promise<boolean> {
  try {
    const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", profile.id);
    const staffRole = (roles || []).some((r: any) => ["admin", "superadmin", "teacher"].includes(r.role));
    if (staffRole) return true;
  } catch (_e) { /* fall through to membership check */ }
  const m = await membershipCheckCached(admin, tgId);
  if (m === null) {
    // Unknown (API storm): refuse WITHOUT caching — the next message retries cleanly.
    console.warn("[telegram-auth] username-link deferred: membership indeterminate", { profile_id: profile.id, telegram_id: tgId });
    return false;
  }
  if (!m.member) {
    console.warn("[telegram-auth] username-link REFUSED: claimer not a group member", {
      profile_id: profile.id, telegram_id: tgId,
    });
    try {
      await admin.from("admin_actions").insert({
        actor_user_id: null, action: "username_link_refused", target_user_id: profile.id,
        target_resource_type: "profile", target_resource_id: profile.id,
        details: { telegram_id: tgId, telegram_username: profile.telegram_username || null },
      });
    } catch (_e) { /* audit best-effort */ }
    return false;
  }
  return true;
}

async function sendUnregisteredReply(
  admin: any,
  chatId: number,
  from: { id: number; username?: string; first_name?: string; last_name?: string; language_code?: string } | null | undefined,
  localeOverride?: Locale,
) {
  const tgId = from?.id ?? chatId;
  console.log("[bot:unregistered]", { telegram_id: tgId, username: from?.username || null, first_name: from?.first_name || null });
  const now = Date.now();
  const last = unregisteredLastReplyAt.get(tgId) || 0;
  if (now - last < UNREGISTERED_REPLY_TTL_MS) return;
  unregisteredLastReplyAt.set(tgId, now);
  const locale: Locale = localeOverride || normLocale(from?.language_code);
  const t = T[locale] as any;

  const membership = from?.id ? await membershipCheckCached(admin, from.id) : { member: false, staff: false, indeterminate: false, group: null };

  if (membership === null) {
    // Probe storm — answer unknown. Fail toward the old, harmless behavior (enrollment funnel),
    // cache nothing so the next message re-checks cleanly.
    const enroll = await getEnrollmentSettings(admin, locale);
    await sendMessage(chatId, enroll.message, {
      inline_keyboard: [[{ text: enroll.buttonLabel, url: enroll.formUrl }]],
    });
    return;
  }

  if (!membership.member) {
    // NOT a member of any active-course group: plain message, NO keyboard/button/link.
    await sendMessage(chatId, t.nmNotMember);
    return;
  }

  // Member without an account → onboard as provisional through the shared engine,
  // honoring the same kill-switch flag as in-topic auto-register. Staff never become students.
  if (!membership.staff && membership.group && from?.id) {
    const cfg = await getHomeworkCaptureConfig(admin);
    if (cfg.autoRegister) {
      const reg = await registerProvisionalViaEngine(admin, from as any, membership.group, "dm_start_member");
      if (reg) {
        const prof = await findProfileByTelegramId(admin, from.id);
        if (prof) {
          await admin.from("bot_conversation_state").delete().eq("telegram_id", from.id).eq("state", "nm_cache");
          const name = (from.first_name || from.username || "do'st").slice(0, 40);
          // Engine may MATCH an existing account instead of creating one — never tell a paid
          // student their account "was created (trial)" (review finding).
          const text = reg.created ? t.nmWelcome(csvEscapeHtml(name)) : t.kbHint;
          await sendWithKeyboard(chatId, text, locale, false, "student");
          return;
        }
      }
    }
  }

  // Member but flag off / staff / engine refused → the human enrollment funnel (form button).
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
    // MEMBERSHIP GATE on first-time username linking: a pre-created profile matched only by
    // telegram_username is claimable by ANYONE who renames their Telegram username to match
    // (usernames are not owned — squatting = account takeover). Shared gate: staff bypass +
    // cached membership + audited refusal (same gate protects handleStartLogin).
    if (matchedBy === "telegram_username") {
      if (!(await usernameLinkAllowed(admin, profile, tgId))) return null;
    }
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
        const tnLabel: any = displayStepNumber(a); // SAP sub-step → sap_number ("Vazifa 1/2/3")
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
        const u0Tn: any = displayStepNumber(u0);
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
    // MEMBERSHIP GATE (same class as resolveProfileForTelegramUser): the website-login path
    // mints a full Supabase session for whoever binds first — username squatting here is a
    // straight account+session takeover. Same shared gate, same staff bypass, same audit.
    if (matchedBy === "telegram_username" && !(await usernameLinkAllowed(admin, profile, tgId))) {
      const enroll = await getEnrollmentSettings(admin, locale);
      await sendMessage(chatId, enroll.message, {
        inline_keyboard: [[{ text: enroll.buttonLabel, url: enroll.formUrl }]],
      });
      return;
    }
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

// ---- Admin statistics (📊 Statistika button + ast: callbacks) ----

// Overall platform stats + an inline keyboard of groups for per-group drill-down.
// Groups and counts are queried live on every render, so new groups/students
// appear automatically — nothing is cached in the keyboard.
async function buildAdminOverallStats(admin: any, locale: Locale): Promise<{ text: string; keyboard: any }> {
  const t = T[locale] as any;
  const rows = await loadStudentActivity(admin);
  const now = Date.now();
  const total = rows.length;
  const loggedOnce = rows.filter((s) => !!s.last_sign_in_at).length;
  const neverLogged = total - loggedOnce;
  const sevenDayMs = 7 * 86400_000;
  const active7d = rows.filter((s) => {
    const la = lastActivityOf(s);
    return la && now - la.getTime() <= sevenDayMs;
  }).length;
  const new7d = rows.filter((s) => now - new Date(s.created_at).getTime() <= sevenDayMs).length;

  const sevenAgoIso = new Date(now - sevenDayMs).toISOString();
  const [compRes, hw7dRes, hwPendRes] = await Promise.all([
    admin.from("lesson_progress").select("user_id", { count: "exact", head: true }).gte("completed_at", sevenAgoIso),
    admin.from("homework_submissions").select("id", { count: "exact", head: true }).gte("submitted_at", sevenAgoIso),
    // Same pending rule as the teacher grading queue: ungraded OR stale after resubmission.
    admin.from("homework_submissions").select("id", { count: "exact", head: true }).or("score.is.null,score_is_stale.is.true"),
  ]);

  const lines = [
    t.adminAnalyticsTitle,
    "",
    t.adminLine(t.adminTotalStudents, total),
    t.adminLine(t.adminLoggedOnce, loggedOnce),
    t.adminLine(t.adminNeverLogged, neverLogged),
    t.adminLine(t.adminActive7d, active7d),
    t.adminLine(t.adminNew7d, new7d),
    t.adminLine(t.adminCompletions7d, compRes?.count ?? 0),
    t.adminLine(t.adminHw7d, hw7dRes?.count ?? 0),
    t.adminLine(t.adminHwPending, hwPendRes?.count ?? 0),
    "",
    t.astGroupsHint,
  ];

  const { data: groups } = await admin.from("groups").select("id, name").order("name");
  const { data: memb } = await admin.from("profiles").select("group_id").not("group_id", "is", null);
  const counts = new Map<string, number>();
  for (const m of (memb || []) as any[]) counts.set(m.group_id, (counts.get(m.group_id) || 0) + 1);
  const btns = ((groups || []) as any[]).map((g) => ({
    text: `${g.name} (${counts.get(g.id) || 0})`.slice(0, 30),
    callback_data: `ast:g:${g.id}`,
  }));
  const kbRows: any[] = [];
  for (let i = 0; i < btns.length; i += 2) kbRows.push(btns.slice(i, i + 2));
  kbRows.push([{ text: t.astRefresh, callback_data: "ast:all" }]);

  return { text: lines.join("\n"), keyboard: { inline_keyboard: kbRows } };
}

// Per-group stats — same engine as the teacher's /tstats (teacher_group_statistics RPC
// admits admins), so admin and teacher numbers can never disagree.
async function buildAdminGroupStats(admin: any, locale: Locale, groupId: string, callerId: string): Promise<{ text: string; keyboard: any }> {
  const t = T[locale] as any;
  const { data, error } = await admin.rpc("teacher_group_statistics", { p_group_id: groupId, p_caller_profile_id: callerId });
  if (error) throw error;
  const s: any = data || {};
  const m = s.messages || {};
  const a = s.active_students || {};
  const total = s.total_students ?? 0;
  const groupName = csvEscapeHtml(s.group_name || "—");
  const avg = s.avg_module_score;
  const avgLine = (avg === null || avg === undefined)
    ? "📊 O'rtacha modul bahosi: hali baholanmagan"
    : `📊 O'rtacha modul bahosi: ${avg}/10`;
  const sevenAgoIso = new Date(Date.now() - 7 * 86400_000).toISOString();
  const { count: new7d } = await admin.from("profiles").select("id", { count: "exact", head: true })
    .eq("group_id", groupId).gte("created_at", sevenAgoIso);
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
    `🆕 ${t.adminNew7d}: <b>${new7d ?? 0}</b>`,
    `📝 ${t.adminHwPending}: <b>${s.pending_homework_count ?? 0}</b>`,
    avgLine,
  ].join("\n");
  const keyboard = {
    inline_keyboard: [[
      { text: t.astBack, callback_data: "ast:all" },
      { text: t.astRefresh, callback_data: `ast:g:${groupId}` },
    ]],
  };
  return { text, keyboard };
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

  // 🤖 Claude Code: owner types a task → it's queued for the laptop poller. OWNER-ONLY (this runs
  // Claude Code with real permissions on the owner's laptop), so gate to superadmin even though
  // handleAdminCommand is already admin-gated. Sets a conversation state; the next message is the task.
  if (cmd === "/claude") {
    if (!(await claudeOwnerAllowed(admin, adminProfileId, chatId))) { await sendWithKeyboard(chatId, t.ccDenied, locale, true); return true; }
    await admin.from("bot_conversation_state").upsert({
      telegram_id: chatId, // admin panel is a private DM → chat.id === the owner's telegram_id
      state: "awaiting_claude_task",
      context: {},
      updated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    await sendMessage(chatId, t.ccPrompt);
    return true;
  }

  if (cmd === "/talaba") {
    await sendWithKeyboard(chatId, t.adminStudentModeOn, locale, false);
    return true;
  }

  if (cmd === "/analitika") {
    // Inline group buttons ride on the message itself; the persistent admin
    // reply keyboard stays visible from prior sends.
    const { text, keyboard } = await buildAdminOverallStats(admin, locale);
    await sendMessage(chatId, text, keyboard);
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
          // Module POSITION, not uuid: groupId+moduleId uuids = 81 bytes > Telegram's 64-byte
          // callback cap → the whole /thomework message was rejected (audit BUG-3). ~48 bytes now.
          buttons.push([
            { text: `${tag} ✅ Topshirgan`, callback_data: `thw:sub:${g.id}:${m.module_position ?? 0}` },
            { text: `${tag} ❌ Topshirmagan`, callback_data: `thw:not:${g.id}:${m.module_position ?? 0}` },
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
    // GRADING NEVER HIDES WORK (2026-07-11): active-group scoping buried 10 fresh 5.0 submissions
    // while teacher DMs kept announcing them. Multi-group teachers now get an explicit GROUP
    // CHOOSER with per-group pending counts on the buttons (nothing can hide behind a count) +
    // an all-groups view; single-group teachers go straight to their list. Owner-requested UX
    // for teachers spanning courses. Stats/roster/broadcast keep the active-group concept.
    if (!isAdmin) {
      const tGroups = await teacherGroups(admin, graderId);
      if (tGroups.length > 1) {
        const gIds = tGroups.map((g: any) => g.id);
        const { data: studs } = await admin.from("profiles").select("id, group_id").in("group_id", gIds);
        const uidToGroup = new Map(((studs || []) as any[]).map((s: any) => [s.id, s.group_id]));
        const uids = Array.from(uidToGroup.keys());
        let pend: any[] = [];
        if (uids.length) {
          const { data: subs } = await admin.from("homework_submissions")
            .select("user_id").or("score.is.null,score_is_stale.is.true").in("user_id", uids);
          pend = (subs || []) as any[];
        }
        const byGroup = new Map<string, number>();
        for (const s of pend) {
          const gid = uidToGroup.get(s.user_id);
          if (gid) byGroup.set(gid, (byGroup.get(gid) || 0) + 1);
        }
        const btns: any[][] = tGroups.map((g: any) => [{
          text: `${g.name} (${byGroup.get(g.id) || 0})`.slice(0, 60),
          callback_data: `gs:grp:${g.id}`,
        }]);
        btns.push([{ text: t.gradeAllGroupsBtn(pend.length), callback_data: "gs:grp:all" }]);
        await sendMessage(chatId, t.gradePickGroup, { inline_keyboard: btns });
        return true;
      }
    }
    await renderStudentPicker(admin, chatId, graderId, locale, isAdmin, 0, null);
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
  // Pending = ungraded OR re-opened (stale) — same rule as loadGradingSubmissions, so
  // resubmissions awaiting regrade are counted here too.
  let q = admin.from("homework_submissions").select("user_id").or("score.is.null,score_is_stale.is.true");
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
  // Pending-window visibility: a just-posted homework lives in hw_pending_posts for up to ~10 min
  // (picker open) before becoming a submission. Show that state so "just submitted" work is never
  // mistaken for missing (owner-reported confusion).
  let pendingPickers = 0;
  try {
    let pq2 = admin.from("hw_pending_posts").select("id", { count: "exact", head: true }).eq("state", "pending");
    if (ids) pq2 = pq2.in("user_id", ids);
    const { count: pc } = await pq2;
    pendingPickers = pc || 0;
  } catch (_e) { /* cosmetic */ }
  const pendingLine = pendingPickers > 0 ? `\n\n${t.gradePendingPickers(pendingPickers)}` : "";
  if (counts.size === 0) {
    await sendWithKeyboard(chatId, `${t.gradePending}\n\n${t.gradeNoneP}${pendingLine}`, locale, isAdmin, isAdmin ? "admin" : "teacher");
    return;
  }
  const userIds = Array.from(counts.keys());
  const { data: profs } = await admin.from("profiles").select("id, name, last_name, group_id").in("id", userIds);
  // Multi-group teachers see every group's pending work in one list — tag each student with
  // their group so e.g. "PRE 5.0" vs "6-GURUH" is obvious at a glance.
  const grpIds = Array.from(new Set(((profs || []) as any[]).map((p: any) => p.group_id).filter(Boolean)));
  const grpNames = new Map<string, string>();
  if (!isAdmin && grpIds.length > 1) {
    const { data: grps } = await admin.from("groups").select("id, name").in("id", grpIds);
    for (const g of (grps || []) as any[]) grpNames.set(g.id, g.name);
  }
  const rows = ((profs || []) as any[]).map((p: any) => {
    const tag = grpNames.get(p.group_id);
    return {
      id: p.id,
      name: ([p.name, p.last_name].filter(Boolean).join(" ") || "—") + (tag ? ` · ${tag}` : ""),
      n: counts.get(p.id) || 0,
    };
  }).sort((a: any, b: any) => b.n - a.n);

  const totalPages = Math.max(1, Math.ceil(rows.length / PICKER_PAGE_SIZE));
  const pageIdx = Math.min(Math.max(0, page), totalPages - 1);
  const slice = rows.slice(pageIdx * PICKER_PAGE_SIZE, (pageIdx + 1) * PICKER_PAGE_SIZE);

  const buttons: any[][] = slice.map((r) => [{
    text: `${r.name} (${r.n})`.slice(0, 60),
    callback_data: `gs:pick:${r.id}`,
  }]);
  // Pagination carries the chosen scope so page 2 shows the same group as page 1
  // (previously it silently fell back to the active group — a different list).
  const scopeTok = groupId || "all";
  const nav: any[] = [];
  if (pageIdx > 0) nav.push({ text: t.gradePrevPage, callback_data: `gs:list:${pageIdx - 1}:${scopeTok}` });
  if (pageIdx < totalPages - 1) nav.push({ text: t.gradeNextPage, callback_data: `gs:list:${pageIdx + 1}:${scopeTok}` });
  if (nav.length) buttons.push(nav);

  await sendMessage(chatId, `${t.gradePickStudent}${pendingLine}`, { inline_keyboard: buttons });
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
    // Pending = ungraded OR re-opened (stale) — the SAME rule as the student picker that counted
    // them. The old score-null-only filter made resubmissions-awaiting-regrade count as "(1)" in
    // the list but show "vazifa yo'q" on tap (owner-reported; Gulmira waited since 07-09).
    admin.from("homework_submissions").select("id, assignment_id, submitted_at, telegram_message_url, score, score_is_stale")
      .eq("user_id", studentId).or("score.is.null,score_is_stale.is.true").order("submitted_at", { ascending: true }),
  ]);
  const list = (subs || []) as any[];
  const name = [prof?.name, prof?.last_name].filter(Boolean).join(" ") || "—";
  if (!list.length) {
    await sendMessage(chatId, `${t.gradeStudentBreakdown(name)}\n\n${t.gradeNoneP}`, {
      inline_keyboard: [[{ text: t.gradeBackList, callback_data: "gs:list:0:all" }]],
    });
    return;
  }
  const aIds = Array.from(new Set(list.map((s) => s.assignment_id)));
  const { data: assigns } = await admin.from("homework_assignments").select("id, title, max_score, task_number, sap_number, parent_id, module_id, modules(position, title)").in("id", aIds);
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
      const tn = displayStepNumber(it.a);
      // 🔄 = resubmission awaiting REGRADE (old score shown); ⏳ = first-time ungraded.
      const isResub = it.sub.score != null && it.sub.score_is_stale;
      lines.push(isResub
        ? `   🔄 V${tn}: ${csvEscapeHtml(it.a.title || "")} (oldingi: ${it.sub.score}/${it.a.max_score || 10})`
        : `   ⏳ V${tn}: ${csvEscapeHtml(it.a.title || "")}`);
      buttons.push([{ text: `${isResub ? "🔄 " : ""}M${m.mPos + 1}·V${tn} — ${it.a.title || ""}`.slice(0, 60), callback_data: `gs:open:${it.sub.id}` }]);
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
  buttons.push([{ text: t.gradeBackList, callback_data: "gs:list:0:all" }]);
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
      // Module POSITION, not uuid: two uuids = 80 bytes > Telegram's 64-byte callback cap, which
      // made Telegram reject this whole message (BUTTON_DATA_INVALID) — audit BUG-2. ~46 bytes now.
      callback_data: `tr:mod:${studentId}:${m.mPos}`,
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
      const tn = displayStepNumber(a);
      const label = `V${tn}`;
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
      const userSubs = (subsByUser.get(p.id) || []).slice().sort((a: any, b: any) => {
        const aa = aMap.get(a.assignment_id) as any, bb = aMap.get(b.assignment_id) as any;
        return ((aa?.task_number || 0) - (bb?.task_number || 0)) || ((aa?.sap_number || 0) - (bb?.sap_number || 0));
      });
      for (const s of userSubs) {
        const a: any = aMap.get(s.assignment_id);
        if (!a) continue;
        const lbl = `V${displayStepNumber(a)}`;
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
    .select("id, assignment_id, user_id, submitted_text, submitted_image_url, submitted_at, is_late, score, score_is_stale, previous_score, telegram_message_url, telegram_file_kind")
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
  const { data: a } = await admin.from("homework_assignments").select("id, title, max_score, task_number, sap_number, parent_id").eq("id", sub.assignment_id).maybeSingle();
  const { data: p } = await admin.from("profiles").select("id, name, last_name").eq("id", sub.user_id).maybeSingle();
  const name = [p?.name, p?.last_name].filter(Boolean).join(" ") || "—";
  const tn = a ? ` #${displayStepNumber(a)}` : ""; // SAP sub-step → its sap_number (not the parent's task_number)
  const header = `<b>${csvEscapeHtml(name)}</b> — ${csvEscapeHtml(a?.title || "")}${tn}`;
  const body = sub.submitted_text ? csvEscapeHtml(sub.submitted_text) : "<i>(no text)</i>";
  // Regrade context: a resubmission carries the grade it's trying to improve — either the
  // previous_score stamp (picker-path resubmits, score reset to null) or, for STALE rows
  // (legacy/web resubmits that keep the old score with score_is_stale=true), the score itself.
  const prevLine = (sub as any).previous_score != null && sub.score == null
    ? `\n${(t as any).pkPrevGrade((sub as any).previous_score, a?.max_score || 10)}`
    : (sub.score != null && (sub as any).score_is_stale
      ? `\n🔄 ${(t as any).pkPrevGrade(sub.score, a?.max_score || 10)}` : "");
  await sendMessage(chatId, `${header}\n\n${body}${prevLine}`);
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
    // opened_sub_at: detect a resubmission landing WHILE the teacher grades (U8) — the commit
    // compares and warns instead of silently grading work that was just replaced.
    context: { submission_id: submissionId, max_score: a?.max_score || 10, grader_id: graderId, is_admin: isAdmin, opened_sub_at: sub.submitted_at },
    updated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  // Re-tag offered while gradeable: ungraded OR reopened-for-regrade (stale) — mis-tag
  // remediation requires moving reopened rows too.
  const scoreKb = (sub.score == null || (sub as any).score_is_stale)
    ? { inline_keyboard: [[{ text: t.retagBtn, callback_data: `hwmv:${submissionId}` }]] }
    : undefined;
  await sendMessage(chatId, t.gradeAskScore(a?.max_score || 10), scoreKb);
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

  // 🤖 Claude Code task capture: the next message after tapping the button is the task. The state is
  // deleted immediately (one-shot), so only the first message is consumed.
  if (state.state === "awaiting_claude_task") {
    await admin.from("bot_conversation_state").delete().eq("telegram_id", tgId);
    // Empty, /cancel, a typed command, or a tapped menu button (its label maps to a command) → cancel,
    // so a stray navigation tap is never queued as a Claude task. The owner just taps again.
    if (!text || text === "/cancel" || text.startsWith("/") || buttonTextToCommand(text)) {
      await sendWithKeyboard(msg.chat.id, t.ccCancelled, locale, isAdmin, "admin");
      return true;
    }
    // Defense-in-depth: only an allowed owner may enqueue (the state is only ever set for them).
    const { data: prof } = await admin.from("profiles").select("id").eq("telegram_id", tgId).maybeSingle();
    if (!prof || !(await claudeOwnerAllowed(admin, prof.id, tgId))) { await sendWithKeyboard(msg.chat.id, t.ccDenied, locale, isAdmin, "admin"); return true; }
    await admin.from("claude_code_tasks").insert({ prompt: text.slice(0, 8000), requested_by: prof.id, requested_tg: tgId });
    // Laptop on/off from the heartbeat freshness (the poller heartbeats every ~15-30s; 90s is generous).
    const { data: hb } = await admin.from("platform_settings").select("value").eq("key", "claude_agent_heartbeat").maybeSingle();
    const at = (hb?.value as any)?.at ? new Date((hb!.value as any).at).getTime() : 0;
    const online = at > 0 && (Date.now() - at) < 90_000;
    if (online) {
      await sendWithKeyboard(msg.chat.id, t.ccQueuedOnline, locale, isAdmin, "admin");
    } else {
      const { count } = await admin.from("claude_code_tasks").select("id", { count: "exact", head: true }).eq("status", "queued");
      await sendWithKeyboard(msg.chat.id, t.ccQueuedOffline(count || 1), locale, isAdmin, "admin");
    }
    return true;
  }

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
    // Feedback can be TEXT or a VOICE note (or both). A voice message arrives with no text, so
    // "/skip" only applies to typed input; a voice message is never a skip.
    const voiceFileId: string | null = msg.voice?.file_id || msg.audio?.file_id || null;
    const feedback = (text && text !== "/skip") ? text : null;
    const score = Number(ctx.score);

    // U8: detect a resubmission that landed WHILE the teacher was grading — warn instead of
    // silently scoring work the student just replaced.
    let racedResubmit = false;
    if (ctx.opened_sub_at && sub?.submitted_at
        && new Date(sub.submitted_at).getTime() > new Date(ctx.opened_sub_at).getTime()) {
      racedResubmit = true;
    }

    const { error: upErr } = await admin.from("homework_submissions").update({
      score, score_feedback: feedback, score_feedback_voice_file_id: voiceFileId,
      scored_by: profileId, scored_at: new Date().toISOString(), score_is_stale: false,
    }).eq("id", submissionId);
    if (upErr) {
      await sendMessage(msg.chat.id, `❌ ${upErr.message}`);
      // A real failure that hit a teacher mid-grade — capture it (system error, not a fumble).
      await logError(admin, "telegram-bot-webhook", upErr.message, {
        action: "grade_save", user_id: sub?.user_id ?? null, telegram_id: tgId,
        context: { submission_id: submissionId },
      });
      return true;
    }
    if (racedResubmit) {
      try {
        await sendMessage(msg.chat.id, "⚠️ Diqqat: siz baholayotgan paytda talaba YANGI variant yuborgan bo'lishi mumkin — topshiriqni yana bir ko'rib chiqing (📝 Baholash).");
      } catch (_e) { /* best-effort */ }
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
      const { data: a } = await admin.from("homework_assignments").select("title, max_score, task_number, sap_number, parent_id").eq("id", sub.assignment_id).maybeSingle();
      const { data: stu } = await admin.from("profiles").select("telegram_id, preferred_locale, name").eq("id", sub.user_id).maybeSingle();
      const max = a?.max_score || 10;
      if (stu?.telegram_id) {
        const stuLocale: Locale = normLocale(stu.preferred_locale);
        const tt = T[stuLocale] as any;
        const tn = a ? ` #${displayStepNumber(a)}` : ""; // SAP sub-step → its sap_number
        const title = `${a?.title || ""}${tn}`;
        try {
          const url = await createMagicLink(admin, sub.user_id, "login", "/profile");
          // S4: low scores get a one-tap resubmit right in the grade card —
          // the existing hw:resub_yes flow handles confirmation + archiving.
          const rows: any[][] = [];
          if (score < max * 0.7 && tt.hwResubYes) {
            rows.push([{ text: tt.hwResubYes, callback_data: `hw:resub_yes:${sub.assignment_id}` }]);
          }
          rows.push([{ text: tt.btnSiteOpen, url }]);
          // If the teacher left a voice note, the card flags it and the voice follows as its own
          // message (voice notes can't carry an inline keyboard, so the card keeps the buttons).
          const cardFeedback = feedback ? feedback : (voiceFileId ? tt.gradeVoiceNote : "");
          await sendLongMessage(stu.telegram_id, tt.gradeStudentDM(csvEscapeHtml(title), score, max, csvEscapeHtml(cardFeedback)), {
            inline_keyboard: rows,
          });
          if (voiceFileId) {
            const vok = await sendVoice(Number(stu.telegram_id), voiceFileId, tt.gradeVoiceNote);
            if (!vok) {
              // DB-visible signal (doctrine): a dropped voice note must not be invisible.
              console.error("grade voice delivery failed", { submission_id: submissionId, student: sub.user_id });
              try {
                await admin.from("admin_actions").insert({
                  actor_user_id: profileId, action: "grade_voice_delivery_failed",
                  target_user_id: sub.user_id, target_resource_type: "homework_submission",
                  target_resource_id: submissionId, details: { has_text: !!feedback },
                });
              } catch (_e) { /* audit best-effort */ }
            }
          }
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
    } catch (e) {
      // A genuine exception here (not a Telegram-side "blocked bot", which never throws) is a
      // real delivery fault — capture it DB-visibly instead of letting it vanish silently.
      await logError(admin, "telegram-bot-webhook", e, {
        action: "teacher_broadcast_dm", user_id: r.id, telegram_id: r.telegram_id,
      });
    }
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
    if ((profile as any).account_type === "provisional") { await sendWithKeyboard(chatId, TRIAL_LOCKED[locale] || TRIAL_LOCKED.uz, locale); return; }
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
    if ((profile as any).account_type === "provisional") { await sendWithKeyboard(chatId, TRIAL_LOCKED[locale] || TRIAL_LOCKED.uz, locale); return; }
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
    .select("id, title, max_score, task_number, sap_number, parent_id, module_id, modules(id, title, position)")
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


  // 4. Upsert intent (10 min TTL). submission_id is EXPLICITLY reset: a revived intent used to
  // inherit the previous post's submission_id, so a 🔁-resubmission post silently APPENDED to the
  // stale-scored row — no attempt bump, no score reset, no teacher DM (adversarial-review HIGH-2).
  // An explicit Topshirish must always start a fresh attempt.
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  await admin.from("bot_homework_intents").upsert({
    user_id: profile.id,
    assignment_id: assignmentId,
    module_id: a.module_id,
    group_id: profile.group_id,
    telegram_chat_id: parsed.chatId,
    telegram_thread_id: parsed.threadId,
    submission_id: null,
    expires_at: expiresAt,
    created_at: new Date().toISOString(),
  }, { onConflict: "user_id,assignment_id" });

  const mn = (a.modules?.position ?? 0) + 1;
  const tn = displayStepNumber(a); // SAP sub-step → its sap_number ("Vazifa 1/2/3"), not the parent's task_number
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
    const { data: mods } = await admin.from("modules").select("id, position").eq("course_id", group.course_id).order("position");
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
    // SMARTER AUTO-TAG (v3.14.42): a bare post used to attach to the FIRST un-submitted leaf of
    // the whole course, so anyone not submitting strictly in order got "Module 1 · Task 1".
    // Bias the guess to the student's CURRENT module — where they most recently watched a lesson
    // or submitted homework — then its successor (just-finished-a-module case). If neither has an
    // open task (or the student has no history), fall back to exactly the old global behavior.
    let asg: any = null;
    try {
      const [lpRes, hwRes] = await Promise.all([
        admin.from("lesson_progress")
          .select("updated_at, lessons!inner(module_id)")
          .eq("user_id", profileId).in("lessons.module_id", modIds)
          .order("updated_at", { ascending: false }).limit(1),
        admin.from("homework_submissions")
          .select("submitted_at, homework_assignments!inner(module_id)")
          .eq("user_id", profileId).in("homework_assignments.module_id", modIds)
          .order("submitted_at", { ascending: false }).limit(1),
      ]);
      const lp = (lpRes.data || [])[0] as any;
      const hw = (hwRes.data || [])[0] as any;
      const lpTs = lp?.updated_at ? Date.parse(lp.updated_at) : 0;
      const hwTs = hw?.submitted_at ? Date.parse(hw.submitted_at) : 0;
      const currentModuleId: string | null =
        lpTs || hwTs
          ? (lpTs >= hwTs ? (lp?.lessons?.module_id ?? null) : (hw?.homework_assignments?.module_id ?? null))
          : null;
      if (currentModuleId) {
        const subMap = new Map(((existingSubs || []) as any[]).map((s: any) => [s.assignment_id, s]));
        const openLeafIn = (mid: string) =>
          (leaves as any[]).find((l: any) => l.module_id === mid && (() => { const s = subMap.get(l.id); return !s || s.score == null; })());
        asg = openLeafIn(currentModuleId) || null;
        if (!asg) {
          const idx = modIds.indexOf(currentModuleId);
          const nextModId = idx >= 0 ? modIds[idx + 1] : undefined;
          if (nextModId) asg = openLeafIn(nextModId) || null;
        }
        if (asg) console.log("hw:group:smart-tag", JSON.stringify({ profile_id: profileId, module_id: asg.module_id, assignment_id: asg.id }));
      }
    } catch (e) {
      console.error("hw:group:smart-tag-err", String(e)); // heuristic is best-effort — never block capture
    }
    if (!asg) {
      asg =
        pickNextLeaf(leaves as any, (existingSubs || []) as any) ||
        // All graded: fall back to the most recent leaf so a resubmission still attaches somewhere.
        [...leaves].sort((a: any, b: any) => String(b.created_at || "").localeCompare(String(a.created_at || "")))[0];
    }
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

// ---------------- In-group picker ("ask, then guess") ----------------
// Picker mode holds a media post in hw_pending_posts and asks the student in-thread
// (inline buttons work in groups for ANY member — no bot Start needed, unlike DMs,
// which only ~30% of students can receive). On pick → real submission for the chosen
// task. No pick in ~10 min → the smart auto-tag fallback files it anyway (sweep below),
// so work is NEVER lost. Explicit /vazifalar intents bypass the picker entirely.

// Turn a pending post into a real submission (shared by the pick tap and the expiry sweep).
async function finalizePendingPost(
  admin: any,
  pending: any,
  assignmentId: string,
  moduleId: string,
  guessed: boolean,
  // "fresh": no prior work expected. "append": add these files to the existing ungraded
  // submission. "replace": full resubmission (attempt bump, score reset) — ONLY after the
  // student explicitly confirmed. Back-to-back different-homework posts each get their own
  // picker (the old 5-min post-finalize append window is gone — it hijacked the next post).
  action: "fresh" | "append" | "replace" = "fresh",
): Promise<"created" | "appended" | "already_graded" | "tier_locked" | "error"> {
  try {
    const chatId = Number(pending.telegram_chat_id);
    const threadId = Number(pending.telegram_thread_id);
    const firstMsgId = Number(pending.first_message_id);
    const deletePicker = async () => {
      if (pending.picker_message_id) {
        try { await tgApi("deleteMessage", { chat_id: chatId, message_id: Number(pending.picker_message_id) }); } catch (_e) { /* best-effort */ }
      }
    };
    // Morph the picker into a visible receipt, then self-delete (~30s; sweep is the backstop).
    const morphReceipt = async (text: string) => {
      if (!pending.picker_message_id) return;
      const pickerMsgId = Number(pending.picker_message_id);
      try {
        await tgApi("editMessageText", { chat_id: chatId, message_id: pickerMsgId, text, parse_mode: "HTML" });
        const delayedDelete = (async () => {
          await new Promise((r) => setTimeout(r, 30_000));
          try { await tgApi("deleteMessage", { chat_id: chatId, message_id: pickerMsgId }); } catch (_e) { /* sweep backstop */ }
          try { await admin.from("hw_pending_posts").update({ picker_message_id: null }).eq("id", pending.id); } catch (_e) { /* ignore */ }
        })();
        const er: any = (globalThis as any).EdgeRuntime;
        if (er?.waitUntil) er.waitUntil(delayedDelete); else delayedDelete.catch(() => {});
      } catch (_e) { /* receipt is best-effort; ✅ reaction + DM still stand */ }
    };
    const { data: profile } = await admin.from("profiles")
      .select("id, name, last_name, telegram_id, telegram_username, preferred_locale")
      .eq("id", pending.user_id).maybeSingle();
    const locale: Locale = normLocale(profile?.preferred_locale);
    const t = T[locale] as any;

    // Already-graded short-circuit (same rule as the auto path).
    // On an EXPLICIT pick (guessed=false) do NOT consume the pending post: the student is told
    // "pick another" — so the picker must stay alive and the post must stay pending. Consuming it
    // here (v1 bug, caught in owner testing) silently lost the post while showing a ✅ reaction.
    const { data: prior } = await admin.from("homework_submissions")
      .select("id, score, score_is_stale, previous_score, media, submitted_text").eq("user_id", pending.user_id).eq("assignment_id", assignmentId).maybeSingle();
    // Carry the grade memory: a graded prior stamps its score; an ungraded prior (pending regrade)
    // keeps whatever previous_score it already carried. Fresh submissions carry null.
    const prevScore: number | null = prior && prior.score != null ? prior.score : ((prior as any)?.previous_score ?? null);
    if (prior && prior.score != null && !prior.score_is_stale && action !== "replace") {
      if (!guessed) return "already_graded"; // picker stays open; nothing consumed
      // Sweep fallback: mirror the legacy auto path (acknowledge, inform, consume).
      await admin.from("hw_pending_posts").update({ state: "done" }).eq("id", pending.id);
      await deletePicker();
      try { await setMessageReaction(chatId, firstMsgId, "✅"); } catch (_e) { /* ignore */ }
      if (profile?.telegram_id) { try { await sendMessage(Number(profile.telegram_id), t.hwIntentAlreadyScored); } catch (_e) { /* ignore */ } }
      return "already_graded";
    }
    // Tier gate (defense-in-depth).
    if (await isModuleBlocked(admin, pending.user_id, moduleId)) {
      if (!guessed) return "tier_locked"; // explicit pick: picker stays open, pick another module
      await admin.from("hw_pending_posts").update({ state: "expired" }).eq("id", pending.id);
      await deletePicker();
      return "tier_locked";
    }

    // ATOMIC CLAIM (adversarial-review MED-1): the sweep and a late tap both read state='pending'
    // and could double-file one post under two assignments (two submissions, two teacher DMs).
    // First writer wins; the loser aborts here. Downstream failures revert to 'pending' so the
    // sweep retries. (All read-only guards above return WITHOUT consuming, so claiming here is
    // exactly the commit point.)
    const { data: _claimed } = await admin.from("hw_pending_posts")
      .update({ state: "done", expires_at: new Date(Date.now() + 90_000).toISOString() })
      .eq("id", pending.id).eq("state", "pending").select("id");
    if (!_claimed || !_claimed.length) {
      console.log("pk:finalize-claim-lost", JSON.stringify({ pending_id: pending.id }));
      return "error";
    }
    const revertClaim = async () => {
      try {
        await admin.from("hw_pending_posts")
          .update({ state: "pending", expires_at: new Date(Date.now() + 60_000).toISOString() })
          .eq("id", pending.id);
      } catch (_e) { /* sweep's done-pass will still clean the picker */ }
    };

    // APPEND: the task already has an UNGRADED submission and the student chose ➕ (or this is
    // the auto-fallback / an unscreened path — a guess must never wipe already-submitted files).
    // Adds the new files to the existing submission: no attempt bump, no score change, no new
    // teacher DM (the teacher was already notified for the original submission).
    if (prior && prior.score == null && action !== "replace") {
      const priorMedia = Array.isArray((prior as any).media) ? (prior as any).media : [];
      const addMedia = Array.isArray(pending.media) ? pending.media : [];
      const mergedMedia = priorMedia.concat(addMedia).slice(0, 10);
      const addText = (pending.submitted_text || "").slice(0, 4000);
      const priorText = ((prior as any).submitted_text || "") as string;
      const mergedText = priorText && addText && !priorText.includes(addText)
        ? `${priorText}\n${addText}`.slice(0, 4000) : (priorText || addText);
      const { error: mergeErr } = await admin.from("homework_submissions")
        .update({ media: mergedMedia, submitted_text: mergedText }).eq("id", (prior as any).id);
      if (mergeErr) { console.error("pk:append-err", mergeErr); await revertClaim(); return "error"; }
      const { data: a0 } = await admin.from("homework_assignments")
        .select("task_number, sap_number, parent_id, modules:module_id(position)").eq("id", assignmentId).maybeSingle();
      const lbl0 = `M${(((a0 as any)?.modules?.position ?? 0) as number) + 1} · V${a0 ? displayStepNumber(a0 as any) : ""}`;
      await admin.from("hw_pending_posts")
        .update({ state: "done", expires_at: new Date(Date.now() + 90_000).toISOString() })
        .eq("id", pending.id);
      try { await setMessageReaction(chatId, firstMsgId, "✅"); } catch (_e) { /* ignore */ }
      await morphReceipt(t.pkAppended(lbl0, mergedMedia.length));
      cacheInvalidateUser(pending.user_id);
      console.log("pk:appended", JSON.stringify({ pending_id: pending.id, submission_id: (prior as any).id, n: mergedMedia.length, guessed }));
      return "appended";
    }

    const media = Array.isArray(pending.media) ? pending.media.slice(0, 10) : [];
    const first = media[0] || {};
    const messageUrl = buildMessageLink(chatId, threadId, firstMsgId);
    const { data: existingSub } = await admin.from("homework_submissions")
      .select("attempt_number").eq("user_id", pending.user_id).eq("assignment_id", assignmentId).maybeSingle();
    const nextAttempt = ((existingSub?.attempt_number as number | null) ?? 0) + 1;
    const { data: upserted, error: upErr } = await admin.from("homework_submissions").upsert({
      user_id: pending.user_id,
      assignment_id: assignmentId,
      submitted_text: (pending.submitted_text || "").slice(0, 4000),
      submitted_at: new Date().toISOString(),
      attempt_number: nextAttempt,
      score: null, score_feedback: null, score_feedback_voice_file_id: null, scored_by: null, scored_at: null,
      score_is_stale: false, is_late: false,
      previous_score: prevScore,
      telegram_chat_id: chatId,
      telegram_thread_id: threadId,
      telegram_message_id: firstMsgId,
      telegram_message_url: messageUrl,
      telegram_file_id: (first as any).file_id || null,
      telegram_file_kind: (first as any).kind || null,
      media,
      source: "telegram_topic",
    }, { onConflict: "user_id,assignment_id" }).select("id").maybeSingle();
    if (upErr || !upserted?.id) { console.error("pk:finalize-upsert-err", upErr); await revertClaim(); return "error"; }

    // NOTE: no post-finalize intent window anymore. It made the NEXT image silently append to
    // this submission (owner-reported). Now every new post opens its own picker; adding files to
    // this task = pick the same task again → ➕ "Fayl qo'shish".

    try { await setMessageReaction(chatId, firstMsgId, "✅"); } catch (_e) { /* ignore */ }

    // Assignment meta for the notifications + the visible receipt.
    const { data: a } = await admin.from("homework_assignments")
      .select("title, task_number, sap_number, parent_id, module_id, max_score, modules(position)")
      .eq("id", assignmentId).maybeSingle();
    const mn = ((a?.modules?.position ?? 0) as number) + 1;
    // SAP sub-step → its sap_number ("Vazifa 1/2/3"); a normal task → task_number. The step now
    // rides on `tn`, so the title stays the plain descriptive text (no more "V3.S1" prefix that
    // read as "step 3" for every sub-step — the reported bug).
    const tn = a ? displayStepNumber(a) : 1;
    let aTitle = a?.title || "";
    if (guessed) aTitle = `${aTitle} (taxminiy)`; // teacher sees the tag was auto-guessed → ✏️ if wrong

    // VISIBLE RECEIPT (owner feedback: the toast alone is too easy to miss): morph the picker
    // message into a short confirmation everyone can see, then self-delete after ~30s.
    // waitUntil gives the precise 30s; the sweep's done-row pass is the backstop if the
    // instance dies first (expires_at doubles as the deletion deadline once state='done').
    await admin.from("hw_pending_posts")
      .update({ state: "done", expires_at: new Date(Date.now() + 90_000).toISOString() })
      .eq("id", pending.id);
    // Resubmission receipt carries the grade being improved — the student sees what they had.
    // U2: if the files span 2+ distinct Telegram albums (or an album plus extra singles), the
    // student may have bundled DIFFERENT homeworks into one submission — say so in the receipt.
    const mgids = new Set<string>();
    let singles = 0;
    for (const it of media as any[]) { if (it?.mgid) mgids.add(String(it.mgid)); else singles++; }
    const multiAlbum = mgids.size >= 2 || (mgids.size >= 1 && singles > 0);
    const albumWarn = multiAlbum
      ? `\n⚠️ Bir nechta yuklama aniqlandi — agar bular BOSHQA vazifalar bo'lsa, ularni alohida yuborib, to'g'ri vazifani tanlang.` : "";
    const confLbl = `M${mn} · V${tn}${guessed ? " (avto)" : ""}`;
    await morphReceipt(t.pkDoneMsg(confLbl)
      + (prevScore != null ? `\n${t.pkPrevGrade(prevScore, (a?.max_score ?? 10) as number)}` : "")
      + albumWarn);

    if (profile?.telegram_id) {
      try { await sendMessage(Number(profile.telegram_id), t.hwReceived(mn, tn, undefined, undefined)); } catch (_e) { /* ~70% can't be DMed — the ✅ reaction is the receipt */ }
    }
    await notifyTeachersOfSubmission(admin, profile || { id: pending.user_id }, pending.group_id, mn, tn, aTitle, messageUrl, upserted.id, assignmentId, moduleId);
    cacheInvalidateUser(pending.user_id);
    console.log("pk:finalized", JSON.stringify({ pending_id: pending.id, submission_id: upserted.id, assignment_id: assignmentId, guessed }));
    return "created";
  } catch (e) {
    console.error("pk:finalize-err", String(e));
    return "error";
  }
}

// U5: throttle map for the anonymous-poster hint (one per topic per 15 min).
const __anonHintAt = new Map<string, number>();

// Expiry sweep: unanswered pickers fall back to the smart auto-tag guess. Runs opportunistically
// on group traffic (throttled) — a quiet night just delays the fallback, which is harmless
// because grading happens on a scale of days.
// ~10s "choose your task" nudge after the picker if the student neither picks nor engages.
const PICK_REMINDER_MS = 10_000;

// Sends the one-time pick-reminder for a pending picker post, IF it is still pending and neither
// reminded nor engaged. The atomic claim (set reminder_at where it is null) both dedupes and defers
// to the hwpk handler, which sets reminder_at the moment the student taps any picker button — so an
// actively-choosing student is never nagged (member-forgiving). Best-effort; re-sends the modules.
async function maybeSendPickReminder(admin: any, pendingId: string) {
  const { data: p } = await admin.from("hw_pending_posts")
    .update({ reminder_at: new Date().toISOString() })
    .eq("id", pendingId).eq("state", "pending").is("reminder_at", null)
    .select("id, user_id, course_id, telegram_chat_id, telegram_thread_id, first_message_id")
    .maybeSingle();
  if (!p?.id) return; // picked, engaged, expired, or already reminded
  try {
    const { data: prof } = await admin.from("profiles").select("preferred_locale").eq("id", p.user_id).maybeSingle();
    const t = T[normLocale(prof?.preferred_locale)] as any;
    const { data: mods } = await admin.from("modules").select("id, position").eq("course_id", p.course_id).order("position");
    const btns = ((mods || []) as any[]).map((m: any, i: number) => ({ text: `M${(m.position ?? 0) + 1}`, callback_data: `hwpk:${p.id}:m:${i}` }));
    const rows: any[][] = [];
    for (let i = 0; i < btns.length; i += 4) rows.push(btns.slice(i, i + 4));
    const resp = await tgApi("sendMessage", {
      chat_id: Number(p.telegram_chat_id), message_thread_id: Number(p.telegram_thread_id),
      reply_to_message_id: Number(p.first_message_id),
      text: t.pkRemind, parse_mode: "HTML", disable_web_page_preview: true,
      reply_markup: { inline_keyboard: rows },
    });
    const body: any = await resp.json().catch(() => null);
    if (resp.ok && body?.ok) {
      console.log("pk:reminder-sent", JSON.stringify({ pending_id: p.id }));
    } else {
      // Benign: the student deleted their post before the nudge (reply target gone) — no work lost,
      // the 10-min auto-tag still finalizes. Systemic (bot kicked / topic closed / write forbidden)
      // → a DB-visible signal so the watchdog/digest layer sees reminders failing, not just logs.
      const desc = String(body?.description || resp.status);
      if (/reply/i.test(desc)) {
        console.log("pk:reminder-skip-benign", JSON.stringify({ pending_id: p.id, desc }));
      } else {
        await logError(admin, "pk-reminder", `send failed: ${desc}`.slice(0, 200),
          { action: "pick_reminder_failed", user_id: p.user_id, telegram_id: Number(p.telegram_chat_id), context: { pending_id: p.id } });
      }
    }
  } catch (e) {
    await logError(admin, "pk-reminder", e instanceof Error ? e.message : String(e),
      { action: "pick_reminder_failed", user_id: p.user_id, context: { pending_id: p.id } });
  }
}

let __pkLastSweep = 0;
async function sweepExpiredPendingPosts(admin: any) {
  if (Date.now() - __pkLastSweep < 60_000) return;
  __pkLastSweep = Date.now();
  try {
    const { data: rows } = await admin.from("hw_pending_posts")
      .select("*").eq("state", "pending").lt("expires_at", new Date().toISOString())
      .order("expires_at", { ascending: true }) // oldest first — a bursty backlog drains fairly
      .limit(5);
    for (const p of (rows || []) as any[]) {
      try {
        const { data: grp } = await admin.from("groups")
          .select("id, course_id, homework_topic_id").eq("id", p.group_id).maybeSingle();
        const resolved = grp ? await resolveAssignmentForTopic(admin, grp, Number(p.telegram_thread_id), p.user_id) : null;
        if (!resolved) {
          await admin.from("hw_pending_posts").update({ state: "expired" }).eq("id", p.id);
          if (p.picker_message_id) { try { await tgApi("deleteMessage", { chat_id: Number(p.telegram_chat_id), message_id: Number(p.picker_message_id) }); } catch (_e) { /* ignore */ } }
          console.log("pk:sweep-unresolved", JSON.stringify({ pending_id: p.id }));
          continue;
        }
        await finalizePendingPost(admin, p, resolved.assignment.id, resolved.moduleId, true);
      } catch (e) { console.error("pk:sweep-row-err", String(e)); }
    }
    // Reminder backstop: pending posts whose ~10s pick-reminder never fired (this instance died
    // before waitUntil). Still pending, not yet reminded/engaged, past the delay, not yet expired.
    const remindCutoff = new Date(Date.now() - PICK_REMINDER_MS).toISOString();
    const { data: needRemind } = await admin.from("hw_pending_posts")
      .select("id").eq("state", "pending").is("reminder_at", null)
      .lt("created_at", remindCutoff).gt("expires_at", new Date().toISOString()).limit(5);
    for (const r of (needRemind || []) as any[]) {
      try { await maybeSendPickReminder(admin, r.id); } catch (_e) { /* ignore */ }
    }

    // Backstop pass: receipts whose timed self-delete didn't run (instance died) —
    // done rows past their deletion deadline that still hold a picker/receipt message.
    const { data: doneRows } = await admin.from("hw_pending_posts")
      .select("id, telegram_chat_id, picker_message_id")
      .eq("state", "done").not("picker_message_id", "is", null)
      .lt("expires_at", new Date().toISOString()).limit(10);
    for (const d of (doneRows || []) as any[]) {
      try { await tgApi("deleteMessage", { chat_id: Number(d.telegram_chat_id), message_id: Number(d.picker_message_id) }); } catch (_e) { /* may already be gone */ }
      await admin.from("hw_pending_posts").update({ picker_message_id: null }).eq("id", d.id);
    }
  } catch (e) { console.error("pk:sweep-err", String(e)); }
}

// AUTO-REGISTER (flag "auto_register"): an unknown Telegram member posting valid homework media
// in a registered homework topic becomes a PROVISIONAL student on the spot — name/username/id
// come from their Telegram profile (no form), the group comes from the chat they posted in.
// Routed through the admin-create-students engine so all dedupe/role rules apply. CRITICAL:
// account_type is NOT passed to the engine — an existing platform student matched by username
// must never be downgraded; provisional is set only when the engine reports status='created'.
async function autoRegisterProvisionalPoster(
  admin: any,
  msg: any,
  chatId: number,
  threadId: number,
): Promise<any | null> {
  try {
    const from = msg.from;
    if (!from?.id || from.is_bot) return null;
    const cfg = await getHomeworkCaptureConfig(admin);
    if (!cfg.autoRegister) { console.log("hw:autoreg:skip", JSON.stringify({ reason: "flag_off" })); return null; }
    // COURSE-AWARE chat→group resolution. One Telegram chat can host TWO platform groups (real
    // case: 9-GURUH 4.0 and 1-GURUH PRE 5.0 share t.me/c/3718576417 — the chat was reused for the
    // new cohort). resolveGroupFromChatId's limit(1) picked the finished-4.0 group and the course
    // scope silently bailed (caught in owner testing). Fetch ALL candidates whose homework topic
    // is THIS thread and prefer the in-scope (active-course) one — new members of a reused chat
    // belong to the current cohort.
    const stripped = String(chatId).replace(/^-100/, "");
    const needle = `%/c/${stripped}/%`;
    const { data: cands } = await admin.from("groups")
      .select("id, course_id, homework_topic_id, courses:course_id(published)")
      .or(`homework_topic_url.ilike.${needle},telegram_group_url.ilike.${needle}`);
    const all = (cands || []) as any[];
    const withTopic: any[] = [];
    for (const g of all) {
      if (!g.course_id) continue;
      let ok = g.homework_topic_id != null && Number(g.homework_topic_id) === Number(threadId);
      if (!ok) {
        const { data: gmt } = await admin.from("group_module_topics")
          .select("module_id").eq("group_id", g.id).eq("telegram_topic_id", threadId).maybeSingle();
        ok = !!gmt?.module_id;
      }
      if (ok) withTopic.push(g);
    }
    const grp = withTopic.find((g: any) => cfg.courseIds.length === 0 || cfg.courseIds.includes(g.course_id))
      ?? null;
    if (!grp) {
      console.log("hw:autoreg:skip", JSON.stringify({
        reason: "no_in_scope_group_for_topic", chatId, threadId,
        candidates: all.map((g: any) => ({ id: g.id, course: g.course_id })),
      }));
      return null;
    }

    // U4: never auto-register the CHAT'S ADMINS as students — unregistered staff posting an
    // example image in the homework topic must not become a provisional student + submission.
    try {
      const cmResp = await tgApi("getChatMember", { chat_id: chatId, user_id: from.id });
      const cm: any = await cmResp.json().catch(() => null);
      const st = cm?.result?.status;
      if (st === "administrator" || st === "creator") {
        console.log("hw:autoreg:skip", JSON.stringify({ reason: "chat_admin", tg: from.id }));
        return null;
      }
    } catch (_e) { /* best-effort — proceed */ }

    // Shared creation engine (also used by the DM /start membership path).
    const reg = await registerProvisionalViaEngine(admin, from, grp, "homework_topic_post");
    if (!reg) return null;
    if (reg.created) {
      // Welcome them in-thread (they can't be DMed — they never started the bot).
      try {
        const t = T.uz as any;
        const botU = Deno.env.get("TELEGRAM_BOT_USERNAME") || "";
        const kb = botU ? { inline_keyboard: [[{ text: t.pkWelcomeBtn, url: `https://t.me/${botU}` }]] } : undefined;
        await tgApi("sendMessage", {
          chat_id: chatId, message_thread_id: threadId, reply_to_message_id: msg.message_id,
          text: t.pkWelcome((from.first_name || from.username || "do'st").slice(0, 40)),
          parse_mode: "HTML", disable_web_page_preview: true,
          ...(kb ? { reply_markup: kb } : {}),
        });
      } catch (_e) { /* welcome is best-effort */ }
    }
    return await findProfileByTelegramId(admin, from.id);
  } catch (e) {
    console.error("hw:autoreg:err", String(e));
    return null;
  }
}

// Server-to-server into the proven creation engine (same pattern as staff-intake). Shared by
// the in-topic auto-register and the DM /start membership path — one engine, all dedupe/role
// rules apply in one place. CRITICAL: account_type is NOT passed to the engine — an existing
// platform student matched by username must never be downgraded; provisional is set only when
// the engine reports status='created'.
async function registerProvisionalViaEngine(
  admin: any,
  from: { id: number; username?: string; first_name?: string; last_name?: string },
  grp: { id: string; course_id: string },
  source: string,
): Promise<{ created: boolean } | null> {
  const { data: sec } = await admin.rpc("internal_fn_secret");
  if (!sec) return null;
  const resp = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/admin-create-students`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-secret": String(sec),
      "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      "apikey": Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    },
    body: JSON.stringify({
      students: [{
        name: (from.first_name || "").slice(0, 60) || (from.username || `tg-${from.id}`),
        last_name: (from.last_name || "").slice(0, 60) || undefined,
        telegram_user_id: from.id,
        telegram_username: from.username || undefined,
        role: "student",
      }],
      target_group_id: grp.id,
      target_course_id: grp.course_id,
    }),
  });
  const out = await resp.json().catch(() => ({}));
  const r0 = (out?.results || [])[0] || {};
  if (!r0.userId) {
    console.log("hw:autoreg:engine-refused", JSON.stringify({ tg: from.id, status: r0.status, err: r0.error, source }));
    return null;
  }
  if (r0.status === "created") {
    // New account → trial. (Existing matched accounts keep their type untouched.)
    await admin.from("profiles").update({ account_type: "provisional" }).eq("id", r0.userId);
    try {
      await admin.from("admin_actions").insert({
        actor_user_id: null, action: "auto_registered_provisional", target_user_id: r0.userId,
        target_resource_type: "profile", target_resource_id: r0.userId,
        details: { telegram_id: from.id, telegram_username: from.username || null, group_id: grp.id, source },
      });
    } catch (_e) { /* audit best-effort */ }
    console.log("hw:autoreg:created", JSON.stringify({ user_id: r0.userId, tg: from.id, group_id: grp.id, source }));
    return { created: true };
  }
  console.log("hw:autoreg:matched-existing", JSON.stringify({ user_id: r0.userId, tg: from.id, status: r0.status, source }));
  return { created: false };
}

// A media post under picker mode: append to the live pending post (albums) or create one + ask.
async function handlePickerPost(
  admin: any,
  profile: any,
  grp: any,
  chatId: number,
  threadId: number,
  messageId: number,
  item: Record<string, unknown>,
  caption: string,
) {
  const nowIso = new Date().toISOString();
  const { data: live } = await admin.from("hw_pending_posts")
    .select("id, media, submitted_text")
    .eq("user_id", profile.id).eq("telegram_chat_id", chatId).eq("telegram_thread_id", threadId)
    .eq("state", "pending").gt("expires_at", nowIso).maybeSingle();
  if (live) {
    // U14: atomic SQL append — concurrent album siblings can no longer lose items to
    // read-modify-write races.
    const { data: n } = await admin.rpc("append_pending_media", { _id: live.id, _item: item, _caption: caption || "" });
    if (typeof n === "number" && n >= 0) {
      try { await tgApi("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: [{ type: "emoji", emoji: "👍" }] }); } catch (_e) { /* ignore */ }
    } else if (n === -1) {
      try { await tgApi("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: [{ type: "emoji", emoji: "🙈" }] }); } catch (_e) { /* ignore */ }
    } else {
      // -2: the pending finalized between our select and the append (album tail) — the file
      // remains visible in the topic thread; log only.
      console.log("pk:append-after-finalize-ignored", JSON.stringify({ pending_id: live.id, messageId }));
    }
    return;
  }
  // Create the pending row. A racing album sibling may win the unique index — append instead.
  const { data: created, error: insErr } = await admin.from("hw_pending_posts").insert({
    user_id: profile.id,
    from_tg_id: Number(profile.telegram_id),
    group_id: grp.id,
    course_id: grp.course_id,
    telegram_chat_id: chatId,
    telegram_thread_id: threadId,
    first_message_id: messageId,
    media: [item],
    submitted_text: (caption || "").slice(0, 4000),
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  }).select("id").maybeSingle();
  if (insErr || !created?.id) {
    // unique-violation race (album): retry as append
    const { data: live2 } = await admin.from("hw_pending_posts")
      .select("id").eq("user_id", profile.id).eq("telegram_chat_id", chatId)
      .eq("telegram_thread_id", threadId).eq("state", "pending").maybeSingle();
    if (live2) {
      const { data: n2 } = await admin.rpc("append_pending_media", { _id: live2.id, _item: item, _caption: caption || "" });
      const emoji = (typeof n2 === "number" && n2 >= 0) ? "👍" : (n2 === -1 ? "🙈" : null);
      if (emoji) {
        try { await tgApi("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: [{ type: "emoji", emoji }] }); } catch (_e) { /* ignore */ }
      }
    } else {
      console.error("pk:insert-err", insErr);
    }
    return;
  }
  // Ask, in-thread, in the student's language. Buttons work for everyone; only the poster's taps count.
  const locale: Locale = normLocale(profile.preferred_locale);
  const t = T[locale] as any;
  const { data: mods } = await admin.from("modules")
    .select("id, position").eq("course_id", grp.course_id).order("position");
  const ordered = (mods || []) as any[];
  const btns = ordered.map((m: any, i: number) => ({ text: `M${(m.position ?? 0) + 1}`, callback_data: `hwpk:${created.id}:m:${i}` }));
  const rows: any[][] = [];
  for (let i = 0; i < btns.length; i += 4) rows.push(btns.slice(i, i + 4));
  try {
    const resp = await tgApi("sendMessage", {
      chat_id: chatId,
      message_thread_id: threadId,
      reply_to_message_id: messageId,
      text: t.pkAsk,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: rows },
    });
    const body: any = await resp.json().catch(() => null);
    const pickerMsgId = body?.result?.message_id;
    if (pickerMsgId) await admin.from("hw_pending_posts").update({ picker_message_id: pickerMsgId }).eq("id", created.id);
  } catch (e) { console.error("pk:ask-send-err", String(e)); /* sweep will auto-tag it */ }
  console.log("pk:pending-created", JSON.stringify({ pending_id: created.id, user_id: profile.id, chatId, threadId, messageId }));

  // ~10s nudge if the student neither picks nor engages. waitUntil gives the precise delay; the
  // expiry sweep is the backstop if this instance dies first. Suppressed the instant they tap any button.
  const remindTask = (async () => {
    await new Promise((r) => setTimeout(r, PICK_REMINDER_MS));
    await maybeSendPickReminder(admin, created.id);
  })();
  const erR: any = (globalThis as any).EdgeRuntime;
  if (erR?.waitUntil) erR.waitUntil(remindTask); else remindTask.catch(() => {});
}

async function handleGroupTopicMessage(admin: any, msg: any) {
  try {
    // Opportunistic fallback sweep: unanswered pickers auto-tag after expiry (throttled, cheap).
    sweepExpiredPendingPosts(admin).catch(() => {});
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
    let kind: "photo" | "video" | "document" | "link" | null = null;
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
    // Links are NOT homework (owner decision 2026-07-11): only photos, videos, and uploaded
    // files count. A text message containing a URL is treated like any other chat message and
    // ignored. (linkUrl stays declared because the media-item builders reference it.)
    const linkUrl: string | null = null;
    if (!kind) {
      console.log("hw:group:non-media-ignored", JSON.stringify({ chatId, threadId, messageId }));
      return;
    }

    // Try to identify the student (only useful when not anonymous)
    let profile: any = null;
    if (fromId && !isAnon) {
      profile = await findProfileByTelegramId(admin, fromId);
    }

    // U5: ANONYMOUS posts (send-as-group / send-as-channel) can't be attributed to a student —
    // they used to vanish with zero feedback. Hint ONLY for fresh non-reply posts in a REGISTERED
    // homework topic (teachers commonly answer anonymously WITH media as replies — never hint at
    // those), throttled to one per topic per 15 min.
    if (isAnon || msg.sender_chat) {
      if (!msg.reply_to_message) {
        const stripped0 = String(chatId).replace(/^-100/, "");
        const { data: hwg } = await admin.from("groups").select("id")
          .eq("homework_topic_id", threadId)
          .ilike("homework_topic_url", `%/c/${stripped0}/%`).limit(1);
        if (hwg && hwg.length) {
          const k = `${chatId}:${threadId}`;
          if ((Date.now() - (__anonHintAt.get(k) || 0)) > 15 * 60_000) {
            __anonHintAt.set(k, Date.now());
            try {
              await tgApi("sendMessage", {
                chat_id: chatId, message_thread_id: threadId, reply_to_message_id: messageId,
                text: "⚠️ Anonim rejimda yuborilgan vazifa qabul qilinmaydi. Iltimos, anonim rejimni o'chirib, o'z nomingizdan qaytadan yuboring.",
              });
            } catch (_e) { /* best-effort */ }
          }
          console.log("hw:group:anon-poster-hinted", JSON.stringify({ chatId, threadId, messageId }));
        }
      }
      return;
    }

    // Strict per-student attribution — but an unknown group member posting real homework in a
    // registered homework topic can now SELF-REGISTER as a provisional student (flag-gated;
    // name/username/id come from Telegram, group from the chat — no form, no bot-start needed).
    if (!profile) {
      profile = await autoRegisterProvisionalPoster(admin, msg, chatId, threadId);
      if (!profile) {
        console.log("hw:group:unknown-sender-ignored", JSON.stringify({ fromId, isAnon, chatId, threadId, messageId }));
        return;
      }
    }

    const nowIso = new Date().toISOString();
    const { data: intents, error: intentErr } = await admin
      .from("bot_homework_intents")
      .select("id, user_id, assignment_id, module_id, group_id, submission_id")
      .eq("telegram_chat_id", chatId)
      .eq("telegram_thread_id", threadId)
      .eq("user_id", profile.id)
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: false })
      .limit(1);
    if (intentErr) console.error("hw:group:intent-query-err", intentErr);
    let intent = (intents && intents[0]) as any;

    // v3.14.40 AUTO-SYNTHESIS (restored 2026-07-07): students post their work
    // DIRECTLY in the homework topic — almost nobody presses 📤 Topshirish first
    // (of ~280 intents ever, ~all submissions came from direct posts). A prior
    // revert re-enabled a strict gate here and silently dropped every direct
    // post. So when there's no explicit intent, resolve THIS identified sender's
    // current assignment for the topic and synthesize an intent. Strict per-
    // sender: profile is the confirmed poster (anon/bot/unknown already filtered
    // above), so a post can never be attributed to anyone else.
    if (!intent) {
      const { data: prof2 } = await admin.from("profiles").select("group_id").eq("id", profile.id).maybeSingle();
      const groupId = prof2?.group_id ?? null;
      const grp = groupId
        ? (await admin.from("groups").select("id, course_id, homework_topic_id, homework_topic_url").eq("id", groupId).maybeSingle()).data
        : null;

      // ENFORCE-BOT-FLOW gate (course-scoped): if this student's course is configured for
      // "require_intent", a post NOT initiated via /vazifalar → 📤 Topshirish is not homework.
      // Send a one-time hint (rate-limited ~1/15 min) and stop — no submission, no teacher ping.
      // Courses out of scope (e.g. finished 4.0) fall through to auto-synthesis (today's behavior).
      const cfg = await getHomeworkCaptureConfig(admin);
      const enforce = cfg.mode === "require_intent" && !!grp?.course_id
        && (cfg.courseIds.length === 0 || cfg.courseIds.includes(grp.course_id));
      if (enforce) {
        try {
          if (profile.telegram_id) {
            const since = new Date(Date.now() - 15 * 60_000).toISOString();
            const { data: recentHint } = await admin.from("notifications_log")
              .select("id").eq("user_id", profile.id).eq("notification_type", "hw_require_intent_hint")
              .gte("sent_at", since).limit(1);
            if (!recentHint || !recentHint.length) {
              const loc: Locale = normLocale(profile.preferred_locale);
              await sendMessage(profile.telegram_id, (T[loc] as any).hwRequireIntentHint);
              await admin.from("notifications_log").insert({
                user_id: profile.id, notification_type: "hw_require_intent_hint", sent_at: new Date().toISOString(),
              });
            }
          }
        } catch (_e) { /* hint is best-effort */ }
        console.log("hw:group:require-intent-uninitiated-ignored", JSON.stringify({ profile_id: profile.id, course_id: grp?.course_id, chatId, threadId, messageId }));
        return;
      }

      // PICKER MODE ("ask, then guess"): hold the post + ask in-thread with buttons.
      const pickerOn = cfg.mode === "picker" && !!grp?.course_id
        && (cfg.courseIds.length === 0 || cfg.courseIds.includes(grp.course_id));
      if (pickerOn) {
        // Is THIS thread a homework topic of the student's own group (shared or per-module)?
        let isHwTopic = grp.homework_topic_id != null && Number(grp.homework_topic_id) === Number(threadId);
        if (!isHwTopic) {
          const { data: gmt } = await admin.from("group_module_topics")
            .select("module_id").eq("group_id", grp.id).eq("telegram_topic_id", threadId).maybeSingle();
          isHwTopic = !!gmt?.module_id;
        }
        if (!isHwTopic) {
          // Wrong-group posts used to vanish silently (the Test-1 hole). If this chat belongs to a
          // DIFFERENT group's homework setup, point the student to their own topic — in-thread,
          // rate-limited, so it works even for the ~70% the bot cannot DM.
          try {
            const { groupId: chatGroupId } = await resolveGroupFromChatId(admin, chatId);
            if (chatGroupId && chatGroupId !== grp.id && grp.homework_topic_url) {
              const since = new Date(Date.now() - 15 * 60_000).toISOString();
              const { data: recentHint } = await admin.from("notifications_log")
                .select("id").eq("user_id", profile.id).eq("notification_type", "hw_wrong_topic_hint")
                .gte("sent_at", since).limit(1);
              if (!recentHint || !recentHint.length) {
                const loc0: Locale = normLocale(profile.preferred_locale);
                await tgApi("sendMessage", {
                  chat_id: chatId, message_thread_id: threadId, reply_to_message_id: messageId,
                  text: (T[loc0] as any).pkWrongTopic(grp.homework_topic_url),
                  disable_web_page_preview: true,
                });
                await admin.from("notifications_log").insert({
                  user_id: profile.id, notification_type: "hw_wrong_topic_hint", sent_at: new Date().toISOString(),
                });
              }
            }
          } catch (_e) { /* hint is best-effort */ }
          console.log("hw:group:picker-not-hw-topic-ignored", JSON.stringify({ profile_id: profile.id, group_id: grp.id, chatId, threadId, messageId }));
          return;
        }
        const messageUrl0 = buildMessageLink(chatId, threadId, messageId);
        const item0 = { kind, ...(linkUrl ? { url: linkUrl } : { file_id: fileId }), msg_url: messageUrl0, ...(msg.media_group_id ? { mgid: String(msg.media_group_id) } : {}) };
        await handlePickerPost(admin, profile, grp, chatId, threadId, messageId, item0, (msg.caption || msg.text || "").slice(0, 4000));
        return;
      }

      const resolved = grp ? await resolveAssignmentForTopic(admin, grp, threadId, profile.id) : null;
      if (!resolved) {
        console.log("hw:group:no-intent-unresolved-ignored", JSON.stringify({ profile_id: profile.id, groupId, chatId, threadId, messageId }));
        return;
      }
      // Create a real intent row so album/follow-up files append to one submission.
      const { data: synth } = await admin.from("bot_homework_intents").upsert({
        user_id: profile.id,
        assignment_id: resolved.assignment.id,
        module_id: resolved.moduleId,
        group_id: grp.id,
        telegram_chat_id: chatId,
        telegram_thread_id: threadId,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        created_at: new Date().toISOString(),
      }, { onConflict: "user_id,assignment_id" }).select("id, user_id, assignment_id, module_id, group_id, submission_id").maybeSingle();
      intent = synth || { id: null, user_id: profile.id, assignment_id: resolved.assignment.id, module_id: resolved.moduleId, group_id: grp.id, submission_id: null };
      console.log("hw:group:auto-synth", JSON.stringify({ profile_id: profile.id, assignment_id: resolved.assignment.id, via: resolved.resolvedVia }));
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
    const mediaItem = { kind, ...(linkUrl ? { url: linkUrl } : { file_id: fileId }), msg_url: messageUrl, ...(msg.media_group_id ? { mgid: String(msg.media_group_id) } : {}) };

    // APPEND MODE: the intent already produced a submission (album photos and
    // follow-up files arrive as separate messages). Attach to it — up to 10
    // items — without bumping attempt_number or re-notifying the teacher.
    if (intent.submission_id) {
      const { data: cur } = await admin.from("homework_submissions")
        .select("id, media, submitted_text, score, score_is_stale").eq("id", intent.submission_id).maybeSingle();
      // Defense-in-depth for HIGH-2: never append onto a STALE-SCORED row — that's a resubmission
      // awaiting regrade; it must fall through to the fresh upsert (attempt bump + teacher DM).
      if (cur && (cur as any).score != null && (cur as any).score_is_stale) {
        console.log("hw:group:append-diverted-stale", JSON.stringify({ submission_id: cur.id }));
      } else if (cur) {
        // U14: atomic SQL append (concurrent album siblings can't lose items anymore).
        const { data: nApp } = await admin.rpc("append_submission_media",
          { _id: cur.id, _item: mediaItem, _caption: submittedText || "" });
        if (typeof nApp === "number" && nApp >= 0) {
          // keep the window open a bit longer for slow uploads
          await admin.from("bot_homework_intents")
            .update({ expires_at: new Date(Date.now() + 5 * 60_000).toISOString() }).eq("id", intent.id);
          try { await tgApi("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: [{ type: "emoji", emoji: "👍" }] }); } catch (_e) { /* best-effort */ }
          console.log("hw:group:media-appended", JSON.stringify({ submission_id: cur.id, n: nApp, kind }));
          return;
        }
        if (nApp === -1) {
          console.log("hw:group:media-cap-reached", JSON.stringify({ submission_id: cur.id }));
          try { await tgApi("setMessageReaction", { chat_id: chatId, message_id: messageId, reaction: [{ type: "emoji", emoji: "🙈" }] }); } catch (_e) { /* best-effort */ }
          return;
        }
        // -2: row became graded/vanished between the read and the append — fall through to the
        // fresh path (attempt bump + teacher DM), which is the correct semantics for a new post.
      }
      // Submission vanished (deleted?) — fall through and recreate below.
    }

    // v3.14.39: bump attempt_number on every consumed-intent post so the
    // homework_submissions_guard trigger permits clearing a previously-set
    // score. Without this bump, a resubmission post is silently rolled back
    // to keep the old score, hiding the new attempt from the teacher's
    // pending list (both /galaba and the web dashboard filter by score IS NULL).
    const { data: existingSub } = await admin
      .from("homework_submissions")
      .select("attempt_number, score, previous_score")
      .eq("user_id", profile.id)
      .eq("assignment_id", intent.assignment_id)
      .maybeSingle();
    const nextAttempt = ((existingSub?.attempt_number as number | null) ?? 0) + 1;
    // Grade memory across resubmissions (mirrors the picker path).
    const prevScore0: number | null = existingSub && (existingSub as any).score != null
      ? (existingSub as any).score : ((existingSub as any)?.previous_score ?? null);

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
        score_feedback_voice_file_id: null,
        scored_by: null,
        scored_at: null,
        score_is_stale: false,
        is_late: false,
        previous_score: prevScore0,
        telegram_chat_id: chatId,
        telegram_thread_id: threadId,
        telegram_message_id: messageId,
        telegram_message_url: messageUrl,
        telegram_file_id: fileId,
        telegram_file_kind: kind,
        media: [mediaItem],
        source: "telegram_topic",
      }, { onConflict: "user_id,assignment_id" })
      .select("id")
      .maybeSingle();
    if (upErr) {
      console.error("hw upsert error", upErr);
      return;
    }

    // Keep the intent alive as an UPLOAD WINDOW (5 min, refreshed per file):
    // album photos / extra files / links from this student append to this
    // submission. Other students' posts never match (intent is per-user).
    if (intent.id && upserted?.id) {
      await admin.from("bot_homework_intents")
        .update({ submission_id: upserted.id, expires_at: new Date(Date.now() + 5 * 60_000).toISOString() })
        .eq("id", intent.id);
    } else if (intent.id) {
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
    // SAP sub-step → its sap_number ("Vazifa 1/2/3"); a normal task → task_number. Step rides on `tn`.
    const tn = a ? displayStepNumber(a) : 1;
    const aTitle = a?.title || "";
    const moduleId = a?.module_id || intent.module_id;

    // Private DM to student (confirmation). Log Telegram errors so failures are visible.
    if (profile.telegram_id) {
      try {
        // S1 receipt: echo what was submitted + honest expectation from the
        // platform's real median grading turnaround (last 100 graded).
        let expectStr: string | undefined;
        try {
          const { data: gr } = await admin.from("homework_submissions")
            .select("submitted_at, scored_at").not("scored_at", "is", null)
            .order("scored_at", { ascending: false }).limit(100);
          const ds = ((gr || []) as any[])
            .map((r) => (new Date(r.scored_at).getTime() - new Date(r.submitted_at).getTime()) / 86400_000)
            .filter((d) => d >= 0).sort((a, b) => a - b);
          if (ds.length >= 10) {
            const med = ds[Math.floor(ds.length / 2)];
            expectStr = med <= 1 ? { uz: "24 soat", ru: "24 часа", en: "24 hours" }[locale]
              : `${Math.ceil(med)} ${{ uz: "kun", ru: "дн.", en: "days" }[locale]}`;
          }
        } catch (_e) { /* fall back to default phrasing */ }
        const preview = submittedText
          ? escHtml(submittedText.length > 80 ? submittedText.slice(0, 80) + "…" : submittedText)
          : undefined;
        const moreHint = { uz: "📎 Yana rasm/video/PDF yoki havola yuborsangiz — shu topshiriqqa qo'shiladi (jami 10 tagacha, 5 daqiqa ichida).",
          ru: "📎 Ещё фото/видео/PDF или ссылка — добавятся к этой сдаче (до 10, в течение 5 минут).",
          en: "📎 More photos/videos/PDFs or links will be attached to this submission (up to 10, within 5 minutes)." }[locale];
        const resp = await sendMessage(profile.telegram_id, t.hwReceived(mn, tn, preview, expectStr) + "\n" + moreHint);
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

    // Name + @username: teachers recognize students by handle at least as often as by name.
    // Baked into student_name so BOTH delivery paths (immediate DM + quiet-hours queue cron)
    // show it without touching the queue schema or the cron renderer.
    const _uname = (studentProfile.telegram_username || "").toString().trim().replace(/^@/, "");
    const studentName = ([studentProfile.name, studentProfile.last_name].filter(Boolean).join(" ") || "—")
      + (_uname ? ` (@${_uname})` : "");

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
        // A3: the step is now shown here too (tn is sap-aware) so the teacher sees "Modul 3 · Vazifa 1".
        const moduleName = `Modul ${mn} · Vazifa ${tn}`;
        // A4: an auto-GUESSED attribution (student ignored the picker) carries the "(taxminiy)" marker
        // on aTitle. Make it loud + give the teacher a one-tap ✏️ retag right on the notification.
        const guessed = /\(taxminiy\)/.test(aTitle || "");
        const body = hwTeacherBody(studentName, grp?.name || "—", moduleName, aTitle || "")
          + (guessed ? "\n\n⚠️ <b>Avto-belgilangan</b> — vazifa taxminan tanlandi. Noto'g'ri bo'lsa ✏️ bilan to'g'rilang." : "");
        // grade:open:<submissionId> = 47 bytes; hwmv:<submissionId> = 41 bytes. Both under Telegram's
        // 64-byte callback_data cap (the previous grade_task:<assignmentId>:<studentId> was 84 → BUTTON_DATA_INVALID).
        const inlineKb = [
          [{ text: "🎯 Baholash", callback_data: `grade:open:${submissionId}` }],
          ...(guessed ? [[{ text: "✏️ Vazifani o'zgartirish", callback_data: `hwmv:${submissionId}` }]] : []),
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
  if (_isImp && (/^grade_task:|^grade:open:|^gs:open:|^settings:|^setlang:|^ops:|^ast:/.test(data) || /^hw:(start|resub_yes):/.test(data))) {
    await answerCallback(cq.id, "👁 Faqat o'qish — /admin");
    return;
  }

  // --- Admin statistics drill-down: ast:all | ast:g:<groupId> — ADMIN ONLY ---
  // Renders in place (editMessageText) so the admin flips between overall and
  // per-group views on one message. Group data comes from teacher_group_statistics
  // (the RPC admits admins), keeping admin and teacher numbers identical.
  if (data.startsWith("ast:") && chatId) {
    if (!_clicker) { await answerCallback(cq.id); return; }
    const astPersona = await getPersona(admin, _clicker.id);
    if (astPersona !== "admin") { await answerCallback(cq.id, "⛔"); return; }
    const astLocale: Locale = normLocale(_clicker?.preferred_locale);
    try {
      let view: { text: string; keyboard: any } | null = null;
      if (data === "ast:all") {
        view = await buildAdminOverallStats(admin, astLocale);
      } else {
        const gm = /^ast:g:([0-9a-f-]{36})$/.exec(data);
        if (gm) view = await buildAdminGroupStats(admin, astLocale, gm[1], _clicker.id);
      }
      if (!view) { await answerCallback(cq.id); return; }
      await answerCallback(cq.id);
      await tgApi("editMessageText", {
        chat_id: chatId, message_id: cq.message?.message_id,
        text: view.text, parse_mode: "HTML", disable_web_page_preview: true,
        reply_markup: view.keyboard,
      });
    } catch (e: any) {
      console.error("[bot:ast] failed", e?.message || e);
      await answerCallback(cq.id, "⚠️ Xato — qayta urinib ko'ring");
    }
    return;
  }

  // --- Autonomous-ops approve flow (Phase 2): ops:a|c|x|reject:<pr#> — ADMIN ONLY ---
  // Verification is layered: real-clicker admin persona → parseOpsCallback (strict format) →
  // verifyOpsPr (label/branch/fork/workflow rules) → checksAllGreen (the CI merge gate — no
  // server-side branch protection on the Free plan, so THIS is the gate) → two-tap confirm.
  if (data.startsWith("ops:") && chatId) {
    if (!_clicker) { await answerCallback(cq.id); return; }
    const opsPersona = await getPersona(admin, _clicker.id);
    if (opsPersona !== "admin") { await answerCallback(cq.id, "⛔"); return; }
    const cb = parseOpsCallback(data);
    if (!cb) { await answerCallback(cq.id); return; }
    const { data: pat } = await admin.rpc("ops_github_pat");
    if (!pat) { await answerCallback(cq.id, "OPS_GITHUB_PAT Vaultda yo'q — sozlang"); return; }
    const opsAudit = async (action: string, details: Record<string, unknown>) => {
      try {
        await admin.from("admin_actions").insert({
          actor_user_id: _clicker.id, action, target_resource_type: "github_pr",
          target_resource_id: String(cb.pr), details,
        });
      } catch (_e) { /* audit best-effort */ }
    };

    const pr = await ghFetchPr(fetch, String(pat), cb.pr);
    if (!pr) { await answerCallback(cq.id, "PR topilmadi"); return; }
    const v = verifyOpsPr(pr);

    if (cb.kind === "ask") {
      if (!v.ok) { await answerCallback(cq.id, `Rad: ${v.reason}`); return; }
      const checks = checksAllGreen(await ghFetchChecks(fetch, String(pat), pr.headSha));
      if (!checks.ok) { await answerCallback(cq.id, `CI yashil emas: ${checks.reason}`); return; }
      await answerCallback(cq.id);
      const migLine = pr.changedMigration ? "\n\n⚠️ <b>DIQQAT: MIGRATION BOR</b> — ma'lumotlar bazasi o'zgaradi!" : "";
      await tgApi("editMessageText", {
        chat_id: chatId, message_id: cq.message?.message_id,
        text: `Merge <b>PR #${pr.number}</b> — ${csvEscapeHtml(pr.title.slice(0, 120))}?${migLine}\n\nCI: ✅ yashil. Tasdiqlaysizmi?`,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[
          { text: "✅ Ha, merge", callback_data: `ops:c:${pr.number}` },
          { text: "⬅️ Bekor", callback_data: `ops:x:${pr.number}` },
        ]] },
      });
      await opsAudit("ops_pr_confirm_shown", { title: pr.title, migration: pr.changedMigration });
      return;
    }

    if (cb.kind === "confirm") {
      if (!v.ok) { await answerCallback(cq.id, `Rad: ${v.reason}`); return; }
      const checks = checksAllGreen(await ghFetchChecks(fetch, String(pat), pr.headSha));
      if (!checks.ok) { await answerCallback(cq.id, `CI yashil emas: ${checks.reason}`); return; }
      if (pr.changedMigration) {
        await ghAddLabel(fetch, String(pat), pr.number, "migration-approved"); // arms the deploy gate
      }
      const merged = await ghMergePr(fetch, String(pat), pr.number);
      if (!merged.ok) {
        await answerCallback(cq.id, `Merge xato: ${(merged.message || "?").slice(0, 60)}`);
        await opsAudit("ops_pr_merge_failed", { message: merged.message });
        return;
      }
      await answerCallback(cq.id, "✅ Merged");
      await tgApi("editMessageText", {
        chat_id: chatId, message_id: cq.message?.message_id,
        text: `✅ <b>PR #${pr.number}</b> merged — deploy pipeline ishga tushdi.\n${csvEscapeHtml(pr.title.slice(0, 120))}`,
        parse_mode: "HTML",
      });
      await opsAudit("ops_pr_merged", { title: pr.title, migration: pr.changedMigration });
      return;
    }

    if (cb.kind === "cancel") {
      await answerCallback(cq.id, "Bekor qilindi");
      await tgApi("editMessageText", {
        chat_id: chatId, message_id: cq.message?.message_id,
        text: `⏸ PR #${cb.pr} — qaror keyinga qoldirildi (PR ochiq qoladi).`,
      });
      await opsAudit("ops_pr_deferred", {});
      return;
    }

    // reject: close the PR + delete its ops/ branch
    const closed = await ghClosePr(fetch, String(pat), pr.number, pr.headRef);
    await answerCallback(cq.id, closed ? "❌ Yopildi" : "Yopishda xato");
    if (closed) {
      await tgApi("editMessageText", {
        chat_id: chatId, message_id: cq.message?.message_id,
        text: `❌ <b>PR #${pr.number}</b> rad etildi va yopildi.\n${csvEscapeHtml(pr.title.slice(0, 120))}`,
        parse_mode: "HTML",
      });
    }
    await opsAudit("ops_pr_rejected", { closed });
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

  // --- "Confirm your name" flow callbacks (also the profile card's ✏️ Edit name button) ---
  if (data.startsWith("name:") && chatId) {
    if (!_clicker) { await answerCallback(cq.id); return; }
    if (_isImp) { await answerCallback(cq.id, "👁 Faqat o'qish — /admin"); return; }
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
        const { error: upErr } = await admin.from("profiles").update({
          name: ctx.first,
          last_name: ctx.last || null,
          name_confirmed_at: new Date().toISOString(),
        }).eq("id", _clicker.id);
        if (upErr) {
          // Don't claim success on a failed write, and keep confirm_name so the student can
          // retry the same name with one more tap. Emit a DB-visible signal for the watchdog.
          console.error("name:yes update failed", { user_id: _clicker.id, err: upErr.message });
          try {
            await admin.from("admin_actions").insert({
              actor_user_id: _clicker.id, action: "name_update_failed",
              target_user_id: _clicker.id, details: { err: upErr.message },
            });
          } catch (_e) { /* audit best-effort */ }
          await answerCallback(cq.id, t.nameSaveError);
          return;
        }
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
    for (const a of leaves) {
      const tnLabel = `Vazifa ${displayStepNumber(a)}`;
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

  // Teacher re-tag at grading time: hwmv:<subId> -> module picker -> hwmv:<subId>:<mIdx> ->
  // task picker -> hwmv:<subId>:<mIdx>:<lIdx> -> atomic move via admin_retag_submission RPC.
  // Indices (not UUIDs) keep callback_data under Telegram's 64-byte cap; the server re-derives
  // the real assignment through the SAME deterministic ordering (modules.position, computeLeaves).
  if (data.startsWith("hwmv:") && chatId) {
    if (_isImp) { await answerCallback(cq.id, "👁 Faqat o'qish — /admin"); return; }
    if (!_clicker) { await answerCallback(cq.id); return; }
    const persona = await getPersona(admin, _clicker.id);
    if (persona !== "admin" && persona !== "teacher") { await answerCallback(cq.id); return; }
    const locale: Locale = normLocale(_clicker.preferred_locale);
    const t = T[locale] as any;
    const parts = data.split(":"); // hwmv, subId[, mIdx[, lIdx]]
    const subId = parts[1];
    const { data: sub } = await admin.from("homework_submissions")
      .select("id, user_id, assignment_id, score, score_is_stale").eq("id", subId).maybeSingle();
    if (!sub) { await answerCallback(cq.id, t.gradeNotFound); return; }
    // C2 scope: a teacher may only re-tag their own groups' students (admins pass).
    if (persona !== "admin") {
      const scope = await gradingScopeIds(admin, _clicker.id, false);
      if (!scope || !scope.includes(sub.user_id)) { await answerCallback(cq.id, "⛔"); return; }
    }
    // Movable while gradeable: ungraded OR reopened (stale). Firm grades stay immutable.
    if (sub.score != null && !(sub as any).score_is_stale) { await answerCallback(cq.id, t.retagGraded); return; }
    const { data: curA } = await admin.from("homework_assignments")
      .select("module_id, modules:module_id(course_id)").eq("id", sub.assignment_id).maybeSingle();
    const courseId = (curA as any)?.modules?.course_id;
    if (!courseId) { await answerCallback(cq.id, t.gradeNotFound); return; }
    const { data: mods } = await admin.from("modules")
      .select("id, position, title").eq("course_id", courseId).order("position");
    const ordered = (mods || []) as any[];
    if (!ordered.length) { await answerCallback(cq.id, t.retagNoTasks); return; }

    if (parts.length === 2) {
      await answerCallback(cq.id);
      const rows = ordered.map((m: any, i: number) =>
        [{ text: `M${(m.position ?? 0) + 1} · ${String(m.title || "").slice(0, 28)}`, callback_data: `hwmv:${subId}:${i}` }]);
      await sendMessage(chatId, t.retagPickModule, { inline_keyboard: rows });
      return;
    }

    const mIdx = Number(parts[2]);
    const mod = ordered[mIdx];
    if (!mod) { await answerCallback(cq.id); return; }
    const { data: asgs } = await admin.from("homework_assignments")
      .select("id, title, task_number, sap_number, parent_id, is_active, created_at, max_score, module_id")
      .eq("module_id", mod.id).eq("is_active", true);
    const allRows = (asgs || []) as any[];
    const leaves = computeLeaves(allRows as any) as any[];
    const leafLabel = (l: any) =>
      `V${displayStepNumber(l)} · ${String(l.title || "").slice(0, l.parent_id ? 20 : 24)}`;

    if (parts.length === 3) {
      await answerCallback(cq.id);
      if (!leaves.length) { await sendMessage(chatId, t.retagNoTasks); return; }
      const rows = leaves.map((l: any, i: number) =>
        [{ text: leafLabel(l), callback_data: `hwmv:${subId}:${mIdx}:${i}` }]);
      await sendMessage(chatId, t.retagPickTask(`M${(mod.position ?? 0) + 1}`), { inline_keyboard: rows });
      return;
    }

    const lIdx = Number(parts[3]);
    const leaf = leaves[lIdx];
    if (!leaf) { await answerCallback(cq.id); return; }
    const { data: res, error: rpcErr } = await admin.rpc("admin_retag_submission", {
      _submission: subId, _new_assignment: leaf.id,
    });
    if (rpcErr) {
      console.error("hwmv:rpc-err", JSON.stringify({ subId, leaf: leaf.id, err: rpcErr.message }));
      await answerCallback(cq.id, "⚠️");
      return;
    }
    const status = (res as any)?.status;
    const survivorId = (res as any)?.submission_id || subId;
    if (status === "same") { await answerCallback(cq.id, t.retagSame); return; }
    if (status === "already_graded") { await answerCallback(cq.id, t.retagGraded); return; }
    if (status === "target_graded") { await answerCallback(cq.id, t.retagTargetGraded); return; }
    if (status !== "moved" && status !== "merged") { await answerCallback(cq.id, t.gradeNotFound); return; }
    const lbl = `M${(mod.position ?? 0) + 1} · ${leafLabel(leaf)}`;
    await answerCallback(cq.id, "✅");
    // Refresh the grading session so the score prompt targets the surviving row + right max.
    await admin.from("bot_conversation_state").upsert({
      telegram_id: tgId,
      state: "grade_score",
      context: { submission_id: survivorId, max_score: leaf.max_score || 10, grader_id: _clicker.id, is_admin: persona === "admin" },
      updated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    await sendMessage(chatId, `${t.retagDone(lbl)}\n${t.gradeAskScore(leaf.max_score || 10)}`);
    // Tell the student (best-effort, their locale).
    try {
      const { data: stu } = await admin.from("profiles")
        .select("telegram_id, preferred_locale").eq("id", sub.user_id).maybeSingle();
      if (stu?.telegram_id) {
        const sLoc: Locale = normLocale(stu.preferred_locale);
        await sendMessage(Number(stu.telegram_id), (T[sLoc] as any).retagStudentNote(lbl));
      }
    } catch (_e) { /* best-effort */ }
    console.log("hwmv:done", JSON.stringify({ subId, survivorId, status, to: leaf.id, by: _clicker.id }));
    return;
  }

  // In-group homework picker taps: hwpk:<pendingId>:m:<mIdx> | :back | :t:<mIdx>:<lIdx>
  // Buttons are visible to the whole group — only the poster (or staff) may operate them.
  if (data.startsWith("hwpk:") && chatId) {
    const parts = data.split(":");
    const pid = parts[1];
    const { data: pending } = await admin.from("hw_pending_posts").select("*").eq("id", pid).maybeSingle();
    // Locale: prefer the pending owner's language (the picker is theirs).
    const { data: ownerProf } = pending
      ? await admin.from("profiles").select("id, preferred_locale").eq("id", pending.user_id).maybeSingle()
      : { data: null };
    const locale: Locale = normLocale(ownerProf?.preferred_locale || _clicker?.preferred_locale);
    const t = T[locale] as any;
    if (!pending || pending.state !== "pending") {
      await answerCallback(cq.id, t.pkExpired);
      try { await tgApi("deleteMessage", { chat_id: chatId, message_id: cq.message?.message_id }); } catch (_e) { /* ignore */ }
      return;
    }
    const isOwner = Number(pending.from_tg_id) === tgId;
    let allowed = isOwner;
    if (!allowed && _clicker) {
      const p2 = await getPersona(admin, _clicker.id);
      allowed = p2 === "admin" || p2 === "teacher";
    }
    if (!allowed) { await answerCallback(cq.id, t.pkNotYours); return; }
    // Keep an actively-used picker from being swept mid-tap.
    await admin.from("hw_pending_posts")
      .update({ expires_at: new Date(Date.now() + 5 * 60_000).toISOString() }).eq("id", pid);
    // Engaged → suppress the pending ~10s "choose your task" reminder (set-once; never overwrites a
    // reminder already sent). Only a student who taps nothing gets nudged.
    await admin.from("hw_pending_posts")
      .update({ reminder_at: new Date().toISOString() }).eq("id", pid).is("reminder_at", null);

    const { data: mods } = await admin.from("modules")
      .select("id, position").eq("course_id", pending.course_id).order("position");
    const ordered = (mods || []) as any[];
    const editPicker = async (text: string, kb: any[][]) => {
      try {
        await tgApi("editMessageText", {
          chat_id: chatId, message_id: cq.message?.message_id,
          text, parse_mode: "HTML", disable_web_page_preview: true,
          reply_markup: { inline_keyboard: kb },
        });
      } catch (_e) { /* e.g. unchanged content — ignore */ }
    };

    if (parts[2] === "back") {
      await answerCallback(cq.id);
      const btns = ordered.map((m: any, i: number) => ({ text: `M${(m.position ?? 0) + 1}`, callback_data: `hwpk:${pid}:m:${i}` }));
      const rows: any[][] = [];
      for (let i = 0; i < btns.length; i += 4) rows.push(btns.slice(i, i + 4));
      await editPicker(t.pkAsk, rows);
      return;
    }

    if (parts[2] === "m") {
      const mod = ordered[Number(parts[3])];
      if (!mod) { await answerCallback(cq.id); return; }
      const { data: asgs } = await admin.from("homework_assignments")
        .select("id, title, task_number, sap_number, parent_id, is_active, created_at")
        .eq("module_id", mod.id).eq("is_active", true);
      const allRows = (asgs || []) as any[];
      const leaves = computeLeaves(allRows as any) as any[];
      await answerCallback(cq.id);
      if (!leaves.length) { await editPicker(`${t.pkAsk}\n\n${t.retagNoTasks}`, [[{ text: t.pkBack, callback_data: `hwpk:${pid}:back` }]]); return; }
      const rows = leaves.map((l: any, i: number) => [{
        // Step number = sap_number for SAP sub-steps ("V1/V2/V3" within the module), task_number
        // otherwise. Module context is already in the header (pkAskTask), so "V1" is unambiguous.
        text: `V${displayStepNumber(l)} · ${String(l.title || "").slice(0, l.parent_id ? 20 : 24)}`,
        callback_data: `hwpk:${pid}:t:${parts[3]}:${i}`,
      }]);
      rows.push([{ text: t.pkBack, callback_data: `hwpk:${pid}:back` }]);
      await editPicker(t.pkAskTask(`M${(mod.position ?? 0) + 1}`), rows);
      return;
    }

    if (parts[2] === "t" || parts[2] === "r" || parts[2] === "a") {
      // "t" = first tap on a task; "a"/"r" only exist on the explicit choice buttons.
      const action: "fresh" | "append" | "replace" =
        parts[2] === "r" ? "replace" : (parts[2] === "a" ? "append" : "fresh");
      const mod = ordered[Number(parts[3])];
      if (!mod) { await answerCallback(cq.id); return; }
      const { data: asgs } = await admin.from("homework_assignments")
        .select("id, title, task_number, sap_number, parent_id, is_active, created_at, max_score")
        .eq("module_id", mod.id).eq("is_active", true);
      const leaves = computeLeaves(((asgs || []) as any)) as any[];
      const leaf = leaves[Number(parts[4])];
      if (!leaf) { await answerCallback(cq.id); return; }
      const lbl = `M${(mod.position ?? 0) + 1} · V${displayStepNumber(leaf)}`;
      // Refresh the pending row (media may have grown since the callback row was loaded).
      const { data: freshPending } = await admin.from("hw_pending_posts").select("*").eq("id", pid).maybeSingle();
      if (!freshPending || freshPending.state !== "pending") { await answerCallback(cq.id, t.pkExpired); return; }

      // First tap on a task that already has work → screen the choice BEFORE filing anything.
      if (parts[2] === "t") {
        const { data: prior } = await admin.from("homework_submissions")
          .select("id, score, score_is_stale, previous_score, media")
          .eq("user_id", freshPending.user_id).eq("assignment_id", leaf.id).maybeSingle();
        if (prior && prior.score != null && !prior.score_is_stale) {
          // Graded → resubmit-to-improve confirmation (shows the grade being improved).
          await answerCallback(cq.id);
          await editPicker(t.pkResubAsk(lbl, (prior.score ?? 0) as number, (leaf.max_score ?? 10) as number), [
            [{ text: t.pkResubYes, callback_data: `hwpk:${pid}:r:${parts[3]}:${parts[4]}` }],
            [{ text: t.pkBack, callback_data: `hwpk:${pid}:m:${parts[3]}` }],
          ]);
          return;
        }
        if (prior && prior.score == null) {
          // Ungraded prior work (e.g. forgot a file, or improving before grading) →
          // add files to it, or replace it entirely — the student decides.
          const n = Array.isArray((prior as any).media) ? (prior as any).media.length : 0;
          const gradeLine = (prior as any).previous_score != null
            ? `\n${t.pkPrevGrade((prior as any).previous_score, (leaf.max_score ?? 10) as number)}` : "";
          await answerCallback(cq.id);
          await editPicker(t.pkExistingAsk(lbl, n, gradeLine), [
            [{ text: t.pkAddFiles, callback_data: `hwpk:${pid}:a:${parts[3]}:${parts[4]}` }],
            [{ text: t.pkResubYes, callback_data: `hwpk:${pid}:r:${parts[3]}:${parts[4]}` }],
            [{ text: t.pkBack, callback_data: `hwpk:${pid}:m:${parts[3]}` }],
          ]);
          return;
        }
        // No prior work → file it fresh below.
      }

      const result = await finalizePendingPost(admin, freshPending, leaf.id, mod.id, false, action);
      if (result === "created" || result === "appended") {
        await answerCallback(cq.id, t.pkDone(lbl));
      } else if (result === "already_graded") {
        await answerCallback(cq.id, t.pkGradedAlready); // race: graded between screen and confirm
      } else if (result === "tier_locked") {
        await answerCallback(cq.id, t.pkTierLocked);
      } else {
        await answerCallback(cq.id, "⚠️");
      }
      return;
    }
    await answerCallback(cq.id);
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
    const modRef = rest.slice(sep + 1);
    // Validate teacher owns group (admins ok)
    if (_effPersona === "teacher") {
      const groups = await teacherGroups(admin, _effId);
      if (!groups.find((x) => x.id === groupId)) { await answerCallback(cq.id, "⛔"); return; }
    }
    await answerCallback(cq.id);
    // Payload carries the module POSITION (uuid pairs blow the 64-byte cap — audit BUG-3).
    // Resolve via the group's course; accept a 36-char uuid defensively.
    let moduleId = modRef.length === 36 ? modRef : "";
    if (!moduleId) {
      const { data: gRow } = await admin.from("groups").select("course_id").eq("id", groupId).maybeSingle();
      if (gRow?.course_id) {
        const { data: mRow } = await admin.from("modules").select("id")
          .eq("course_id", gRow.course_id).eq("position", parseInt(modRef, 10) || 0).maybeSingle();
        moduleId = mRow?.id ?? "";
      }
    }
    if (!moduleId) { return; }
    // Load group, module, students, submissions
    const [{ data: grp }, { data: mod }, { data: profs }, { data: asgs }] = await Promise.all([
      admin.from("groups").select("id,name").eq("id", groupId).maybeSingle(),
      admin.from("modules").select("id,position,title").eq("id", moduleId).maybeSingle(),
      admin.from("profiles").select("id,name,last_name,telegram_username,telegram_id").eq("group_id", groupId).is("archived_at", null),
      admin.from("homework_assignments").select("id,title,task_number,sap_number,parent_id").eq("module_id", moduleId).eq("is_active", true),
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
          const label = a ? `${tag}·V${displayStepNumber(a)}` : "vazifa";
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
  if ((data.startsWith("gs:list:") || data.startsWith("gs:pick:") || data.startsWith("gs:open:") || data.startsWith("gs:grp:") || data.startsWith("tr:") || data.startsWith("thm:")) && chatId) {
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
    if (data.startsWith("gs:grp:")) {
      // Group chooser tap: explicit scope ("all" or a group the teacher owns).
      const tok = data.slice("gs:grp:".length);
      let scope: string | null = null;
      if (tok !== "all") {
        if (!isAdmin) {
          const tg2 = await teacherGroups(admin, _effId);
          if (!tg2.find((x: any) => x.id === tok)) { return; }
        }
        scope = tok;
      }
      await renderStudentPicker(admin, chatId, _effId, locale, isAdmin, 0, scope);
    } else if (data.startsWith("gs:list:")) {
      // gs:list:<page>[:<groupId|all>] — the token pins pagination to the chosen scope.
      const parts0 = data.slice("gs:list:".length).split(":");
      const page = parseInt(parts0[0], 10) || 0;
      const tok = parts0[1];
      let scope: string | null = null;
      if (tok && tok !== "all") {
        if (!isAdmin) {
          const tg2 = await teacherGroups(admin, _effId);
          if (!tg2.find((x: any) => x.id === tok)) { return; }
        }
        scope = tok;
      } else if (!tok) {
        scope = groupIdScope; // legacy buttons (pre-scope-token) keep old behavior
      }
      await renderStudentPicker(admin, chatId, _effId, locale, isAdmin, page, scope);
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
      const [sid, midOrPos] = rest.split(":");
      if (sid && midOrPos) {
        // Payload carries the module POSITION (uuid pairs blow the 64-byte cap — audit BUG-2).
        // Resolve via the student's group course; accept a 36-char uuid defensively.
        let mid: string | null = midOrPos.length === 36 ? midOrPos : null;
        if (!mid) {
          const { data: sp } = await admin.from("profiles").select("group_id, groups:group_id(course_id)").eq("id", sid).maybeSingle();
          const courseId = (sp as any)?.groups?.course_id;
          if (courseId) {
            const { data: m } = await admin.from("modules").select("id")
              .eq("course_id", courseId).eq("position", parseInt(midOrPos, 10) || 0).maybeSingle();
            mid = m?.id ?? null;
          }
        }
        if (mid) await renderStudentModuleDetail(admin, chatId, _effId, sid, mid, locale, isAdmin);
      }
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
  if (internalSecret) {
    // Accept the env secret OR the DB-side internal_fn_secret() (callers like the minute
    // drainer only have the DB one).
    let okInternal = !!INTERNAL && internalSecret === INTERNAL;
    if (!okInternal) {
      try {
        const adminX = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        const { data: s } = await adminX.rpc("internal_fn_secret");
        okInternal = !!s && internalSecret === String(s);
      } catch (_e) { /* fall through to 403 */ }
    }
    if (!okInternal) return new Response("Forbidden", { status: 403, headers: corsHeaders });
    let body: any = {};
    try { body = await req.json(); } catch { /* ignore */ }
    if (body?.action === "migration_broadcast") {
      const adminC = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const report = await runMigrationBroadcast(adminC, body.mode === "all" ? "all" : "test");
      return new Response(JSON.stringify(report), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (body?.action === "sweep_pending") {
      // Cron tick from the minute drainer: guarantees picker auto-fallback even when the group
      // is silent (the sweep used to run only on organic group traffic — quiet nights starved it).
      const adminC = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      __pkLastSweep = 0; // bypass the per-instance throttle for explicit ticks
      await sweepExpiredPendingPosts(adminC);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
    // U7: a student EDITING their homework post (e.g. replacing the photo) used to be ignored —
    // the submission kept the original file. Update the stored file_id + matching media item.
    if (update.edited_message) {
      const em = update.edited_message;
      const emChatType = em.chat?.type;
      if ((emChatType === "supergroup" || emChatType === "group") && em.from?.id && !em.from.is_bot) {
        try {
          let newFileId: string | null = null; let newKind: string | null = null;
          if (Array.isArray(em.photo) && em.photo.length) { newFileId = em.photo[em.photo.length - 1].file_id; newKind = "photo"; }
          else if (em.video) { newFileId = em.video.file_id; newKind = "video"; }
          else if (em.document) { newFileId = em.document.file_id; newKind = "document"; }
          if (newFileId) {
            const emProfile = await findProfileByTelegramId(admin, em.from.id);
            if (emProfile) {
              // Update the submission that anchors on this exact message…
              const { data: hit } = await admin.from("homework_submissions")
                .select("id, media").eq("user_id", emProfile.id)
                .eq("telegram_chat_id", em.chat.id).eq("telegram_message_id", em.message_id).maybeSingle();
              if (hit) {
                const media2 = (Array.isArray(hit.media) ? hit.media : []).map((it: any) =>
                  (it?.msg_url && String(it.msg_url).endsWith(`/${em.message_id}`)) ? { ...it, file_id: newFileId, kind: newKind } : it);
                await admin.from("homework_submissions")
                  .update({ telegram_file_id: newFileId, telegram_file_kind: newKind, media: media2 }).eq("id", hit.id);
                console.log("hw:edit:updated-submission", JSON.stringify({ submission_id: hit.id, msg: em.message_id }));
              } else {
                // …or a media item appended under a different anchor (album member). Scan the
                // student's recent submissions in JS (jsonb text-matching isn't PostgREST-filterable).
                const { data: subs2 } = await admin.from("homework_submissions")
                  .select("id, media").eq("user_id", emProfile.id)
                  .order("submitted_at", { ascending: false }).limit(10);
                for (const s2 of (subs2 || []) as any[]) {
                  const arr = Array.isArray(s2.media) ? s2.media : [];
                  if (!arr.some((it: any) => it?.msg_url && String(it.msg_url).endsWith(`/${em.message_id}`))) continue;
                  const media3 = arr.map((it: any) =>
                    (it?.msg_url && String(it.msg_url).endsWith(`/${em.message_id}`)) ? { ...it, file_id: newFileId, kind: newKind } : it);
                  await admin.from("homework_submissions").update({ media: media3 }).eq("id", s2.id);
                  console.log("hw:edit:updated-media-item", JSON.stringify({ submission_id: s2.id, msg: em.message_id }));
                  break;
                }
              }
            }
          }
        } catch (e) { console.error("hw:edit:err", String(e)); }
      }
      return new Response("ok", { status: 200, headers: corsHeaders });
    }

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

      // U1: students WILL try DMing homework media to the bot. Point them to their group's
      // homework topic instead of ignoring them (rate-limited 15 min).
      if (isPrivateChat && persona === "student" && profileForLocale
          && (msg.photo || msg.video || msg.document)) {
        try {
          const since = new Date(Date.now() - 15 * 60_000).toISOString();
          const { data: rh } = await admin.from("notifications_log")
            .select("id").eq("user_id", profileForLocale.id)
            .eq("notification_type", "hw_dm_media_hint").gte("sent_at", since).limit(1);
          if (!rh || !rh.length) {
            let topicUrl: string | null = null;
            if (profileForLocale.group_id) {
              const { data: g0 } = await admin.from("groups")
                .select("homework_topic_url").eq("id", profileForLocale.group_id).maybeSingle();
              topicUrl = g0?.homework_topic_url ?? null;
            }
            const hint = {
              uz: "📌 Vazifalar botga emas, guruhingizdagi <b>UYGA VAZIFA</b> topigiga yuboriladi. O'sha yerga yuborsangiz, modul va vazifani tugmalar bilan tanlaysiz.",
              ru: "📌 Задания отправляются не боту, а в топик <b>UYGA VAZIFA</b> вашей группы. Там вы выберете модуль и задание кнопками.",
              en: "📌 Homework goes to your group's <b>UYGA VAZIFA</b> topic, not to the bot. Post it there and pick the module/task with the buttons.",
            }[locale];
            await sendMessage(msg.chat.id, hint,
              topicUrl ? { inline_keyboard: [[{ text: "📥 Vazifa topigiga o'tish", url: topicUrl }]] } : undefined);
            await admin.from("notifications_log").insert({
              user_id: profileForLocale.id, notification_type: "hw_dm_media_hint", sent_at: new Date().toISOString(),
            });
          }
        } catch (_e) { /* hint is best-effort */ }
        return new Response("ok", { status: 200, headers: corsHeaders });
      }

      if (text.startsWith("/start ")) {
        const arg = text.slice(7).trim();
        if (arg.startsWith("login_")) {
          const tok = arg.slice(6);
          await handleStartLogin(admin, msg, tok, locale);
        } else {
          await sendWithKeyboard(msg.chat.id, T[locale].helpReply, locale, adminFlag, persona);
        }
      } else if (text === "/start") {
        // Teacher greeting: name + live pending count + where things are.
        if (persona === "teacher" && profileForLocale) {
          let pend = 0;
          try {
            const { data: pg } = await admin.rpc("teacher_groups", { uid: profileForLocale.id });
            pend = ((pg || []) as any[]).reduce((s, g) => s + (g.pending_homework || 0), 0);
          } catch (_e) { /* best-effort */ }
          const nm = profileForLocale.name || "";
          const greet = {
            uz: `Salom, ${nm}! 🧑‍🏫\n${pend > 0 ? `📝 <b>${pend} ta vazifa</b> baholashni kutmoqda.` : "✅ Baholanmagan vazifalar yo'q."}\n\nTOP talabalar, faolsizlar, guruh almashtirish va sozlamalar — 👤 Profil ichida.`,
            ru: `Салом, ${nm}! 🧑‍🏫\n${pend > 0 ? `📝 <b>${pend} заданий</b> ждут проверки.` : "✅ Непроверенных заданий нет."}\n\nТОП, неактивные, смена группы и настройки — внутри 👤 Профиль.`,
            en: `Hi ${nm}! 🧑‍🏫\n${pend > 0 ? `📝 <b>${pend} submissions</b> are waiting.` : "✅ Nothing waiting to grade."}\n\nTOP students, inactive, group switching and settings live inside 👤 Profile.`,
          }[locale];
          await sendMessage(msg.chat.id, greet, getTeacherKeyboard(locale, pend));
        } else {
          await sendWithKeyboard(msg.chat.id, T[locale].helpReply, locale, adminFlag, persona);
        }
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
        // Group-button taps by unknown users: ephemeral toast to the tapper only — the bot
        // must never post enrollment/non-member text INTO a group chat (pre-existing leak,
        // fixed with the membership gate 2026-07-13).
        if (cq.message?.chat?.type !== "private") {
          const loc: Locale = normLocale(cq.from.language_code);
          try { await answerCallback(cq.id, (T[loc] as any).nmNotMember); } catch (_e) {}
          return new Response("ok", { status: 200, headers: corsHeaders });
        }
        try { await answerCallback(cq.id); } catch (_e) {}
        if (cq.message?.chat?.id) {
          await sendUnregisteredReply(admin, cq.message.chat.id, cq.from);
        }
        return new Response("ok", { status: 200, headers: corsHeaders });
      }
      await handleCallback(admin, cq);
    }
  } catch (e) {
    // A genuine, unhandled failure while processing a Telegram update — capture it DB-visibly so
    // the agent can classify it (real code bug vs transient) rather than it vanishing into logs.
    console.error("update handler error", e);
    try {
      const from = update?.message?.from || update?.callback_query?.from || update?.edited_message?.from;
      await logError(admin, "telegram-bot-webhook", e, {
        action: "update_handler",
        telegram_id: from?.id ?? null,
        context: { update_keys: Object.keys(update || {}).filter((k) => k !== "update_id") },
      });
    } catch (_e) { /* never let logging break the 200 */ }
  }

  // Always 200 OK so Telegram doesn't retry
  return new Response("ok", { status: 200, headers: corsHeaders });
});
