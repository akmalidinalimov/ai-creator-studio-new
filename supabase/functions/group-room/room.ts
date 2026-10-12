// group-room — the student groups' morning greeting and 21:00 thank-you, each an image + caption in the group's
// NETWORKING topic (migration 20261012074100). Pure rendering + one runOnce with injected I/O (room.test.ts runs it with
// fakes); index.ts is the HTTP shell. A sibling of teacher-room (the curators' group), same claim/retry/watchdog shape.
//
// Tone rules (owner: encourage them to act; thank them at night): rotating hand-written texts (texts.ts); the evening
// shows the GROUP'S real day; a quiet day gets an encouraging text instead of "spectacular"; a student who hid
// themselves from the group boards is never named; zeros are left out, never pointed at.

import { logHealth } from "../_shared/edge.ts";
import { escCap } from "../_shared/support-agent-card.ts";
import {
  ACTIONS, EVENING_CLOSINGS, EVENING_OPENERS, MORNING_CLOSINGS, MORNING_OPENERS, QUIET_OPENERS, WEEKDAY_LINES,
} from "./texts.ts";

type Db = any;
export type Kind = "morning" | "evening";
export type SendFn = (method: string, payload: Record<string, unknown>) =>
  Promise<{ ok: boolean; result: any; error: string | null; status?: number }>;
export interface Io { admin: Db; send: SendFn; now: () => number }

export type Target = { group_id: string; group_name: string; chat_id: number | null; thread_id: number | null; students: number; ready: boolean };
export type Star = { name: string | null; last_name: string | null; username: string | null; score: number };
export type DayStats = { students: number; lessons: number; homework: number; answered: number; active: number; stars: Star[] };

/** Telegram's caption limit (characters of the caption text). */
export const CAPTION_MAX = 1024;
const TZ_MS = 5 * 3_600_000;

// Tashkent is UTC+5 all year. (Own copies, not imported from teacher-room: the deploy pipeline redeploys a function
// only when its own files change.)
export function tashkentDayNumber(nowMs: number): number {
  return Math.floor((nowMs + TZ_MS) / 86_400_000);
}
export function tashkentDate(nowMs: number): string {
  return new Date(nowMs + TZ_MS).toISOString().slice(0, 10);
}
/** Tashkent midnight (as a UTC instant) of the day containing `nowMs`, shifted by `days`. */
export function tashkentMidnight(nowMs: number, days = 0): Date {
  const local = new Date(nowMs + TZ_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days) - TZ_MS);
}
export function pick<T>(pool: T[], day: number, salt = 0): T {
  return pool[((day + salt) % pool.length + pool.length) % pool.length];
}

export function weekday(nowMs: number): number {
  return new Date(nowMs + TZ_MS).getUTCDay();
}

/** A student's display name: a real first name, else @username, else nothing (then they are not listed). */
export function starName(s: Star): string | null {
  const n = String(s.name ?? "").trim().split(/\s+/)[0] ?? "";
  if (/[\p{L}]{3,}/u.test(n) && !/^\p{L}\.$/u.test(n)) return escCap(n, 30);
  return s.username ? `@${escCap(s.username, 30)}` : null;
}

/** Three different actions for the day, rotating through the whole pool. */
export function dayActions(day: number): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < 3 && i < ACTIONS.length; i++) {
    const a = ACTIONS[((day * 3 + i) % ACTIONS.length + ACTIONS.length) % ACTIONS.length];
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

export function renderMorning(nowMs: number): string {
  const day = tashkentDayNumber(nowMs);
  const o = pick(MORNING_OPENERS, day);
  const wl = WEEKDAY_LINES[weekday(nowMs)];
  return [
    [`<b>${o.head}</b>`, ...(wl ? [wl] : []), "", o.body].join("\n"),
    ["👇 <b>Bugun nima qilamiz?</b>", ...dayActions(day)].join("\n"),
    pick(MORNING_CLOSINGS, day, 2),
  ].join("\n\n");
}

export function isQuiet(s: DayStats, activeBelow = 3): boolean {
  return s.active < activeBelow && s.lessons + s.homework < activeBelow;
}

export function renderEvening(s: DayStats, nowMs: number, activeBelow = 3): string {
  const day = tashkentDayNumber(nowMs);
  if (isQuiet(s, activeBelow)) {
    const q = pick(QUIET_OPENERS, day);
    return [`<b>${q.head}</b>\n\n${q.body}`, pick(EVENING_CLOSINGS, day, 3)].join("\n\n");
  }
  const o = pick(EVENING_OPENERS, day);
  const rows = ["📊 <b>Bugun guruhimizda:</b>"];
  if (s.lessons > 0) rows.push(`📚 <b>${s.lessons}</b> ta dars koʻrildi`);
  if (s.homework > 0) rows.push(`📝 <b>${s.homework}</b> ta uyga vazifa topshirildi`);
  if (s.answered > 0) rows.push(`💬 <b>${s.answered}</b> ta savolga javob berildi`);
  if (s.active > 0) rows.push(`🙌 <b>${s.active}</b> kishi faol boʻldi`);
  const blocks = [`<b>${o.head}</b>\n\n${o.body}`, rows.join("\n")];
  const names = (s.stars ?? []).map(starName).filter((n): n is string => !!n).slice(0, 3);
  if (names.length) blocks.push(`🌟 Bugungi eng faollar: <b>${names.join("</b>, <b>")}</b> — barakalla!`);
  blocks.push(pick(EVENING_CLOSINGS, day, 3));
  return blocks.join("\n\n");
}

/** Caption length as Telegram counts it: UTF-16 units of the text after HTML tags and entities are parsed. */
export function captionLength(html: string): number {
  return html.replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt);/g, "x").length;
}

