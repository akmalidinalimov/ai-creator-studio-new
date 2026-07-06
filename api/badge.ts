// Vercel Node serverless function — Soft Monoliths badge renderer.
// satori (SVG) + @resvg/resvg-js (native → PNG). Node runtime = ample memory,
// no wasm limits, no JSX. GET /api/badge?key=streak_7&name=Aziz[&m=1] → PNG.
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

const FOOTER = "AICREATOR.ACADEMY - ONLINE AI KURSI";
const MODULE_LINES: Record<number, string> = {
  1: "ChatGPT — endi sizning qurolingiz.",
  2: "Tasavvuringizdagi har qanday rasmni yaratasiz.",
  3: "Pro video ishlab chiqarish — endi qo'lingizda.",
  4: "Ishni AI'ga topshirdingiz — vaqtingiz o'zingizniki.",
  5: "Bilim — endi daromadga aylanadi.",
  6: "O'z multfilmingizni yaratadigan darajadasiz.",
  7: "Kameradan qo'rqmaysiz — avataringiz siz uchun gapiradi.",
  8: "Butun jarayonni avtomatlashtirdingiz — tizim siz uchun ishlaydi.",
};
type P = { gold: boolean; glyph: string; title: string; top: string; bold: string; chip: string };
const PRESETS: Record<string, P> = {
  first_lesson:    { gold: false, glyph: "🚀", title: "YO'L BOSHLANDI",   top: "Eng qiyini — boshlash edi.",              bold: "Siz boshladingiz.",                chip: "📚 Birinchi dars ✓" },
  first_homework:  { gold: false, glyph: "✍️", title: "BIRINCHI ISH",      top: "Endi siz tomoshabin emassiz —",           bold: "yaratuvchisiz.",                   chip: "✍️ Birinchi vazifa topshirildi" },
  five_lessons:    { gold: false, glyph: "📗", title: "5 DARS ✓",          top: "Odat shakllanmoqda.",                     bold: "Natija yaqin.",                    chip: "📚 5 dars tugallandi" },
  ten_lessons:     { gold: false, glyph: "📚", title: "10 DARS ✓",         top: "10 dars — bu 10 ta qaror.",               bold: "Siz har safar «ha» dedingiz.",     chip: "📚 10 dars tugallandi" },
  module_complete: { gold: false, glyph: "✅", title: "{n}-MODUL TAMOM",   top: "Siz buni qildingiz.",                     bold: "{module}",                          chip: "🎓 Modul sertifikati bilan" },
  streak_7:        { gold: true,  glyph: "🔥", title: "7 KUN",             top: "Bir hafta — bir kun ham tashlamadingiz.", bold: "Bu — xarakter.",                   chip: "🔥 7 kunlik streak" },
  streak_14:       { gold: true,  glyph: "🔥", title: "14 KUN",            top: "Ikki hafta uzluksiz.",                    bold: "Bu endi odat emas — bu SIZ.",      chip: "🔥 14 kunlik streak" },
  streak_30:       { gold: true,  glyph: "🔥", title: "30 KUN",            top: "Siz 1% ichidasiz.",                       bold: "Bunday sabr — chempionlarda.",     chip: "👑 Oltin streak — noyob" },
  perfect_score:   { gold: false, glyph: "💯", title: "10/10",             top: "Ustoz «mukammal» dedi.",                  bold: "Boshqa so'z kerak emas.",          chip: "💯 Mukammal baho" },
  group_top3:      { gold: false, glyph: "🏆", title: "GURUHDA TOP-3",     top: "O'z guruhingizda eng yaxshilardansiz.",   bold: "Buni hamma bilsin.",               chip: "🏆 Haftalik guruh reytingi" },
  level_5:         { gold: false, glyph: "⚡", title: "5-DARAJA",          top: "1000 XP. Bu tasodif emas —",              bold: "bu mehnat.",                       chip: "⚡ Master yo'lida" },
  course_complete: { gold: true,  glyph: "🎓", title: "KURS TAMOM",        top: "Boshlagan va tugatgan — ikki xil inson.", bold: "Bugun siz ikkinchisisiz.",         chip: "🎓 AI Creators bitiruvchisi" },
  ambassador:      { gold: false, glyph: "🏅", title: "AMBASSADOR",        top: "Yutuqlaringiz bilan boshqalarga",         bold: "yo'l ko'rsatyapsiz.",              chip: "🏅 Birinchi ulashgan story uchun" },
};

