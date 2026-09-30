// nextLesson — the ONE client engine for "which lesson does this student watch next?".
//
// Used by the Dashboard's resume card AND by the /continue route that every Mini App watch button opens
// (src/pages/Continue.tsx). Before this file the algorithm lived inline in Dashboard.tsx; it is moved here
// verbatim (same tier clamp by course_tiers.module_limit, same module-rank + lesson-position order, same
// "most recent activity first" course order), so the button and the resume card can never disagree.
//
// Access is still enforced server-side (RLS hides unpublished courses from students; lesson-video-url refuses a
// provisional or beyond-tier lesson). The rules here only decide WHERE to land, and never deep-link past the
// student's module_limit.
import type { SupabaseClient } from "@supabase/supabase-js";
import { isUuid } from "@/lib/miniappLinks";

export interface CourseMeta {
  id: string;
  title: string;
  tagline: string | null;
  cover_url: string | null;
  duration_hours: number | null;
  published?: boolean | null;
}

export interface RawLessonRow {
  id: string;
  position: number | null;
  title: string;
  duration_seconds: number | null;
  modules: { id: string; course_id?: string; position: number | null; title: string } | null;
}

export interface ProgressRow {
  lesson_id: string;
  completed_at: string | null;
  updated_at: string | null;
}

export interface CourseRow {
  id: string; title: string; tagline: string | null; cover_url: string | null; duration_hours: number | null;
  total: number; completed: number; nextLessonId?: string; nextCourseId?: string;
  nextLessonTitle?: string; nextLessonDurationSec?: number | null;
  nextModuleTitle?: string; nextModuleRank?: number; nextLessonPositionInModule?: number;
  modulesTotal: number; modulesCompleted: number;
  lastActivityMs: number; // most-recent lesson activity in this course (0 = never touched)
  /** The tier-accessible lessons, in watch order (module rank, then lesson position). */
  accessibleLessonIds: string[];
  published: boolean;
}

/**
 * One course's resume data from its lessons and the student's progress rows. Pure — this is Dashboard.tsx's
 * per-course block, unchanged (nextLesson.test.ts pins it against the old inline copy).
 */
export function buildCourseRow(course: CourseMeta, limit: number | null, lessons: RawLessonRow[], progress: ProgressRow[]): CourseRow {
  const raw = (lessons || []).map((l) => ({
    id: l.id, lp: l.position ?? 0, title: l.title as string, dur: l.duration_seconds as number | null,
    mid: l.modules?.id as string, mp: l.modules?.position ?? 0, mtitle: l.modules?.title as string,
  }));
  // Rank modules by position so the cap matches the backend's rank logic.
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
  // The Dashboard only ever READ progress for the accessible lessons (.in("lesson_id", lessonIds)); filtering
  // here keeps that exact meaning whatever the caller passes.
  const accessibleSet = new Set(lessonIds);
  const prog = (progress || []).filter((p) => accessibleSet.has(p.lesson_id));
  const completedSet = new Set(prog.filter((p) => p.completed_at).map((p) => p.lesson_id));
  const lastActivityMs = prog.reduce((mx: number, p) => {
    const ts = p.updated_at ? Date.parse(p.updated_at) : 0;
    return ts > mx ? ts : mx;
  }, 0);
  const next = ordered.find((l) => !completedSet.has(l.id));
  const nextPositionInModule = next
    ? ordered.filter((l) => l.mid === next.mid).findIndex((l) => l.id === next.id) + 1
    : undefined;

  // Module completion (accessible modules only) for the compact "Kursim" card's
  // "N / M modul tugallandi" line — a module counts as done when every one of its
  // (tier-accessible) lessons is completed.
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
    id: course.id, title: course.title, tagline: course.tagline, cover_url: course.cover_url, duration_hours: course.duration_hours,
    total, completed: completedSet.size,
    nextLessonId: next?.id, nextCourseId: course.id,
    nextLessonTitle: next?.title, nextLessonDurationSec: next?.dur,
    nextModuleTitle: next ? modTitleByMid.get(next.mid) : undefined,
    nextModuleRank: next ? modRank.get(next.mid) : undefined,
    nextLessonPositionInModule: nextPositionInModule,
    modulesTotal, modulesCompleted,
    lastActivityMs,
    accessibleLessonIds: lessonIds,
    published: course.published !== false,
  };
}

/**
 * "Continue where you left off" must show the course the student is actually working in. Enrollment order is
 * arbitrary, so a student enrolled in 2 courses (e.g. finished 4.0 + active 5.0) could see the stale one. Order
 * by most-recent activity, then by progress, so the resume card + course list lead with the live course.
 */
export function orderCourseRows(rows: CourseRow[]): CourseRow[] {
  return rows.slice().sort((a, b) => (b.lastActivityMs - a.lastActivityMs) || (b.completed - a.completed));
}

/** The Dashboard's resume course: the first (most active) course with an unfinished lesson. */
export function pickResume(rows: CourseRow[]): CourseRow | undefined {
  return rows.find((c) => c.nextLessonId && c.completed < c.total) || rows.find((c) => c.nextLessonId);
}

export interface EnrollmentRow {
  course_id: string;
  courses: CourseMeta | null;
  course_tiers: { module_limit: number | null } | null;
}

type Client = SupabaseClient | { from: SupabaseClient["from"] };

/** The student's enrollments, with course + tier — the exact select the Dashboard makes. */
export async function fetchEnrollments(client: Client, userId: string): Promise<EnrollmentRow[]> {
  const { data, error } = await (client as SupabaseClient)
    .from("enrollments")
    .select("course_id, tier_id, courses(*), course_tiers(module_limit)")
    .eq("user_id", userId);
  if (error) throw error;
  return (data || []) as unknown as EnrollmentRow[];
}

