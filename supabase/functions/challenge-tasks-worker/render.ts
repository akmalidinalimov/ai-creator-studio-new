// challenge-tasks-worker — what the worker shows that the bot never does: the task post's button, the 20:00 topic
// summary, and the four DM kinds (morning, evening, result, backfill_summary). PURE: no I/O, no clock, no env.
// Receipts are NOT rendered here: the worker uses the bot's renderer (_shared/daily-task-render.ts renderReceipt), so a
// receipt the worker edits is byte-identical to the one the bot sent ("message is not modified" = success).
//
// Copy: group-visible text (the post button, the summary) is Uzbek (a group chat is shared); DMs use the student's
// locale (uz / ru / en). Every name / title that reaches Telegram HTML goes through escapeHtml.
import {
  botStartUrl, DAILY_COPY, escapeHtml, formatTaskDate, type InlineButton, type InlineKeyboard, isTelegramUrl, type Locale,
  type Rendered, safeName,
} from "../_shared/daily-task-render.ts";

/** Telegram's limit for a photo caption, in UTF-16 units of the VISIBLE text (after HTML parsing). */
export const CAPTION_MAX = 1024;

/**
 * The visible length of a Telegram-HTML text: tags removed, the entities the renderers produce decoded, counted in
 * UTF-16 units (a JS string's length) — the way Telegram counts a caption. A task post longer than CAPTION_MAX cannot
 * ride under its day image, so the worker posts it as plain text instead (and says so in admin_actions).
 */
export function captionLength(html: string): number {
  return String(html ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .length;
}

/** The task post's button text. The SQL fallback poster (migration 20260930152010) posts the SAME text. */
export const POST_BUTTON_TEXT = "📲 Vazifani botda ochish";

export function toLocale(v: unknown): Locale {
  const s = String(v ?? "").toLowerCase().slice(0, 2);
  return s === "ru" ? "ru" : s === "en" ? "en" : "uz";
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The post's inline button: t.me/<bot>?start=dt_<id> (spec C10 — group-safe, makes the student DM-able). A Mini App
 * link only when the config parser let one through (miniapp_link, refused until member onboarding exists — G28).
 */
export function postKeyboard(taskId: number, botUsername: string | null | undefined, miniappLink?: string | null): InlineKeyboard | null {
  if (!Number.isSafeInteger(taskId) || taskId <= 0) return null;
  let url: string | null = null;
  const ml = String(miniappLink ?? "").trim();
  if (ml && /^https:\/\/t\.me\/[A-Za-z0-9_]{3,64}(\/[A-Za-z0-9_]{1,64})?(\?startapp=[A-Za-z0-9_-]{0,64})?$/.test(ml)) {
    url = ml.includes("?startapp=") ? ml : `${ml}?startapp=dt_${taskId}`;
  } else {
    url = botStartUrl(botUsername, `dt_${taskId}`);
  }
  return url ? { inline_keyboard: [[{ text: POST_BUTTON_TEXT, url }]] } : null;
}

export interface SummaryCounts {
  done?: number | null;
  on_time?: number | null;
  checking?: number | null;
  needs_more?: number | null;
  task_date?: string | null;
  /** The last ON-TIME day (task_date + grace_days, 20261005111000). Absent = the task day itself. */
  due_date?: string | null;
}

function isoDay(v: unknown): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? ""));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000 : null;
}

/**
 * Until when a task is on time, said from the day the message goes out (2026-10-05: a task every other day, on time
 * until 23:59 of the NEXT day): "bugun 23:59 gacha" / "ertaga 23:59 gacha" / "8-oktabr 23:59 gacha". `due` absent or
 * unparseable = `from` (the old same-day rule).
 */
export function dueText(locale: Locale, from: string | null | undefined, due: string | null | undefined): string {
  const f = isoDay(from);
  const d = isoDay(due ?? from);
  const diff = f !== null && d !== null ? d - f : 0;
  const date = formatTaskDate(String(due ?? ""), locale);
  if (locale === "ru") return diff <= 0 ? "до 23:59 сегодня" : diff === 1 ? "до 23:59 завтра" : `до 23:59 ${date}`;
  if (locale === "en") return diff <= 0 ? "by 23:59 today" : diff === 1 ? "by 23:59 tomorrow" : `by 23:59 on ${date}`;
  return diff <= 0 ? "bugun 23:59 gacha" : diff === 1 ? "ertaga 23:59 gacha" : `${date} 23:59 gacha`;
}

