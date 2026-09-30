/**
 * Challenge 6.0 «Kunlik vazifalar» calendar (Daily Tasks PR-2, migration 20260930122010): the pure rules the
 * admin page and the plan importer share with SQL.
 *
 * The DATABASE is the authority. The SQL mirrors are:
 *   requiresValid          <-> public.challenge_task_requires_valid(jsonb)        (the table CHECK)
 *   requiresProblem        <-> public.challenge_task_requires_problem(text, jsonb, text[])  (the approve guard)
 *   parseMessageUrl        <-> public.challenge_task_parse_message_url(text)      (manual-post links)
 * The PGlite harness (supabase/functions/_challenge/testing/daily-tasks-calendar-check.ts) imports THIS file and
 * asserts each mirror agrees with SQL fixture-by-fixture, and that every task of the real 25-task plan imports
 * and passes the approve guard. Dependency-free on purpose (no "@/..." imports) so Deno can load it.
 *
 * ── FORMAT → requires / accepts (build spec v2 §5.4) ─────────────────────────────────────────────────────────
 * A plan task's `format` ("screenshot + text", "file (.xlsx/.csv) or screenshot", "Instagram Reel: screenshot +
 * link", ...) is turned into `requires`: an AND of kind groups, each {any: kinds[], min, label}.
 *   screenshot | image | photo | picture   -> {photo, image_doc}          label screenshot
 *   video | clip                           -> {video, video_doc}          label video
 *   file | document | doc                  -> {document, image_doc}       label file
 *   link | url                             -> {link}                      label link
 *                                             {ig_link} on an instagram task, label ig_link
 *   voice | audio | (round) video note     -> {voice, video_note, audio}  label voice, and min_duration_sec 20
 *   text | caption | prompt                -> {text}                      label text
 *   "A + B"            AND: two groups
 *   "A or B", "A, B"   one group holding both kinds (label = the first alternative's)
 *   "A (or B)"         the parenthesis adds an alternative to A's group
 *   "A (N)", "(N x)", "(up to N)"   NOT turned into a minimum (min stays 1): the day drawer flags it for the admin
 *   "A (.xlsx/.csv)"   an informational note, shown in the drawer
 *   "Instagram post|carousel|Reel: ..."   the prefix is dropped (the task's type decides)
 * accepts = every requires kind mapped to its capture kind (image_doc/video_doc -> document, ig_link -> link),
 * plus text. Every import is a DRAFT: a human reviews `requires` in the drawer before approving (G3).
 */

export type TaskType = "general" | "instagram";
export type TaskStatus = "draft" | "approved" | "cancelled";
export type TaskSource = "manual" | "import" | "ai_draft" | "retro";

/** challenge_tasks.accepts vocabulary: what the bot may capture as an item of a submission. */
export const ACCEPT_KINDS = ["text", "photo", "video", "document", "voice", "video_note", "audio", "link"] as const;
export type AcceptKind = (typeof ACCEPT_KINDS)[number];

/** challenge_tasks.requires kinds (PR-3 classify: image_doc / video_doc = a document whose mime is image/* or video/*). */
export const REQUIRE_KINDS = [
  "text", "photo", "image_doc", "video", "video_doc", "document", "voice", "video_note", "audio", "link", "ig_link",
] as const;
export type RequireKind = (typeof REQUIRE_KINDS)[number];

/** The copy key the engine puts in missing[] when a group is unmet. */
export const REQUIRE_LABELS = ["screenshot", "video", "file", "text", "link", "ig_link", "voice"] as const;
export type RequireLabel = (typeof REQUIRE_LABELS)[number];

export type RequiresGroup = { any: RequireKind[]; min: number; label: RequireLabel };

export const MAX_REQUIRE_GROUPS = 8;
export const MAX_GROUP_MIN = 20;
export const VOICE_MIN_DURATION_SEC = 20;
/** Telegram's hard limit is 4096; the approve guard keeps 96 characters of headroom (G29). */
export const POST_MAX_CHARS = 4000;

