// TeacherGroups — `/tg/teacher/groups`, the Guruhlar screen (Phase 2, Task 1).
//
// Renders INSIDE `TeacherShell` (App.tsx owns the shell + bottom nav + staff guard), so this file is
// page CONTENT only. Two inline views behind a local `openGroupId`:
//   • LIST  — the teacher's groups (junction-aware, from `useSelectedGroup`'s `teacher_groups` load):
//             name + course, student count, completion %, pending count. One round trip, no N+1.
//   • ROSTER — a group's students from `staff_group_members(_group_id)` (gated by junction-aware
//             `can_see_group`, so co-teachers pass). Each row → the Task-2 student-detail route.
// Opening a group ALSO sets the shared `groupId` (via setGroupId), so the pick follows the teacher to
// Stats/Grading. A pure list/roster screen carries NO coral primary (allowed by the coral rule).
//
// STATES (all required): loading `Skeleton`; empty `EmptyState` — "Sizda guruh yo'q" (no groups) and a
// DISTINCT "Bu guruhda o'quvchi yo'q" (a group with no students); `navigator.onLine`-aware error +
// retry (mirrors TeacherHome/TeacherGrade). Names `truncate`/`min-w-0` — no horizontal scroll.
//
// staff_group_members columns (src: supabase/migrations/20260502225517_...sql:163):
//   id, name, last_name, email, telegram_username, telegram_id, last_sign_in_at,
//   last_activity_at, completed_lessons, avg_score. There is NO per-student XP or pending column
//   here, so the roster row shows what the RPC actually returns: name, completed lessons, last
//   active, and the quiz avg — not invented fields (see the task-1 report for this deviation).
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useSelectedGroup } from "@/hooks/useSelectedGroup";
import { Card, SectionHeader, StatusChip, Button, EmptyState, Skeleton } from "@/components/ui-kit";

// A student row as returned by `staff_group_members(_group_id)` (columns cited in the file header).
interface RosterMember {
  id: string;
  name: string | null;
  last_name: string | null;
  email: string | null;
  telegram_username: string | null;
  telegram_id: number | null;
  last_sign_in_at: string | null;
  last_activity_at: string | null;
  completed_lessons: number;
  avg_score: number;
}

const offlineNow = () => typeof navigator !== "undefined" && !navigator.onLine;

const fullName = (m: RosterMember) =>
  [m.name, m.last_name].map((s) => (s || "").trim()).filter(Boolean).join(" ") || "O'quvchi";

