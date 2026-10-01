import { describe, it, expect } from "vitest";
import {
  blockedMoveText,
  classifyGroupMoves,
  courseOfRow,
  crossMoveConfirmText,
  DB_MOVE_REFUSAL_PREFIX,
  dbMoveRefusalText,
  describeIntakeRefusal,
  isEngineFailure,
  isEnginePlaced,
  loadGroupMovePlan,
  type MoveRow,
  sameCourseMoveNote,
  transferDecision,
  waitingText,
} from "./courseMove";

// Mirrors supabase/functions/_shared/course-move-guard.ts (the server rule; Deno-tested there).
const C5 = "c5", C6 = "c6";

describe("engine statuses", () => {
  it("placed vs failed; a status a screen does not know is a failure, never a success", () => {
    for (const s of ["created", "updated", "matched", "skipped_already_in_group"]) expect(isEnginePlaced(s)).toBe(true);
    for (const s of ["cross_course_refused", "telegram_id_conflict", "role_conflict", "forbidden", "error", "invalid_email", "brand_new"]) {
      expect(isEnginePlaced(s)).toBe(false);
      expect(isEngineFailure(s)).toBe(true);
    }
    expect(isEngineFailure("already_in_group")).toBe(false);
    expect(isEngineFailure(undefined)).toBe(true);
  });
});

describe("describeIntakeRefusal (the /intake form)", () => {
  const base = {
    status: "cross_course_refused", reason: "cross_course", current_group: "2-GURUH VIP 5.0",
    current_course: "AI CREATORS 5.0", target_course: "AI CREATORS CHALLENGE 6.0",
  };
  it("salesperson: names group + both courses + waiting count, no override", () => {
    const d = describeIntakeRefusal({ ...base, old_course_waiting: 2, can_override: false }, "@ali_v");
    expect(d.title).toContain("Boshqa kurs");
    expect(d.detail).toContain("@ali_v");
    expect(d.detail).toContain('"2-GURUH VIP 5.0"');
    expect(d.detail).toContain("AI CREATORS 5.0");
    expect(d.detail).toContain("AI CREATORS CHALLENGE 6.0 faqat yangi o'quvchilar uchun");
    expect(d.detail).toContain("2 ta vazifa hali baholanmagan");
    expect(d.canOverride).toBe(false);
    expect(d.overrideNote).toContain("admin ham o'tkaza olmaydi");
  });
  it("signed-in admin with 0 waiting: override offered with its consequence spelled out", () => {
    const d = describeIntakeRefusal({ ...base, old_course_waiting: 0, can_override: true }, "ali_v");
    expect(d.canOverride).toBe(true);
    expect(d.detail).toContain("baholanmagan vazifa yo'q");
    expect(d.overrideNote).toContain("qolgan vazifalarini endi topshira olmaydi");
  });
  it("override refused while homework waits / non-admin / failed check", () => {
    expect(describeIntakeRefusal({ ...base, reason: "old_course_waiting", old_course_waiting: 3 }, "a").detail).toContain("3 ta vazifa");
    expect(describeIntakeRefusal({ ...base, reason: "override_not_admin" }, "a").detail).toContain("faqat admin");
    const f = describeIntakeRefusal({ reason: "check_failed", message: "retry" }, "a");
    expect(f.detail).toBe("retry");
    expect(f.canOverride).toBe(false);
  });
  it("an older server without the new fields still renders a sensible refusal", () => {
    const d = describeIntakeRefusal({ status: "cross_course_refused" }, "a");
    expect(d.detail).toContain("boshqa kursga o'tkazib bo'lmaydi");
    expect(d.canOverride).toBe(false);
  });
  it("same-course move note only when something waits", () => {
    expect(sameCourseMoveNote(0)).toBeNull();
    expect(sameCourseMoveNote(null)).toBeNull();
    expect(sameCourseMoveNote(4)).toContain("4 ta baholanmagan");
    expect(waitingText(undefined)).toBe("");
  });
});

const row = (p: Partial<MoveRow>): MoveRow => ({
  userId: "u", fromGroupId: "g5", fromGroupName: "2-GURUH VIP 5.0", fromCourseId: C5, fromCourseTitle: "AI CREATORS 5.0", waiting: 0, ...p,
});

