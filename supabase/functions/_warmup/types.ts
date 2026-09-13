// _warmup/types.ts — the warm-up engine's shared contract.
//
// PUBLISHED FIRST, DELIBERATELY. Agents B–G build against this file, so it changes only by
// agreement. SPEC.md §4 is reproduced verbatim below; everything after the SUPPORT TYPES marker
// is a type that §4 references but does not define (SendPayload, CampaignPack, Participant,
// LedgerRow, ScheduleTick) and without which the file cannot compile.
//
// THE GOVERNING RULE, expressed in the type system. The engine contains zero campaign content,
// so the normal send path has no free-text field: a plugin addresses copy by `copyKey` and the
// drainer resolves it against the active pack. Prose generated at runtime (an AI answer, an
// admin-composed message) goes through RawSendPayload, which forces a `rawReason` — making every
// such send self-documenting and greppable. A hardcoded user-facing string is therefore not
// expressible in an Effect.
//
// CASING. Engine-side types are camelCase (Event, Effect, Participant, LedgerRow). CampaignPack
// mirrors the pack JSON exactly and so stays snake_case — those keys are the content team's
// contract, not ours, and must not drift.

// ─────────────────────────────────────────────────────────────────────────────
// SPEC §4 — VERBATIM
// ─────────────────────────────────────────────────────────────────────────────

export type EventType =
  | 'participant.joined' | 'participant.started_bot' | 'participant.left'
  | 'message.posted' | 'message.is_question' | 'reaction.added'
  | 'media.submitted' | 'reply.to_peer' | 'command.received'
  | 'task.completed' | 'event.attended' | 'event.committed'
  | 'day.started' | 'day.ended' | 'scores.frozen'
  | 'points.awarded' | 'tier.reached' | 'streak.broken'
  | 'offer.viewed' | 'payment.started' | 'payment.completed';

export interface Event {
  id: number; type: EventType;
  telegramId?: number; chatId?: number; messageId?: number;
  payload: Record<string, unknown>; createdAt: string;
}

export type Effect =
  | { kind:'award';      telegramId:number; action:string; points:number; reason?:string; sourceRef:string }
  | { kind:'send';       telegramId?:number; chatId?:number; surface:'dm'|'channel'|'group';
                         msgKind:'push'|'reply'; payload:SendPayload; scheduledFor?:string; dedupeKey?:string }
  | { kind:'react';      chatId:number; messageId:number; emoji:string }
  | { kind:'render';     template:string; data:object; then:'dm'|'channel' }
  | { kind:'setSegment'; telegramId:number; segment:string }
  | { kind:'setState';   plugin:string; telegramId?:number; key:string; value:unknown }
  | { kind:'escalate';   telegramId:number; question:string; category:string; heatFlag:boolean }
  | { kind:'awardBadge'; telegramId:number; badgeKey:string };

export interface Plugin {
  name: string; version: string; subscribes: EventType[];
  onEvent?(e: Event, ctx: Ctx): Promise<Effect[]>;
  onSchedule?(tick: ScheduleTick, ctx: Ctx): Promise<Effect[]>;
}

