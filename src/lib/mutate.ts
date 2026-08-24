/**
 * mutate — the guarded safe-write primitive (the "paved road" for every DB write in src/).
 *
 * WHY: `supabase.from(t).update(...).eq(...)` resolves `{ error: null }` even when RLS filters the
 * write down to ZERO rows — so a write that changed nothing reads as success ("Saqlandi!"), and the
 * card/queue silently doesn't update. That is the single most common silent-failure class in this
 * codebase (~107 inline write→toast sites, most checking only `error`). `mutate` makes it
 * unrepresentable: it appends `.select().maybeSingle()` and treats a 0-row write as a real failure
 * (`not_saved`) rather than a false success. Generalizes the guard proven in teacherApi.submitScore.
 *
 * PASS A THUNK, not a builder: `mutate(() => supabase.from(t).update(y).eq("id", id))`. The thunk lets
 * the impersonation check run BEFORE the builder is constructed — critical, because while an admin
 * previews as a student, src/lib/impersonationGuard.ts turns `.update()` into a rejected promise, so a
 * FILTERED write (`.update().eq()`) throws synchronously at `.eq()` (a Promise has no `.eq`) and
 * orphans that rejected promise → an unhandledrejection → a bogus client-error beacon for every lesson
 * preview. Building inside the thunk (skipped entirely during impersonation) avoids constructing it at
 * all, so there's nothing to throw or orphan. During impersonation `mutate` returns an EXPECTED no-op
 * (`impersonation_readonly`) — callers must NOT toast or beacon it.
 *
 * CONTRACT: `mutate` is for a SINGLE-row write whose filter matches a unique key (id). A filter that
 * matches >1 row still writes server-side but `.maybeSingle()` then reports an error — use `mutateMany`
 * for bulk `.in(...)` writes so a partial RLS filter is caught instead.
 *
 * USAGE:
 *   const r = await mutate(() => supabase.from("groups").update({ teacher_id }).eq("id", id));
 *   if (!r.ok && r.reason !== "impersonation_readonly") toast.error("Saqlanmadi");
 * Or `saveWithToast(() => ..., { success, failure })` which wires the toast + impersonation exception.
 */
import { toast } from "sonner";

export type SaveReason = "not_saved" | "error" | "impersonation_readonly";
export type SaveResult<T = { id: string }> =
  | { ok: true; row: T }
  | { ok: false; reason: SaveReason; message?: string };

export type SaveManyReason = "not_saved" | "partial" | "error" | "impersonation_readonly";
export type SaveManyResult<T = { id: string }> =
  | { ok: true; rows: T[] }
  | { ok: false; reason: SaveManyReason; count?: number; message?: string };

/** True while an admin is previewing as a student (writes are blocked read-only). */
function impersonatingReadonly(): boolean {
  try {
    return typeof window !== "undefined" && !!window.localStorage?.getItem("impersonating");
  } catch {
    return false;
  }
}

const IMPERSONATION_RE = /read-only impersonation/i;

/**
 * Guarded SINGLE-row write. Pass a THUNK that builds a Supabase update/insert/upsert/delete query
 * (before `.select()`). Returns `{ ok:true, row }`, or `{ ok:false, reason }` where `not_saved` = a
 * 0-row (RLS-filtered) write, `error` = a real DB/transport error, `impersonation_readonly` = an
 * expected preview no-op. Never throws.
 */
export async function mutate<T = { id: string }>(build: () => any, returning = "id"): Promise<SaveResult<T>> {
  if (impersonatingReadonly()) return { ok: false, reason: "impersonation_readonly" }; // never build the write

  let builder: any;
  try {
    builder = build();
  } catch (e: any) {
    // Construction threw — an impersonation toggle in the check→build window, or a caller bug.
    if (impersonatingReadonly() || IMPERSONATION_RE.test(e?.message ?? "")) {
      return { ok: false, reason: "impersonation_readonly" };
    }
    return { ok: false, reason: "error", message: e?.message ?? String(e) };
  }

  try {
    const { data, error } = await builder.select(returning).maybeSingle();
    if (error) return { ok: false, reason: "error", message: error.message };
    if (data == null) return { ok: false, reason: "not_saved" }; // 0 rows, no error = RLS-filtered no-op
    return { ok: true, row: data as T };
  } catch (e: any) {
    const message = e?.message ?? String(e);
    if (IMPERSONATION_RE.test(message)) return { ok: false, reason: "impersonation_readonly" };
    return { ok: false, reason: "error", message };
  }
}

/**
 * Guarded MULTI-row write (bulk `.in(...)` / `.neq(...)`). Pass a THUNK. Appends `.select()` and
 * reports the number of rows actually written — so a partial RLS filter (some rows silently dropped)
 * surfaces as `partial` with its `count`, and a total no-op as `not_saved`, not a blanket "all N saved".
 */
export async function mutateMany<T = { id: string }>(
  build: () => any,
  opts?: { expected?: number; returning?: string },
): Promise<SaveManyResult<T>> {
  if (impersonatingReadonly()) return { ok: false, reason: "impersonation_readonly" };

  let builder: any;
  try {
    builder = build();
  } catch (e: any) {
    if (impersonatingReadonly() || IMPERSONATION_RE.test(e?.message ?? "")) {
      return { ok: false, reason: "impersonation_readonly" };
    }
    return { ok: false, reason: "error", message: e?.message ?? String(e) };
  }

  try {
    const { data, error } = await builder.select(opts?.returning ?? "id");
    if (error) return { ok: false, reason: "error", message: error.message };
    const rows = (data ?? []) as T[];
    if (rows.length === 0) return { ok: false, reason: "not_saved", count: 0 };
    if (opts?.expected != null && rows.length < opts.expected) {
      return { ok: false, reason: "partial", count: rows.length };
    }
    return { ok: true, rows };
  } catch (e: any) {
    const message = e?.message ?? String(e);
    if (IMPERSONATION_RE.test(message)) return { ok: false, reason: "impersonation_readonly" };
    return { ok: false, reason: "error", message };
  }
}

/**
 * `mutate` + a toast, the convenience for the ~107 write→toast sites. Success toasts `opts.success`
 * (if given); a real failure toasts `opts.failure` (or the DB message); an impersonation no-op is
 * silent (the guard already toasted). Returns the `SaveResult` so callers can still branch.
 */
export async function saveWithToast<T = { id: string }>(
  build: () => any,
  opts?: { success?: string; failure?: string; returning?: string },
): Promise<SaveResult<T>> {
  const r = await mutate<T>(build, opts?.returning);
  if (r.ok) {
    if (opts?.success) toast.success(opts.success);
  } else if (r.reason !== "impersonation_readonly") {
    toast.error(opts?.failure ?? r.message ?? "Saqlab bo'lmadi");
  }
  return r;
}
