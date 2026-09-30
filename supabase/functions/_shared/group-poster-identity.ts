// WHO POSTED THIS? One identity resolver for a media post in a registered group topic (homework, per-module,
// and, from PR-1 on, the daily-task topic). Every caller that attributes a group-topic post to a student goes
// through resolveGroupPoster(), so a new path cannot pick a weaker rule.
//
// Order:
//   1. profiles.telegram_id = from.id                          → via 'telegram_id' (the signed id; no gate)
//   2. the post must be in a REGISTERED topic of the requested kinds, in this chat. Anything else is general
//      chat: silent, no link, no registration, no signal (CLAUDE.md "Members vs non-members").
//   3. the GATED USERNAME LINK. An intake student (sales add them by @username through /intake, so their
//      profile has telegram_username and NO telegram_id) is linked when, and only when, ALL of these hold:
//        - exactly one profile has that username (case-insensitive, LIKE-escaped: "_" is a wildcard);
//        - it has no telegram_id yet;
//        - it is a STUDENT and holds no staff role (a squatter must never claim a teacher/admin account);
//        - it is active (status 'active', not archived);
//        - its CURRENT group lives in THIS chat. The post itself is the membership proof: Telegram delivered
//          a message from this user in this chat, so no getChatMember probe is needed. This is the
//          tg-miniapp-auth rule (member of the profile's OWN group chat), stricter than the bot DM gate
//          (member of ANY active-course group).
//      The link is ONE atomic write guarded by `.is("telegram_id", null)`: a racing album sibling or a
//      parallel path cannot overwrite it; the loser re-reads by telegram_id and uses whatever won.
//      A username that matches a profile but fails a gate is REFUSED here and never handed to the
//      registration engine: admin-create-students matches by username too, and would move or link the very
//      profile this gate just refused (the account-takeover class; see admin-create-students/telegram-link.ts).
//   4. no profile carries that username at all → the injected autoRegister() (the bot's
//      autoRegisterProvisionalPoster: kill-switch flag, course scope, chat-admin exclusion, the engine).
//
// DB-visible outcomes (graceful is not silent). admin_actions rows:
//   group_poster_linked_by_username  one per link (target_user_id = the linked profile).
//   group_poster_unresolved          a post in a registered topic that ended with no profile for a reason this
//                                    module owns (a refused username, a lookup/link failure, no registrar),
//                                    once per (reason, chat, sender, Tashkent day). A refusal inside
//                                    autoRegister is NOT re-recorded: autoRegister already writes the one row
//                                    that explains it (hw_capture_skipped / auto_register_failed).
//
// daily_task_topic_id arrives with PR-1 (groups.daily_task_topic_id). It is selected only when a caller asks
// for the 'daily_task' kind, and read DEFENSIVELY: before PR-1 the column does not exist, so the select is
// retried without it and the daily kind simply matches nothing.
import { logHealth, logHealthOnce } from "./edge.ts";
import { likeEscape, normUsername } from "./username.ts";

// A service-role Supabase client (typed loosely, like the rest of the codebase).
// deno-lint-ignore no-explicit-any
type Db = any;

export type TopicKind = "homework" | "module" | "daily_task";
export type GroupPosterSource = "homework_topic_post" | "daily_task_post";
export type GroupPosterVia = "telegram_id" | "username_link" | "auto_register";

/** Why the resolver ended without a profile. Closed union: a later health field can count every value. */
export type GroupPosterUnresolvedReason =
  | "username_ambiguous"        // more than one profile carries the username
  | "username_linked_elsewhere" // the username's profile is already linked to a DIFFERENT Telegram account
  | "username_not_student"      // the username's profile is staff, or has no student role
  | "username_inactive"         // the username's profile is not active / archived
  | "username_no_group"         // the username's profile has no current group
  | "username_other_chat"       // the username's profile's current group lives in another chat
  | "link_race_lost"            // the guarded link wrote 0 rows and nobody holds this telegram_id
  | "link_failed"               // the link write errored and nobody holds this telegram_id
  | "lookup_failed"             // a read the gate depends on errored (fail closed)
  | "no_account";               // nothing matched and the caller supplied no registrar

/** Outcomes that are expected and never recorded by this module. */
export type GroupPosterSilentReason =
  | "no_sender"                 // no from / a bot
  | "not_registered_topic"      // general chat: members' own space
  | "auto_register_declined";   // autoRegister returned null; it recorded its own row

export type GroupPosterReason = GroupPosterVia | GroupPosterUnresolvedReason | GroupPosterSilentReason;

export interface GroupPosterResult<P> {
  profile: P | null;
  via: GroupPosterVia | null;
  reason: GroupPosterReason;
}

