import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  campaignDayFor, CopyKeyMissingError, isEventDay, isQuietHour, nextWindowOpen,
  resolveCopy, zonedDateKey, zonedTimeToInstant,
} from "./pack.ts";
import { testPack } from "./testing/pack-fixture.ts";

const pack = testPack();                       // Asia/Tashkent (UTC+5), starts 2099-01-01, 3 days
const at = (iso: string) => new Date(iso);

// ─── campaign calendar ───────────────────────────────────────────────────────

Deno.test("campaignDay: before, during and after the campaign", () => {
  assertEquals(campaignDayFor(pack, at("2098-12-31T12:00:00Z")), null);
  assertEquals(campaignDayFor(pack, at("2099-01-01T09:00:00Z")), 1);
  assertEquals(campaignDayFor(pack, at("2099-01-03T09:00:00Z")), 3);
  assertEquals(campaignDayFor(pack, at("2099-01-04T09:00:00Z")), null);
});

// The bug this prevents: counting days in UTC would roll the campaign day five hours early for
// every participant, so an evening action would land on the next day's scorecard.
Deno.test("campaignDay rolls on the PACK timezone midnight, not UTC's", () => {
  assertEquals(campaignDayFor(pack, at("2099-01-01T18:30:00Z")), 1);   // 23:30 Tashkent
  assertEquals(campaignDayFor(pack, at("2099-01-01T19:00:00Z")), 2);   // 00:00 Tashkent
  assertEquals(zonedDateKey(at("2099-01-01T19:00:00Z"), "Asia/Tashkent"), "2099-01-02");
});

Deno.test("event days are recognised (they get their own channel budget)", () => {
  assertEquals(isEventDay(pack, at("2099-01-04T09:00:00Z")), true);
  assertEquals(isEventDay(pack, at("2099-01-03T09:00:00Z")), false);
});

// ─── quiet hours ─────────────────────────────────────────────────────────────

Deno.test("quiet hours 22:00→08:00 handle the midnight crossing", () => {
  const q = (iso: string) => isQuietHour(pack, at(iso));
  assertEquals(q("2099-01-02T08:00:00Z"), false);   // 13:00 local
  assertEquals(q("2099-01-02T16:59:00Z"), false);   // 21:59 local
  assertEquals(q("2099-01-02T17:00:00Z"), true);    // 22:00 local
  assertEquals(q("2099-01-01T21:00:00Z"), true);    // 02:00 local
  assertEquals(q("2099-01-02T02:59:00Z"), true);    // 07:59 local
  assertEquals(q("2099-01-02T03:00:00Z"), false);   // 08:00 local
});

Deno.test("nextWindowOpen defers to the correct 08:00", () => {
  // 22:30 local → tomorrow morning.
  assertEquals(nextWindowOpen(pack, at("2099-01-02T17:30:00Z")).toISOString(), "2099-01-03T03:00:00.000Z");
  // 07:00 local → this morning, only an hour away.
  assertEquals(nextWindowOpen(pack, at("2099-01-02T02:00:00Z")).toISOString(), "2099-01-02T03:00:00.000Z");
  const open = at("2099-01-02T08:00:00Z");
  assertEquals(nextWindowOpen(pack, open).getTime(), open.getTime());
});

// broadcast-core hardcodes UTC+5 for Tashkent, which is correct there and would be a bug here: the
// pack names its own zone, and a DST-observing campaign would drift an hour twice a year.
Deno.test("DST: wall-clock times resolve through the zone, not a fixed offset", () => {
  const tz = "America/New_York";                   // US DST 2099 begins Sunday 2099-03-08
  const before = zonedTimeToInstant("2099-03-07", "08:00", tz);
  const after = zonedTimeToInstant("2099-03-09", "08:00", tz);
  assertEquals(before.toISOString(), "2099-03-07T13:00:00.000Z");
  assertEquals(after.toISOString(), "2099-03-09T12:00:00.000Z");
  assertEquals(before.getUTCHours() === after.getUTCHours(), false);
});

Deno.test("DST: the campaign day does not skip or repeat across the transition", () => {
  const dst = testPack();
  dst.manifest.timezone = "America/New_York";
  dst.manifest.starts_on = "2099-03-06";
  dst.manifest.duration_days = 10;
  assertEquals(campaignDayFor(dst, at("2099-03-07T18:00:00Z")), 2);
  assertEquals(campaignDayFor(dst, at("2099-03-08T18:00:00Z")), 3);
  assertEquals(campaignDayFor(dst, at("2099-03-09T18:00:00Z")), 4);
});

// ─── copy resolution ─────────────────────────────────────────────────────────

Deno.test("a plain copy key resolves to its text", () => {
  assertEquals(resolveCopy(pack, "day1.midday"), "Day 1 midday post.");
});

// If variants were random, a redelivered message would differ from the one already sent, and
// "replaying changes nothing" would quietly stop being true for sends.
Deno.test("variant choice is deterministic in the seed", () => {
  const a = resolveCopy(pack, "cheer.first_submission", { variantSeed: "u111:d1" });
  const b = resolveCopy(pack, "cheer.first_submission", { variantSeed: "u111:d1" });
  assertEquals(a, b);
});

Deno.test("different seeds spread across every variant", () => {
  const seen = new Set(
    Array.from({ length: 40 }, (_, i) => resolveCopy(pack, "cheer.first_submission", { variantSeed: `u${i}` })));
  assertEquals(seen.size, 5);
});

Deno.test("vars interpolate; an unknown placeholder stays visible rather than blanking", () => {
  assertEquals(resolveCopy(pack, "cmd.points", { vars: { points: 12, rank: 4 } }),
    "You have 12 points, rank 4.");
  assertEquals(resolveCopy(pack, "cmd.points", { vars: { points: 12 } }),
    "You have 12 points, rank {rank}.");
});

// A blank Telegram message reaching participants is worse than a loud failure the drainer can
// record as copy_unresolvable.
Deno.test("a missing copy_key throws instead of sending an empty message", () => {
  assertThrows(() => resolveCopy(pack, "does.not.exist"), CopyKeyMissingError);
});
