// QO‘SHIMCHA VAZIFALAR (Challenge 6.0 extra tasks; «KUNLIK VAZIFALAR» until 2026-10-05): the ONE renderer for everything the bot (PR-4) and the worker
// (PR-5) show about a daily-task submission. PURE: no I/O, no clock, no env. The SQL engine decides everything
// (status, points, attribution, which buttons make sense — spec I1); this module only turns the engine's
// payload (challenge_task_payload / challenge_task_card) into Telegram HTML + inline keyboards, so a receipt the
// worker re-renders later is byte-identical to the one the bot sent first ("message is not modified" = success).
//
// Copy: uz is the owner's copy (spec §7.2 + the student flow); ru / en mirror it. Group-visible receipts are
// rendered in uz (a group chat is shared); DMs use the student's locale.
// Buttons (spec §7.4): ASCII callback_data dt:m:<sub>:<task> | dt:x:<sub> | dt:r:<sub>, <= 44 bytes, <= 2 rows.
// Reactions (§7.3): 👍 accepted · 🔥 accepted on time with a streak >= 3 · 👀 checking · ✍ needs_more · 🤔 rejected.
// Never ✅ — it is not a valid Telegram reaction.

export type Locale = "uz" | "ru" | "en";

export interface DtTaskRef {
  id: number;
  date: string; // Tashkent date, YYYY-MM-DD
  day_no?: number | null;
  type?: string | null;
  title?: string | null;
  /** Calendar days from task_date to the day the work was first posted (20261005111000). With grace_days a task can
   *  be ON TIME (late_days 0) on the next day, so the label reads this, not late_days. */
  rel_days?: number | null;
}

export interface DtSubmission {
  id: number;
  status: string;
  reason?: string | null;
  missing?: string[] | null;
  hold_reason?: string | null;
  points?: number | null;
  potential_points?: number | null;
  late_days?: number | null;
  attempts_left?: number | null;
  attributed_via?: string | null;
  moved_count?: number | null;
  receipt_message_id?: number | null;
  receipt_version?: number | null;
  task?: DtTaskRef | null;
}

export interface DtAlternative {
  task_id: number;
  date: string;
  rel: string; // today | yesterday | day_before | earlier (relative to the date the work was FIRST posted)
}

export interface DtPayload {
  status?: string;
  ok?: boolean;
  outcome?: string;
  reason?: string | null;
  user_id?: string | null;
  submission?: DtSubmission | null;
  alternatives?: DtAlternative[] | null;
  streak?: { days?: number | null; milestone_bonus?: number | null } | null;
  reaction?: string | null;
  receipt?: {
    send?: boolean;
    mode?: string;
    carries_welcome?: boolean;
    reply_to_message_id?: number | null;
    receipt_message_id?: number | null;
    version?: number | null;
  } | null;
  hint?: { kind?: string | null; url?: string | null } | null;
  own_topic_url?: string | null;
  from_submission_id?: number | null;
  shaped?: boolean;
  group_id?: string | null;
  resolved_via?: string | null;
}

export type InlineButton = { text: string; callback_data?: string; url?: string };
export type InlineKeyboard = { inline_keyboard: InlineButton[][] };
export interface Rendered {
  text: string;
  keyboard: InlineKeyboard | null;
}

export interface RenderOpts {
  locale?: Locale;
  /** The student's first name (unescaped; this module escapes it). */
  name?: string | null;
  /** Fold the auto-registration welcome into this receipt (G7). */
  welcome?: boolean;
  /** Bot username for t.me/<bot>?start=… buttons (group-safe deep links). Empty = no such button. */
  botUsername?: string | null;
  /** config max_moves_per_submission (default 5): no move buttons once used up. */
  maxMoves?: number;
  /** config max_attempts_per_task (default 3), for the "(3/3)" copy. */
  maxAttempts?: number;
  /** config ig.tag_handle, for the tag-missing copy. */
  tagHandle?: string | null;
}

// Telegram's allowed reaction emoji this feature uses. U+FE0F is stripped before the check ("✍️" → "✍").
export const DAILY_REACTIONS = ["👍", "🔥", "👀", "✍", "🤔"] as const;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** First name, trimmed to 40 chars, HTML-escaped. Empty when unknown. */
export function safeName(name: string | null | undefined): string {
  const first = String(name ?? "").trim().split(/\s+/)[0] ?? "";
  return escapeHtml(first.slice(0, 40));
}

/** A valid reaction from the engine's payload, or null (anything else is dropped — never ✅). */
export function reactionFor(p: DtPayload | null | undefined): string | null {
  const r = String(p?.reaction ?? "").replace(/️/g, "");
  return (DAILY_REACTIONS as readonly string[]).includes(r) ? r : null;
}

const MONTHS: Record<Locale, string[]> = {
  uz: ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"],
  ru: ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"],
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
};

/** "2026-09-30" → "30-sentabr" (uz) / "30 сентября" (ru) / "Sep 30" (en). Unparseable → the input. */
export function formatTaskDate(iso: string | null | undefined, locale: Locale = "uz"): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  if (!m) return String(iso ?? "");
  const day = Number(m[3]);
  const mon = MONTHS[locale][Number(m[2]) - 1];
  if (!mon) return String(iso);
  if (locale === "uz") return `${day}-${mon}`;
  if (locale === "ru") return `${day} ${mon}`;
  return `${mon} ${day}`;
}

