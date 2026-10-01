// courseTone — one colour per course on the teacher's grading surfaces (the card's course chip, the Baholash
// filter, the Home per-course counts), so a teacher of both courses tells a 5.0 card from its Challenge 6.0 copy
// at a glance (teacher audit TUI-1). The two families match TeacherProfile's group-chip dots: the platform
// primary for a course, violet for a Challenge. Keyed on the course TITLE (courses.title), so the same course has
// the same colour on every screen. Tailwind classes are literal strings so the JIT keeps them.

export type CourseToneKey = "course" | "challenge" | "unknown";

export interface CourseTone {
  key: CourseToneKey;
  /** a small round dot */
  dot: string;
  /** a passive chip (the card's "5.0 · 1-GURUH VIP") */
  chip: string;
  /** a selected filter chip's border + fill */
  active: string;
}

const TONES: Record<CourseToneKey, CourseTone> = {
  course: {
    key: "course",
    dot: "bg-primary",
    chip: "bg-primary/10 text-primary",
    active: "border-primary bg-primary/10 text-foreground",
  },
  challenge: {
    key: "challenge",
    dot: "bg-violet-500",
    chip: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
    active: "border-violet-500 bg-violet-500/15 text-foreground",
  },
  unknown: {
    key: "unknown",
    dot: "bg-muted-foreground/40",
    chip: "bg-tint text-foreground",
    active: "border-foreground/40 bg-tint text-foreground",
  },
};

// The same word rule as the shared label's courseShort ("challenge" as a whole word, any case).
const CHALLENGE_RE = /\bchallenge\b/i;

export function courseTone(courseTitle: string | null | undefined): CourseTone {
  const t = (courseTitle ?? "").trim();
  if (!t) return TONES.unknown;
  return CHALLENGE_RE.test(t) ? TONES.challenge : TONES.course;
}
