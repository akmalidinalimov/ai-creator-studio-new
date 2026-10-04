// 📸 Instagram username, set from the BOT (owner request, 2026-10-04).
//
// Before this, the only place to set profiles.instagram_username was the website (Sozlamalar), and
// t.me/<bot>?start=ig only answered with a link to it. 138 of 169 Challenge 6.0 students had no username two
// days before the first Instagram task. The handle is what the Instagram checker matches the screenshot
// against, so a student without one cannot earn Instagram points.
//
// Flow (private chat):
//   /instagram (or /ig), ?start=ig, the reminder DM's button, the 👤 Profil card's 📸 button (ig:set)
//     → start(): shows the current handle (if any) and asks for one; bot_conversation_state = 'awaiting_ig'
//   the student's next plain-text message → capture() → save() → a clear answer, the state cleared
//   A reply-keyboard button or a command while waiting is NOT taken as a username: the state is dropped and
//   the button works as usual.
//
// save() uses the SAME parse rule as the website and the DB (public.instagram_handle_parse), so a handle the
// site refuses is refused here too. The bot writes with the service role, which bypasses two invoker-only
// guards, so it re-applies both itself:
//   * the lock (challenge_task_ig_handle_guard): no change after an ACCEPTED Instagram task, while
//     challenge_tasks.ig.lock_handle_after_accept is on (admins are never locked);
//   * the write is verified: normalize_instagram_username() silently KEEPS the old value on a bad input, so a
//     "saved" is only reported when the row really holds the new handle.
// Every outcome that is not "saved" leaves a DB-visible row (ig_handle_bot_refused) — never alarmed: a typo
// is ordinary member fumbling. A real write failure (ig_handle_bot_save_failed) is a fault.
import { logHealth, logHealthOnce } from "../_shared/edge.ts";

export type Locale = "uz" | "ru" | "en";
export const IG_STATE = "awaiting_ig";
export const IG_STATE_TTL_MS = 15 * 60_000;
export const IG_CALLBACK = "ig:set";

type Db = any;

export type ParseReason = "empty" | "not_profile_link" | "no_handle_in_link" | "too_long" | "bad_chars";
export type SaveOutcome =
  | { kind: "saved"; handle: string }
  | { kind: "same"; handle: string }
  | { kind: "rejected"; reason: ParseReason }
  | { kind: "taken" }
  | { kind: "locked"; handle: string | null }
  | { kind: "error" };

