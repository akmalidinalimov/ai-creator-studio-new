// Walking a Challenge week TASK BY TASK in the admins' DM (owner's request, 2026-10-01).
//
// The weekly ask (PR-9) approves a whole week with one ✅. This adds the other way round: one message
// per task, each with [✅ Tasdiqlash] and [✏️ O‘zgartirish].
//
//   dtt:l:<yyyymmdd>  📋 list the week, one message per task (from the ask message's new button)
//   dtt:a:<id>        ✅ approve THAT task        -> challenge_tasks_approve_task(id, actor)
//   dtt:c:<id>        ✏️ change its text          -> asks for a reply, stores TASK_BODY_STATE
//   dtt:x:<id>        ↩️ cancel the change        -> clears the state, re-renders the card
//
// challenge_tasks.id is a bigint, so every callback_data here is ~12 bytes — far inside Telegram's 64.
//
// Everything is pure except the two thin DB calls the webhook passes in: this module renders and
// parses, the webhook owns the admin check (the real clicker's persona, impersonation refused) and the
// RPCs own the rules (admin gate, the approval guard, past days, the post-length limit).
//
// NOT changed from the bot: the title, type, points and required submission. The prompt says so, and
// the calendar (Admin → Kunlik vazifalar) remains the full editor.

export const TASK_BODY_STATE = "dt_task_body";
/** A reply is captured for this long after ✏️ (the same 10 minutes the name flow uses). */
export const TASK_BODY_TTL_MS = 10 * 60_000;

export type Locale = "uz" | "ru" | "en";

export type TaskCb =
  | { kind: "list"; week: string }
  | { kind: "approve" | "change" | "cancel"; taskId: number };

/** Strict parser: anything else is not ours. Never throws. */
export function parseTaskCardCb(data: string): TaskCb | null {
  const l = /^dtt:l:(\d{8})$/.exec(data);
  if (l) return { kind: "list", week: `${l[1].slice(0, 4)}-${l[1].slice(4, 6)}-${l[1].slice(6, 8)}` };
  const m = /^dtt:([acx]):(\d{1,18})$/.exec(data);
  if (!m) return null;
  const taskId = Number(m[2]);
  if (!Number.isSafeInteger(taskId) || taskId <= 0) return null;
  return { kind: m[1] === "a" ? "approve" : m[1] === "c" ? "change" : "cancel", taskId };
}