describe("classifyGroupMoves (admin bulk move / group CSV)", () => {
  const to6 = { groupId: "g6", courseId: C6, courseTitle: "AI CREATORS CHALLENGE 6.0" };
  it("same-course, groupless and already-there students are not cross-course", () => {
    const plan = classifyGroupMoves([
      row({ userId: "a", fromGroupId: "g5b", fromCourseId: C6 }),
      row({ userId: "b", fromGroupId: null, fromCourseId: null }),
      row({ userId: "c", fromGroupId: "g6", fromCourseId: C6 }),
    ], to6);
    expect(plan.cross).toEqual([]);
    expect(plan.blocked).toEqual([]);
  });
  it("cross-course with waiting (or uncounted) work is blocked; with 0 waiting it only needs a confirm", () => {
    const plan = classifyGroupMoves([
      row({ userId: "a", waiting: 2 }),
      row({ userId: "b", waiting: 0 }),
      row({ userId: "c", waiting: null }),
    ], to6);
    expect(plan.cross.map((r) => r.userId)).toEqual(["a", "b", "c"]);
    expect(plan.blocked.map((r) => r.userId)).toEqual(["a", "c"]);
    expect(plan.blockedWaiting).toBe(2);
    expect(blockedMoveText(plan)).toContain("2 talabani");
    expect(crossMoveConfirmText({ ...plan, blocked: [] })).toContain("AI CREATORS 5.0");
  });
  it("a target group with no course cannot be judged cross-course (same as the server)", () => {
    expect(classifyGroupMoves([row({ waiting: 5 })], { groupId: "gx", courseId: null, courseTitle: null }).cross).toEqual([]);
  });
});

describe("transferDecision (group page → «Talaba qo'shish»)", () => {
  const to6 = { groupId: "g6", courseId: C6, courseTitle: "AI CREATORS CHALLENGE 6.0" };

  it("a same-course or groupless student is placed with no confirm", () => {
    const plan = classifyGroupMoves([row({ fromGroupId: "g5b", fromCourseId: C6 })], to6);
    expect(transferDecision(plan)).toEqual({ kind: "go" });
  });

  it("waiting homework in the old course blocks the transfer, even for an admin", () => {
    const plan = classifyGroupMoves([row({ waiting: 2 })], to6);
    const d = transferDecision(plan, { unenroll: true });
    expect(d.kind).toBe("blocked");
    if (d.kind === "blocked") expect(d.text).toContain("2 ta vazifa hali baholanmagan");
  });

  it("0 waiting asks for a confirm and names the old course's enrollment to remove", () => {
    const plan = classifyGroupMoves([row({ waiting: 0 })], to6);
    const d = transferDecision(plan, { unenroll: true });
    expect(d.kind).toBe("confirm");
    if (d.kind !== "confirm") return;
    expect(d.fromCourseIds).toEqual([C5]);
    // Every consequence the admin must see before they agree.
    expect(d.text).toContain("AI CREATORS 5.0");
    expect(d.text).toContain("AI CREATORS CHALLENGE 6.0");
    expect(d.text).toContain("0 dan boshlaydi");          // the new course's rating starts at zero
    expect(d.text).toContain("topshira olmaydi");          // the old course's remaining homework
    expect(d.text).toContain("darslari yopiladi");         // the old course's access closes
    expect(d.text).toContain("2-GURUH VIP 5.0");           // which group they come from
  });

  it("without unenroll the confirm never promises to close the old course", () => {
    const plan = classifyGroupMoves([row({ waiting: 0 })], to6);
    const d = transferDecision(plan);
    expect(d.kind).toBe("confirm");
    if (d.kind === "confirm") expect(d.text).not.toContain("darslari yopiladi");
  });

  it("the target course is never listed as an enrollment to remove", () => {
    const plan = classifyGroupMoves([
      row({ userId: "a", waiting: 0 }),
      row({ userId: "b", fromGroupId: "g4", fromCourseId: "c4", fromCourseTitle: "AI CREATORS 4.0", waiting: 0 }),
    ], to6);
    const d = transferDecision(plan, { unenroll: true });
    if (d.kind !== "confirm") throw new Error("expected confirm");
    expect(d.fromCourseIds.sort()).toEqual(["c4", C5].sort());
    expect(d.fromCourseIds).not.toContain(C6);
    expect(d.text).toContain("2 talaba");
  });
});

