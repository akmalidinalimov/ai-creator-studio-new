// The WEEKLY APPROVAL messages (Daily Tasks PR-9): parse the dtw: buttons and render the ask / reminder / "no tasks"
// note, the confirm step and the result — PURE (no I/O), shared by challenge-tasks-worker (sends the ask / reminder /
// note) and telegram-bot-webhook (the dtw: buttons re-render the same message in place). Unit-tested in
// week-approval.test.ts; end to end against the real SQL in _challenge/testing/daily-tasks-week-approval-check.ts.
//
// The data is public.challenge_task_week_view(week) (migration 20260930200010): the week's live tasks with the points
// the 09:00 post will show, the configured task days with no task, the counts, and today (Tashkent) + a past flag per
// task. A PAST day is never approved from here (PR-5 never posts it, and an approved-but-never-posted day is a miss in
// every student's streak): it is marked «⌛ o‘tgan kun», left out of N and of the approve button, and a week that is
// over says «Bu hafta o‘tib ketdi». The SQL (challenge_tasks_approve_week) enforces the same rule. Telegram HTML (parse_mode HTML); every
// admin-typed string is escaped. A message always fits one Telegram message (fitText: <= 4000 UTF-16 units, the
// approve guard's own bound, under Telegram's 4096).
//
// Buttons (callback_data <= 64 bytes; "dtw:y:20261005" is 14):
//   dtw:a:<yyyymmdd>  ✅ Haftani tasdiqlash  -> the confirm step (edit in place)
//   dtw:y:<yyyymmdd>  ✅ Ha, tasdiqlash      -> challenge_tasks_approve_week (the real clicker, admin only)
//   dtw:b:<yyyymmdd>  ↩️ Orqaga              -> back to the listing
//   👀 Ko‘rib chiqish = a URL button to the admin calendar on that week (…/admin/challenge/tasks?week=YYYY-MM-DD).

export type WeekTask = {
  id: number;
  course_id?: string | null;
  course_title?: string | null;
  date: string; // YYYY-MM-DD (Tashkent)
  weekday?: number; // ISO 1..7
  type: string; // general | instagram
  title: string;
  status: string; // draft | approved
  points?: number | null;
  requires?: unknown;
  accepts?: unknown;
  min_text_chars?: number | null;
  min_duration_sec?: number | null;
  past?: boolean; // task_date < today (Tashkent): never approved from the week button
};

export type WeekView = {
  week_start: string;
  week_end?: string;
  tasks: WeekTask[];
  missing?: string[];
  multi_course?: boolean;
  counts?: { drafts?: number; drafts_all?: number; approved?: number; live?: number; configured_days?: number };
  post_time?: string | null;
  approved_at?: string | null;
  approved_by_name?: string | null;
  admin_url?: string | null;
  today?: string | null; // YYYY-MM-DD (Tashkent), from SQL now()
};

export type PastSkip = { task_id?: number; date?: string; title?: string; reason?: string };

export type ApproveResult = {
  approved: number;
  already_approved: number;
  failed: Array<{ task_id?: number; date?: string; title?: string; error?: string }>;
  skipped_past?: PastSkip[];
  past_week?: boolean;
  drafts_left?: number;
  actor_name?: string | null;
};

export type InlineButton = { text: string; callback_data?: string; url?: string };
export type Keyboard = { inline_keyboard: InlineButton[][] };
export type Rendered = { text: string; keyboard: Keyboard | null };

export type DtwAction = "a" | "y" | "b";
export type DtwCallback = { action: DtwAction; week: string; compact: string };

export const SITE = "https://www.aicreator.academy";
export const MAX_TEXT = 4000;

export const BTN = {
  approve: "✅ Haftani tasdiqlash",
  review: "👀 Ko‘rib chiqish",
  yes: "✅ Ha, tasdiqlash",
  back: "↩️ Orqaga",
} as const;

/** Why a past day is not approved here (the owner-facing words; the SQL's skipped_past reason says the same). */
export const PAST_EXPLAIN =
  "O‘tgan kunni bu yerdan tasdiqlab bo‘lmaydi: u guruhlarga chiqmagan, keyin tasdiqlansa o‘quvchilarning seriyasi buziladi. " +
  "Kerak bo‘lsa — kalendarda alohida (retro) tasdiqlang.";

const MONTH = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
const WEEKDAY_SHORT = ["Du", "Se", "Ch", "Pa", "Ju", "Sh", "Ya"]; // ISO 1..7 (the admin page's labels)