/** The table's length/number limits (CHECK constraints), mirrored for instant feedback. */
export const LIMITS = {
  title: [3, 120],
  body: [1, 3000],
  learn: 500,
  hint: 500,
  rubric: 2000,
  planRef: 120,
  planFormat: 200,
  minutes: [1, 600],
  points: [1, 50],
} as const;

export const KIND_TO_ACCEPT: Record<RequireKind, AcceptKind> = {
  text: "text", photo: "photo", image_doc: "document", video: "video", video_doc: "document", document: "document",
  voice: "voice", video_note: "video_note", audio: "audio", link: "link", ig_link: "link",
};

export const ACCEPT_LABEL_UZ: Record<AcceptKind, string> = {
  text: "Matn", photo: "Rasm (foto)", video: "Video", document: "Fayl", voice: "Ovozli xabar",
  video_note: "Dumaloq video", audio: "Audio", link: "Havola",
};
export const KIND_LABEL_UZ: Record<RequireKind, string> = {
  text: "Matn", photo: "Rasm (foto)", image_doc: "Rasm fayl", video: "Video", video_doc: "Video fayl", document: "Fayl",
  voice: "Ovozli xabar", video_note: "Dumaloq video", audio: "Audio", link: "Havola", ig_link: "Instagram havolasi",
};
export const LABEL_UZ: Record<RequireLabel, string> = {
  screenshot: "Skrinshot / rasm", video: "Video", file: "Fayl", text: "Matn", link: "Havola", ig_link: "Instagram havolasi",
  voice: "Ovozli xabar",
};

/** The approve guard's messages (public.challenge_task_requires_problem returns exactly these). */
export const REQUIRES_MSG = {
  invalid: "«Nima yuborilishi shart» (requires) formati noto‘g‘ri",
  igLinkOnGeneral: "Instagram havolasi (ig_link) faqat Instagram vazifasida talab qilinadi",
  igNeedsShotAndLink: "Instagram vazifasi skrinshot va Instagram havolasini talab qilishi kerak",
  notAccepted: (kind: string) => `«${kind}» talab qilingan, lekin qabul qilinadigan formatlarda yo‘q`,
} as const;

const includesStr = (list: readonly string[], v: unknown): boolean => typeof v === "string" && list.includes(v);

/** Mirror of public.challenge_task_requires_valid(jsonb) -- the table CHECK. */
export function requiresValid(r: unknown): r is RequiresGroup[] {
  if (!Array.isArray(r) || r.length > MAX_REQUIRE_GROUPS) return false;
  for (const g of r) {
    if (!g || typeof g !== "object" || Array.isArray(g)) return false;
    if (Object.keys(g).some((k) => k !== "any" && k !== "min" && k !== "label")) return false;
    const rec = g as Record<string, unknown>;
    const any = rec.any;
    if (!Array.isArray(any) || any.length === 0 || any.length > REQUIRE_KINDS.length) return false;
    const seen = new Set<string>();
    for (const k of any) {
      if (!includesStr(REQUIRE_KINDS, k) || seen.has(k as string)) return false;
      seen.add(k as string);
    }
    const min = rec.min;
    if (typeof min !== "number" || !Number.isInteger(min) || min < 1 || min > MAX_GROUP_MIN) return false;
    if (!includesStr(REQUIRE_LABELS, rec.label)) return false;
  }
  return true;
}

/**
 * Mirror of public.challenge_task_requires_problem(type, requires, accepts): null when `requires` is valid and
 * consistent with the type and with accepts, else the guard's message. Checked in the guard's order.
 */
export function requiresProblem(type: string, requires: unknown, accepts: readonly string[] | null | undefined): string | null {
  if (!requiresValid(requires)) return REQUIRES_MSG.invalid;
  if (type !== "instagram" && requires.some((g) => g.any.includes("ig_link"))) return REQUIRES_MSG.igLinkOnGeneral;
  if (type === "instagram") {
    const shot = requires.some((g) => g.any.every((k) => k === "photo" || k === "image_doc"));
    const ig = requires.some((g) => g.any.every((k) => k === "ig_link"));
    if (!(shot && ig)) return REQUIRES_MSG.igNeedsShotAndLink;
  }
  for (const g of requires) {
    for (const k of g.any) {
      if (!accepts || !accepts.includes(KIND_TO_ACCEPT[k])) return REQUIRES_MSG.notAccepted(k);
    }
  }
  return null;
}

