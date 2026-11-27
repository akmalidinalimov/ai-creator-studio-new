// MULTI-COURSE STUDENTS in the bot (PR 3a of 4, student side).
//
// A student keeps ONE main group (profiles.group_id): rating, boards, reminders and group posts stay there. Since
// PR 1 (20261127143100) public.student_course_groups also holds their SECONDARY courses, one group per course
// (is_main = false). This file is the bot's one reading of that table, so every student screen agrees:
//
//   - courseScopeIds()      the courses they STUDY: the main group's course (published) first, then each published
//                           secondary course. Feeds /dars, /davom, /vazifalar, stats (index.ts getStudentCourseScope).
//   - taskScopeIds()        the courses whose TASKS they may open / file: main ∪ secondary, published or not (the
//                           group decides the topic and the teachers, as PR-1's currentCourseScope always did).
//                           Every other course is still a "previous course" and refused exactly as before.
//   - groupForTaskCourse()  the group a task's homework belongs to: the secondary group of that course, else the
//                           main group — the same rule as SQL student_group_for_course (PR 2).
//   - pickCaptureGroup()    which of the student's secondary groups owns a (chat, thread) homework topic.
//   - auto-add              ONLY for the courses in platform_settings 'multi_course'.auto_add_course_ids (missing /
//                           malformed = none): a registered non-staff student posting in such a course's homework
//                           topic, or found (throttled getChatMember) in its chats, is added through the SQL engine
//                           add_student_course_group, which audits every add (admin_actions student_course_added).
//
// A student with no secondary course gets exactly the single-course answers every function had before.

// deno-lint-ignore no-explicit-any
type Db = any;

export type CourseGroup = { group_id: string; course_id: string; published: boolean };

export type StudentCourseGroups = {
  /** profiles.group_id and its course (course_id null for a course-less group). null = no main group. */
  main: { group_id: string; course_id: string | null; published: boolean } | null;
  /** Secondary courses (student_course_groups, is_main = false), never the main course. */
  secondary: CourseGroup[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function publishedOf(row: unknown): boolean {
  // deno-lint-ignore no-explicit-any
  const c = (row as any)?.courses;
  return (Array.isArray(c) ? c[0]?.published : c?.published) === true;
}

/** The student's main group (+ its course) and secondary course groups. A failed secondary read = none. */
export async function loadStudentCourseGroups(admin: Db, userId: string): Promise<StudentCourseGroups> {
  const [profRes, secRes] = await Promise.all([
    admin.from("profiles").select("group_id").eq("id", userId).maybeSingle(),
    admin.from("student_course_groups").select("course_id, group_id, courses(published)")
      .eq("user_id", userId).eq("is_main", false),
  ]);
  const gid: string | null = profRes?.data?.group_id ?? null;
  let main: StudentCourseGroups["main"] = null;
  if (gid) {
    const { data: g } = await admin.from("groups").select("course_id, courses(published)").eq("id", gid).maybeSingle();
    main = { group_id: gid, course_id: g?.course_id ?? null, published: publishedOf(g) };
  }
  const secondary: CourseGroup[] = [];
  if (!secRes?.error) {
    for (const r of (secRes?.data || []) as unknown[]) {
      // deno-lint-ignore no-explicit-any
      const row = r as any;
      if (!row?.course_id || !row?.group_id) continue;
      if (main?.course_id && row.course_id === main.course_id) continue; // never the main course twice
      if (secondary.some((s) => s.course_id === row.course_id)) continue;
      secondary.push({ group_id: String(row.group_id), course_id: String(row.course_id), published: publishedOf(row) });
    }
  }
  return { main, secondary };
}

/** Courses the student studies: the main course if published, then each published secondary course. */
export function courseScopeIds(sc: StudentCourseGroups): string[] {
  const out: string[] = [];
  if (sc.main?.course_id && sc.main.published) out.push(sc.main.course_id);
  for (const s of sc.secondary) if (s.published && !out.includes(s.course_id)) out.push(s.course_id);
  return out;
}

/** Courses whose tasks the student may open / file: main ∪ secondary, published or not. */
export function taskScopeIds(sc: StudentCourseGroups): string[] {
  const out: string[] = [];
  if (sc.main?.course_id) out.push(sc.main.course_id);
  for (const s of sc.secondary) if (!out.includes(s.course_id)) out.push(s.course_id);
  return out;
}

/** The group a task of `taskCourseId` belongs to: that course's secondary group, else the main group. */
export function groupForTaskCourse(taskCourseId: string | null | undefined, sc: StudentCourseGroups): string | null {
  if (taskCourseId) {
    const s = sc.secondary.find((x) => x.course_id === taskCourseId);
    if (s) return s.group_id;
  }
  return sc.main?.group_id ?? null;
}

/** Among the student's secondary groups, the one whose homework topic is this (chat, thread) (topicGroupIds). */
export function pickCaptureGroup(topicGroupIds: readonly string[], secondary: readonly CourseGroup[]): CourseGroup | null {
  const ids = new Set(topicGroupIds.map(String));
  return secondary.find((s) => ids.has(s.group_id)) ?? null;
}

// ── auto-add ──

/** platform_settings 'multi_course'.value → the auto-add course ids. Missing / malformed = [] (no auto-add). */
export function parseAutoAddConfig(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const raw = (value as Record<string, unknown>).auto_add_course_ids;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && UUID_RE.test(v.trim()) && !out.includes(v.trim().toLowerCase())) out.push(v.trim().toLowerCase());
  }
  return out;
}

