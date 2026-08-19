// TeacherNudges — `/tg/teacher/nudges`, the Nudge screen (Phase 3, Task 3).
//
// Renders INSIDE `TeacherShell` (App.tsx owns the shell + bottom nav + staff guard), so this file is
// page CONTENT only — no `max-w-2xl`/extra px (the shell already applies those). A teacher/co-teacher
// picks one of their groups (`useSelectedGroup`, Phase 2, junction-aware `teacher_groups(uid)`), sees
// the group's students who've "gone quiet", and one-tap sends each a warm "we miss you" Telegram DM
// via the `teacher-nudge-student` edge fn (already shipped — reused verbatim from
// `src/components/profile/TeacherProfile.tsx:199-242`, the working reference for this exact invoke +
// error-body pattern).
//
// INACTIVITY THRESHOLD: `last_activity_at` older than 7 days OR null ("hech qachon"). Source: grepped
// both cron candidates named in the task brief.
//   • `supabase/functions/detect-and-nudge/index.ts` already runs an "inactive_7d" pattern via the
//     `nudge_candidates_inactive(_days: 7)` RPC (supabase/migrations/20260502234117_...sql:2), which
//     computes inactivity from `MAX(lesson_progress.updated_at)` — the SAME source column that feeds
//     `staff_group_members.last_activity_at`. 7 days is therefore already the platform's "gone quiet"
//     window for students, not just this task's default — no divergence to match.
//   • `supabase/functions/cron-teacher-engagement-nudge/index.ts` nudges TEACHERS (not students) off
//     unrelated signals (unanswered-question hours, teacher-offline hours) — not a "days inactive"
//     window at all, so it doesn't apply here.
//
// ERROR CONTRACT: on success the fn returns HTTP 200 with `{ok:true}`. On a business/error state it
// returns a NON-2xx status, so supabase-js puts the response body in `error.context` (a Response), NOT
// `data` — read the JSON body off `error.context.json()` to get the `error` code. Same pattern as
// src/components/homework/HomeworkSubmit.tsx:207-215 and TeacherBroadcast.tsx (Task 2).
//
// PER-ROW STATE MACHINE (one-tap only, never double-send — disable IMMEDIATELY on click):
//   telegram_id == null  → pre-empted: a disabled "Telegram ulanmagan" chip, no button, no invoke.
//   idle/error            → live "Eslatma" button.
//   sending                → button disabled + spinner (blocks a second tap while in flight).
//   ok (200)                → terminal "✅ Yuborildi" chip (disabled).
//   already_nudged_today (429) → terminal "Bugun yuborilgan" chip (disabled).
//   no_telegram (400, race — roster went stale between load and click) → same terminal chip as the
//     pre-empted case.
//   forbidden (403) / other (401/402/5xx/unknown) → NOT terminal: button re-enables (the copy itself
//     says "qayta urining" = try again) + a small inline red line under the row.
//
// STATES (all required, mirrors TeacherGroups/TeacherBroadcast): loading `Skeleton`; `navigator.onLine`
// -aware error + retry; no-groups `EmptyState` ("Sizda guruh yo'q"); no-inactive `EmptyState`
// ("Hamma faol — hech kim uxlab qolmagan"). No bulk/"nudge all" button — out of scope per the brief
// (respects the fn's 1/day/student rate limit + anti-spam intent).
import { useEffect, useMemo, useState } from "react";
import { BellRing, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useSelectedGroup } from "@/hooks/useSelectedGroup";
import { Card, SectionHeader, StatusChip, Button, EmptyState, Skeleton } from "@/components/ui-kit";

// A `staff_group_members(_group_id)` row (columns per 20260502225517_...sql:163-164, cited across the
// Teacher Mini App — same shape TeacherGroups.tsx consumes).
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
  avg_score: number | null;
}

// Terminal/in-flight states for a row's nudge action. Absence of an entry = idle (never tapped, or a
// prior tap errored and was reset for retry).
type RowState = "sending" | "sent" | "already" | "no_telegram";

const THRESHOLD_DAYS = 7; // see file header for the source confirming this window
const offlineNow = () => typeof navigator !== "undefined" && !navigator.onLine;

const fullName = (m: RosterMember) =>
  [m.name, m.last_name].map((s) => (s || "").trim()).filter(Boolean).join(" ") || "O'quvchi";

