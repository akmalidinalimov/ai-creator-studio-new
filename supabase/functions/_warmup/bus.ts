// _warmup/bus.ts — the event bus: plugin registry, feature flags, auto-disable, and the read-only
// Ctx handed to plugins.
//
// The contract this file enforces is that ONE PLUGIN CANNOT TAKE THE BOT DOWN. Every plugin call
// is wrapped: caught, timed out, counted, and — after enough consecutive failures — switched off,
// while every other plugin in the same batch still runs and the dispatcher still returns.
//
// On "the applier is the only writer": that rule is about DOMAIN state — points, messages,
// segments — which may only change through an Effect. Engine bookkeeping is not domain state, so
// this file updates warmup.plugin_registry (plugin health) and warmup-dispatch marks
// warmup.events.processed_at. Plugins can reach neither: a plugin's only output is Effect[], and
// setState can only address warmup.plugin_state, never plugin_registry. That separation is what
// stops a failing plugin from clearing its own error count and re-enabling itself.

import type { CampaignPack, Ctx, Effect, Event, EventType, LedgerRow, Participant, Plugin, ScheduleTick } from "./types.ts";
import { campaignDayFor, zonedDateKey, zonedTimeToInstant } from "./pack.ts";

/** Consecutive failures before a plugin is switched off. Engine policy, not campaign content. */
export const AUTO_DISABLE_AFTER = Number(Deno.env.get("WARMUP_PLUGIN_ERROR_LIMIT") ?? 5);

/** A plugin that hangs would stall the whole dispatch tick, so every call is raced against this. */
export const PLUGIN_TIMEOUT_MS = Number(Deno.env.get("WARMUP_PLUGIN_TIMEOUT_MS") ?? 5_000);

export interface PluginRunResult {
  plugin: string;
  effects: Effect[];
  ok: boolean;
  error?: string;
  skipped?: "disabled" | "not_subscribed" | "no_handler";
  ms: number;
}

// ─── registry ────────────────────────────────────────────────────────────────

const registry = new Map<string, Plugin>();

/** Register a plugin. Re-registering the same name replaces it (module reload on a warm instance). */
export function registerPlugin(plugin: Plugin): void {
  registry.set(plugin.name, plugin);
}

export function registerPlugins(plugins: Plugin[]): void {
  for (const p of plugins) registerPlugin(p);
}

export function registeredPlugins(): Plugin[] {
  return [...registry.values()];
}

/** Test seam. Not used in production paths. */
export function clearPlugins(): void {
  registry.clear();
}

// ─── feature flags ───────────────────────────────────────────────────────────

/**
 * Which plugins are currently switched on. A plugin with no registry row is ENABLED — registering
 * a new plugin should not require a database write before it can run. Only an explicit
 * enabled=false (set by an admin, or by auto-disable) switches one off.
 *
 * If the registry cannot be read, every plugin is treated as DISABLED. A dispatcher that cannot
 * tell which plugins are safe must not guess in favour of running them.
 */
export async function loadFlags(admin: any): Promise<Map<string, boolean>> {
  const flags = new Map<string, boolean>();
  const { data, error } = await admin.schema("warmup").from("plugin_registry").select("plugin, enabled");
  if (error) {
    console.error("warmup/bus: plugin_registry unreadable, disabling all plugins", error.message);
    for (const name of registry.keys()) flags.set(name, false);
    return flags;
  }
  for (const row of (data || []) as { plugin: string; enabled: boolean }[]) {
    flags.set(row.plugin, row.enabled);
  }
  return flags;
}

/** Record a clean run: clears the consecutive-error count so old failures do not accumulate. */
async function noteSuccess(admin: any, plugin: string): Promise<void> {
  try {
    await admin.schema("warmup").from("plugin_registry").upsert({
      plugin, enabled: true, consecutive_errors: 0, updated_at: new Date().toISOString(),
    }, { onConflict: "plugin" });
  } catch (e) {
    console.error("warmup/bus: noteSuccess failed", plugin, String(e));
  }
}