const IG_T: Record<Locale, {
  ask: string;
  askHave: (h: string) => string;
  saved: (h: string) => string;
  same: (h: string) => string;
  taken: string;
  locked: (h: string | null) => string;
  error: string;
  readOnly: string;
  button: string;
  kbButton: string; // the reply keyboard's button (index.ts getMainKeyboard), maps to /instagram
  reasons: Record<ParseReason, string>;
}> = {
  uz: {
    ask: "📸 <b>Instagram username’ingizni yozib yuboring</b> (masalan: @ismingiz).\n\n" +
      "🔎 Qayerdan topasiz: Instagram ilovasi → pastki o‘ngdagi profil belgisi → tepada yozilgan nom.\n\n" +
      "Instagram vazifalari uchun ball aynan shu nom orqali beriladi — skrinshotdagi username bilan solishtiriladi. " +
      "Kurs davomida Instagram’ingiz portfoliongizga aylanadi.",
    askHave: (h) => `📸 Hozirgi Instagram username’ingiz: <b>@${h}</b>\n\n` +
      "O‘zgartirmoqchi bo‘lsangiz — yangi username’ni yozib yuboring (masalan: @ismingiz). O‘zgartirish shart bo‘lmasa, hech narsa yozmang.",
    saved: (h) => `✅ Saqlandi: <b>@${h}</b>\n\nEndi Instagram vazifalarini topshirsangiz bo‘ladi. ` +
      "Kutib turgan Instagram ishlaringiz avtomatik qayta tekshiriladi.",
    same: (h) => `✅ <b>@${h}</b> allaqachon saqlangan — hammasi joyida.`,
    taken: "Bu Instagram nomi boshqa hisobda band. Nom to‘g‘riligini tekshiring yoki kuratoringizga yozing.",
    locked: (h) => `🔒 Instagram username’ingiz${h ? ` (<b>@${h}</b>)` : ""} qulflangan: u bilan Instagram vazifasi allaqachon qabul qilingan. ` +
      "O‘zgartirish kerak bo‘lsa — kuratoringizga yozing.",
    error: "⚠️ Hozir saqlab bo‘lmadi. Birozdan keyin /instagram ni qayta yuboring.",
    readOnly: "👁 Faqat o‘qish rejimi — saqlanmaydi.",
    button: "📸 Instagram",
    kbButton: "📸 Instagram qo‘shish",
    reasons: {
      empty: "Instagram nomini yozing, masalan: @ismingiz",
      not_profile_link: "Bu post yoki reel havolasi, profil emas. Instagram nomingizni yozing, masalan: @ismingiz",
      no_handle_in_link: "Havolada Instagram nomi yo‘q. Nomingizni yozing, masalan: @ismingiz",
      too_long: "Instagram nomi 30 belgidan uzun bo‘lmaydi. Qayta yozing.",
      bad_chars: "Instagram nomida faqat lotin harflari, raqamlar, nuqta (.) va pastki chiziq (_) bo‘ladi. Bo‘sh joy va kirill harflari bo‘lmaydi. Qayta yozing.",
    },
  },
  ru: {
    ask: "📸 <b>Напишите ваш Instagram username</b> (например: @vashe_imya).\n\n" +
      "🔎 Где найти: приложение Instagram → значок профиля справа внизу → имя вверху.\n\n" +
      "Баллы за Instagram-задания начисляются именно по этому имени — оно сверяется с username на скриншоте. " +
      "За время курса ваш Instagram станет вашим портфолио.",
    askHave: (h) => `📸 Ваш текущий Instagram username: <b>@${h}</b>\n\n` +
      "Чтобы изменить — напишите новый username (например: @vashe_imya). Если менять не нужно, ничего не пишите.",
    saved: (h) => `✅ Сохранено: <b>@${h}</b>\n\nТеперь можно сдавать Instagram-задания. ` +
      "Ожидающие Instagram-работы будут перепроверены автоматически.",
    same: (h) => `✅ <b>@${h}</b> уже сохранён — всё в порядке.`,
    taken: "Этот Instagram username уже занят другим аккаунтом. Проверьте имя или напишите куратору.",
    locked: (h) => `🔒 Ваш Instagram username${h ? ` (<b>@${h}</b>)` : ""} закреплён: по нему уже принято Instagram-задание. ` +
      "Если нужно изменить — напишите куратору.",
    error: "⚠️ Сейчас не удалось сохранить. Отправьте /instagram чуть позже.",
    readOnly: "👁 Режим просмотра — не сохраняется.",
    button: "📸 Instagram",
    kbButton: "📸 Добавить Instagram",
    reasons: {
      empty: "Напишите Instagram username, например: @vashe_imya",
      not_profile_link: "Это ссылка на пост или reel, а не на профиль. Напишите ваш username, например: @vashe_imya",
      no_handle_in_link: "В ссылке нет имени профиля. Напишите username, например: @vashe_imya",
      too_long: "Instagram username не длиннее 30 символов. Напишите ещё раз.",
      bad_chars: "В Instagram username только латинские буквы, цифры, точка (.) и подчёркивание (_). Без пробелов и кириллицы. Напишите ещё раз.",
    },
  },
  en: {
    ask: "📸 <b>Send me your Instagram username</b> (for example: @yourname).\n\n" +
      "🔎 Where to find it: the Instagram app → the profile icon at the bottom right → the name at the top.\n\n" +
      "Instagram task points are given by this name — it is matched against the username on your screenshot. " +
      "Over the course your Instagram becomes your portfolio.",
    askHave: (h) => `📸 Your current Instagram username: <b>@${h}</b>\n\n` +
      "To change it, send the new username (for example: @yourname). If nothing needs to change, just don't reply.",
    saved: (h) => `✅ Saved: <b>@${h}</b>\n\nYou can submit Instagram tasks now. ` +
      "Any Instagram work that was waiting is re-checked automatically.",
    same: (h) => `✅ <b>@${h}</b> is already saved — all good.`,
    taken: "This Instagram username belongs to another account. Check the name or message your curator.",
    locked: (h) => `🔒 Your Instagram username${h ? ` (<b>@${h}</b>)` : ""} is locked: an Instagram task was already accepted with it. ` +
      "Message your curator if it has to change.",
    error: "⚠️ Couldn't save right now. Send /instagram again in a moment.",
    readOnly: "👁 Read-only view — not saved.",
    button: "📸 Instagram",
    kbButton: "📸 Add Instagram",
    reasons: {
      empty: "Send your Instagram username, for example: @yourname",
      not_profile_link: "That's a post or reel link, not a profile. Send your username, for example: @yourname",
      no_handle_in_link: "That link has no profile name in it. Send your username, for example: @yourname",
      too_long: "An Instagram username is at most 30 characters. Try again.",
      bad_chars: "An Instagram username has only Latin letters, digits, dot (.) and underscore (_), no spaces or Cyrillic. Try again.",
    },
  },
};

