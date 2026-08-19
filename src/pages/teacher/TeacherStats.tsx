// TeacherStats — `/tg/teacher/stats`, the Statistika screen (Phase 2, Task 3).
//
// Renders INSIDE `TeacherShell` (App.tsx owns the shell + bottom nav + staff guard), so this file is
// page CONTENT only — no shell/nav chrome, no extra `max-w-2xl`/padding. It re-skins the existing
// initData board (`src/pages/TgGroupBoard.tsx`) into the in-session teacher tool: the SAME
// junction-aware RPCs, but called from the AUTHENTICATED Supabase session (no Telegram initData),
// restyled from the board's bespoke `StatChip`/`rounded-2xl` cards to the ui-kit (`StatTile`, `Card`)
// + a Homework-style segmented control for the weekly ↔ all-time toggle.
//
// SHARED GROUP CONTEXT: the active group + switcher come from `useSelectedGroup()` (Task 1). Picking a
// group here calls `setGroupId`, which persists to localStorage — so the choice follows the teacher to
// Groups/Grading and back (each teacher tab remounts under its own route; localStorage is the source of
// truth). If the teacher has a single group there is no switcher.
//
// DATA (all reads, no XP writes — the leaderboard math is the untouched RPC):
//   • staff_group_overview(_group_id) → total_students, active_7d, avg_completion_pct, avg_score_pct
//     (src: supabase/migrations/20260503110451_...sql). It has NO pending column, so "Kutilmoqda" is
//     pulled from the selected group's `pendingHomework` (teacher_groups, already loaded by the hook) —
//     the same source the Groups list shows, so the two screens agree.
//   • group_student_leaderboard(_group_id, 50) → rows for BOTH boards (`board` = 'weekly' | 'alltime'),
//     scored by user_group_rating_xp (matches /leaderboard + profile — the xp-integrity primitive).
//     Columns: board, rank, user_id, first_name, last_initial, xp, level, current_streak.
//
// STATES (all required): loading `Skeleton`; empty `EmptyState` — "Sizda guruh yo'q" (no groups) and
// "Hali ma'lumot yo'q" (a group with no students / no board data); `navigator.onLine`-aware error +
// retry. Names `truncate`/`min-w-0` — no horizontal scroll (the switcher pills wrap).
import { useEffect, useState } from "react";
import { Users, TrendingUp, Star, Clock } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { useSelectedGroup } from "@/hooks/useSelectedGroup";
import { Card, StatTile, EmptyState, Skeleton, Button } from "@/components/ui-kit";

// One row of `group_student_leaderboard(_group_id, _limit)` — both boards returned in one call.
interface BoardRow {
  board: "alltime" | "weekly";
  rank: number;
  user_id: string;
  first_name: string;
  last_initial: string;
  xp: number;
  level: number;
  current_streak: number;
}

// The single row of `staff_group_overview(_group_id)` we consume (more columns exist).
interface Overview {
  total_students: number;
  active_7d: number;
  avg_completion_pct: number;
  avg_score_pct: number;
}

type Board = "weekly" | "alltime";

const offlineNow = () => typeof navigator !== "undefined" && !navigator.onLine;

const medal = (r: number) => (r === 1 ? "🥇" : r === 2 ? "🥈" : r === 3 ? "🥉" : `${r}`);
const fullName = (r: BoardRow) =>
  `${r.first_name}${r.last_initial ? " " + r.last_initial + "." : ""}`;

