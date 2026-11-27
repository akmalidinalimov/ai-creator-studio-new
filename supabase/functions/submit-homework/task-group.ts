// Multi-course students (PR 4): a homework belongs to the student's group IN THE TASK'S COURSE — their secondary
// group of that course (student_course_groups) — else, as before, their main group (profiles.group_id). The SQL rule
// is public.student_group_for_course(uid, course) (20261127180654); this is its edge-side caller, used for the topic
// the Mini App posts into and the teacher DM queue row. For a single-course student it returns profiles.group_id,
// exactly what this function used before.
//
// A failed course/rule read never blocks the submission: it falls back to the main group and says so
// (fallbackReason), so the caller can make the fallback DB-visible ("graceful is not silent", CLAUDE.md).

export type TaskGroup = { groupId: string | null; fallbackReason: string | null };

// deno-lint-ignore no-explicit-any
export async function resolveTaskGroupId(admin: any, userId: string, moduleId: string | null): Promise<TaskGroup> {
  let fallbackReason: string | null = null;
  if (moduleId) {
    const { data: mod, error: modErr } = await admin.from("modules").select("course_id").eq("id", moduleId).maybeSingle();
    if (modErr) {
      fallbackReason = `module_lookup_failed: ${String(modErr.message ?? modErr).slice(0, 200)}`;
    } else if (mod?.course_id) {
      const { data: g, error: rpcErr } = await admin.rpc("student_group_for_course", { _uid: userId, _course: mod.course_id });
      if (rpcErr) {
        fallbackReason = `group_rule_failed: ${String(rpcErr.message ?? rpcErr).slice(0, 200)}`;
      } else if (typeof g === "string" && g) {
        return { groupId: g, fallbackReason: null };
      }
      // NULL from the rule = no secondary group AND no main group: the profile read below answers the same
    }
  }
  const { data, error } = await admin.from("profiles").select("group_id").eq("id", userId).maybeSingle();
  if (error) throw error; // a masked failure here would misclassify as "student has no group"
  return { groupId: data?.group_id ?? null, fallbackReason };
}