export function igCopy(locale: Locale) {
  return IG_T[locale] ?? IG_T.uz;
}

const REASONS: ParseReason[] = ["empty", "not_profile_link", "no_handle_in_link", "too_long", "bad_chars"];

/** public.instagram_handle_parse() → a handle or a reason. A failed read or an unknown reason → null (caller: error). */
export async function parseHandle(admin: Db, input: string): Promise<{ handle: string } | { reason: ParseReason } | null> {
  const { data, error } = await admin.rpc("instagram_handle_parse", { p_input: input });
  if (error) return null;
  const row = Array.isArray(data) ? data[0] : data;
  const reason = row?.reason ?? null;
  const handle = typeof row?.handle === "string" ? row.handle : null;
  if (reason == null && handle) return { handle };
  if (reason == null && !handle) return { reason: "empty" }; // a blank input never clears a handle from the bot
  return REASONS.includes(reason) ? { reason } : null;
}

/** The lock the invoker trigger applies on the website, re-applied for the service-role write. */
export async function handleLocked(admin: Db, profileId: string): Promise<boolean> {
  const { data: cfg } = await admin.from("platform_settings").select("value").eq("key", "challenge_tasks").maybeSingle();
  const lockOn = (cfg?.value as any)?.ig?.lock_handle_after_accept !== false;
  if (!lockOn) return false;
  const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", profileId).in("role", ["admin", "superadmin"]);
  if (Array.isArray(roles) && roles.length) return false;
  const { data: subs } = await admin.from("challenge_task_submissions")
    .select("id, challenge_tasks!inner(type)")
    .eq("user_id", profileId).eq("status", "accepted").eq("challenge_tasks.type", "instagram").limit(1);
  return Array.isArray(subs) && subs.length > 0;
}

/** Parse, lock-check, write, verify. Never throws. */
export async function saveHandle(admin: Db, profileId: string, input: string): Promise<SaveOutcome> {
  try {
    const parsed = await parseHandle(admin, input);
    if (!parsed) return { kind: "error" };
    if ("reason" in parsed) return { kind: "rejected", reason: parsed.reason };
    const { data: cur, error: curErr } = await admin.from("profiles").select("instagram_username").eq("id", profileId).maybeSingle();
    if (curErr) return { kind: "error" };
    const current = typeof cur?.instagram_username === "string" ? cur.instagram_username.toLowerCase() : null;
    if (current === parsed.handle) return { kind: "same", handle: parsed.handle };
    if (await handleLocked(admin, profileId)) return { kind: "locked", handle: current };
    const { data: rows, error } = await admin.from("profiles")
      .update({ instagram_username: parsed.handle }).eq("id", profileId).select("instagram_username");
    if (error) return String((error as any).code) === "23505" ? { kind: "taken" } : { kind: "error" };
    const stored = Array.isArray(rows) && rows[0] ? String(rows[0].instagram_username ?? "").toLowerCase() : null;
    return stored === parsed.handle ? { kind: "saved", handle: parsed.handle } : { kind: "error" };
  } catch (_e) {
    return { kind: "error" };
  }
}

