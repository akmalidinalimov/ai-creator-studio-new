// Pure profile-resolution logic for the Mini App auth bridge — no I/O, fully unit-testable via injected
// deps. This is where the auth-model security decisions live:
//
//   1. telegram_id already linked → sign in directly (signed id = proof of ownership; no gate).
//   2. else match a STUDENT-role, telegram_id-null profile by username → membership-gate it against that
//      profile's OWN group chat. Member → backfill + first-link admin alert + sign in. Non-member OR
//      indeterminate (getChatMember error) → not_linked (FAIL CLOSED).
//   3. else → not_linked.
//
// Staff (teacher/admin/superadmin) profiles are NEVER matched here — findStudentUsernameOnly filters to
// role='student' (a squatter claiming an unlinked staff username would otherwise be privilege escalation,
// cso Finding 2). Ambiguous (>1) username → not_linked.

export type ResolveOutcome =
  | { kind: "signin"; profileId: string; email: string; backfilled: boolean }
  | { kind: "not_linked" };

export interface StudentMatch {
  id: string;
  email: string;
  group_id: string | null;
  group_chat_id: number | null;
}

export interface ResolveDeps {
  /** Profile already linked to this telegram_id (any role). */
  findByTelegramId(tgId: number): Promise<{ id: string; email: string } | null>;
  /** Exactly-one STUDENT profile with telegram_id IS NULL and this (lowercased) username; `{ambiguous}` if >1. */
  findStudentUsernameOnly(username: string): Promise<StudentMatch | { ambiguous: true } | null>;
  /** getChatMember → true=member, false=not, null=indeterminate (caller fails closed on null). */
  isMember(chatId: number, tgId: number): Promise<boolean | null>;
  linkTelegramId(profileId: string, tgId: number, username?: string): Promise<void>;
  alertFirstLink(profileId: string, tgId: number, username?: string): Promise<void>;
}

export async function resolveProfile(
  deps: ResolveDeps,
  user: { id: number; username?: string },
): Promise<ResolveOutcome> {
  // 1. Direct telegram_id link — no gate needed (signed id).
  const linked = await deps.findByTelegramId(user.id);
  if (linked) return { kind: "signin", profileId: linked.id, email: linked.email, backfilled: false };

  // 2. Username-backfill (student-only), gated by membership.
  const uname = (user.username || "").replace(/^@+/, "").toLowerCase();
  if (!uname) return { kind: "not_linked" };

  const match = await deps.findStudentUsernameOnly(uname);
  if (!match || (match as { ambiguous?: true }).ambiguous) return { kind: "not_linked" };
  const m = match as StudentMatch;
  if (!m.group_chat_id) return { kind: "not_linked" }; // no group chat to verify against → fail closed

  const member = await deps.isMember(m.group_chat_id, user.id);
  if (member !== true) return { kind: "not_linked" }; // false OR null → fail closed

  await deps.linkTelegramId(m.id, user.id, user.username);
  await deps.alertFirstLink(m.id, user.id, user.username);
  return { kind: "signin", profileId: m.id, email: m.email, backfilled: true };
}
