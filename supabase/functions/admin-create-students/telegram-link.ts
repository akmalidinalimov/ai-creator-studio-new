// What to do with an incoming telegram_user_id when a row matched an EXISTING profile (pure; unit-tested).
//
// Why this exists (PR-0b, the intake identity drop): staff-intake creates students by @username only, so their
// profile has no telegram_id. When such a student posted in their group's homework topic, the bot's
// auto-register called this engine with their real telegram_user_id; the engine matched the profile by
// username in the SAME group, answered 'already_in_group' and `continue`d BEFORE the telegram_id patch, so
// the profile was never linked and the post was dropped. 'free' now links it.
//
// The fan-out found the opposite hole in the same code: the MOVE path (username match in ANOTHER group)
// wrote `patch.telegram_id = incoming` unconditionally. A telegram_id match is the same account, so a
// profile linked to a DIFFERENT account can only be reached through a USERNAME match, and usernames are not
// owned: whoever holds a stale username a linked student has since dropped could, by posting in any
// registered topic or pressing /start, re-point that student's account to themselves and move it to their
// group. For SYSTEM callers (x-internal-secret: the bot's auto-register and DM /start member path are the
// only ones that send a telegram_user_id; staff-intake and sheet-sync send none) that is now
// 'conflict_system' and the row is refused untouched. An admin (JWT) who types an id keeps today's
// behaviour: it is a deliberate correction.
export type IncomingTelegramVerdict =
  | "absent"          // no telegram_user_id in the row
  | "same"            // the profile already holds exactly this id
  | "free"            // the profile has no telegram_id: link it (guarded, when no other profile holds it)
  | "conflict_system" // system caller, profile linked to a DIFFERENT account: refuse the row, change nothing
  | "differs_admin";  // admin caller, profile linked to a different account: today's behaviour

export function incomingTelegramVerdict(
  isSystem: boolean,
  incoming: number | undefined,
  existing: number | string | null | undefined,
): IncomingTelegramVerdict {
  if (incoming === undefined) return "absent";
  if (existing === null || existing === undefined || String(existing).trim() === "") return "free";
  if (String(existing).trim() === String(incoming)) return "same";
  return isSystem ? "conflict_system" : "differs_admin";
}
