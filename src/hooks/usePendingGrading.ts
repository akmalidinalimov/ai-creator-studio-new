import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";
import { fetchPendingQueue } from "@/lib/teacherApi";
import { countByCourse, type CourseOption } from "@/lib/gradeFilter";

/**
 * usePendingGrading — how many homework submissions in the signed-in teacher's
 * (junction-scoped) groups still await a grade, in total and per course. The total drives the
 * coral count badge on the teacher bottom nav's Baholash tab (mirrors `usePendingHomework` for the
 * student side); `byCourse` drives TeacherHome's per-course counts (teacher audit PR-4), each of
 * which opens the grading queue filtered to that course.
 *
 * Reads the grading queue itself (fetchPendingQueue → `teacher_pending_submissions()`, SECURITY
 * DEFINER, scoped to `teacher_group_ids(auth.uid())`, `score is null OR stale` rows) — so every number
 * here is exactly what the Baholash screen will show; there is no lighter count-only RPC. A row's
 * course is its TASK's course; rows with no known course count in the total only. Errors never throw
 * — they resolve to 0 / [] (a missing badge beats a crash, per the member-forgiveness / fail-quiet
 * convention).
 */
export function usePendingGrading(): { count: number; byCourse: CourseOption[]; loading: boolean } {
  const { user } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ["teacher-pending-grading-count", user?.id],
    queryFn: async () => {
      try {
        const rows = await fetchPendingQueue();
        return { count: rows.length, byCourse: countByCourse(rows) };
      } catch {
        return { count: 0, byCourse: [] as CourseOption[] };
      }
    },
    enabled: !!user,
    staleTime: 60_000,
  });

  return { count: data?.count ?? 0, byCourse: data?.byCourse ?? [], loading: isLoading };
}
