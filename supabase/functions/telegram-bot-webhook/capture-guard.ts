// WHICH CHAT, WHICH COURSE. The two checks every homework-capture path and every stale student button now
// share (teacher audit 2026-09-30, PR-1).
//
// 1. A homework topic is (chat, thread), never a thread number alone. Telegram numbers forum topics per
//    chat, so the numbers repeat between chats. Live on 2026-09-30: homework topic 7 is the homework topic of
//    1-GURUH PRE 5.0, 2-GURUH VIP 5.0 AND AC CHALLENGE | 4-GURUH (three different chats); 6 is AC CHALLENGE |
//    2-GURUH and 6-GURUH; 8 is 1-GURUH VIP 5.0's homework topic and a Challenge networking topic. The picker
//    compared only `grp.homework_topic_id === threadId`, so a student's photo in ANY chat's topic with their
//    group's number was filed as their homework: 4 real misfiles in August (a 2-GURUH VIP 5.0 student
//    posting in the 1-GURUH PRE 5.0 chat, thread 7). A Challenge chat would have produced 5.0 homework with a
//    5.0 picker posted inside the Challenge chat, and vice versa.
//    The shared topic's chat is the chat of groups.homework_topic_url: groups.homework_topic_id is derived
//    from exactly that URL by trg_groups_extract_homework_topic_id (live body verified 2026-09-30), and the
//    uncaptured_24h detector in hw_dm_health_stats matches the same (chat, thread) pair. A per-module topic
//    (group_module_topics) is in the chat of its own telegram_topic_url, or the group's chat when that URL is
//    not a /c/ link.
//
// 2. A task belongs to exactly one course (homework_assignments → modules.course_id). An old /vazifalar
//    list, an old grade card's 🔁 button or a still-open intent can point at a task of the student's
//    PREVIOUS course after a move. The bot used to reopen that task (start_homework_resubmission first) and
//    file the student's next post onto it, routed to the new group's teachers. Every such entry point now
//    checks the task's course against the student's current course scope first. The scope is the same one
//    /vazifalar and student_assignable_homework use (the current group's published course; enrollments or
//    the default only without a group), supplied by the caller as `courseIdsFor`.
//
// Both refusals are DB-visible (graceful is not silent) and member-forgiving: a friendly sentence, never an
// error, and nothing is recorded for a post in a topic that is not a homework topic (general chat).
import { logHealthOnce } from "../_shared/edge.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

