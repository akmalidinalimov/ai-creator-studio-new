// course-membership-check — is each student of a membership course (courses.membership_required; 7.0) still in its
// Telegram channel or one of its groups? Migration 20261030145000 holds the state and the lock rule; this probes
// Telegram and records what it saw. Pure except for the injected I/O (check.test.ts runs it with fakes); index.ts is
// the HTTP shell.
//
// Fail-open everywhere: a Telegram error, or a course whose chats are not all known yet, records nothing that can lock.
// A student is locked only after course_membership_record has seen two clean "not a member" answers grace_hours apart
// (has_module_access → course_membership_locked). One "rejoin within 24 h" DM per absence.

import { logHealth } from "../_shared/edge.ts";

type Db = any;
export type Verdict = "member" | "not" | "error";
export type Probe = (chatId: number, telegramId: number) => Promise<Verdict>;
export type SendFn = (chatId: number, text: string, button?: { text: string; url: string }) => Promise<boolean>;
export interface Io { admin: Db; probe: Probe; send: SendFn; now: () => number }

export type Due = {
  user_id: string; course_id: string; telegram_id: number; chats: number[]; member: boolean | null; ready: boolean;
  channel_chat_id?: number | null; in_holding?: boolean;
};

/** A getChatMember answer → member / not. Anything that is not a clean answer is an error (never "not"). */
export function verdictOf(resp: any): Verdict {
  if (!resp || resp.ok !== true || !resp.result) return "error";
  const st = resp.result.status;
  if (st === "member" || st === "administrator" || st === "creator") return "member";
  if (st === "restricted") return resp.result.is_member === true ? "member" : "not";
  if (st === "left" || st === "kicked") return "not";
  return "error";
}

/** Member of ANY chat → member + that chat (stops at the first; the SQL lists group chats before the channel); every
 *  chat a clean "not" → not; otherwise unknown. */
export async function probeAll(chats: number[], telegramId: number, probe: Probe):
  Promise<{ state: "member" | "not" | "unknown"; chat: number | null }> {
  if (!chats.length) return { state: "unknown", chat: null };
  let errors = 0;
  for (const c of chats) {
    const v = await probe(c, telegramId);
    if (v === "member") return { state: "member", chat: c };
    if (v === "error") errors++;
  }
  return { state: errors ? "unknown" : "not", chat: null };
}

export function warningText(courseTitle: string, graceHours: number): string {
  return `⚠️ <b>${courseTitle}</b> kanali va guruhlarida sizni topa olmadik.\n\n` +
    `Darslar <b>${graceHours} soatdan keyin</b> yopiladi. Davom ettirish uchun kanalga yoki guruhingizga qayta qoʻshiling — ` +
    `qoʻshilganingizdan keyin darslar darhol yana ochiladi, ballaringiz va vazifalaringiz saqlanib qoladi.`;
}

export async function runOnce(io: Io): Promise<Record<string, unknown>> {
  const { admin } = io;
  const { data: cfgRow } = await admin.from("platform_settings").select("value").eq("key", "course_membership").maybeSingle();
  const cfg = (cfgRow?.value ?? {}) as Record<string, unknown>;
  const batch = Math.min(Math.max(Number(cfg.batch) || 300, 1), 1000);
  const grace = Math.max(Number(cfg.grace_hours) || 24, 1);

  const { data: due, error } = await admin.rpc("course_membership_due", { _limit: batch });
  if (error) throw new Error(`course_membership_due: ${String(error.message ?? error).slice(0, 200)}`);
  const rows = (due ?? []) as Due[];

  const courseIds = Array.from(new Set(rows.map((r) => r.course_id)));
  const courses = new Map<string, { title: string; url: string | null }>();
  if (courseIds.length) {
    const { data: cs } = await admin.from("courses").select("id, title, telegram_channel_url").in("id", courseIds);
    for (const c of (cs ?? []) as any[]) courses.set(c.id, { title: c.title, url: c.telegram_channel_url ?? null });
  }

  const out = { due: rows.length, member: 0, not_member: 0, unknown: 0, not_ready: 0, warned: 0, rejoined: 0, locked: 0, placed: 0 };
  const notReady = new Set<string>();
  for (const r of rows) {
    // a course whose channel or some group chat is unknown: an absence cannot be trusted yet — record nothing
    if (!r.ready) { out.not_ready++; notReady.add(r.course_id); continue; }
    const { state, chat } = await probeAll((r.chats ?? []).map(Number).filter(Number.isFinite), Number(r.telegram_id), io.probe);
    const member = state === "member" ? true : state === "not" ? false : null;
    const { data: rec, error: recErr } = await admin.rpc("course_membership_record", {
      _uid: r.user_id, _course: r.course_id, _member: member, _error: state === "unknown" ? "telegram_error" : null,
    });
    if (recErr) throw new Error(`course_membership_record: ${String(recErr.message ?? recErr).slice(0, 200)}`);
    const res = (rec ?? {}) as Record<string, unknown>;
    if (state === "member") {
      out.member++;
      if (res.rejoined) out.rejoined++;
      // registered through the channel, now in a real group of the course → into that group
      if (r.in_holding && chat != null && chat !== Number(r.channel_chat_id)) {
        const { data: placed } = await admin.rpc("course_membership_place", { _uid: r.user_id, _course: r.course_id, _chat_id: chat });
        if (placed) out.placed++;
      }
      continue;
    }
    if (state === "unknown") { out.unknown++; continue; }
    out.not_member++;
    if (res.locked) out.locked++;
    if (!res.warned) {
      const c = courses.get(r.course_id);
      const sent = await io.send(Number(r.telegram_id), warningText(c?.title ?? "Kurs", grace),
        c?.url ? { text: "📣 Kanalga qoʻshilish", url: c.url } : undefined);
      // marked even when the DM failed (blocked bot): the warning is a courtesy, never retried every 15 min
      await admin.rpc("course_membership_mark_warned", { _uid: r.user_id, _course: r.course_id });
      if (sent) out.warned++;
    }
  }
  await logHealth(admin, "course_membership_check", { ...out, not_ready_courses: Array.from(notReady), grace_hours: grace },
    { source: "course-membership-check" });
  return { status: "ok", ...out };
}
