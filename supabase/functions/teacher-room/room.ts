// teacher-room — the morning greeting and the evening thank-you + statistics in «KURATORLAR 6.0»
// (migration 20261011063000). Pure rendering + one runOnce with injected I/O (room.test.ts runs it with fakes);
// index.ts is the HTTP shell.
//
// Tone rules (owner: "not robotic — encourage them"): rotating hand-written openers (texts.ts), the day's REAL numbers,
// praise for the day's star and the fastest answers, and a zero is shown plainly — never singled out or commented on.

import { logHealth } from "../_shared/edge.ts";
import { escCap } from "../_shared/support-agent-card.ts";
import { ageText, shortGroup } from "../_shared/teacher-questions.ts";
import {
  EVENING_CLOSINGS, EVENING_OPENERS, MORNING_CLOSINGS, MORNING_OPENERS, pick, tashkentDayNumber, WEEKDAY_LINES,
} from "./texts.ts";

type Db = any;
export type Kind = "morning" | "evening";
export type SendFn = (method: string, payload: Record<string, unknown>) => Promise<{ ok: boolean; result: any; error: string | null }>;
export interface Io { admin: Db; send: SendFn; now: () => number }

export type GroupStat = {
  group_id: string; group_name: string;
  teachers: Array<{ id: string; name: string | null; last_name: string | null; username: string | null }>;
  graded: number; submitted: number; pending: number; asked: number; answered: number; open: number;
  oldest_min: number; median_min: number | null;
};

const TZ_MS = 5 * 3_600_000;

/** Tashkent midnight (as a UTC instant) of the day containing `nowMs`, shifted by `days`. */
export function tashkentMidnight(nowMs: number, days = 0): Date {
  const local = new Date(nowMs + TZ_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days) - TZ_MS);
}

export function tashkentDate(nowMs: number): string {
  return new Date(nowMs + TZ_MS).toISOString().slice(0, 10);
}

/** A curator's name for the group: their first name when it is a real word, else @username. */
export function curatorName(s: GroupStat): string {
  const names = s.teachers.map((t) => {
    const n = String(t.name ?? "").trim();
    if (/[\p{L}]{3,}/u.test(n) && !/^\p{L}\.$/u.test(n)) return escCap(n, 40);
    return t.username ? `@${escCap(t.username, 40)}` : "Ustoz";
  });
  return names.length ? names.join(", ") : "Ustoz";
}

function minutesText(m: number | null): string {
  if (m === null || !Number.isFinite(m)) return "";
  if (m < 1) return "1 daqiqadan kam";
  if (m < 60) return `${Math.round(m)} daqiqa`;
  return ageText(m * 60_000);
}

const sum = (xs: GroupStat[], k: "graded" | "answered" | "pending" | "open") => xs.reduce((a, s) => a + (Number(s[k]) || 0), 0);

export function renderMorning(stats: GroupStat[], nowMs: number): string {
  const day = tashkentDayNumber(nowMs);
  const dow = new Date(nowMs + TZ_MS).getUTCDay();
  const o = pick(MORNING_OPENERS, day);
  const blocks: string[] = [];

  // 1. the greeting — a bold line, the weekday line, a short paragraph
  blocks.push([`<b>${o.head}</b>`, ...(WEEKDAY_LINES[dow] ? [WEEKDAY_LINES[dow]] : []), "", o.body].join("\n"));

  // 2. yesterday
  const graded = sum(stats, "graded"), answered = sum(stats, "answered");
  if (graded + answered > 0) {
    blocks.push([
      "📊 <b>Kechagi natija</b>",
      `✅ ${graded} ta vazifa baholandi`,
      `💬 ${answered} ta savolga javob berildi`,
      "Zoʻr ish, jamoa! 👏",
    ].join("\n"));
  }

  // 3. today's queue
  const pending = sum(stats, "pending"), open = sum(stats, "open");
  if (pending + open === 0) {
    blocks.push("📌 <b>Bugungi navbat</b>\nNavbat boʻsh — ajoyib boshlanish! 🎉");
  } else {
    const rows = ["📌 <b>Bugungi navbat</b>"];
    for (const s of stats) {
      if (!s.pending && !s.open) continue;
      const bits = [s.pending ? `${s.pending} ta vazifa` : "", s.open ? `${s.open} ta savol` : ""].filter(Boolean).join(" · ");
      rows.push(`• ${shortGroup(s.group_name)} · ${curatorName(s)} — ${bits}`);
    }
    const oldest = Math.max(0, ...stats.map((s) => Number(s.oldest_min) || 0));
    if (open && oldest >= 60) rows.push("", `⏳ Eng uzoq kutayotgan savol: <b>${ageText(oldest * 60_000)}</b>`);
    blocks.push(rows.join("\n"));
  }

  blocks.push(pick(MORNING_CLOSINGS, day, 3));
  return blocks.join("\n\n");
}

