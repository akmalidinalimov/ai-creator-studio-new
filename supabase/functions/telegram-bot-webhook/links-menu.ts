// Two student reply-keyboard buttons that only hand out Telegram links (owner request 2026-11-27):
//
//   🎁 Bonus darslar     the bonus courses (video editing, SMM, YouTube, ...), each a URL button to its own channel.
//                        The list is platform_settings 'bonus_courses' = {"items":[{"title": "..." | {uz,ru,en},
//                        "url": "https://t.me/..."}]}, edited in Admin → Sozlamalar. PAID students only: a trial
//                        (profiles.account_type = 'provisional') account gets TRIAL_LOCKED instead.
//   📣 Kurs Telegrami    per course the student is in (main course first, then each secondary course from
//                        student_course_groups): the course's lessons/news channel (courses.telegram_channel_url) and
//                        the student's own group of that course (groups.telegram_group_url). Every registered
//                        student, trial included (they are group members).
//
// Everything here is pure (plain data in, rows out) so it is pinned by links-menu.test.ts; index.ts does the reads and
// the send. Only URL buttons, so no callback_data. A link is shown only when it is https://t.me/...: one bad URL in an
// inline keyboard makes Telegram reject the WHOLE message (BUTTON_URL_INVALID), so a bad link is dropped, never sent.
// A course's channel "holding group" (courses.channel_group_id, «... | KANAL») has no chat: never shown as a group.

import { clip } from "../_shared/text-safe.ts";

export type Locale = "uz" | "ru" | "en";
export type UrlButton = { text: string; url: string };

const TME_RE = /^https:\/\/t\.me\/[^\s<>"'`\\]+$/;
const URL_MAX = 512;
const TITLE_MAX = 48;
export const BONUS_MAX_ITEMS = 30;

/** A link we may put on a button: https://t.me/<something>, no whitespace / quotes, bounded length. */
export function isTmeUrl(u: unknown): u is string {
  return typeof u === "string" && u.length <= URL_MAX && TME_RE.test(u);
}

/** The trial lock for 🎁 Bonus darslar: only a provisional (trial) account is locked. */
export function bonusLocked(accountType: unknown): boolean {
  return accountType === "provisional";
}

// ── 🎁 Bonus darslar ──

export type BonusTitle = string | Partial<Record<Locale, string>>;
export type BonusItem = { title: BonusTitle; url: string };

function cleanTitle(t: unknown): BonusTitle | null {
  if (typeof t === "string") return t.trim() ? t.trim() : null;
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const out: Partial<Record<Locale, string>> = {};
  for (const loc of ["uz", "ru", "en"] as Locale[]) {
    const v = (t as Record<string, unknown>)[loc];
    if (typeof v === "string" && v.trim()) out[loc] = v.trim();
  }
  return Object.keys(out).length ? out : null;
}

/**
 * platform_settings 'bonus_courses'.value → the valid items, in order. Missing / malformed value = []. An item
 * without a title or with a URL that is not https://t.me/... is dropped (never sent). Capped at BONUS_MAX_ITEMS.
 */
export function parseBonusCourses(value: unknown): BonusItem[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const raw = (value as Record<string, unknown>).items;
  if (!Array.isArray(raw)) return [];
  const out: BonusItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const rec = r as Record<string, unknown>;
    const url = typeof rec.url === "string" ? rec.url.trim() : "";
    const title = cleanTitle(rec.title);
    if (!title || !isTmeUrl(url)) continue;
    out.push({ title, url });
    if (out.length >= BONUS_MAX_ITEMS) break;
  }
  return out;
}

/** The title in the student's locale, else Uzbek, else any locale given. */
export function bonusTitle(title: BonusTitle, locale: Locale): string {
  if (typeof title === "string") return title;
  return title[locale] || title.uz || title.ru || title.en || "";
}

/** One URL button per row, in the admin's order; the title clipped. */
export function bonusRows(items: readonly BonusItem[], locale: Locale): UrlButton[][] {
  const rows: UrlButton[][] = [];
  for (const it of items) {
    const text = clip(bonusTitle(it.title, locale), TITLE_MAX).trim();
    if (!text || !isTmeUrl(it.url)) continue;
    rows.push([{ text: `🎁 ${text}`, url: it.url }]);
  }
  return rows;
}

// ── 📣 Kurs Telegrami ──

export type KanalCourseRow = {
  id: string;
  title: string | null;
  telegram_channel_url: string | null;
  channel_group_id: string | null;
};
export type KanalGroupRow = { id: string; name: string | null; telegram_group_url: string | null };

export type KanalInput = {
  /** profiles.group_id and its course (course null for a course-less group); null = no main group. */
  main: { group_id: string; course_id: string | null } | null;
  /** student_course_groups (is_main = false), never the main course. */
  secondary: readonly { group_id: string; course_id: string }[];
  courses: readonly KanalCourseRow[];
  groups: readonly KanalGroupRow[];
};

export type KanalEntry = {
  course_id: string | null;
  group_id: string | null;
  course_title: string;
  group_name: string;
  /** a valid https://t.me/ link or null */
  channel_url: string | null;
  /** a valid https://t.me/ link or null; always null for the course's channel holding group */
  group_url: string | null;
  /** the student's group here is the course's channel holding group (no chat, nothing to link) */
  holding: boolean;
};