/** One course's row: its lessons (all modules) + the student's progress on the accessible ones. */
export async function fetchCourseRow(client: Client, userId: string, e: EnrollmentRow): Promise<CourseRow | null> {
  const c = e.courses;
  if (!c) return null;
  // Tier cap: null = unlimited. Modules are ranked by position (matching
  // has_module_access); only the first `limit` modules are accessible.
  const limit: number | null = e.course_tiers?.module_limit ?? null;
  const { data: lessonsData } = await (client as SupabaseClient)
    .from("lessons")
    .select("id, position, title, duration_seconds, modules!inner(id, course_id, position, title)")
    .eq("modules.course_id", c.id);
  const lessons = (lessonsData || []) as unknown as RawLessonRow[];
  // Progress is read for the ACCESSIBLE lessons only (as before): compute the clamp first.
  const accessible = buildCourseRow(c, limit, lessons, []).accessibleLessonIds;
  const { data: progress } = await (client as SupabaseClient)
    .from("lesson_progress")
    .select("lesson_id, completed_at, updated_at")
    .eq("user_id", userId)
    .in("lesson_id", accessible.length ? accessible : ["00000000-0000-0000-0000-000000000000"]);
  return buildCourseRow(c, limit, lessons, (progress || []) as unknown as ProgressRow[]);
}

/** Every enrolled course's row, most-recent activity first (the Dashboard's list). */
export async function loadCourseRows(client: Client, userId: string, enrollments: EnrollmentRow[]): Promise<CourseRow[]> {
  const rows: CourseRow[] = [];
  for (const e of enrollments || []) {
    const row = await fetchCourseRow(client, userId, e);
    if (row) rows.push(row);
  }
  return orderCourseRows(rows);
}

/**
 * Where a watch button lands. Pure — the rules, in order:
 *   1. provisional (trial) account          → /course/<c>, the trial card (never a lesson it cannot open)
 *   2. ?lesson=<l> in an enrolled published course AND inside module_limit → /lesson/<c>/<l>
 *   3. the requested course, when it is enrolled and published; else the primary (most active) published
 *      enrolled course; none at all        → /dashboard
 *   4. every accessible lesson complete     → /course/<c>
 *   5. otherwise                            → /lesson/<c>/<next>  (the player resumes at last_position_seconds)
 * `rows` are the student's enrolled courses (any order; unpublished ones are skipped here).
 */
export function decideContinue(input: {
  accountType: string | null | undefined;
  rows: CourseRow[];
  requestedCourseId?: string | null;
  lesson?: { id: string; courseId: string } | null;
}): string {
  const published = orderCourseRows(input.rows.filter((r) => r.published));
  const wantedId = input.requestedCourseId ? input.requestedCourseId.toLowerCase() : null;
  const requested = wantedId ? published.find((r) => r.id.toLowerCase() === wantedId) : undefined;
  const lesson = input.lesson ?? null;
  const lessonRow = lesson ? published.find((r) => r.id === lesson.courseId) : undefined;
  const primary = requested ?? lessonRow ?? pickResume(published) ?? published[0];

  if (input.accountType === "provisional") return primary ? `/course/${primary.id}` : "/dashboard";

  if (lesson && lessonRow && lessonRow.accessibleLessonIds.includes(lesson.id)) {
    return `/lesson/${lessonRow.id}/${lesson.id}`;
  }

  const target = requested ?? pickResume(published) ?? published[0];
  if (!target) return "/dashboard";
  if (!target.nextLessonId) return `/course/${target.id}`; // all complete (or an empty course)
  return `/lesson/${target.id}/${target.nextLessonId}`;
}

/**
 * Load what decideContinue needs and decide. `courseId` / `lessonId` come from /continue/:courseId and
 * ?lesson=<uuid>; anything that is not a UUID is ignored (the continue rules then apply).
 */
export async function resolveContinueTarget(
  client: Client,
  userId: string,
  opts: { courseId?: string | null; lessonId?: string | null } = {},
): Promise<string> {
  const courseId = isUuid(opts.courseId) ? opts.courseId.toLowerCase() : null;
  const lessonId = isUuid(opts.lessonId) ? opts.lessonId.toLowerCase() : null;
  const sb = client as SupabaseClient;

  const [profRes, enrollments, lessonRes] = await Promise.all([
    sb.from("profiles").select("account_type").eq("id", userId).maybeSingle(),
    fetchEnrollments(client, userId),
    lessonId
      ? sb.from("lessons").select("id, modules!inner(course_id)").eq("id", lessonId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const accountType = ((profRes as { data: { account_type?: string | null } | null }).data?.account_type) ?? "paid";
  const lessonData = (lessonRes as { data: { id: string; modules: { course_id: string } | null } | null }).data;
  const lesson = lessonData?.modules?.course_id ? { id: lessonData.id, courseId: lessonData.modules.course_id } : null;

  // Only the courses a rule can pick need their lessons loaded: the requested one and the ?lesson= one when
  // enrolled, else every published enrollment (to find the most active).
  const published = enrollments.filter((e) => e.courses && e.courses.published !== false);
  const wanted = new Set<string>();
  if (courseId && published.some((e) => e.course_id === courseId)) wanted.add(courseId);
  if (lesson && published.some((e) => e.course_id === lesson.courseId)) wanted.add(lesson.courseId);
  const toLoad = wanted.size > 0 ? published.filter((e) => wanted.has(e.course_id)) : published;
  const rows = await loadCourseRows(client, userId, toLoad);
  return decideContinue({ accountType, rows, requestedCourseId: courseId, lesson });
}