// what a student must send, by requires-group label (the admin page's LABEL_UZ, src/lib/dailyTasksPlan.ts)
const LABEL: Record<string, string> = {
  screenshot: "Skrinshot / rasm", video: "Video", file: "Fayl", text: "Matn", link: "Havola", ig_link: "Instagram havolasi",
  voice: "Ovozli xabar",
};
const ACCEPT: Record<string, string> = {
  text: "matn", photo: "rasm", video: "video", document: "fayl", voice: "ovozli xabar", video_note: "dumaloq video",
  audio: "audio", link: "havola",
};

export function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function isoWeekday(iso: string): number {
  const w = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
}

function addDaysIso(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export type WeekPhase = "next" | "current" | "past";

/** Where the week stands against today (the view's, from SQL): no today known = "next" (nothing is marked past). */
export function weekPhase(v: Pick<WeekView, "week_start" | "week_end" | "today">): WeekPhase {
  if (!isIsoDate(v.today)) return "next";
  const end = isIsoDate(v.week_end) ? v.week_end : addDaysIso(v.week_start, 6);
  if (end < v.today) return "past";
  return v.week_start <= v.today ? "current" : "next";
}

/** A task day before today: never approved from the week button. */
export function isPastTask(v: Pick<WeekView, "today">, t: Pick<WeekTask, "date" | "past">): boolean {
  return t.past === true || (isIsoDate(v.today) && t.date < v.today);
}

function weekTitle(v: WeekView): string {
  const p = weekPhase(v);
  return p === "past" ? "O‘tgan hafta vazifalari" : p === "current" ? "Shu hafta vazifalari" : "Keyingi hafta vazifalari";
}

/** "dtw:a:20261005" -> {action a, week 2026-10-05}. Only a real Monday; anything else null (a stale / forged tap). */
export function parseDtwCallback(data: unknown): DtwCallback | null {
  const m = typeof data === "string" ? /^dtw:([ayb]):(\d{4})(\d{2})(\d{2})$/.exec(data) : null;
  if (!m) return null;
  const week = `${m[2]}-${m[3]}-${m[4]}`;
  if (!isIsoDate(week) || isoWeekday(week) !== 1) return null;
  return { action: m[1] as DtwAction, week, compact: `${m[2]}${m[3]}${m[4]}` };
}

export function dtwData(action: DtwAction, week: string): string {
  return `dtw:${action}:${week.replace(/-/g, "")}`;
}

export function reviewUrl(week: string, site = SITE): string {
  return `${site}/admin/challenge/tasks?week=${week}`;
}

/** "5-oktabr" */
export function dayLabel(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${d}-${MONTH[m - 1]}`;
}

/** "Du, 5-oktabr" */
export function dayLine(iso: string): string {
  return `${WEEKDAY_SHORT[isoWeekday(iso) - 1]}, ${dayLabel(iso)}`;
}

/** "5–9 oktabr" / "28 sentabr – 2 oktabr" / "5 oktabr" */
export function rangeLabel(from: string, to: string): string {
  const [, m1, d1] = from.split("-").map(Number);
  const [, m2, d2] = to.split("-").map(Number);
  if (from === to) return `${d1} ${MONTH[m1 - 1]}`;
  if (m1 === m2) return `${d1}–${d2} ${MONTH[m1 - 1]}`;
  return `${d1} ${MONTH[m1 - 1]} – ${d2} ${MONTH[m2 - 1]}`;
}

/** The week's label: the span of its task days (tasks + configured days with no task), else Monday..Sunday. */
export function weekLabel(v: Pick<WeekView, "week_start" | "week_end" | "tasks" | "missing">): string {
  const days = [...(v.tasks ?? []).map((t) => t.date), ...(v.missing ?? [])].filter(isIsoDate).sort();
  if (days.length) return rangeLabel(days[0], days[days.length - 1]);
  const end = isIsoDate(v.week_end) ? v.week_end : v.week_start;
  return rangeLabel(v.week_start, end);
}

/** "Skrinshot / rasm ×2 + Matn" -- what a student MUST send (requires); [] = any one accepted item. */
export function requiresShort(requires: unknown, accepts?: unknown): string {
  const groups = Array.isArray(requires) ? requires : null;
  if (groups && groups.length > 0) {
    const parts = groups.map((g) => {
      const o = (g && typeof g === "object") ? g as { label?: unknown; min?: unknown } : {};
      const label = LABEL[String(o.label)] ?? String(o.label ?? "?");
      const min = Number(o.min);
      return `${label}${Number.isInteger(min) && min > 1 ? ` ×${min}` : ""}`;
    });
    return parts.join(" + ");
  }
  const acc = Array.isArray(accepts) ? accepts.map((a) => ACCEPT[String(a)] ?? String(a)) : [];
  return acc.length ? `istalgan bittasi (${acc.join(", ")})` : "istalgan bitta ish";
}

function typeLabel(type: string): string {
  return type === "instagram" ? "📸 Instagram" : "📝 umumiy";
}

function cut(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s;
}

type ListOpts = { titleMax: number; reqMax: number; limit: number };

/** The day-by-day listing (the body of the ask, the reminder and the confirm step). */
function listing(v: WeekView, o: ListOpts): string {
  const rows: Array<{ date: string; text: string }> = [];
  const tasks = [...(v.tasks ?? [])].sort((a, b) => a.date.localeCompare(b.date) || String(a.course_title ?? "").localeCompare(String(b.course_title ?? "")));
  for (const t of tasks) {
    const mark = t.status === "approved" ? "✅ " : "";
    const course = v.multi_course && t.course_title ? ` · ${esc(cut(t.course_title, 40))}` : "";
    const pts = Number.isFinite(Number(t.points)) && t.points != null ? ` · ${Number(t.points)} ball` : "";
    const past = isPastTask(v, t) ? " · ⌛ o‘tgan kun" : "";
    rows.push({
      date: t.date,
      text: `<b>${dayLine(t.date)}</b> · ${typeLabel(t.type)}${pts}${past}${course}\n` +
        `${mark}${esc(cut(String(t.title ?? "").trim(), o.titleMax))}\n` +
        `Topshirish: ${esc(cut(requiresShort(t.requires, t.accepts), o.reqMax))}`,
    });
  }
  for (const d of (v.missing ?? []).filter(isIsoDate)) {
    rows.push({ date: d, text: `<b>${dayLine(d)}</b> — ⚠️ vazifa yo‘q` });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  const shown = rows.slice(0, o.limit).map((r) => r.text);
  if (rows.length > o.limit) shown.push(`… yana ${rows.length - o.limit} ta — «${BTN.review}»`);
  return shown.join("\n\n");
}

/** Builds the message with progressively shorter listings until it fits one Telegram message. */
function fitText(build: (o: ListOpts) => string): string {
  const tries: ListOpts[] = [
    { titleMax: 120, reqMax: 200, limit: 60 },
    { titleMax: 60, reqMax: 80, limit: 60 },
    { titleMax: 40, reqMax: 50, limit: 20 },
    { titleMax: 30, reqMax: 40, limit: 8 },
  ];
  for (const o of tries) {
    const t = build(o);
    if (t.length <= MAX_TEXT) return t;
  }
  return build({ titleMax: 20, reqMax: 20, limit: 3 }).slice(0, MAX_TEXT);
}

/** drafts = what the week button can approve (today and later); pastDrafts = drafts of days already gone. */
export function weekCounts(v: WeekView): { drafts: number; pastDrafts: number; approved: number } {
  const all = v.tasks.filter((t) => t.status === "draft");
  const pastDrafts = all.filter((t) => isPastTask(v, t)).length;
  const approved = v.tasks.filter((t) => t.status === "approved").length;
  return { drafts: all.length - pastDrafts, pastDrafts, approved };
}
const counts = weekCounts;

function reviewButton(v: WeekView): InlineButton {
  return { text: BTN.review, url: v.admin_url && /^https:\/\//.test(v.admin_url) ? v.admin_url : reviewUrl(v.week_start) };
}

/** [✅ Haftani tasdiqlash] (only while a draft of today or later remains) + [👀 Ko‘rib chiqish]. */
export function askKeyboard(v: WeekView): Keyboard {
  const rows: InlineButton[][] = [];
  if (counts(v).drafts > 0) rows.push([{ text: BTN.approve, callback_data: dtwData("a", v.week_start) }]);
  rows.push([reviewButton(v)]);
  return { inline_keyboard: rows };
}

function summaryLine(v: WeekView): string {
  const c = counts(v);
  const bits = [`${c.drafts} ta qoralama`];
  if (c.approved > 0) bits.push(`${c.approved} ta tasdiqlangan`);
  if (c.pastDrafts > 0) bits.push(`${c.pastDrafts} ta o‘tgan kun qoralamasi`);
  const miss = (v.missing ?? []).length;
  if (miss > 0) bits.push(`${miss} kun vazifasiz`);
  return `Jami: ${bits.join(", ")}.`;
}

/** The Thursday ask ('ask') and the weekend reminder ('remind'); also the listing a dtw: tap re-renders (a week that
 * has started, or is over, says so; its past days carry no approve button). */
export function renderAsk(v: WeekView, kind: "ask" | "remind" = "ask"): Rendered {
  const label = weekLabel(v);
  const post = /^\d{2}:\d{2}$/.test(String(v.post_time ?? "")) ? String(v.post_time) : "09:00";
  const phase = weekPhase(v);
  const head = kind === "remind"
    ? `⏰ <b>Eslatma: keyingi hafta vazifalari hali tasdiqlanmagan (${label})</b>`
    : phase === "past"
    ? `⌛ <b>Bu hafta o‘tib ketdi (${label})</b>`
    : `📅 <b>${weekTitle(v)} (${label})</b>`;
  const intro = kind === "remind"
    ? `Tasdiqlanmasa, o‘sha kuni ${post} da guruhlarga vazifa chiqmaydi.`
    : phase === "past"
    ? PAST_EXPLAIN
    : phase === "current"
    ? "Qoralama kun guruhlarga chiqmaydi. Bu yerdan faqat bugun va keyingi kunlar tasdiqlanadi, o‘tgan kunlar — yo‘q."
    : "Hammasi hozircha QORALAMA — tasdiqlanmaguncha guruhlarga chiqmaydi.";
  const tail = counts(v).drafts > 0
    ? "✅ — hammasini bir bosishda tasdiqlash (yana bir marta so‘raladi). 👀 — avval o‘zgartirish."
    : "👀 — kalendarda ko‘rish va o‘zgartirish.";
  const text = fitText((o) => `${head}\n${intro}\n\n${listing(v, o)}\n\n${summaryLine(v)}\n${tail}`);
  return { text, keyboard: askKeyboard(v) };
}

/** The confirm step: the same listing + "N ta vazifa tasdiqlansinmi?" [✅ Ha, tasdiqlash] [↩️ Orqaga]. */
export function renderConfirm(v: WeekView): Rendered {
  const { drafts: n, pastDrafts } = counts(v);
  const label = weekLabel(v);
  const pastNote = pastDrafts > 0
    ? `\n⌛ O‘tgan kunlardagi ${pastDrafts} ta qoralama kiritilmaydi — kerak bo‘lsa, kalendarda alohida (retro) tasdiqlang.`
    : "";
  const text = fitText((o) =>
    `📅 <b>${weekTitle(v)} (${label})</b>\n\n${listing(v, o)}\n\n` +
    `❓ <b>${n} ta vazifa tasdiqlansinmi?</b>\nTasdiqlangach, har biri o‘z kunida guruhlarga e’lon qilinadi.${pastNote}`
  );
  return {
    text,
    keyboard: { inline_keyboard: [[{ text: BTN.yes, callback_data: dtwData("y", v.week_start) }, { text: BTN.back, callback_data: dtwData("b", v.week_start) }]] },
  };
}

/** The past-dated drafts the approval left alone (never approved from here), with the retro hint. */
function pastLines(past: PastSkip[]): string[] {
  if (!past.length) return [];
  const lines = ["", `<b>⌛ O‘tgan kun — tasdiqlanmadi (${past.length}):</b>`];
  for (const p of past.slice(0, 10)) {
    lines.push(`• ${isIsoDate(p.date) ? dayLine(p.date) : "?"} — «${esc(cut(String(p.title ?? ""), 60))}»`);
  }
  if (past.length > 10) lines.push(`… yana ${past.length - 10} ta`);
  lines.push(`Guruhlarga chiqmagan kun keyin tasdiqlansa, seriyalar buziladi. Kerak bo‘lsa — kalendarda alohida (retro): «${BTN.review}».`);
  return lines;
}

/** After challenge_tasks_approve_week: "✅ N/M tasdiqlandi — <admin>", failures listed with the review link. */
export function renderResult(v: WeekView, r: ApproveResult, actorName?: string | null): Rendered {
  const label = weekLabel(v);
  const who = esc(cut(String(actorName ?? r.actor_name ?? "").trim() || "admin", 60));
  const failed = Array.isArray(r.failed) ? r.failed : [];
  const past = Array.isArray(r.skipped_past) ? r.skipped_past : [];
  const tried = r.approved + failed.length;
  let text: string;
  if (r.approved === 0 && failed.length === 0) {
    const head = r.past_week === true || weekPhase(v) === "past"
      ? `⌛ <b>Bu hafta o‘tib ketdi (${label})</b>`
      : `ℹ️ <b>Bu hafta allaqachon tasdiqlangan (${label})</b>`;
    text = [`${head}\nTasdiqlangan: ${r.already_approved} ta vazifa.${past.length ? "" : " Qoralama qolmagan."}`, ...pastLines(past)]
      .join("\n").slice(0, MAX_TEXT);
  } else {
    const lines = [
      `${failed.length ? "⚠️" : "✅"} <b>${weekTitle(v)}: ${r.approved}/${tried} tasdiqlandi</b> (${label}) — ${who}`,
    ];
    if (r.already_approved > 0) lines.push(`Avval tasdiqlangan: ${r.already_approved} ta.`);
    if (failed.length) {
      lines.push("", `<b>Tasdiqlanmadi (${failed.length}):</b>`);
      for (const f of failed.slice(0, 10)) {
        const day = isIsoDate(f.date) ? dayLine(f.date) : "?";
        lines.push(`• ${day} — «${esc(cut(String(f.title ?? ""), 60))}»: ${esc(cut(String(f.error ?? "xato"), 160))}`);
      }
      if (failed.length > 10) lines.push(`… yana ${failed.length - 10} ta`);
      lines.push("", `Tuzatib, qaytadan tasdiqlang: «${BTN.review}».`);
    } else {
      lines.push("Har bir vazifa o‘z kunida guruhlarga e’lon qilinadi.");
    }
    lines.push(...pastLines(past));
    text = lines.join("\n").slice(0, MAX_TEXT);
  }
  // v is the week AFTER the approval: the approve button stays only while a draft remains (fix it, then tap again)
  return { text, keyboard: askKeyboard(v) };
}

/** "Next week has no task at all" (configured task days, inside the window). */
export function renderNoTasks(v: WeekView): Rendered {
  const label = weekLabel(v);
  const days = (v.missing ?? []).filter(isIsoDate).map((d) => dayLine(d)).join(", ");
  const text = `📭 <b>Keyingi haftaga vazifa yo‘q (${label})</b>\n` +
    (days ? `Vazifa kunlari: ${esc(days)}.\n` : "") +
    `Kalendarga vazifa qo‘shing — qo‘shilgan qoralamalarni shu yerda tasdiqlash so‘raladi.`;
  return { text: text.slice(0, MAX_TEXT), keyboard: { inline_keyboard: [[reviewButton(v)]] } };
}

/** The message for an outbox kind, or null for an unknown kind. */
export function renderKind(kind: string, v: WeekView): Rendered | null {
  if (kind === "ask" || kind === "remind") return renderAsk(v, kind);
  if (kind === "no_tasks") return renderNoTasks(v);
  return null;
}

/** A defensive read of challenge_task_week_view's jsonb (never throws; junk -> an empty week). */
export function toWeekView(raw: unknown, week: string): WeekView {
  const o = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  const tasks = Array.isArray(o.tasks) ? (o.tasks as unknown[]).filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .filter((t) => isIsoDate(t.date))
    .map((t) => ({
      id: Number(t.id), course_id: typeof t.course_id === "string" ? t.course_id : null,
      course_title: typeof t.course_title === "string" ? t.course_title : null, date: String(t.date),
      weekday: Number(t.weekday) || undefined, type: String(t.type ?? "general"), title: String(t.title ?? ""),
      status: String(t.status ?? "draft"), points: t.points == null ? null : Number(t.points), requires: t.requires,
      accepts: t.accepts, past: t.past === true,
    })) : [];
  return {
    week_start: isIsoDate(o.week_start) ? o.week_start : week,
    week_end: isIsoDate(o.week_end) ? o.week_end : undefined,
    tasks,
    missing: Array.isArray(o.missing) ? (o.missing as unknown[]).filter(isIsoDate) : [],
    multi_course: o.multi_course === true,
    counts: (o.counts && typeof o.counts === "object") ? o.counts as WeekView["counts"] : undefined,
    post_time: typeof o.post_time === "string" ? o.post_time : null,
    approved_at: typeof o.approved_at === "string" ? o.approved_at : null,
    approved_by_name: typeof o.approved_by_name === "string" ? o.approved_by_name : null,
    admin_url: typeof o.admin_url === "string" ? o.admin_url : null,
    today: isIsoDate(o.today) ? o.today : null,
  };
}
