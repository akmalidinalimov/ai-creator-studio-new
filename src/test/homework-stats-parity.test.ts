import { describe, it, expect } from "vitest";

// Parity test: the web module (src/lib/homeworkStats.ts) and the bot module
// (supabase/functions/telegram-bot-webhook/homework-stats.ts) duplicate the
// same effective-grade logic and are "kept in sync manually". This test FAILS
// if they ever drift.
//
// Import approach: DIRECT IMPORT. Both files are plain TS with no Deno-only
// APIs, so vitest resolves and imports both without issue.
import * as web from "@/lib/homeworkStats";
import * as bot from "../../supabase/functions/telegram-bot-webhook/homework-stats";

type LeafLite = { id: string; max_score: number };
type SubmissionLite = {
  assignment_id: string;
  score: number | null;
  score_feedback: string | null;
  scored_at: string | null;
  previous_attempts?: any[] | null;
};

type Fixture = {
  name: string;
  leaves: LeafLite[];
  subs: SubmissionLite[];
};

const fixtures: Fixture[] = [
  {
    name: "fully-scored multi-leaf set",
    leaves: [
      { id: "a", max_score: 10 },
      { id: "b", max_score: 5 },
      { id: "c", max_score: 20 },
    ],
    subs: [
      { assignment_id: "a", score: 8, score_feedback: "good", scored_at: "2026-01-01T00:00:00Z", previous_attempts: null },
      { assignment_id: "b", score: 5, score_feedback: "perfect", scored_at: "2026-01-02T00:00:00Z", previous_attempts: null },
      { assignment_id: "c", score: 15, score_feedback: "ok", scored_at: "2026-01-03T00:00:00Z", previous_attempts: null },
    ],
  },
  {
    name: "unscored leaf (submitted but score null, no attempts)",
    leaves: [
      { id: "a", max_score: 10 },
      { id: "b", max_score: 10 },
    ],
    subs: [
      { assignment_id: "a", score: 7, score_feedback: "nice", scored_at: "2026-01-01T00:00:00Z", previous_attempts: null },
      { assignment_id: "b", score: null, score_feedback: null, scored_at: null, previous_attempts: null },
    ],
  },
  {
    name: "effective fallback: current score null but scored entry in previous_attempts",
    leaves: [{ id: "a", max_score: 10 }],
    subs: [
      {
        assignment_id: "a",
        score: null,
        score_feedback: null,
        scored_at: null,
        previous_attempts: [
          { score: 9, score_feedback: "from attempt", scored_at: "2025-12-30T00:00:00Z" },
        ],
      },
    ],
  },
  {
    name: "zero-score leaf",
    leaves: [{ id: "a", max_score: 10 }],
    subs: [
      { assignment_id: "a", score: 0, score_feedback: "missed it", scored_at: "2026-01-01T00:00:00Z", previous_attempts: null },
    ],
  },
  {
    name: "resubmission: multiple previous_attempts, last one scored (current null)",
    leaves: [{ id: "a", max_score: 10 }],
    subs: [
      {
        assignment_id: "a",
        score: null,
        score_feedback: null,
        scored_at: null,
        previous_attempts: [
          { score: 3, score_feedback: "first try", scored_at: "2025-12-28T00:00:00Z" },
          { score: null, score_feedback: null, scored_at: null },
          { score: 8, score_feedback: "much better", scored_at: "2025-12-31T00:00:00Z" },
        ],
      },
    ],
  },
  {
    name: "empty set",
    leaves: [],
    subs: [],
  },
];

describe("homework-stats web/bot parity", () => {
  for (const fx of fixtures) {
    it(`effectiveLeafGrades parity — ${fx.name}`, () => {
      const w = web.effectiveLeafGrades(fx.leaves, fx.subs);
      const b = bot.effectiveLeafGrades(fx.leaves, fx.subs);
      expect(b).toEqual(w);
    });

    it(`summarizeHomework parity — ${fx.name}`, () => {
      const w = web.summarizeHomework(web.effectiveLeafGrades(fx.leaves, fx.subs));
      const b = bot.summarizeHomework(bot.effectiveLeafGrades(fx.leaves, fx.subs));
      expect(b).toEqual(w);
    });
  }

  it("leavesFromAssignments parity", () => {
    const assignments = [
      { id: "root1", parent_id: null, is_active: true },
      { id: "child1", parent_id: "root1", is_active: true },
      { id: "child2", parent_id: "root1", is_active: true },
      { id: "standalone", parent_id: null, is_active: true },
      { id: "inactive", parent_id: null, is_active: false },
      { id: "root2", parent_id: null }, // is_active omitted -> treated active
      { id: "child3", parent_id: "root2", is_active: true },
    ];
    const w = web.leavesFromAssignments(assignments);
    const b = bot.leavesFromAssignments(assignments);
    expect(b).toEqual(w);
  });
});