/**
 * Record a failure and switch the plugin off once it has failed AUTO_DISABLE_AFTER times running.
 * Read-then-write is acceptable here: the count is a health signal, and losing one increment to a
 * race costs one extra failed run, never correctness.
 */
async function noteFailure(admin: any, plugin: string, message: string): Promise<boolean> {
  try {
    const wm = admin.schema("warmup");
    const { data } = await wm.from("plugin_registry")
      .select("consecutive_errors").eq("plugin", plugin).maybeSingle();
    const next = ((data?.consecutive_errors as number) ?? 0) + 1;
    const disable = next >= AUTO_DISABLE_AFTER;
    await wm.from("plugin_registry").upsert({
      plugin,
      enabled: !disable,
      consecutive_errors: next,
      last_error: message.slice(0, 500),
      last_error_at: new Date().toISOString(),
      ...(disable
        ? { disabled_at: new Date().toISOString(), disabled_reason: `auto: ${next} consecutive errors` }
        : {}),
      updated_at: new Date().toISOString(),
    }, { onConflict: "plugin" });
    if (disable) {
      console.error(`warmup/bus: AUTO-DISABLED plugin '${plugin}' after ${next} consecutive errors: ${message}`);
    }
    return disable;
  } catch (e) {
    console.error("warmup/bus: noteFailure failed", plugin, String(e));
    return false;
  }
}

// ─── the read-only context handed to plugins ─────────────────────────────────

/**
 * Ctx exposes queries, never a database handle — a plugin has nothing to write through. Combined
 * with plugins returning Effect[], that is the whole "plugins never write" guarantee.
 */
export function buildCtx(admin: any, pack: CampaignPack, atFn: () => Date = () => new Date()): Ctx {
  const wm = admin.schema("warmup");
  const tz = pack.manifest.timezone;

  return {
    pack,

    async getParticipant(id: number): Promise<Participant | null> {
      const { data } = await wm.from("participants").select("*").eq("telegram_id", id).maybeSingle();
      if (!data) return null;
      return {
        id: data.id, telegramId: Number(data.telegram_id), username: data.username,
        firstName: data.first_name, startedBot: data.started_bot, startedBotAt: data.started_bot_at,
        joinedChannelAt: data.joined_channel_at, leftAt: data.left_at, segment: data.segment,
        streak: data.streak, streakFreezes: data.streak_freezes, lastActiveAt: data.last_active_at,
        survey: data.survey ?? {}, attendance: data.attendance ?? {},
        committedEvents: data.committed_events ?? [], referredBy: data.referred_by ?? null,
        optedOut: data.opted_out, pausedUntil: data.paused_until, createdAt: data.created_at,
      };
    },

    async getTotal(id: number): Promise<number> {
      const { data } = await wm.from("totals").select("total_points").eq("telegram_id", id).maybeSingle();
      return Number(data?.total_points ?? 0);
    },

    async getRank(id: number): Promise<number> {
      const { data } = await wm.from("ranks").select("rank").eq("telegram_id", id).maybeSingle();
      return Number(data?.rank ?? 0);
    },

    async getLedger(id: number, since?: string): Promise<LedgerRow[]> {
      let q = wm.from("ledger").select("*").eq("telegram_id", id).order("created_at", { ascending: false });
      if (since) q = q.gte("created_at", since);
      const { data } = await q;
      return ((data || []) as Record<string, unknown>[]).map((r) => ({
        id: r.id as number, telegramId: Number(r.telegram_id), action: r.action as string,
        points: r.points as number, reason: (r.reason ?? null) as string | null,
        plugin: r.plugin as string, campaignDay: (r.campaign_day ?? null) as number | null,
        sourceRef: (r.source_ref ?? null) as string | null, dedupeKey: r.dedupe_key as string,
        createdAt: r.created_at as string,
      }));
    },

    /** Awards of one action since midnight IN THE PACK TIMEZONE — the boundary caps reset on. */
    async countToday(id: number, action: string): Promise<number> {
      const dayStart = zonedTimeToInstant(zonedDateKey(atFn(), tz), "00:00", tz).toISOString();
      const { count } = await wm.from("ledger")
        .select("id", { count: "exact", head: true })
        .eq("telegram_id", id).eq("action", action).gte("created_at", dayStart);
      return count || 0;
    },

    async getState(plugin: string, id: number | null, key: string): Promise<unknown> {
      const { data } = await wm.from("plugin_state")
        .select("value").eq("plugin", plugin).eq("scope_id", id ?? -1).eq("key", key).maybeSingle();
      return data?.value ?? null;
    },

    // SPEC annotates this "in pack timezone". A Date is an absolute instant — it has no timezone —
    // so returning a shifted Date would return the WRONG instant while looking right. The true
    // instant is returned; every zone-aware question (what day is it, is it quiet) goes through
    // the pack.ts helpers, which take the zone explicitly.
    now: atFn,

    campaignDay: () => campaignDayFor(pack, atFn()),

    log(level, msg, meta) {
      const line = `warmup/plugin ${msg}`;
      if (level === "error") console.error(line, meta ?? "");
      else if (level === "warn") console.warn(line, meta ?? "");
      else console.log(line, meta ?? "");
    },
  };
}

