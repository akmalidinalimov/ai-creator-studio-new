// The ☰ SWEEP — sets the Mini App menu button (and the "/" command lists) for EVERY current member, without
// sending a single message (UX review 2026-09-30, quick win #2 + #14).
//
// WHY: the live sync (menu-button.ts) only reaches a member who writes to the bot or taps a button; 55 of 157
// current students had never been given the ☰ app door, and nothing ever set it in bulk.
//
// WHO (loadSweepTargets) — members only, never a stranger:
//   students  profiles in a group of a PUBLISHED course (5.0, Challenge 6.0), status active, not archived,
//             with a telegram_id
//   staff     user_roles admin / teacher, status active, not archived, with a telegram_id
//   The persona is getPersona()'s: admin > teacher > student. A teacher gets 📝 Ustoz + the teacher "/" list.
//
// HOW — bounded, idempotent, rate-limited, re-runnable, DB-visible:
//   * It rides the webhook's existing minute tick (action "sweep_pending", sent by notify-homework-submission
//     every minute) in the background (EdgeRuntime.waitUntil), so no new cron job and no migration. It can
//     also be run on demand: internal action "menu_button_sweep" ({restart:true} starts a fresh pass).
//   * One PASS walks every target once, in profile-id order, BATCH_MAX per tick, one Telegram call at a time
//     with SPACING_MS between calls (≤ ~16 calls/s, under Telegram's ~20/s guidance), inside a TIME_BUDGET_MS.
//     setChatMenuButton / setMyCommands are idempotent: re-applying the same menu changes nothing.
//   * Progress lives in app_settings 'menu_button_sweep' (admin-only RLS): pass key, cursor, done, per-outcome
//     totals, last tick, last stop. A tick claims it with an optimistic `rev` check plus a short lease, so two
//     overlapping ticks cannot both run a batch.
//   * A new pass starts when the desired state changes (a flag flip, a new label/URL, a new command list, a
//     `rerun` value) and every 6 hours otherwise — which is how new members (Challenge 6.0 joins) get the button
//     and how a flipped kill-switch converges on everyone, not only on the members who happen to write.
//   * Finished pass → one admin_actions 'menu_button_sweep_pass' row with the totals. Refusals and failures are
//     recorded by menu-button.ts (a refused student web_app menu → 'miniapp_button_rejected', which
//     watch_button_watchdog alarms on; a refused staff /tg/teacher menu → 'teacher_miniapp_button_rejected',
//     kept out of the student detector). A 429 or a bot-wide failure (401/404) stops the tick and backs off; the
//     cursor does not move past a member who was not processed.
//
// ONE MEMBER CAN NEVER FREEZE A PASS (incident 2026-10-01). A per-member answer — ok, unreachable (blocked, never
// started, "user not found"), or any other failure — is counted and the cursor moves on. Only a REFUSAL of our
// button (a 400 that positively names a button / web app) can stop the pass, because that one is normally global:
// our URL or label, refused for everyone. But a stop must never repeat forever on one member, so (decideRefusal):
//   1st refusal of member X      stop BEFORE X, back off 30 min, remember X as the `suspect` (phase backoff).
//   X refused AGAIN after that    probation: step past X and let the NEXT member with the SAME menu decide —
//                                   accepted  → it was about X: one 'menu_button_sweep_member_skipped' row (profile
//                                               id + Telegram's description, never the token), X stays skipped
//                                               until the next pass, the pass goes on;
//                                   refused   → it is our button (GLOBAL): rewind to just before X, stop, back off
//                                               again (and say so once a day in 'menu_button_sweep_failed').
//                                 A probation the pass runs out of members to decide ends as a skip.
// Before the fix, "user not found" read as a refusal and the sweep stopped on member 96 of 166 every 30 minutes;
// the 6-hour re-pass never ran and ~70 members never got the ☰ door.
//
// LIVENESS (read by watch_button_health → watch_button_watchdog, migration 20261001050010): `last_progress_at`
// is stamped whenever a tick moves the cursor forward; `stop_cursor` / `stop_repeats` count consecutive hard stops
// (refused / bot-wide) at the same cursor. Not done and no progress for 2 h, the same cursor stopped twice, or a
// finished pass whose re-pass is 2 h overdue → the watchdog DMs the admins.
//
// KILL-SWITCHES: platform_settings 'menu_button_sweep' {"enabled": false} stops the sweep (an absent row = on;
// `"rerun": "<anything new>"` forces a fresh pass). student_miniapp / teacher_miniapp decide WHAT is set: with
// a flag off the sweep resets that role's ☰ to Telegram's default — the kill-switch reaches everyone. A
// settings read error never counts as "off": the tick stops without touching anyone.
import { logHealth, logHealthOnce } from "../_shared/edge.ts";
import { applyGlobalCommands, COMMANDS_VERSION, type Locale, type TgCall } from "./bot-commands.ts";
import { applyChatCommands, applyMenuButton, botCall, isStaff, menuButtonFor, menuKey, type MenuRole } from "./menu-button.ts";
import type { SendOutcome } from "../_shared/telegram-send.ts";