// ── Copy ─────────────────────────────────────────────────────────────────────────────────────────────────
type Copy = {
  todayTask: string;
  yesterdayTask: (d: string) => string;
  dateTask: (d: string) => string;
  acceptedOnTime: (label: string, pts: string) => string;
  acceptedLate: (label: string, pts: string) => string;
  points: (n: number) => string;
  streak: (n: number) => string;
  milestone: (n: number) => string;
  heldAiOff: (name: string) => string;
  heldIg: (name: string) => string;
  checking: (label: string) => string;
  needsMore: (label: string, list: string) => string;
  igShare: string;
  igReused: string;
  igOld: string;
  igInvalid: string;
  rejected: (label: string, why: string) => string;
  attemptsLeft: (n: number) => string;
  attemptsNone: string;
  withdrawn: string;
  merged: string;
  expired: (label: string) => string;
  voided: string;
  welcome: (name: string) => string;
  missing: Record<string, string>;
  reasons: Record<string, string>;
  reasonDefault: string;
  tagMissing: (tag: string) => string;
  btnToday: string;
  btnYesterday: string;
  btnDate: (d: string) => string;
  btnNotTask: string;
  btnRestore: string;
  btnIg: string;
  btnBot: string;
  // hints (§7.2)
  held: (name: string) => string;
  wrongGroup: (name: string) => string;
  btnOwnTopic: string;
  beforeOpen: string;
  noOpenTask: string;
  targetClosed: string;
  attemptsExhausted: (max: number) => string;
  // corrections
  okMove: string;
  okWithdraw: string;
  okRestore: string;
  corr: Record<string, string>;
  corrDefault: string;
  // /start dt_<id> card, /start ig
  cardWhere: string;
  cardNotYourGroup: string;
  cardClosed: string;
  cardPaused: string;
  cardStatus: Record<string, string>;
  btnTopic: string;
  cardMissing: string;
  cardUnavailable: string;
  igHave: (h: string) => string;
  igNone: string;
  btnSettings: string;
  // DM media hint (U1) for challenge students
  u1Daily: string;
  btnHwTopic: string;
  btnDailyTopic: string;
};

