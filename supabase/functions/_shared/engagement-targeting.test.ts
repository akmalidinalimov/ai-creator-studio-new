// Pins the engagement_targeting switches: fail-closed parsing (only a JSON `true` turns one on), the 60 s cached
// reader (a read error is reported and not cached), the write helper that keeps other keys, and the closed-course
// rule shared by cron-engagement and detect-and-nudge. Run: deno test supabase/functions/_shared/
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _resetEngagementTargetingCache,
  decideReminderCourse,
  ENGAGEMENT_TARGETING_KEY,
  loadEngagementTargeting,
  parseEngagementTargeting,
  TARGETING_OFF,
  TARGETING_SWITCHES,
  withTargetingSwitch,
} from "./engagement-targeting.ts";

const C4 = "c8103dae-f8e5-463a-882f-f52b04b12223"; // closed (AI CREATORS 4.0 shape)
const C5 = "78011384-4024-49b0-b72d-b0b2e3a04ee8"; // published
const C6 = "f502f631-2104-4834-b6c2-702cd3080e27"; // published
const PUB = new Map<string, boolean>([[C4, false], [C5, true], [C6, true]]);
const ALL_ON = { skip_closed_courses: true, trial_to_course_page: true, retire_smart_inactive_nudges: true };

Deno.test("parse: only a JSON boolean true turns a switch on; anything else is today's behaviour", () => {
  assertEquals(parseEngagementTargeting(ALL_ON), ALL_ON);
  for (const v of [null, undefined, "x", 1, [], [true], { skip_closed_courses: "true" }, { skip_closed_courses: 1 }, {}]) {
    assertEquals(parseEngagementTargeting(v), TARGETING_OFF);
  }
  assertEquals(parseEngagementTargeting({ skip_closed_courses: true, trial_to_course_page: false, extra: true }), {
    skip_closed_courses: true, trial_to_course_page: false, retire_smart_inactive_nudges: false,
  });
  assertEquals([...TARGETING_SWITCHES].sort(), Object.keys(TARGETING_OFF).sort());
});

Deno.test("withTargetingSwitch: flips one key and keeps every other key of the stored object", () => {
  assertEquals(withTargetingSwitch({ skip_closed_courses: true, note: "owner" }, "trial_to_course_page", true),
    { skip_closed_courses: true, note: "owner", trial_to_course_page: true });
  assertEquals(withTargetingSwitch(null, "skip_closed_courses", false), { skip_closed_courses: false });
  assertEquals(withTargetingSwitch(["x"], "retire_smart_inactive_nudges", true), { retire_smart_inactive_nudges: true });
});

function fakeAdmin(result: { data?: unknown; error?: unknown } | "throw") {
  let reads = 0;
  const keys: string[] = [];
  const admin = {
    get reads() {
      return reads;
    },
    keys,
    from(table: string) {
      assertEquals(table, "platform_settings");
      const b = {
        select: () => b,
        eq: (_c: string, v: string) => {
          keys.push(v);
          return b;
        },
        maybeSingle: () => {
          reads++;
          if (result === "throw") return Promise.reject(new Error("socket hang up"));
          return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
        },
      };
      return b;
    },
  };
  return admin;
}

Deno.test("loader: reads platform_settings.engagement_targeting, caches 60 s", async () => {
  _resetEngagementTargetingCache();
  const a = fakeAdmin({ data: { value: ALL_ON } });
  assertEquals(await loadEngagementTargeting(a, 1_000), { targeting: ALL_ON, error: null });
  assertEquals(await loadEngagementTargeting(a, 50_000), { targeting: ALL_ON, error: null });
  assertEquals(a.reads, 1);
  assertEquals(a.keys, [ENGAGEMENT_TARGETING_KEY]);
  await loadEngagementTargeting(a, 62_000);
  assertEquals(a.reads, 2);
});

Deno.test("loader: an absent row is today's behaviour, no error", async () => {
  _resetEngagementTargetingCache();
  assertEquals(await loadEngagementTargeting(fakeAdmin({ data: null }), 1), { targeting: TARGETING_OFF, error: null });
});

Deno.test("loader: a read error or a throw is today's behaviour WITH the error, and is not cached", async () => {
  _resetEngagementTargetingCache();
  const bad = fakeAdmin({ error: { message: "permission denied" } });
  assertEquals(await loadEngagementTargeting(bad, 1), { targeting: TARGETING_OFF, error: "permission denied" });
  await loadEngagementTargeting(bad, 2);
  assertEquals(bad.reads, 2);
  _resetEngagementTargetingCache();
  const r = await loadEngagementTargeting(fakeAdmin("throw"), 1);
  assertEquals(r, { targeting: TARGETING_OFF, error: "socket hang up" });
  // The returned object is a copy: a caller mutating it cannot flip the shared default.
  r.targeting.skip_closed_courses = true;
  assertEquals(TARGETING_OFF.skip_closed_courses, false);
});

Deno.test("closed rule: switch off / unknown → today's course, unchanged", () => {
  const same = { courseId: C4, closed: false, redirected: false };
  assertEquals(decideReminderCourse(C4, false, PUB, []), same); // switch off
  assertEquals(decideReminderCourse(C4, true, null, []), same); // courses read failed
  assertEquals(decideReminderCourse(C4, true, PUB, null), same); // enrollments unknown
  const ghost = "00000000-0000-4000-8000-000000000000";
  assertEquals(decideReminderCourse(ghost, true, PUB, []), { courseId: ghost, closed: false, redirected: false }); // not in map
  assertEquals(decideReminderCourse(null, true, PUB, []), { courseId: null, closed: false, redirected: false });
});

Deno.test("closed rule: a published course is never touched", () => {
  assertEquals(decideReminderCourse(C5, true, PUB, [C5]), { courseId: C5, closed: false, redirected: false });
  assertEquals(decideReminderCourse(C5, true, PUB, [C4, C5]), { courseId: C5, closed: false, redirected: false });
});

Deno.test("closed rule: closed + a published enrollment → re-pointed there; closed only → skipped", () => {
  assertEquals(decideReminderCourse(C4, true, PUB, [C4, C6]), { courseId: C6, closed: false, redirected: true });
  assertEquals(decideReminderCourse(C4, true, PUB, [C4]), { courseId: null, closed: true, redirected: false });
  assertEquals(decideReminderCourse(C4, true, PUB, []), { courseId: null, closed: true, redirected: false });
  // An enrollment in a course missing from the map is not "published": still skipped.
  assertEquals(decideReminderCourse(C4, true, PUB, [C4, "00000000-0000-4000-8000-000000000000"]),
    { courseId: null, closed: true, redirected: false });
});
