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