const CFG_TTL_MS = 5 * 60_000;
let __cfg: { at: number; ids: string[] } | null = null;

/** The auto-add course ids, cached 5 min per isolate. A read error = [] (fail closed: no auto-add). */
export async function loadAutoAddCourseIds(admin: Db): Promise<string[]> {
  if (__cfg && Date.now() - __cfg.at < CFG_TTL_MS) return __cfg.ids;
  let ids: string[] = [];
  try {
    const { data, error } = await admin.from("platform_settings").select("value").eq("key", "multi_course").maybeSingle();
    ids = error ? [] : parseAutoAddConfig(data?.value);
  } catch (_e) {
    ids = [];
  }
  __cfg = { at: Date.now(), ids };
  return ids;
}

/** Tests only. */
export function _resetAutoAddCache(): void {
  __cfg = null;
}

export type CourseMeta = { id: string; published: boolean; channel_group_id: string | null; telegram_channel_chat_id?: string | number | null };

/**
 * Group-topic auto-add: among the groups whose homework topic the student just posted in, the ONE group to add
 * them to. Only a published course in `autoAdd`, never a course's channel holding group, and only when that course
 * is not theirs yet — or theirs only through its holding group (they joined the channel first; posting homework in
 * the real group's topic moves them there). Ambiguous (two candidate groups) = null.
 */
export function autoAddTopicCandidate(
  topicGroups: readonly { id: string; course_id: string | null }[],
  autoAdd: readonly string[],
  courses: readonly CourseMeta[],
  sc: StudentCourseGroups,
): { group_id: string; course_id: string } | null {
  const allow = new Set(autoAdd.map((c) => c.toLowerCase()));
  const meta = new Map(courses.map((c) => [String(c.id).toLowerCase(), c]));
  const cands = new Map<string, { group_id: string; course_id: string }>();
  for (const g of topicGroups) {
    const cid = String(g.course_id ?? "").toLowerCase();
    if (!cid || !allow.has(cid)) continue;
    const c = meta.get(cid);
    if (!c || !c.published) continue;
    if (c.channel_group_id && c.channel_group_id === g.id) continue; // the holding group is filled via the channel
    if (sc.main?.course_id && sc.main.course_id.toLowerCase() === cid) continue; // their main course: a move, never here
    const sec = sc.secondary.find((s) => s.course_id.toLowerCase() === cid);
    if (sec && !(c.channel_group_id && sec.group_id === c.channel_group_id)) continue; // already in a real group of it
    cands.set(g.id, { group_id: g.id, course_id: String(g.course_id) });
  }
  return cands.size === 1 ? [...cands.values()][0] : null;
}