/** Every capture kind `requires` needs, in ACCEPT_KINDS order (what the drawer offers to add to accepts). */
export function acceptsFor(requires: readonly RequiresGroup[], withText = true): AcceptKind[] {
  const need = new Set<AcceptKind>(withText ? ["text"] : []);
  for (const g of requires) for (const k of g.any) need.add(KIND_TO_ACCEPT[k]);
  return ACCEPT_KINDS.filter((k) => need.has(k));
}

/**
 * True when a submission could be COMPLETE with text and links only (every group offers text or a link). While
 * ai=false such general work is held in 'checking' (spec C16), so the importer warns about these in week 1.
 */
export function textOnlySatisfiable(requires: readonly RequiresGroup[]): boolean {
  if (requires.length === 0) return true; // 'any one accepted item' -- and text is always accepted
  return requires.every((g) => g.any.some((k) => k === "text" || k === "link"));
}

// ───────────────────────────── format derivation ─────────────────────────────

type Term = "screenshot" | "video" | "file" | "link" | "voice" | "text";

const TERM_PATTERNS: [RegExp, Term][] = [
  // longest phrases first: "round video note" must never read as "video"
  [/^(round video notes?|round videos?|video notes?|video messages?|dumaloq video( xabar)?)$/, "voice"],
  [/^(voice( messages?| notes?)?|audio( messages?)?|ovozli xabar)$/, "voice"],
  [/^(screenshots?|images?|photos?|pictures?|skrinshot|rasm)$/, "screenshot"],
  [/^(videos?|clips?)$/, "video"],
  [/^(files?|documents?|docs?|fayl)$/, "file"],
  [/^(links?|urls?|havola)$/, "link"],
  [/^(texts?|captions?|prompts?|matn)$/, "text"],
];

function termGroup(term: Term, type: TaskType): { any: RequireKind[]; label: RequireLabel } {
  switch (term) {
    case "screenshot": return { any: ["photo", "image_doc"], label: "screenshot" };
    case "video": return { any: ["video", "video_doc"], label: "video" };
    case "file": return { any: ["document", "image_doc"], label: "file" };
    case "link": return type === "instagram" ? { any: ["ig_link"], label: "ig_link" } : { any: ["link"], label: "link" };
    case "voice": return { any: ["voice", "video_note", "audio"], label: "voice" };
    case "text": return { any: ["text"], label: "text" };
  }
}

export type FormatFlag = {
  /** 'count': a "(N)" the importer deliberately did NOT turn into a minimum; 'note': other parenthetical info. */
  kind: "count" | "note" | "type";
  /** The format fragment it came from, e.g. "screenshot (2)". */
  term: string;
  text: string;
  /** A plain "(N)" / "(N things)" suggests min = N; "(up to N)" is a maximum and suggests nothing. */
  suggestedMin: number | null;
  /** Index of the requires group the flag belongs to (null for a whole-format note). */
  group: number | null;
};

export type Derived = {
  requires: RequiresGroup[];
  accepts: AcceptKind[];
  minDurationSec: number | null;
  flags: FormatFlag[];
  /** Set when a fragment is not understood: the import is refused until the plan is fixed. */
  error: string | null;
};

/** Splits at depth 0 (outside parentheses). `sep` returns the separator length at i, or 0. */
function splitTop(s: string, sep: (s: string, i: number) => number): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      const n = sep(s, i);
      if (n > 0) {
        out.push(s.slice(start, i));
        start = i + n;
        i += n - 1;
      }
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter((x) => x.length > 0);
}
const plusSep = (s: string, i: number) => (s[i] === "+" ? 1 : 0);
const altSep = (s: string, i: number) => {
  if (s[i] === ",") return 1;
  const m = /^\s+(or|yoki)\s+/i.exec(s.slice(i));
  return m && i > 0 ? m[0].length : 0;
};