export interface GroupPosterInput {
  from: { id?: number; username?: string | null; is_bot?: boolean } | null | undefined;
  chatId: number;
  threadId: number;
  messageId?: number | null;
  /** Which registered topics count. The homework capture path passes ["homework", "module"]. */
  topicKinds: readonly TopicKind[];
  source: GroupPosterSource;
}

/** A group that lives in the posting chat, with its registered topic ids. */
export interface ChatGroup {
  id: string;
  course_id: string | null;
  homework_topic_id: number | null;
  module_topic_ids: number[];
  daily_task_topic_id: number | null;
}

export interface UsernameCandidate {
  id: string;
  telegram_username: string | null;
  telegram_id: number | string | null;
  group_id: string | null;
  status: string | null;
  archived_at: string | null;
  roles: string[];
}

export interface GroupPosterDeps<P> {
  findByTelegramId(tgId: number): Promise<P | null>;
  /** Groups whose topic/group URL is in this chat. null = the lookup failed. */
  groupsInChat(chatId: number, kinds: readonly TopicKind[]): Promise<ChatGroup[] | null>;
  /** Profiles whose telegram_username equals `username` case-insensitively, any telegram_id. null = failed. */
  findByUsername(username: string): Promise<UsernameCandidate[] | null>;
  /** The guarded write: set telegram_id only while it is still NULL. */
  linkTelegramId(profileId: string, tgId: number): Promise<"linked" | "not_linked" | "error">;
  recordLinked(d: Record<string, unknown>, profileId: string): Promise<void>;
  recordUnresolved(reason: GroupPosterUnresolvedReason, d: Record<string, unknown>, targetUserId: string | null): Promise<void>;
}

const STAFF_ROLES = new Set(["teacher", "admin", "superadmin"]);

/** True when `threadId` is one of this group's registered topics of the requested kinds. */
export function topicMatches(g: ChatGroup, threadId: number, kinds: readonly TopicKind[]): boolean {
  if (!g?.course_id) return false; // same rule as autoRegisterProvisionalPoster: a course-less group has no capture
  const t = Number(threadId);
  if (!Number.isFinite(t)) return false;
  for (const k of kinds) {
    if (k === "homework" && g.homework_topic_id != null && Number(g.homework_topic_id) === t) return true;
    if (k === "module" && g.module_topic_ids.some((m) => Number(m) === t)) return true;
    if (k === "daily_task" && g.daily_task_topic_id != null && Number(g.daily_task_topic_id) === t) return true;
  }
  return false;
}

/**
 * The username gate, pure. `candidates` are the lookup's rows; they are re-compared exactly here so a sloppy
 * lookup (an unescaped wildcard, a suffix match) can never widen the match. Returns the profile to link, or
 * the refusal reason, or 'none' when no profile carries the username (then registration may create one).
 */
export function usernameLinkVerdict(
  candidates: readonly UsernameCandidate[],
  username: string,
  chatGroupIds: ReadonlySet<string>,
  tgId: number,
): { kind: "link"; profileId: string } | { kind: "refuse"; reason: GroupPosterUnresolvedReason; profileId: string | null } | { kind: "none" } {
  const uname = normUsername(username);
  if (!uname) return { kind: "none" };
  const exact = candidates.filter((c) => normUsername(c.telegram_username) === uname);
  if (exact.length === 0) return { kind: "none" };
  if (exact.length > 1) return { kind: "refuse", reason: "username_ambiguous", profileId: null };
  const c = exact[0];
  if (c.telegram_id != null && String(c.telegram_id) !== "") {
    // Already THIS account (step 1's read missed it, or a sibling linked it a moment ago): the guarded write
    // is a no-op and the caller's re-read by telegram_id returns it.
    if (String(c.telegram_id) === String(tgId)) return { kind: "link", profileId: c.id };
    return { kind: "refuse", reason: "username_linked_elsewhere", profileId: c.id };
  }
  const roles = c.roles ?? [];
  if (!roles.includes("student") || roles.some((r) => STAFF_ROLES.has(r))) {
    return { kind: "refuse", reason: "username_not_student", profileId: c.id };
  }
  if ((c.status && c.status !== "active") || c.archived_at) {
    return { kind: "refuse", reason: "username_inactive", profileId: c.id };
  }
  if (!c.group_id) return { kind: "refuse", reason: "username_no_group", profileId: c.id };
  if (!chatGroupIds.has(c.group_id)) return { kind: "refuse", reason: "username_other_chat", profileId: c.id };
  return { kind: "link", profileId: c.id };
}

