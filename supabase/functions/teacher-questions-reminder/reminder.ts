// teacher-questions-reminder — while «KURATORGA SAVOLLAR» questions wait longer than remind_after_min (60), the
// group's teachers get ONE digest of them (then again every repeat_min, at most max_reminders times, never in quiet
// hours) with a 📂 button per question that opens it in their ❓ Savollar inbox (telegram-bot-webhook).
// A group with no teacher the bot can write to → the admins. Questions are CLAIMED (teacher_questions_claim_reminders:
// reminded_at + reminder_count, FOR UPDATE SKIP LOCKED) before sending, so overlapping runs never double-send; a
// question no recipient received is un-claimed and DB-visible (teacher_question_reminder_undelivered).
//
// Pure except for the injected I/O (reminder.test.ts runs it with fakes). index.ts is the HTTP shell.

import { logHealth } from "../_shared/edge.ts";
import { adminTelegramIds } from "../_shared/admin-recipients.ts";
import { renderTqDigest, type TqRow, tqQuietHour, tqSettingsOf } from "../_shared/teacher-questions.ts";

type Db = any;
export type SendFn = (method: string, payload: Record<string, unknown>) => Promise<{ ok: boolean; result: any; error: string | null }>;
export interface Io { admin: Db; send: SendFn; now: () => number }

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const a = m.get(k);
  if (a) a.push(v); else m.set(k, [v]);
}

/** group id → the Telegram chats of its teachers (primary ∪ co-teachers) the bot may write to. */
async function teacherChats(admin: Db, groupIds: string[]): Promise<Map<string, number[]>> {
  const [{ data: gs }, { data: gt }] = await Promise.all([
    admin.from("groups").select("id, teacher_id").in("id", groupIds),
    admin.from("group_teachers").select("group_id, teacher_id").in("group_id", groupIds),
  ]);
  const byGroup = new Map<string, string[]>();
  for (const g of (gs ?? []) as any[]) if (g.teacher_id) push(byGroup, g.id, g.teacher_id);
  for (const r of (gt ?? []) as any[]) if (r.teacher_id) push(byGroup, r.group_id, r.teacher_id);
  const ids = Array.from(new Set(Array.from(byGroup.values()).flat()));
  const chatOf = new Map<string, number>();
  if (ids.length) {
    const { data: ps } = await admin.from("profiles").select("id, telegram_id, telegram_write_access_at").in("id", ids);
    for (const p of (ps ?? []) as any[]) {
      const tg = Number(p.telegram_id);
      if (p.telegram_write_access_at && Number.isSafeInteger(tg) && tg !== 0) chatOf.set(p.id, tg);
    }
  }
  const out = new Map<string, number[]>();
  for (const gid of groupIds) {
    const chats = (byGroup.get(gid) ?? []).map((t) => chatOf.get(t)).filter((x): x is number => typeof x === "number");
    out.set(gid, Array.from(new Set(chats)));
  }
  return out;
}

export async function runOnce(io: Io): Promise<{ status: string; [k: string]: unknown }> {
  const { admin } = io;
  const now = io.now();
  const { data: row } = await admin.from("platform_settings").select("value").eq("key", "teacher_questions").maybeSingle();
  const cfg = tqSettingsOf(row?.value);
  if (!cfg.enabled) return { status: "disabled" };
  if (tqQuietHour(now, cfg.quiet_start_hour, cfg.quiet_end_hour)) return { status: "quiet_hours" };

  const { data: claimed, error } = await admin.rpc("teacher_questions_claim_reminders", {
    _after_min: cfg.remind_after_min, _repeat_min: cfg.repeat_min, _max: cfg.max_reminders,
  });
  if (error) throw new Error(`claim: ${String(error.message ?? error).slice(0, 200)}`);
  const rows = (claimed ?? []) as TqRow[];
  if (!rows.length) return { status: "idle" };
  const ids = rows.map((r) => r.id);

  try {
    const groupIds = Array.from(new Set(rows.map((r) => r.group_id)));
    const [{ data: gn }, chats] = await Promise.all([
      admin.from("groups").select("id, name").in("id", groupIds),
      teacherChats(admin, groupIds),
    ]);
    const names: Record<string, string> = Object.fromEntries(((gn ?? []) as any[]).map((g) => [g.id, g.name]));
    // a group no teacher can be reached for → the admins
    const orphan = groupIds.filter((g) => !(chats.get(g) ?? []).length);
    if (orphan.length) {
      const admins = await adminTelegramIds(admin, { limit: 3 });
      for (const g of orphan) chats.set(g, admins.ids);
    }
    // recipient → the questions of every group they look after (one digest each)
    const byChat = new Map<number, TqRow[]>();
    for (const r of rows) for (const c of chats.get(r.group_id) ?? []) push(byChat, c, r);

    const delivered = new Set<number>();
    let sent = 0, failed = 0;
    for (const [chat, list] of byChat) {
      const d = renderTqDigest(list, now, names);
      const r = await io.send("sendMessage", {
        chat_id: chat, text: d.text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: d.keyboard,
      });
      if (r.ok) {
        sent++;
        for (const q of list) delivered.add(q.id);
      } else {
        failed++;
      }
    }
    const missed = ids.filter((id) => !delivered.has(id));
    if (missed.length) {
      await admin.rpc("teacher_questions_unclaim_reminders", { _ids: missed });
      await logHealth(admin, "teacher_question_reminder_undelivered",
        { questions: missed, recipients: byChat.size, failed, orphan_groups: orphan }, { source: "teacher-questions-reminder" });
    }
    if (delivered.size) {
      await logHealth(admin, "teacher_question_reminder_sent",
        { questions: Array.from(delivered), digests: sent, failed, orphan_groups: orphan }, { source: "teacher-questions-reminder" });
    }
    return {
      status: missed.length ? (delivered.size ? "partial" : "undelivered") : "ok",
      due: ids.length, delivered: delivered.size, digests: sent,
    };
  } catch (e) {
    // never leave questions claimed without a reminder (they would stay silent for another repeat_min)
    await admin.rpc("teacher_questions_unclaim_reminders", { _ids: ids });
    throw e;
  }
}
