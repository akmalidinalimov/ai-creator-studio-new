// 🤖 The assistant's words (Uzbek, warm, short). Platform answers are templates filled from facts the database gave
// (question_assist_platform_facts) — the AI never writes them; how-to answers come verbatim from support_kb.

import { escCap } from "../_shared/support-agent-card.ts";

export const SITE = "aicreator.academy";

export type Facts = {
  account: { found: boolean; active: boolean; telegram_linked: boolean; in_this_group: boolean; enrolled: boolean;
             open_modules: number; total_modules: number };
  mine_24h: { module_locked: number; backend_unreachable: number; stale_app: number; video_error: number };
  platform: { video_error_users: number; unreachable_users: number; crash_users: number;
              open_incident: { id: number; kind: string } | null };
};

export type PlatformAnswer = {
  kind: "incident" | "not_found" | "needs_admin" | "module_locked" | "network" | "stale_app" | "video_error" | "no_issue";
  html: string;
  needsAdmin: boolean;
  /** a NEW platform-wide incident to open (kind), or the id of the open one this question joins */
  incident?: { open?: string; join?: number };
};

const STEPS_NETWORK = "1. Wi-Fi ↔ mobil internetni almashtiring\n2. VPN yoqilgan boʻlsa — oʻchirib koʻring (yoki aksincha)\n3. Telegramni toʻliq yopib, qayta oching";
const STEPS_APP = "1. Telegramni toʻliq yoping (orqa fondan ham)\n2. Qayta ochib, darsni yana oching\n3. Telegram ilovasini yangilang (App Store / Play Market)";

/** The answer for a platform problem, from the facts only. `globalUsers` = how many students failing at once is "global". */
export function platformAnswer(f: Facts, globalUsers: number): PlatformAnswer {
  const p = f.platform;
  // 1. the platform itself: many students failing at the same time
  if (p.open_incident) {
    return { kind: "incident", needsAdmin: false, incident: { join: p.open_incident.id },
      html: "Hozir platformada texnik nosozlik bor — bir nechta oʻquvchida shunday boʻlyapti. Jamoamiz hal qilyapti 🙏\n\nTuzalishi bilan shu yerda xabar beramiz." };
  }
  const globalKind = p.video_error_users >= globalUsers ? "video_error"
    : p.unreachable_users >= globalUsers ? "unreachable" : p.crash_users >= globalUsers ? "crash" : null;
  if (globalKind) {
    return { kind: "incident", needsAdmin: true, incident: { open: globalKind },
      html: "Hozir platformada texnik nosozlik bor — bir nechta oʻquvchida shunday boʻlyapti. Jamoamiz hal qilyapti 🙏\n\nTuzalishi bilan shu yerda xabar beramiz." };
  }
  // 2. their account
  const a = f.account;
  if (!a.found || !a.telegram_linked) {
    return { kind: "not_found", needsAdmin: false,
      html: "Botda hisobingiz topilmadi 🤔\n\nIltimos, AI Creators botiga <b>/start</b> yuboring — u sizni avtomatik taniydi. " +
        "Baribir ochilmasa, botdagi «❓ Yordam» tugmasi orqali yozing." };
  }
  if (!a.active || !a.enrolled) {
    return { kind: "needs_admin", needsAdmin: true,
      html: "Hisobingizni tekshirish kerak koʻrinadi — admin koʻrib chiqib, sizga yozadi 🙏" };
  }
  const m = f.mine_24h;
  if (m.module_locked > 0) {
    return { kind: "module_locked", needsAdmin: false,
      html: `Siz ochmoqchi boʻlgan dars hali yopiq modulda 🔒\n\nHozir sizga <b>1–${a.open_modules}-modullar</b> ochiq. ` +
        "Keyingi modul jadval boʻyicha ochiladi — «MUHIM EʼLONLAR»ni kuzatib boring 🙂" };
  }
  if (m.backend_unreachable > 0) {
    return { kind: "network", needsAdmin: false,
      html: `Telefoningiz platformaga ulana olmayapti — bu odatda internet bilan bogʻliq 📶\n\nQuyidagilarni sinab koʻring:\n${STEPS_NETWORK}` };
  }
  if (m.stale_app > 0) {
    return { kind: "stale_app", needsAdmin: false,
      html: `Ilovaning eski versiyasi qolib ketgan koʻrinadi 🔄\n\n${STEPS_APP}` };
  }
  if (m.video_error > 0) {
    return { kind: "video_error", needsAdmin: false,
      html: `Video pleyerda xatolik boʻldi 🎬\n\n1. Boshqa internetga ulanib koʻring (Wi-Fi ↔ mobil)\n2. Telegramni yopib, qayta oching\n3. Boʻlmasa, darsni kompyuter brauzerida oching: ${SITE}` };
  }
  // 3. nothing wrong on our side
  return { kind: "no_issue", needsAdmin: false,
    html: "Hisobingizda muammo topilmadi ✅ — darslar sizga ochiq.\n\nShu qadamlarni sinab koʻring:\n" +
      "1. Internetni oʻchirib-yoqing yoki Wi-Fi ↔ mobil internetni almashtiring\n2. Telegramni toʻliq yopib, qayta oching\n" +
      `3. Telegram ilovasini yangilang\n4. Darsni brauzerda oching: ${SITE}` };
}

/** The reply posted in the topic (live, or a curator's ✅ in the trial). */
export function topicReply(answerHtml: string): string {
  return `🤖 <b>Yordamchi</b>\n\n${answerHtml}\n\n<i>Yordam bermasa — pastdagi tugmani bosing, kurator javob beradi.</i>`;
}

export const HELP_BUTTON = (id: number) => ({ inline_keyboard: [[{ text: "❌ Yordam bermadi", callback_data: `qa:n:${id}` }]] });

/** The trial card to the group's curators. */
export function curatorCard(o: { id: number; group: string; student: string; question: string; draft: string; why: string }): string {
  const q = String(o.question ?? "").replace(/\s+/g, " ").trim();
  return `🤖 <b>Yordamchi taklifi</b> · #${o.id} · ${escCap(o.group, 40)}\n👤 ${escCap(o.student || "Oʻquvchi", 60)}\n` +
    `❓ ${q ? `«${escCap(q, 400)}»` : "<i>(rasm/fayl)</i>"}\n\n<b>Javob loyihasi:</b>\n${o.draft}\n\n` +
    `<i>${escCap(o.why, 200)}</i>\n<i>Sinov rejimi: «✅ Yuborish» — javob guruhda savolga reply boʻlib chiqadi.</i>`;
}

export const CARD_BUTTONS = (id: number) => ({ inline_keyboard: [
  [{ text: "✅ Yuborish", callback_data: `qa:s:${id}` }, { text: "❌ Kerak emas", callback_data: `qa:x:${id}` }],
  [{ text: "✍️ Oʻzim yozaman", callback_data: `tq:r:${id}` }],
] });

export const INCIDENT_FIXED = "✅ Texnik nosozlik bartaraf etildi — iltimos, qayta urinib koʻring 🙏";

export const CATEGORY_UZ: Record<string, string> = {
  platform_issue: "platforma muammosi", tool_howto: "vosita / obuna savoli", course_logistics: "kurs tartibi",
  learning: "oʻquv savoli", chatter: "suhbat",
};