export const PROGRESS_KEY = "menu_button_sweep"; // app_settings
export const SWITCH_KEY = "menu_button_sweep"; // platform_settings
export const SWEEP_VERSION = 1;
export const BATCH_MAX = 40;
export const SPACING_MS = 60;
export const TIME_BUDGET_MS = 25_000;
export const REPASS_MS = 6 * 3_600_000; // ~170 idempotent calls per re-pass; new members wait ≤ 6 h (or write to the bot)
export const LEASE_MS = 120_000;
export const BACKOFF_MS: Record<string, number> = {
  rejected: 30 * 60_000,
  global: 30 * 60_000,
  rate_limited: 2 * 60_000,
  targets_read_failed: 5 * 60_000,
};
/** Stops that count toward `stop_repeats` (a 429 is flow control, a read error is retried every 5 min). */
const HARD_STOPS = new Set(["rejected", "global"]);

// deno-lint-ignore no-explicit-any
type Db = any;

// ─────────────────────────── settings ───────────────────────────
export type SweepSettings = { enabled: boolean; student: boolean; teacher: boolean; rerun: string };

/** platform_settings rows → what to set. Mirrors the webhook's readers exactly (see the header). */
export function parseSweepSettings(rows: { key: string; value: unknown }[]): SweepSettings {
  const by = new Map(rows.map((r) => [r.key, (r.value && typeof r.value === "object") ? r.value as Record<string, unknown> : {}]));
  const sw = by.get(SWITCH_KEY);
  const t = by.get("teacher_miniapp");
  return {
    // absent → on; a present row is off only on a literal false
    enabled: !sw || sw.enabled !== false,
    // absent → OFF; only a literal true (loadStudentMiniAppEnabled)
    student: by.get("student_miniapp")?.enabled === true,
    // absent → ON; a present row only on a literal true (loadTeacherMiniAppEnabled)
    teacher: !t || t.enabled === true,
    rerun: sw && sw.rerun != null ? String(sw.rerun).slice(0, 64) : "",
  };
}

/** Everything that decides what a member should end up with. A change starts a new pass. */
export function passKey(s: SweepSettings, base: string): string {
  return `v${SWEEP_VERSION}|c${COMMANDS_VERSION}|s${s.student ? 1 : 0}|t${s.teacher ? 1 : 0}|${base}|${s.rerun}`;
}

// ─────────────────────────── progress ───────────────────────────
export type Totals = {
  targets: number;
  students: number;
  staff: number;
  processed: number;
  ok: number;
  unreachable: number;
  rejected: number;
  /** Members stepped past after a second refusal that another member's acceptance proved was about them. */
  skipped: number;
  failed: number;
  commands_ok: number;
  commands_failed: number;
  global_commands_ok: number;
  global_commands_failed: number;
};

