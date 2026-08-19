// useSelectedGroup — the teacher Mini App's shared "active group" (Phase 2, Task 1).
//
// Loads the caller's groups from the JUNCTION-AWARE `teacher_groups(uid)` RPC (primary ∪
// co-teacher — src: supabase/migrations/20260818190000_group_teachers_multi.sql:219), and holds a
// single selected `groupId` persisted in localStorage keyed by user id. Because each teacher screen
// (Groups / Stats / — later — Grading's filter) mounts fresh under its own `TeacherShell` route,
// the in-memory selection would not survive navigation on its own; localStorage IS the cross-tab
// source of truth, so picking group B on Stats shows B on Groups and vice-versa.
//
// Contract consumed by Task 3 (Stats): `{ groupId, setGroupId, groups }` — `groups` is `{id,name,…}[]`.
// The RPC's raw `group_id`/`group_name` columns are mapped to stable `id`/`name` so consumers never
// depend on the RPC's field names. Additive `loading`/`error`/`reload` help screens render states.
//
// NEVER THROWS: no auth, an RPC error, or an empty result all resolve to `groups: []`, `groupId: null`
// (not-loading, `error` flagged only for the RPC-failure case so a screen can offer a retry).
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";

/**
 * A teacher's group, mapped from a `teacher_groups(uid)` row. The RPC returns
 * `(group_id, group_name, course_name, total_students, active_7d, avg_completion_pct, pending_homework)`
 * — everything the Groups list needs in one round trip (no per-group N+1 to `staff_group_overview`).
 */
export interface TeacherGroup {
  id: string;
  name: string;
  courseName: string | null;
  totalStudents: number;
  active7d: number;
  avgCompletionPct: number;
  pendingHomework: number;
}

export interface UseSelectedGroup {
  groupId: string | null;
  setGroupId: (id: string) => void;
  groups: TeacherGroup[];
  loading: boolean;
  error: boolean;
  reload: () => void;
}

const storageKey = (uid: string) => `teacher.selectedGroup.${uid}`;

export function useSelectedGroup(): UseSelectedGroup {
  const { user } = useAuth();
  const [groups, setGroups] = useState<TeacherGroup[]>([]);
  const [groupId, setGroupIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  // Persist the pick so it survives the remount between teacher tabs. Storage failures
  // (private mode / quota) are swallowed — the selection just won't persist, never a crash.
  const setGroupId = useCallback(
    (id: string) => {
      setGroupIdState(id);
      if (user) {
        try {
          localStorage.setItem(storageKey(user.id), id);
        } catch {
          /* non-fatal */
        }
      }
    },
    [user],
  );

  useEffect(() => {
    if (!user) {
      // No session yet: a calm, non-loading empty — never a throw or a spinner that never ends.
      setGroups([]);
      setGroupIdState(null);
      setError(false);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        // `teacher_groups` isn't in the generated Supabase types — cast the name (frontend-typecheck-verify).
        const { data, error: rpcErr } = await supabase.rpc("teacher_groups" as any, { uid: user.id });
        if (cancelled) return;
        if (rpcErr) throw rpcErr;

        const rows = (((data as any[]) || []) as any[]).map(
          (r): TeacherGroup => ({
            id: r.group_id,
            name: r.group_name,
            courseName: r.course_name ?? null,
            totalStudents: r.total_students ?? 0,
            active7d: r.active_7d ?? 0,
            avgCompletionPct: r.avg_completion_pct ?? 0,
            pendingHomework: r.pending_homework ?? 0,
          }),
        );
        setGroups(rows);

        // Resolve the active group: a persisted id still present in the list wins, else the first
        // group. Never leave a dangling id pointing at a group the teacher no longer teaches.
        let persisted: string | null = null;
        try {
          persisted = localStorage.getItem(storageKey(user.id));
        } catch {
          persisted = null;
        }
        const resolved = persisted && rows.some((g) => g.id === persisted) ? persisted : rows[0]?.id ?? null;
        setGroupIdState(resolved);
      } catch (e) {
        if (!cancelled) {
          console.error("[useSelectedGroup] teacher_groups failed", e);
          setGroups([]);
          setGroupIdState(null);
          setError(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, reloadKey]);

  return { groupId, setGroupId, groups, loading, error, reload };
}
