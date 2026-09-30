// Pure routing + copy for the ungraded-homework reminder (tested in route.test.ts).
//
// Who hears about a submission that has waited 24h+ for a grade:
//   * every REACHABLE teacher of the student's group: the primary AND the co-teachers
//     (_shared/group-teachers.ts, the same set the teacher-DM enqueue paths fan out to);
//   * nobody reachable -> the admins, in ONE message per run that lists every such submission.
//     Before, admins got one DM per submission per run, up to 200 in an hour.
//
// Every submission is named by the shared label "<course> · <group> · M<n> V<step> — <title>"
// (_shared/hw-label.ts): the Challenge 6.0 tasks are copies of the 5.0 tasks, so "«module · task»" alone could
// not say which course a reminder was about (audit BOT-6).
import { isReachableTeacher, type TeacherContact } from "../_shared/group-teachers.ts";
import { hwLabel } from "../_shared/hw-label.ts";

export type Locale = "uz" | "ru" | "en";
export const normLocale = (c?: string | null): Locale => {
  const l = (c || "").toLowerCase().slice(0, 2);
  if (l === "ru") return "ru";
  if (l === "en") return "en";
  return "uz";
};

export type TeacherProfile = TeacherContact & { id: string; preferred_locale?: string | null };
export type Recipient = { userId: string; chatId: number; locale: Locale };
export type AdminReason = "no_group" | "no_teacher" | "unreachable_teacher";
export type Route =
  | { kind: "teacher"; recipients: Recipient[] }
  | { kind: "admin"; reason: AdminReason };

/**
 * Route one submission. `teachersOf` comes from loadGroupTeachers() (primary first). A chat id shared
 * by two profiles is messaged once.
 */
export function routeReminder(
  groupId: string | null | undefined,
  teachersOf: Map<string, string[]>,
  profiles: Map<string, TeacherProfile>,
): Route {
  if (!groupId) return { kind: "admin", reason: "no_group" };
  const teacherIds = teachersOf.get(groupId) ?? [];
  if (!teacherIds.length) return { kind: "admin", reason: "no_teacher" };
  const recipients: Recipient[] = [];
  const seen = new Set<number>();
  for (const id of teacherIds) {
    const p = profiles.get(id);
    if (!isReachableTeacher(p)) continue;
    const chatId = Number(p!.telegram_id);
    if (!Number.isFinite(chatId) || seen.has(chatId)) continue;
    seen.add(chatId);
    recipients.push({ userId: id, chatId, locale: normLocale(p!.preferred_locale) });
  }
  if (!recipients.length) return { kind: "admin", reason: "unreachable_teacher" };
  return { kind: "teacher", recipients };
}

export const escHtml = (s: string = "") =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Cut BEFORE escaping, so a cut can never split an HTML entity; cut by code point, so an emoji in a
// name is never split into a lone surrogate.
const clip = (s: string, n: number) => {
  const cps = Array.from(s);
  return cps.length > n ? cps.slice(0, n - 1).join("") + "…" : s;
};

export type AdminItem = {
  studentName: string; // raw (unescaped)
  taskTitle: string;   // raw (unescaped): the assignment title
  groupName: string | null; // raw; null when the student has no group
  courseTitle?: string | null; // courses.title of the TASK's course; null/absent when unknown
  moduleNumber?: number | null;
  step?: number | null;
  hours: number;
  n: number; // this reminder's number for the submission, 1..3
  reason: AdminReason;
};

// --- Teacher reminder (one DM per reachable teacher per submission) ---

const TEACHER_COPY: Record<Locale, (s: string, label: string, h: number, n: number) => string> = {
  uz: (s, t, h, n) => `⏳ <b>${s}</b>ning «${t}» topshirig'i ${h} soatdan beri baholanmagan. Iltimos, baholang. (eslatma ${n}/3)`,
  ru: (s, t, h, n) => `⏳ Работа «${t}» от <b>${s}</b> не оценена уже ${h} ч. Пожалуйста, оцените. (напоминание ${n}/3)`,
  en: (s, t, h, n) => `⏳ <b>${s}</b>'s «${t}» has been awaiting grading for ${h}h. Please grade it. (reminder ${n}/3)`,
};
const TEACHER_BTN: Record<Locale, string> = { uz: "🎯 Baholash", ru: "🎯 Оценить", en: "🎯 Grade" };
const TEACHER_SITE_BTN: Record<Locale, string> = { uz: "🌐 Saytda ochish", ru: "🌐 Открыть на сайте", en: "🌐 Open on the site" };
export const TEACHER_URL = "https://aicreator.academy/teacher/homework";

