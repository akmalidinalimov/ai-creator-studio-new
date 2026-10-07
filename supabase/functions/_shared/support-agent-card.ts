// The support auto-resolver's proposal card — ONE definition for the worker (supabase/functions/support-agent, which
// sends it) and the bot (telegram-bot-webhook, which handles its buttons and re-renders the keyboard).
//
// Callback data (≤ 64 bytes; the proposal id is a bigserial):
//   sa:a:<id>  approve. A proposal WITH an action asks once more (sa:c / sa:n); a reply-only one sends at once.
//   sa:c:<id>  confirmed: run support_apply_fix, then reply to the student
//   sa:n:<id>  not now: back to the first keyboard
//   sa:r:<id>  reject: nothing runs, nothing is sent
// The ✏️ button reuses the ticket flow (sup:r:<ticket>: the admin writes the answer).

export type SaAction = "approve" | "confirm" | "back" | "reject";

export function parseSaCallback(data: string): { action: SaAction; id: number } | null {
  const m = /^sa:([acnr]):(\d{1,15})$/.exec(String(data ?? ""));
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const action: SaAction = m[1] === "a" ? "approve" : m[1] === "c" ? "confirm" : m[1] === "n" ? "back" : "reject";
  return { action, id };
}

export type ProposalKind = { id: number; ticketId: number; action: string | null; hasReply: boolean };

/** The first keyboard under a proposal card. */
export function proposalKeyboard(p: ProposalKind) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  if (p.action) {
    rows.push([{ text: "✅ Tasdiqlash va bajarish", callback_data: `sa:a:${p.id}` }, { text: "❌ Rad etish", callback_data: `sa:r:${p.id}` }]);
  } else if (p.hasReply) {
    rows.push([{ text: "📨 Javobni yuborish", callback_data: `sa:a:${p.id}` }, { text: "❌ Rad etish", callback_data: `sa:r:${p.id}` }]);
  } else {
    rows.push([{ text: "❌ Yopish", callback_data: `sa:r:${p.id}` }]);
  }
  rows.push([{ text: "✏️ Oʻzim yozaman", callback_data: `sup:r:${p.ticketId}` }]);
  return { inline_keyboard: rows };
}

/** The second step of a data change: are you sure? */
export function confirmKeyboard(id: number) {
  return { inline_keyboard: [[{ text: "✅ Ha, bajarish", callback_data: `sa:c:${id}` }, { text: "↩️ Yoʻq", callback_data: `sa:n:${id}` }]] };
}

/** What a whitelisted action does, for the admin (Uzbek). */
export function actionLabel(action: string | null): string {
  switch (action) {
    case "assign_group": return "oʻquvchini toʻgʻri guruhga biriktirish";
    case "heal_split": return "boʻsh ikkinchi hisobni arxivlash, guruhni bot hisobiga oʻtkazish";
    case "set_account_type": return "hisobni «paid» qilish (darslar ochiladi)";
    case "reconcile_points": return "ballarni qayta hisoblash";
    default: return "faqat javob (maʼlumot oʻzgarmaydi)";
  }
}

export function escapeHtml(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape, keeping the ESCAPED result within `max` (never cuts an entity in half); "…" when cut. */
export function escCap(s: string, max: number): string {
  let out = "";
  for (const ch of String(s ?? "")) {
    const e = ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch;
    if (out.length + e.length > max - 1) return out + "…";
    out += e;
  }
  return out;
}

/** The proposal card (HTML). Every part is capped AFTER escaping, so the whole stays < 3500 characters. */
export function proposalCard(p: {
  ticketId: number; who: string; group: string | null; evidence: string; action: string | null; confidence: string;
  summary: string | null; reply: string | null; locale: string; ruleId: string; codeBug: boolean;
}): string {
  const lines = [
    `🤖 <b>#${p.ticketId} tashxis</b> — ${escCap(p.who, 160)}${p.group ? ` · ${escCap(p.group, 100)}` : ""}`,
    `<b>Sabab:</b> ${escCap(p.evidence || "aniqlanmadi", 900)}`,
    `<b>Taklif:</b> ${escapeHtml(actionLabel(p.action))} · ishonch: ${escCap(p.confidence, 20)} · ${escCap(p.ruleId, 40)}`,
  ];
  if (p.codeBug) lines.push("🛠 Kod muammosi boʻlishi mumkin — takrorlansa, ops-agentga yuboriladi.");
  if (p.summary) lines.push("", `<i>${escCap(p.summary, 600)}</i>`);
  if (p.reply) lines.push("", `<b>Oʻquvchiga javob (${escCap(p.locale, 4)}):</b>`, `<blockquote>${escCap(p.reply, 1200)}</blockquote>`);
  return lines.join("\n");
}