export function imageUrl(base: string, kind: Kind, nowMs: number): string {
  return `${base.replace(/\/+$/, "")}/${kind}-${weekday(nowMs)}.jpg?v=1`;
}

export async function runOnce(io: Io, kind: Kind, opts: { force?: boolean } = {}): Promise<{ status: string; [k: string]: unknown }> {
  const { admin } = io;
  const now = io.now();
  const { data: row } = await admin.from("platform_settings").select("value").eq("key", "group_room").maybeSingle();
  const cfg = (row?.value ?? {}) as Record<string, unknown>;
  if (String(cfg.enabled ?? "true").toLowerCase() === "false") return { status: "disabled" };
  const base = String(cfg.image_base ?? "https://www.aicreator.academy/group-room");
  const activeBelow = Number(cfg.quiet_active_below) > 0 ? Number(cfg.quiet_active_below) : 3;
  // Only inside the post's own hour (09:xx / 21:xx Tashkent): a late or manual call must never greet "good morning"
  // at night. `force` (a deliberate manual run) skips this.
  const hour = Number(cfg[`${kind}_hour`]) || (kind === "morning" ? 9 : 21);
  const localHour = new Date(now + TZ_MS).getUTCHours();
  if (!opts.force && localHour !== hour) {
    await logHealth(admin, "group_room_out_of_window", { kind, local_hour: localHour, hour }, { source: "group-room" });
    return { status: "out_of_window", kind, local_hour: localHour };
  }

  const { data: t, error: tErr } = await admin.rpc("group_room_targets");
  if (tErr) {
    await logHealth(admin, "group_room_post_failed", { kind, error: `targets: ${String(tErr.message ?? tErr).slice(0, 200)}` },
      { source: "group-room" });
    return { status: "targets_failed" };
  }
  const targets = (Array.isArray(t) ? t : []) as Target[];
  const day = tashkentDate(now);
  const out = { sent: 0, as_text: 0, already: 0, skipped: [] as string[], failed: [] as string[] };

  for (const g of targets) {
    if (!g.ready || !(Number(g.students) > 0)) {
      out.skipped.push(`${g.group_name}: ${!g.ready ? "no NETWORKING topic" : "no students"}`);
      continue;
    }
    const { data: claimed, error: claimErr } = await admin.rpc("group_room_claim", { _day: day, _kind: kind, _group: g.group_id });
    if (claimErr) { out.failed.push(`${g.group_name}: claim`); continue; }
    if (claimed !== true) { out.already++; continue; }

    let caption: string;
    if (kind === "morning") {
      caption = renderMorning(now);
    } else {
      const { data: s, error: sErr } = await admin.rpc("group_room_stats", {
        _group: g.group_id, _from: tashkentMidnight(now, 0).toISOString(), _to: new Date(now).toISOString(),
      });
      if (sErr || !s) {
        await admin.from("group_room_posts").update({ error: `stats: ${String(sErr?.message ?? "empty").slice(0, 200)}` })
          .eq("day", day).eq("kind", kind).eq("group_id", g.group_id);
        out.failed.push(`${g.group_name}: stats`);
        continue;
      }
      caption = renderEvening(s as DayStats, now, activeBelow);
    }

    const where = { chat_id: Number(g.chat_id), message_thread_id: Number(g.thread_id) };
    let r = await io.send("sendPhoto", { ...where, photo: imageUrl(base, kind, now), caption, parse_mode: "HTML" });
    let asText = false;
    if (!r.ok && Number(r.status ?? 400) >= 400) {
      // Telegram REFUSED the photo (URL fetch, a too-long caption, a bad image): the words still go, and it is logged.
      // A transport error (status 0) is ambiguous — the photo may have landed — so it is NOT followed by the text;
      // the row keeps the error and the :20 run retries.
      const photoErr = r.error;
      r = await io.send("sendMessage", { ...where, text: caption, parse_mode: "HTML", disable_web_page_preview: true });
      asText = r.ok;
      if (r.ok) {
        await logHealth(admin, "group_room_photo_fallback", { kind, day, group: g.group_name, error: String(photoErr ?? "").slice(0, 200) },
          { source: "group-room" });
      }
    }
    if (!r.ok) {
      await admin.from("group_room_posts").update({ error: String(r.error ?? "send failed").slice(0, 300) })
        .eq("day", day).eq("kind", kind).eq("group_id", g.group_id);
      out.failed.push(`${g.group_name}: ${String(r.error ?? "send failed").slice(0, 80)}`);
      continue;
    }
    // sent_at is what makes the claim final (group_room_claim never retries a row with sent_at), so it is written even
    // when Telegram returned no message_id; a failed write is loud.
    const { error: upErr } = await admin.from("group_room_posts")
      .update({ sent_at: new Date(now).toISOString(), message_id: Number(r.result?.message_id) || null, as_text: asText, error: null })
      .eq("day", day).eq("kind", kind).eq("group_id", g.group_id);
    if (upErr) {
      await logHealth(admin, "group_room_post_failed", { kind, day, group: g.group_name, error: `sent but not recorded: ${String(upErr.message ?? upErr).slice(0, 160)}` },
        { source: "group-room" });
    }
    out.sent++;
    if (asText) out.as_text++;
  }

  if (out.failed.length) {
    await logHealth(admin, "group_room_post_failed", { kind, day, failed: out.failed }, { source: "group-room" });
  }
  await logHealth(admin, "group_room_run", { kind, day, ...out }, { source: "group-room" });
  return { status: out.failed.length ? "partial" : "ok", day, kind, ...out };
}
