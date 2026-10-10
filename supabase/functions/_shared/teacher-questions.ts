// «KURATORGA SAVOLLAR» — the teacher's question inbox (owner, 2026-10-10: "really easy for teachers to track which
// questions are left unanswered, old or new"). Rows come from public.teacher_questions (built from the group's
// questions topic by teacher_questions_reconcile(); migration 20261010051000).
//
//   ❓ Savollar (teacher keyboard / /savollar) → summary: 🆕 new (< new_min) · ⏳ waiting longer · per-group filter
//   [🆕 Yangi (n)] [⏳ Kutayotgan (m)] → a compact list, 8 per page (new: newest first; waiting: longest wait first)
//   [📂 #12 · Ali · 2 soat] → the question card + its screenshots: [✍️ Javob yozish] [✅ Javob berildi] [🔗 Guruhda]
//   ✍️ → the teacher's next message is posted in the topic as a reply to the student, and DM'd to the student.
//
// Callback data (≤ 64 bytes; a group filter is a uuid = 36): tq:s[:<gid>] · tq:l:<n|o>:<page>[:<gid>] ·
// tq:o:<id> · tq:r:<id> · tq:d:<id> · tq:u:<id>. Pure — the bot (telegram-bot-webhook/teacher-questions-bot.ts) and the
// reminder (teacher-questions-reminder) do the I/O.

import { escCap } from "./support-agent-card.ts";
import { ageText } from "./support-inbox.ts";

export { ageText };
type Kb = { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> };

export const TQ_PAGE_SIZE = 8;
export const TQ_DEFAULTS = {
  enabled: true, merge_min: 10, new_min: 60, remind_after_min: 60, repeat_min: 180, max_reminders: 3,
  quiet_start_hour: 22, quiet_end_hour: 8,
};
export type TqSettings = typeof TQ_DEFAULTS;

/** The teacher keyboard's button (uz / ru / en), mapped to /savollar. */
export const TQ_BUTTON: Record<"uz" | "ru" | "en", string> = { uz: "❓ Savollar", ru: "❓ Вопросы", en: "❓ Questions" };

export function tqSettingsOf(v: unknown): TqSettings {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const int = (x: unknown, d: number, lo: number, hi: number) => {
    const n = Number(x);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : d;
  };
  return {
    enabled: o.enabled === undefined ? true : o.enabled === true,
    merge_min: int(o.merge_min, 10, 1, 120),
    new_min: int(o.new_min, 60, 5, 24 * 60),
    remind_after_min: int(o.remind_after_min, 60, 5, 24 * 60),
    repeat_min: int(o.repeat_min, 180, 15, 7 * 24 * 60),
    max_reminders: int(o.max_reminders, 3, 0, 20),
    quiet_start_hour: int(o.quiet_start_hour, 22, 0, 23),
    quiet_end_hour: int(o.quiet_end_hour, 8, 0, 23),
  };
}

export type TqRow = {
  id: number; group_id: string; chat_id: number; thread_id: number; tg_user_id: number; student_id: string | null;
  student_name: string; student_username: string | null; first_message_id: number; message_ids: number[];
  text: string; media: Array<{ message_id: number; kind: string }> | null; peer_reply_ids: number[] | null;
  asked_at: string; last_msg_at?: string; status: string; reminder_count?: number;
};

export const TQ_COLUMNS = "id, group_id, chat_id, thread_id, tg_user_id, student_id, student_name, student_username, " +
  "first_message_id, message_ids, text, media, peer_reply_ids, asked_at, last_msg_at, status, reminder_count";