/** The resolver core over injected I/O (unit-tested without a database). */
export async function resolveGroupPosterWith<P>(
  deps: GroupPosterDeps<P>,
  input: GroupPosterInput,
  autoRegister?: () => Promise<P | null>,
): Promise<GroupPosterResult<P>> {
  const from = input.from;
  const tgId = Number(from?.id);
  if (!from || !Number.isSafeInteger(tgId) || tgId <= 0 || from.is_bot) {
    return { profile: null, via: null, reason: "no_sender" };
  }
  const base = {
    chat_id: input.chatId, thread_id: input.threadId, message_id: input.messageId ?? null,
    telegram_id: tgId, telegram_username: from.username || null, source: input.source,
  };
  const unresolved = async (reason: GroupPosterUnresolvedReason, targetUserId: string | null, extra: Record<string, unknown> = {}) => {
    await deps.recordUnresolved(reason, { ...base, ...extra }, targetUserId);
    return { profile: null, via: null, reason } as GroupPosterResult<P>;
  };

  // 1. The signed id.
  const byId = await deps.findByTelegramId(tgId);
  if (byId) return { profile: byId, via: "telegram_id", reason: "telegram_id" };

  // 2. Registered topics only.
  const groups = await deps.groupsInChat(input.chatId, input.topicKinds);
  if (groups === null) return unresolved("lookup_failed", null, { step: "groups_in_chat" });
  const topicGroups = groups.filter((g) => topicMatches(g, input.threadId, input.topicKinds));
  if (topicGroups.length === 0) return { profile: null, via: null, reason: "not_registered_topic" };
  const groupIds = topicGroups.map((g) => g.id);

  // 3. The gated username link.
  const uname = normUsername(from.username);
  if (uname) {
    const cands = await deps.findByUsername(uname);
    if (cands === null) return unresolved("lookup_failed", null, { step: "username_lookup", group_ids: groupIds });
    const v = usernameLinkVerdict(cands, uname, new Set(groups.map((g) => g.id)), tgId);
    if (v.kind === "refuse") return unresolved(v.reason, v.profileId, { matched_user_id: v.profileId, group_ids: groupIds });
    if (v.kind === "link") {
      const res = await deps.linkTelegramId(v.profileId, tgId);
      if (res === "linked") await deps.recordLinked({ ...base, profile_id: v.profileId, group_ids: groupIds }, v.profileId);
      // Re-read by the signed id either way. After 0 rows / an error, an album sibling (or another path)
      // linked this telegram_id first, and whatever holds it now is the poster.
      const now = await deps.findByTelegramId(tgId);
      if (now) {
        return res === "linked"
          ? { profile: now, via: "username_link", reason: "username_link" }
          : { profile: now, via: "telegram_id", reason: "telegram_id" };
      }
      const reason: GroupPosterUnresolvedReason = res === "linked" ? "lookup_failed" : res === "error" ? "link_failed" : "link_race_lost";
      return unresolved(reason, v.profileId, {
        matched_user_id: v.profileId, group_ids: groupIds, link_result: res, ...(res === "linked" ? { step: "post_link_read" } : {}),
      });
    }
  }

  // 4. Nobody carries this username (or the sender has none): registration may create an account.
  if (!autoRegister) return unresolved("no_account", null, { group_ids: groupIds });
  const reg = await autoRegister();
  if (reg) return { profile: reg, via: "auto_register", reason: "auto_register" };
  return { profile: null, via: null, reason: "auto_register_declined" };
}

// ---------------------------------------------------------------------------------------------------------
// I/O layer (service-role client).

/** The profile columns the bot's capture path reads (same list as telegram-bot-webhook findProfileByTelegramId). */
export const POSTER_PROFILE_COLS =
  "id, name, last_name, telegram_username, telegram_id, telegram_onboarded_at, preferred_locale, group_id, status, account_type";

function isMissingColumn(err: { code?: string; message?: string } | null | undefined, col: string): boolean {
  if (!err) return false;
  return err.code === "42703" || err.code === "PGRST204" || String(err.message ?? "").includes(col);
}