const UZ: Copy = {
  todayTask: "Bugungi vazifa",
  yesterdayTask: (d) => `Kechagi vazifa (${d})`,
  dateTask: (d) => `${d} vazifasi`,
  acceptedOnTime: (label, pts) => `✅ ${label} qabul qilindi${pts ? `: ${pts}` : ""}.`,
  acceptedLate: (label, pts) => `✅ ${label} uchun qabul qilindi${pts ? `, ${pts} (kechikkan — yarim ball)` : ""}.`,
  points: (n) => `+${n} ball`,
  streak: (n) => `🔥 ${n} ta vazifa ketma-ket`,
  milestone: (n) => `🎉 Seriya bonusi: +${n} ball!`,
  heldAiOff: (name) => `👀 ${name ? `${name}, q` : "Q"}abul qilindi — tekshiruvdan so‘ng ball qo‘shiladi.`,
  heldIg: (name) => `👀 ${name ? `${name}, I` : "I"}nstagram ishingiz qabul qilindi — tekshiruvdan so‘ng ball qo‘shiladi.`,
  checking: (label) => `👀 ${label} tekshirilmoqda… Natija shu xabarda chiqadi.`,
  needsMore: (label, list) => `✍️ ${label} uchun yana kerak: ${list}. Shu topikka yuboring — o‘zi qo‘shiladi.`,
  igShare: "✍️ Bu «share» havolasi. Postni oching → ⋯ → «Havolani nusxalash» orqali olingan havolani yuboring.",
  igReused: "✍️ Bu post havolasi avval ishlatilgan. Shu vazifa uchun yangi post havolasini yuboring.",
  igOld: "🤔 Bu post yaqinda joylanganga o‘xshamaydi. Shu vazifa uchun yangi post joylang.",
  igInvalid: "🤔 Bu Instagram havolasi ochilmadi. Havolani qayta nusxalab yuboring.",
  rejected: (label, why) => `🤔 ${label} qabul qilinmadi: ${why}.`,
  attemptsLeft: (n) => `Tuzatib, yana ${n} marta yuborishingiz mumkin.`,
  attemptsNone: "Bu vazifa uchun urinishlar tugadi. Keyingi vazifada omad!",
  withdrawn: "❌ Bu xabar topshiriq sifatida hisoblanmaydi. Adashib bosgan bo‘lsangiz — «↩️ Qaytarish».",
  merged: "🔗 Bu ish siz tanlagan vazifadagi ishingizga qo‘shildi.",
  expired: (label) => `⌛ ${label} muddati tugadi — ish to‘liq bo‘lmagani uchun hisoblanmadi.`,
  voided: "Bu ish hisobdan chiqarilgan.",
  welcome: (name) => `👋 <b>${name || "Do‘stim"}</b>, siz AI Creators platformasiga qo‘shildingiz (sinov hisobi). Qo‘shimcha vazifalardagi ishlaringiz shu yerda hisoblanadi.`,
  missing: {
    screenshot: "skrinshot", video: "video", file: "fayl", text: "qisqa matn (izoh)", link: "havola",
    ig_link: "Instagram post havolasi", voice: "ovozli xabar", instagram_handle: "Instagram username (botga /instagram deb yozing)",
  },
  reasons: {
    image_seen_before: "bu rasm boshqa o‘quvchining ishida bor",
    image_reused: "bu rasm avvalgi vazifangizda ishlatilgan",
    image_near_duplicate: "bu rasm avval yuborilgan rasmga juda o‘xshaydi",
    ig_link_reused: "bu post havolasi avval ishlatilgan",
    ig_handle_mismatch: "skrinshotdagi Instagram profil ilovadagi username’ingiz bilan mos kelmadi",
    ig_handle_not_visible: "skrinshotda Instagram profil nomi ko‘rinmayapti",
    not_instagram: "skrinshot Instagramdan emas",
    off_task: "ish vazifa mavzusiga mos kelmadi",
    placeholder: "ish bo‘sh yoki namuna ko‘rinadi",
    inappropriate: "nomaqbul kontent",
    secret: "rasmda maxfiy ma’lumot (parol yoki token) ko‘rinadi — uni yashirib qayta yuboring",
    manipulation: "tekshiruvni chetlab o‘tishga urinish aniqlandi",
    admin_override: "admin qaroriga ko‘ra",
  },
  reasonDefault: "vazifa talablariga mos kelmadi",
  tagMissing: (tag) => `postda @${tag} belgilanmagan`,
  btnToday: "📌 Bugungi deb belgilash",
  btnYesterday: "↩️ Kechagi uchun",
  btnDate: (d) => `↩️ ${d} uchun`,
  btnNotTask: "❌ Bu topshiriq emas",
  btnRestore: "↩️ Qaytarish",
  btnIg: "📸 Instagram profil",
  btnBot: "🤖 Botga ulanish",
  held: (name) => `📌 ${name ? `${name}, i` : "I"}shingizni hisoblash uchun profilingiz bu guruhga biriktirilishi kerak. Admin bilan bog‘laning — xabaringiz saqlanib qoladi (24 soat).`,
  wrongGroup: (name) => `📍 ${name ? `${name}, b` : "B"}u boshqa guruhning «Qo‘shimcha vazifalar» topigi. Ishingizni o‘z guruhingiz topigiga yuboring.`,
  btnOwnTopic: "📅 Mening topigim",
  beforeOpen: "⏰ Bugungi vazifa hali e’lon qilinmagan (09:00). Vazifa chiqqach ishingizni shu topikka qayta yuboring.",
  noOpenTask: "📭 Hozir ochiq vazifa yo‘q — bu xabar hisobga olinmadi.",
  targetClosed: "🔒 Bu vazifa yopilgan — muddati o‘tgan vazifaga ish qabul qilinmaydi.",
  attemptsExhausted: (max) => `🤔 Bu vazifa uchun urinishlar tugadi (${max}/${max}). Keyingi vazifada omad!`,
  okMove: "✅ Ko‘chirildi",
  okWithdraw: "❌ Hisobdan chiqarildi. Qaytarish uchun «↩️ Qaytarish».",
  okRestore: "↩️ Qaytarildi",
  corr: {
    not_owner: "Bu boshqa o‘quvchining ishi 🙂",
    not_found: "Bu ish topilmadi.",
    future_task: "Bu vazifa hali ochilmagan.",
    same_task: "Ish allaqachon shu vazifada.",
    bad_target: "Bu vazifaga ko‘chirib bo‘lmaydi.",
    too_many_moves: "Ko‘chirishlar soni tugadi.",
    attempts_exhausted: "Bu vazifa uchun urinishlar tugagan.",
    slot_taken: "Bu vazifada boshqa ishingiz bor — avval uni «Bu topshiriq emas» qiling.",
    not_movable: "Bu ishni endi ko‘chirib bo‘lmaydi.",
    not_withdrawable: "Bu ishni endi o‘zgartirib bo‘lmaydi.",
    not_withdrawn: "Bu ish allaqachon hisobda.",
    rejected_final: "Rad etilgan ishni o‘zgartirib bo‘lmaydi — admin bilan bog‘laning.",
    withdrawn_by_admin: "Bu ishni admin hisobdan chiqargan — admin bilan bog‘laning.",
    closed: "Vazifa yopilgan — endi o‘zgartirib bo‘lmaydi.",
  },
  corrDefault: "Hozircha bo‘lmadi — birozdan so‘ng qayta urinib ko‘ring.",
  cardWhere: "📍 Ishingizni guruhingizdagi «Qo‘shimcha vazifalar» topigiga yuboring (uy vazifasi topigiga emas).",
  cardNotYourGroup: "ℹ️ Bu vazifa sizning guruhingiz uchun emas.",
  cardClosed: "🔒 Bu vazifa yopilgan.",
  cardPaused: "⏳ Ballar hisobi hali yoqilmagan.",
  cardStatus: {
    accepted: "✅ Sizning ishingiz qabul qilingan",
    checking: "👀 Ishingiz tekshirilmoqda",
    needs_more: "✍️ Ishingiz to‘liq emas",
  },
  btnTopic: "📌 Qo‘shimcha vazifalar topigi",
  cardMissing: "🤔 Bu vazifa topilmadi yoki hali tasdiqlanmagan.",
  cardUnavailable: "Hozircha ochib bo‘lmadi — birozdan so‘ng qayta urinib ko‘ring.",
  igHave: (h) => `📸 Instagram profilingiz: <b>@${h}</b>. O‘zgartirish kerak bo‘lsa — Sozlamalar.`,
  igNone: "📸 Instagram vazifalari uchun Instagram username’ingizni profilingizga qo‘shing: Sozlamalar → Instagram.",
  btnSettings: "⚙️ Sozlamalarni ochish",
  u1Daily: "📌 Qo‘shimcha vazifalar esa guruhdagi <b>QO‘SHIMCHA VAZIFALAR</b> topigiga yuboriladi.",
  btnHwTopic: "📚 Uy vazifasi topigi",
  btnDailyTopic: "📌 Qo‘shimcha vazifalar topigi",
};

/** 1 балл · 2–4 балла · 5+ баллов (11–14 → баллов). */
export function ruBall(n: number): string {
  const a = Math.abs(Math.trunc(n));
  const m10 = a % 10;
  const m100 = a % 100;
  if (m10 === 1 && m100 !== 11) return "балл";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "балла";
  return "баллов";
}