let fontsP: Promise<any[]> | null = null;
const fontUrl = (w: number) => `https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.16/files/inter-latin-${w}-normal.woff`;
function loadFonts() {
  if (!fontsP) fontsP = Promise.all([400, 700].map(async (w) => ({ name: "Inter", data: await (await fetch(fontUrl(w))).arrayBuffer(), weight: w, style: "normal" })));
  return fontsP;
}

const emojiCache = new Map<string, string>();
async function loadEmoji(seg: string): Promise<string> {
  const cp = Array.from(seg).map((c) => c.codePointAt(0)!.toString(16)).filter((h) => h !== "fe0f").join("-");
  if (emojiCache.has(cp)) return emojiCache.get(cp)!;
  const buf = await fetch(`https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${cp}.png`).then((r) => r.ok ? r.arrayBuffer() : null);
  const uri = buf ? `data:image/png;base64,${Buffer.from(buf).toString("base64")}` : "";
  emojiCache.set(cp, uri);
  return uri;
}

const el = (type: string, style: any, children?: any) => ({ type, props: { style, ...(children !== undefined ? { children } : {}) } });
const txt = (s: string, style: any) => el("div", { display: "flex", ...style }, s);

function tree(c: any) {
  const ground = c.gold
    ? "radial-gradient(90% 46% at 50% 20%, #4A3A14 0%, #1E1A0C 52%, #0F0D06 100%)"
    : "radial-gradient(90% 46% at 50% 20%, #16453C 0%, #0C231F 52%, #08100F 100%)";
  const monoBg = c.gold ? "linear-gradient(150deg,#E6C878,#B8860B 60%,#8A6508)" : "linear-gradient(150deg,#2FB39B 0%,#177564 55%,#0E4A40 100%)";
  const glow = c.gold ? "0 0 160px 24px rgba(216,180,90,.42)" : "0 0 160px 24px rgba(47,179,155,.32)";
  const eb = c.gold ? "#D8B45A" : "#7FC7B5";
  return el("div", { width: 1080, height: 1920, display: "flex", flexDirection: "column", alignItems: "center", background: ground, fontFamily: "Inter", padding: "150px 90px 120px" }, [
    el("div", { width: 300, height: 300, borderRadius: 76, background: monoBg, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: glow, marginBottom: 70 }, txt(c.glyph, { fontSize: 150 })),
    txt(c.eyebrow, { fontSize: 26, letterSpacing: 10, color: eb, fontWeight: 700, marginBottom: 14 }),
    txt(c.title, { fontSize: 100, fontWeight: 700, color: "#E9C971", letterSpacing: -2, marginBottom: 18 }),
    el("div", { width: 120, height: 5, borderRadius: 3, background: "#D8B45A", marginBottom: 44 }),
    txt(c.name, { fontSize: 60, fontWeight: 700, color: "#FFFFFF", marginBottom: 22 }),
    txt(c.top, { fontSize: 34, color: "#A9CCC2", marginBottom: 8 }),
    txt(c.bold, { fontSize: 37, fontWeight: 700, color: "#E8F5F0", marginBottom: 60 }),
    el("div", { display: "flex", border: "2px solid rgba(216,180,90,.4)", background: "rgba(216,180,90,.08)", borderRadius: 999, padding: "16px 36px" }, txt(c.chip, { fontSize: 30, color: "#E9C971", fontWeight: 700 })),
    el("div", { display: "flex", flexGrow: 1 }),
    txt("AI Creators", { fontSize: 34, fontWeight: 700, color: "#CFE8DF", marginBottom: 10 }),
    txt(FOOTER, { fontSize: 22, letterSpacing: 4, color: "#5E8B7F" }),
  ]);
}

export default async function handler(req: any, res: any) {
  try {
    const q = req.query || {};
    const key = String(q.key || "first_lesson");
    const name = String(q.name || "Talaba");
    const n = Number(q.m || "1");
    const p = PRESETS[key] || PRESETS.first_lesson;
    const card = {
      gold: p.gold, glyph: p.glyph, name,
      title: p.title.replace("{n}", String(n)),
      top: p.top,
      bold: p.bold === "{module}" ? (MODULE_LINES[n] ?? MODULE_LINES[1]) : p.bold,
      chip: p.chip,
      eyebrow: p.gold ? "AI CREATORS · OLTIN YUTUQ" : "AI CREATORS · YUTUQ",
    };
    const fonts = await loadFonts();
    const svg = await satori(tree(card) as any, { width: 1080, height: 1920, fonts, loadAdditionalAsset: async (code: string, seg: string) => code === "emoji" ? await loadEmoji(seg) : seg });
    const png = new Resvg(svg).render().asPng();
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.status(200).send(Buffer.from(png));
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  }
}