const normTerm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function matchTerm(base: string): Term | null {
  const b = normTerm(base);
  for (const [re, t] of TERM_PATTERNS) if (re.test(b)) return t;
  return null;
}

/** "(2)" -> 2, "(3 prompts)" -> 3, "(up to 3)" -> null. */
function countSuggestion(paren: string): number | null {
  const p = paren.trim().toLowerCase();
  if (/\b(up to|max(imum)?|gacha|ko'pi bilan|ko‘pi bilan)\b/.test(p)) return null;
  const m = /^(\d{1,2})\b/.exec(p);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= MAX_GROUP_MIN ? n : null;
}

/** Turns a plan `format` into requires / accepts / flags (see the header for the mapping). */
export function deriveFromFormat(format: string | null | undefined, type: TaskType): Derived {
  const flags: FormatFlag[] = [];
  let f = (format ?? "").trim();
  const empty: Derived = { requires: [], accepts: ["text"], minDurationSec: null, flags, error: null };
  if (!f) return { ...empty, error: "Format bo‘sh" };

  const ig = /^instagram\b[^:+(]*:\s*/i.exec(f);
  if (ig) {
    f = f.slice(ig[0].length);
    if (type !== "instagram") {
      flags.push({ kind: "type", term: ig[0].trim(), text: "Format Instagram uchun, lekin vazifa turi «general»", suggestedMin: null, group: null });
    }
  }

  const requires: RequiresGroup[] = [];
  let voice = false;
  for (const andTerm of splitTop(f, plusSep)) {
    const kinds = new Set<RequireKind>();
    let label: RequireLabel | null = null;
    const groupIdx = requires.length;
    const queue = splitTop(andTerm, altSep);
    while (queue.length > 0) {
      const alt = queue.shift() as string;
      const m = /^([^()]*?)\s*(?:\(([^()]*)\))?\s*$/.exec(alt);
      if (!m) return { ...empty, flags, error: `Format tushunilmadi: «${alt}»` };
      const base = m[1];
      const paren = m[2];
      const term = matchTerm(base);
      if (!term) return { ...empty, flags, error: `Format tushunilmadi: «${base.trim() || alt}»` };
      const g = termGroup(term, type);
      if (term === "voice") voice = true;
      for (const k of g.any) kinds.add(k);
      if (!label) label = g.label;
      if (paren !== undefined && paren.trim() !== "") {
        const orM = /^\s*(or|yoki)\s+(.*)$/i.exec(paren);
        if (orM) {
          queue.push(...splitTop(orM[2], altSep));
        } else if (/\d/.test(paren)) {
          flags.push({ kind: "count", term: alt.trim(), text: paren.trim(), suggestedMin: countSuggestion(paren), group: groupIdx });
        } else {
          flags.push({ kind: "note", term: alt.trim(), text: paren.trim(), suggestedMin: null, group: groupIdx });
        }
      }
    }
    if (kinds.size === 0 || !label) return { ...empty, flags, error: `Format tushunilmadi: «${andTerm}»` };
    requires.push({ any: REQUIRE_KINDS.filter((k) => kinds.has(k)), min: 1, label });
  }
  if (requires.length === 0) return { ...empty, flags, error: `Format tushunilmadi: «${format}»` };
  if (requires.length > MAX_REQUIRE_GROUPS) return { ...empty, flags, error: `Formatda ${MAX_REQUIRE_GROUPS} tadan ko‘p qism bor` };
  return { requires, accepts: acceptsFor(requires), minDurationSec: voice ? VOICE_MIN_DURATION_SEC : null, flags, error: null };
}

// ───────────────────────────── the plan file ─────────────────────────────

export type PlanTask = {
  week: number;
  day: number;
  title_uz: string;
  task_uz: string;
  learn_uz: string | null;
  submit_uz: string | null;
  type: TaskType;
  points: number | null;
  format: string;
  auto_check: string | null;
  minutes: number | null;
};

const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/** Reads the plan JSON: {weeks: [{week, tasks: [...]}]}, {tasks: [...]} or a bare array of tasks. */
export function parsePlan(input: unknown): { tasks: PlanTask[]; errors: string[] } {
  const errors: string[] = [];
  let data: unknown = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input);
    } catch (e) {
      return { tasks: [], errors: [`JSON o‘qilmadi: ${(e as Error).message}`] };
    }
  }
  type Raw = { raw: Record<string, unknown>; week: number | null; day: number | null };
  const raws: Raw[] = [];
  const pushTasks = (list: unknown, week: number | null) => {
    if (!Array.isArray(list)) return;
    list.forEach((t, i) => {
      if (t && typeof t === "object" && !Array.isArray(t)) {
        const r = t as Record<string, unknown>;
        raws.push({ raw: r, week: intOrNull(r.week) ?? week, day: intOrNull(r.day) ?? i + 1 });
      } else errors.push(`Vazifa #${raws.length + 1}: obyekt emas`);
    });
  };
  if (Array.isArray(data)) pushTasks(data, null);
  else if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.weeks)) {
      d.weeks.forEach((w, wi) => {
        const wr = (w && typeof w === "object" ? w : {}) as Record<string, unknown>;
        pushTasks(wr.tasks, intOrNull(wr.week) ?? wi + 1);
      });
    } else pushTasks(d.tasks, null);
  }
  if (raws.length === 0 && errors.length === 0) errors.push("Rejada vazifa topilmadi (weeks[].tasks[] kutilgan)");

  const tasks: PlanTask[] = [];
  const seen = new Set<string>();
  for (const { raw, week, day } of raws) {
    const where = `${week ?? "?"}-hafta ${day ?? "?"}-kun`;
    const title = strOrNull(raw.title_uz) ?? strOrNull(raw.title);
    const body = strOrNull(raw.task_uz) ?? strOrNull(raw.body);
    const type = raw.type === "instagram" ? "instagram" : raw.type === "general" ? "general" : null;
    const format = strOrNull(raw.format);
    const problems: string[] = [];
    if (week == null || week < 1) problems.push("hafta raqami yo‘q");
    if (!title) problems.push("title_uz yo‘q");
    if (!body) problems.push("task_uz yo‘q");
    if (!type) problems.push("type general yoki instagram bo‘lishi kerak");
    if (!format) problems.push("format yo‘q");
    if (problems.length) { errors.push(`${where}: ${problems.join(", ")}`); continue; }
    const key = `${week}:${day}`;
    if (seen.has(key)) { errors.push(`${where}: takrorlangan`); continue; }
    seen.add(key);
    tasks.push({
      week: week as number, day: day as number, title_uz: title as string, task_uz: body as string,
      learn_uz: strOrNull(raw.learn_uz), submit_uz: strOrNull(raw.submit_uz), type: type as TaskType,
      points: intOrNull(raw.points), format: format as string, auto_check: strOrNull(raw.auto_check), minutes: intOrNull(raw.minutes),
    });
  }
  tasks.sort((a, b) => a.week - b.week || a.day - b.day);
  return { tasks, errors };
}

