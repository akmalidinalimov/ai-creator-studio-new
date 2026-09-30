// Cross-course move guard (PR-3a): ONE rule for every edge path that changes an EXISTING student's group.
//
// Why: who may see and grade a homework is decided by the student's CURRENT group (is_teacher_of,
// teacher_pending_submissions, gradingScopeIds, the media/voice endpoints all read profiles.group_id).
// Moving a 5.0 student into a Challenge 6.0 group therefore hands their waiting 5.0 homework to the 6.0
// teachers, takes it away from the 5.0 teacher, and leaves the student unable to hand in the rest of 5.0
// (student_assignable_homework offers only the current group's course). Until each submission records
// its own group (PR-8/PR-9), a move between courses is refused by default. The owner's rule: Challenge
// 6.0 is for new students only.
//
// Callers: staff-intake (the passwordless /intake form) and admin-create-students (the engine behind
// staff-intake, sheet-sync, the bot's auto-register and every admin add/import screen). The engine
// re-checks at the write, so no caller can skip the rule.
//
// An explicit ADMIN override is allowed only when the old course has 0 waiting homework (score is null or
// score_is_stale: the same "waiting" the grading queue and the bot use), and every refusal and override
// is written to admin_actions.

// A service-role Supabase client (typed loosely, like the rest of the codebase).
// deno-lint-ignore no-explicit-any
type Db = any;

export type CourseMoveFacts = {
  fromGroupId: string | null;
  fromGroupName: string | null;
  fromCourseId: string | null;
  fromCourseTitle: string | null;
  toGroupId: string | null;
  toCourseId: string | null;
  toCourseTitle: string | null;
  /** Waiting (score null or stale) submissions in the FROM course. null = not counted, or the read failed. */
  oldCourseWaiting: number | null;
  /** The group/course read failed, so we cannot tell whether this is a move between courses. */
  lookupFailed: boolean;
};

export type OverrideAsk = {
  /** The caller explicitly asked to move the student to another course anyway. */
  requested: boolean;
  /** A VERIFIED admin/superadmin user id behind the request, or null. Never taken from the body unchecked. */
  adminId: string | null;
};

export type RefuseReason =
  | "cross_course"        // a move between courses, no override asked
  | "old_course_waiting"  // override asked, but homework in the old course still waits for a grade
  | "override_not_admin"  // override asked by a caller that is not a verified admin
  | "check_failed";       // the facts could not be read; never move blind

export type CourseMoveVerdict =
  | { kind: "no_move" }     // no current group, or already in the target group
  | { kind: "same_course" } // a move inside one course: the existing confirm flow applies
  | { kind: "override"; adminId: string }
  | { kind: "refused"; reason: RefuseReason };

export const REFUSED_STATUS = "cross_course_refused";

/**
 * PR-3b: the DATABASE enforces the same rule for every writer. The trigger trg_profiles_aa_course_move_guard
 * (migration 20260930181000) refuses a move between courses while the old course has waiting homework with
 * P0001, MESSAGE "cross_course_refused: <Uzbek sentence>" and DETAIL = the course_move_facts() jsonb. The engine
 * checks first (above), so this only fires when homework arrives between that check and the write.
 */
export const DB_REFUSAL_PREFIX = "cross_course_refused:";

/** The facts carried by a database guard refusal, or null when `err` is any other error. Pure; never throws. */
export function dbRefusalFacts(
  err: { message?: string | null; details?: string | null } | null | undefined,
): CourseMoveFacts | null {
  if (!err || !String(err.message ?? "").trim().startsWith(DB_REFUSAL_PREFIX)) return null;
  let d: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(err.details ?? ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) d = parsed as Record<string, unknown>;
  } catch (_e) { /* a refusal without readable facts is still a refusal */ }
  const s = (k: string): string | null => (typeof d[k] === "string" && d[k] ? d[k] as string : null);
  const w = d.old_course_waiting;
  return {
    fromGroupId: s("from_group_id"), fromGroupName: s("from_group"),
    fromCourseId: s("from_course_id"), fromCourseTitle: s("from_course"),
    toGroupId: s("to_group_id"), toCourseId: s("to_course_id"), toCourseTitle: s("to_course"),
    oldCourseWaiting: typeof w === "number" && Number.isFinite(w) ? w : null,
    lookupFailed: false,
  };
}