export default function TeacherStats() {
  const { groups, groupId, setGroupId, loading: groupsLoading, error: groupsError, reload } = useSelectedGroup();

  const [overview, setOverview] = useState<Overview | null>(null);
  const [rows, setRows] = useState<BoardRow[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState(false);
  const [dataReloadKey, setDataReloadKey] = useState(0);
  const [board, setBoard] = useState<Board>("weekly"); // weekly first — the fresh race, like the board.

  const selectedGroup = groups.find((g) => g.id === groupId) ?? null;

  // Load the per-group overview + leaderboard whenever the selected group changes (or a retry fires).
  useEffect(() => {
    if (!groupId) {
      setOverview(null);
      setRows([]);
      return;
    }
    let cancelled = false;
    setDataLoading(true);
    setDataError(false);
    (async () => {
      try {
        // Neither RPC is in the generated Supabase types — cast the names (frontend-typecheck-verify).
        const [ovRes, lbRes] = await Promise.all([
          supabase.rpc("staff_group_overview" as any, { _group_id: groupId }),
          supabase.rpc("group_student_leaderboard" as any, { _group_id: groupId, _limit: 50 }),
        ]);
        if (cancelled) return;
        if (ovRes.error) throw ovRes.error;
        if (lbRes.error) throw lbRes.error;

        const ovRow = (Array.isArray(ovRes.data) ? ovRes.data[0] : ovRes.data) as any;
        setOverview(
          ovRow
            ? {
                total_students: ovRow.total_students ?? 0,
                active_7d: ovRow.active_7d ?? 0,
                avg_completion_pct: ovRow.avg_completion_pct ?? 0,
                avg_score_pct: ovRow.avg_score_pct ?? 0,
              }
            : null,
        );
        setRows((((lbRes.data as any[]) || []) as BoardRow[]));
      } catch (e) {
        if (!cancelled) {
          console.error("[TeacherStats] group stats load failed", e);
          setDataError(true);
        }
      } finally {
        if (!cancelled) setDataLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [groupId, dataReloadKey]);

  const weekly = rows.filter((r) => r.board === "weekly");
  const alltime = rows.filter((r) => r.board === "alltime");
  const activeRows = board === "weekly" ? weekly : alltime;

  // ── Group-level states (the hook owns groups loading/error) ──────────────────────────────────────
  if (groupsLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-9 w-full rounded-full" />
        <div className="grid grid-cols-4 gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[86px] rounded-md" />
          ))}
        </div>
        <Skeleton className="h-10 w-full rounded-2xl" />
        <Skeleton className="h-[280px] w-full rounded-lg" />
      </div>
    );
  }

  if (groupsError) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-extrabold tracking-tight text-foreground">Statistika</h1>
        <EmptyState
          icon={offlineNow() ? "📡" : "⚠️"}
          title={offlineNow() ? "Internet yo'q" : "Xatolik"}
          body={
            offlineNow()
              ? "Ulanishni tekshiring va qayta urinib ko'ring."
              : "Guruhlarni yuklab bo'lmadi. Birozdan so'ng qayta urinib ko'ring."
          }
          cta={
            <Button variant="secondary" size="sm" onClick={reload}>
              Qayta urinish
            </Button>
          }
        />
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-extrabold tracking-tight text-foreground">Statistika</h1>
        <EmptyState
          icon="🏫"
          title="Sizda guruh yo'q"
          body="Sizga hali guruh biriktirilmagan. Guruh biriktirilganda statistikasi shu yerda ko'rinadi."
        />
      </div>
    );
  }

  const hasSwitcher = groups.length > 1;

  return (
    <div className="space-y-4">
      {/* Header + group context. With one group we name it here; with many the switcher shows names. */}
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-extrabold tracking-tight text-foreground">Statistika</h1>
        {!hasSwitcher && selectedGroup && (
          <p className="truncate text-sm font-semibold text-muted-foreground">
            {[selectedGroup.name, selectedGroup.courseName].filter(Boolean).join(" · ")}
          </p>
        )}
      </div>

      {/* Group switcher — wrapping pills (no horizontal scroll). Picking persists via setGroupId. */}
      {hasSwitcher && (
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Guruhni tanlang">
          {groups.map((g) => {
            const on = g.id === groupId;
            return (
              <button
                key={g.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setGroupId(g.id)}
                className={cn(
                  "max-w-full truncate rounded-full border px-3 py-1.5 text-xs font-bold transition-colors",
                  on
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:bg-tint",
                )}
              >
                {g.name}
              </button>
            );
          })}
        </div>
      )}

      {dataLoading ? (
        <>
          <div className="grid grid-cols-4 gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[86px] rounded-md" />
            ))}
          </div>
          <Skeleton className="h-10 w-full rounded-2xl" />
          <Skeleton className="h-[280px] w-full rounded-lg" />
        </>
      ) : dataError ? (
        <EmptyState
          icon={offlineNow() ? "📡" : "⚠️"}
          title={offlineNow() ? "Internet yo'q" : "Xatolik"}
          body={
            offlineNow()
              ? "Ulanishni tekshiring va qayta urinib ko'ring."
              : "Statistikani yuklab bo'lmadi. Birozdan so'ng qayta urinib ko'ring."
          }
          cta={
            <Button variant="secondary" size="sm" onClick={() => setDataReloadKey((k) => k + 1)}>
              Qayta urinish
            </Button>
          }
        />
      ) : !overview || overview.total_students === 0 ? (
        <EmptyState
          icon="📊"
          title="Hali ma'lumot yo'q"
          body="Bu guruhda hali statistika yo'q. O'quvchilar faollashganda shu yerda ko'rinadi."
        />
      ) : (
        <>
          {/* Summary strip — real staff_group_overview columns + pending from teacher_groups. */}
          <div className="grid grid-cols-4 gap-2">
            <StatTile
              icon={<Users />}
              label="Faol"
              value={`${overview.active_7d}/${overview.total_students}`}
            />
            <StatTile icon={<TrendingUp />} label="Tugatildi" value={`${overview.avg_completion_pct}%`} />
            <StatTile icon={<Star />} label="O'rtacha" value={`${overview.avg_score_pct}%`} />
            <StatTile
              icon={<Clock />}
              label="Kutilmoqda"
              value={selectedGroup?.pendingHomework ?? 0}
              highlight={(selectedGroup?.pendingHomework ?? 0) > 0}
            />
          </div>

          {/* Weekly ↔ all-time toggle — Homework-style segmented control. */}
          <div className="flex gap-1 rounded-2xl bg-tint p-1" role="tablist" aria-label="Reyting davri">
            {(["weekly", "alltime"] as Board[]).map((b) => (
              <button
                key={b}
                type="button"
                role="tab"
                aria-selected={board === b}
                onClick={() => setBoard(b)}
                className={cn(
                  "flex-1 rounded-xl px-3 py-2 text-[12.5px] font-bold transition-colors",
                  board === b ? "bg-card text-foreground shadow-soft" : "text-muted-foreground",
                )}
              >
                {b === "weekly" ? "🔥 Shu hafta" : "🏆 Umumiy"}
              </button>
            ))}
          </div>

          {/* Leaderboard — top-50 rows, rank + name + XP (tabular-nums). Names truncate. */}
          <Card className="overflow-hidden p-0">
            {activeRows.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                {board === "weekly"
                  ? "Bu hafta hali XP yig'ilmadi."
                  : "Hali ma'lumot yo'q"}
              </div>
            ) : (
              <ol className="divide-y divide-border/60">
                {activeRows.map((r) => (
                  <li key={`${r.board}-${r.user_id}`} className="flex items-center gap-3 px-4 py-2.5">
                    <span
                      className={cn(
                        "w-7 shrink-0 text-center",
                        r.rank <= 3 ? "text-base" : "text-sm font-semibold text-muted-foreground tabular-nums",
                      )}
                    >
                      {medal(r.rank)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-foreground">
                      {fullName(r)}
                    </span>
                    {r.current_streak > 0 && (
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        🔥{r.current_streak}
                      </span>
                    )}
                    <span className="shrink-0 text-sm font-extrabold tabular-nums text-primary">
                      {r.xp.toLocaleString()}{" "}
                      <span className="text-[10px] font-semibold text-muted-foreground">XP</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
