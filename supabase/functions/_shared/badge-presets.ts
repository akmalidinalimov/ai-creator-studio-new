// Soft Monoliths — achievement badge presets (single source of truth).
// The renderer fills exactly two dynamic inputs: {name} always, and {module_no}
// only for the module_complete preset. Everything else is frozen here.
//
// Design: 9:16 (1080×1920) story cards, deep-teal ground, one clay-3D monolith,
// gold engraving. gold=true → OLTIN YUTUQ (bronze ground + gold monolith),
// reserved for the streak ladder (7·14·30) + course completion.

export const BADGE_FOOTER = "AICREATOR.ACADEMY - ONLINE AI KURSI";
export const EYEBROW = "AI CREATORS · YUTUQ";
export const EYEBROW_GOLD = "AI CREATORS · OLTIN YUTUQ";

// Module-completion is the one multi-variable card: headline = "{n}-MODUL TAMOM",
// bold line = MODULE_LINES[n]. Topics pulled from the modules table; lines are
// fixed here (1–8 cover both AI CREATORS 4.0 and 5.0, which share topics).
export const MODULE_LINES: Record<number, string> = {
  1: "ChatGPT — endi sizning qurolingiz.",
  2: "Tasavvuringizdagi har qanday rasmni yaratasiz.",
  3: "Pro video ishlab chiqarish — endi qo'lingizda.",
  4: "Ishni AI'ga topshirdingiz — vaqtingiz o'zingizniki.",
  5: "Bilim — endi daromadga aylanadi.",
  6: "O'z multfilmingizni yaratadigan darajadasiz.",
  7: "Kameradan qo'rqmaysiz — avataringiz siz uchun gapiradi.",
  8: "Butun jarayonni avtomatlashtirdingiz — tizim siz uchun ishlaydi.",
};

// Pre-written share caption for the DM (student copies & pastes to their story).
export const shareCaption = (titlePlain: string) =>
  `${titlePlain} — AI Creators'da! 🚀 AI o'rganish yo'limda davom etyapman. aicreator.academy #aicreators`;

export interface BadgePreset {
  key: string;          // matches badge code / trigger key
  gold: boolean;        // OLTIN YUTUQ treatment
  icon: string;         // clay-3D PNG filename in the badge-icons bucket
  title: string;        // headline; may contain {n} for module_complete
  lnTop: string;        // faint first line
  lnBold: string;       // bold second line; "{module}" → MODULE_LINES[n]
  chip: string;         // single stat/label chip
  captionTitle: string; // plain title used in the share caption
}