/** Raw inputs (unescaped); escaped here. `label` is the hw-label; "" falls back to "—". */
export function teacherReminderText(loc: Locale, studentName: string, label: string, hours: number, n: number): string {
  return TEACHER_COPY[loc](escHtml(studentName || "—"), escHtml(label || "—"), hours, n);
}

/**
 * 🎯 opens THIS submission in the bot's grading flow (gs:open:<id> = 44 bytes, under Telegram's 64-byte
 * callback_data cap; the handler re-checks the teacher's scope). Before, the only button was the generic web
 * /teacher/homework page, which never opened the submission itself. The web link stays as the second button.
 */
export function teacherReminderKeyboard(loc: Locale, submissionId: string) {
  return {
    inline_keyboard: [
      [{ text: TEACHER_BTN[loc], callback_data: `gs:open:${submissionId}` }],
      [{ text: TEACHER_SITE_BTN[loc], url: TEACHER_URL }],
    ],
  };
}

/** The label of one reminder item. */
export function itemLabel(it: Pick<AdminItem, "taskTitle" | "groupName" | "courseTitle" | "moduleNumber" | "step">): string {
  return hwLabel({
    courseTitle: it.courseTitle ?? null, groupName: it.groupName, moduleNumber: it.moduleNumber ?? null,
    step: it.step ?? null, title: it.taskTitle,
  });
}

const ADMIN_DIGEST: Record<Locale, {
  head: (n: number) => string;
  reason: Record<AdminReason, string>;
  h: string;
  more: (m: number) => string;
}> = {
  uz: {
    head: (n) => `⚠️ <b>${n} ta</b> vazifa 24 soatdan ortiq baholanmagan va xabar oladigan o'qituvchisi yo'q. Iltimos, ko'rib chiqing yoki guruhga o'qituvchi biriktiring.`,
    reason: { no_group: "guruhi yo'q", no_teacher: "o'qituvchi biriktirilmagan", unreachable_teacher: "o'qituvchiga Telegramda yetib bo'lmaydi" },
    h: "soat",
    more: (m) => `… yana ${m} ta`,
  },
  ru: {
    head: (n) => `⚠️ Не оценены больше 24 ч, и напомнить некому (нет доступного преподавателя): <b>${n}</b>. Пожалуйста, проверьте или назначьте группе преподавателя.`,
    reason: { no_group: "нет группы", no_teacher: "нет преподавателя", unreachable_teacher: "преподаватель недоступен в Telegram" },
    h: "ч",
    more: (m) => `… и ещё ${m}`,
  },
  en: {
    head: (n) => `⚠️ Ungraded for 24h+ with no teacher who can be notified: <b>${n}</b>. Please review, or assign the group a teacher.`,
    reason: { no_group: "no group", no_teacher: "no teacher", unreachable_teacher: "teacher unreachable on Telegram" },
    h: "h",
    more: (m) => `… and ${m} more`,
  },
};

export const ADMIN_DIGEST_MAX_LINES = 20;
// Telegram's sendMessage cap is 4096 characters; stay well under it.
export const ADMIN_DIGEST_MAX_CHARS = 3500;

/** One admin message covering every submission that had no reachable teacher in this run. */
export function adminDigestText(items: readonly AdminItem[], loc: Locale): string {
  const c = ADMIN_DIGEST[loc];
  const out: string[] = [c.head(items.length), ""];
  let len = out.join("\n").length;
  let shown = 0;
  for (const it of items) {
    if (shown >= ADMIN_DIGEST_MAX_LINES) break;
    // The label carries course · group · M V — title. No group: the reason already says so, and the label
    // simply has no group part.
    const line = `• <b>${escHtml(clip(it.studentName || "—", 40))}</b> — «${escHtml(clip(itemLabel(it) || "—", 100))}» · ` +
      `${c.reason[it.reason]} · ${it.hours} ${c.h} (${it.n}/3)`;
    // Reserve room for the "… and N more" line.
    if (len + line.length + 1 + 40 > ADMIN_DIGEST_MAX_CHARS) break;
    out.push(line);
    len += line.length + 1;
    shown++;
  }
  if (items.length > shown) out.push(c.more(items.length - shown));
  return out.join("\n");
}