// Relative "last active" in Uzbek; null/blank → "—". Same shape as TeacherGrade's agoUz.
function agoUz(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "hozirgina";
  if (m < 60) return `${m} daqiqa oldin`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} soat oldin`;
  const d = Math.floor(h / 24);
  return `${d} kun oldin`;
}

export default function TeacherGroups() {
  const navigate = useNavigate();
  const { groups, groupId, setGroupId, loading, error, reload } = useSelectedGroup();

  // Local drill-down: null = groups list; a group id = that group's roster.
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);

  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [rosterError, setRosterError] = useState(false);
  const [rosterReloadKey, setRosterReloadKey] = useState(0);

  const openGroup = groups.find((g) => g.id === openGroupId) ?? null;

  const handleOpenGroup = (id: string) => {
    setOpenGroupId(id);
    setGroupId(id); // the pick follows the teacher to Stats/Grading (shared selection).
    setRoster([]);
  };

  // Load a group's roster whenever one is opened (or a retry is requested).
  useEffect(() => {
    if (!openGroupId) return;
    let cancelled = false;
    setRosterLoading(true);
    setRosterError(false);
    (async () => {
      try {
        // Not in the generated types — cast the RPC name (frontend-typecheck-verify convention).
        const { data, error: rpcErr } = await supabase.rpc("staff_group_members" as any, {
          _group_id: openGroupId,
        });
        if (cancelled) return;
        if (rpcErr) throw rpcErr;
        setRoster((((data as any[]) || []) as RosterMember[]));
      } catch (e) {
        if (!cancelled) {
          console.error("[TeacherGroups] staff_group_members failed", e);
          setRosterError(true);
        }
      } finally {
        if (!cancelled) setRosterLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openGroupId, rosterReloadKey]);

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // ROSTER VIEW
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  if (openGroupId) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setOpenGroupId(null)} aria-label="Orqaga">
            <ChevronLeft className="size-4" />
            Guruhlar
          </Button>
        </div>

        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-2xl font-extrabold tracking-tight text-foreground">
            {openGroup?.name ?? "Guruh"}
          </h1>
          {openGroup && (
            <p className="truncate text-sm font-semibold text-muted-foreground">
              {[openGroup.courseName, `${openGroup.totalStudents} o'quvchi`].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>

        {rosterLoading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-[68px] w-full rounded-lg" />
            ))}
          </div>
        ) : rosterError ? (
          <EmptyState
            icon={offlineNow() ? "📡" : "⚠️"}
            title={offlineNow() ? "Internet yo'q" : "Xatolik"}
            body={
              offlineNow()
                ? "Ulanishni tekshiring va qayta urinib ko'ring."
                : "O'quvchilar ro'yxatini yuklab bo'lmadi. Birozdan so'ng qayta urinib ko'ring."
            }
            cta={
              <Button variant="secondary" size="sm" onClick={() => setRosterReloadKey((k) => k + 1)}>
                Qayta urinish
              </Button>
            }
          />
        ) : roster.length === 0 ? (
          <EmptyState
            icon="👥"
            title="O'quvchi yo'q"
            body="Bu guruhda hali faol o'quvchi yo'q. O'quvchilar qo'shilganda shu yerda ko'rinadi."
          />
        ) : (
          <div className="space-y-2">
            <SectionHeader title={`O'quvchilar (${roster.length})`} />
            {roster.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => navigate(`/tg/teacher/groups/student/${m.id}`)}
                className="block w-full text-left transition-transform active:scale-[0.99]"
              >
                <Card className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-extrabold tracking-tight text-foreground">
                      {fullName(m)}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] font-semibold text-muted-foreground">
                      <span className="tabular-nums">{m.completed_lessons} dars</span>
                      <span className="truncate">Faol: {agoUz(m.last_activity_at)}</span>
                    </div>
                  </div>
                  {m.avg_score > 0 && (
                    <StatusChip kind="ok" label={`${m.avg_score}%`} />
                  )}
                  <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                </Card>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // GROUPS LIST VIEW
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-extrabold tracking-tight text-foreground">Guruhlar</h1>
        {!loading && !error && groups.length > 0 && (
          <p className="truncate text-sm font-semibold text-muted-foreground">
            {groups.length} ta guruh
          </p>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[84px] w-full rounded-lg" />
          ))}
        </div>
      ) : error ? (
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
      ) : groups.length === 0 ? (
        <EmptyState
          icon="🏫"
          title="Sizda guruh yo'q"
          body="Sizga hali guruh biriktirilmagan. Guruh biriktirilganda shu yerda ko'rinadi."
        />
      ) : (
        <div className="space-y-2">
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => handleOpenGroup(g.id)}
              aria-current={g.id === groupId ? "true" : undefined}
              className="block w-full text-left transition-transform active:scale-[0.99]"
            >
              <Card className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-extrabold tracking-tight text-foreground">
                    {g.name}
                  </div>
                  {g.courseName && (
                    <div className="truncate text-xs font-semibold text-muted-foreground">{g.courseName}</div>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] font-semibold text-muted-foreground">
                    <span className="tabular-nums">{g.totalStudents} o'quvchi</span>
                    <span className="tabular-nums">{g.avgCompletionPct}% tugatildi</span>
                    {g.pendingHomework > 0 && (
                      <span className="tabular-nums font-extrabold text-cta">
                        {g.pendingHomework} kutilmoqda
                      </span>
                    )}
                  </div>
                </div>
                <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
              </Card>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
