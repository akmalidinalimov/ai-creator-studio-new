// SLICE 0 ACCEPTANCE — TASKS.md, run against a real PostgreSQL.
//
//   deno run -A --node-modules-dir=none supabase/functions/_warmup/testing/slice0-acceptance.ts
//
// --node-modules-dir=none is required: this repo has a package.json, so Deno would otherwise look
// for PGlite in node_modules (where it is not, and should not be — it is a Deno-side test dep).
//
// Not a *.test.ts, deliberately: it needs network (to fetch the PGlite WASM package) and full
// permissions, and CI runs `deno test supabase/functions/` with neither. The pure unit suites
// (_warmup/*.test.ts, warmup-webhook/normalise.test.ts) are the CI-blocking half; this is the
// integration half, run before shipping a change to the engine.
//
// The real modules run unmodified. Only Telegram is replaced — by a sender that records calls, so
// "no sends left" is proven by an empty array rather than by reading the code.

import { bootWarmupDb } from "./pglite-client.ts";
import { testPack } from "./pack-fixture.ts";
import { applyEffects } from "../applier.ts";
import { clearPlugins, registerPlugin } from "../bus.ts";
import { govern } from "../governor.ts";
import { invalidatePackCache } from "../pack.ts";
import { ingestUpdate } from "../../warmup-webhook/ingest.ts";
import { runDispatch } from "../../warmup-dispatch/run.ts";
import { runDrainer } from "../../warmup-drainer/run.ts";
import type { Effect, Event, Plugin } from "../types.ts";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  PASS  ${n}${d ? "  — " + d : ""}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? "  — " + d : ""}`); }
};

const { db, admin } = await bootWarmupDb();
const pack = testPack();

// The campaign is "running", at 14:00 Tashkent — inside the open sending window.
const NOW = new Date("2099-01-02T09:00:00Z");
await db.query(`INSERT INTO warmup.campaign_pack (version,pack,status) VALUES ($1,$2::jsonb,'active')`,
  [pack.manifest.pack_version, JSON.stringify(pack)]);
invalidatePackCache();

const CHANNEL = -1000000000001, GROUP = -1000000000002;
const ALICE = 111, BOB = 222, CAROL = 333;      // Carol never pressed Start
for (const [id, started] of [[ALICE, true], [BOB, true], [CAROL, false]] as [number, boolean][]) {
  await db.query(`INSERT INTO warmup.participants (telegram_id, started_bot, first_name) VALUES ($1,$2,$3)`,
    [id, started, `u${id}`]);
}

let goodRuns = 0, boomRuns = 0;
const points: Plugin = {
  name: "points-basic", version: "1.0.0",
  subscribes: ["reaction.added", "message.posted"],
  onEvent(e: Event): Promise<Effect[]> {
    goodRuns++;
    const action = e.type === "reaction.added" ? "reaction" : "comment";
    return Promise.resolve([{
      kind: "award", telegramId: e.telegramId!, action,
      points: pack.economy.points[action].value ?? 0,
      sourceRef: `${action}:${e.chatId}:${e.messageId}`,
    }]);
  },
};
const broken: Plugin = {
  name: "deliberately-broken", version: "0.0.1",
  subscribes: ["reaction.added", "message.posted"],
  onEvent(): Promise<Effect[]> { boomRuns++; throw new Error("I am a deliberately broken plugin"); },
};
clearPlugins();
registerPlugin(points);
registerPlugin(broken);

const reactionUpdate = (updateId: number, user: number, msgId: number) => ({
  update_id: updateId,
  message_reaction: {
    chat: { id: CHANNEL, type: "channel" }, message_id: msgId, date: 1,
    user: { id: user, username: `u${user}`, first_name: `U${user}` },
    old_reaction: [], new_reaction: [{ type: "emoji", emoji: "🔥" }],
  },
});
const commentUpdate = (updateId: number, user: number, msgId: number, text: string) => ({
  update_id: updateId,
  message: {
    message_id: msgId, date: 1, chat: { id: GROUP, type: "supergroup", title: "discussion" },
    from: { id: user, is_bot: false, username: `u${user}`, first_name: `U${user}` }, text,
  },
});

console.log("=== ACCEPTANCE 1: a reaction in the channel reaches warmup.events ===");
const t0 = performance.now();
const r1 = await ingestUpdate(admin, pack, reactionUpdate(9001, ALICE, 500));
const elapsed = performance.now() - t0;
let ev = await db.query(`select event_type, telegram_id, chat_id, message_id from warmup.events`);
ok("one event row written", ev.rows.length === 1 && r1.ingested === 1, JSON.stringify(ev.rows[0]));
ok("classified as reaction.added", (ev.rows[0] as any)?.event_type === "reaction.added");
ok("attributed to the reacting user", Number((ev.rows[0] as any)?.telegram_id) === ALICE);
ok("well inside the 2s budget", elapsed < 2000, `${elapsed.toFixed(1)}ms`);

console.log("\n=== ACCEPTANCE 2: a group comment reaches warmup.events ===");
await ingestUpdate(admin, pack, commentUpdate(9002, BOB, 501, "this is a real comment"));
ev = await db.query(`select event_type, telegram_id from warmup.events where chat_id=${GROUP}`);
ok("group message ingested", ev.rows.length === 1, JSON.stringify(ev.rows[0]));
ok("classified as message.posted", (ev.rows[0] as any)?.event_type === "message.posted");
console.log("  NOTE  proves the NORMALISER handles a group message. Whether Telegram DELIVERS one");
console.log("        depends on BotFather privacy mode being off — only provable on a live group.");

console.log("\n=== ACCEPTANCE 3: the same webhook payload twice → exactly ONE ledger row ===");
await ingestUpdate(admin, pack, reactionUpdate(9001, ALICE, 500));   // byte-identical replay
await ingestUpdate(admin, pack, reactionUpdate(9001, ALICE, 500));
const evCount = await db.query(`select count(*)::int n from warmup.events where update_id=9001`);
ok("layer 1 — a replayed update inserts no new event", (evCount.rows[0] as any).n === 1,
   `${(evCount.rows[0] as any).n} event row(s)`);

const d1 = await runDispatch(admin, NOW);
let led = await db.query(`select telegram_id, action, points, plugin from warmup.ledger order by id`);
ok("dispatch awarded once", led.rows.length === 2, JSON.stringify(led.rows));
ok("each award is attributed to the plugin that decided it",
   led.rows.every((r: any) => r.plugin === "points-basic"));

// Force the second layer: re-open the events, as a redelivered or re-claimed event would.
await db.exec(`UPDATE warmup.events SET processed_at=NULL, claimed_at=NULL`);
const d2 = await runDispatch(admin, NOW);
led = await db.query(`select count(*)::int n, coalesce(sum(points),0)::int p from warmup.ledger`);
ok("layer 2 — re-dispatching the SAME events awards nothing new",
   (led.rows[0] as any).n === 2 && d2.effectsDeduped === 2,
   `${(led.rows[0] as any).n} rows, ${(led.rows[0] as any).p} points, ${d2.effectsDeduped} deduped`);
const totals = await db.query(`select telegram_id, total_points from warmup.totals order by telegram_id`);
const seen = (totals.rows as any[]).map((r) => `${Number(r.telegram_id)}=${Number(r.total_points)}`).join(",");
ok("totals unchanged after the replay", seen === "111=1,222=2", seen);

console.log("\n=== ACCEPTANCE 4: a throwing plugin is caught, auto-disabled — the bot survives ===");
ok("the broken plugin ran and threw", boomRuns > 0, `${boomRuns} invocations`);
ok("the healthy plugin still ran in the same batch", goodRuns > 0, `${goodRuns} invocations`);
ok("dispatch reported plugin errors instead of crashing", d1.pluginErrors > 0, `${d1.pluginErrors} errors`);
let reg = await db.query(`select plugin, enabled, consecutive_errors from warmup.plugin_registry order by plugin`);
ok("the failure is DB-visible, not log-only",
   reg.rows.some((r: any) => r.plugin === "deliberately-broken" && r.consecutive_errors > 0),
   JSON.stringify(reg.rows.map((r: any) => `${r.plugin}:err=${r.consecutive_errors}:on=${r.enabled}`)));

for (let i = 0; i < 6; i++) {                    // keep feeding it until it trips the threshold
  await ingestUpdate(admin, pack, commentUpdate(9100 + i, BOB, 600 + i, `comment number ${i}`));
  await runDispatch(admin, NOW);
}
reg = await db.query(`select plugin, enabled, consecutive_errors, disabled_reason from warmup.plugin_registry order by plugin`);
const brokenRow = reg.rows.find((r: any) => r.plugin === "deliberately-broken") as any;
const healthyRow = reg.rows.find((r: any) => r.plugin === "points-basic") as any;
ok("the broken plugin is AUTO-DISABLED", brokenRow?.enabled === false, brokenRow?.disabled_reason ?? "");
ok("the healthy plugin stays enabled with a clean error count",
   healthyRow?.enabled === true && healthyRow?.consecutive_errors === 0);
const boomBefore = boomRuns;
await ingestUpdate(admin, pack, commentUpdate(9200, BOB, 700, "after the disable"));
const d3 = await runDispatch(admin, NOW);
ok("a disabled plugin is no longer invoked", boomRuns === boomBefore, `${boomRuns - boomBefore} extra calls`);
ok("the bot keeps running and keeps awarding", d3.processed === 1 && d3.effectsApplied === 1,
   `processed=${d3.processed} applied=${d3.effectsApplied}`);

console.log("\n=== ACCEPTANCE 5: the kill switch stops all sends ===");
const sends: { method: string; payload: Record<string, unknown> }[] = [];
const recorder = (method: string, payload: Record<string, unknown>) => {
  sends.push({ method, payload });
  return Promise.resolve({ ok: true, status: 200, error: null, terminal: false, recipient: false, content: false });
};
await applyEffects(admin, pack, [
  { kind: "send", telegramId: ALICE, surface: "dm", msgKind: "push", payload: { copyKey: "day1.midday" } },
  { kind: "send", chatId: CHANNEL, surface: "channel", msgKind: "push", payload: { copyKey: "day1.evening" } },
], { plugin: "test", campaignDay: 2 });
let queued = await db.query(`select count(*)::int n from warmup.outbox where status='queued'`);
ok("two sends queued", (queued.rows[0] as any).n === 2);

await db.query(`INSERT INTO public.platform_settings (key,value) VALUES ('warmup','{"enabled": false}'::jsonb)`);
const off = await runDrainer(admin, { now: NOW, sender: recorder, pace: 0 });
ok("the drainer refuses to run", off.note === "warmup_disabled" && off.sent === 0, JSON.stringify(off));
ok("ZERO Telegram calls made", sends.length === 0, `${sends.length} calls`);
queued = await db.query(`select count(*)::int n from warmup.outbox where status='queued'`);
ok("messages stay queued, nothing dropped — the switch is reversible", (queued.rows[0] as any).n === 2);
ok("dispatch honours it too", (await runDispatch(admin, NOW)).note === "warmup_disabled");

await db.query(`UPDATE public.platform_settings SET value='{"enabled": true}'::jsonb WHERE key='warmup'`);
const on = await runDrainer(admin, { now: NOW, sender: recorder, pace: 0 });
ok("switching back on releases the queue", on.sent === 2 && sends.length === 2,
   `sent=${on.sent} calls=${sends.length}`);
ok("copy came from the pack, not from code",
   sends[0].payload.text === "Day 1 midday post.", String(sends[0].payload.text));

console.log("\n=== the kill switch's default ===");
await db.query(`DELETE FROM public.platform_settings WHERE key='warmup'`);
await applyEffects(admin, pack, [
  { kind: "send", telegramId: ALICE, surface: "dm", msgKind: "push", payload: { copyKey: "day1.task" } },
], { plugin: "test", campaignDay: 2 });
const absent = await runDrainer(admin, { now: NOW, sender: recorder, pace: 0 });
ok("an absent row means ENABLED, so Slice 0 needs no write to the public schema",
   absent.note !== "warmup_disabled", JSON.stringify({ note: absent.note, sent: absent.sent }));

console.log("\n=== the governor ===");
const QUIET = new Date("2099-01-02T18:00:00Z");  // 23:00 Tashkent
const vQuiet = await govern(admin, pack, { surface: "dm", kind: "push", telegramId: CAROL }, QUIET);
ok("quiet hours DEFER a push — it is still wanted at 08:00",
   vQuiet.allow === false && (vQuiet as any).action === "defer", JSON.stringify(vQuiet));
ok("a reply is PULL and is not held overnight",
   (await govern(admin, pack, { surface: "group", kind: "reply", telegramId: CAROL }, QUIET)).allow === true);
ok("a reaction is unlimited and ungated",
   (await govern(admin, pack, { surface: "group", kind: "react", chatId: GROUP }, QUIET)).allow === true);

// dm_per_day = 2, and the DM budget belongs to a PERSON.
await db.query(`INSERT INTO warmup.outbox (telegram_id,surface,kind,payload,scheduled_for,status,sent_at)
  VALUES (${BOB},'dm','push','{}'::jsonb,$1,'sent',$1), (${BOB},'dm','push','{}'::jsonb,$1,'sent',$1)`,
  [NOW.toISOString()]);
const vBob = await govern(admin, pack, { surface: "dm", kind: "push", telegramId: BOB }, NOW);
ok("Bob has spent his 2 DMs → dropped with a reason",
   vBob.allow === false && (vBob as any).reason.startsWith("dm_budget_exhausted"), JSON.stringify(vBob));
ok("Alice is unaffected — the DM budget is per person, not global",
   (await govern(admin, pack, { surface: "dm", kind: "push", telegramId: ALICE }, NOW)).allow === true);

// channel_per_day = 2, and the channel budget is GLOBAL.
await db.query(`INSERT INTO warmup.outbox (chat_id,surface,kind,payload,scheduled_for,status,sent_at)
  VALUES (${CHANNEL},'channel','push','{}'::jsonb,$1,'sent',$1), (${CHANNEL},'channel','push','{}'::jsonb,$1,'sent',$1)`,
  [NOW.toISOString()]);
const vChan = await govern(admin, pack, { surface: "channel", kind: "push", chatId: CHANNEL }, NOW);
ok("the channel budget is exhausted globally",
   vChan.allow === false && (vChan as any).reason.startsWith("channel_budget_exhausted"), JSON.stringify(vChan));
ok("a reply still passes — pull traffic does not consume the push budget",
   (await govern(admin, pack, { surface: "group", kind: "reply", telegramId: ALICE }, NOW)).allow === true);

console.log("\n=== an unreachable participant is skipped silently ===");
await applyEffects(admin, pack, [
  { kind: "send", telegramId: CAROL, surface: "dm", msgKind: "push", payload: { copyKey: "day1.midday" } },
], { plugin: "test", campaignDay: 2 });
const before = sends.length;
await runDrainer(admin, { now: NOW, sender: recorder, pace: 0 });
const carol = await db.query(
  `select status, drop_reason from warmup.outbox where telegram_id=${CAROL} order by id desc limit 1`);
ok("a never-pressed-Start participant is dropped, not retried five times",
   (carol.rows[0] as any)?.status === "dropped", JSON.stringify(carol.rows[0]));
ok("and no Telegram call was wasted on them", sends.length === before, `${sends.length - before} calls`);

console.log(`\n${"=".repeat(60)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(60)}`);
if (fail) Deno.exit(1);
