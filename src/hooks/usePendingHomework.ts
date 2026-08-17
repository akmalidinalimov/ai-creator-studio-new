import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

/**
 * True when the signed-in student has at least one homework submission still
 * awaiting a grade (score IS NULL). Drives the pending dot on the bottom
 * nav's Vazifa tab — a lightweight signal, not a full stats hook (see
 * HomeworkProfileSection for the full effective-grade aggregation).
 */
export function usePendingHomework() {
  const { user } = useAuth();

  const { data } = useQuery({
    queryKey: ["pending-homework-count", user?.id],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("homework_submissions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", user!.id)
        .is("score", null);
      if (error) return 0;
      return count ?? 0;
    },
    enabled: !!user,
    staleTime: 60_000,
  });

  return (data ?? 0) > 0;
}