// Order mirrors the approved 13-card sheet.
export const PRESETS: Record<string, BadgePreset> = {
  first_lesson:    { key: "first_lesson",    gold: false, icon: "rocket.png",   title: "YO'L BOSHLANDI",   lnTop: "Eng qiyini — boshlash edi.",            lnBold: "Siz boshladingiz.",                chip: "📚 Birinchi dars ✓",              captionTitle: "Birinchi darsni boshladim" },
  first_homework:  { key: "first_homework",  gold: false, icon: "pencil.png",   title: "BIRINCHI ISH",     lnTop: "Endi siz tomoshabin emassiz —",         lnBold: "yaratuvchisiz.",                   chip: "✍️ Birinchi vazifa topshirildi",  captionTitle: "Birinchi vazifamni topshirdim" },
  five_lessons:    { key: "five_lessons",    gold: false, icon: "book.png",     title: "5 DARS ✓",         lnTop: "Odat shakllanmoqda.",                   lnBold: "Natija yaqin.",                    chip: "📚 5 dars tugallandi",            captionTitle: "5 darsni tugatdim" },
  ten_lessons:     { key: "ten_lessons",     gold: false, icon: "books.png",    title: "10 DARS ✓",        lnTop: "10 dars — bu 10 ta qaror.",             lnBold: "Siz har safar «ha» dedingiz.",     chip: "📚 10 dars tugallandi",           captionTitle: "10 darsni tugatdim" },
  module_complete: { key: "module_complete", gold: false, icon: "check.png",    title: "{n}-MODUL TAMOM",  lnTop: "Siz buni qildingiz. 🔥",                lnBold: "{module}",                          chip: "🎓 Modul sertifikati bilan",      captionTitle: "{n}-modulni tugatdim" },
  streak_7:        { key: "streak_7",        gold: true,  icon: "fire.png",     title: "7 KUN 🔥",         lnTop: "Bir hafta — bir kun ham tashlamadingiz.", lnBold: "Bu — xarakter.",                 chip: "🔥 7 kunlik streak",              captionTitle: "7 kun ketma-ket o'qidim" },
  streak_14:       { key: "streak_14",       gold: true,  icon: "fire.png",     title: "14 KUN 🔥",        lnTop: "Ikki hafta uzluksiz.",                  lnBold: "Bu endi odat emas — bu SIZ.",      chip: "🔥 14 kunlik streak",             captionTitle: "14 kun ketma-ket o'qidim" },
  streak_30:       { key: "streak_30",       gold: true,  icon: "fire.png",     title: "30 KUN 🔥",        lnTop: "Siz 1% ichidasiz.",                     lnBold: "Bunday sabr — chempionlarda.",     chip: "👑 Oltin streak — noyob",         captionTitle: "30 kun ketma-ket o'qidim" },
  perfect_score:   { key: "perfect_score",   gold: false, icon: "hundred.png",  title: "10/10",            lnTop: "Ustoz «mukammal» dedi.",                lnBold: "Boshqa so'z kerak emas.",          chip: "💯 Mukammal baho",                captionTitle: "Vazifamga 10/10 oldim" },
  group_top3:      { key: "group_top3",      gold: false, icon: "trophy.png",   title: "GURUHDA TOP-3",    lnTop: "O'z guruhingizda eng yaxshilardansiz.", lnBold: "Buni hamma bilsin.",               chip: "🏆 Haftalik guruh reytingi",      captionTitle: "Guruhimda TOP-3 daman" },
  level_5:         { key: "level_5",         gold: false, icon: "bolt.png",     title: "5-DARAJA",         lnTop: "1000 XP. Bu tasodif emas —",            lnBold: "bu mehnat.",                       chip: "⚡ Master yo'lida",               captionTitle: "5-darajaga yetdim" },
  course_complete: { key: "course_complete", gold: true,  icon: "cap.png",      title: "KURS TAMOM",       lnTop: "Boshlagan va tugatgan — ikki xil inson.", lnBold: "Bugun siz ikkinchisisiz.",       chip: "🎓 AI Creators bitiruvchisi",     captionTitle: "AI Creators kursini tamomladim" },
  ambassador:      { key: "ambassador",      gold: false, icon: "medal.png",    title: "AMBASSADOR",       lnTop: "Yutuqlaringiz bilan boshqalarga",       lnBold: "yo'l ko'rsatyapsiz.",              chip: "🏅 Birinchi ulashgan story uchun", captionTitle: "AI Creators Ambassadoriman" },
};

/** Resolve a preset for a student, filling name + optional module number. */
export function resolveBadge(key: string, opts: { name: string; moduleNo?: number }) {
  const p = PRESETS[key];
  if (!p) return null;
  const n = opts.moduleNo ?? 1;
  const title = p.title.replace("{n}", String(n));
  const lnBold = p.lnBold === "{module}" ? (MODULE_LINES[n] ?? MODULE_LINES[1]) : p.lnBold;
  const captionTitle = p.captionTitle.replace("{n}", String(n));
  return {
    ...p,
    title,
    lnBold,
    eyebrow: p.gold ? EYEBROW_GOLD : EYEBROW,
    footer: BADGE_FOOTER,
    name: opts.name,
    caption: shareCaption(captionTitle),
  };
}