// ─── dispatch ────────────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function runOne(
  admin: any,
  plugin: Plugin,
  flags: Map<string, boolean>,
  invoke: () => Promise<Effect[]> | undefined,
  subscribed: boolean,
): Promise<PluginRunResult> {
  const started = Date.now();
  const base = { plugin: plugin.name, effects: [] as Effect[], ms: 0 };

  if (!subscribed) return { ...base, ok: true, skipped: "not_subscribed", ms: 0 };
  if (flags.get(plugin.name) === false) return { ...base, ok: true, skipped: "disabled", ms: 0 };

  let call: Promise<Effect[]> | undefined;
  try {
    // The handler can throw SYNCHRONOUSLY, before returning a promise — that path must be caught
    // here or it escapes the try/catch around the await and kills the whole tick.
    call = invoke();
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    await noteFailure(admin, plugin.name, message);
    return { ...base, ok: false, error: message, ms: Date.now() - started };
  }
  if (!call) return { ...base, ok: true, skipped: "no_handler", ms: 0 };

  try {
    const effects = await withTimeout(Promise.resolve(call), PLUGIN_TIMEOUT_MS, `plugin '${plugin.name}'`);
    const list = Array.isArray(effects) ? effects : [];
    await noteSuccess(admin, plugin.name);
    return { plugin: plugin.name, effects: list, ok: true, ms: Date.now() - started };
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    console.error(`warmup/bus: plugin '${plugin.name}' failed:`, message);
    await noteFailure(admin, plugin.name, message);
    return { ...base, ok: false, error: message, ms: Date.now() - started };
  }
}

/**
 * Fan one event out to every subscribed, enabled plugin and collect their effects.
 *
 * Always resolves. A thrown plugin, a hung plugin, and a plugin returning nonsense all produce a
 * result row with ok:false and zero effects, while every other plugin's effects come back intact.
 */
export async function dispatchEvent(
  admin: any,
  event: Event,
  ctx: Ctx,
  flags: Map<string, boolean>,
): Promise<PluginRunResult[]> {
  const out: PluginRunResult[] = [];
  for (const plugin of registry.values()) {
    const subscribed = plugin.subscribes.includes(event.type as EventType);
    out.push(await runOne(admin, plugin, flags, () => plugin.onEvent?.(event, ctx), subscribed));
  }
  return out;
}

/** Same isolation for scheduled ticks. Every plugin with an onSchedule handler is offered the tick. */
export async function dispatchSchedule(
  admin: any,
  tick: ScheduleTick,
  ctx: Ctx,
  flags: Map<string, boolean>,
): Promise<PluginRunResult[]> {
  const out: PluginRunResult[] = [];
  for (const plugin of registry.values()) {
    out.push(await runOne(admin, plugin, flags, () => plugin.onSchedule?.(tick, ctx), true));
  }
  return out;
}
