import { describe, it, expect } from "vitest";

// Parity test: src/lib/hwLabel.ts (web / Mini App) and supabase/functions/_shared/hw-label.ts (edge functions +
// the bot) are ONE source kept as two byte-identical copies (the web bundle cannot import from
// supabase/functions). This fails if they drift, both on the file text and on behaviour over the live
// course / group names.
import * as web from "@/lib/hwLabel";
import * as edge from "../../supabase/functions/_shared/hw-label";
import webSrc from "@/lib/hwLabel.ts?raw";
import edgeSrc from "../../supabase/functions/_shared/hw-label.ts?raw";

const norm = (s: string) => s.replace(/\r\n/g, "\n");

const COURSES = ["AI CREATORS 5.0", "AI CREATORS CHALLENGE 6.0", "AI CREATORS 4.0", "Midjourney masterclass pro", "", null];
const GROUPS = [
  "1-GURUH PRE 5.0", "1-GURUH VIP 5.0", "2-GURUH VIP 5.0",
  "AC CHALLENGE | 1-GURUH", "AC CHALLENGE | 3-GURUH", "AC CHALLENGE | 6-GURUH",
  "5.0", "GURUH 5", "", null,
];
const TASKS: Array<[number | null, number | null, string | null]> = [
  [1, 1, "1- MODUL: PROMPT ENGINEERING"],
  [2, 1, "2-MODUL ERKAKLAR KO'Z OYNAGI"],
  [3, 2, "3-MODUL (taxminiy)"],
  [null, null, "Task"],
  [4, null, null],
];

describe("hw-label web/edge parity", () => {
  it("the two files are byte-identical (edit one, copy it over the other)", () => {
    expect(norm(webSrc)).toBe(norm(edgeSrc));
  });

  it("courseShort / groupShort / scopeTag agree on every live name", () => {
    for (const c of COURSES) {
      expect(web.courseShort(c)).toBe(edge.courseShort(c));
      for (const g of GROUPS) {
        expect(web.groupShort(g, c)).toBe(edge.groupShort(g, c));
        expect(web.scopeTag(c, g)).toBe(edge.scopeTag(c, g));
      }
    }
  });

  it("hwLabel agrees on every combination", () => {
    for (const c of COURSES) for (const g of GROUPS) for (const [m, s, t] of TASKS) {
      const p = { courseTitle: c, groupName: g, moduleNumber: m, step: s, title: t };
      expect(web.hwLabel(p)).toBe(edge.hwLabel(p));
    }
  });

  it("the web copy renders the cloned task differently per course (same result the edge tests pin)", () => {
    const base = { moduleNumber: 1, step: 1, title: "1- MODUL: PROMPT ENGINEERING" };
    expect(web.hwLabel({ ...base, courseTitle: "AI CREATORS 5.0", groupName: "1-GURUH VIP 5.0" }))
      .toBe("5.0 · 1-GURUH VIP · M1 V1 — 1- MODUL: PROMPT ENGINEERING");
    expect(web.hwLabel({ ...base, courseTitle: "AI CREATORS CHALLENGE 6.0", groupName: "AC CHALLENGE | 1-GURUH" }))
      .toBe("CH6 · 1-GURUH · M1 V1 — 1- MODUL: PROMPT ENGINEERING");
    expect(web.scopeTag("AI CREATORS 5.0", "AC CHALLENGE | 3-GURUH")).toBe("5.0 · AC CHALLENGE | 3-GURUH");
  });
});