export function renderEvening(stats: GroupStat[], nowMs: number): string {
  const day = tashkentDayNumber(nowMs);
  const o = pick(EVENING_OPENERS, day);
  const blocks: string[] = [`<b>${o.head}</b>\n\n${o.body}`];

  // 1. per curator
  if (stats.length) {
    blocks.push("📊 <b>Bugungi natijalar</b>");
    for (const s of stats) {
      const med = s.answered > 0 && s.median_min !== null ? ` (oʻrtacha ${minutesText(Number(s.median_min))})` : "";
      const left = [s.pending ? `${s.pending} ta vazifa` : "", s.open ? `${s.open} ta savol` : ""].filter(Boolean).join(" · ");
      blocks.push([
        `👩‍🏫 <b>${curatorName(s)}</b> · ${shortGroup(s.group_name)}`,
        `✅ Baholandi: <b>${s.graded}</b> ta vazifa`,
        `💬 Javob berildi: <b>${s.answered}</b> ta savol${med}`,
        left ? `⏳ Ertaga: ${left}` : "🎉 Navbat boʻsh!",
      ].join("\n"));
    }
  }

  // 2. the day's heroes + the team
  const heroes: string[] = [];
  const star = [...stats].sort((a, b) => b.graded - a.graded)[0];
  if (star && star.graded > 0) heroes.push(`🏆 Kun yulduzi: <b>${curatorName(star)}</b> — ${star.graded} ta vazifa`);
  const most = [...stats].sort((a, b) => b.answered - a.answered)[0];
  if (most && most.answered >= 3) heroes.push(`💬 Eng koʻp javob: <b>${curatorName(most)}</b> — ${most.answered} ta savol`);
  const fast = stats.filter((s) => s.answered >= 3 && s.median_min !== null)
    .sort((a, b) => Number(a.median_min) - Number(b.median_min))[0];
  if (fast) heroes.push(`⚡ Eng tez javoblar: <b>${curatorName(fast)}</b> — oʻrtacha ${minutesText(Number(fast.median_min))}`);
  if (heroes.length) blocks.push(["🏅 <b>Kun qahramonlari</b>", ...heroes].join("\n"));

  const graded = sum(stats, "graded"), answered = sum(stats, "answered");
  if (stats.length > 1 && graded + answered > 0) {
    blocks.push(`🤝 Jamoa boʻlib bugun: <b>${graded}</b> ta vazifa va <b>${answered}</b> ta savol`);
  }

  blocks.push(pick(EVENING_CLOSINGS, day, 5));
  return blocks.join("\n\n");
}

export async function runOnce(io: Io, kind: Kind): Promise<{ status: string; [k: string]: unknown }> {
  const { admin } = io;
  const now = io.now();
  const { data: row } = await admin.from("platform_settings").select("value").eq("key", "teacher_room").maybeSingle();
  const cfg = (row?.value ?? {}) as Record<string, unknown>;
  if (String(cfg.enabled ?? "true").toLowerCase() === "false") return { status: "disabled" };
  const chatId = Number(cfg.chat_id);
  if (!Number.isSafeInteger(chatId) || chatId === 0) {
    await logHealth(admin, "teacher_room_post_failed", { kind, error: "no chat_id" }, { source: "teacher-room" });
    return { status: "no_chat" };
  }
  const day = tashkentDate(now);
  const { data: claimed, error: claimErr } = await admin.rpc("teacher_room_claim", { _day: day, _kind: kind });
  if (claimErr) throw new Error(`claim: ${String(claimErr.message ?? claimErr).slice(0, 200)}`);
  if (claimed !== true) return { status: "already", day, kind };

  const from = kind === "morning" ? tashkentMidnight(now, -1) : tashkentMidnight(now, 0);
  const to = kind === "morning" ? tashkentMidnight(now, 0) : new Date(now);
  const { data: s, error: statsErr } = await admin.rpc("teacher_room_stats", { _from: from.toISOString(), _to: to.toISOString() });
  if (statsErr) {
    await admin.from("teacher_room_posts").update({ error: `stats: ${String(statsErr.message ?? statsErr).slice(0, 200)}` })
      .eq("day", day).eq("kind", kind);
    await logHealth(admin, "teacher_room_post_failed", { kind, day, error: String(statsErr.message ?? statsErr).slice(0, 200) },
      { source: "teacher-room" });
    return { status: "stats_failed" };
  }
  const stats = (Array.isArray(s) ? s : []) as GroupStat[];
  const text = kind === "morning" ? renderMorning(stats, now) : renderEvening(stats, now);
  const thread = Number(cfg.thread_id);
  const r = await io.send("sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
    ...(Number.isSafeInteger(thread) && thread > 0 ? { message_thread_id: thread } : {}),
  });
  if (!r.ok) {
    await admin.from("teacher_room_posts").update({ error: String(r.error ?? "send failed").slice(0, 300) }).eq("day", day).eq("kind", kind);
    await logHealth(admin, "teacher_room_post_failed", { kind, day, error: r.error }, { source: "teacher-room" });
    return { status: "send_failed", error: r.error };
  }
  await admin.from("teacher_room_posts")
    .update({ message_id: Number(r.result?.message_id) || null, sent_at: new Date(now).toISOString(), error: null })
    .eq("day", day).eq("kind", kind);
  return { status: "ok", day, kind, groups: stats.length };
}
