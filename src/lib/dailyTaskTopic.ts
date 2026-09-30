/**
 * Client-side mirror of the «KUNLIK VAZIFALAR» topic-link rules enforced in SQL by
 * public.challenge_task_parse_topic_url() and trg_groups_extract_daily_task_topic
 * (migration 20260930121000). The DATABASE is the authority -- this only gives the admin an instant,
 * identical message before the save round-trip. Module-topic collisions and the one-group-per-topic
 * UNIQUE index are checked server-side only (their messages come back through mutate()).
 *
 * Pure and dependency-free on purpose: the PGlite harness
 * (supabase/functions/_challenge/testing/daily_topic_check_test.ts) imports it and asserts it parses
 * every fixture exactly like the SQL function does.
 */

export type TopicRef = {
  /** The chat number as written in the URL (no -100 prefix). */
  chat: string;
  /** The Bot API chat id: -100<chat>. */
  chatId: number;
  /** message_thread_id of the forum topic. */
  topic: number;
};

// https?://t.me/c/<chat>/<topic>, /c/<chat>/<topic>/<msg> (the MIDDLE number), optional trailing slash,
// optional query; ?thread=<n> wins over the path. Same pattern and bounds as the SQL helper.
const TOPIC_URL_RE = /^https?:\/\/t\.me\/c\/([1-9][0-9]{0,14})\/([0-9]{1,12})(?:\/([0-9]{1,12}))?\/?(?:\?([^#]*))?$/i;
const THREAD_PARAM_RE = /(?:^|&)thread=([0-9]{1,12})(?:&|$)/;
// The live homework trigger's own reading (groups_extract_homework_topic_id): the first number after the chat.
const HW_LEGACY_RE = /^https?:\/\/t\.me\/c\/\d+\/(\d{1,12})/;

/** SQL btrim(x, E' \t\r\n'): only these four characters. */
function sqlTrim(s: string): string {
  return s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
}

export function parseTopicUrl(url: string | null | undefined): TopicRef | null {
  const m = TOPIC_URL_RE.exec(sqlTrim(url ?? ""));
  if (!m) return null;
  let topic = Number(m[2]);
  const query = m[4] ?? "";
  if (/(^|&)thread=/.test(query)) {
    const t = THREAD_PARAM_RE.exec(query);
    if (!t) return null; // a thread parameter that is not a number: not a topic link
    topic = Number(t[1]);
  }
  return { chat: m[1], chatId: Number(`-100${m[1]}`), topic };
}

export const DAILY_TOPIC_MSG = {
  badFormat: "Kunlik vazifalar topiki havolasi noto‘g‘ri. Namuna: https://t.me/c/4440955972/144",
  general: "Kunlik vazifalar topiki General bo‘la olmaydi",
  homeworkMissing: "Avval «Vazifalar topiki URL»ni kiriting",
  homeworkNotC: "Avval «Vazifalar topiki URL»ni https://t.me/c/… ko‘rinishida kiriting",
  otherChat: "Kunlik vazifalar topiki boshqa guruhga tegishli",
  sameAsHomework: "Kunlik vazifalar topiki uy vazifasi topigi bilan bir xil bo‘lmasin",
  sameAsModule: "Kunlik vazifalar topiki modul topigi bilan bir xil bo‘lmasin",
  takenByOtherGroup: "Bu topik boshqa guruhning «Kunlik vazifalar» topigi sifatida saqlangan",
} as const;

/**
 * The trigger's checks, in the trigger's order. Returns the exact message the database would raise, or
 * null when the pair is acceptable (an empty daily URL is always acceptable: it clears the topic).
 */
export function dailyTopicError(dailyUrl: string | null | undefined, homeworkUrl: string | null | undefined): string | null {
  if (sqlTrim(dailyUrl ?? "") === "") return null;
  const d = parseTopicUrl(dailyUrl);
  if (!d) return DAILY_TOPIC_MSG.badFormat;
  if (d.topic <= 1) return DAILY_TOPIC_MSG.general;
  const hwRaw = sqlTrim(homeworkUrl ?? "");
  if (hwRaw === "") return DAILY_TOPIC_MSG.homeworkMissing;
  const h = parseTopicUrl(hwRaw);
  if (!h) return DAILY_TOPIC_MSG.homeworkNotC;
  if (h.chat !== d.chat) return DAILY_TOPIC_MSG.otherChat; // no leading zeros: equal text <=> equal number
  const legacy = HW_LEGACY_RE.exec(homeworkUrl ?? "");
  if (d.topic === h.topic || (legacy && d.topic === Number(legacy[1]))) return DAILY_TOPIC_MSG.sameAsHomework;
  return null;
}

/** Maps a save error from the groups update to the admin-facing text (the trigger's own text passes through). */
export function dailyTopicSaveMessage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.includes("uq_groups_daily_task_topic")) return DAILY_TOPIC_MSG.takenByOtherGroup;
  return raw;
}