export type TqCallback =
  | { kind: "summary"; gid: string | null }
  | { kind: "list"; bucket: "n" | "o"; page: number; gid: string | null }
  | { kind: "open" | "reply" | "done" | "undo"; id: number };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export function parseTqCallback(data: string): TqCallback | null {
  const d = String(data ?? "");
  let m = new RegExp(`^tq:s(?::(${UUID}))?$`).exec(d);
  if (m) return { kind: "summary", gid: m[1] ?? null };
  m = new RegExp(`^tq:l:([no]):(\\d{1,4})(?::(${UUID}))?$`).exec(d);
  if (m) return { kind: "list", bucket: m[1] as "n" | "o", page: Number(m[2]), gid: m[3] ?? null };
  m = /^tq:([ordu]):(\d{1,12})$/.exec(d);
  if (m) {
    const id = Number(m[2]);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const kind = ({ o: "open", r: "reply", d: "done", u: "undo" } as const)[m[1] as "o" | "r" | "d" | "u"];
    return { kind, id };
  }
  return null;
}

/** New = asked less than `newMin` minutes ago (newest first); waiting = the rest (the longest wait first). */
export function bucketizeTq(rows: TqRow[], nowMs: number, newMin: number) {
  const cut = nowMs - newMin * 60_000;
  const fresh = rows.filter((r) => Date.parse(r.asked_at) >= cut).sort((a, b) => Date.parse(b.asked_at) - Date.parse(a.asked_at));
  const old = rows.filter((r) => Date.parse(r.asked_at) < cut).sort((a, b) => Date.parse(a.asked_at) - Date.parse(b.asked_at));
  return { fresh, old };
}

/** https://t.me/c/<internal>/<thread>/<message> for a supergroup message (null for anything else). */
export function messageLink(chatId: number, threadId: number | null, messageId: number): string | null {
  const s = String(chatId);
  if (!s.startsWith("-100") || !Number.isSafeInteger(messageId) || messageId <= 0) return null;
  const internal = s.slice(4);
  return threadId ? `https://t.me/c/${internal}/${threadId}/${messageId}` : `https://t.me/c/${internal}/${messageId}`;
}

function snippet(text: string, max: number): string {
  const one = String(text ?? "").replace(/\s+/g, " ").trim();
  return one ? `«${escCap(one, max)}»` : "<i>(rasm/fayl)</i>";
}

function whoOf(r: TqRow): string {
  return escCap(r.student_name || (r.student_username ? `@${r.student_username}` : "Oʻquvchi"), 60);
}

/** Group short name for a list line: "AC CHALLENGE | 3-GURUH" → "3-GURUH". */
export function shortGroup(name: string | null | undefined): string {
  const n = String(name ?? "").trim();
  const i = n.lastIndexOf("|");
  return escCap(i >= 0 ? n.slice(i + 1).trim() : n, 40);
}

const gidSuffix = (gid: string | null) => (gid ? `:${gid}` : "");

/** The summary: per bucket counts + the oldest wait, list buttons, and a group filter when there are several groups. */
export function renderTqSummary(
  b: { fresh: TqRow[]; old: TqRow[] }, nowMs: number, s: Pick<TqSettings, "new_min">,
  groups: Array<{ id: string; name: string; open: number }>, gid: string | null, heading = "❓ <b>Kuratorga savollar</b>",
): { text: string; keyboard: Kb } {
  const total = b.fresh.length + b.old.length;
  const scope = gid ? groups.find((g) => g.id === gid)?.name ?? null : null;
  const lines = [`${heading}${scope ? ` · ${shortGroup(scope)}` : groups.length > 1 ? " · barcha guruhlar" : ""}`, ""];
  if (!total) {
    lines.push("✅ Javob kutayotgan savol yoʻq.");
  } else {
    lines.push(`🆕 Yangi (${s.new_min} daqiqagacha): <b>${b.fresh.length}</b>`);
    const oldest = b.old[0];
    lines.push(`⏳ Javob kutmoqda: <b>${b.old.length}</b>${oldest ? ` · eng uzoq kutgani ${ageText(nowMs - Date.parse(oldest.asked_at))}` : ""}`);
    lines.push("", "Savolni oching → «✍️ Javob yozish». Guruhda reply qilib javob bersangiz ham, savol avtomatik yopiladi.");
  }
  const kb: Kb["inline_keyboard"] = [];
  if (total) {
    kb.push([
      { text: `🆕 Yangi (${b.fresh.length})`, callback_data: `tq:l:n:0${gidSuffix(gid)}` },
      { text: `⏳ Kutayotgan (${b.old.length})`, callback_data: `tq:l:o:0${gidSuffix(gid)}` },
    ]);
  }
  if (groups.length > 1) {
    const cells = [{ text: `${gid ? "" : "• "}Hammasi`, callback_data: "tq:s" },
      ...groups.map((g) => ({ text: `${gid === g.id ? "• " : ""}${shortGroup(g.name)} (${g.open})`, callback_data: `tq:s:${g.id}` }))];
    for (let i = 0; i < cells.length; i += 3) kb.push(cells.slice(i, i + 3));
  }
  kb.push([{ text: "🔄 Yangilash", callback_data: `tq:s${gidSuffix(gid)}` }]);
  return { text: lines.join("\n"), keyboard: { inline_keyboard: kb } };
}

