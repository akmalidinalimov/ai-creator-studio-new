// "The admins who get ops alerts", for edge functions: ONE definition, so a new watchdog cannot quietly pick a query
// that returns nobody.
//
// Admins = user_roles.role in ('admin', 'superadmin') → profiles.telegram_id (not null), deduplicated. The same set
// as challenge_tasks_admin_dm() and ops-notify.
//
// WHY TWO QUERIES AND NOT A POSTGREST EMBED. profiles and user_roles share no foreign key (user_roles.user_id and
// profiles.id both reference auth.users), so `from("profiles").select("telegram_id, user_roles!inner(role)")` is a
// schema-cache error — HTTP 400 PGRST200 "Could not find a relationship between 'profiles' and 'user_roles'" — on
// every call, for the service role too. canary (since 2026-07-05), reputation-check (since 2026-07-21) and the
// first draft of frontend-deploy-watchdog used exactly that embed, ignored or swallowed the error, and DMed their
// alerts to nobody (verified against prod 2026-10-01). The footgun lint (Rule 5) now forbids the embed.
//
// A failed read is returned as `error`, never thrown and never reported as "no admins": the caller must make it
// DB-visible (an alert that reaches nobody is the failure this module exists to stop).

// A service-role Supabase client (typed loosely, like the rest of the codebase).
// deno-lint-ignore no-explicit-any
type Db = any;

export const ADMIN_ROLES = ["admin", "superadmin"] as const;

export type AdminRecipients = { ids: number[]; error: string | null };

/** Pure: Telegram chat ids from profile rows — numeric, non-zero, deduplicated, in row order. */
export function toChatIds(rows: unknown): number[] {
  const out: number[] = [];
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const raw = r && typeof r === "object" ? (r as { telegram_id?: unknown }).telegram_id : null;
    if (raw === null || raw === undefined || raw === "") continue;
    const id = Number(raw);
    if (Number.isSafeInteger(id) && id !== 0 && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The admins' Telegram chat ids. `limit` caps how many (challenge_tasks_admin_dm() uses 3). Never throws. */
export async function adminTelegramIds(admin: Db, opts: { limit?: number } = {}): Promise<AdminRecipients> {
  try {
    const roles = await admin.from("user_roles").select("user_id").in("role", [...ADMIN_ROLES]);
    if (roles.error) return { ids: [], error: `user_roles: ${String(roles.error.message ?? roles.error)}`.slice(0, 200) };
    const userIds = [
      ...new Set(
        ((roles.data ?? []) as { user_id?: unknown }[])
          .map((r) => r?.user_id)
          .filter((x): x is string => typeof x === "string" && x.length > 0),
      ),
    ];
    if (!userIds.length) return { ids: [], error: null };
    const profs = await admin.from("profiles").select("id, telegram_id").in("id", userIds).not("telegram_id", "is", null);
    if (profs.error) return { ids: [], error: `profiles: ${String(profs.error.message ?? profs.error)}`.slice(0, 200) };
    const ids = toChatIds(profs.data);
    return { ids: opts.limit && opts.limit > 0 ? ids.slice(0, opts.limit) : ids, error: null };
  } catch (e) {
    return { ids: [], error: `threw: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  }
}