const RU: Copy = {
  todayTask: "Сегодняшнее задание",
  yesterdayTask: (d) => `Вчерашнее задание (${d})`,
  dateTask: (d) => `Задание за ${d}`,
  acceptedOnTime: (label, pts) => `✅ ${label} принято${pts ? `: ${pts}` : ""}.`,
  acceptedLate: (label, pts) => `✅ ${label} принято${pts ? `, ${pts} (с опозданием — половина баллов)` : ""}.`,
  points: (n) => `+${n} ${ruBall(n)}`,
  streak: (n) => `🔥 ${n} подряд`,
  milestone: (n) => `🎉 Бонус за серию: +${n} ${ruBall(n)}!`,
  heldAiOff: (name) => `👀 ${name ? `${name}, п` : "П"}ринято — баллы добавятся после проверки.`,
  heldIg: (name) => `👀 ${name ? `${name}, в` : "В"}аша работа в Instagram принята — баллы добавятся после проверки.`,
  checking: (label) => `👀 ${label} проверяется… Результат появится в этом сообщении.`,
  needsMore: (label, list) => `✍️ Для «${label}» ещё нужно: ${list}. Отправьте сюда — добавится само.`,
  igShare: "✍️ Это ссылка «share». Откройте пост → ⋯ → «Копировать ссылку» и отправьте её.",
  igReused: "✍️ Эта ссылка на пост уже использовалась. Отправьте ссылку на новый пост для этого задания.",
  igOld: "🤔 Похоже, этот пост опубликован не недавно. Опубликуйте новый пост для этого задания.",
  igInvalid: "🤔 Ссылка на Instagram не открылась. Скопируйте её заново и отправьте.",
  rejected: (label, why) => `🤔 ${label} не принято: ${why}.`,
  attemptsLeft: (n) => `Исправьте и отправьте ещё раз (осталось попыток: ${n}).`,
  attemptsNone: "Попытки для этого задания закончились. Удачи со следующим!",
  withdrawn: "❌ Это сообщение не считается сдачей. Нажали по ошибке — «↩️ Вернуть».",
  merged: "🔗 Эта работа добавлена к вашей работе в выбранном задании.",
  expired: (label) => `⌛ ${label}: срок истёк — работа была неполной и не засчитана.`,
  voided: "Эта работа аннулирована.",
  welcome: (name) => `👋 <b>${name || "Друг"}</b>, вы добавлены на платформу AI Creators (пробный аккаунт). Ваши работы в «Qo‘shimcha vazifalar» засчитываются здесь.`,
  missing: {
    screenshot: "скриншот", video: "видео", file: "файл", text: "короткий текст (пояснение)", link: "ссылка",
    ig_link: "ссылка на пост в Instagram", voice: "голосовое сообщение", instagram_handle: "Instagram-username (напишите боту /instagram)",
  },
  reasons: {
    image_seen_before: "это изображение уже есть в работе другого студента",
    image_reused: "это изображение уже использовано в вашем прошлом задании",
    image_near_duplicate: "изображение слишком похоже на уже отправленное",
    ig_link_reused: "эта ссылка на пост уже использовалась",
    ig_handle_mismatch: "профиль Instagram на скриншоте не совпадает с вашим username",
    ig_handle_not_visible: "на скриншоте не видно имени профиля Instagram",
    not_instagram: "скриншот не из Instagram",
    off_task: "работа не соответствует теме задания",
    placeholder: "работа пустая или выглядит как шаблон",
    inappropriate: "недопустимый контент",
    secret: "на изображении видны секретные данные (пароль или токен) — скройте их и отправьте снова",
    manipulation: "обнаружена попытка обойти проверку",
    admin_override: "по решению администратора",
  },
  reasonDefault: "не соответствует требованиям задания",
  tagMissing: (tag) => `в посте не отмечен @${tag}`,
  btnToday: "📌 Отметить как сегодняшнее",
  btnYesterday: "↩️ За вчера",
  btnDate: (d) => `↩️ За ${d}`,
  btnNotTask: "❌ Это не сдача",
  btnRestore: "↩️ Вернуть",
  btnIg: "📸 Профиль Instagram",
  btnBot: "🤖 Подключить бота",
  held: (name) => `📌 ${name ? `${name}, ч` : "Ч"}тобы засчитать работу, ваш профиль должен быть привязан к этой группе. Свяжитесь с администратором — сообщение сохранится (24 часа).`,
  wrongGroup: (name) => `📍 ${name ? `${name}, э` : "Э"}то топик «Qo‘shimcha vazifalar» другой группы. Отправьте работу в топик своей группы.`,
  btnOwnTopic: "📅 Мой топик",
  beforeOpen: "⏰ Сегодняшнее задание ещё не опубликовано (09:00). После публикации отправьте работу сюда снова.",
  noOpenTask: "📭 Сейчас нет открытого задания — сообщение не засчитано.",
  targetClosed: "🔒 Это задание закрыто — работы по просроченным заданиям не принимаются.",
  attemptsExhausted: (max) => `🤔 Попытки для этого задания закончились (${max}/${max}). Удачи со следующим!`,
  okMove: "✅ Перенесено",
  okWithdraw: "❌ Не засчитывается. Чтобы вернуть — «↩️ Вернуть».",
  okRestore: "↩️ Возвращено",
  corr: {
    not_owner: "Это работа другого студента 🙂",
    not_found: "Работа не найдена.",
    future_task: "Это задание ещё не открыто.",
    same_task: "Работа уже в этом задании.",
    bad_target: "В это задание перенести нельзя.",
    too_many_moves: "Лимит переносов исчерпан.",
    attempts_exhausted: "Попытки для этого задания закончились.",
    slot_taken: "В этом задании уже есть ваша работа — сначала отметьте её «Это не сдача».",
    not_movable: "Эту работу больше нельзя перенести.",
    not_withdrawable: "Эту работу больше нельзя изменить.",
    not_withdrawn: "Эта работа уже засчитывается.",
    rejected_final: "Отклонённую работу изменить нельзя — свяжитесь с администратором.",
    withdrawn_by_admin: "Эту работу снял администратор — свяжитесь с ним.",
    closed: "Задание закрыто — изменить уже нельзя.",
  },
  corrDefault: "Пока не получилось — попробуйте чуть позже.",
  cardWhere: "📍 Отправьте работу в топик «Qo‘shimcha vazifalar» вашей группы (не в топик домашних заданий).",
  cardNotYourGroup: "ℹ️ Это задание не для вашей группы.",
  cardClosed: "🔒 Это задание закрыто.",
  cardPaused: "⏳ Подсчёт баллов ещё не включён.",
  cardStatus: {
    accepted: "✅ Ваша работа принята",
    checking: "👀 Ваша работа проверяется",
    needs_more: "✍️ Ваша работа неполная",
  },
  btnTopic: "📌 Топик «Qo‘shimcha vazifalar»",
  cardMissing: "🤔 Задание не найдено или ещё не утверждено.",
  cardUnavailable: "Пока не удалось открыть — попробуйте чуть позже.",
  igHave: (h) => `📸 Ваш профиль Instagram: <b>@${h}</b>. Изменить — в Настройках.`,
  igNone: "📸 Для заданий в Instagram добавьте свой username в профиль: Настройки → Instagram.",
  btnSettings: "⚙️ Открыть настройки",
  u1Daily: "📌 А дополнительные задания отправляются в топик <b>QO‘SHIMCHA VAZIFALAR</b> группы.",
  btnHwTopic: "📚 Топик домашних заданий",
  btnDailyTopic: "📌 Топик дополнительных заданий",
};

