import { describe, it, expect } from "vitest";
import {
  buildCourseRow, decideContinue, orderCourseRows, pickResume, resolveContinueTarget,
  type CourseMeta, type CourseRow, type ProgressRow, type RawLessonRow,
} from "@/lib/nextLesson";

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────
const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const CU = "33333333-3333-4333-8333-333333333333"; // unpublished
const M = (n: number) => `aaaaaaaa-0000-4000-8000-0000000000${n}`;
const Lx = (c: number, m: number, p: number) => `cccccccc-000${c}-4000-8000-0000000${m}${p}000`;

const course = (id: string, title = "Course", published = true): CourseMeta =>
  ({ id, title, tagline: null, cover_url: null, duration_hours: null, published });

/** 3 modules × 3 lessons, modules deliberately listed out of order. */
function lessonsFor(c: number): RawLessonRow[] {
  const rows: RawLessonRow[] = [];
  for (const m of [3, 1, 2]) {
    for (const p of [2, 1, 3]) {
      rows.push({
        id: Lx(c, m, p), position: p, title: `M${m} L${p}`, duration_seconds: 300,
        modules: { id: M(c * 10 + m), course_id: c === 1 ? C1 : C2, position: m * 10, title: `Module ${m}` },
      });
    }
  }
  return rows;
}
const done = (id: string, at = "2026-09-20T10:00:00Z"): ProgressRow => ({ lesson_id: id, completed_at: at, updated_at: at });
const partial = (id: string, at = "2026-09-29T10:00:00Z"): ProgressRow => ({ lesson_id: id, completed_at: null, updated_at: at });

// The Dashboard's per-course block EXACTLY as it was inline in Dashboard.tsx before the extraction (minus the
// two network reads, whose results are the arguments). buildCourseRow must give the same answer.
function oldDashboardRow(c: CourseMeta, limit: number | null, lessonsData: RawLessonRow[], progressAll: ProgressRow[]) {
  const raw = (lessonsData || []).map((l: any) => ({
    id: l.id, lp: l.position ?? 0, title: l.title as string, dur: l.duration_seconds as number | null,
    mid: l.modules?.id, mp: l.modules?.position ?? 0, mtitle: l.modules?.title as string,
  }));
  const modRank = new Map<string, number>();
  Array.from(new Map(raw.map((l) => [l.mid, l.mp])).entries())
    .sort((a, b) => a[1] - b[1])
    .forEach(([mid], i) => modRank.set(mid, i + 1));
  const modTitleByMid = new Map<string, string>();
  raw.forEach((l) => { if (!modTitleByMid.has(l.mid)) modTitleByMid.set(l.mid, l.mtitle); });
  let ordered = raw
    .sort((a, b) => (modRank.get(a.mid)! - modRank.get(b.mid)!) || a.lp - b.lp);
  if (limit != null) ordered = ordered.filter((l) => (modRank.get(l.mid) ?? 1e9) <= limit);
  const lessonIds = ordered.map((l) => l.id);
  const total = lessonIds.length;
  const progress = progressAll.filter((p) => lessonIds.includes(p.lesson_id)); // = .in("lesson_id", lessonIds)
  const completedSet = new Set((progress || []).filter((p: any) => p.completed_at).map((p: any) => p.lesson_id));
  const lastActivityMs = (progress || []).reduce((mx: number, p: any) => {
    const ts = p.updated_at ? Date.parse(p.updated_at) : 0;
    return ts > mx ? ts : mx;
  }, 0);
  const next = ordered.find((l) => !completedSet.has(l.id));
  const nextPositionInModule = next
    ? ordered.filter((l) => l.mid === next.mid).findIndex((l) => l.id === next.id) + 1
    : undefined;
  const moduleLessonIds = new Map<string, string[]>();
  ordered.forEach((l) => {
    const arr = moduleLessonIds.get(l.mid) || [];
    arr.push(l.id);
    moduleLessonIds.set(l.mid, arr);
  });
  const modulesTotal = moduleLessonIds.size;
  const modulesCompleted = Array.from(moduleLessonIds.values())
    .filter((ids) => ids.length > 0 && ids.every((id) => completedSet.has(id))).length;
  return {
    id: c.id, title: c.title, tagline: c.tagline, cover_url: c.cover_url, duration_hours: c.duration_hours,
    total, completed: completedSet.size,
    nextLessonId: next?.id, nextCourseId: c.id,
    nextLessonTitle: next?.title, nextLessonDurationSec: next?.dur,
    nextModuleTitle: next ? modTitleByMid.get(next.mid) : undefined,
    nextModuleRank: next ? modRank.get(next.mid) : undefined,
    nextLessonPositionInModule: nextPositionInModule,
    modulesTotal, modulesCompleted,
    lastActivityMs,
  };
}

