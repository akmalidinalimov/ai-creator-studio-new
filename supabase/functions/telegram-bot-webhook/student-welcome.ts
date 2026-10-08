// A real /start welcome for a student (UX review 2026-09-30, quick win #7).
//
// BEFORE: a bare /start (or /start with any argument other than login_) answered one line — "Savollaringiz
// bo'lsa, biz bilan bog'laning:" — with no greeting, no button and no contact: a dead end on first contact
// (14 current students and 20 unregistered users sent a bare /start in 30 days).
//
// NOW, for a registered student in a private chat who sends a bare /start or types "Start" (teachers keep their
// greeting; admins and non-members are unchanged — a non-member never reaches this, the membership gate answers
// first; a /start <argument> deep link — login_ and the daily-task links — is left to its own handler):
//   message 1  the welcome, carrying the CURRENT reply keyboard (so every /start also refreshes a keyboard a
//              phone has cached for months):
//                Salom, Aziza! 👋
//                Siz AI CREATORS 5.0 · 3-guruh talabasisiz.
//                📚 Davom etish — keyingi darsingiz
//                📝 Mening vazifalarim — nima topshirildi, nima qoldi
//                👤 Profil — ballaringiz va guruhdagi o'rningiz
//                🚀 Hammasi bitta ilovada — pastda chapdagi ☰ «Ilovani ochish» tugmasi.   (Mini App on only)
//                📥 Uy vazifasini guruhdagi «UYGA VAZIFA» topigiga yuborasiz.
//   message 2  "Davom etamizmi? 👇" with [▶️ Keyingi dars ↗] (the Mini App's /continue/<course>; today's magic
//              link when the student Mini App is off) and, when the group has one, [📥 UYGA VAZIFA topigi]
//              (a plain url to the group's homework topic). Telegram cannot put a reply keyboard and inline
//              buttons on one message, hence two. A trial (provisional) account gets no lesson button.
// The button labels quoted in message 1 are passed in from index.ts — they are the keyboard's own strings.
import { type BotWatch, sendStudentWatchMessage } from "./miniapp-buttons.ts";
import { continuePath, coursePath } from "../_shared/miniapp-links.ts";
import { type SendOutcome } from "../_shared/telegram-send.ts";

export type Locale = "uz" | "ru" | "en";
// deno-lint-ignore no-explicit-any
type Db = any;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const WELCOME_T: Record<Locale, {
  hi: (name: string) => string;
  member: (where: string) => string;
  davom: string;
  homework: string;
  profil: string;
  instagram: string;
  app: string;
  trial: string;
  topic: string;
  cta: string;
  ctaTopicOnly: string;
  nextLesson: string;
  coursePage: string;
  topicBtn: string;
}> = {
  uz: {
    hi: (n) => `Salom, <b>${n}</b>! 👋`,
    member: (w) => `Siz <b>${w}</b> talabasisiz.`,
    davom: "keyingi darsingiz",
    homework: "nima topshirildi, nima qoldi",
    profil: "ballaringiz va guruhdagi o'rningiz",
    instagram: "Instagram username’ingizni qo‘shish yoki o‘zgartirish (Instagram vazifalari uchun)",
    app: "🚀 Hammasi bitta ilovada — pastda chapdagi ☰ «Ilovani ochish» tugmasi.",
    trial: "🔒 Darsliklar sinov hisobida yopiq — vazifa va ballar ishlaydi.",
    topic: "📥 Uy vazifasini (video, rasm, fayl) guruhdagi «UYGA VAZIFA» topigiga yuborasiz.",
    cta: "Davom etamizmi? 👇",
    ctaTopicOnly: "Uy vazifasi shu yerga yuboriladi 👇",
    nextLesson: "▶️ Keyingi dars",
    coursePage: "📋 Kurs sahifasi",
    topicBtn: "📥 UYGA VAZIFA topigi",
  },
  ru: {
    hi: (n) => `Салом, <b>${n}</b>! 👋`,
    member: (w) => `Вы студент <b>${w}</b>.`,
    davom: "ваш следующий урок",
    homework: "что сдано и что осталось",
    profil: "ваши баллы и место в группе",
    instagram: "добавить или изменить Instagram username (для Instagram-заданий)",
    app: "🚀 Всё в одном приложении — кнопка ☰ «Открыть приложение» слева внизу.",
    trial: "🔒 На пробном аккаунте уроки закрыты — задания и баллы работают.",
    topic: "📥 Домашние задания (видео, фото, файлы) отправляйте в топик «UYGA VAZIFA» вашей группы.",
    cta: "Продолжим? 👇",
    ctaTopicOnly: "Домашние задания отправляются сюда 👇",
    nextLesson: "▶️ Следующий урок",
    coursePage: "📋 Страница курса",
    topicBtn: "📥 Топик UYGA VAZIFA",
  },
  en: {
    hi: (n) => `Hi, <b>${n}</b>! 👋`,
    member: (w) => `You are a student of <b>${w}</b>.`,
    davom: "your next lesson",
    homework: "what you've handed in and what's left",
    profil: "your points and your place in the group",
    instagram: "add or change your Instagram username (for Instagram tasks)",
    app: "🚀 Everything in one app — the ☰ «Open the app» button at the bottom left.",
    trial: "🔒 Lessons are locked on a trial account — homework and points work.",
    topic: "📥 Send homework (video, photo, file) to your group's «UYGA VAZIFA» topic.",
    cta: "Shall we continue? 👇",
    ctaTopicOnly: "Homework goes here 👇",
    nextLesson: "▶️ Next lesson",
    coursePage: "📋 Course page",
    topicBtn: "📥 UYGA VAZIFA topic",
  },
};

