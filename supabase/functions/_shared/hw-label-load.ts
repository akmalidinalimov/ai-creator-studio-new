// Reads what hw-label.ts needs, for edge functions and the bot: ONE select and ONE row shape, so every sender
// derives the label the same way.
//
// The COURSE comes from the task (assignment → module → course), never from the student's current group: a
// student moved to another course keeps old-course work, and that work must still name its own course. The
// GROUP is whatever group the caller routes by (today the student's current group, or the queue row's group),
// so on a moved student the label shows both and the mismatch is visible ("5.0 · AC CHALLENGE | 3-GURUH").
//
// A label is an enrichment: a failed read never blocks a send. The caller falls back to the text it sent
// before, and the failure is DB-visible (graceful is not silent): one `hw_label_lookup_failed` admin_actions row
// per source and part per Tashkent day (logHealthOnce), so a broken embed shows up without flooding.
import { logHealthOnce } from "./edge.ts";
import { hwLabel, stepOf } from "./hw-label.ts";

// A service-role Supabase client (typed loosely, like the rest of the codebase).
// deno-lint-ignore no-explicit-any
type Db = any;

/** The homework_assignments select every label reader uses (to-one embeds: module, then its course). */
export const ASSIGNMENT_LABEL_SELECT =
  "id, title, max_score, task_number, sap_number, parent_id, module_id, modules(position, title, courses(title))";
/** The same row without the embeds: the retry when the embedded read fails, so title / max / step still load. */
export const ASSIGNMENT_PLAIN_SELECT = "id, title, max_score, task_number, sap_number, parent_id, module_id";

export type AssignmentLabelInfo = {
  id: string;
  title: string;
  maxScore: number | null;
  /** modules.position + 1, the number every surface shows. */
  moduleNumber: number | null;
  moduleTitle: string | null;
  /** stepOf(): sap_number for a SAP sub-step, else task_number. */
  step: number | null;
  /** courses.title of the task's course. */
  courseTitle: string | null;
};

// PostgREST returns an object for a to-one embed; tolerate an array (or nothing) all the same.
// deno-lint-ignore no-explicit-any
const one = (r: any): any => (Array.isArray(r) ? (r[0] ?? null) : (r ?? null));
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** Pure: one ASSIGNMENT_LABEL_SELECT row → the label fields. null for a missing row. */
// deno-lint-ignore no-explicit-any
export function assignmentLabelInfo(row: any): AssignmentLabelInfo | null {
  if (!row || !row.id) return null;
  const mod = one(row.modules);
  const course = one(mod?.courses);
  const pos = typeof mod?.position === "number" && Number.isFinite(mod.position) ? mod.position : null;
  return {
    id: String(row.id),
    title: typeof row.title === "string" ? row.title : "",
    maxScore: typeof row.max_score === "number" ? row.max_score : null,
    moduleNumber: pos != null ? pos + 1 : null,
    moduleTitle: str(mod?.title),
    step: stepOf(row),
    courseTitle: str(course?.title),
  };
}

/** The full label for one task in one group. "" when the task is unknown (the caller keeps its old text). */
export function labelOf(info: AssignmentLabelInfo | null | undefined, groupName: string | null | undefined): string {
  if (!info) return "";
  return hwLabel({
    courseTitle: info.courseTitle, groupName, moduleNumber: info.moduleNumber, step: info.step, title: info.title,
  });
}

/** The label without the title ("5.0 · 1-GURUH PRE · M2 V1"), for a line that already shows the title. */
export function tagOf(info: AssignmentLabelInfo | null | undefined, groupName: string | null | undefined): string {
  if (!info) return hwLabel({ groupName });
  return hwLabel({ courseTitle: info.courseTitle, groupName, moduleNumber: info.moduleNumber, step: info.step });
}

export type LoadResult<T> = { map: Map<string, T>; error: string | null };

const uniq = (ids: readonly (string | null | undefined)[]): string[] =>
  Array.from(new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0)));

async function reportLookupFailed(admin: Db, source: string, part: string, error: string): Promise<void> {
  await logHealthOnce(admin, "hw_label_lookup_failed", `${source}:${part}`, { part, error: error.slice(0, 300) }, { source });
}

async function readAssignments(admin: Db, select: string, list: string[]): Promise<unknown[]> {
  const { data, error } = await admin.from("homework_assignments").select(select).in("id", list);
  if (error) throw new Error(String(error.message ?? error));
  return (data || []) as unknown[];
}

/**
 * Label fields per assignment id. Never throws. When the embedded read fails, it is recorded (once a day) and
 * retried WITHOUT the embeds, so a sender that also takes the title / max_score from here keeps them (only the
 * course and module number go missing). Both reads failing → empty map + error.
 */
export async function loadAssignmentLabels(
  admin: Db, ids: readonly (string | null | undefined)[], source: string,
): Promise<LoadResult<AssignmentLabelInfo>> {
  const map = new Map<string, AssignmentLabelInfo>();
  const list = uniq(ids);
  if (!list.length) return { map, error: null };
  let rows: unknown[];
  let error: string | null = null;
  try {
    rows = await readAssignments(admin, ASSIGNMENT_LABEL_SELECT, list);
  } catch (e) {
    error = String((e as Error)?.message ?? e);
    await reportLookupFailed(admin, source, "assignments", error);
    try {
      rows = await readAssignments(admin, ASSIGNMENT_PLAIN_SELECT, list);
    } catch (e2) {
      return { map, error: `${error}; plain: ${String((e2 as Error)?.message ?? e2)}` };
    }
  }
  for (const r of rows) {
    const info = assignmentLabelInfo(r);
    if (info) map.set(info.id, info);
  }
  return { map, error };
}

/** groups.name per group id. Never throws; a failed read → empty map + error (recorded once a day). */
export async function loadGroupNames(
  admin: Db, ids: readonly (string | null | undefined)[], source: string,
): Promise<LoadResult<string>> {
  const map = new Map<string, string>();
  const list = uniq(ids);
  if (!list.length) return { map, error: null };
  try {
    const { data, error } = await admin.from("groups").select("id, name").in("id", list);
    if (error) throw new Error(String(error.message ?? error));
    for (const g of (data || []) as { id?: string; name?: string | null }[]) {
      if (g?.id && typeof g.name === "string" && g.name.trim()) map.set(g.id, g.name);
    }
    return { map, error: null };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    await reportLookupFailed(admin, source, "groups", msg);
    return { map, error: msg };
  }
}

export type OneLabel = {
  info: AssignmentLabelInfo | null;
  groupName: string | null;
  /** Full label with the title; "" when the task could not be read. */
  label: string;
  /** Label without the title. */
  tag: string;
};

/** One task + one group, both reads in parallel. Never throws. */
export async function loadHwLabel(
  admin: Db, assignmentId: string | null | undefined, groupId: string | null | undefined, source: string,
): Promise<OneLabel> {
  const [a, g] = await Promise.all([
    loadAssignmentLabels(admin, [assignmentId], source),
    loadGroupNames(admin, [groupId], source),
  ]);
  const info = assignmentId ? (a.map.get(assignmentId) ?? null) : null;
  const groupName = groupId ? (g.map.get(groupId) ?? null) : null;
  return { info, groupName, label: labelOf(info, groupName), tag: tagOf(info, groupName) };
}
