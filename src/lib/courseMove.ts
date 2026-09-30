// The cross-course move rule on the web side (PR-3a). The server rule lives in
// supabase/functions/_shared/course-move-guard.ts and is enforced by staff-intake and admin-create-students;
// this module only explains its answers (the /intake form) and applies the same rule to the admin screens
// that change profiles.group_id without going through that engine (bulk "Guruhga ko'chirish", the group CSV).
//
// Why a move between courses is refused: a teacher's access follows the student's CURRENT group, so moving a
// 5.0 student into a Challenge 6.0 group hands their waiting 5.0 homework to the 6.0 teachers and takes it
// from the 5.0 teacher. An admin may override only when nothing waits in the old course.

// The few PostgREST reads loadGroupMovePlan makes. The app's `supabase` client fits; tests pass a fake.
type Db = { from: (table: string) => any };

export const REFUSED_STATUS = "cross_course_refused";

/** admin-create-students row statuses that mean "the student is placed". */
const ENGINE_PLACED = new Set(["created", "updated", "matched", "skipped_already_in_group"]);

export function isEnginePlaced(status: string | null | undefined): boolean {
  return ENGINE_PLACED.has(String(status ?? ""));
}

/**
 * A row the engine refused or failed (cross_course_refused, telegram_id_conflict, role_conflict, forbidden,
 * error, invalid_email, ...). "already_in_group" is neither placed nor a failure. Screens must SHOW these:
 * a status a screen does not know must never read as success or vanish from the tally.
 */
export function isEngineFailure(status: string | null | undefined): boolean {
  return !isEnginePlaced(status) && status !== "already_in_group";
}

/** Uzbek sentence about the old course's waiting homework ("" when it was not counted). */
export function waitingText(n: number | null | undefined): string {
  if (n === null || n === undefined) return "";
  return n > 0 ? `Eski kursda ${n} ta vazifa hali baholanmagan.` : "Eski kursda baholanmagan vazifa yo'q.";
}

export type IntakeRefusal = {
  status?: string;
  reason?: string | null;
  message?: string | null;
  current_group?: string | null;
  current_course?: string | null;
  target_course?: string | null;
  old_course_waiting?: number | null;
  can_override?: boolean;
};

/** What the /intake form shows for a `cross_course_refused` answer. */
export function describeIntakeRefusal(d: IntakeRefusal, username: string): {
  title: string;
  detail: string;
  canOverride: boolean;
  overrideNote: string | null;
} {
  const u = username.trim().replace(/^@+/, "");
  const who = u ? `@${u}` : "Bu talaba";
  const grp = d.current_group ? `"${d.current_group}"` : "boshqa";
  const from = d.current_course || "boshqa kurs";
  const to = d.target_course || "tanlangan kurs";
  const waiting = waitingText(d.old_course_waiting);
  const canOverride = d.can_override === true;

  if (d.reason === "check_failed") {
    return {
      title: "⚠️ Tekshirib bo'lmadi",
      detail: d.message || "Talabaning hozirgi guruhi va kursini tekshirib bo'lmadi. Qayta urinib ko'ring.",
      canOverride: false,
      overrideNote: null,
    };
  }
  if (d.reason === "old_course_waiting") {
    return {
      title: "⛔ Kurs o'zgartirilmadi",
      detail: `${who} ${grp} guruhida (${from}). ${waiting} Avval ustoz ularni baholashi kerak, keyin admin o'tkaza oladi.`.replace(/\s+/g, " ").trim(),
      canOverride: false,
      overrideNote: null,
    };
  }
  if (d.reason === "override_not_admin") {
    return {
      title: "⛔ Faqat admin",
      detail: "Talabani boshqa kursga faqat admin o'tkaza oladi. Admin hisobi bilan kirib, qayta urinib ko'ring.",
      canOverride: false,
      overrideNote: null,
    };
  }
  // Default refusal (reason "cross_course", or an older server without a reason).
  const detail = [
    `${who} allaqachon ${grp} guruhida (${from}).`,
    `${to} faqat yangi o'quvchilar uchun — uni boshqa kursga o'tkazib bo'lmaydi.`,
    waiting,
    canOverride ? "" : "Savol bo'lsa, admin bilan bog'laning.",
  ].filter(Boolean).join(" ");
  const pending = d.old_course_waiting ?? null;
  const overrideNote = canOverride
    ? `Admin: eski kursda baholanmagan vazifa yo'q, shuning uchun o'tkazish mumkin. Talaba ${from} kursining qolgan vazifalarini endi topshira olmaydi.`
    : pending !== null && pending > 0
      ? `${pending} ta vazifa baholanmaguncha admin ham o'tkaza olmaydi.`
      : null;
  return { title: "⛔ Boshqa kursdagi talaba", detail, canOverride, overrideNote };
}