export const planRef = (t: Pick<PlanTask, "week" | "day">) => `W${t.week}D${t.day}`;

// ───────────────────────────── Tashkent dates ─────────────────────────────

/** Asia/Tashkent is UTC+5 with no DST (since 1992), so a fixed offset is exact. */
export function tashkentToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 5 * 3600_000).toISOString().slice(0, 10);
}
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** ISO weekday: Monday 1 .. Sunday 7 (the numbering of challenge_tasks.task_weekdays). */
export function isoWeekday(iso: string): number {
  const w = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
}
export const isIsoDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime()) &&
  new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export const WEEKDAY_SHORT_UZ = ["Du", "Se", "Ch", "Pa", "Ju", "Sh", "Ya"] as const; // index = isoWeekday - 1
export const MONTH_UZ = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"] as const;

/** The next `count` task days from `start` (inclusive) on `weekdays`, skipping dates already taken. */
export function scheduleDates(start: string, weekdays: readonly number[], count: number, occupied: ReadonlySet<string>): string[] {
  const days = new Set(weekdays.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7));
  if (!isIsoDate(start) || days.size === 0 || count <= 0) return [];
  const out: string[] = [];
  let d = start;
  for (let guard = 0; out.length < count && guard < 3660; guard++, d = addDays(d, 1)) {
    if (days.has(isoWeekday(d)) && !occupied.has(d)) out.push(d);
  }
  return out;
}