export type Progress = {
  version: number;
  rev: number;
  pass_key: string;
  pass_started_at: string;
  cursor: string | null;
  done: boolean;
  finished_at: string | null;
  lease_until: string | null;
  retry_after: string | null;
  last_tick_at: string | null;
  last_stop: string | null;
  /** The bot-wide "/" lists were sent for this pass (once per pass, even when a later tick finishes it). */
  global_commands_sent: boolean;
  ticks: number;
  totals: Totals;
  /** The member whose button refusal stopped the pass, until a later answer decides it (see the header). */
  suspect: Suspect | null;
  /** When a tick last moved the cursor forward (null: not yet in this pass → the detector uses pass_started_at). */
  last_progress_at: string | null;
  /** The cursor of the last hard stop and how many consecutive hard stops happened there. */
  stop_cursor: string | null;
  stop_repeats: number;
};

export type Suspect = {
  /** profiles.id of the refused member (an internal id — never a Telegram id or the token). */
  id: string;
  role: MenuRole;
  /** menuKey of the refused menu: only a member with the SAME menu can decide the probation. */
  menu: string;
  status: number;
  /** Telegram's description only. */
  error: string | null;
  phase: "backoff" | "probe";
  /** The cursor just before this member — where a GLOBAL verdict rewinds to. */
  prev_cursor: string | null;
  first_at: string;
  refusals: number;
};

export const emptyTotals = (): Totals => ({
  targets: 0, students: 0, staff: 0, processed: 0, ok: 0, unreachable: 0, rejected: 0, skipped: 0, failed: 0,
  commands_ok: 0, commands_failed: 0, global_commands_ok: 0, global_commands_failed: 0,
});

export function freshProgress(key: string, nowMs: number, rev: number): Progress {
  return {
    version: SWEEP_VERSION, rev, pass_key: key, pass_started_at: new Date(nowMs).toISOString(), cursor: null,
    done: false, finished_at: null, lease_until: null, retry_after: null, last_tick_at: null, last_stop: null,
    global_commands_sent: false, ticks: 0, totals: emptyTotals(),
    suspect: null, last_progress_at: null, stop_cursor: null, stop_repeats: 0,
  };
}

/** A stored suspect, or null when it is absent or not the shape this code writes. */
export function parseSuspect(v: unknown): Suspect | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id || typeof o.menu !== "string") return null;
  if (o.phase !== "backoff" && o.phase !== "probe") return null;
  const role: MenuRole = o.role === "teacher" || o.role === "admin" ? o.role : "student";
  return {
    id: o.id, role, menu: o.menu, status: Number(o.status) || 0, error: o.error == null ? null : String(o.error).slice(0, 300),
    phase: o.phase, prev_cursor: typeof o.prev_cursor === "string" ? o.prev_cursor : null,
    first_at: typeof o.first_at === "string" ? o.first_at : new Date(0).toISOString(),
    refusals: Number.isInteger(o.refusals) ? Number(o.refusals) : 1,
  };
}

/** The stored jsonb → a Progress, or null when there is no usable row. Rows written before 2026-10-01 parse too. */
export function parseProgress(v: unknown): Progress | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.pass_key !== "string" || !Number.isInteger(o.rev)) return null;
  return {
    ...freshProgress(o.pass_key, Date.parse(String(o.pass_started_at)) || 0, Number(o.rev)),
    ...(o as Partial<Progress>),
    totals: { ...emptyTotals(), ...((o.totals && typeof o.totals === "object") ? o.totals as Partial<Totals> : {}) },
    suspect: parseSuspect(o.suspect),
    last_progress_at: typeof o.last_progress_at === "string" ? o.last_progress_at : null,
    stop_cursor: typeof o.stop_cursor === "string" ? o.stop_cursor : null,
    stop_repeats: Number.isInteger(o.stop_repeats) && Number(o.stop_repeats) > 0 ? Number(o.stop_repeats) : 0,
  };
}

