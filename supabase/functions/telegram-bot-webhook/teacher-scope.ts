// A teacher's bot scope, profiles.active_teacher_group_id, is a PREFERENCE, not a grant.
//
// The roster, module-progress and legacy student-picker callbacks (tr:list, thm:list, thm:mod, gs:list
// with no token) narrow a teacher's view to this group and then read that group's names, @usernames,
// telegram_ids and submissions with the service-role client. So the stored value must be re-checked
// against the groups the teacher teaches NOW before it is used:
//   * the DB guard (20260930120020) stops a teacher PATCHing it to a foreign group, but a service-role
//     write (the tprof:g: callback, whose data a modified client can forge) is privileged there;
//   * a value that was valid when written goes STALE when an admin reassigns the group.
// A value that fails the check falls back to "all of the teacher's own groups" (null), the same view a
// teacher with no stored scope gets. Kept pure so the rule is CI-tested in teacher-scope.test.ts;
// index.ts itself is not type-checked in CI.

/** The stored scope when this teacher teaches that group, else null (use all of their own groups). */
export function taughtScope(
  stored: string | null | undefined,
  taught: readonly { id: string }[],
): string | null {
  if (!stored) return null;
  return taught.some((g) => g.id === stored) ? stored : null;
}
