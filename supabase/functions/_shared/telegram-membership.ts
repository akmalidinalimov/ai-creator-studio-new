// Telegram getChatMember wrapper for the Mini App auth membership gate.
//
// Returns:
//   true  — the user is in the chat (creator/administrator/member/restricted-but-present)
//   false — the user is NOT a member (left/kicked)
//   null  — could not determine (Telegram API error, bot is not an admin in the chat, network failure)
//
// Callers MUST fail CLOSED on `null` (treat unknown as "not a member") — never grant access on an
// indeterminate membership check.

export type MembershipResult = boolean | null;

/**
 * What a getChatMember answer means for REGISTERING a group poster: the one rule both daily-topic registrars use
 * (the bot's autoRegisterDailyTaskPoster and challenge-tasks-worker/registrar.ts). Fail closed: anything that is not
 * positively a member is not a member. 'left' / 'kicked' (and 'restricted' with is_member false) are not members; a
 * failed probe (`ok` false) or an unknown status is 'unknown', and the caller declines it (the identity sweep retries
 * later). The chat's admins / creator are never registered as students (U4).
 */
export type MembershipVerdict = "member" | "chat_admin" | "not_member" | "unknown";

// deno-lint-ignore no-explicit-any
export function membershipVerdict(ok: boolean, result: any): MembershipVerdict {
  if (!ok) return "unknown";
  const st = String(result?.status ?? "");
  if (st === "administrator" || st === "creator") return "chat_admin";
  if (st === "member") return "member";
  // ChatMemberRestricted carries is_member: false when the user has left the chat while restricted
  if (st === "restricted") return result?.is_member === false ? "not_member" : "member";
  if (st === "left" || st === "kicked") return "not_member";
  return "unknown";
}

export async function isChatMember(
  botToken: string,
  chatId: number | string,
  telegramId: number,
): Promise<MembershipResult> {
  if (!botToken || !chatId || !telegramId) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/getChatMember`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, user_id: telegramId }),
    });
    const j = await r.json().catch(() => null);
    if (!j?.ok) return null; // e.g. "chat not found", "bot is not a member", "user not found"
    const status = j.result?.status;
    return status === "creator" || status === "administrator" || status === "member" || status === "restricted";
  } catch {
    return null;
  }
}
