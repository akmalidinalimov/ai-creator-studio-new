// "The teachers of a group" for edge functions: ONE definition, so a new sender cannot quietly pick a
// narrower one.
//
// A group's teachers = groups.teacher_id (the primary) UNION group_teachers.teacher_id (co-teachers).
// That is the set the SQL helpers is_group_teacher() / teacher_group_ids() authorise, the set both
// teacher-DM enqueue paths fan out to (telegram-bot-webhook notifyTeachersOfSubmission, submit-homework
// enqueueTeacherDm), and the set teacherless_homework_health() checks. A lookup that reads only
// groups.teacher_id drops every co-teacher, and treats a group whose teachers are all in the junction
// (the admin form can save a group with co-teachers and no primary) as teacherless.
//
// groups.teacher_id is still the primary for ATTRIBUTION: teacher XP, per-teacher stats, the
// student-facing "your teacher". Use this module only where the question is "who teaches this group /
// who should hear about it".

// A service-role Supabase client (typed loosely, like the rest of the codebase).
// deno-lint-ignore no-explicit-any
type Db = any;

export type GroupPrimaryRow = { id: string; teacher_id: string | null };
export type GroupTeacherRow = { group_id: string; teacher_id: string };
export type TeacherContact = {
  telegram_id?: number | string | null;
  notifications_enabled?: boolean | null;
};

/**
 * Pure merge: group id -> teacher ids, the primary first, then co-teachers in row order, no duplicates.
 * Every group in `groups` gets an entry (an empty list = no teacher at all).
 */
export function mergeGroupTeachers(
  groups: readonly GroupPrimaryRow[],
  junction: readonly GroupTeacherRow[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const g of groups) {
    if (!g?.id) continue;
    const list = out.get(g.id) ?? [];
    if (g.teacher_id && !list.includes(g.teacher_id)) list.unshift(g.teacher_id);
    out.set(g.id, list);
  }
  for (const r of junction) {
    if (!r?.group_id || !r.teacher_id) continue;
    const list = out.get(r.group_id) ?? [];
    if (!list.includes(r.teacher_id)) list.push(r.teacher_id);
    out.set(r.group_id, list);
  }
  return out;
}

/**
 * Reachable by a bot DM: a telegram_id, and notifications not switched off. The same condition the
 * notify-homework-submission drainer sends on and teacherless_homework_health() counts as reachable.
 */
export function isReachableTeacher(p: TeacherContact | null | undefined): boolean {
  return !!p && !!p.telegram_id && p.notifications_enabled !== false;
}

/**
 * Teachers of each requested group, in two reads. Every requested id gets an entry. Throws on a read
 * error: a failed read that came back as "no rows" would make a taught group look teacherless and
 * send its notifications to the wrong people.
 */
export async function loadGroupTeachers(admin: Db, groupIds: readonly (string | null | undefined)[]): Promise<Map<string, string[]>> {
  const ids = Array.from(new Set(groupIds.filter((x): x is string => !!x)));
  if (!ids.length) return new Map();
  const [{ data: g, error: gErr }, { data: gt, error: gtErr }] = await Promise.all([
    admin.from("groups").select("id, teacher_id").in("id", ids),
    admin.from("group_teachers").select("group_id, teacher_id").in("group_id", ids),
  ]);
  if (gErr) throw new Error(`groups read failed: ${gErr.message}`);
  if (gtErr) throw new Error(`group_teachers read failed: ${gtErr.message}`);
  const merged = mergeGroupTeachers((g || []) as GroupPrimaryRow[], (gt || []) as GroupTeacherRow[]);
  for (const id of ids) if (!merged.has(id)) merged.set(id, []);
  return merged;
}