export interface Ctx {                       // READ-ONLY
  pack: CampaignPack;
  getParticipant(id:number): Promise<Participant|null>;
  getTotal(id:number): Promise<number>;
  getRank(id:number): Promise<number>;
  getLedger(id:number, since?:string): Promise<LedgerRow[]>;
  countToday(id:number, action:string): Promise<number>;
  getState(plugin:string, id:number|null, key:string): Promise<unknown>;
  now(): Date;                               // in pack timezone
  campaignDay(): number|null;
  log(level:'info'|'warn'|'error', msg:string, meta?:object): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUPPORT TYPES — referenced by §4, defined here
// ─────────────────────────────────────────────────────────────────────────────

/** A button. Labels are copy keys, never literals. `url` is engine-generated (deep links) or
 *  pack-supplied (payment_url); `callbackData` must stay ≤64 bytes — Telegram's hard cap. */
export interface SendButton {
  labelKey: string;
  url?: string;
  callbackData?: string;
}

/** The normal path: address copy by key, let the drainer resolve it against the active pack. */
export interface CopySendPayload {
  copyKey: string;
  /** Interpolation values for the resolved copy, e.g. { points: 12, rank: 4 }. */
  vars?: Record<string, string | number>;
  /** Deterministic variant choice for copy carrying a `variants` array — same seed, same
   *  variant, so a replayed event never produces a different message. */
  variantSeed?: string;
  buttons?: SendButton[][];
  /** Storage path, Telegram file_id, or a render-output reference. */
  imageRef?: string;
  replyToMessageId?: number;
  threadId?: number;
  parseMode?: 'HTML' | 'MarkdownV2';
  disablePreview?: boolean;
  text?: never;
}

/** The deliberate escape hatch for prose that does not exist until runtime. `rawReason` is
 *  mandatory so every raw string in the outbox says why it is not a copy key. */
export interface RawSendPayload {
  text: string;
  rawReason: 'ai_answer' | 'admin_composed' | 'render_caption';
  buttons?: SendButton[][];
  imageRef?: string;
  replyToMessageId?: number;
  threadId?: number;
  parseMode?: 'HTML' | 'MarkdownV2';
  disablePreview?: boolean;
  copyKey?: never;
}

export type SendPayload = CopySendPayload | RawSendPayload;

/** One row of warmup.participants, camelCased. */
export interface Participant {
  id: number;
  telegramId: number;
  username: string | null;
  firstName: string | null;
  startedBot: boolean;
  startedBotAt: string | null;
  joinedChannelAt: string | null;
  leftAt: string | null;
  segment: string;
  streak: number;
  streakFreezes: number;
  lastActiveAt: string | null;
  survey: Record<string, unknown>;
  attendance: Record<string, unknown>;
  committedEvents: string[];
  referredBy: number | null;
  optedOut: boolean;
  pausedUntil: string | null;
  createdAt: string;
}

/** One row of warmup.ledger, camelCased. Append-only: there is no mutable shape here. */
export interface LedgerRow {
  id: number;
  telegramId: number;
  action: string;
  points: number;
  reason: string | null;
  plugin: string;
  campaignDay: number | null;
  sourceRef: string | null;
  dedupeKey: string;
  createdAt: string;
}

/** What the scheduler hands a plugin's onSchedule(). `at` is already in the pack timezone. */
export interface ScheduleTick {
  at: string;
  campaignDay: number | null;
  reason: 'slot' | 'cron' | 'countdown' | 'freeze' | 'segments' | 'manual';
  /** pack.schedule.slots[].id when `reason` is 'slot'. */
  slotId?: string;
  /** pack.events[].id when `reason` is 'countdown'. */
  eventId?: string;
  /** The pack-defined countdown offset that fired, e.g. '-6h'. */
  offset?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMPAIGN PACK — the shape only. Never the content.
// ─────────────────────────────────────────────────────────────────────────────
//
// Structural fields the ENGINE reads are typed; campaign-specific leaves stay open. Every
// section carries an index signature so a richer real pack does not break compilation, and
// Agent C's JSON-schema validator — not this file — is the authority on validity.

export interface PackManifest {
  pack_version: string;
  campaign_name: string;
  language: string;
  /** IANA zone, e.g. 'Asia/Tashkent'. All engine time maths resolves through this. */
  timezone: string;
  starts_on: string;
  duration_days: number;
  channel_id: string;
  discussion_group_id: string;
  admin_telegram_ids: string[];
  [k: string]: unknown;
}

export interface PackSlot {
  id: string;
  /** 'HH:MM' in the pack timezone. */
  time: string;
  surface: 'dm' | 'channel' | 'group';
  renders?: string;
  conditional?: boolean;
  [k: string]: unknown;
}

export interface PackSchedule {
  slots: PackSlot[];
  budgets: {
    channel_per_day: number;
    dm_per_day: number;
    event_day_channel?: number;
    [k: string]: unknown;
  };
  /** 'HH:MM' bounds in the pack timezone; `from` > `to` means the window crosses midnight. */
  quiet_hours: { from: string; to: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface PackPointRule {
  value?: number;
  cap_per_day?: number;
  min_chars?: number;
  cooldown_seconds?: number;
  tag?: string;
  [k: string]: unknown;
}

export interface PackTier {
  key: string;
  threshold?: number;
  rank_based?: number;
  reward?: string;
  [k: string]: unknown;
}

export interface PackEconomy {
  points: Record<string, PackPointRule>;
  tiers: PackTier[];
  endowed_progress?: number;
  badges?: unknown[];
  [k: string]: unknown;
}

export interface PackDay {
  day: number;
  belief: string;
  hashtag?: string;
  task?: { instruction_key: string; [k: string]: unknown };
  posts?: { slot: string; copy_key: string; [k: string]: unknown }[];
  [k: string]: unknown;
}

export interface PackEvent {
  id: string;
  /** 'YYYY-MM-DD' and 'HH:MM' in the pack timezone. */
  date: string;
  time: string;
  /** At least two per event (SPEC §6.3) — matched case- and diacritic-insensitively. */
  code_words: string[];
  points?: number;
  countdowns?: string[];
  pitch?: boolean;
  [k: string]: unknown;
}

export interface PackCommand {
  key: string;
  command: string;
  aliases: string[];
  reply_key: string;
  [k: string]: unknown;
}

export interface PackCm {
  cheer_triggers: string[];
  first_n_of_day?: number;
  limits: {
    text_replies_per_user_per_day: number;
    ai_answers_per_user_per_day: number;
    bot_messages_per_thread: number;
    thread_revivals_per_day: number;
    reply_delay_seconds: { min: number; max: number };
    [k: string]: unknown;
  };
  reaction_emojis: string[];
  [k: string]: unknown;
}

export interface PackRouting {
  escalate_keywords: string[];
  ai_scope?: string;
  /** Topics the AI may never answer. SPEC §6.8's guardrails are hardcoded and stricter — this
   *  list adds to them and can never subtract. */
  ai_forbidden: string[];
  holding_reply_key: string;
  [k: string]: unknown;
}

export interface PackBrand {
  colors: Record<string, string>;
  logo?: string;
  footer_left?: string;
  footer_right?: string;
  font_regular?: string;
  font_bold?: string;
  [k: string]: unknown;
}

/** One copy entry. Single-use copy carries `text`; anything sent repeatedly carries `variants`
 *  (the validator enforces ≥5). Exactly one of the two is present. */
export interface CopyEntry {
  text?: string;
  variants?: string[];
  one_cta?: boolean;
  [k: string]: unknown;
}

export interface CampaignPack {
  manifest: PackManifest;
  schedule: PackSchedule;
  economy: PackEconomy;
  days: PackDay[];
  events: PackEvent[];
  commands: PackCommand[];
  cm: PackCm;
  routing: PackRouting;
  brand: PackBrand;
  /** Flat map: the dotted copy_key ('day1.midday', 'cheer.standout') is the key itself. */
  copy: Record<string, CopyEntry>;
  offer?: Record<string, unknown>;
  sequences?: Record<string, unknown>;
  inter_event_sequence?: Record<string, unknown>;
  survey?: Record<string, unknown>;
  heat_weights?: Record<string, number>;
  proof?: Record<string, unknown>;
  faq?: { pattern: string; answer_key: string; [k: string]: unknown }[];
  [section: string]: unknown;
}