export function emptyFacts(fromGroupId: string | null, toGroupId: string | null, toCourseId: string | null): CourseMoveFacts {
  return {
    fromGroupId, fromGroupName: null, fromCourseId: null, fromCourseTitle: null,
    toGroupId, toCourseId, toCourseTitle: null, oldCourseWaiting: null, lookupFailed: false,
  };
}

/** Both courses are known and differ, and the student really changes group. */
export function isCrossCourse(f: CourseMoveFacts): boolean {
  if (!f.fromGroupId) return false;
  if (f.toGroupId && f.toGroupId === f.fromGroupId) return false;
  return !!f.fromCourseId && !!f.toCourseId && f.fromCourseId !== f.toCourseId;
}

/** An admin could override this refusal: a move between courses with nothing waiting in the old one. */
export function overridePossible(f: CourseMoveFacts): boolean {
  return isCrossCourse(f) && f.oldCourseWaiting === 0;
}

/**
 * Pure decision. A group or course that is unknown but read fine (a group without a course) is treated as
 * a same-course move, as before: we refuse only what we can prove is a move between courses, plus the
 * case where the read itself failed.
 */
export function decideCourseMove(f: CourseMoveFacts, ask: OverrideAsk): CourseMoveVerdict {
  if (!f.fromGroupId) return { kind: "no_move" };
  if (f.toGroupId && f.toGroupId === f.fromGroupId) return { kind: "no_move" };
  if (f.lookupFailed) return { kind: "refused", reason: "check_failed" };
  if (!isCrossCourse(f)) return { kind: "same_course" };
  if (!ask.requested) return { kind: "refused", reason: "cross_course" };
  if (!ask.adminId) return { kind: "refused", reason: "override_not_admin" };
  if (f.oldCourseWaiting === null) return { kind: "refused", reason: "check_failed" };
  if (f.oldCourseWaiting > 0) return { kind: "refused", reason: "old_course_waiting" };
  return { kind: "override", adminId: ask.adminId };
}

// deno-lint-ignore no-explicit-any
function courseIdOfRow(row: any): string | null {
  // PostgREST returns a to-one embed as an object; tolerate an array too.
  const a = Array.isArray(row?.homework_assignments) ? row.homework_assignments[0] : row?.homework_assignments;
  const m = Array.isArray(a?.modules) ? a.modules[0] : a?.modules;
  const c = m?.course_id;
  return typeof c === "string" && c ? c : null;
}

/** Pure: how many of the student's waiting rows belong to `courseId`. */
// deno-lint-ignore no-explicit-any
export function countWaitingInCourse(rows: readonly any[], courseId: string): number {
  let n = 0;
  for (const r of rows) if (courseIdOfRow(r) === courseId) n++;
  return n;
}

/**
 * Reads what the decision needs, and only when a real group change is on the table (no queries for a new
 * student or a same-group re-submit). The target group's OWN course wins over `toCourseId` (the hint is
 * used when the target group does not exist yet and will be created in that course). Never throws.
 */
export async function loadCourseMoveFacts(
  db: Db,
  args: { userId: string; fromGroupId: string | null; toGroupId: string | null; toCourseId: string | null },
): Promise<CourseMoveFacts> {
  const f = emptyFacts(args.fromGroupId, args.toGroupId, args.toCourseId);
  if (!args.fromGroupId) return f;
  if (args.toGroupId && args.toGroupId === args.fromGroupId) return f;
  try {
    const ids = [args.fromGroupId, ...(args.toGroupId ? [args.toGroupId] : [])];
    const { data: groups, error: gErr } = await db.from("groups").select("id, name, course_id").in("id", ids);
    if (gErr) { f.lookupFailed = true; return f; }
    const from = (groups || []).find((g: { id: string }) => g.id === args.fromGroupId);
    const to = args.toGroupId ? (groups || []).find((g: { id: string }) => g.id === args.toGroupId) : null;
    f.fromGroupName = from?.name ?? null;
    f.fromCourseId = from?.course_id ?? null;
    if (to) f.toCourseId = to.course_id ?? null;

    const courseIds = [...new Set([f.fromCourseId, f.toCourseId].filter((x): x is string => !!x))];
    if (courseIds.length) {
      // Titles only feed the messages: a failed read here is not a reason to refuse.
      const { data: cs } = await db.from("courses").select("id, title").in("id", courseIds);
      for (const c of (cs || []) as Array<{ id: string; title: string }>) {
        if (c.id === f.fromCourseId) f.fromCourseTitle = c.title;
        if (c.id === f.toCourseId) f.toCourseTitle = c.title;
      }
    }

    if (f.fromCourseId) {
      const { data: rows, error: wErr } = await db.from("homework_submissions")
        .select("id, homework_assignments(modules(course_id))")
        .eq("user_id", args.userId)
        .or("score.is.null,score_is_stale.is.true")
        .limit(1000);
      f.oldCourseWaiting = wErr ? null : countWaitingInCourse(rows || [], f.fromCourseId);
    }
  } catch (_e) {
    f.lookupFailed = true;
  }
  return f;
}

