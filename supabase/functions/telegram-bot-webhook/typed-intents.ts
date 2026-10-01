// Typed intents — a student who TYPES instead of tapping gets the right screen, not "use the buttons below"
// (UX review 2026-09-30, quick win #13).
//
// About 20 clear-intent private messages in 30 days got only the generic kbHint, e.g. "uyga vazifa",
// "Men yana qanday vazifalarni qilmaganman", "Давом этамиз", "Курс йук дияптику", "Start". This maps such a
// message to the command its keyboard button would have sent; anything else still gets kbHint (which re-sends
// the keyboard, as before). Students only, private chat only, and only after every other text consumer (a
// grading/teacher session, the name-confirm flow, the keyboard labels) has declined the message — index.ts
// wires it as the last step before kbHint. Pure: typed-intents.test.ts pins every rule.
//
// Order matters (first match wins): homework words beat lesson words ("vazifa darsi" is about homework), and a
// lesson word beats a course word ("kurs darslari" → the next lesson).

export type TypedIntent = "/vazifalar" | "/davom" | "/dars" | "/profil" | "/yordam" | "/start";

/** Longer messages are left alone: a paragraph is a question for a human, not a menu choice. */
export const INTENT_MAX_LEN = 160;

// `(?<!\p{L})` = "at the start of a word" for Latin AND Cyrillic (JS `\b` only knows ASCII letters, so
// /\bдарс/ could never match). Every pattern carries the `u` flag for it.
const RULES: [RegExp, TypedIntent][] = [
  [/(vazifa|вазифа|задани|задач|домашн|домашк|homework|uyga\s*ish|уйга\s*иш)/u, "/vazifalar"],
  [/(davom|давом|продолж|continue|keyingi|кейинги|следующ|(?<!\p{L})dars|(?<!\p{L})дарс|(?<!\p{L})урок|lesson)/u, "/davom"],
  [/(kurs|курс|course|modul|модул|module)/u, "/dars"],
  [/(reyting|рейтинг|rating|(?<!\p{L})ball|(?<!\p{L})балл|o'ri?n|ўри?н|(?<!\p{L})урин|profil|профил|profile|statistik|статистик)/u, "/profil"],
  [/(yordam|ёрдам|помощ|помоги|(?<!\p{L})help(?!\p{L})|(?<!\p{L})admin|(?<!\p{L})админ|support|поддержк)/u, "/yordam"],
];

const START_RE = /^(start|старт|boshla\w*|бошла\w*|начать|menu|menyu|меню)$/;

/** Lower-case, one apostrophe, no emoji/punctuation noise, single spaces. */
export function normalizeIntentText(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[‘’ʻʼ`´]/g, "'")
    .replace(/[^\p{L}\p{N}'\s/]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The command a typed message means, or null (→ kbHint). */
export function typedIntent(text: string): TypedIntent | null {
  if (typeof text !== "string") return null;
  const raw = text.trim();
  if (!raw || raw.length > INTENT_MAX_LEN || raw.startsWith("/")) return null;
  const t = normalizeIntentText(raw);
  if (!t) return null;
  if (START_RE.test(t)) return "/start";
  for (const [re, intent] of RULES) if (re.test(t)) return intent;
  return null;
}
