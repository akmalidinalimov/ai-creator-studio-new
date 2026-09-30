// The daily report's buttons (UX review 2026-09-30, quick win #10). Pure — tested in buttons.test.ts.
//
// The report already says how much homework is waiting ("📥 Baholanmagan vazifalar: 6 (eng eskisi 38 soat)") but
// its only button was a one-time Profil magic link that Telegram opens in its own browser, logged into the WEB
// profile. With the teacher Mini App on (platform_settings.teacher_miniapp) it now carries:
//   [📝 Baholash (N) ↗]   the grading queue (/tg/teacher/grade) — only when N > 0
//   [👤 Profil ↗]         the teacher Mini App home (/tg/teacher)
// both inline web_app buttons (_shared/teacher-miniapp.ts), no magic-link row written. Off, a malformed
// MINIAPP_BASE, or a web_app button Telegram rejects → today's single magic-link button, byte-identical.

// deno-lint-ignore no-explicit-any
export type Btn = Record<string, any>;
export type Loc = "uz" | "ru" | "en";

/** Today's button text (one label for every locale, unchanged). */
export const LEGACY_PROFILE_LABEL = "👤 Profil / Profile";

export const REPORT_GRADE_LABEL: Record<Loc, (n: number) => string> = {
  uz: (n) => `📝 Baholash (${n})`,
  ru: (n) => `📝 Оценить (${n})`,
  en: (n) => `📝 Grade (${n})`,
};

export const REPORT_HOME_LABEL: Record<Loc, string> = { uz: "👤 Profil", ru: "👤 Профиль", en: "👤 Profile" };

/** The ungraded count the 📝 button shows, or 0 (no button) for anything that is not a positive number. */
export function backlogCount(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Today's keyboard: the magic link to the web profile. */
export function legacyReportRows(profileUrl: string): Btn[][] {
  return [[{ text: LEGACY_PROFILE_LABEL, url: profileUrl }]];
}

/**
 * The app keyboard, or null when there is no app button (the caller then sends legacyReportRows). `grade` is
 * built only when the backlog is positive; a grade button without a home button cannot happen (both follow the
 * same flag, base and chat) and is treated as "no app".
 */
export function appReportRows(a: { grade: Btn | null; home: Btn | null }): Btn[][] | null {
  if (!a.home) return null;
  return a.grade ? [[a.grade], [a.home]] : [[a.home]];
}