/** One entry per course the student is in: the main course first, then each secondary course (deduped). */
export function kanalEntries(input: KanalInput): KanalEntry[] {
  const courseById = new Map(input.courses.map((c) => [String(c.id), c]));
  const groupById = new Map(input.groups.map((g) => [String(g.id), g]));
  const pairs: { group_id: string; course_id: string | null }[] = [];
  if (input.main) pairs.push({ group_id: input.main.group_id, course_id: input.main.course_id });
  for (const s of input.secondary) {
    if (pairs.some((p) => p.course_id && p.course_id === s.course_id)) continue;
    pairs.push({ group_id: s.group_id, course_id: s.course_id });
  }
  const out: KanalEntry[] = [];
  for (const p of pairs) {
    const c = p.course_id ? courseById.get(String(p.course_id)) : undefined;
    const g = groupById.get(String(p.group_id));
    const holding = !!(c?.channel_group_id && String(c.channel_group_id) === String(p.group_id));
    const ch = typeof c?.telegram_channel_url === "string" ? c.telegram_channel_url.trim() : "";
    const gu = typeof g?.telegram_group_url === "string" ? g.telegram_group_url.trim() : "";
    out.push({
      course_id: p.course_id,
      group_id: p.group_id,
      course_title: String(c?.title ?? "").trim(),
      group_name: String(g?.name ?? "").trim(),
      channel_url: isTmeUrl(ch) ? ch : null,
      group_url: !holding && isTmeUrl(gu) ? gu : null,
      holding,
    });
  }
  return out;
}

/** Which links are missing per entry (for the health signal). The holding group never counts as a missing group. */
export function kanalMissing(entries: readonly KanalEntry[]): {
  course_id: string | null; group_id: string | null; channel_missing: boolean; group_missing: boolean;
}[] {
  return entries
    .map((e) => ({
      course_id: e.course_id,
      group_id: e.group_id,
      channel_missing: !!e.course_id && !e.channel_url,
      group_missing: !e.holding && !e.group_url,
    }))
    .filter((m) => m.channel_missing || m.group_missing);
}

const KANAL_LABEL: Record<Locale, { channel: string; group: string; course: string }> = {
  uz: { channel: "Kanal", group: "Guruh", course: "Kurs" },
  ru: { channel: "Канал", group: "Группа", course: "Курс" },
  en: { channel: "Channel", group: "Group", course: "Course" },
};

/** Per entry: the channel button, then the group button; a missing link is skipped. */
export function kanalRows(entries: readonly KanalEntry[], locale: Locale): UrlButton[][] {
  const L = KANAL_LABEL[locale] ?? KANAL_LABEL.uz;
  const rows: UrlButton[][] = [];
  for (const e of entries) {
    if (e.channel_url) {
      const name = clip(e.course_title || L.course, TITLE_MAX).trim();
      rows.push([{ text: `📣 ${name} · ${L.channel}`, url: e.channel_url }]);
    }
    if (e.group_url) {
      const name = clip(e.group_name || e.course_title || L.group, TITLE_MAX).trim();
      rows.push([{ text: `👥 ${name} · ${L.group}`, url: e.group_url }]);
    }
  }
  return rows;
}

// ── copy (Uzbek first; casual) ──

export const LINKS_COPY: Record<Locale, {
  bonusIntro: string; bonusEmpty: string; kanalIntro: string; kanalEmpty: string; sendFailed: string;
}> = {
  uz: {
    bonusIntro: "🎁 <b>Bonus darslar</b>\nHar bir bonus kursning o'z Telegram kanali bor. Kerakligini tanlang 👇",
    bonusEmpty: "🎁 Bonus darslar tez orada qo'shiladi. Kuzatib boring 🙂",
    kanalIntro: "📣 <b>Kurs Telegrami</b>\nKurs kanali (darslar va yangiliklar) va guruhingiz 👇",
    kanalEmpty: "📣 Kurs kanali va guruh havolasi hali qo'shilmagan. Ustozingizdan so'rang 🙂",
    sendFailed: "Havolalarni hozir ochib bo'lmadi. Birozdan keyin qayta urinib ko'ring 🙏",
  },
  ru: {
    bonusIntro: "🎁 <b>Бонусные уроки</b>\nУ каждого бонусного курса свой Telegram-канал. Выберите нужный 👇",
    bonusEmpty: "🎁 Бонусные уроки скоро появятся. Следите за новостями 🙂",
    kanalIntro: "📣 <b>Telegram курса</b>\nКанал курса (уроки и новости) и ваша группа 👇",
    kanalEmpty: "📣 Ссылки на канал и группу ещё не добавлены. Спросите у преподавателя 🙂",
    sendFailed: "Не удалось открыть ссылки. Попробуйте чуть позже 🙏",
  },
  en: {
    bonusIntro: "🎁 <b>Bonus lessons</b>\nEach bonus course has its own Telegram channel. Pick one 👇",
    bonusEmpty: "🎁 Bonus lessons are coming soon. Stay tuned 🙂",
    kanalIntro: "📣 <b>Course Telegram</b>\nThe course channel (lessons and news) and your group 👇",
    kanalEmpty: "📣 The channel and group links aren't added yet. Ask your teacher 🙂",
    sendFailed: "Couldn't open the links right now. Please try again a bit later 🙏",
  },
};
