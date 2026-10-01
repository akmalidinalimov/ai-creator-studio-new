// GradeFilterBar — the Baholash queue's course + group filter (teacher audit PR-4, TUI-1). Pure presentation:
// the model (which chips, their counts, what is visible) is src/lib/gradeFilter.ts. Two wrapping chip rows, no
// horizontal scroll: "Hammasi · N" + one chip per course in its colour, then one chip per group. Selection chips,
// never coral (the screen's one coral primary is "Baholash → keyingi").
import { cn } from "@/lib/utils";
import { courseTone } from "@/lib/courseTone";
import { NO_FILTER, type GradeFilter, type GradeFilterModel, type GradeFilterRow } from "@/lib/gradeFilter";

interface ChipProps {
  active: boolean;
  activeClass: string;
  dotClass?: string;
  label: string;
  count: number;
  disabled?: boolean;
  onClick: () => void;
}

function FilterChip({ active, activeClass, dotClass, label, count, disabled, onClick }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={`${label} (${count})`}
      className={cn(
        "inline-flex min-h-[40px] max-w-full items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-bold transition-colors disabled:opacity-50",
        active ? activeClass : "border-border bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {dotClass && <span className={cn("size-2 shrink-0 rounded-full", dotClass)} aria-hidden />}
      <span className="min-w-0 truncate">{label}</span>
      <span
        className={cn(
          "shrink-0 rounded-full px-1.5 text-[11px] font-extrabold tabular-nums",
          count > 0 ? "bg-foreground/10 text-foreground" : "text-muted-foreground",
        )}
      >
        {count}
      </span>
    </button>
  );
}

export interface GradeFilterBarProps {
  model: GradeFilterModel<GradeFilterRow>;
  onChange: (f: GradeFilter) => void;
  /** true while a grade / return is being written: the card under the teacher's finger must not change. */
  disabled?: boolean;
}

export function GradeFilterBar({ model, onChange, disabled }: GradeFilterBarProps) {
  const { filter, total, courses, groups, showCourses, showGroups } = model;
  if (!showCourses && !showGroups) return null;
  const neutral = "border-foreground/40 bg-tint text-foreground";
  return (
    <div className="space-y-2" role="group" aria-label="Kurs va guruh bo'yicha">
      <div className="flex flex-wrap gap-1.5">
        <FilterChip
          active={!filter.courseId && !filter.groupId}
          activeClass={neutral}
          label="Hammasi"
          count={total}
          disabled={disabled}
          onClick={() => onChange(NO_FILTER)}
        />
        {showCourses &&
          courses.map((c) => {
            const tone = courseTone(c.title);
            return (
              <FilterChip
                key={c.id}
                active={filter.courseId === c.id}
                activeClass={tone.active}
                dotClass={tone.dot}
                label={c.short}
                count={c.count}
                disabled={disabled}
                onClick={() => onChange({ courseId: c.id, groupId: null })}
              />
            );
          })}
      </div>
      {showGroups && (
        <div className="flex flex-wrap gap-1.5">
          {groups.map((g) => {
            const tone = courseTone(g.courseTitle);
            const active = filter.groupId === g.id;
            return (
              <FilterChip
                key={g.id}
                active={active}
                activeClass={tone.active}
                dotClass={tone.dot}
                label={g.label}
                count={g.count}
                disabled={disabled}
                // A second tap on the chosen group widens back to its course (or to everything).
                onClick={() => onChange({ courseId: filter.courseId, groupId: active ? null : g.id })}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
