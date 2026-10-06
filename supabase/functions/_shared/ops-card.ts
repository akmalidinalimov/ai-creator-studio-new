// The ops-agent PR approve card — ONE definition for every sender (support auto-resolver plan, PR0, 2026-10-06).
//
// The bot's ops: flow (telegram-bot-webhook/ops-approve.ts) can verify, check CI and merge an ops-agent PR from
// Telegram, but nothing told the owner that such a PR existed: ops-notify could carry the keyboard, yet its only
// caller (deploy-supabase.yml) never passes a pr. ops-agent-log — which the ops-investigate workflow already calls
// with {outcome_type:'pr', outcome_ref:<number>} after every run — now sends this card once per PR.
//
// Recipients: _shared/admin-recipients.ts (two queries; an embed returns nobody). Sends: sendTelegram (every
// non-delivery recorded). Callback data ops:a:<pr> / ops:reject:<pr> stays well under 64 bytes.
import { adminTelegramIds } from "./admin-recipients.ts";
import { sendTelegram } from "./telegram-send.ts";

// deno-lint-ignore no-explicit-any
type Db = any;

export const OPS_REPO_URL = "https://github.com/akmalidinalimov/ai-creator-studio-new";

/** A PR number we are willing to put on a button: 1..999999. */
export function opsPrNumber(v: unknown): number | null {
  const n = typeof v === "string" && /^\d{1,6}$/.test(v.trim()) ? Number(v.trim()) : typeof v === "number" ? v : NaN;
  return Number.isInteger(n) && n > 0 && n < 1_000_000 ? n : null;
}

export function opsApproveKeyboard(pr: number) {
  return {
    inline_keyboard: [
      [{ text: "✅ Ko'rib tasdiqlash", callback_data: `ops:a:${pr}` }, { text: "❌ Rad etish", callback_data: `ops:reject:${pr}` }],
      [{ text: `🔍 PR #${pr} ni ochish`, url: `${OPS_REPO_URL}/pull/${pr}` }],
    ],
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The card text for a freshly opened ops-agent PR (HTML, < 4096). */
export function opsPrCardText(pr: number, problem: string | null | undefined): string {
  const p = String(problem ?? "").trim();
  return `🤖 <b>Ops-agent PR ochdi: #${pr}</b>\n\n` +
    (p ? `<b>Muammo:</b> ${esc(p.slice(0, 1500))}${p.length > 1500 ? "…" : ""}\n\n` : "") +
    "Tekshirib, CI yashil boʻlsa — «✅ Koʻrib tasdiqlash» (ikki bosqichda birlashtiriladi).";
}

/** Send `text` (+ the approve keyboard when `pr` is set) to the admins. Never throws. */
export async function sendOpsCard(
  admin: Db, botToken: string, text: string, pr: number | null, purpose: string,
): Promise<{ sent: number; recipients: number; error: string | null }> {
  const rec = await adminTelegramIds(admin, { limit: 3 });
  let sent = 0;
  for (const chat of rec.ids) {
    const out = await sendTelegram(botToken, "sendMessage", {
      chat_id: chat, text: text.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true,
      ...(pr ? { reply_markup: opsApproveKeyboard(pr) } : {}),
    }, { admin, purpose, recipientId: chat });
    if (out.ok) sent++;
  }
  return { sent, recipients: rec.ids.length, error: rec.error };
}
