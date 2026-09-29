// "GRACEFUL IS NOT SILENT" for homework capture (CLAUDE.md, incident doctrine step 5).
//
// A media post in a REGISTERED homework topic that ends with no pending post and no submission used to
// leave only a console line. hw_dm_health_stats' uncaptured_24h cannot see it: that detector joins
// webhook_inbox to profiles by telegram_id and to groups by the profile's group_id, so an unknown sender
// or a group-less profile never matches. Each such outcome now leaves one admin_actions row per
// (reason, chat, sender, Tashkent day), via logHealthOnce:
//   hw_capture_skipped    a by-design outcome (auto-register off, chat admin, course out of scope,
//                         tier-locked, album item after finalize, no group/assignment). Countable only.
//   hw_capture_failed     a write or handler failure. Baseline 0.
//   auto_register_failed  the auto-register engine (shared by the in-topic path and the DM /start member
//                         path) left a group member WITHOUT a linked profile. The sibling of the
//                         auto_registered_provisional success row, with details.source = the path.
// Posts OUTSIDE registered homework topics stay silent by design (CLAUDE.md "Members vs non-members":
// members' general chat is their space). None of this makes a Telegram call, and none of it throws.
import { logHealthOnce } from "../_shared/edge.ts";

export async function recordCaptureDrop(
  admin: any,
  kind: "skipped" | "failed",
  reason: string,
  d: {
    chatId: number;
    threadId?: number | null;
    messageId?: number | null;
    fromId?: number | null;
    userId?: string | null;
    [k: string]: unknown;
  },
): Promise<void> {
  const { chatId, threadId, messageId, fromId, userId, ...extra } = d;
  await logHealthOnce(admin, `hw_capture_${kind}`, `${reason}:${chatId}:${fromId ?? userId ?? "unknown"}`, {
    reason, chat_id: chatId, thread_id: threadId ?? null, message_id: messageId ?? null, telegram_id: fromId ?? null,
    ...extra,
  }, { source: "telegram-bot-webhook", targetUserId: userId ?? null });
}

export async function recordAutoRegisterFailed(
  admin: any,
  reason: string,
  from: { id: number; username?: string },
  grp: { id: string } | null,
  source: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await logHealthOnce(admin, "auto_register_failed", `${reason}:${source}:${from.id}`, {
    reason, telegram_id: from.id, telegram_username: from.username || null, group_id: grp?.id ?? null, ...extra,
  }, { source });
}

// True when (chatId, threadId) is a REGISTERED homework topic of some group: its shared topic
// (groups.homework_topic_id) or a per-module topic (group_module_topics). The chat is matched by URL the
// same way autoRegisterProvisionalPoster does it. Called only on drop paths, so that members' posts in
// general-chat topics stay silent. Fails closed (false = stay silent) on any error.
export async function isRegisteredHomeworkTopic(admin: any, chatId: number, threadId: number): Promise<boolean> {
  try {
    const needle = `%/c/${String(chatId).replace(/^-100/, "")}/%`;
    const { data: gs } = await admin.from("groups")
      .select("id, homework_topic_id")
      .or(`homework_topic_url.ilike.${needle},telegram_group_url.ilike.${needle}`);
    const groups = (gs || []) as any[];
    if (groups.some((g) => g.homework_topic_id != null && Number(g.homework_topic_id) === Number(threadId))) return true;
    if (!groups.length) return false;
    const { data: gmt } = await admin.from("group_module_topics")
      .select("group_id").in("group_id", groups.map((g) => g.id)).eq("telegram_topic_id", threadId).limit(1);
    return !!(gmt && gmt.length);
  } catch (_e) {
    return false;
  }
}
