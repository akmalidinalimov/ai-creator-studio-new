// One nudge: build the watch button, send, and log it to nudge_log — the testable core of detect-and-nudge.
//
// The nudge_log id is generated BEFORE the send and travels in the Mini App button as ?ref=<id>. When the
// student taps it, the Mini App reports the open (tg-miniapp-auth, src nudge_*) and clicked_at is stamped on
// THIS row of THIS student — so "a clicked 3-day nudge suppresses the 7-day one" keeps working without a
// magic-link token (magic_token is null on the web_app path). With the student Mini App off, the button is
// today's magic link (24 h, purpose 'nudge'), byte-identical, and its token is stored as before.
import {
  legacyWatchButton,
  type PrivateWatchOpts,
  sendWithWatchFallback,
  watchButton,
  type WatchFlag,
  type WatchMode,
  type WatchReason,
} from "../_shared/miniapp-button.ts";
import { continuePath, type MiniAppSrc } from "../_shared/miniapp-links.ts";
import { decideReminderCourse, type EngagementTargeting } from "../_shared/engagement-targeting.ts";

export type NudgeType = "inactive_3d" | "inactive_7d" | "stuck_lesson" | "module_complete";

// ─────────────────────────── who gets a smart nudge (engagement_targeting) ───────────────────────────
export type NudgeRunPlan = {
  /** Run inactive_3d / inactive_7d. False when retire_smart_inactive_nudges is on (the drip covers days 3/7). */
  inactive: boolean;
  /** Skip an inactive candidate who has no published course (skip_closed_courses). */
  skipClosed: boolean;
};

/** What this cron run does. module_complete always runs: it celebrates a module the student just finished. */
export function nudgeRunPlan(t: EngagementTargeting): NudgeRunPlan {
  const inactive = !t.retire_smart_inactive_nudges;
  return { inactive, skipClosed: inactive && t.skip_closed_courses };
}

/** The cron result for a retired inactive nudge type — what used to be its {sent, failed, skipped, total}. */
export function retiredResult() {
  return { retired: true, by: "engagement_targeting.retire_smart_inactive_nudges", sent: 0, failed: 0, skipped: 0, total: 0 };
}

/**
 * True when skip_closed_courses must drop this candidate: the course its /continue button would open (group
 * course, else first enrollment) is closed and no enrolled course is published. Same rule as cron-engagement
 * (_shared/engagement-targeting.ts decideReminderCourse); anything unknown (no course at all, a read failed →
 * published null) keeps today's behaviour and sends.
 */
export function closedForNudge(
  groupCourseId: string | null,
  enrolled: readonly string[],
  published: ReadonlyMap<string, boolean> | null,
): boolean {
  return decideReminderCourse(groupCourseId ?? enrolled[0] ?? null, true, published, enrolled).closed;
}

export const NUDGE_SRC: Record<NudgeType, MiniAppSrc> = {
  inactive_3d: "nudge_3d",
  inactive_7d: "nudge_7d",
  stuck_lesson: "nudge_stuck",
  module_complete: "nudge_module",
};

/** The raw Telegram result detect-and-nudge keeps (nudge_log.telegram_message_id needs result.message_id). */
// deno-lint-ignore no-explicit-any
export type TgRaw = { ok: boolean; status: number; data: any };

export type NudgeDeps = {
  admin?: unknown;
  flag: WatchFlag;
  newId: () => string;
  makeMagicLink: (userId: string, targetPath: string) => Promise<{ token: string; url: string }>;
  /** Throws only on a transport failure (already token-redacted). */
  send: (payload: Record<string, unknown>) => Promise<TgRaw>;
  insertLog: (row: Record<string, unknown>) => Promise<unknown>;
  redact: (e: unknown) => string;
};

export type NudgeProfile = { id: string; telegram_id: number | string; preferred_locale?: string | null };

/** The sendMessage body — the old one exactly when the button is a url button. */
export function nudgePayload(chatId: number, text: string, button: Record<string, unknown> | null): Record<string, unknown> {
  return {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(button ? { reply_markup: { inline_keyboard: [[button]] } } : {}),
  };
}

export async function sendNudgeWith(
  deps: NudgeDeps,
  profile: NudgeProfile,
  type: NudgeType,
  body: string,
  buttonText: string,
  extra: Record<string, string>,
  legacyPath: string,
): Promise<TgRaw> {
  const id = deps.newId();
  const chatId = Number(profile.telegram_id);
  const opts: PrivateWatchOpts = {
    chat: "private", text: buttonText, flag: deps.flag, fn: "detect-and-nudge", admin: deps.admin,
    // /continue picks the student's primary course and next lesson when TAPPED — no resolver needed here.
    miniPath: continuePath(),
    legacyPath,
    track: { src: NUDGE_SRC[type], ref: id },
    magicLink: (p) => deps.makeMagicLink(profile.id, p),
  };
  const w = await watchButton(opts);
  let token: string | null = w.token ?? null;
  let mode: WatchMode = w.mode;
  const reason: WatchReason = w.reason;
  const payload = nudgePayload(chatId, body, w.button);

  // A TRANSPORT failure (send throws) must not escape: one flaky send costs one nudge, and the failure stays
  // DB-visible in nudge_log.error (graceful is not silent). The send has already redacted the message.
  let r: TgRaw;
  try {
    const out = await sendWithWatchFallback(
      async (p) => {
        const x = await deps.send(p);
        return { ...x, error: x.ok ? null : String(x.data?.description ?? `http_${x.status}`) };
      },
      payload,
      async () => {
        const lg = await legacyWatchButton(opts, "ok");
        if (!lg.button) return null;
        token = lg.token ?? null;
        mode = "magic_link";
        return nudgePayload(chatId, body, lg.button);
      },
      { fn: "detect-and-nudge", admin: deps.admin },
    );
    r = { ok: out.result.ok, status: out.result.status, data: out.result.data };
  } catch (e) {
    r = { ok: false, status: 0, data: { error: deps.redact(e) } };
  }

  await deps.insertLog({
    id,
    profile_id: profile.id,
    nudge_type: type,
    telegram_message_id: r.ok ? String(r.data?.result?.message_id ?? "") : null,
    magic_token: token,
    payload: { extra, locale: profile.preferred_locale, ok: r.ok, button_mode: mode, button_reason: reason },
    error: r.ok ? null : JSON.stringify(r.data).slice(0, 500),
  });
  return r;
}
