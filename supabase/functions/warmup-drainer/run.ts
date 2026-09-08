// warmup-drainer/run.ts — the outbox drain loop, separated from the HTTP wrapper so it can be
// tested with an injected sender instead of the real Telegram API.
//
// Same hardened model as broadcast-drainer: atomic claim lease so overlapping ticks cannot
// double-send, terminal-vs-transient classification from the shared classifier, a retry cap, and
// ~40ms pacing to stay under Telegram's rate ceiling.
//
// Copy is resolved HERE, at the moment of delivery, not when the effect was queued: a message
// deferred overnight renders from the pack that is active when it actually goes out.

import { isTerminal } from "../_shared/telegram-classify.ts";
import type { SendOutcome } from "../_shared/telegram-send.ts";
import { govern } from "../_warmup/governor.ts";
import { loadActivePack, resolveCopy } from "../_warmup/pack.ts";
import { send as realSend, warmupEnabled } from "../_warmup/tg.ts";
import type { CampaignPack, SendPayload } from "../_warmup/types.ts";

export const BATCH = 100;
export const MAX_ATTEMPTS = 5;
export const CLAIM_LEASE_MS = 90_000;
export const PACE_MS = 40;                 // ~25 msg/sec, under Telegram's cap

export type Sender = (method: string, payload: Record<string, unknown>) => Promise<SendOutcome>;

export interface DrainResult {
  ok: boolean;
  processed: number;
  sent: number;
  dropped: number;
  deferred: number;
  failed: number;
  retrying: number;
  note?: string;
  error?: string;
}

const EMPTY: DrainResult = {
  ok: true, processed: 0, sent: 0, dropped: 0, deferred: 0, failed: 0, retrying: 0,
};

/** Turn a stored payload into the text that will be sent. */
export function renderText(pack: CampaignPack, payload: SendPayload, telegramId: number | null): string {
  if ("text" in payload && typeof payload.text === "string") return payload.text;   // RawSendPayload
  const p = payload as Extract<SendPayload, { copyKey: string }>;
  // Seed the variant per recipient: different people see different phrasings, any one person sees
  // a stable one, and a redelivery renders identically.
  return resolveCopy(pack, p.copyKey, {
    vars: p.vars,
    variantSeed: p.variantSeed ?? `${telegramId ?? "chan"}:${p.copyKey}`,
  });
}

export function renderButtons(pack: CampaignPack, payload: SendPayload): unknown | undefined {
  const rows = payload.buttons;
  if (!rows?.length) return undefined;
  return {
    inline_keyboard: rows.map((row) =>
      row.map((b) => ({
        text: resolveCopy(pack, b.labelKey),
        ...(b.url ? { url: b.url } : {}),
        ...(b.callbackData ? { callback_data: b.callbackData } : {}),
      }))
    ),
  };
}