export type IgDeps = {
  send: (chatId: number, html: string) => Promise<unknown>;
  isMenuButton: (text: string) => boolean; // a reply-keyboard button or typed intent: never a username
};

/** Ask for the handle and wait for the next message. */
export async function startIgFlow(admin: Db, chatId: number, tgId: number, profileId: string, locale: Locale, deps: IgDeps): Promise<void> {
  const c = igCopy(locale);
  let current: string | null = null;
  try {
    const { data } = await admin.from("profiles").select("instagram_username").eq("id", profileId).maybeSingle();
    current = typeof data?.instagram_username === "string" && data.instagram_username ? data.instagram_username : null;
  } catch (_e) { /* the ask still works without the current value */ }
  await admin.from("bot_conversation_state").upsert({
    telegram_id: tgId, state: IG_STATE, context: { profile_id: profileId },
    updated_at: new Date().toISOString(), expires_at: new Date(Date.now() + IG_STATE_TTL_MS).toISOString(),
  });
  await deps.send(chatId, current ? c.askHave(escapeHtml(current)) : c.ask);
}

/** The student's reply while 'awaiting_ig'. true = consumed. */
export async function captureIgReply(
  admin: Db, msg: { chat: { id: number }; from: { id: number } }, profileId: string, locale: Locale, text: string, deps: IgDeps,
): Promise<boolean> {
  const { data: st } = await admin.from("bot_conversation_state")
    .select("state, expires_at, context").eq("telegram_id", msg.from.id).maybeSingle();
  if (st?.state !== IG_STATE) return false;
  const live = st.expires_at && new Date(st.expires_at).getTime() > Date.now();
  const owner = (st.context as any)?.profile_id;
  if (!live || (owner && owner !== profileId)) {
    await admin.from("bot_conversation_state").delete().eq("telegram_id", msg.from.id).eq("state", IG_STATE);
    return false;
  }
  if (deps.isMenuButton(text)) {
    // A menu button is never a username: leave the flow and let the button do its job.
    await admin.from("bot_conversation_state").delete().eq("telegram_id", msg.from.id).eq("state", IG_STATE);
    return false;
  }
  const c = igCopy(locale);
  const out = await saveHandle(admin, profileId, text);
  if (out.kind === "rejected") {
    await deps.send(msg.chat.id, c.reasons[out.reason]); // the state stays: the next message is another try
    await logHealthOnce(admin, "ig_handle_bot_refused", `${profileId}:${out.reason}`, { reason: out.reason }, {
      source: "telegram-bot-webhook", targetUserId: profileId,
    });
    return true;
  }
  await admin.from("bot_conversation_state").delete().eq("telegram_id", msg.from.id).eq("state", IG_STATE);
  if (out.kind === "saved") await deps.send(msg.chat.id, c.saved(escapeHtml(out.handle)));
  else if (out.kind === "same") await deps.send(msg.chat.id, c.same(escapeHtml(out.handle)));
  else if (out.kind === "taken") await deps.send(msg.chat.id, c.taken);
  else if (out.kind === "locked") await deps.send(msg.chat.id, c.locked(out.handle ? escapeHtml(out.handle) : null));
  else await deps.send(msg.chat.id, c.error);
  if (out.kind === "taken" || out.kind === "locked") {
    await logHealthOnce(admin, "ig_handle_bot_refused", `${profileId}:${out.kind}`, { reason: out.kind }, {
      source: "telegram-bot-webhook", targetUserId: profileId,
    });
  } else if (out.kind === "error") {
    await logHealth(admin, "ig_handle_bot_save_failed", { profile_id: profileId }, { source: "telegram-bot-webhook", targetUserId: profileId });
  }
  return true;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