export type ProbeTarget = { chatId: number; courseId: string; groupIds: string[]; channel: boolean };

const chatOf = (url: string | null | undefined): number | null => {
  const m = /\/c\/(\d{1,20})\//.exec(String(url ?? ""));
  if (!m) return null;
  const id = -Number(`100${m[1]}`);
  return Number.isSafeInteger(id) ? id : null;
};

/**
 * DM auto-add: the chats to probe for the auto-add courses the student is NOT in (none at all when they are in
 * every one). A course's channel (telegram_channel_chat_id → its holding group) and each real group's chat (the
 * /c/<id>/ of homework_topic_url / telegram_group_url, as resolveMembershipGroup reads them). Published courses only.
 */
export function autoAddProbeTargets(
  autoAdd: readonly string[],
  sc: StudentCourseGroups,
  courses: readonly CourseMeta[],
  groups: readonly { id: string; course_id: string | null; homework_topic_url?: string | null; telegram_group_url?: string | null }[],
): ProbeTarget[] {
  const mine = new Set(taskScopeIds(sc).map((c) => c.toLowerCase()));
  const missing = new Set(autoAdd.map((c) => c.toLowerCase()).filter((c) => !mine.has(c)));
  if (!missing.size) return [];
  const out = new Map<string, ProbeTarget>();
  const holding = new Set(courses.map((c) => c.channel_group_id).filter(Boolean) as string[]);
  for (const c of courses) {
    const cid = String(c.id).toLowerCase();
    if (!missing.has(cid) || !c.published) continue;
    for (const g of groups) {
      if (String(g.course_id ?? "").toLowerCase() !== cid || holding.has(g.id)) continue;
      for (const url of [g.homework_topic_url, g.telegram_group_url]) {
        const chat = chatOf(url);
        if (chat == null) continue;
        const k = `${chat}:${cid}`;
        const t = out.get(k) ?? { chatId: chat, courseId: String(c.id), groupIds: [], channel: false };
        if (!t.groupIds.includes(g.id)) t.groupIds.push(g.id);
        out.set(k, t);
      }
    }
    const ch = String(c.telegram_channel_chat_id ?? "");
    if (c.channel_group_id && /^-100\d+$/.test(ch)) {
      const k = `${ch}:${cid}`;
      if (!out.has(k)) out.set(k, { chatId: Number(ch), courseId: String(c.id), groupIds: [], channel: true });
    }
  }
  return [...out.values()];
}

/**
 * After the probes: per course, the group to add. A real group chat the student is in wins (one group per chat
 * listed → that group; several groups behind one chat → the first one listed, the caller orders them); else the
 * course's channel → its holding group. Courses with no hit get nothing.
 */
export function chooseAutoAddGroups(
  hits: readonly ProbeTarget[],
  courses: readonly CourseMeta[],
): { course_id: string; group_id: string; via: "group" | "channel" }[] {
  const out: { course_id: string; group_id: string; via: "group" | "channel" }[] = [];
  const meta = new Map(courses.map((c) => [String(c.id).toLowerCase(), c]));
  const byCourse = new Map<string, ProbeTarget[]>();
  for (const h of hits) byCourse.set(h.courseId.toLowerCase(), [...(byCourse.get(h.courseId.toLowerCase()) ?? []), h]);
  for (const [cid, hs] of byCourse) {
    const groupHit = hs.find((h) => !h.channel && h.groupIds.length);
    if (groupHit) {
      out.push({ course_id: groupHit.courseId, group_id: groupHit.groupIds[0], via: "group" });
      continue;
    }
    const holding = meta.get(cid)?.channel_group_id;
    if (holding && hs.some((h) => h.channel)) out.push({ course_id: hs[0].courseId, group_id: holding, via: "channel" });
  }
  return out;
}

/** A getChatMember answer that counts as "a student member" (admins/creators are staff: never auto-added). */
export function isStudentMember(cm: unknown): boolean {
  // deno-lint-ignore no-explicit-any
  const r = (cm as any)?.result;
  const st = r?.status;
  return st === "member" || (st === "restricted" && r?.is_member === true);
}
