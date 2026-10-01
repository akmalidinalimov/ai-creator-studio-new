// "🌙 Bugun emas" (ack:not_today) on the daily lesson reminder — make it DO what it says (UX review
// 2026-09-30, quick win #8).
//
// BEFORE: the tap only showed an "OK 👍" toast. The button stayed on the message and nothing was muted: 55 taps
// from 21 students in 30 days, 13 of them repeats within 10 s (people tapping again because nothing happened).
//
// NOW, on a tap:
//   1. profiles.last_streak_warning_at = now — checked (error AND row count). cron-engagement's reminderWindows()
//      sends the ~21:00 streak warning only when that stamp is not TODAY in the student's timezone
//      (core.ts: `lastStreakYmd !== ymd`), so tonight's warning is skipped; tomorrow is untouched. The daily
//      reminder itself already went out (this button is on it). Nothing else reads the column.
//   2. the toast "Mayli 🙂", and the reminder is EDITED to "Mayli 🙂 Bugun boshqa eslatma yo'q. Ertaga
//      ko'rishamiz!" with its buttons removed (so a second tap is impossible).
//   3. DB-visible: admin_actions 'reminder_snoozed' — at most one row per student per Tashkent day.
// A failed save answers an honest "not saved" toast, leaves the message as it is (the student can tap again)
// and writes 'reminder_snooze_save_failed'. It never says "done" when nothing was saved.
//
// "Bugun" means the day of the TAP: a tap on an old reminder still mutes today, which is what the student
// asked for. It is the tapper's OWN reminder in their own chat, so impersonation does not apply.
import { logHealth, logHealthOnce } from "../_shared/edge.ts";
import { type SendOutcome } from "../_shared/telegram-send.ts";

export type Locale = "uz" | "ru" | "en";
type TgCall = (method: string, payload: Record<string, unknown>) => Promise<SendOutcome>;
// deno-lint-ignore no-explicit-any
type Db = any;

export const SNOOZE_T: Record<Locale, { done: string; toast: string; failed: string }> = {
  uz: {
    done: "Mayli 🙂 Bugun boshqa eslatma yo'q. Ertaga ko'rishamiz!",
    toast: "Mayli 🙂",
    failed: "⚠️ Saqlanmadi — birozdan keyin yana bosing",
  },
  ru: {
    done: "Хорошо 🙂 Сегодня больше напоминаний не будет. До завтра!",
    toast: "Хорошо 🙂",
    failed: "⚠️ Не сохранилось — нажмите ещё раз чуть позже",
  },
  en: {
    done: "OK 🙂 No more reminders today. See you tomorrow!",
    toast: "OK 🙂",
    failed: "⚠️ Not saved — please tap again in a moment",
  },
};

const normLocale = (v: unknown): Locale => {
  const l = String(v ?? "").toLowerCase().slice(0, 2);
  return l === "ru" ? "ru" : l === "en" ? "en" : "uz";
};

/** One checked write of the streak-warning stamp. true only when exactly this student's row was updated. */
export async function stampSnooze(admin: Db, userId: string, at: Date): Promise<{ ok: boolean; problem: string | null }> {
  try {
    const { data, error } = await admin.from("profiles")
      .update({ last_streak_warning_at: at.toISOString() })
      .eq("id", userId)
      .select("id");
    if (error) return { ok: false, problem: String(error.message ?? error).slice(0, 200) };
    if (!Array.isArray(data) || data.length !== 1) return { ok: false, problem: `${Array.isArray(data) ? data.length : 0} rows updated` };
    return { ok: true, problem: null };
  } catch (e) {
    return { ok: false, problem: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

export type SnoozeDeps = {
  call: TgCall;
  /** index.ts findProfileByTelegramId — the tapper's own profile. */
  findProfile: (tgId: number) => Promise<{ id: string; preferred_locale?: string | null } | null>;
  /** answerCallbackQuery with a toast. */
  answer: (text: string) => Promise<unknown>;
  now?: () => Date;
};

export type SnoozeResult = "snoozed" | "no_profile" | "save_failed";

// deno-lint-ignore no-explicit-any
export async function handleNotToday(admin: Db, cq: any, d: SnoozeDeps): Promise<SnoozeResult> {
  const profile = await d.findProfile(Number(cq?.from?.id));
  if (!profile) {
    await d.answer("OK 👍"); // unreachable behind the webhook's profile gate; today's answer
    return "no_profile";
  }
  const locale = normLocale(profile.preferred_locale);
  const s = SNOOZE_T[locale];
  const at = (d.now ?? (() => new Date()))();

  const saved = await stampSnooze(admin, profile.id, at);
  if (!saved.ok) {
    await logHealth(admin, "reminder_snooze_save_failed", { error: saved.problem }, {
      targetUserId: profile.id, source: "telegram-bot-webhook",
    });
    await d.answer(s.failed);
    return "save_failed";
  }
  await d.answer(s.toast);

  const chatId = cq?.message?.chat?.id;
  const messageId = cq?.message?.message_id;
  if (chatId && messageId) {
    // No reply_markup → Telegram removes the inline keyboard.
    const o = await d.call("editMessageText", { chat_id: chatId, message_id: messageId, text: s.done });
    if (!o.ok && !/message is not modified/i.test(String(o.error ?? ""))) {
      // Cosmetic (the snooze is saved); still visible, once a day per status.
      await logHealthOnce(admin, "reminder_snooze_edit_failed", `status:${o.status}`, { status: o.status, error: o.error }, {
        source: "telegram-bot-webhook",
      });
    }
  }
  await logHealthOnce(admin, "reminder_snoozed", profile.id, {
    reminder_sent_at: typeof cq?.message?.date === "number" ? new Date(cq.message.date * 1000).toISOString() : null,
    locale,
  }, { actorUserId: profile.id, targetUserId: profile.id, source: "telegram-bot-webhook" });
  return "snoozed";
}
