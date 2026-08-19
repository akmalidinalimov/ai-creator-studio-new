import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

/**
 * usePendingGrading — how many homework submissions in the signed-in teacher's
 * (junction-scoped) groups still await a grade. Drives the coral count badge on
 * the teacher bottom nav's Baholash tab (mirrors `usePendingHomework` for the
 * student side).
 *
 * Phase 1 reuses the grading-queue RPC's row count — there's no lighter count-only
 * RPC yet. `teacher_pending_submissions()` (Task 1 migration) is SECURITY DEFINER,
 * scoped to `teacher_group_ids(auth.uid())` and returns `score is null OR stale`
 * rows, so `.length` is already the caller's own pending total. Errors never throw
 * — they resolve to 0 (a missing badge beats a crash, per the member-forgiveness /
 * fail-quiet convention).
 */
export function usePendingGrading(): { count: number; loading: boolean } {
  const { user } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ["teacher-pending-grading-count", user?.id],
    queryFn: async () => {
      // `teacher_pending_submissions` ships in a Task 1 migration that may not be in
      // the generated Supabase types yet — cast the name per the frontend-typecheck-verify
      // convention so tsc passes before the types are regenerated.
      const { data, error } = await supabase.rpc("teacher_pending_submissions" as any);
      if (error) return 0;
      return Array.isArray(data) ? data.length : 0;
    },
    enabled: !!user,
    staleTime: 60_000,
  });

  return { count: data ?? 0, loading: isLoading };
}
