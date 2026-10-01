// Pins what engagement_targeting does to the smart nudges: retire_smart_inactive_nudges stops inactive_3d /
// inactive_7d (module_complete always runs), skip_closed_courses drops a candidate with no published course, and
// every switch off is today's run. Run: deno test supabase/functions/detect-and-nudge/
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { closedForNudge, nudgeRunPlan, retiredResult } from "./nudge.ts";
import { TARGETING_OFF } from "../_shared/engagement-targeting.ts";

const C4 = "c8103dae-f8e5-463a-882f-f52b04b12223"; // closed
const C5 = "78011384-4024-49b0-b72d-b0b2e3a04ee8"; // published
const PUB = new Map<string, boolean>([[C4, false], [C5, true]]);

Deno.test("plan: every switch off → today's run (inactive nudges on, no closed-course check)", () => {
  assertEquals(nudgeRunPlan(TARGETING_OFF), { inactive: true, skipClosed: false });
});

Deno.test("plan: retire → no inactive nudges (and so no closed-course reads); skip_closed alone → checked", () => {
  assertEquals(nudgeRunPlan({ ...TARGETING_OFF, retire_smart_inactive_nudges: true }), { inactive: false, skipClosed: false });
  assertEquals(nudgeRunPlan({ skip_closed_courses: true, trial_to_course_page: true, retire_smart_inactive_nudges: true }),
    { inactive: false, skipClosed: false });
  assertEquals(nudgeRunPlan({ ...TARGETING_OFF, skip_closed_courses: true }), { inactive: true, skipClosed: true });
});

Deno.test("retired result keeps the old counters at 0 and says why", () => {
  assertEquals(retiredResult(), {
    retired: true, by: "engagement_targeting.retire_smart_inactive_nudges", sent: 0, failed: 0, skipped: 0, total: 0,
  });
});

Deno.test("closedForNudge: group course first, then the first enrollment; any published enrollment keeps the nudge", () => {
  assertEquals(closedForNudge(C5, [], PUB), false); // a published group course
  assertEquals(closedForNudge(null, [C5], PUB), false);
  assertEquals(closedForNudge(C4, [C4], PUB), true); // closed and nothing open
  assertEquals(closedForNudge(null, [C4], PUB), true);
  assertEquals(closedForNudge(C4, [C4, C5], PUB), false); // also enrolled in an open course
});

Deno.test("closedForNudge: anything unknown sends, as today", () => {
  assertEquals(closedForNudge(null, [], PUB), false); // no course at all
  assertEquals(closedForNudge(C4, [C4], null), false); // the courses read failed
  assertEquals(closedForNudge("00000000-0000-4000-8000-000000000000", [], PUB), false); // not in the map
});
