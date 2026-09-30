// "GRACEFUL IS NOT SILENT" for homework capture (CLAUDE.md, incident doctrine step 5).
//
// A media post in a REGISTERED homework topic that ends in no submission used to leave only a console
// line. hw_dm_health_stats' uncaptured_24h cannot see most of these: it joins webhook_inbox to profiles
// by telegram_id and to groups by the profile's group_id AND groups.homework_topic_id, so an unknown
// sender, a group-less profile and a per-module topic (group_module_topics) never match, and anything
// that created a pending post is excluded by design. Each such outcome now leaves ONE admin_actions row
// per (reason, chat, sender, Tashkent day), via logHealthOnce:
//   hw_capture_skipped    a by-design outcome (see CaptureSkipReason). Countable, never alarmed: some of
//                         these are ordinary member behaviour (a 🙈 11th file, a repost of graded work).
//   hw_capture_failed     a write or handler failure (see CaptureFailReason). Baseline 0.
//   auto_register_failed  the auto-register engine (shared by the in-topic path and the DM /start member
//                         path) left a group member WITHOUT a linked profile. The sibling of the
//                         auto_registered_provisional success row, with details.source = the path.
// The reasons are closed unions, so a call site cannot invent a name a later health field won't count.
// Posts OUTSIDE registered homework topics stay silent by design (CLAUDE.md "Members vs non-members":
// members' general chat is their space). None of this makes a Telegram call, and none of it throws.
import { logHealthOnce } from "../_shared/edge.ts";

export type CaptureSkipReason =
  | "autoreg_off"                // unknown sender, auto_register flag off (kill-switch)
  | "topic_course_out_of_scope"  // unknown sender, the topic's group course is not in homework_capture.course_ids
  | "chat_admin"                 // unknown sender is a chat admin/creator (U4: staff never auto-register)
  | "anonymous_sender"           // posted as the group/channel, not as a reply; cannot be attributed (details.sender_kind)
  | "sender_has_no_group"        // registered profile with no group_id
  | "assignment_unresolved"      // registered profile, no assignment resolvable for this topic
  | "other_group_topic"          // registered profile posted in ANOTHER group's homework topic (capture-guard.ts); redirect hint sent
  | "pending_other_course"       // picker: the held post's task is outside the student's current course (moved meanwhile)
  | "tier_locked"                // module beyond the student's tier
  | "already_graded"             // auto path: the task is graded (✅ + "already scored" DM, post not filed)
  | "media_cap_reached"          // 11th+ file of one submission/pending post (🙈 reaction); step=finalize_append: the picker's merge
  | "album_item_after_finalize"  // album tail arrived after its pending post was finalized
  | "guess_already_graded"       // picker ignored; the auto-guess hit a graded task, post consumed unfiled
  | "guess_tier_locked"          // picker ignored; the auto-guess hit a tier-locked module, post expired
  | "sweep_unresolved";          // picker ignored; no task resolvable, post expired

export type CaptureFailReason =
  | "pending_append_failed"      // append_pending_media RPC errored
  | "pending_insert_failed"      // no pending row created and none to append to
  | "submission_upsert_failed"   // auto path homework_submissions upsert errored
  | "finalize_write_failed"      // picker finalize write errored (claim reverted; the sweep retries)
  | "finalize_error"             // picker finalize threw
  | "sweep_error"                // expiry sweep threw on a pending post
  | "handler_error";             // handleGroupTopicMessage threw

export type AutoRegisterFailReason =
  | "internal_secret_missing"    // internal_fn_secret() returned nothing: the engine cannot be called
  | "engine_refused"             // admin-create-students returned no userId
  | "engine_error"               // the engine call threw (network/transport)
  | "profile_not_linked"         // the engine MATCHED a profile without linking this telegram_id
  | "error";                     // autoRegisterProvisionalPoster threw

// daily_task_post: the daily-task topic path (PR-4), which resolves posters through
// _shared/group-poster-identity.ts like the homework path.
export type AutoRegisterSource = "homework_topic_post" | "dm_start_member" | "daily_task_post";