/** config.task_weekdays as the engine reads it: ISO 1..7, default Mon-Fri. */
export function configWeekdays(v: unknown): number[] {
  const list = Array.isArray(v) ? v.filter((d): d is number => Number.isInteger(d) && d >= 1 && d <= 7) : [];
  return list.length > 0 ? [...new Set(list)].sort((a, b) => a - b) : [1, 2, 3, 4, 5];
}

// ───────────────────────────── the importer ─────────────────────────────

/** One element of admin_challenge_tasks_import(_course_id, _items). */
export type ImportItem = {
  task_date: string;
  type: TaskType;
  title: string;
  body: string;
  learn_line: string | null;
  submit_hint: string | null;
  accepts: AcceptKind[];
  requires: RequiresGroup[];
  min_duration_sec: number | null;
  minutes: number | null;
  points: number | null;
  check_rubric: string | null;
  requires_tag: boolean | null;
  plan_ref: string;
  plan_format: string;
};

export type ImportRow = {
  ref: string;
  task: PlanTask;
  date: string | null;
  derived: Derived;
  status: "new" | "exists" | "error";
  problems: string[];
  item: ImportItem | null;
};

const tooLong = (s: string | null, max: number) => s !== null && s.length > max;

/**
 * Plans the import: dates for the tasks that are not in the calendar yet (by plan_ref), requires/accepts from the
 * format, and every table limit checked up front. `points` is stored only when it differs from the type's
 * configured default, so a later config change still applies to imported tasks.
 */
export function buildImportRows(
  tasks: readonly PlanTask[],
  opts: {
    startDate: string;
    weekdays: readonly number[];
    occupiedDates: ReadonlySet<string>;
    existingRefs: ReadonlySet<string>;
    defaultPoints: { general: number; instagram: number };
  },
): ImportRow[] {
  const pending = tasks.filter((t) => !opts.existingRefs.has(planRef(t)));
  const dates = scheduleDates(opts.startDate, opts.weekdays, pending.length, opts.occupiedDates);
  let di = 0;
  return tasks.map((t) => {
    const ref = planRef(t);
    const derived = deriveFromFormat(t.format, t.type);
    if (opts.existingRefs.has(ref)) return { ref, task: t, date: null, derived, status: "exists", problems: [], item: null };
    const date = dates[di++] ?? null;
    const problems: string[] = [];
    if (derived.error) problems.push(derived.error);
    if (!date) problems.push("Sana topilmadi (kunlar tanlanmagan yoki boshlanish sanasi noto‘g‘ri)");
    const title = t.title_uz.trim();
    if (title.length < LIMITS.title[0] || title.length > LIMITS.title[1]) problems.push(`Sarlavha ${LIMITS.title[0]}–${LIMITS.title[1]} belgi bo‘lishi kerak`);
    if (t.task_uz.length > LIMITS.body[1]) problems.push(`Vazifa matni ${LIMITS.body[1]} belgidan uzun`);
    if (tooLong(t.learn_uz, LIMITS.learn)) problems.push(`«Nimani o‘rganasiz» ${LIMITS.learn} belgidan uzun`);
    if (tooLong(t.submit_uz, LIMITS.hint)) problems.push(`«Topshirish» ${LIMITS.hint} belgidan uzun`);
    if (tooLong(t.auto_check, LIMITS.rubric)) problems.push(`AI mezoni ${LIMITS.rubric} belgidan uzun`);
    if (t.minutes !== null && (t.minutes < LIMITS.minutes[0] || t.minutes > LIMITS.minutes[1])) problems.push("Daqiqa 1–600 oralig‘ida bo‘lishi kerak");
    if (t.points !== null && (t.points < LIMITS.points[0] || t.points > LIMITS.points[1])) problems.push("Ball 1–50 oralig‘ida bo‘lishi kerak");
    if (tooLong(t.format, LIMITS.planFormat)) problems.push(`Format ${LIMITS.planFormat} belgidan uzun`);
    if (!derived.error) {
      const p = requiresProblem(t.type, derived.requires, derived.accepts);
      if (p) problems.push(p);
    }
    const item: ImportItem | null = problems.length > 0 || !date ? null : {
      task_date: date,
      type: t.type,
      title,
      body: t.task_uz,
      learn_line: t.learn_uz,
      submit_hint: t.submit_uz,
      accepts: derived.accepts,
      requires: derived.requires,
      min_duration_sec: derived.minDurationSec,
      minutes: t.minutes,
      points: t.points !== null && t.points !== opts.defaultPoints[t.type] ? t.points : null,
      check_rubric: t.auto_check,
      requires_tag: t.type === "instagram" ? true : null,
      plan_ref: ref,
      plan_format: t.format,
    };
    return { ref, task: t, date, derived, status: problems.length > 0 ? "error" : "new", problems, item };
  });
}