/** The line under the same-course "move?" prompt: who will see the student's waiting homework after the move. */
export function sameCourseMoveNote(n: number | null | undefined): string | null {
  if (!n || n <= 0) return null;
  return `Eski guruhda ${n} ta baholanmagan vazifa bor — o'tkazilgandan keyin ularni yangi guruh ustozi ko'radi.`;
}

// ---- admin screens: the same rule for a direct group change ----

export type MoveRow = {
  userId: string;
  fromGroupId: string | null;
  fromGroupName: string | null;
  fromCourseId: string | null;
  fromCourseTitle: string | null;
  /** Waiting (score null or stale) submissions in the student's CURRENT course. null = not counted. */
  waiting: number | null;
};

export type MovePlan = {
  targetCourseId: string | null;
  targetCourseTitle: string | null;
  /** Students whose current group belongs to another course than the target group. */
  cross: MoveRow[];
  /** Cross-course students with homework still waiting (or an uncounted total): never movable, even by an admin. */
  blocked: MoveRow[];
  /** Waiting homework across `blocked`. */
  blockedWaiting: number;
};

/** Pure: the same decision as decideCourseMove, for many students and one target group. */
export function classifyGroupMoves(
  rows: readonly MoveRow[],
  target: { groupId: string; courseId: string | null; courseTitle: string | null },
): MovePlan {
  const cross = rows.filter((r) =>
    !!r.fromGroupId && r.fromGroupId !== target.groupId &&
    !!r.fromCourseId && !!target.courseId && r.fromCourseId !== target.courseId);
  const blocked = cross.filter((r) => r.waiting === null || r.waiting > 0);
  return {
    targetCourseId: target.courseId,
    targetCourseTitle: target.courseTitle,
    cross,
    blocked,
    blockedWaiting: blocked.reduce((s, r) => s + (r.waiting ?? 0), 0),
  };
}

type CourseEmbed = { course_id?: string | null };
type AssignmentEmbed = { modules?: CourseEmbed | CourseEmbed[] | null };

/** The course of a waiting row embedded as homework_assignments(modules(course_id)); tolerates array embeds. */
export function courseOfRow(row: { homework_assignments?: AssignmentEmbed | AssignmentEmbed[] | null }): string | null {
  const a = Array.isArray(row.homework_assignments) ? row.homework_assignments[0] : row.homework_assignments;
  const m = Array.isArray(a?.modules) ? a?.modules[0] : a?.modules;
  return typeof m?.course_id === "string" ? m.course_id : null;
}

const CHUNK = 100;

/**
 * Reads what classifyGroupMoves needs (admin RLS: admins read all of these). THROWS on any read error: the
 * caller must not move students it could not check.
 */