const EN: Copy = {
  todayTask: "Today's task",
  yesterdayTask: (d) => `Yesterday's task (${d})`,
  dateTask: (d) => `The ${d} task`,
  acceptedOnTime: (label, pts) => `✅ ${label} accepted${pts ? `: ${pts}` : ""}.`,
  acceptedLate: (label, pts) => `✅ ${label} accepted${pts ? `, ${pts} (late — half points)` : ""}.`,
  points: (n) => `+${n} pts`,
  streak: (n) => `🔥 ${n} in a row`,
  milestone: (n) => `🎉 Streak bonus: +${n} pts!`,
  heldAiOff: (name) => `👀 ${name ? `${name}, r` : "R"}eceived — points are added after the check.`,
  heldIg: (name) => `👀 ${name ? `${name}, y` : "Y"}our Instagram work was received — points are added after the check.`,
  checking: (label) => `👀 ${label} is being checked… The result will appear in this message.`,
  needsMore: (label, list) => `✍️ ${label} still needs: ${list}. Send it here — it attaches by itself.`,
  igShare: "✍️ That's a «share» link. Open the post → ⋯ → «Copy link» and send that link.",
  igReused: "✍️ That post link was already used. Send the link to a new post for this task.",
  igOld: "🤔 This post doesn't look recent. Publish a new post for this task.",
  igInvalid: "🤔 That Instagram link didn't open. Copy it again and send it.",
  rejected: (label, why) => `🤔 ${label} was not accepted: ${why}.`,
  attemptsLeft: (n) => `Fix it and send again (${n} attempts left).`,
  attemptsNone: "No attempts left for this task. Good luck with the next one!",
  withdrawn: "❌ This message doesn't count as a submission. Tapped by mistake? «↩️ Undo».",
  merged: "🔗 This work was added to your submission for the task you chose.",
  expired: (label) => `⌛ ${label} closed — the work was incomplete and didn't count.`,
  voided: "This work was voided.",
  welcome: (name) => `👋 <b>${name || "Friend"}</b>, you've been added to the AI Creators platform (trial account). Your extra-task work counts right here.`,
  missing: {
    screenshot: "a screenshot", video: "a video", file: "a file", text: "a short text (caption)", link: "a link",
    ig_link: "the Instagram post link", voice: "a voice message", instagram_handle: "your Instagram username (send /instagram to the bot)",
  },
  reasons: {
    image_seen_before: "this image is already in another student's work",
    image_reused: "this image was used in one of your earlier tasks",
    image_near_duplicate: "this image is too similar to one already sent",
    ig_link_reused: "that post link was already used",
    ig_handle_mismatch: "the Instagram profile in the screenshot doesn't match your username",
    ig_handle_not_visible: "the Instagram profile name isn't visible in the screenshot",
    not_instagram: "the screenshot isn't from Instagram",
    off_task: "the work doesn't match the task",
    placeholder: "the work is empty or looks like a template",
    inappropriate: "inappropriate content",
    secret: "a secret (password or token) is visible — hide it and send again",
    manipulation: "an attempt to bypass the check was detected",
    admin_override: "by an admin's decision",
  },
  reasonDefault: "it doesn't meet the task requirements",
  tagMissing: (tag) => `@${tag} isn't tagged in the post`,
  btnToday: "📌 Mark as today's",
  btnYesterday: "↩️ For yesterday",
  btnDate: (d) => `↩️ For ${d}`,
  btnNotTask: "❌ Not a submission",
  btnRestore: "↩️ Undo",
  btnIg: "📸 Instagram profile",
  btnBot: "🤖 Connect the bot",
  held: (name) => `📌 ${name ? `${name}, t` : "T"}o count your work, your profile must be attached to this group. Please contact an admin — your message is kept (24 hours).`,
  wrongGroup: (name) => `📍 ${name ? `${name}, t` : "T"}his is another group's «Qo‘shimcha vazifalar» topic. Please post your work in your own group's topic.`,
  btnOwnTopic: "📅 My topic",
  beforeOpen: "⏰ Today's task isn't posted yet (09:00). Once it is, send your work here again.",
  noOpenTask: "📭 There's no open task right now — this message didn't count.",
  targetClosed: "🔒 That task is closed — work for past-due tasks isn't accepted.",
  attemptsExhausted: (max) => `🤔 No attempts left for this task (${max}/${max}). Good luck with the next one!`,
  okMove: "✅ Moved",
  okWithdraw: "❌ Doesn't count now. To undo, tap «↩️ Undo».",
  okRestore: "↩️ Restored",
  corr: {
    not_owner: "That's another student's submission 🙂",
    not_found: "That submission wasn't found.",
    future_task: "That task isn't open yet.",
    same_task: "It's already on that task.",
    bad_target: "It can't be moved to that task.",
    too_many_moves: "No moves left.",
    attempts_exhausted: "No attempts left for that task.",
    slot_taken: "You already have work on that task — mark it «Not a submission» first.",
    not_movable: "This work can't be moved any more.",
    not_withdrawable: "This work can't be changed any more.",
    not_withdrawn: "This work already counts.",
    rejected_final: "A rejected submission can't be changed — please contact an admin.",
    withdrawn_by_admin: "An admin removed this work — please contact an admin.",
    closed: "The task is closed — it can't be changed now.",
  },
  corrDefault: "That didn't work right now — please try again shortly.",
  cardWhere: "📍 Post your work in your group's «Qo‘shimcha vazifalar» topic (not the homework topic).",
  cardNotYourGroup: "ℹ️ This task isn't for your group.",
  cardClosed: "🔒 This task is closed.",
  cardPaused: "⏳ Points aren't being counted yet.",
  cardStatus: {
    accepted: "✅ Your work is accepted",
    checking: "👀 Your work is being checked",
    needs_more: "✍️ Your work is incomplete",
  },
  btnTopic: "📌 Extra tasks topic",
  cardMissing: "🤔 That task wasn't found or isn't approved yet.",
  cardUnavailable: "Couldn't open it right now — please try again shortly.",
  igHave: (h) => `📸 Your Instagram profile: <b>@${h}</b>. To change it, open Settings.`,
  igNone: "📸 For Instagram tasks, add your Instagram username to your profile: Settings → Instagram.",
  btnSettings: "⚙️ Open settings",
  u1Daily: "📌 Extra tasks go to the group's <b>QO‘SHIMCHA VAZIFALAR</b> topic.",
  btnHwTopic: "📚 Homework topic",
  btnDailyTopic: "📌 Extra tasks topic",
};

