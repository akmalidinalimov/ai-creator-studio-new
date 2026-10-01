import { describe, it, expect } from "vitest";

// Parity test: src/lib/engagementTargeting.ts (the admin switch card) and
// supabase/functions/_shared/engagement-targeting.ts (cron-engagement, detect-and-nudge) are ONE definition of the
// engagement_targeting switches kept as two byte-identical copies (the web bundle cannot import from
// supabase/functions). A drift would let the card write a key the senders never read. This fails if they differ.
import * as web from "@/lib/engagementTargeting";
import * as edge from "../../supabase/functions/_shared/engagement-targeting";
import webSrc from "@/lib/engagementTargeting.ts?raw";
import edgeSrc from "../../supabase/functions/_shared/engagement-targeting.ts?raw";

const norm = (s: string) => s.replace(/\r\n/g, "\n");

describe("engagement-targeting web/edge parity", () => {
  it("the two files are byte-identical (edit one, copy it over the other)", () => {
    expect(norm(webSrc)).toBe(norm(edgeSrc));
  });

  it("same key, same switches, same fail-closed parse", () => {
    expect(web.ENGAGEMENT_TARGETING_KEY).toBe("engagement_targeting");
    expect(edge.ENGAGEMENT_TARGETING_KEY).toBe(web.ENGAGEMENT_TARGETING_KEY);
    expect([...web.TARGETING_SWITCHES]).toEqual(["skip_closed_courses", "trial_to_course_page", "retire_smart_inactive_nudges"]);
    for (const v of [null, {}, { skip_closed_courses: "true" }, { skip_closed_courses: true, retire_smart_inactive_nudges: 1 }]) {
      expect(web.parseEngagementTargeting(v)).toEqual(edge.parseEngagementTargeting(v));
    }
    expect(web.parseEngagementTargeting({ skip_closed_courses: true })).toEqual({
      skip_closed_courses: true, trial_to_course_page: false, retire_smart_inactive_nudges: false,
    });
  });

  it("a flip written by the card is read back by the senders as that switch, other keys untouched", () => {
    const written = web.withTargetingSwitch({ skip_closed_courses: true, note: "x" }, "retire_smart_inactive_nudges", true);
    expect(written).toEqual({ skip_closed_courses: true, note: "x", retire_smart_inactive_nudges: true });
    expect(edge.parseEngagementTargeting(written)).toEqual({
      skip_closed_courses: true, trial_to_course_page: false, retire_smart_inactive_nudges: true,
    });
  });
});
