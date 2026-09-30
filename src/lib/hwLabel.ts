// hw-label — ONE label for a homework item, on every teacher- and student-facing surface:
//
//   "<course short> · <group> · M<n> V<step> — <title>"
//     "5.0 · 1-GURUH PRE · M2 V1 — 2-MODUL ERKAKLAR KO'Z OYNAGI"
//     "CH6 · 3-GURUH · M1 V1 — 1- MODUL: PROMPT ENGINEERING"
//
// WHY: the ten Challenge 6.0 tasks are copies of the 5.0 tasks (same titles, task and step numbers), and the
// same "Modul N" is a different task in each course (the Claude task is M6 in 5.0 and M4 in 6.0). A card, DM
// or grade card that says only "Modul 2 · Vazifa 1 «title»" cannot tell a teacher or a student which course
// and group it belongs to (teacher audit 2026-09-30: F3, BOT-3, BOT-6, BOT-8, TUI-1, FB-3).
//
// Pure: no imports, no Deno or DOM APIs. The SAME FILE, byte for byte, is
//   supabase/functions/_shared/hw-label.ts   (edge functions + the bot)
//   src/lib/hwLabel.ts                       (the web / Mini App bundle, which cannot import supabase/functions)
// src/test/hw-label-parity.test.ts fails if the two copies drift. Edit one, copy it over the other.
//
// The output is plain text. A caller that sends Telegram HTML escapes it.

/** Collapse whitespace; null/undefined → "". */
function clean(s: unknown): string {
  return s == null ? "" : String(s).replace(/\s+/g, " ").trim();
}

/** Cut by code point (never splits an emoji into a lone surrogate). */
function clip(s: string, n: number): string {
  const cps = Array.from(s);
  return cps.length > n ? cps.slice(0, n - 1).join("") + "…" : s;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CHALLENGE_RE = /\bchallenge\b/i;

/** Longest fallback short name for a course whose title carries no version number. */
export const COURSE_SHORT_FALLBACK_MAX = 14;

/** The version written in a course title ("AI CREATORS 5.0" → "5.0"); the LAST number wins; "" if none. */
export function courseVersion(courseTitle: string | null | undefined): string {
  const nums = clean(courseTitle).match(/\d+(?:[.,]\d+)?/g);
  return nums ? nums[nums.length - 1].replace(",", ".") : "";
}

/**
 * The course's short code, from courses.title:
 *   "AI CREATORS 5.0"            → "5.0"
 *   "AI CREATORS CHALLENGE 6.0"  → "CH6"   (a ".0" minor is dropped; a real one stays: "… CHALLENGE 6.5" → "CH6.5")
 *   "AI CREATORS 4.0"            → "4.0"
 *   a title with no number       → the title itself, clipped to COURSE_SHORT_FALLBACK_MAX
 *   null / ""                    → ""      (the label then simply has no course part)
 */
export function courseShort(courseTitle: string | null | undefined): string {
  const t = clean(courseTitle);
  if (!t) return "";
  const ver = courseVersion(t);
  if (CHALLENGE_RE.test(t)) return `CH${ver.replace(/\.0+$/, "")}`;
  return ver || clip(t, COURSE_SHORT_FALLBACK_MAX);
}

/**
 * The group name without the course markers that courseShort() already shows, so a label never names the
 * course twice:
 *   ("1-GURUH PRE 5.0",        "AI CREATORS 5.0")            → "1-GURUH PRE"
 *   ("AC CHALLENGE | 3-GURUH", "AI CREATORS CHALLENGE 6.0")  → "3-GURUH"
 * Only a marker that MATCHES the given course is removed. When the group belongs to a different course than
 * the task (a student moved between courses), the name stays whole and the mismatch is visible:
 *   ("AC CHALLENGE | 3-GURUH", "AI CREATORS 5.0")            → "AC CHALLENGE | 3-GURUH"
 * A version is removed only when it has a dot ("5.0"): a bare number could be the group's own number.
 * No course → the name unchanged. Never returns "" for a non-empty name.
 */
export function groupShort(groupName: string | null | undefined, courseTitle: string | null | undefined): string {
  const g = clean(groupName);
  if (!g) return "";
  const t = clean(courseTitle);
  if (!courseShort(t)) return g;
  let out = g;
  if (CHALLENGE_RE.test(t)) {
    const m = out.match(/^[^|]*\bchallenge\b[^|]*\|(.+)$/i);
    if (m) out = m[1];
  }
  const ver = courseVersion(t);
  if (ver.includes(".")) out = out.replace(new RegExp(`(^|\\s)${escapeRe(ver)}(?=\\s|$)`, "g"), " ");
  out = clean(out).replace(/^[|·\s]+|[|·\s]+$/g, "");
  return out || g;
}

/** Fields that decide the step number people see. */
export type StepFields = {
  parent_id?: string | null;
  task_number?: number | null;
  sap_number?: number | null;
};

/**
 * The step number shown to people. The same rule as telegram-bot-webhook/homework-routing.ts
 * displayStepNumber (pinned by a test): a SAP sub-step shows its sap_number, a normal task its task_number,
 * default 1. null when there is no task at all.
 */
export function stepOf(task: StepFields | null | undefined): number | null {
  if (!task) return null;
  if (task.parent_id != null) return task.sap_number ?? task.task_number ?? 1;
  return task.task_number ?? 1;
}

const wholeNumber = (n: unknown): number | null =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;

/** "M2 V1" (module number = modules.position + 1, step = stepOf). A missing part is left out. */
export function taskTag(moduleNumber: number | null | undefined, step: number | null | undefined): string {
  const m = wholeNumber(moduleNumber);
  const s = wholeNumber(step);
  return [m != null ? `M${m}` : "", s != null ? `V${s}` : ""].filter(Boolean).join(" ");
}

/** "5.0 · 1-GURUH PRE": course short + group, for a chip or a header. */
export function scopeTag(courseTitle: string | null | undefined, groupName: string | null | undefined): string {
  return [courseShort(courseTitle), groupShort(groupName, courseTitle)].filter(Boolean).join(" · ");
}

export type HwLabelParts = {
  /** courses.title of the TASK's course (assignment → module → course), not the student's current group's. */
  courseTitle?: string | null;
  groupName?: string | null;
  moduleNumber?: number | null;
  step?: number | null;
  title?: string | null;
};

/**
 * "<course short> · <group> · M<n> V<step> — <title>". Every missing part is left out cleanly:
 * no title → "5.0 · 1-GURUH PRE · M2 V1"; nothing but a title → the title; nothing → "".
 */
export function hwLabel(p: HwLabelParts): string {
  const head = [scopeTag(p.courseTitle, p.groupName), taskTag(p.moduleNumber, p.step)].filter(Boolean).join(" · ");
  const title = clean(p.title);
  return head && title ? `${head} — ${title}` : head || title;
}