export const DAILY_COPY: Record<Locale, Copy> = { uz: UZ, ru: RU, en: EN };

function copyFor(locale: Locale | undefined): Copy {
  return DAILY_COPY[locale ?? "uz"] ?? UZ;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "Bugungi vazifa" / "Kechagi vazifa (30-sentabr)" / "28-sentabr vazifasi" — relative to the day the work was POSTED. */
export function taskLabel(sub: DtSubmission | null | undefined, locale: Locale = "uz"): string {
  const c = copyFor(locale);
  // rel_days (calendar) when the engine sends it; late_days (days past the deadline) is only a fallback for an older
  // payload — with grace_days a next-day submission is late_days 0 but is not "today's" task.
  const late = num(sub?.task?.rel_days) ?? num(sub?.late_days) ?? 0;
  const d = formatTaskDate(sub?.task?.date ?? "", locale);
  if (late <= 0) return c.todayTask;
  if (late === 1) return c.yesterdayTask(d);
  return c.dateTask(d);
}

/** A t.me link we are willing to put on a button (https only, t.me host). */
export function isTelegramUrl(u: string | null | undefined): u is string {
  return typeof u === "string" && /^https:\/\/t\.me\/[A-Za-z0-9_+/?=&.-]{1,200}$/.test(u.trim());
}

/** t.me/<bot>?start=<param> — the group-safe deep link (spec C10). null when the bot username is unknown. */
export function botStartUrl(botUsername: string | null | undefined, param: string): string | null {
  const u = String(botUsername ?? "").trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{3,64}$/.test(u) || !/^[A-Za-z0-9_-]{1,64}$/.test(param)) return null;
  return `https://t.me/${u}?start=${param}`;
}

// ── Callback data (spec §7.4) ──────────────────────────────────────────────────────────────────────────
export type DtCallback = { op: "m"; sub: number; task: number } | { op: "x"; sub: number } | { op: "r"; sub: number };

export function dtCallbackData(cb: DtCallback): string {
  const s = cb.op === "m" ? `dt:m:${cb.sub}:${cb.task}` : `dt:${cb.op}:${cb.sub}`;
  if (s.length > 44) throw new Error("dt callback_data over 44 bytes");
  return s;
}

/** Strict parser: anything else (a forged or stale shape) is null. */
export function parseDtCallback(data: string | null | undefined): DtCallback | null {
  const s = String(data ?? "");
  let m = /^dt:m:([1-9][0-9]{0,15}):([1-9][0-9]{0,15})$/.exec(s);
  if (m) {
    const sub = Number(m[1]);
    const task = Number(m[2]);
    return Number.isSafeInteger(sub) && Number.isSafeInteger(task) ? { op: "m", sub, task } : null;
  }
  m = /^dt:([xr]):([1-9][0-9]{0,15})$/.exec(s);
  if (m) {
    const sub = Number(m[2]);
    if (!Number.isSafeInteger(sub)) return null;
    return m[1] === "x" ? { op: "x", sub } : { op: "r", sub };
  }
  return null;
}