export async function runDrainer(
  admin: any,
  opts?: { now?: Date; sender?: Sender; pace?: number },
): Promise<DrainResult> {
  const now = opts?.now ?? new Date();
  const send = opts?.sender ?? realSend;
  const pace = opts?.pace ?? PACE_MS;

  // The kill switch, before a single row is claimed. Rows stay queued and go out when it is lifted.
  if (!(await warmupEnabled(admin))) return { ...EMPTY, note: "warmup_disabled" };

  const wm = admin.schema("warmup");
  const nowIso = now.toISOString();
  const claimCutoff = new Date(now.getTime() - CLAIM_LEASE_MS).toISOString();
  const leaseFilter = `last_attempt_at.is.null,last_attempt_at.lt.${claimCutoff}`;

  let pack: CampaignPack;
  try {
    pack = await loadActivePack(admin);
  } catch (e) {
    return { ...EMPTY, ok: false, error: `no_active_pack: ${String((e as Error)?.message ?? e)}` };
  }

  // kind='render' belongs to warmup-render (Agent B), which produces an image and requeues a send.
  // Excluded so the drainer does not spin on rows it cannot handle.
  const { data: cand, error: selErr } = await wm.from("outbox")
    .select("id")
    .eq("status", "queued")
    .neq("kind", "render")
    .lt("attempts", MAX_ATTEMPTS)
    .lte("scheduled_for", nowIso)
    .or(leaseFilter)
    .order("scheduled_for", { ascending: true })
    .limit(BATCH);
  if (selErr) return { ...EMPTY, ok: false, error: selErr.message };

  const ids = (cand || []).map((r: { id: number }) => r.id);
  if (!ids.length) return { ...EMPTY };

  const { data: claimed } = await wm.from("outbox")
    .update({ last_attempt_at: nowIso })
    .in("id", ids)
    .eq("status", "queued")
    .or(leaseFilter)
    .select("id, telegram_id, chat_id, surface, kind, payload, attempts");
  const rows = (claimed || []) as Record<string, any>[];
  if (!rows.length) return { ...EMPTY };

  // Every DM recipient's reachability in one query. A bot cannot DM someone who never pressed
  // Start (~70% of LMS students never did), and a per-row lookup would be 100 extra round trips.
  const dmIds = rows.filter((r) => r.surface === "dm" && r.telegram_id).map((r) => Number(r.telegram_id));
  const reachable = new Map<number, boolean>();
  if (dmIds.length) {
    const { data: ps } = await wm.from("participants")
      .select("telegram_id, started_bot, opted_out, paused_until").in("telegram_id", dmIds);
    for (const p of (ps || []) as Record<string, any>[]) {
      reachable.set(Number(p.telegram_id),
        !!p.started_bot && !p.opted_out && !(p.paused_until && new Date(p.paused_until) > now));
    }
  }

  const out: DrainResult = { ...EMPTY };
  const stamp = () => new Date().toISOString();
  const drop = async (id: number, reason: string) => {
    await wm.from("outbox").update({ status: "dropped", drop_reason: reason.slice(0, 300) }).eq("id", id);
    out.dropped++;
  };

  for (const row of rows) {
    out.processed++;
    const telegramId = row.telegram_id ? Number(row.telegram_id) : null;

    // Unreachable DM: drop quietly rather than burning five attempts on a guaranteed failure.
    if (row.surface === "dm" && telegramId && reachable.get(telegramId) !== true) {
      await drop(row.id, "recipient_unreachable:not_started_or_opted_out");
      continue;
    }

    const verdict = await govern(admin, pack, {
      surface: row.surface, kind: row.kind, telegramId, chatId: row.chat_id,
    }, now);

    if (!verdict.allow) {
      if (verdict.action === "defer") {
        await wm.from("outbox")
          .update({ scheduled_for: verdict.until, last_attempt_at: null, drop_reason: verdict.reason })
          .eq("id", row.id);
        out.deferred++;
      } else {
        await drop(row.id, verdict.reason);
      }
      continue;
    }

    const chatId = row.chat_id
      ? Number(row.chat_id)
      : row.surface === "dm"
        ? telegramId
        : Number(row.surface === "group" ? pack.manifest.discussion_group_id : pack.manifest.channel_id);
    if (!chatId) { await drop(row.id, "no_chat_id"); continue; }

    const record = async (res: SendOutcome) => {
      if (res.ok) {
        await wm.from("outbox").update({ status: "sent", sent_at: stamp(), drop_reason: null }).eq("id", row.id);
        out.sent++;
      } else if (isTerminal(res.error) || row.attempts + 1 >= MAX_ATTEMPTS) {
        await wm.from("outbox")
          .update({ status: "failed", drop_reason: res.error, last_attempt_at: stamp() }).eq("id", row.id);
        out.failed++;
      } else {
        await wm.from("outbox")
          .update({ attempts: row.attempts + 1, drop_reason: res.error, last_attempt_at: stamp() }).eq("id", row.id);
        out.retrying++;
      }
    };

    // A reaction is its own Telegram method and carries no copy.
    if (row.kind === "react") {
      await record(await send("setMessageReaction", {
        chat_id: chatId,
        message_id: Number(row.payload?.messageId),
        reaction: [{ type: "emoji", emoji: String(row.payload?.emoji) }],
      }));
      if (pace) await new Promise((r) => setTimeout(r, pace));
      continue;
    }

    let text: string;
    let reply_markup: unknown | undefined;
    try {
      const payload = row.payload as SendPayload;
      text = renderText(pack, payload, telegramId);
      reply_markup = renderButtons(pack, payload);
    } catch (e) {
      // A missing copy_key is a content bug, not a delivery problem: retrying cannot fix it, and
      // sending a blank message would be worse than sending nothing.
      await drop(row.id, `copy_unresolvable:${String((e as Error)?.message ?? e)}`);
      continue;
    }

    const p = row.payload as Record<string, any>;
    const common = {
      chat_id: chatId,
      parse_mode: p?.parseMode ?? "HTML",
      ...(reply_markup ? { reply_markup } : {}),
      ...(p?.replyToMessageId ? { reply_parameters: { message_id: p.replyToMessageId } } : {}),
      ...(p?.threadId ? { message_thread_id: p.threadId } : {}),
    };

    await record(p?.imageRef
      ? await send("sendPhoto", { ...common, photo: p.imageRef, caption: text })
      : await send("sendMessage", { ...common, text, disable_web_page_preview: true }));

    if (pace) await new Promise((r) => setTimeout(r, pace));
  }

  return out;
}