// ─────────────────────────── one refusal: stop, probe, skip or rewind ───────────────────────────
export type RefusalVerdict =
  /** First refusal of this member: stop BEFORE them and back off; they become the suspect. */
  | { action: "stop_first"; suspect: Suspect }
  /** The suspect refused again after a backoff: step past them; the next member with the same menu decides. */
  | { action: "probe"; suspect: Suspect }
  /** A second member refused while the suspect is on probation: our button — rewind to before the suspect, stop. */
  | { action: "global"; suspect: Suspect; rewindTo: string | null };

/**
 * What a button REFUSAL of target `t` means, given the current suspect. Pure — pinned by menu-sweep.test.ts.
 * `cursor` is the cursor before `t` (everything up to it is processed).
 */
export function decideRefusal(
  suspect: Suspect | null,
  t: { id: string; role: MenuRole },
  menu: string,
  o: { status: number; error: string | null },
  cursor: string | null,
  nowMs: number,
): RefusalVerdict {
  if (suspect && suspect.phase === "probe" && suspect.id !== t.id) {
    return { action: "global", suspect: { ...suspect, phase: "backoff" }, rewindTo: suspect.prev_cursor };
  }
  if (suspect && suspect.id === t.id) {
    return {
      action: "probe",
      suspect: { ...suspect, phase: "probe", menu, status: o.status, error: o.error, prev_cursor: cursor, refusals: suspect.refusals + 1 },
    };
  }
  return {
    action: "stop_first",
    suspect: {
      id: t.id, role: t.role, menu, status: o.status, error: o.error, phase: "backoff", prev_cursor: cursor,
      first_at: new Date(nowMs).toISOString(), refusals: 1,
    },
  };
}

/** The stop bookkeeping the liveness detector reads: consecutive HARD stops at the same cursor. Pure. */
export function nextStopRepeats(
  prev: { stop_cursor: string | null; stop_repeats: number },
  stop: string | null,
  cursor: string | null,
  advanced: boolean,
): { stop_cursor: string | null; stop_repeats: number } {
  if (stop && HARD_STOPS.has(stop)) {
    const same = prev.stop_repeats > 0 && prev.stop_cursor === cursor;
    return { stop_cursor: cursor, stop_repeats: same ? prev.stop_repeats + 1 : 1 };
  }
  if (!stop || advanced) return { stop_cursor: null, stop_repeats: 0 };
  return { stop_cursor: prev.stop_cursor, stop_repeats: prev.stop_repeats }; // a 429 / read error without progress
}

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

export type Plan = { run: false; reason: string } | { run: true; fresh: boolean; reason: string };

/** What this tick should do. Pure — pinned by menu-sweep.test.ts. */
export function planTick(p: Progress | null, key: string, nowMs: number, restart = false): Plan {
  const lease = ms(p?.lease_until);
  if (lease !== null && lease > nowMs) return { run: false, reason: "leased" };
  if (restart) return { run: true, fresh: true, reason: "restart" };
  if (!p) return { run: true, fresh: true, reason: "first_pass" };
  if (p.pass_key !== key) return { run: true, fresh: true, reason: "state_changed" };
  const retry = ms(p.retry_after);
  if (retry !== null && retry > nowMs) return { run: false, reason: "backoff" };
  if (!p.done) return { run: true, fresh: false, reason: "continue" };
  const fin = ms(p.finished_at);
  if (fin === null || nowMs - fin >= REPASS_MS) return { run: true, fresh: true, reason: "repass" };
  return { run: false, reason: "done" };
}

// ─────────────────────────── targets ───────────────────────────
export type SweepTarget = { id: string; chatId: number; locale: Locale; role: MenuRole };

const normLocale = (v: unknown): Locale => {
  const l = String(v ?? "").toLowerCase().slice(0, 2);
  return l === "ru" ? "ru" : l === "en" ? "en" : "uz";
};

const PROFILE_COLS = "id, telegram_id, preferred_locale";
const PAGE = 1000;