const strip = (r: CourseRow) => {
  const { accessibleLessonIds: _a, published: _p, ...rest } = r;
  return rest;
};

describe("buildCourseRow — the Dashboard's algorithm, unchanged", () => {
  const scenarios: Array<[string, number | null, ProgressRow[]]> = [
    ["fresh student", null, []],
    ["partly through module 1", null, [done(Lx(1, 1, 1)), partial(Lx(1, 1, 2))]],
    ["module 1 done → next is module 2's first lesson", null, [done(Lx(1, 1, 1)), done(Lx(1, 1, 2)), done(Lx(1, 1, 3))]],
    ["tier clamp 1 module, module 1 done", 1, [done(Lx(1, 1, 1)), done(Lx(1, 1, 2)), done(Lx(1, 1, 3)), done(Lx(1, 2, 1))]],
    ["tier clamp 2, out-of-order completions", 2, [done(Lx(1, 2, 2)), done(Lx(1, 1, 3)), partial(Lx(1, 3, 1))]],
    ["everything complete", null, [1, 2, 3].flatMap((m) => [1, 2, 3].map((p) => done(Lx(1, m, p))))],
  ];
  for (const [name, limit, progress] of scenarios) {
    it(`matches the old inline code: ${name}`, () => {
      const got = buildCourseRow(course(C1), limit, lessonsFor(1), progress);
      expect(strip(got)).toEqual(oldDashboardRow(course(C1), limit, lessonsFor(1), progress));
    });
  }

  it("tier clamp: only the first module_limit modules are accessible", () => {
    const row = buildCourseRow(course(C1), 1, lessonsFor(1), []);
    expect(row.total).toBe(3);
    expect(row.accessibleLessonIds).toEqual([Lx(1, 1, 1), Lx(1, 1, 2), Lx(1, 1, 3)]);
  });

  it("a partially watched lesson is the one returned (the player resumes it)", () => {
    const row = buildCourseRow(course(C1), null, lessonsFor(1), [done(Lx(1, 1, 1)), partial(Lx(1, 1, 2))]);
    expect(row.nextLessonId).toBe(Lx(1, 1, 2));
  });

  it("all complete → no next lesson", () => {
    const all = [1, 2, 3].flatMap((m) => [1, 2, 3].map((p) => done(Lx(1, m, p))));
    expect(buildCourseRow(course(C1), null, lessonsFor(1), all).nextLessonId).toBeUndefined();
  });
});

describe("decideContinue", () => {
  const row1 = (progress: ProgressRow[], limit: number | null = null) => buildCourseRow(course(C1), limit, lessonsFor(1), progress);
  const row2 = (progress: ProgressRow[]) => buildCourseRow(course(C2), null, lessonsFor(2), progress);
  const unpublished = buildCourseRow(course(CU, "Hidden", false), null, lessonsFor(1), [partial(Lx(1, 1, 1), "2026-09-30T00:00:00Z")]);

  it("normal: the next unfinished lesson of the requested course", () => {
    expect(decideContinue({ accountType: "paid", rows: [row1([done(Lx(1, 1, 1))])], requestedCourseId: C1 }))
      .toBe(`/lesson/${C1}/${Lx(1, 1, 2)}`);
  });

  it("provisional → the course page (trial card), never a lesson", () => {
    expect(decideContinue({ accountType: "provisional", rows: [row1([])], requestedCourseId: C1 })).toBe(`/course/${C1}`);
    expect(decideContinue({ accountType: "provisional", rows: [row1([])], lesson: { id: Lx(1, 1, 1), courseId: C1 } }))
      .toBe(`/course/${C1}`);
    expect(decideContinue({ accountType: "provisional", rows: [] })).toBe("/dashboard");
  });

  it("a requested course the student is not enrolled in → their primary course", () => {
    expect(decideContinue({ accountType: "paid", rows: [row1([])], requestedCourseId: C2 })).toBe(`/lesson/${C1}/${Lx(1, 1, 1)}`);
  });

  it("the primary course is the most recently active one (the Dashboard's order)", () => {
    const rows = [row1([done(Lx(1, 1, 1), "2026-09-01T00:00:00Z")]), row2([done(Lx(2, 1, 1), "2026-09-28T00:00:00Z")])];
    expect(decideContinue({ accountType: "paid", rows })).toBe(`/lesson/${C2}/${Lx(2, 1, 2)}`);
    expect(pickResume(orderCourseRows(rows))?.id).toBe(C2);
  });

  it("an unpublished course is skipped even when it is the most active", () => {
    expect(decideContinue({ accountType: "paid", rows: [unpublished, row1([])] })).toBe(`/lesson/${C1}/${Lx(1, 1, 1)}`);
    expect(decideContinue({ accountType: "paid", rows: [unpublished], requestedCourseId: CU })).toBe("/dashboard");
  });

  it("no published enrolled course → /dashboard", () => {
    expect(decideContinue({ accountType: "paid", rows: [] })).toBe("/dashboard");
  });

  it("every lesson complete → the course page", () => {
    const all = [1, 2, 3].flatMap((m) => [1, 2, 3].map((p) => done(Lx(1, m, p))));
    expect(decideContinue({ accountType: "paid", rows: [row1(all)], requestedCourseId: C1 })).toBe(`/course/${C1}`);
  });

  it("?lesson= is honoured inside module_limit, ignored beyond it", () => {
    const clamped = row1([], 1);
    expect(decideContinue({ accountType: "paid", rows: [clamped], lesson: { id: Lx(1, 1, 3), courseId: C1 } }))
      .toBe(`/lesson/${C1}/${Lx(1, 1, 3)}`);
    expect(decideContinue({ accountType: "paid", rows: [clamped], lesson: { id: Lx(1, 3, 1), courseId: C1 } }))
      .toBe(`/lesson/${C1}/${Lx(1, 1, 1)}`); // beyond the tier → the continue rules
  });

  it("?lesson= in a course the student is not enrolled in → the continue rules", () => {
    expect(decideContinue({ accountType: "paid", rows: [row1([])], lesson: { id: Lx(2, 1, 1), courseId: C2 } }))
      .toBe(`/lesson/${C1}/${Lx(1, 1, 1)}`);
  });
});