describe("dbMoveRefusalText (the database guard, migration 20260930181010)", () => {
  // The exact MESSAGE profiles_course_move_guard() raises (format() of the migration, verified in PGlite).
  const real = "cross_course_refused: Aziza Karimova boshqa kursga (AI CREATORS CHALLENGE 6.0) o'tkazilmadi: " +
    "eski kursda (AI CREATORS 5.0) 1 ta vazifa hali baholanmagan. Avval ustoz ularni baholashi kerak. Hech kim ko'chirilmadi.";
  it("the refusal becomes its Uzbek sentence, prefix removed", () => {
    expect(real.startsWith(DB_MOVE_REFUSAL_PREFIX)).toBe(true);
    expect(dbMoveRefusalText(real)).toBe(real.slice(DB_MOVE_REFUSAL_PREFIX.length).trim());
    expect(dbMoveRefusalText(real)).toContain("1 ta vazifa hali baholanmagan");
    expect(dbMoveRefusalText(`  ${real}  `)).toMatch(/^Aziza Karimova/);
  });
  it("a placement (student with no group) is refused with the same sentence, every other course named", () => {
    // PGlite harness vector: no group, waiting work in 4.0 and 5.0, placed into a 6.0 group.
    const placement = "cross_course_refused: Hasan boshqa kursga (AI CREATORS CHALLENGE 6.0) o'tkazilmadi: " +
      "eski kursda (AI CREATORS 4.0, AI CREATORS 5.0) 2 ta vazifa hali baholanmagan. Avval ustoz ularni baholashi kerak. Hech kim ko'chirilmadi.";
    expect(dbMoveRefusalText(placement)).toBe(placement.slice(DB_MOVE_REFUSAL_PREFIX.length).trim());
    expect(dbMoveRefusalText(placement)).toContain("(AI CREATORS 4.0, AI CREATORS 5.0) 2 ta vazifa");
  });
  it("any other error is not ours: null, so the caller shows its own text", () => {
    expect(dbMoveRefusalText("forbidden")).toBeNull();
    expect(dbMoveRefusalText("Bu maydonni faqat admin o‘zgartira oladi")).toBeNull();
    expect(dbMoveRefusalText("new row violates cross_course_refused: later in the text")).toBeNull();
    expect(dbMoveRefusalText(null)).toBeNull();
    expect(dbMoveRefusalText(undefined)).toBeNull();
  });
  it("a bare prefix still says what happened", () => {
    expect(dbMoveRefusalText(DB_MOVE_REFUSAL_PREFIX)).toContain("Hech kim ko'chirilmadi");
  });
});

describe("courseOfRow", () => {
  it("object and array embeds, missing pieces", () => {
    expect(courseOfRow({ homework_assignments: { modules: { course_id: C5 } } })).toBe(C5);
    expect(courseOfRow({ homework_assignments: [{ modules: [{ course_id: C6 }] }] })).toBe(C6);
    expect(courseOfRow({ homework_assignments: null })).toBeNull();
    expect(courseOfRow({})).toBeNull();
  });
});

// A fake that honours the exact filter chain loadGroupMovePlan builds.
function fakeDb(t: Record<string, Array<Record<string, unknown>>>, failOn?: string) {
  return {
    from: (table: string) => {
      const f: { inCol?: string; inVals?: unknown[]; waiting?: boolean } = {};
      const run = () => {
        if (failOn === table) return { data: null, error: { message: "boom" } };
        let rows = (t[table] || []).slice();
        if (f.inCol) rows = rows.filter((r) => f.inVals!.includes(r[f.inCol!]));
        if (f.waiting) rows = rows.filter((r) => r.score === null || r.score_is_stale === true);
        if (table === "homework_submissions") {
          rows = rows.map((r) => ({ user_id: r.user_id, homework_assignments: { modules: { course_id: r.course_id } } }));
        }
        return { data: rows, error: null };
      };
      const qb = {
        select: () => qb,
        in: (col: string, vals: unknown[]) => { f.inCol = col; f.inVals = vals; return qb; },
        or: (expr: string) => { f.waiting = expr === "score.is.null,score_is_stale.is.true"; return qb; },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      };
      return qb;
    },
  };
}

describe("loadGroupMovePlan", () => {
  const T = {
    profiles: [
      { id: "a", group_id: "g5" }, // 5.0, 1 waiting + 1 stale
      { id: "b", group_id: "g5" }, // 5.0, nothing waiting
      { id: "c", group_id: "g5b" }, // another 6.0 group: same course as the target
      { id: "d", group_id: null },
    ],
    groups: [
      { id: "g5", name: "2-GURUH VIP 5.0", course_id: C5 },
      { id: "g5b", name: "AC CHALLENGE | 1-GURUH", course_id: C6 },
      { id: "g6", name: "AC CHALLENGE | 3-GURUH", course_id: C6 },
    ],
    courses: [{ id: C5, title: "AI CREATORS 5.0" }, { id: C6, title: "AI CREATORS CHALLENGE 6.0" }],
    homework_submissions: [
      { user_id: "a", score: null, score_is_stale: false, course_id: C5 },
      { user_id: "a", score: 7, score_is_stale: true, course_id: C5 },
      { user_id: "a", score: 9, score_is_stale: false, course_id: C5 },
      { user_id: "b", score: 9, score_is_stale: false, course_id: C5 },
    ],
  };
  it("real shapes: a is blocked (2 waiting), b needs a confirm, c and d are not cross-course", async () => {
    const plan = await loadGroupMovePlan(fakeDb(T), ["a", "b", "c", "d"], "g6");
    expect(plan.targetCourseTitle).toBe("AI CREATORS CHALLENGE 6.0");
    expect(plan.cross.map((r) => r.userId).sort()).toEqual(["a", "b"]);
    expect(plan.blocked.map((r) => r.userId)).toEqual(["a"]);
    expect(plan.blockedWaiting).toBe(2);
  });
  it("any read error throws: never move students that could not be checked", async () => {
    for (const t of ["profiles", "groups", "courses", "homework_submissions"]) {
      await expect(loadGroupMovePlan(fakeDb(T, t), ["a"], "g6")).rejects.toThrow("boom");
    }
  });
});