/** The Bot API chat id (-100<digits>) of a private-supergroup link https://t.me/c/<digits>/…; else null. */
export function chatIdFromTelegramUrl(url: string | null | undefined): number | null {
  const m = String(url ?? "").trim().match(/^(?:https?:\/\/)?t\.me\/c\/(\d{1,20})\//i);
  if (!m) return null;
  const id = -Number(`100${m[1]}`);
  return Number.isSafeInteger(id) ? id : null;
}

export interface GroupTopicConfig {
  id: string;
  homework_topic_id: number | string | null;
  homework_topic_url: string | null;
  telegram_group_url?: string | null;
}

export interface ModuleTopicRow {
  module_id: string | null;
  telegram_topic_id: number | string | null;
  telegram_topic_url: string | null;
}

export type OwnHomeworkTopic = { via: "shared" } | { via: "module"; moduleId: string };

function sameNumber(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return false;
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

/**
 * Is (chatId, threadId) a homework topic of `group`? The shared topic must be in the chat of
 * homework_topic_url; a per-module topic in the chat of its own URL (or, when that URL is not a /c/ link,
 * the group's chat). null = not this group's homework topic: another chat, or a non-homework topic.
 */
export function matchOwnHomeworkTopic(
  post: { chatId: number; threadId: number },
  group: GroupTopicConfig,
  moduleTopics: readonly ModuleTopicRow[] = [],
): OwnHomeworkTopic | null {
  const chatId = Number(post.chatId);
  if (!Number.isFinite(chatId)) return null;
  const sharedChat = chatIdFromTelegramUrl(group.homework_topic_url);
  if (sameNumber(group.homework_topic_id, post.threadId) && sharedChat === chatId) return { via: "shared" };
  const groupChats = new Set<number>();
  if (sharedChat != null) groupChats.add(sharedChat);
  const linkChat = chatIdFromTelegramUrl(group.telegram_group_url);
  if (linkChat != null) groupChats.add(linkChat);
  for (const t of moduleTopics) {
    if (!t?.module_id || !sameNumber(t.telegram_topic_id, post.threadId)) continue;
    const topicChat = chatIdFromTelegramUrl(t.telegram_topic_url);
    if (topicChat != null ? topicChat === chatId : groupChats.has(chatId)) return { via: "module", moduleId: t.module_id };
  }
  return null;
}

/** matchOwnHomeworkTopic with the per-module rows read for this thread. Any read error → null (not a match). */
export async function findOwnHomeworkTopic(
  admin: Db, group: GroupTopicConfig, chatId: number, threadId: number,
): Promise<OwnHomeworkTopic | null> {
  const shared = matchOwnHomeworkTopic({ chatId, threadId }, group);
  if (shared) return shared;
  try {
    const { data, error } = await admin.from("group_module_topics")
      .select("module_id, telegram_topic_id, telegram_topic_url")
      .eq("group_id", group.id).eq("telegram_topic_id", threadId);
    if (error) return null;
    return matchOwnHomeworkTopic({ chatId, threadId }, group, (data || []) as ModuleTopicRow[]);
  } catch (_e) {
    return null;
  }
}

/**
 * The groups whose homework topic IS (chatId, threadId), by the same rule. Drives the wrong-topic redirect:
 * it fires only inside ANOTHER group's homework topic, never in that chat's general topics. Any read error
 * → [] (stay silent).
 */
export async function homeworkTopicGroupIds(admin: Db, chatId: number, threadId: number): Promise<string[]> {
  try {
    const stripped = String(chatId).replace(/^-100/, "");
    if (!/^\d+$/.test(stripped)) return [];
    const needle = `%/c/${stripped}/%`; // digits only, so the or-filter cannot be broken out of
    const { data: gs, error } = await admin.from("groups")
      .select("id, homework_topic_id, homework_topic_url, telegram_group_url")
      .or(`homework_topic_url.ilike.${needle},telegram_group_url.ilike.${needle}`);
    if (error) return [];
    const groups = (gs || []) as GroupTopicConfig[];
    if (!groups.length) return [];
    const { data: gmt } = await admin.from("group_module_topics")
      .select("group_id, module_id, telegram_topic_id, telegram_topic_url")
      .in("group_id", groups.map((g) => g.id)).eq("telegram_topic_id", threadId);
    const byGroup = new Map<string, ModuleTopicRow[]>();
    for (const r of (gmt || []) as Array<ModuleTopicRow & { group_id: string }>) {
      byGroup.set(r.group_id, [...(byGroup.get(r.group_id) ?? []), r]);
    }
    return groups.filter((g) => matchOwnHomeworkTopic({ chatId, threadId }, g, byGroup.get(g.id) ?? [])).map((g) => g.id);
  } catch (_e) {
    return [];
  }
}

export type TaskCourseVerdict =
  | { ok: true }
  | { ok: false; taskCourseId: string; currentCourseIds: string[] };

/**
 * A task may be opened / filed only in the student's current course scope. It is refused only on a PROVEN
 * mismatch: an unknown task course, or a student with no course scope at all, keeps the old behaviour
 * (nothing to compare against, and the later capture and tier gates still apply).
 */
export function taskCourseVerdict(
  taskCourseId: string | null | undefined,
  currentCourseIds: readonly (string | null | undefined)[],
): TaskCourseVerdict {
  const scope = currentCourseIds.filter((c): c is string => typeof c === "string" && c.length > 0);
  if (!taskCourseId || scope.length === 0) return { ok: true };
  return scope.includes(taskCourseId) ? { ok: true } : { ok: false, taskCourseId, currentCourseIds: scope };
}

/** The course of a module, or of an assignment's module. null when it cannot be read. */
export async function taskCourseId(admin: Db, ref: { moduleId?: string | null; assignmentId?: string | null }): Promise<string | null> {
  try {
    let moduleId = ref.moduleId ?? null;
    if (!moduleId && ref.assignmentId) {
      const { data: a } = await admin.from("homework_assignments").select("module_id").eq("id", ref.assignmentId).maybeSingle();
      moduleId = a?.module_id ?? null;
    }
    if (!moduleId) return null;
    const { data: m } = await admin.from("modules").select("course_id").eq("id", moduleId).maybeSingle();
    return m?.course_id ?? null;
  } catch (_e) {
    return null;
  }
}

/** The mismatch when the task is outside the student's current course scope; null when it may proceed. */
export async function otherCourseTask(
  admin: Db,
  userId: string,
  ref: { moduleId?: string | null; assignmentId?: string | null },
  courseIdsFor: (userId: string) => Promise<string[]>,
): Promise<{ taskCourseId: string; currentCourseIds: string[] } | null> {
  const course = await taskCourseId(admin, ref);
  if (!course) return null;
  const v = taskCourseVerdict(course, await courseIdsFor(userId));
  return v.ok ? null : { taskCourseId: v.taskCourseId, currentCourseIds: v.currentCourseIds };
}

/** Where a previous-course task was refused. */
// The picker's own refusal (a held post whose student moved course) is a dropped POST, so it is counted in the
// capture family instead: hw_capture_skipped 'pending_other_course' (capture-signals.ts).
// thm:mod is the TEACHER's module drill-down (userId = the teacher; currentCourseIds = the active group's course).
export type OtherCoursePath = "hw:mod" | "hw:start" | "hw:resub_ask" | "hw:resub_yes" | "intent" | "thm:mod";

/**
 * DB-visible row for a refused other-course task: admin_actions 'stale_course_button_refused', one per
 * (path, user, task course, Tashkent day); target_user_id = the student (the teacher for thm:mod). A counter,
 * never alarmed: a moved student tapping an old button is expected member behaviour.
 */
export async function recordOtherCourseRefused(
  admin: Db,
  path: OtherCoursePath,
  userId: string,
  mismatch: { taskCourseId: string; currentCourseIds: string[] },
  extra: Record<string, unknown> = {},
): Promise<void> {
  await logHealthOnce(admin, "stale_course_button_refused", `${path}:${userId}:${mismatch.taskCourseId}`, {
    path, user_id: userId, task_course_id: mismatch.taskCourseId, current_course_ids: mismatch.currentCourseIds, ...extra,
  }, { source: "telegram-bot-webhook", targetUserId: userId });
}

/**
 * tr:mod:<student>:<position>[:<course prefix>] → the module the button meant. The roster lists the modules
 * the student has SUBMISSIONS in, which after a course move span two courses at the same positions, so the
 * position alone is ambiguous: resolve it among the student's own submitted modules, by the course prefix
 * the button carries, else the only candidate, else the current group's course, else the lowest course id
 * (deterministic). null when the student has no submitted module at that position.
 */
export function pickSubmissionModule(
  submitted: readonly { id: string; position: number | null; course_id: string | null }[],
  position: number,
  opts: { coursePrefix?: string | null; currentCourseId?: string | null } = {},
): string | null {
  const byId = new Map<string, { id: string; position: number | null; course_id: string | null }>();
  for (const m of submitted) {
    if (m?.id && Number(m.position ?? 0) === position) byId.set(m.id, m);
  }
  const atPos = [...byId.values()].sort((a, b) => String(a.course_id ?? "").localeCompare(String(b.course_id ?? "")));
  if (!atPos.length) return null;
  const prefix = courseToken(opts.coursePrefix);
  if (prefix) {
    const hit = atPos.filter((m) => courseToken(m.course_id) === prefix);
    if (hit.length === 1) return hit[0].id;
  }
  if (atPos.length === 1) return atPos[0].id;
  const cur = opts.currentCourseId ? atPos.find((m) => m.course_id === opts.currentCourseId) : undefined;
  return (cur ?? atPos[0]).id;
}

/** The course token a tr:mod button carries: 8 hex chars (tr:mod:<36>:<pos>:<8> is at most 55 bytes). */
export function courseToken(courseId: string | null | undefined): string {
  return String(courseId ?? "").replace(/-/g, "").slice(0, 8).toLowerCase();
}