// ───────────────────────────── manual-post links ─────────────────────────────

export type MessageRef = { chat: string; chatId: number; topic: number; msg: number };

// The same pattern and bounds as challenge_task_parse_topic_url (PR-1) / parseTopicUrl in dailyTaskTopic.ts.
const TME_C_RE = /^https?:\/\/t\.me\/c\/([1-9][0-9]{0,14})\/([0-9]{1,12})(?:\/([0-9]{1,12}))?\/?(?:\?([^#]*))?$/i;
const THREAD_PARAM_RE = /(?:^|&)thread=([0-9]{1,12})(?:&|$)/;
const sqlTrim = (s: string) => s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");

/**
 * Mirror of public.challenge_task_parse_message_url: a link to ONE message inside a forum topic.
 *   https://t.me/c/<chat>/<topic>/<msg>          ("Copy link" on a message in a topic)
 *   https://t.me/c/<chat>/<msg>?thread=<topic>   (the older form; thread= names the topic, and wins if both)
 * A two-number link without thread= is refused: it cannot say which topic the message is in.
 */
export function parseMessageUrl(url: string | null | undefined): MessageRef | null {
  const m = TME_C_RE.exec(sqlTrim(url ?? ""));
  if (!m) return null;
  const query = m[4] ?? "";
  let thread: number | null = null;
  if (/(^|&)thread=/.test(query)) {
    const t = THREAD_PARAM_RE.exec(query);
    if (!t) return null;
    thread = Number(t[1]);
  }
  const chatId = Number(`-100${m[1]}`);
  if (m[3] !== undefined) return { chat: m[1], chatId, topic: thread ?? Number(m[2]), msg: Number(m[3]) };
  if (thread === null) return null;
  return { chat: m[1], chatId, topic: thread, msg: Number(m[2]) };
}

// ───────────────────────────── config (display only; the engine has its own parser) ─────────────────────────────

export type CalendarConfig = {
  /** challenge_tasks.enabled -- false until go-live (PR-8): nothing is posted. */
  enabled: boolean;
  ai: boolean;
  weekdays: number[];
  defaultPoints: { general: number; instagram: number };
  lateFactor: number;
  /** Tashkent dates of challenge.window (null = open). */
  windowStart: string | null;
  windowEnd: string | null;
  courseIds: string[];
  groupIds: string[];
  testGroupIds: string[];
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const pts = (v: unknown, dflt: number) => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 50 ? v : dflt);
function tashkentDateOf(ts: unknown): string | null {
  if (typeof ts !== "string" || ts.trim() === "") return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : tashkentToday(d);
}

/** Reads platform_settings 'challenge' + 'challenge_tasks' the way the approve guard does (defaults on junk). */
export function readCalendarConfig(challenge: unknown, tasks: unknown): CalendarConfig {
  const c = obj(challenge);
  const t = obj(tasks);
  const w = obj(c.window);
  const p = obj(t.points);
  const lf = typeof t.late_factor === "number" && t.late_factor > 0 && t.late_factor <= 1 ? t.late_factor : 0.5;
  return {
    enabled: t.enabled === true,
    ai: t.ai === true,
    weekdays: configWeekdays(t.task_weekdays),
    defaultPoints: { general: pts(p.general, 5), instagram: pts(p.instagram, 8) },
    lateFactor: lf,
    windowStart: tashkentDateOf(w.start),
    windowEnd: tashkentDateOf(w.end),
    courseIds: strs(c.course_ids),
    groupIds: strs(c.group_ids),
    testGroupIds: strs(t.test_group_ids),
  };
}

export const inWindow = (d: string, cfg: Pick<CalendarConfig, "windowStart" | "windowEnd">) =>
  (cfg.windowStart === null || d >= cfg.windowStart) && (cfg.windowEnd === null || d <= cfg.windowEnd);

// ───────────────────────────── admin-facing text ─────────────────────────────

/** "Skrinshot / rasm ×2 + Matn" -- what a task requires, for the calendar and the importer preview. */
export function requiresSummary(requires: unknown): string {
  if (!requiresValid(requires)) return "—";
  if (requires.length === 0) return "Istalgan bitta element";
  return requires.map((g) => `${LABEL_UZ[g.label]}${g.min > 1 ? ` ×${g.min}` : ""}`).join(" + ");
}

/**
 * A challenge_tasks write error, in the admin's words. The guard's own messages (P0001) pass through verbatim;
 * constraint names (which PostgREST reports as-is) are translated.
 */
export function taskSaveMessage(raw: string | null | undefined): string {
  const m = raw ?? "";
  if (m.includes("uq_challenge_tasks_course_date")) return "Bu sanada allaqachon vazifa bor — bir kunda bitta vazifa (avvalgisini bekor qiling)";
  if (m.includes("challenge_tasks_title_check")) return `Sarlavha ${LIMITS.title[0]}–${LIMITS.title[1]} belgi bo‘lishi kerak`;
  if (m.includes("challenge_tasks_body_check")) return `Vazifa matni 1–${LIMITS.body[1]} belgi bo‘lishi kerak`;
  if (m.includes("challenge_tasks_learn_line_check")) return `«Nimani o‘rganasiz» ko‘pi bilan ${LIMITS.learn} belgi`;
  if (m.includes("challenge_tasks_submit_hint_check")) return `«Topshirish» ko‘pi bilan ${LIMITS.hint} belgi`;
  if (m.includes("challenge_tasks_check_rubric_check")) return `AI mezoni ko‘pi bilan ${LIMITS.rubric} belgi`;
  if (m.includes("challenge_tasks_accepts_check")) return "Kamida bitta qabul qilinadigan format tanlang";
  if (m.includes("challenge_tasks_requires_check")) return REQUIRES_MSG.invalid;
  if (m.includes("challenge_tasks_points_check")) return `Ball ${LIMITS.points[0]}–${LIMITS.points[1]} oralig‘ida bo‘lishi kerak`;
  if (m.includes("challenge_tasks_minutes_check")) return `Daqiqa ${LIMITS.minutes[0]}–${LIMITS.minutes[1]} oralig‘ida bo‘lishi kerak`;
  if (m.includes("challenge_task_posts_task_id_fkey")) return "Bu vazifaga e’lon qilingan xabar biriktirilgan — avval havolalarni o‘chiring yoki vazifani bekor qiling";
  if (/row-level security|permission denied/i.test(m)) return "Ruxsat yo‘q (faqat admin)";
  return m || "Saqlab bo‘lmadi";
}

// ───────────────────────────── the post preview (display only) ─────────────────────────────

/**
 * The preview RPC returns the post as Telegram HTML (only <b> and the three entities are ever produced by
 * challenge_task_render_post_text). Splits it into plain/bold runs for display without innerHTML.
 */
export function telegramHtmlRuns(html: string): { text: string; bold: boolean }[] {
  const unescape = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const out: { text: string; bold: boolean }[] = [];
  const re = /<b>([\s\S]*?)<\/b>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m.index > last) out.push({ text: unescape(html.slice(last, m.index)), bold: false });
    out.push({ text: unescape(m[1]), bold: true });
    last = m.index + m[0].length;
  }
  if (last < html.length) out.push({ text: unescape(html.slice(last)), bold: false });
  return out;
}