// "oxirgi faollik: X kun oldin" / "hech qachon" — exact copy from the task brief.
function lastActiveLabel(iso: string | null): string {
  if (!iso) return "hech qachon";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000);
  if (Number.isNaN(days)) return "hech qachon";
  return `${Math.max(days, 0)} kun oldin`;
}

export default function TeacherNudges() {
  const { groups, groupId, setGroupId, loading: groupsLoading, error: groupsError, reload: reloadGroups } =
    useSelectedGroup();

  const [roster, setRoster] = useState<RosterMember[]>([]);
  // Starts true (not false): `useSelectedGroup()` resolves `groupsLoading:false` + `groupId` together
  // in one batched render, and this roster-load effect only fires AFTER that render commits. Starting
  // `rosterLoading` false left a one-frame window where `loading` (below) was already false but `roster`
  // was still its initial `[]` — long enough for the no-inactive "🎉 Hamma faol" EmptyState to flash
  // before the roster skeleton, since an empty roster and a genuinely-all-active roster are indistinguishable
  // by `inactive.length === 0` alone. Starting true keeps `loading` true through that gap; harmless when
  // there's no group at all (`loading` only consults `rosterLoading` when `!!groupId`, so a no-groups
  // teacher never gets stuck on the skeleton).
  const [rosterLoading, setRosterLoading] = useState(true);
  const [rosterError, setRosterError] = useState(false);
  const [rosterReloadKey, setRosterReloadKey] = useState(0);

  // Per-student state (keyed by student id) for the nudge action, plus an optional inline error line.
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});

  // Load the selected group's roster whenever the shared selection changes.
  useEffect(() => {
    if (!groupId) {
      setRoster([]);
      return;
    }
    let cancelled = false;
    setRosterLoading(true);
    setRosterError(false);
    (async () => {
      try {
        // Not in the generated types — cast the RPC name (frontend-typecheck-verify convention).
        const { data, error } = await supabase.rpc("staff_group_members" as any, { _group_id: groupId });
        if (cancelled) return;
        if (error) throw error;
        setRoster(((data as any[]) || []) as RosterMember[]);
        // A fresh roster load invalidates any stale per-row state from a previously selected group.
        setRowState({});
        setRowError({});
      } catch (e) {
        if (!cancelled) {
          console.error("[TeacherNudges] staff_group_members failed", e);
          setRosterError(true);
        }
      } finally {
        if (!cancelled) setRosterLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [groupId, rosterReloadKey]);

  // inactive = no last_activity_at OR older than the threshold; sorted most-inactive first (never-active
  // students first, then oldest last_activity_at → most recent, all still under the cutoff).
  const inactive = useMemo(() => {
    const cutoffMs = Date.now() - THRESHOLD_DAYS * 86400_000;
    return roster
      .filter((m) => !m.last_activity_at || new Date(m.last_activity_at).getTime() < cutoffMs)
      .sort((a, b) => {
        const at = a.last_activity_at ? new Date(a.last_activity_at).getTime() : -Infinity;
        const bt = b.last_activity_at ? new Date(b.last_activity_at).getTime() : -Infinity;
        return at - bt;
      });
  }, [roster]);

  const nudge = async (studentId: string) => {
    // Guard: a terminal or in-flight state must never double-invoke (defensive — the UI already hides
    // the button for these states, but this keeps the function itself safe against a stray re-call).
    if (rowState[studentId]) return;
    setRowState((s) => ({ ...s, [studentId]: "sending" }));
    setRowError((s) => {
      const next = { ...s };
      delete next[studentId];
      return next;
    });
    try {
      const { error } = await supabase.functions.invoke("teacher-nudge-student", {
        body: { student_id: studentId },
      });
      if (error) {
        // On an HTTP error, supabase-js puts the response body in error.context, not `data` — read
        // the code from there (HomeworkSubmit.tsx:207-215 / TeacherBroadcast.tsx is the reference).
        let code = "";
        try {
          const j = await (error as any).context?.json?.();
          code = j?.error || "";
        } catch {
          // body unreadable — falls through to the generic error message below
        }
        if (code === "already_nudged_today") {
          setRowState((s) => ({ ...s, [studentId]: "already" }));
          return;
        }
        if (code === "no_telegram") {
          setRowState((s) => ({ ...s, [studentId]: "no_telegram" }));
          return;
        }
        console.error("[TeacherNudges] nudge failed", code || error);
        // forbidden / unauthorized / send_failed / unknown all collapse to the same generic retry —
        // NOT terminal, so clear back to idle and let the teacher tap again.
        setRowState((s) => {
          const next = { ...s };
          delete next[studentId];
          return next;
        });
        setRowError((s) => ({ ...s, [studentId]: code === "forbidden" ? "Ruxsat yo'q" : "Xatolik — qayta urining" }));
        return;
      }
      setRowState((s) => ({ ...s, [studentId]: "sent" }));
    } catch (e) {
      // supabase-js can THROW on a network failure.
      console.error("[TeacherNudges] nudge threw", e);
      setRowState((s) => {
        const next = { ...s };
        delete next[studentId];
        return next;
      });
      setRowError((s) => ({ ...s, [studentId]: "Xatolik — qayta urining" }));
    }
  };

  const offline = offlineNow();
  const loading = groupsLoading || (!!groupId && rosterLoading);
  const error = groupsError || rosterError;
  const retry = () => {
    if (groupsError) reloadGroups();
    else setRosterReloadKey((k) => k + 1);
  };

  return (
    <div className="space-y-4">
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-extrabold tracking-tight text-foreground">Eslatma yuborish</h1>
        <p className="truncate text-sm font-semibold text-muted-foreground">
          7+ kun faolsiz o'quvchilarga "sog'indik" xabari yuboriladi
        </p>
      </div>

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-11 w-full rounded-lg" />
          <Skeleton className="h-[68px] w-full rounded-lg" />
          <Skeleton className="h-[68px] w-full rounded-lg" />
          <Skeleton className="h-[68px] w-full rounded-lg" />
        </div>
      ) : error ? (
        <EmptyState
          icon={offline ? "📡" : "⚠️"}
          title={offline ? "Internet yo'q" : "Xatolik"}
          body={
            offline
              ? "Ulanishni tekshiring va qayta urinib ko'ring."
              : "Ma'lumotlarni yuklab bo'lmadi. Birozdan so'ng qayta urinib ko'ring."
          }
          cta={
            <Button variant="secondary" size="sm" onClick={retry}>
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
        <div className="space-y-4">
          {/* Group picker — a single group shows its name (no picker); 2+ get a native select that
              drives the shared `setGroupId` (so the pick follows the teacher to Groups/Stats). */}
          <div className="min-w-0 space-y-1.5">
            <SectionHeader title="Guruh" />
            {groups.length === 1 ? (
              <div className="truncate rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-[15px] font-extrabold text-foreground">
                {groups[0].name}
              </div>
            ) : (
              <select
                value={groupId ?? ""}
                onChange={(e) => setGroupId(e.target.value)}
                className="w-full min-w-0 rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-sm font-bold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          {inactive.length === 0 ? (
            <EmptyState icon="🎉" title="Hamma faol" body="Hech kim uxlab qolmagan." />
          ) : (
            <div className="space-y-2">
              <SectionHeader title={`Faolsiz o'quvchilar (${inactive.length})`} />
              {inactive.map((m) => (
                <Card key={m.id} className="space-y-1.5">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15px] font-extrabold tracking-tight text-foreground">
                        {fullName(m)}
                      </div>
                      <div className="truncate text-[11.5px] font-semibold text-muted-foreground">
                        oxirgi faollik: {lastActiveLabel(m.last_activity_at)}
                      </div>
                    </div>
                    <div className="flex-none">
                      {!m.telegram_id || rowState[m.id] === "no_telegram" ? (
                        <StatusChip kind="none" label="Telegram ulanmagan" />
                      ) : rowState[m.id] === "sent" ? (
                        <StatusChip kind="ok" label="✅ Yuborildi" />
                      ) : rowState[m.id] === "already" ? (
                        <StatusChip kind="wait" label="Bugun yuborilgan" />
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={rowState[m.id] === "sending"}
                          onClick={() => nudge(m.id)}
                        >
                          {rowState[m.id] === "sending" ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <BellRing className="size-4" />
                          )}
                          Eslatma
                        </Button>
                      )}
                    </div>
                  </div>
                  {rowError[m.id] && (
                    <p className="truncate text-[11.5px] font-semibold text-danger-2">{rowError[m.id]}</p>
                  )}
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