async function readProfiles(admin: Db, filter: (q: Db) => Db): Promise<{ rows: Record<string, unknown>[]; error: string | null }> {
  const rows: Record<string, unknown>[] = [];
  let after: string | null = null;
  for (let page = 0; page < 50; page++) {
    let q = filter(admin.from("profiles").select(PROFILE_COLS))
      .eq("status", "active").is("archived_at", null).not("telegram_id", "is", null);
    if (after !== null) q = q.gt("id", after);
    const { data, error } = await q.order("id", { ascending: true }).limit(PAGE);
    if (error) return { rows, error: String(error.message ?? error) };
    if (!data || data.length === 0) return { rows, error: null };
    rows.push(...data);
    after = String(data[data.length - 1].id);
  }
  return { rows, error: "too many pages" };
}

/** The members to sweep, sorted by profile id (the cursor order). Never throws. */
export async function loadSweepTargets(admin: Db): Promise<{ targets: SweepTarget[]; error: string | null }> {
  try {
    const { data: roles, error: rErr } = await admin.from("user_roles").select("user_id, role").in("role", ["admin", "teacher"]);
    if (rErr) return { targets: [], error: `user_roles: ${rErr.message ?? rErr}` };
    const staffRole = new Map<string, MenuRole>();
    for (const r of (roles ?? []) as { user_id: string; role: string }[]) {
      if (r.role === "admin") staffRole.set(r.user_id, "admin");
      else if (!staffRole.has(r.user_id)) staffRole.set(r.user_id, "teacher");
    }

    const { data: courses, error: cErr } = await admin.from("courses").select("id").eq("published", true);
    if (cErr) return { targets: [], error: `courses: ${cErr.message ?? cErr}` };
    const courseIds = ((courses ?? []) as { id: string }[]).map((c) => c.id);
    let groupIds: string[] = [];
    if (courseIds.length) {
      const { data: groups, error: gErr } = await admin.from("groups").select("id").in("course_id", courseIds);
      if (gErr) return { targets: [], error: `groups: ${gErr.message ?? gErr}` };
      groupIds = ((groups ?? []) as { id: string }[]).map((g) => g.id);
    }

    const byId = new Map<string, SweepTarget>();
    const add = (rows: Record<string, unknown>[]) => {
      for (const p of rows) {
        const id = String(p.id);
        const chatId = Number(p.telegram_id);
        if (!(chatId > 0) || byId.has(id)) continue;
        byId.set(id, { id, chatId, locale: normLocale(p.preferred_locale), role: staffRole.get(id) ?? "student" });
      }
    };
    if (groupIds.length) {
      const st = await readProfiles(admin, (q) => q.in("group_id", groupIds));
      if (st.error) return { targets: [], error: `students: ${st.error}` };
      add(st.rows);
    }
    const staffIds = [...staffRole.keys()];
    if (staffIds.length) {
      const sf = await readProfiles(admin, (q) => q.in("id", staffIds));
      if (sf.error) return { targets: [], error: `staff: ${sf.error}` };
      add(sf.rows);
    }
    const targets = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { targets, error: null };
  } catch (e) {
    return { targets: [], error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

// ─────────────────────────── the tick ───────────────────────────
export type SweepReport = {
  ran: boolean;
  reason: string;
  processed?: number;
  done?: boolean;
  stop?: string | null;
  totals?: Totals;
  cursor?: string | null;
};

export type TickOpts = {
  /** The Mini App origin the webhook's ☰ uses (index.ts MINIAPP_BASE). */
  base: string;
  restart?: boolean;
  call?: TgCall;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  batch?: number;
  budgetMs?: number;
};

const iso = (t: number) => new Date(t).toISOString();
const realSleep = (n: number) => new Promise<void>((r) => setTimeout(r, n));

async function failOnce(admin: Db, key: string, details: Record<string, unknown>) {
  await logHealthOnce(admin, "menu_button_sweep_failed", key, details, { source: "telegram-bot-webhook" });
}

/** A member stepped past after a second refusal (see the header). Once a day per member. Never the token. */
async function recordSkip(admin: Db, s: Suspect, decidedBy: "same_menu_accepted" | "pass_end", passKey: string) {
  await logHealthOnce(admin, "menu_button_sweep_member_skipped", `skip:${s.id}`, {
    fn: "menu_button_sweep",
    profile_id: s.id,
    role: s.role,
    method: "setChatMenuButton",
    status: s.status,
    error: s.error, // Telegram's description only
    refusals: s.refusals,
    first_refused_at: s.first_at,
    decided_by: decidedBy,
    pass_key: passKey,
  }, { source: "telegram-bot-webhook" });
}

/** Write the progress row only if nobody else moved it since `rev` (or create it when `exists` is false). */
async function casWrite(admin: Db, exists: boolean, rev: number, next: Progress): Promise<boolean> {
  if (!exists) {
    const { error } = await admin.from("app_settings").insert({
      key: PROGRESS_KEY,
      value: next,
      description: "☰ menu-button sweep progress (telegram-bot-webhook menu-sweep.ts). Machine-owned; delete the row to reset.",
    });
    if (error && error.code !== "23505") throw new Error(`progress insert: ${error.message ?? error}`);
    return !error;
  }
  const { data, error } = await admin.from("app_settings")
    .update({ value: next, updated_at: new Date().toISOString() })
    .eq("key", PROGRESS_KEY)
    .eq("value->>rev", String(rev))
    .select("key");
  if (error) throw new Error(`progress update: ${error.message ?? error}`);
  return Array.isArray(data) && data.length === 1;
}

/** One bounded tick. Never throws: every failure is a report reason plus a DB-visible row. */
export async function runMenuSweepTick(admin: Db, opts: TickOpts): Promise<SweepReport> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const call = opts.call ?? botCall;
  const batch = Math.max(1, Math.min(opts.batch ?? BATCH_MAX, 200));
  const budget = opts.budgetMs ?? TIME_BUDGET_MS;
  const t0 = now();
  try {
    // 1. What should members have? (a read error is never "off")
    const { data: srows, error: sErr } = await admin.from("platform_settings").select("key, value")
      .in("key", ["student_miniapp", "teacher_miniapp", SWITCH_KEY]);
    if (sErr) {
      await failOnce(admin, "settings_read", { error: String(sErr.message ?? sErr).slice(0, 200) });
      return { ran: false, reason: "settings_read_failed" };
    }
    const settings = parseSweepSettings((srows ?? []) as { key: string; value: unknown }[]);
    if (!settings.enabled) return { ran: false, reason: "disabled" };
    const key = passKey(settings, opts.base);

    // 2. Where are we?
    const { data: prow, error: pErr } = await admin.from("app_settings").select("value").eq("key", PROGRESS_KEY).maybeSingle();
    if (pErr) {
      await failOnce(admin, "progress_read", { error: String(pErr.message ?? pErr).slice(0, 200) });
      return { ran: false, reason: "progress_read_failed" };
    }
    const exists = !!prow;
    const prev = parseProgress(prow?.value);
    if (exists && !prev) {
      await failOnce(admin, "progress_unreadable", { hint: "delete app_settings 'menu_button_sweep' to reset" });
      return { ran: false, reason: "progress_unreadable" };
    }
    const plan = planTick(prev, key, t0, opts.restart === true);
    if (!plan.run) return { ran: false, reason: plan.reason };

    // 3. Claim the tick (optimistic rev + lease).
    const prevRev = prev?.rev ?? 0;
    const base: Progress = plan.fresh ? freshProgress(key, t0, prevRev) : prev!;
    const claimed: Progress = {
      ...base, rev: prevRev + 1, lease_until: iso(t0 + LEASE_MS), last_tick_at: iso(t0), ticks: base.ticks + 1,
      retry_after: null, totals: { ...base.totals },
    };
    if (!(await casWrite(admin, exists, prevRev, claimed))) return { ran: false, reason: "lost_race" };

    const totals = claimed.totals;
    const startCursor = claimed.cursor;
    let cursor = claimed.cursor;
    let suspect = claimed.suspect;
    let stop: string | null = null;
    let processed = 0;
    let remaining = 0;

    // 4. Who?
    const { targets, error: tErr } = await loadSweepTargets(admin);
    if (tErr) {
      stop = "targets_read_failed";
      await failOnce(admin, "targets_read", { error: tErr.slice(0, 200) });
    } else {
      totals.targets = targets.length;
      totals.staff = targets.filter((t) => isStaff(t.role)).length;
      totals.students = targets.length - totals.staff;

      // 5. The bot-wide "/" lists, once per pass.
      if (!claimed.global_commands_sent) {
        claimed.global_commands_sent = true;
        const g = await applyGlobalCommands(call);
        totals.global_commands_ok += g.ok;
        totals.global_commands_failed += g.failed;
        if (g.failed) {
          await logHealthOnce(admin, "menu_button_sync_failed", "sweep:setMyCommands:global", {
            fn: "menu_button_sweep", method: "setMyCommands", errors: g.errors,
          }, { source: "telegram-bot-webhook" });
        }
        await sleep(SPACING_MS);
      }

      // 6. One bounded batch. Every per-member answer moves the cursor on; only a 429, a bot-wide failure or a
      //    button refusal can stop it, and a refusal is decided per member by decideRefusal (see the header).
      const pending = targets.filter((t) => cursor === null || t.id > cursor);
      for (const t of pending) {
        if (processed >= batch || now() - t0 > budget) break;
        const on = isStaff(t.role) ? settings.teacher : settings.student;
        const mb = menuButtonFor(t.role, on, t.locale, opts.base);
        const mk = menuKey(mb, t.role, t.locale);
        let rateLimited = false;
        let last: SendOutcome | null = null;
        const counting: TgCall = async (m, p) => {
          const o = await call(m, p);
          if (o.status === 429) rateLimited = true;
          last = o;
          return o;
        };
        const out = await applyMenuButton(admin, counting, t.chatId, mb, { where: "sweep", role: t.role });
        await sleep(SPACING_MS);
        const answer = last as SendOutcome | null;
        if (rateLimited) { stop = "rate_limited"; break; }
        if (out === "global") {
          // The bot itself cannot call Telegram (token revoked / malformed): every member would fail the same way.
          stop = "global";
          await failOnce(admin, "bot_unreachable", { status: answer?.status ?? 0, error: answer?.error ?? null });
          break;
        }
        if (out === "rejected") {
          totals.rejected++;
          const v = decideRefusal(suspect, t, mk, { status: answer?.status ?? 400, error: answer?.error ?? null }, cursor, now());
          suspect = v.suspect;
          if (v.action === "stop_first") { stop = "rejected"; break; }
          if (v.action === "global") {
            // Two different members refused the same way: our button, not a member. Rewind so the suspect is
            // retried once it is fixed; the members in between are re-applied then (idempotent calls).
            stop = "rejected";
            const back = v.rewindTo;
            cursor = back;
            totals.processed = targets.filter((x) => back !== null && x.id <= back).length;
            await failOnce(admin, "global_refusal", {
              suspect_profile_id: v.suspect.id, second_profile_id: t.id, role: t.role, status: answer?.status ?? 400,
              error: answer?.error ?? null,
            });
            break;
          }
          // probe: step past the suspect; the next member with the same menu decides
          cursor = t.id;
          processed++;
          totals.processed++;
          continue;
        }
        if (out === "ok") totals.ok++;
        else if (out === "unreachable") totals.unreachable++;
        else totals.failed++;
        if (suspect) {
          if (suspect.phase === "probe" && out === "ok" && mk === suspect.menu) {
            // Another member took the very menu the suspect was refused: the refusal was about that member.
            await recordSkip(admin, suspect, "same_menu_accepted", key);
            totals.skipped++;
            suspect = null;
          } else if (suspect.phase === "backoff" && t.id >= suspect.id) {
            // The suspect answered without a refusal this time (or left the target list): nothing to decide.
            suspect = null;
          }
        }
        if (out === "ok" && isStaff(t.role)) {
          const c = await applyChatCommands(admin, counting, t.chatId, t.role, t.locale, "sweep");
          await sleep(SPACING_MS);
          if (c === "ok") totals.commands_ok++;
          else totals.commands_failed++;
          if (rateLimited) { cursor = t.id; processed++; totals.processed++; stop = "rate_limited"; break; }
        }
        cursor = t.id;
        processed++;
        totals.processed++;
      }
      remaining = targets.filter((t) => cursor === null || t.id > cursor).length;
      if (!stop && remaining === 0 && suspect?.phase === "probe") {
        // Refused on two ticks a backoff apart, and the pass ran out of members with that menu to say otherwise.
        await recordSkip(admin, suspect, "pass_end", key);
        totals.skipped++;
        suspect = null;
      }
    }

    // 7. Release with the new position.
    const tEnd = now();
    const done = !stop && remaining === 0;
    const advanced = cursor !== null && (startCursor === null || cursor > startCursor);
    const final: Progress = {
      ...claimed,
      rev: claimed.rev + 1,
      cursor,
      done,
      finished_at: done ? iso(tEnd) : null,
      lease_until: null,
      retry_after: stop ? iso(tEnd + (BACKOFF_MS[stop] ?? 5 * 60_000)) : null,
      last_stop: stop,
      totals,
      suspect: done ? null : suspect,
      last_progress_at: advanced ? iso(tEnd) : claimed.last_progress_at,
      ...nextStopRepeats(claimed, stop, cursor, advanced),
    };
    let saved = false;
    try {
      saved = await casWrite(admin, true, claimed.rev, final);
    } catch (e) {
      await failOnce(admin, "progress_write", { error: String((e as Error)?.message ?? e).slice(0, 200) });
    }
    if (!saved) {
      // The lease expires on its own; the next tick re-applies from the old cursor (idempotent calls).
      await failOnce(admin, "progress_write", { error: "rev moved or 0 rows" });
    }
    if (done && saved) {
      await logHealth(admin, "menu_button_sweep_pass", {
        pass_key: key, started_at: final.pass_started_at, finished_at: final.finished_at, ticks: final.ticks, totals,
      }, { source: "telegram-bot-webhook" });
    }
    return { ran: true, reason: plan.reason, processed, done, stop, totals, cursor };
  } catch (e) {
    await failOnce(admin, "tick_threw", { error: String((e as Error)?.message ?? e).slice(0, 200) });
    return { ran: false, reason: "threw" };
  }
}

// ─────────────────────────── the minute-tick hook ───────────────────────────
let lastScheduled = 0;

/** Test hook. */
export function _resetMenuSweepSchedule() {
  lastScheduled = 0;
}

/**
 * Start one tick in the background (at most one per isolate per ~50 s). Returns at once; the tick is bounded
 * (TIME_BUDGET_MS) and handed to EdgeRuntime.waitUntil so the caller's minute tick is not held up.
 */
export function scheduleMenuSweepTick(admin: Db, opts: TickOpts): boolean {
  const n = (opts.now ?? Date.now)();
  if (n - lastScheduled < 50_000) return false;
  lastScheduled = n;
  const task = runMenuSweepTick(admin, opts)
    .then((r) => {
      if (r.ran) console.log("menu_button_sweep", JSON.stringify({ reason: r.reason, processed: r.processed, done: r.done, stop: r.stop }));
    })
    .catch((e) => console.error("menu_button_sweep threw", String((e as Error)?.message ?? e)));
  const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (er?.waitUntil) er.waitUntil(task);
  return true;
}