export type WelcomeFacts = {
  name: string | null | undefined;
  course: string | null | undefined;
  group: string | null | undefined;
  appOn: boolean;
  trial: boolean;
  /** The keyboard's own labels (T.kbDavom, T.kbHomework, PROF_T.kbProfil). */
  labels: { davom: string; homework: string; profil: string; instagram?: string };
};

/** Message 1. Pure — pinned by student-welcome.test.ts. */
export function welcomeText(locale: Locale, f: WelcomeFacts): string {
  const t = WELCOME_T[locale] ?? WELCOME_T.uz;
  const name = esc(String(f.name ?? "").trim()) || "👋";
  const where = [f.course, f.group].map((s) => esc(String(s ?? "").trim())).filter(Boolean).join(" · ");
  const lines = [t.hi(name)];
  if (where) lines.push(t.member(where));
  lines.push("");
  if (!f.trial) lines.push(`${f.labels.davom} — ${t.davom}`);
  lines.push(`${f.labels.homework} — ${t.homework}`);
  // The keyboard's third button: 👤 Profil again since 2026-10-08 (no Instagram tasks; index.ts passes no instagram
  // label). The instagram branch stays for the day the 📸 button comes back (2026-10-04..10-07 it replaced Profil).
  lines.push(f.labels.instagram ? `${f.labels.instagram} — ${t.instagram}` : `${f.labels.profil} — ${t.profil}`);
  if (f.appOn) lines.push(t.app);
  if (f.trial) lines.push(t.trial);
  lines.push("", t.topic);
  return lines.join("\n");
}

export type WelcomeDeps = {
  chatId: number;
  locale: Locale;
  profile: { id: string; name?: string | null; group_id?: string | null; account_type?: string | null };
  labels: WelcomeFacts["labels"];
  /** The student Mini App flag as the webhook sees it (☰ is an app door only when it is on). */
  appOn: boolean;
  /** Send message 1 with the persona's reply keyboard (index.ts sendWithKeyboard). */
  sendWithKeyboard: (text: string) => Promise<unknown>;
  primaryCourseId: () => Promise<string | null>;
  nextLessonId: (courseId: string) => Promise<string | null>;
  /** index.ts studentWatchButton bound to this chat, src "bot_start", the student's own magic links. */
  watch: (o: { text: string; miniPath: string; legacyPath: string }) => Promise<BotWatch>;
  /** Tests. */
  sendFn?: (admin: unknown, chatId: number, text: string, rows: (BotWatch | Record<string, unknown>)[][]) => Promise<SendOutcome>;
};

/** Send the welcome (both messages). Never throws past a failed read: the text degrades, the keyboard still goes. */
export async function sendStudentWelcome(admin: Db, d: WelcomeDeps): Promise<void> {
  const t = WELCOME_T[d.locale] ?? WELCOME_T.uz;
  let group: { name?: string | null; course_id?: string | null; homework_topic_url?: string | null } | null = null;
  let course: string | null = null;
  try {
    if (d.profile.group_id) {
      const { data: g } = await admin.from("groups").select("name, course_id, homework_topic_url").eq("id", d.profile.group_id).maybeSingle();
      group = g ?? null;
      if (g?.course_id) {
        const { data: c } = await admin.from("courses").select("title").eq("id", g.course_id).maybeSingle();
        course = c?.title ?? null;
      }
    }
  } catch (e) {
    console.error("student-welcome: group read failed", String((e as Error)?.message ?? e));
  }
  const trial = d.profile.account_type === "provisional";
  await d.sendWithKeyboard(welcomeText(d.locale, {
    name: d.profile.name, course, group: group?.name ?? null, appOn: d.appOn, trial, labels: d.labels,
  }));

  const rows: (BotWatch | Record<string, unknown>)[][] = [];
  let hasLesson = false;
  if (!trial) {
    try {
      // The same course 📚 Davom etish resolves (index.ts getPrimaryCourseIdForUser), so both agree.
      const courseId = await d.primaryCourseId();
      if (courseId) {
        const next = await d.nextLessonId(courseId);
        rows.push([await d.watch(next
          ? { text: t.nextLesson, miniPath: continuePath(courseId), legacyPath: `/lesson/${courseId}/${next}` }
          : { text: t.coursePage, miniPath: coursePath(courseId), legacyPath: `/course/${courseId}` })]);
        hasLesson = true;
      }
    } catch (e) {
      console.error("student-welcome: lesson button failed", String((e as Error)?.message ?? e));
    }
  }
  const topic = String(group?.homework_topic_url ?? "").trim();
  if (/^https:\/\/t\.me\//.test(topic)) rows.push([{ text: t.topicBtn, url: topic }]);
  if (!rows.length) return;
  const send = d.sendFn ?? sendStudentWatchMessage;
  await send(admin, d.chatId, hasLesson ? t.cta : t.ctaTopicOnly, rows);
}