/** The anonymous 20:00 topic summary (counts only, never a name). */
export function renderSummary(s: SummaryCounts | null | undefined): string {
  const done = num(s?.done) ?? 0;
  const onTime = num(s?.on_time) ?? 0;
  const checking = num(s?.checking) ?? 0;
  const needsMore = num(s?.needs_more) ?? 0;
  const date = s?.task_date ? ` (${formatTaskDate(s.task_date, "uz")})` : "";
  const lines = [`📊 <b>Vazifa natijasi</b>${date}`];
  if (done + checking + needsMore === 0) {
    lines.push("📭 Hali hech kim topshirmadi.");
  } else {
    lines.push(`✅ Topshirdi: ${done}${done > 0 ? ` (o‘z vaqtida: ${onTime})` : ""}`);
    if (checking > 0) lines.push(`👀 Tekshirilmoqda: ${checking}`);
    if (needsMore > 0) lines.push(`✍️ To‘ldirish kerak: ${needsMore}`);
  }
  lines.push("");
  lines.push(`⏰ Ulgurmaganlar — ${dueText("uz", s?.task_date, s?.due_date)} vaqt bor.`);
  return lines.join("\n");
}

// ── DMs ──────────────────────────────────────────────────────────────────────────────────────────────────
type DmCopy = {
  morningHead: (name: string, dayNo: number | null) => string;
  pointsDue: (pts: number, due: string) => string;
  where: string;
  btnTopic: string;
  btnTask: string;
  eveningHead: (streak: number) => string;
  eveningToday: (name: string, title: string, pts: number, due: string) => string;
  eveningMissed: (date: string, title: string, pts: number) => string;
  eveningKeep: (streak: number) => string;
  resultAccepted: (title: string, date: string, pts: number, late: boolean) => string;
  resultRejected: (title: string, date: string, why: string) => string;
  backfill: (name: string, n: number, pts: number) => string;
};

const DM_UZ: DmCopy = {
  morningHead: (name, dayNo) => `☀️ ${name ? `${name}, x` : "X"}ayrli tong! ${dayNo ? `${dayNo}-qo‘shimcha vazifa` : "Yangi qo‘shimcha vazifa"} e’lon qilindi:`,
  pointsDue: (pts, due) => `🏆 +${pts} ball — ${due}.`,
  where: "📍 Ishingizni guruhingizdagi «Qo‘shimcha vazifalar» topigiga yuboring.",
  btnTopic: "📌 Qo‘shimcha vazifalar topigi",
  btnTask: "📋 Vazifa matni",
  eveningHead: (streak) => streak > 0 ? `📅 Vazifa seriyasi: ${streak} ta vazifa ketma-ket 🔥` : "📅 Vazifa seriyasi",
  eveningToday: (name, title, pts, due) => `${name ? `${name}, v` : "V"}azifa hali topshirilmagan: <b>${title}</b> — ${due} +${pts} ball.`,
  eveningMissed: (date, title, pts) => `↩️ ${date} vazifasi ham ochiq (kechikkan — +${pts} ball): <b>${title}</b>`,
  eveningKeep: (streak) => `🔥 Topshirsangiz, seriyangiz ${streak + 1} taga yetadi.`,
  resultAccepted: (title, date, pts, late) =>
    `✅ «${title}» (${date}) qabul qilindi${pts > 0 ? `: +${pts} ball` : ""}${late && pts > 0 ? " (kechikkan — yarim ball)" : ""}.`,
  resultRejected: (title, date, why) => `🤔 «${title}» (${date}) qabul qilinmadi: ${why}.`,
  backfill: (name, n, pts) => `🎉 ${name ? `${name}, q` : "Q"}o‘shimcha vazifalardagi avvalgi ishlaringiz hisoblandi: ${n} ta ish${pts > 0 ? `, jami +${pts} ball` : ""}.`,
};