export async function loadGroupMovePlan(db: Db, userIds: readonly string[], targetGroupId: string): Promise<MovePlan> {
  const ids = [...new Set(userIds)];
  const profiles: Array<{ id: string; group_id: string | null }> = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await db.from("profiles").select("id, group_id").in("id", ids.slice(i, i + CHUNK));
    if (error) throw new Error(error.message);
    profiles.push(...((data || []) as Array<{ id: string; group_id: string | null }>));
  }
  const groupIds = [...new Set([targetGroupId, ...profiles.map((p) => p.group_id).filter((g): g is string => !!g)])];
  const { data: groups, error: gErr } = await db.from("groups").select("id, name, course_id").in("id", groupIds);
  if (gErr) throw new Error(gErr.message);
  const gById = new Map(((groups || []) as Array<{ id: string; name: string; course_id: string | null }>).map((g) => [g.id, g]));
  const courseIds = [...new Set([...gById.values()].map((g) => g.course_id).filter((c): c is string => !!c))];
  const titles = new Map<string, string>();
  if (courseIds.length) {
    const { data: cs, error: cErr } = await db.from("courses").select("id, title").in("id", courseIds);
    if (cErr) throw new Error(cErr.message);
    for (const c of (cs || []) as Array<{ id: string; title: string }>) titles.set(c.id, c.title);
  }
  const target = gById.get(targetGroupId);
  const targetCourseId = target?.course_id ?? null;

  // Count waiting homework only for the students who would actually cross courses.
  const movers = profiles.filter((p) => {
    const from = p.group_id ? gById.get(p.group_id) : undefined;
    return !!from && p.group_id !== targetGroupId && !!from.course_id && !!targetCourseId && from.course_id !== targetCourseId;
  });
  const waitingByUser = new Map<string, number>();
  const groupOfUser = new Map(profiles.map((p) => [p.id, p.group_id]));
  const moverIds = movers.map((p) => p.id);
  for (let i = 0; i < moverIds.length; i += CHUNK) {
    const { data, error } = await db.from("homework_submissions")
      .select("user_id, homework_assignments(modules(course_id))")
      .in("user_id", moverIds.slice(i, i + CHUNK))
      .or("score.is.null,score_is_stale.is.true");
    if (error) throw new Error(error.message);
    for (const r of (data || []) as Array<{ user_id: string; homework_assignments?: AssignmentEmbed | null }>) {
      const from = gById.get(groupOfUser.get(r.user_id) ?? "");
      if (from?.course_id && courseOfRow(r) === from.course_id) waitingByUser.set(r.user_id, (waitingByUser.get(r.user_id) ?? 0) + 1);
    }
  }

  const rows: MoveRow[] = profiles.map((p) => {
    const from = p.group_id ? gById.get(p.group_id) : undefined;
    return {
      userId: p.id,
      fromGroupId: p.group_id,
      fromGroupName: from?.name ?? null,
      fromCourseId: from?.course_id ?? null,
      fromCourseTitle: from?.course_id ? titles.get(from.course_id) ?? null : null,
      waiting: waitingByUser.get(p.id) ?? 0,
    };
  });
  return classifyGroupMoves(rows, {
    groupId: targetGroupId,
    courseId: targetCourseId,
    courseTitle: targetCourseId ? titles.get(targetCourseId) ?? null : null,
  });
}

/** Uzbek text for a bulk/CSV move the rule blocks. */
export function blockedMoveText(plan: MovePlan): string {
  const n = plan.blocked.length;
  return `${n} talabani boshqa kursga (${plan.targetCourseTitle || "tanlangan kurs"}) o'tkazib bo'lmaydi: eski kursida ${plan.blockedWaiting} ta vazifa hali baholanmagan. Avval ustoz ularni baholashi kerak.`;
}

/** Uzbek confirm text for a cross-course move an admin may still make (0 waiting). */
export function crossMoveConfirmText(plan: MovePlan): string {
  const from = [...new Set(plan.cross.map((r) => r.fromCourseTitle || "boshqa kurs"))].join(", ");
  return `${plan.cross.length} talaba boshqa kursdan (${from}) ${plan.targetCourseTitle || "tanlangan kurs"} guruhiga o'tkaziladi.\n\n` +
    `Eski kursda baholanmagan vazifa yo'q. Lekin ular eski kursning qolgan vazifalarini endi topshira olmaydi, eski baholarini esa yangi guruh ustozlari ko'radi.\n\n` +
    `Qoida: yangi kurs faqat yangi o'quvchilar uchun. Baribir o'tkazasizmi?`;
}

/** Warning before clearing a student's group (the group CSV/remove buttons). */
export const CLEAR_GROUP_WARNING =
  "Guruhsiz talabaning uy vazifalarini hech bir ustoz ko'rmaydi va baholay olmaydi (baholanmaganlari ham). Faqat admin ko'radi.";