/** True when `userId` holds the admin or superadmin role. Any read failure is false (fail closed). */
export async function isAdminUser(db: Db, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  try {
    const { data, error } = await db.from("user_roles").select("role").eq("user_id", userId).in("role", ["admin", "superadmin"]);
    return !error && Array.isArray(data) && data.length > 0;
  } catch (_e) {
    return false;
  }
}

/**
 * The verified admin behind an Authorization header, or null. The passwordless /intake form sends the
 * visitor's own session token when an admin happens to be signed in on the site; a salesperson (no session)
 * sends the publishable key, which is no user at all. Never throws.
 */
export async function adminIdFromBearer(db: Db, authHeader: string | null | undefined): Promise<string | null> {
  const token = String(authHeader || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    const { data, error } = await db.auth.getUser(token);
    const id: string | undefined = data?.user?.id;
    if (error || !id) return null;
    return (await isAdminUser(db, id)) ? id : null;
  } catch (_e) {
    return null;
  }
}

const q = (s: string | null, fallback: string) => (s && s.trim() ? s.trim() : fallback);

/** Uzbek line about the old course's waiting homework ("" when it was not counted). */
export function waitingSentence(n: number | null): string {
  if (n === null) return "";
  return n > 0 ? `Eski kursda ${n} ta vazifa hali baholanmagan.` : "Eski kursda baholanmagan vazifa yo'q.";
}

/** The Uzbek message shown to sales/admins for a refusal. */
export function refusalMessage(f: CourseMoveFacts, reason: RefuseReason): string {
  const from = q(f.fromCourseTitle, "boshqa kurs");
  const to = q(f.toCourseTitle, "yangi kurs");
  const grp = q(f.fromGroupName, "boshqa");
  switch (reason) {
    case "cross_course":
      return [
        `Bu talaba "${grp}" guruhida (${from}). Uni boshqa kursga o'tkazib bo'lmaydi: ${to} faqat yangi o'quvchilar uchun.`,
        waitingSentence(f.oldCourseWaiting),
      ].filter(Boolean).join(" ");
    case "old_course_waiting":
      return `Kursni o'zgartirib bo'lmaydi: eski kursda (${from}) ${f.oldCourseWaiting ?? 0} ta vazifa hali baholanmagan. Avval ustoz ularni baholashi kerak.`;
    case "override_not_admin":
      return "Talabani boshqa kursga faqat admin o'tkaza oladi. Admin hisobi bilan kirib, qayta urinib ko'ring.";
    case "check_failed":
    default:
      return "Talabaning hozirgi guruhi va kursini tekshirib bo'lmadi. Qayta urinib ko'ring.";
  }
}

/** The fields a caller returns so a UI can explain the refusal itself (no ids, no PII). */
export function moveSummary(f: CourseMoveFacts) {
  return {
    current_group: f.fromGroupName,
    current_course: f.fromCourseTitle,
    target_course: f.toCourseTitle,
    old_course_waiting: f.oldCourseWaiting,
  };
}

/** admin_actions.details for a refusal or an override. */
export function moveAuditDetails(f: CourseMoveFacts, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from_group_id: f.fromGroupId,
    from_group: f.fromGroupName,
    from_course_id: f.fromCourseId,
    from_course: f.fromCourseTitle,
    to_group_id: f.toGroupId,
    to_course_id: f.toCourseId,
    to_course: f.toCourseTitle,
    old_course_waiting: f.oldCourseWaiting,
    ...extra,
  };
}