export function groupPosterDeps(admin: Db): GroupPosterDeps<Record<string, unknown>> {
  return {
    findByTelegramId: async (tgId) => {
      const { data } = await admin.from("profiles").select(POSTER_PROFILE_COLS).eq("telegram_id", tgId).maybeSingle();
      return data ?? null;
    },

    groupsInChat: async (chatId, kinds) => {
      try {
        const stripped = String(chatId).replace(/^-100/, "");
        if (!/^\d+$/.test(stripped)) return [];
        // Same chat match as autoRegisterProvisionalPoster / isRegisteredHomeworkTopic (digits only, so the
        // PostgREST or-filter cannot be broken out of).
        const needle = `%/c/${stripped}/%`;
        const orFilter = `homework_topic_url.ilike.${needle},telegram_group_url.ilike.${needle}`;
        const baseCols = "id, course_id, homework_topic_id";
        // Only the daily kind asks for the PR-1 column, so the homework path never depends on it. No memo:
        // nothing calls the daily kind before PR-1 is ledgered (PR-4 depends on it), so the retry is a
        // safety net, not a hot path.
        const wantDaily = kinds.includes("daily_task");
        let res = await admin.from("groups").select(wantDaily ? `${baseCols}, daily_task_topic_id` : baseCols).or(orFilter);
        if (res.error && wantDaily && isMissingColumn(res.error, "daily_task_topic_id")) {
          res = await admin.from("groups").select(baseCols).or(orFilter);
        }
        if (res.error) {
          console.error("group-poster:groups-lookup-failed", res.error.message);
          return null;
        }
        const rows = (res.data || []) as Array<Record<string, unknown>>;
        const modTopics = new Map<string, number[]>();
        if (kinds.includes("module") && rows.length) {
          const { data: gmt, error: gmtErr } = await admin.from("group_module_topics")
            .select("group_id, telegram_topic_id").in("group_id", rows.map((r) => String(r.id)));
          if (gmtErr) {
            console.error("group-poster:module-topics-lookup-failed", gmtErr.message);
            return null;
          }
          for (const t of (gmt || []) as Array<{ group_id: string; telegram_topic_id: number | null }>) {
            if (t.telegram_topic_id == null) continue;
            const list = modTopics.get(t.group_id) ?? [];
            list.push(Number(t.telegram_topic_id));
            modTopics.set(t.group_id, list);
          }
        }
        return rows.map((r) => ({
          id: String(r.id),
          course_id: (r.course_id as string | null) ?? null,
          homework_topic_id: r.homework_topic_id == null ? null : Number(r.homework_topic_id),
          module_topic_ids: modTopics.get(String(r.id)) ?? [],
          daily_task_topic_id: r.daily_task_topic_id == null ? null : Number(r.daily_task_topic_id),
        }));
      } catch (e) {
        console.error("group-poster:groups-lookup-threw", String(e));
        return null;
      }
    },

    findByUsername: async (username) => {
      try {
        const uname = normUsername(username);
        if (!uname) return [];
        // Escaped, so the ilike is a case-insensitive EXACT match (the footgun lint enforces likeEscape).
        const { data, error } = await admin.from("profiles")
          .select("id, telegram_username, telegram_id, group_id, status, archived_at")
          .ilike("telegram_username", likeEscape(uname))
          .limit(3);
        if (error) {
          console.error("group-poster:username-lookup-failed", error.message);
          return null;
        }
        const rows = (data || []) as Array<Omit<UsernameCandidate, "roles">>;
        if (!rows.length) return [];
        const { data: roleRows, error: roleErr } = await admin.from("user_roles")
          .select("user_id, role").in("user_id", rows.map((r) => r.id));
        if (roleErr) {
          console.error("group-poster:roles-lookup-failed", roleErr.message);
          return null;
        }
        const roles = new Map<string, string[]>();
        for (const r of (roleRows || []) as Array<{ user_id: string; role: string }>) {
          roles.set(r.user_id, [...(roles.get(r.user_id) ?? []), r.role]);
        }
        return rows.map((r) => ({ ...r, roles: roles.get(r.id) ?? [] }));
      } catch (e) {
        console.error("group-poster:username-lookup-threw", String(e));
        return null;
      }
    },

    linkTelegramId: async (profileId, tgId) => {
      try {
        const { data, error } = await admin.from("profiles")
          .update({ telegram_id: tgId, updated_at: new Date().toISOString() })
          .eq("id", profileId)
          .is("telegram_id", null)
          .select("id");
        if (error) {
          console.error("group-poster:link-failed", error.message);
          return "error";
        }
        return Array.isArray(data) && data.length === 1 ? "linked" : "not_linked";
      } catch (e) {
        console.error("group-poster:link-threw", String(e));
        return "error";
      }
    },

    recordLinked: async (d, profileId) => {
      await logHealth(admin, "group_poster_linked_by_username", d, {
        source: String(d.source ?? "group_poster"), targetUserId: profileId,
        targetResourceType: "profile", targetResourceId: profileId,
      });
    },

    recordUnresolved: async (reason, d, targetUserId) => {
      await logHealthOnce(admin, "group_poster_unresolved", `${reason}:${d.chat_id}:${d.telegram_id}`, { reason, ...d }, {
        source: String(d.source ?? "group_poster"), targetUserId,
      });
    },
  };
}

/**
 * Resolve the poster of a media post in a group topic. `opts.autoRegister` is the caller's registrar (the bot
 * passes autoRegisterProvisionalPoster); it runs only when no profile carries the sender's username.
 */
export function resolveGroupPoster(
  admin: Db,
  input: GroupPosterInput,
  opts: { autoRegister?: () => Promise<Record<string, unknown> | null> } = {},
): Promise<GroupPosterResult<Record<string, unknown>>> {
  return resolveGroupPosterWith(groupPosterDeps(admin), input, opts.autoRegister);
}