/** yyyymmdd for a Monday, for the list button's callback_data. */
export function weekCb(weekStart: string): string {
  return `dtt:l:${weekStart.replace(/-/g, "")}`;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const MONTHS: Record<Locale, string[]> = {
  uz: ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"],
  ru: ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"],
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
};
const WEEKDAYS: Record<Locale, string[]> = {
  uz: ["dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba", "yakshanba"],
  ru: ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"],
  en: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
};

/** "5-oktabr (dushanba)" / "5 октября (понедельник)" / "5 October (Monday)". */
export function dayLabel(date: string, weekday: number, locale: Locale): string {
  const [, mm, dd] = date.split("-");
  const day = Number(dd);
  const month = MONTHS[locale][Number(mm) - 1] ?? mm;
  const wd = WEEKDAYS[locale][Math.min(Math.max(weekday, 1), 7) - 1] ?? "";
  if (locale === "uz") return `${day}-${month} (${wd})`;
  return `${day} ${month} (${wd})`;
}

const TXT = {
  uz: {
    kindGeneral: "📝 umumiy", kindInstagram: "📸 Instagram", points: "ball",
    draft: "QORALAMA — hali e'lon qilinmaydi", approved: "✅ tasdiqlangan", cancelled: "🚫 bekor qilingan",
    past: "⌛ o‘tgan kun", posted: "📣 e'lon qilingan",
    submit: "Topshirish", minutes: "daqiqa",
    btnApprove: "✅ Tasdiqlash", btnChange: "✏️ O‘zgartirish", btnCancel: "↩️ Bekor qilish",
    askBody: "✏️ Yangi matnni shu yerga yuboring (oddiy xabar sifatida).\n\nFaqat vazifa matni o‘zgaradi — sarlavha, tur, ball va topshirish talabi o‘zgarmaydi. Boshqasini o‘zgartirish uchun: Admin → Kunlik vazifalar.\n\nBekor qilish uchun «↩️ Bekor qilish».",
    savedBody: "✅ Matn yangilandi.",
    approvedOk: "✅ Tasdiqlandi.",
    alreadyApproved: "Bu vazifa allaqachon tasdiqlangan.",
    pastDay: "⌛ O‘tgan kun — tasdiqlanmadi. Kerak bo‘lsa, kalendarda alohida (retro) tasdiqlang.",
    notFound: "Vazifa topilmadi.",
    tooLong: "Matn juda uzun — bitta Telegram xabariga sig‘maydi. Qisqartirib qayta yuboring.",
    empty: "Bo‘sh matn — o‘zgarmadi.",
    cancelled2: "Bu vazifa bekor qilingan — matnini o‘zgartirib bo‘lmaydi.",
    refused: "O‘zgartirib bo‘lmadi",
    noTasks: "Bu haftada vazifa yo‘q.",
    header: (n: number, week: string) => `📋 <b>${week}</b> — ${n} ta vazifa. Har birini alohida ko‘rib chiqing:`,
    changeCancelled: "↩️ O‘zgartirish bekor qilindi.",
    expired: "⏳ Vaqt tugadi — «✏️ O‘zgartirish»ni qayta bosing.",
  },
  ru: {
    kindGeneral: "📝 обычное", kindInstagram: "📸 Instagram", points: "балл(ов)",
    draft: "ЧЕРНОВИК — пока не публикуется", approved: "✅ подтверждено", cancelled: "🚫 отменено",
    past: "⌛ прошедший день", posted: "📣 опубликовано",
    submit: "Сдать", minutes: "мин",
    btnApprove: "✅ Подтвердить", btnChange: "✏️ Изменить", btnCancel: "↩️ Отмена",
    askBody: "✏️ Пришлите новый текст сюда обычным сообщением.\n\nИзменится только текст задания — название, тип, баллы и требование к сдаче останутся как есть. Остальное: Admin → Kunlik vazifalar.\n\nЧтобы отменить — «↩️ Отмена».",
    savedBody: "✅ Текст обновлён.",
    approvedOk: "✅ Подтверждено.",
    alreadyApproved: "Это задание уже подтверждено.",
    pastDay: "⌛ Прошедший день — не подтверждено. Если нужно, подтвердите отдельно в календаре.",
    notFound: "Задание не найдено.",
    tooLong: "Текст слишком длинный — не вмещается в одно сообщение Telegram. Сократите и пришлите снова.",
    empty: "Пустой текст — ничего не изменилось.",
    cancelled2: "Задание отменено — текст изменить нельзя.",
    refused: "Не удалось изменить",
    noTasks: "На этой неделе заданий нет.",
    header: (n: number, week: string) => `📋 <b>${week}</b> — ${n} задан. Проверьте каждое:`,
    changeCancelled: "↩️ Изменение отменено.",
    expired: "⏳ Время вышло — нажмите «✏️ Изменить» снова.",
  },
  en: {
    kindGeneral: "📝 general", kindInstagram: "📸 Instagram", points: "pts",
    draft: "DRAFT — not posted yet", approved: "✅ approved", cancelled: "🚫 cancelled",
    past: "⌛ past day", posted: "📣 posted",
    submit: "Submit", minutes: "min",
    btnApprove: "✅ Approve", btnChange: "✏️ Change", btnCancel: "↩️ Cancel",
    askBody: "✏️ Send the new text here as a normal message.\n\nOnly the task text changes — the title, type, points and required submission stay as they are. For anything else: Admin → Kunlik vazifalar.\n\nTo cancel, tap «↩️ Cancel».",
    savedBody: "✅ Text updated.",
    approvedOk: "✅ Approved.",
    alreadyApproved: "This task is already approved.",
    pastDay: "⌛ Past day — not approved. Approve it separately in the calendar if you need to.",
    notFound: "Task not found.",
    tooLong: "Too long for one Telegram message. Shorten it and send again.",
    empty: "Empty text — nothing changed.",
    cancelled2: "This task is cancelled — its text cannot be changed.",
    refused: "Could not change it",
    noTasks: "No tasks this week.",
    header: (n: number, week: string) => `📋 <b>${week}</b> — ${n} task(s). Review each one:`,
    changeCancelled: "↩️ Change cancelled.",
    expired: "⏳ Timed out — tap «✏️ Change» again.",
  },
} as const;

export function taskCardTexts(locale: Locale) {
  return TXT[locale] ?? TXT.uz;
}

export type TaskCard = {
  ok?: boolean;
  task_id?: number;
  date?: string;
  weekday?: number;
  title?: string;
  body?: string;
  submit_hint?: string | null;
  type?: string;
  points?: number | null;
  minutes?: number | null;
  status?: string;
  past?: boolean;
  posted?: boolean;
};

/**
 * One task as a message. A DRAFT dated today or later gets both buttons; an approved or past task
 * never gets ✅ (the RPC would refuse it anyway, and a button that always fails is worse than no
 * button); a cancelled task gets none.
 */
export function renderTaskCard(
  card: TaskCard,
  locale: Locale,
  opts: { editing?: boolean; note?: string | null } = {},
): { text: string; keyboard: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } } {
  const t = taskCardTexts(locale);
  const id = Number(card.task_id);
  const kind = card.type === "instagram" ? t.kindInstagram : t.kindGeneral;
  const head = [
    `📅 <b>${esc(dayLabel(String(card.date ?? ""), Number(card.weekday ?? 1), locale))}</b>`,
    kind,
    `⭐️ ${Number(card.points ?? 0)} ${t.points}`,
    card.minutes ? `⏱ ${Number(card.minutes)} ${t.minutes}` : null,
  ].filter(Boolean).join(" · ");

  const status = card.status === "approved"
    ? (card.posted ? `${t.approved} · ${t.posted}` : t.approved)
    : card.status === "cancelled"
    ? t.cancelled
    : t.draft;

  const lines = [
    head,
    "",
    `<b>${esc(card.title)}</b>`,
    "",
    esc(card.body),
  ];
  if (card.submit_hint) lines.push("", `<i>${esc(card.submit_hint)}</i>`);
  lines.push("", `${card.past ? `${t.past} · ` : ""}${status}`);
  if (opts.note) lines.push("", esc(opts.note));
  if (opts.editing) lines.push("", t.askBody);

  const row: Array<{ text: string; callback_data: string }> = [];
  if (opts.editing) {
    row.push({ text: t.btnCancel, callback_data: `dtt:x:${id}` });
  } else {
    if (card.status === "draft" && !card.past) row.push({ text: t.btnApprove, callback_data: `dtt:a:${id}` });
    if (card.status !== "cancelled") row.push({ text: t.btnChange, callback_data: `dtt:c:${id}` });
  }
  return { text: lines.join("\n").slice(0, 4000), keyboard: { inline_keyboard: row.length ? [row] : [] } };
}

/** The reason text for a refusal the RPCs report as data (never an exception). */
export function refusalText(reason: string | null | undefined, locale: Locale, extra?: { error?: string | null }): string {
  const t = taskCardTexts(locale);
  switch (reason) {
    case "not_found": return t.notFound;
    case "past_day": return t.pastDay;
    case "empty": return t.empty;
    case "too_long":
    case "post_too_long": return t.tooLong;
    case "cancelled": return t.cancelled2;
    case "not_draft": return t.alreadyApproved;
    default: return `${t.refused}${extra?.error ? `: ${extra.error}` : ""}`;
  }
}