// ── Receipt ────────────────────────────────────────────────────────────────────────────────────────────
function missingList(missing: string[], c: Copy): string {
  const parts = missing.map((m) => c.missing[m] ?? escapeHtml(m));
  return parts.join(", ");
}

function reasonText(reason: string | null | undefined, c: Copy, tag: string): string {
  const r = String(reason ?? "");
  if (r === "ig_tag_missing") return c.tagMissing(escapeHtml(tag));
  if (c.reasons[r]) return c.reasons[r];
  // An admin's free-text rejection reason (admin_challenge_task_override) is shown as typed, escaped.
  if (/\s/.test(r) && r.length <= 300) return escapeHtml(r.trim());
  return c.reasonDefault;
}

const LIVE = new Set(["needs_more", "checking", "accepted"]);

/** The correction keyboard for a submission (<= 2 rows), or null. */
export function correctionKeyboard(p: DtPayload, opts: RenderOpts = {}): InlineKeyboard | null {
  const c = copyFor(opts.locale);
  const s = p.submission;
  if (!s || !Number.isSafeInteger(Number(s.id))) return null;
  const rows: InlineButton[][] = [];
  if (s.status === "withdrawn") {
    rows.push([{ text: c.btnRestore, callback_data: dtCallbackData({ op: "r", sub: Number(s.id) }) }]);
    return { inline_keyboard: rows };
  }
  if (!LIVE.has(s.status)) return null;
  const maxMoves = opts.maxMoves ?? 5;
  if ((num(s.moved_count) ?? 0) < maxMoves) {
    const moves: InlineButton[] = [];
    for (const a of p.alternatives ?? []) {
      if (moves.length >= 2) break;
      const task = Number(a?.task_id);
      if (!Number.isSafeInteger(task) || task <= 0) continue;
      const label = a.rel === "today" ? c.btnToday
        : a.rel === "yesterday" ? c.btnYesterday
        : a.rel === "day_before" ? c.btnDate(formatTaskDate(a.date, opts.locale ?? "uz"))
        : null;
      if (!label) continue;
      moves.push({ text: label, callback_data: dtCallbackData({ op: "m", sub: Number(s.id), task }) });
    }
    if (moves.length) rows.push(moves);
  }
  const row2: InlineButton[] = [{ text: c.btnNotTask, callback_data: dtCallbackData({ op: "x", sub: Number(s.id) }) }];
  const missing = Array.isArray(s.missing) ? s.missing : [];
  const igUrl = missing.includes("instagram_handle") ? botStartUrl(opts.botUsername, "ig") : null;
  if (igUrl) row2.push({ text: c.btnIg, url: igUrl });
  else if (opts.welcome) {
    // A brand-new auto-registered student: one tap opens the bot (and the task card), which also makes them
    // DM-able for results and reminders.
    const botUrl = botStartUrl(opts.botUsername, `dt_${Number(s.task?.id ?? 0) || 0}`);
    if (botUrl && Number(s.task?.id) > 0) row2.push({ text: c.btnBot, url: botUrl });
  }
  rows.push(row2);
  return { inline_keyboard: rows };
}

/** The receipt a student sees under their work (one per submission, edited as it changes — spec C7). */
export function renderReceipt(p: DtPayload, opts: RenderOpts = {}): Rendered {
  const locale = opts.locale ?? "uz";
  const c = copyFor(locale);
  const s = p.submission;
  const name = safeName(opts.name);
  const lines: string[] = [];
  if (opts.welcome) lines.push(c.welcome(name));
  if (!s) return { text: lines.join("\n") || c.corrDefault, keyboard: null };
  const label = taskLabel(s, locale);
  const late = num(s.late_days) ?? 0;
  const missing = Array.isArray(s.missing) ? s.missing.filter((m) => typeof m === "string") : [];
  const tag = String(opts.tagHandle ?? "aicreators.students").replace(/^@/, "");
  switch (s.status) {
    case "accepted": {
      const n = (num(s.points) ?? 0) > 0 ? num(s.points)! : (num(s.potential_points) ?? 0);
      const pts = n > 0 ? c.points(n) : "";
      lines.push(late <= 0 ? c.acceptedOnTime(label, pts) : c.acceptedLate(label, pts));
      const days = num(p.streak?.days) ?? 0;
      if (late <= 0 && days >= 2) lines.push(c.streak(days));
      const bonus = num(p.streak?.milestone_bonus) ?? 0;
      if (bonus > 0) lines.push(c.milestone(bonus));
      break;
    }
    case "checking":
      if (s.hold_reason === "ai_off") lines.push(c.heldAiOff(name));
      else if (s.hold_reason === "ig_waiting_ai") lines.push(c.heldIg(name));
      else lines.push(c.checking(label));
      break;
    case "needs_more":
      if (s.reason === "ig_link_share") lines.push(c.igShare);
      else if (s.reason === "ig_link_reused") lines.push(c.igReused);
      if (missing.length) lines.push(c.needsMore(label, missingList(missing, c)));
      else if (!s.reason) lines.push(c.needsMore(label, c.missing.text));
      break;
    case "rejected": {
      if (s.reason === "ig_post_old") lines.push(c.igOld);
      else if (s.reason === "ig_link_invalid") lines.push(c.igInvalid);
      else lines.push(c.rejected(label, reasonText(s.reason, c, tag)));
      const left = num(s.attempts_left);
      if (left !== null) lines.push(left > 0 ? c.attemptsLeft(left) : c.attemptsNone);
      break;
    }
    case "withdrawn":
      lines.push(c.withdrawn);
      break;
    case "merged":
      lines.push(c.merged); // date-free: the payload of a merged row names its OLD task, not the one it joined
      break;
    case "expired":
      lines.push(c.expired(label));
      break;
    default:
      lines.push(c.voided);
  }
  return { text: lines.join("\n"), keyboard: correctionKeyboard(p, opts) };
}