type DropDetails = {
  chatId: number;
  threadId?: number | null;
  messageId?: number | null;
  fromId?: number | null;
  userId?: string | null;
  [k: string]: unknown;
};

async function recordCaptureDrop(admin: any, kind: "skipped" | "failed", reason: string, d: DropDetails): Promise<void> {
  const { chatId, threadId, messageId, fromId, userId, ...extra } = d;
  await logHealthOnce(admin, `hw_capture_${kind}`, `${reason}:${chatId}:${fromId ?? userId ?? "unknown"}`, {
    reason, chat_id: chatId, thread_id: threadId ?? null, message_id: messageId ?? null, telegram_id: fromId ?? null,
    ...extra,
  }, { source: "telegram-bot-webhook", targetUserId: userId ?? null });
}

export function recordCaptureSkipped(admin: any, reason: CaptureSkipReason, d: DropDetails): Promise<void> {
  return recordCaptureDrop(admin, "skipped", reason, d);
}

export function recordCaptureFailed(admin: any, reason: CaptureFailReason, d: DropDetails): Promise<void> {
  return recordCaptureDrop(admin, "failed", reason, d);
}

// append_pending_media (live body, verified 2026-09-29) returns the new item count (>= 0), -1 when the
// pending post already holds 10 items, and -2 when it is no longer pending (finalized under an album
// tail). supabase-js yields null when the RPC itself errors. Every outcome but a count leaves this item
// out of the submission.
export function pendingAppendDrop(n: unknown):
  | { kind: "skipped"; reason: "media_cap_reached" | "album_item_after_finalize" }
  | { kind: "failed"; reason: "pending_append_failed" }
  | null {
  if (typeof n === "number" && n >= 0) return null;
  if (n === -1) return { kind: "skipped", reason: "media_cap_reached" };
  if (n === -2) return { kind: "skipped", reason: "album_item_after_finalize" };
  return { kind: "failed", reason: "pending_append_failed" };
}

// One submission holds at most 10 media items: the same cap as append_pending_media and
// append_submission_media (both refuse at jsonb_array_length(media) >= 10, live bodies verified 2026-09-29).
export const SUBMISSION_MEDIA_CAP = 10;

// The picker's APPEND finalize (➕ add files, the sweep's guess onto an ungraded submission, an unscreened
// fresh pick) merges a pending post's files into the existing submission. Prior files are kept first, so
// whatever does not fit is the tail of the NEW files. `dropped` is exactly what the old
// `priorMedia.concat(addMedia).slice(0, 10)` threw away with no signal. `added` is how many new files fit.
export function mergeCappedMedia<T>(prior: T[], add: T[], cap = SUBMISSION_MEDIA_CAP): { merged: T[]; added: number; dropped: T[] } {
  const all = prior.concat(add);
  const merged = all.slice(0, cap);
  const dropped = all.slice(cap);
  return { merged, added: add.length - dropped.length, dropped };
}

// True when a message replies to a REAL message. Telegram sets reply_to_message on every post in a forum
// topic, pointing at the topic's creation service message (reply_to_message.forum_topic_created), so
// `!msg.reply_to_message` does not identify a fresh post there (the #170/#171 class). Verified on
// webhook_inbox 2026-09-29: of 13 anonymous media posts in registered homework topics in 90 days, 7 were
// fresh posts carrying that implicit reply, 6 were real replies, and 0 had no reply_to_message at all.
export function isRealReply(msg: any): boolean {
  const r = msg?.reply_to_message;
  return !!r && !r.forum_topic_created;
}

export async function recordPendingAppendDrop(admin: any, n: unknown, d: DropDetails): Promise<void> {
  const drop = pendingAppendDrop(n);
  if (!drop) return;
  if (drop.kind === "skipped") await recordCaptureSkipped(admin, drop.reason, d);
  else await recordCaptureFailed(admin, drop.reason, d);
}

export async function recordAutoRegisterFailed(
  admin: any,
  reason: AutoRegisterFailReason,
  from: { id: number; username?: string },
  grp: { id: string } | null,
  source: AutoRegisterSource,
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