/** One page of a bucket: a line per question + a 📂 button each, ◀️ 🔙 ▶️ navigation. */
export function renderTqList(
  bucket: "n" | "o", rows: TqRow[], page: number, nowMs: number, groupNames: Record<string, string>, gid: string | null,
): { text: string; keyboard: Kb } {
  const pages = Math.max(1, Math.ceil(rows.length / TQ_PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = rows.slice(p * TQ_PAGE_SIZE, (p + 1) * TQ_PAGE_SIZE);
  const title = bucket === "n" ? "🆕 <b>Yangi savollar</b>" : "⏳ <b>Javob kutayotgan savollar</b>";
  const lines = [`${title}${pages > 1 ? ` · ${p + 1}/${pages}-sahifa` : ""}`, ""];
  if (!slice.length) lines.push("Hozircha yoʻq ✅");
  const multi = new Set(rows.map((r) => r.group_id)).size > 1;
  for (const r of slice) {
    const peers = (r.peer_reply_ids?.length ?? 0) > 0 ? ` · 💬${r.peer_reply_ids!.length}` : "";
    const files = (r.media?.length ?? 0) > 0 ? ` 📎${r.media!.length}` : "";
    lines.push(`<b>#${r.id}</b> · ${whoOf(r)}${multi ? ` · ${shortGroup(groupNames[r.group_id])}` : ""} · ${ageText(nowMs - Date.parse(r.asked_at))}${peers}`);
    lines.push(`   ${snippet(r.text, 90)}${files}`);
  }
  const kb: Kb["inline_keyboard"] = slice.map((r) => [{
    text: `📂 #${r.id} · ${String(r.student_name || r.student_username || "Oʻquvchi").slice(0, 24)} · ${ageText(nowMs - Date.parse(r.asked_at))}`,
    callback_data: `tq:o:${r.id}`,
  }]);
  const nav: Kb["inline_keyboard"][number] = [];
  if (p > 0) nav.push({ text: "◀️", callback_data: `tq:l:${bucket}:${p - 1}${gidSuffix(gid)}` });
  nav.push({ text: "🔙 Savollar", callback_data: `tq:s${gidSuffix(gid)}` });
  if (p < pages - 1) nav.push({ text: "▶️", callback_data: `tq:l:${bucket}:${p + 1}${gidSuffix(gid)}` });
  kb.push(nav);
  return { text: lines.join("\n"), keyboard: { inline_keyboard: kb } };
}

/** The full question card (HTML, < 4096). */
export function tqCard(r: TqRow, nowMs: number, groupName: string | null): string {
  const who = `${whoOf(r)}${r.student_username ? ` (@${escCap(r.student_username, 40)})` : ""}`;
  const status = r.status === "open" ? `⏳ ${ageText(nowMs - Date.parse(r.asked_at))} dan beri javob kutmoqda`
    : r.status === "answered" ? "✅ javob berilgan" : r.status === "dismissed" ? "☑️ yopilgan" : "⌛️ muddati oʻtgan";
  const peers = (r.peer_reply_ids?.length ?? 0) > 0 ? `\n💬 Guruhdoshlar ${r.peer_reply_ids!.length} marta javob yozgan` : "";
  const files = (r.media?.length ?? 0) > 0 ? `\n📎 ${r.media!.length} ta fayl — pastda` : "";
  const body = r.text ? escCap(r.text, 3000) : "<i>(matnsiz — rasm/fayl)</i>";
  return `❓ <b>Savol #${r.id}</b>${groupName ? ` · ${shortGroup(groupName)}` : ""}\n👤 ${who}\n${status}${peers}\n\n${body}${files}`;
}

export function tqCardKeyboard(r: TqRow): Kb {
  const link = messageLink(r.chat_id, r.thread_id, r.first_message_id);
  const rows: Kb["inline_keyboard"] = [];
  if (r.status === "open") {
    rows.push([{ text: "✍️ Javob yozish", callback_data: `tq:r:${r.id}` }, { text: "✅ Javob berildi", callback_data: `tq:d:${r.id}` }]);
  } else {
    rows.push([{ text: "✍️ Yana javob yozish", callback_data: `tq:r:${r.id}` }]);
  }
  if (link) rows.push([{ text: "🔗 Guruhda koʻrish", url: link }]);
  rows.push([{ text: "🔙 Savollar", callback_data: "tq:s" }]);
  return { inline_keyboard: rows };
}

/** The reminder digest for one teacher: the questions waiting longer than the reminder threshold. */
export function renderTqDigest(rows: TqRow[], nowMs: number, groupNames: Record<string, string>): { text: string; keyboard: Kb } {
  const shown = [...rows].sort((a, b) => Date.parse(a.asked_at) - Date.parse(b.asked_at)).slice(0, TQ_PAGE_SIZE);
  const multi = new Set(rows.map((r) => r.group_id)).size > 1;
  const lines = [`⏳ <b>${rows.length} ta savol javob kutmoqda</b>`, "Oʻquvchilar 1 soatdan beri javob kutyapti:", ""];
  for (const r of shown) {
    lines.push(`<b>#${r.id}</b> · ${whoOf(r)}${multi ? ` · ${shortGroup(groupNames[r.group_id])}` : ""} · ${ageText(nowMs - Date.parse(r.asked_at))}`);
    lines.push(`   ${snippet(r.text, 90)}`);
  }
  if (rows.length > shown.length) lines.push("", `… va yana ${rows.length - shown.length} ta`);
  const kb: Kb["inline_keyboard"] = shown.map((r) => [{
    text: `📂 #${r.id} · ${String(r.student_name || r.student_username || "Oʻquvchi").slice(0, 24)}`,
    callback_data: `tq:o:${r.id}`,
  }]);
  kb.push([{ text: "❓ Barcha savollar", callback_data: "tq:s" }]);
  return { text: lines.join("\n"), keyboard: { inline_keyboard: kb } };
}

/** The answer as posted in the group topic (text answers; media answers carry it as the caption). */
export function tqAnswerHead(): string {
  return "💬 <b>Kurator javobi</b>";
}

/** The DM to the student with the answer (text answers). */
export function tqStudentDm(questionText: string, answerHtml: string, link: string | null): string {
  return `❓ <b>Savolingizga javob keldi</b>\n${snippet(questionText, 160)}\n\n💬 ${answerHtml}` +
    (link ? `\n\n<a href="${link}">Guruhda koʻrish</a>` : "");
}

/** Tashkent (UTC+5, no DST) quiet hours, [start, end) wrapping midnight. */
export function tqQuietHour(nowMs: number, start: number, end: number): boolean {
  const h = new Date(nowMs + 5 * 3_600_000).getUTCHours();
  return start === end ? false : start < end ? h >= start && h < end : h >= start || h < end;
}
