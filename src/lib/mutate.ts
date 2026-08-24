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
 * IMPERSONATION: while an admin previews as a student, src/lib/impersonationGuard.ts turns every write
 * into a rejected promise (and already toasts "Read-only"). `mutate` detects that and returns an
 * EXPECTED no-op (`impersonation_readonly`) — callers must NOT toast or beacon it (a naive "beacon on
 * write failure" here would flag every teacher/admin lesson preview as a bogus error). The rejected
 * promise is consumed so it can never surface as an unhandledrejection (which would itself beacon).
 *
 * USAGE (single-row write — update/insert/upsert/delete BY id, pass the builder BEFORE `.select()`):
 *   const r = await mutate(supabase.from("groups").update({ teacher_id }).eq("id", id));
 *   if (!r.ok && r.reason !== "impersonation_readonly") toast.error("Saqlanmadi");
 * Or use `saveWithToast(...)` which wires the toast + the impersonation exception for you.
 * For multi-row writes (`.in(...)` bulk) use `mutateMany` so a partial RLS filter is caught.
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

/** Consume the impersonation-guard's rejected promise so it can't become an unhandledrejection. */
async function drain(builder: unknown): Promise<void> {
  try {
    await Promise.resolve(builder as PromiseLike<unknown>);
  } catch {
    /* expected: read-only impersonation rejection */
  }
}

/**
 * Guarded SINGLE-row write. Pass a Supabase update/insert/upsert/delete builder (before `.select()`).
 * Returns `{ ok:true, row }`, or `{ ok:false, reason }` where `not_saved` = a 0-row (RLS-filtered)
 * write, `error` = a real DB/transport error, `impersonation_readonly` = an expected preview no-op.
 */
export async function mutate<T = { id: string }>(builder: any, returning = "id"): Promise<SaveResult<T>> {
  if (impersonatingReadonly()) {
    await drain(builder);
    return { ok: false, reason: "impersonation_readonly" };
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
 * Guarded MULTI-row write (bulk `.in(...)` / `.neq(...)`). Appends `.select()` and reports the number
 * of rows actually written — so a partial RLS filter (some rows silently dropped) surfaces as
 * `partial` with its `count`, and a total no-op as `not_saved`, instead of a blanket "all N saved".
 */
export async function mutateMany<T = { id: string }>(
  builder: any,
  opts?: { expected?: number; returning?: string },
): Promise<SaveManyResult<T>> {
  if (impersonatingReadonly()) {
    await drain(builder);
    return { ok: false, reason: "impersonation_readonly" };
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
  builder: any,
  opts?: { success?: string; failure?: string; returning?: string },
): Promise<SaveResult<T>> {
  const r = await mutate<T>(builder, opts?.returning);
  if (r.ok) {
    if (opts?.success) toast.success(opts.success);
  } else if (r.reason !== "impersonation_readonly") {
    toast.error(opts?.failure ?? r.message ?? "Saqlab bo'lmadi");
  }
  return r;
}
