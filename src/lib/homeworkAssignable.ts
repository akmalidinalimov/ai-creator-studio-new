import type { TFunction } from "i18next";
import type { StatusChipKind } from "@/components/ui-kit";
import { formatXp } from "@/lib/xp";

// Shared shape for student_assignable_homework() RPC rows — supabase/migrations/
// 20260818160000_student_assignable_homework.sql. `state` is the RPC's own unification of both
// resubmission mechanisms (bot capture path's previous_score/null-score reset vs.
// start_homework_resubmission()'s score_is_stale flag) — callers never need to know which one
// produced it. Kept in one place (moved out of Homework.tsx, item 5 / module-end homework) so
// Homework.tsx's picker, Lessons.tsx's module-end row, and ModuleHomework.tsx's detail screen
// all read the exact same row shape and state semantics.
export type AssignableState = "none" | "pending" | "graded" | "needs_redo";

export interface AssignableItem {
  assignment_id: string;
  module_id: string;
  module_number: number;
  module_title: string;
  is_sap: boolean;
  step_number: number;
  title: string;
  max_score: number;
  state: AssignableState;
  score: number | null;
  attempt_number: number | null;
  submission_id: string | null;
}

// Single source of truth for turning an AssignableState into a StatusChip — was
// Homework.tsx's local renderPickerStateChip (item 4); centralized so the module-end row
// (Lessons.tsx) and the module homework screen (ModuleHomework.tsx) render the IDENTICAL
// "topshirilmagan / kutilmoqda / baholandi N/max / qayta yuboring" chip the picker already
// established, off the same homework.* i18n keys — no new copy needed for chip states.
export function getHomeworkStateChip(
  state: AssignableState,
  score: number | null,
  maxScore: number,
  t: TFunction,
  locale: string,
): { kind: StatusChipKind; label: string } {
  switch (state) {
    case "graded":
      return {
        kind: "ok",
        label: t("homework.picker.stateGraded", {
          score: formatXp(score ?? 0, locale),
          max: formatXp(maxScore, locale),
        }),
      };
    case "needs_redo":
      return { kind: "redo", label: t("homework.statusRedo") };
    case "pending":
      return { kind: "wait", label: t("homework.statusWaiting") };
    default:
      return { kind: "none", label: t("homework.picker.stateNone") };
  }
}

// Rolls up every leaf homework item in a module into a single worst-case state for the
// module-end summary row (Lessons.tsx) — priority order needs_redo > none > pending > graded,
// i.e. whatever needs the student's attention most wins the chip. When everything is graded,
// score/max are summed across the module's leaves so the chip can show a combined "N/max".
export function aggregateHomeworkState(items: AssignableItem[]): {
  state: AssignableState;
  score: number;
  max: number;
} {
  const priority: AssignableState[] = ["needs_redo", "none", "pending", "graded"];
  let state: AssignableState = "graded";
  for (const s of priority) {
    if (items.some((i) => i.state === s)) {
      state = s;
      break;
    }
  }
  const score = items.reduce((sum, i) => sum + (i.score ?? 0), 0);
  const max = items.reduce((sum, i) => sum + (i.max_score ?? 0), 0);
  return { state, score, max };
}