/**
 * The tapped receipt of a submission that a move MERGED into the student's other live submission: exactly what
 * renderReceipt shows for a 'merged' row (the worker re-renders it identically — no buttons).
 */
export function renderMergedNote(subId: number, locale: Locale = "uz"): Rendered {
  return renderReceipt({ submission: { id: subId, status: "merged" } }, { locale });
}

// ── Once-a-day hints (spec §7.2) — the engine sets payload.hint only on the first one of the day ─────────
export function renderHint(p: DtPayload, opts: RenderOpts = {}): Rendered | null {
  const c = copyFor(opts.locale);
  const kind = String(p.hint?.kind ?? "");
  const name = safeName(opts.name);
  switch (kind) {
    case "held":
      return { text: c.held(name), keyboard: null }; // NO button: nothing the student can open fixes it (G13)
    case "wrong_group": {
      const url = p.hint?.url ?? p.own_topic_url ?? null;
      return {
        text: c.wrongGroup(name),
        keyboard: isTelegramUrl(url) ? { inline_keyboard: [[{ text: c.btnOwnTopic, url: url.trim() }]] } : null,
      };
    }
    case "no_slot_before_open":
      return { text: c.beforeOpen, keyboard: null };
    case "no_slot_no_open_task":
      return { text: c.noOpenTask, keyboard: null };
    case "no_slot_target_closed":
      return { text: c.targetClosed, keyboard: null };
    case "attempts_exhausted":
      return { text: c.attemptsExhausted(opts.maxAttempts ?? 3), keyboard: null };
    default:
      return null;
  }
}

// ── Correction toasts (answerCallbackQuery, <= 200 chars) ─────────────────────────────────────────────────
export function correctionToast(op: DtCallback["op"], res: { ok?: boolean; reason?: string | null } | null, locale: Locale = "uz"): string {
  const c = copyFor(locale);
  if (res?.ok) return op === "m" ? c.okMove : op === "x" ? c.okWithdraw : c.okRestore;
  return c.corr[String(res?.reason ?? "")] ?? c.corrDefault;
}

// ── /start dt_<id> — the task card in DM (spec §10.5, G14) ───────────────────────────────────────────────
export interface DtCard {
  ok?: boolean;
  reason?: string | null;
  enabled?: boolean;
  task?: DtTaskRef | null;
  text?: string | null; // challenge_task_render_post: Telegram HTML already escaped by SQL
  topic_url?: string | null;
  closed?: boolean;
  submission?: { id?: number; status?: string; points?: number | null; missing?: string[] | null } | null;
}

export const TELEGRAM_TEXT_MAX = 4096;

/** The card as one message, or two when the post plus the status lines would pass Telegram's 4096 limit. */
export function renderCard(card: DtCard | null | undefined, locale: Locale = "uz"): Rendered[] {
  const c = copyFor(locale);
  if (!card?.ok || !card.text) return [{ text: c.cardMissing, keyboard: null }];
  const extra: string[] = [];
  const st = card.submission?.status ?? "";
  if (c.cardStatus[st]) {
    const pts = num(card.submission?.points) ?? 0;
    extra.push(st === "accepted" && pts > 0 ? `${c.cardStatus[st]}: ${c.points(pts)}.` : `${c.cardStatus[st]}.`);
  }
  if (card.closed) extra.push(c.cardClosed);
  else if (card.topic_url) extra.push(c.cardWhere);
  else extra.push(c.cardNotYourGroup);
  if (card.enabled === false) extra.push(c.cardPaused);
  const keyboard = !card.closed && isTelegramUrl(card.topic_url)
    ? { inline_keyboard: [[{ text: c.btnTopic, url: card.topic_url.trim() }]] }
    : null;
  const tail = extra.join("\n");
  const one = `${card.text}\n\n${tail}`;
  if (one.length <= TELEGRAM_TEXT_MAX) return [{ text: one, keyboard }];
  return [{ text: card.text.slice(0, TELEGRAM_TEXT_MAX), keyboard: null }, { text: tail, keyboard }];
}

/** A friendly "could not open it now" (the card RPC failed; the failure itself is recorded by the caller). */
export function renderUnavailable(locale: Locale = "uz"): Rendered {
  return { text: copyFor(locale).cardUnavailable, keyboard: null };
}

/** /start ig — where to set the Instagram handle (the app's Settings; the handle is locked after a paid IG task). */
export function renderIgStart(handle: string | null | undefined, settingsUrl: string | null, locale: Locale = "uz"): Rendered {
  const c = copyFor(locale);
  const h = String(handle ?? "").trim().replace(/^@/, "");
  const text = h ? c.igHave(escapeHtml(h.slice(0, 64))) : c.igNone;
  const keyboard = settingsUrl && /^https:\/\//.test(settingsUrl)
    ? { inline_keyboard: [[{ text: c.btnSettings, url: settingsUrl }]] }
    : null;
  return { text, keyboard };
}

/** /start argument → what it asks for. */
export function parseDailyStartArg(arg: string | null | undefined): { kind: "task"; taskId: number } | { kind: "ig" } | null {
  const a = String(arg ?? "").trim();
  if (a === "ig") return { kind: "ig" };
  const m = /^dt_([1-9][0-9]{0,11})$/.exec(a);
  if (m) return { kind: "task", taskId: Number(m[1]) };
  return null;
}