// ── resolveContinueTarget end to end over a fake supabase client ────────────────────────────────
type Tables = Record<string, any[]>;
function fakeClient(tables: Tables) {
  const get = (row: any, path: string) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), row);
  return {
    from(table: string) {
      let rows = (tables[table] || []).slice();
      const q: any = {
        select: () => q,
        eq: (col: string, v: unknown) => { rows = rows.filter((r) => get(r, col) === v); return q; },
        in: (col: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(get(r, col))); return q; },
        maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res, rej),
      };
      return q;
    },
  };
}

describe("resolveContinueTarget", () => {
  const U = "44444444-4444-4444-8444-444444444444";
  const base = (accountType: string, enrollments: any[], progress: ProgressRow[] = []) => fakeClient({
    profiles: [{ id: U, account_type: accountType }],
    enrollments: enrollments.map((e) => ({ user_id: U, ...e })),
    lessons: [...lessonsFor(1), ...lessonsFor(2)],
    lesson_progress: progress.map((p) => ({ user_id: U, ...p })),
  });

  it("normal", async () => {
    const sb = base("paid", [{ course_id: C1, courses: course(C1), course_tiers: null }], [done(Lx(1, 1, 1))]);
    expect(await resolveContinueTarget(sb as never, U, { courseId: C1 })).toBe(`/lesson/${C1}/${Lx(1, 1, 2)}`);
  });

  it("provisional", async () => {
    const sb = base("provisional", [{ course_id: C1, courses: course(C1), course_tiers: null }]);
    expect(await resolveContinueTarget(sb as never, U, { courseId: C1 })).toBe(`/course/${C1}`);
  });

  it("not enrolled in the requested course", async () => {
    const sb = base("paid", [{ course_id: C1, courses: course(C1), course_tiers: null }]);
    expect(await resolveContinueTarget(sb as never, U, { courseId: C2 })).toBe(`/lesson/${C1}/${Lx(1, 1, 1)}`);
  });

  it("?lesson= resolves its course through lessons → modules", async () => {
    const sb = base("paid", [{ course_id: C1, courses: course(C1), course_tiers: { module_limit: 2 } }]);
    expect(await resolveContinueTarget(sb as never, U, { lessonId: Lx(1, 2, 3) })).toBe(`/lesson/${C1}/${Lx(1, 2, 3)}`);
    expect(await resolveContinueTarget(sb as never, U, { lessonId: Lx(1, 3, 1) })).toBe(`/lesson/${C1}/${Lx(1, 1, 1)}`);
  });

  it("garbage ids are ignored", async () => {
    const sb = base("paid", [{ course_id: C1, courses: course(C1), course_tiers: null }]);
    expect(await resolveContinueTarget(sb as never, U, { courseId: "../../x", lessonId: "nope" })).toBe(`/lesson/${C1}/${Lx(1, 1, 1)}`);
  });

  it("no enrollment → /dashboard", async () => {
    expect(await resolveContinueTarget(base("paid", []) as never, U, {})).toBe("/dashboard");
  });
});
