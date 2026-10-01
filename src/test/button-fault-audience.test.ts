import { describe, it, expect } from "vitest";

// ONE place decides whose fault a Mini App button fault is. The LIVE watch_button_health() sums every admin_actions
// 'miniapp_button_fallback' / 'miniapp_button_rejected' row, from ANY sender and any fn, into the STUDENT
// watch-button alarm, and that alarm's advice is the STUDENT kill-switch. A fault in a TEACHER Mini App button
// (/tg/teacher…) is therefore written as 'teacher_miniapp_button_*' instead, by
// supabase/functions/_shared/miniapp-button.ts BUTTON_FAULT_ACTIONS[audience], with the audience taken from the
// button's own url (webAppAudience / isTeacherAppPath).
//
// This test fails when edge-function CODE names a student fault action as a string literal anywhere except the
// allow-list below. A hand-written writer is how a teacher fault reaches the student alarm: the ☰ menu sync
// (telegram-bot-webhook/menu-button.ts, #237) logs every refused web_app menu as 'miniapp_button_rejected',
// including the staff 📝 Ustoz one (/tg/teacher). Merging that with this branch is not a textual conflict, so
// without this test nothing would notice the audience routing (menuButtonAudience) missing from the merged tree.
// Comment lines are skipped. A literal on a code line is flagged even when a trailing comment follows it, so a
// wrong guess here fails loudly and is never silent.
const SOURCES = import.meta.glob(
  [
    "../../supabase/functions/**/*.ts",
    "!../../supabase/functions/**/*.test.ts",
    "!../../supabase/functions/**/testing/**",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const PREFIX = "../../supabase/functions/";

/** Files that may name a student fault action, each with the reason it can only ever be a student button. */
const ALLOWED: Record<string, string> = {
  "_shared/miniapp-button.ts": "BUTTON_FAULT_ACTIONS itself, the one place the action names live",
  "telegram-bot-webhook/miniapp-buttons.ts": "studentWatchButton's not_private fallback: a student watch button by construction",
};

const STUDENT_FAULT_LITERAL = /["'`]miniapp_button_(?:fallback|rejected)["'`]/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/** "<file>:<line>" for every code line of `src` that names a student fault action as a literal. */
function literalWriters(file: string, src: string): string[] {
  const hits: string[] = [];
  src.replace(/\r\n/g, "\n").split("\n").forEach((line, i) => {
    if (!COMMENT_LINE.test(line) && STUDENT_FAULT_LITERAL.test(line)) hits.push(`${file}:${i + 1}`);
  });
  return hits;
}

describe("Mini App button faults: the audience comes from BUTTON_FAULT_ACTIONS, never a literal", () => {
  it("the scan sees the edge functions (an empty glob must not pass)", () => {
    const files = Object.keys(SOURCES);
    expect(files.length).toBeGreaterThan(50);
    expect(SOURCES[`${PREFIX}_shared/miniapp-button.ts`]).toContain("BUTTON_FAULT_ACTIONS");
    for (const f of Object.keys(ALLOWED)) expect(files).toContain(`${PREFIX}${f}`);
  });

  it("the detector flags a hand-written student fault writer and ignores comments", () => {
    const sample = [
      "// a refused web_app menu → 'miniapp_button_rejected' (comment: ignored)",
      " * 'miniapp_button_fallback' in a doc comment (ignored)",
      '    await logHealthOnce(admin, "miniapp_button_rejected", `rejected:menu_button_${w}:${m}`, details, {',
      "    const action = BUTTON_FAULT_ACTIONS[audience].rejected;",
      "    await logHealthOnce(admin, 'teacher_miniapp_button_rejected', key, details);",
    ].join("\n");
    expect(literalWriters("sample.ts", sample)).toEqual(["sample.ts:3"]);
  });

  it("no edge function names 'miniapp_button_fallback' / 'miniapp_button_rejected' outside the allow-list", () => {
    const offenders = Object.entries(SOURCES)
      .map(([path, src]) => [path.slice(PREFIX.length), src] as const)
      .filter(([file]) => !(file in ALLOWED))
      .flatMap(([file, src]) => literalWriters(file, src));
    // Fix: take the action from BUTTON_FAULT_ACTIONS[audience] (_shared/miniapp-button.ts), with the audience
    // derived from the button's url (a web_app url under /tg/teacher is 'teacher', anything else 'student').
    expect(offenders).toEqual([]);
  });
});
