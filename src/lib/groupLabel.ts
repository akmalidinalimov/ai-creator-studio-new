// groupLabel — how a teacher-facing PICKER or CONFIRMATION names a group: "<group name> · <course title>".
//
//   groupWithCourse("AC CHALLENGE | 2-GURUH", "AI CREATORS CHALLENGE 6.0") → "AC CHALLENGE | 2-GURUH · AI CREATORS CHALLENGE 6.0"
//   groupWithCourse("1-GURUH PRE 5.0", "AI CREATORS 5.0")                  → "1-GURUH PRE 5.0 · AI CREATORS 5.0"
//   groupWithCourse("1-GURUH PRE 5.0", null)                               → "1-GURUH PRE 5.0"
//
// WHY (teacher audit 2026-09-30, TUI-3 / TUI-4 / TUI-8): a teacher can teach a 5.0 group and a Challenge 6.0 group at
// the same time, and until now every group select showed the group NAME only — the course was visible only when the
// admin happened to put it in the name. A picker is where she must recognise her group, so the group name stays whole
// (never shortened), and the course is stated from the course record rather than trusted to the name.
//
// Compact places (a card chip, a queue row) use src/lib/hwLabel.ts scopeTag()/courseShort() instead ("CH6 · 2-GURUH").

function clean(s: unknown): string {
  return s == null ? "" : String(s).replace(/\s+/g, " ").trim();
}

/** "<group name> · <course title>"; the course part is left out when unknown. Never "" for a non-empty name. */
export function groupWithCourse(groupName: string | null | undefined, courseTitle: string | null | undefined): string {
  const g = clean(groupName);
  const c = clean(courseTitle);
  if (!g) return c;
  return c ? `${g} · ${c}` : g;
}