const DM_RU: DmCopy = {
  morningHead: (name, dayNo) => `☀️ ${name ? `${name}, д` : "Д"}оброе утро! Опубликовано ${dayNo ? `дополнительное задание №${dayNo}` : "новое дополнительное задание"}:`,
  pointsDue: (pts, due) => `🏆 +${pts} — ${due}.`,
  where: "📍 Отправьте работу в топик «Qo‘shimcha vazifalar» вашей группы.",
  btnTopic: "📌 Топик дополнительных заданий",
  btnTask: "📋 Текст задания",
  eveningHead: (streak) => streak > 0 ? `📅 Серия заданий: ${streak} подряд 🔥` : "📅 Серия заданий",
  eveningToday: (name, title, pts, due) => `${name ? `${name}, з` : "З"}адание ещё не сдано: <b>${title}</b> — ${due} +${pts}.`,
  eveningMissed: (date, title, pts) => `↩️ Задание за ${date} тоже открыто (с опозданием — +${pts}): <b>${title}</b>`,
  eveningKeep: (streak) => `🔥 Сдадите — серия станет ${streak + 1}.`,
  resultAccepted: (title, date, pts, late) =>
    `✅ «${title}» (${date}) принято${pts > 0 ? `: +${pts}` : ""}${late && pts > 0 ? " (с опозданием — половина баллов)" : ""}.`,
  resultRejected: (title, date, why) => `🤔 «${title}» (${date}) не принято: ${why}.`,
  backfill: (name, n, pts) => `🎉 ${name ? `${name}, в` : "В"}аши прошлые работы в дополнительных заданиях засчитаны: ${n}${pts > 0 ? `, всего +${pts}` : ""}.`,
};

const DM_EN: DmCopy = {
  morningHead: (name, dayNo) => `☀️ Good morning${name ? `, ${name}` : ""}! ${dayNo ? `Extra task ${dayNo}` : "A new extra task"} is out:`,
  pointsDue: (pts, due) => `🏆 +${pts} pts — ${due}.`,
  where: "📍 Post your work in your group's «Qo‘shimcha vazifalar» topic.",
  btnTopic: "📌 Extra tasks topic",
  btnTask: "📋 Task text",
  eveningHead: (streak) => streak > 0 ? `📅 Task streak: ${streak} in a row 🔥` : "📅 Task streak",
  eveningToday: (name, title, pts, due) => `${name ? `${name}, y` : "Y"}our task isn't submitted yet: <b>${title}</b> — +${pts} pts ${due}.`,
  eveningMissed: (date, title, pts) => `↩️ The ${date} task is still open (late — +${pts} pts): <b>${title}</b>`,
  eveningKeep: (streak) => `🔥 Submit it and your streak reaches ${streak + 1}.`,
  resultAccepted: (title, date, pts, late) =>
    `✅ «${title}» (${date}) accepted${pts > 0 ? `: +${pts} pts` : ""}${late && pts > 0 ? " (late — half points)" : ""}.`,
  resultRejected: (title, date, why) => `🤔 «${title}» (${date}) was not accepted: ${why}.`,
  backfill: (name, n, pts) => `🎉 ${name ? `${name}, y` : "Y"}our earlier extra-task work was counted: ${n} submissions${pts > 0 ? `, +${pts} pts in total` : ""}.`,
};

const DM_COPY: Record<Locale, DmCopy> = { uz: DM_UZ, ru: DM_RU, en: DM_EN };

function dmKeyboard(c: DmCopy, topicUrl: unknown, taskId: unknown, botUsername: string | null | undefined): InlineKeyboard | null {
  const row: InlineButton[] = [];
  if (isTelegramUrl(topicUrl as string)) row.push({ text: c.btnTopic, url: String(topicUrl).trim() });
  const t = Number(taskId);
  const cardUrl = Number.isSafeInteger(t) && t > 0 ? botStartUrl(botUsername, `dt_${t}`) : null;
  if (cardUrl) row.push({ text: c.btnTask, url: cardUrl });
  return row.length ? { inline_keyboard: [row] } : null;
}

/** challenge_task_outbox.payload of kind 'morning' (migration 20260930152010, tick section b). */
export interface MorningPayload {
  task_id?: number;
  task_date?: string;
  day_no?: number | null;
  type?: string;
  title?: string;
  points?: number | null;
  topic_url?: string | null;
  /** task_date + grace_days (20261005111000); absent = task_date. */
  due_date?: string | null;
}

export function renderMorningDm(p: MorningPayload, opts: { locale: Locale; name?: string | null; botUsername?: string | null }): Rendered {
  const c = DM_COPY[opts.locale] ?? DM_UZ;
  const pts = num(p.points) ?? 0;
  const lines = [
    c.morningHead(safeName(opts.name), num(p.day_no)),
    `<b>${escapeHtml(String(p.title ?? "").trim())}</b>`,
    ...(pts > 0 ? [c.pointsDue(pts, dueText(opts.locale, p.task_date, p.due_date))] : []),
    c.where,
  ];
  return { text: lines.join("\n"), keyboard: dmKeyboard(c, p.topic_url, p.task_id, opts.botUsername) };
}

/** kind 'evening' (tick section d): the student's OPEN tasks not yet done, newest first. */
export interface EveningPayload {
  date?: string;
  topic_url?: string | null;
  streak_days?: number | null;
  pending?: Array<{ task_id?: number; date?: string; title?: string; type?: string; late_days?: number; points?: number; due_date?: string }> | null;
}

export function renderEveningDm(p: EveningPayload, opts: { locale: Locale; name?: string | null; botUsername?: string | null }): Rendered | null {
  const c = DM_COPY[opts.locale] ?? DM_UZ;
  const pending = Array.isArray(p.pending) ? p.pending : [];
  if (!pending.length) return null;
  const streak = num(p.streak_days) ?? 0;
  const name = safeName(opts.name);
  const lines = [c.eveningHead(streak)];
  const today = pending.find((x) => (num(x.late_days) ?? 1) === 0);
  if (today) {
    lines.push(c.eveningToday(name, escapeHtml(String(today.title ?? "").trim()), num(today.points) ?? 0,
      dueText(opts.locale, p.date, today.due_date ?? p.date)));
    if (streak > 0) lines.push(c.eveningKeep(streak));
  }
  for (const x of pending) {
    if (x === today) continue;
    lines.push(c.eveningMissed(formatTaskDate(x.date ?? "", opts.locale), escapeHtml(String(x.title ?? "").trim()), num(x.points) ?? 0));
  }
  lines.push(c.where);
  const first = today ?? pending[0];
  return { text: lines.join("\n"), keyboard: dmKeyboard(c, p.topic_url, first?.task_id, opts.botUsername) };
}

/** kind 'result': the CURRENT state of the checked submission (read at send time). null = nothing to tell. */
export interface ResultState {
  status: string;
  reason?: string | null;
  points_awarded?: number | null;
  late_days?: number | null;
  task_id?: number;
  task_date?: string;
  title?: string;
  topic_url?: string | null;
  tag_handle?: string | null;
}

export function renderResultDm(s: ResultState, opts: { locale: Locale; botUsername?: string | null }): Rendered | null {
  const c = DM_COPY[opts.locale] ?? DM_UZ;
  const base = DAILY_COPY[opts.locale] ?? DAILY_COPY.uz;
  const title = escapeHtml(String(s.title ?? "").trim());
  const date = formatTaskDate(s.task_date ?? "", opts.locale);
  let text: string;
  if (s.status === "accepted") {
    text = c.resultAccepted(title, date, num(s.points_awarded) ?? 0, (num(s.late_days) ?? 0) > 0);
  } else if (s.status === "rejected") {
    const r = String(s.reason ?? "");
    const guide = base.igGuide[r];
    if (guide) {
      // an Instagram problem: what to do, in steps (not a one-word reason)
      return { text: `📌 «${title}» (${date})\n${guide}`, keyboard: dmKeyboard(c, s.topic_url, s.task_id, opts.botUsername) };
    }
    const why = r === "ig_tag_missing"
      ? base.tagMissing(escapeHtml(String(s.tag_handle ?? "aicreators.students").replace(/^@/, "")))
      : r === "ig_post_old" ? base.igOld.replace(/^🤔\s*/, "").replace(/\.$/, "")
      : r === "ig_link_invalid" ? base.igInvalid.replace(/^🤔\s*/, "").replace(/\.$/, "")
      : base.reasons[r] ?? base.reasonDefault;
    text = c.resultRejected(title, date, why);
  } else {
    return null; // withdrawn / moved / merged / re-checking since: the group receipt already says it
  }
  return { text, keyboard: dmKeyboard(c, s.topic_url, s.status === "rejected" ? s.task_id : null, opts.botUsername) };
}

/** kind 'backfill_summary' (challenge_tasks_backfill, PR-3). */
export function renderBackfillDm(p: { submissions?: number | null; points?: number | null }, opts: { locale: Locale; name?: string | null }): Rendered | null {
  const n = num(p.submissions) ?? 0;
  if (n <= 0) return null;
  const c = DM_COPY[opts.locale] ?? DM_UZ;
  return { text: c.backfill(safeName(opts.name), n, num(p.points) ?? 0), keyboard: null };
}
