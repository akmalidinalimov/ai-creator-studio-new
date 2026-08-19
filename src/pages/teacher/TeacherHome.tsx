// TeacherHome — `/tg/teacher` home screen (Task 5).
//
// Renders INSIDE `TeacherShell` (App.tsx wires the shell + bottom nav + staff guard), so this
// file is page CONTENT only — no nav/shell chrome, no extra `max-w-2xl`/`px` (the shell owns
// those). Mirrors `Dashboard.tsx`'s proven shape: a greeting header, a ui-kit `Hero` as the ONE
// coral CTA, a 4-up `StatTile` strip, and the `navigator.onLine`-aware loading/error/retry pattern.
//
// Coral discipline (Global Constraints): exactly one `Button variant="primary"` per screen. Here
// that single coral primary is the `Hero`'s built-in CTA ("Baholash"), and ONLY when there is a
// non-empty grading queue. When the queue is clear (N=0) the hero is replaced by a calm
// `StatusChip kind="ok"` — zero coral, no CTA pointing at an empty queue. Error/loading states
// carry no primary either.
//
// Data sources (see task-5 report for the tile-by-tile provenance):
//   • Kutilmoqda (pending)  ← usePendingGrading() → teacher_pending_submissions() (junction-aware).
//   • Guruhlar / O'quvchilar / Faol ← teacher_groups(uid) aggregated across the teacher's scope.
// "Bugun baholandi" (graded-today) is intentionally OMITTED — no cheap data source exists; we show
// only tiles backed by a real query rather than invent a number.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Users, GraduationCap, Activity, BarChart3, Send, BellRing, type LucideIcon } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { usePendingGrading } from "@/hooks/usePendingGrading";
import {
  Hero,
  StatTile,
  Card,
  SectionHeader,
  StatusChip,
  Button,
  EmptyState,
  Skeleton,
} from "@/components/ui-kit";

// Shape of a `teacher_groups(uid)` row we consume (SECURITY DEFINER RPC; more columns exist).
interface TeacherGroupRow {
  group_id: string;
  group_name: string;
  course_name: string | null;
  total_students: number;
  active_7d: number;
}

// Phase-2 destinations, rendered as DISABLED ghost tiles ("tez orada") — never coral. These are the
// Home action tiles the spec lists (Guruhlar / Statistika / Xabar / Nudge); wired up in later phases.
const COMING_SOON: { icon: LucideIcon; label: string }[] = [
  { icon: Users, label: "Guruhlar" },
  { icon: BarChart3, label: "Statistika" },
  { icon: Send, label: "Xabar" },
  { icon: BellRing, label: "Nudge" },
];

export default function TeacherHome() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pending = usePendingGrading(); // { count, loading } — junction-aware pending total.

  const [displayName, setDisplayName] = useState("");
  const [groups, setGroups] = useState<TeacherGroupRow[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setGroupsLoading(true);
    setError(false);
    (async () => {
      try {
        // One round trip: identity (for the greeting) + the teacher's groups (for the tiles/context).
        // `teacher_groups` is a Task-era RPC not necessarily in the generated Supabase types — cast
        // the name per the frontend-typecheck-verify convention.
        const [profRes, groupsRes] = await Promise.all([
          supabase.from("profiles").select("name, last_name").eq("id", user.id).maybeSingle(),
          supabase.rpc("teacher_groups" as any, { uid: user.id }),
        ]);
        if (cancelled) return;
        if (groupsRes.error) throw groupsRes.error;

        const p: any = profRes.data;
        const name = [p?.name, p?.last_name].filter(Boolean).join(" ").trim();
        setDisplayName(name || "Ustoz");
        setGroups(((groupsRes.data as any) || []) as TeacherGroupRow[]);
      } catch (e) {
        if (!cancelled) {
          console.error("[TeacherHome] load failed", e);
          setError(true);
        }
      } finally {
        if (!cancelled) setGroupsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, reloadKey]);

  // `usePendingGrading` fails quiet (RPC error → count 0, resolves fast — never retries/throws), so
  // the page's error surface is the groups fetch alone; the pending count only gates the hero shape.
  const loading = groupsLoading || pending.loading;
  const offline = typeof navigator !== "undefined" && !navigator.onLine;

  const retry = () => {
    setReloadKey((k) => k + 1);
    queryClient.invalidateQueries({ queryKey: ["teacher-pending-grading-count"] });
  };

  // Aggregate across the teacher's junction scope — Home has no per-group switcher.
  const groupsCount = groups.length;
  const studentsTotal = groups.reduce((s, g) => s + (g.total_students || 0), 0);
  const active7d = groups.reduce((s, g) => s + (g.active_7d || 0), 0);
  const activePct = studentsTotal > 0 ? Math.round((active7d / studentsTotal) * 100) : 0;

  const groupContext =
    groupsCount === 0
      ? "Baholash markazingiz"
      : groupsCount === 1
        ? [groups[0].group_name, groups[0].course_name].filter(Boolean).join(" · ")
        : `${groupsCount} ta guruh` + (studentsTotal > 0 ? ` · ${studentsTotal} o'quvchi` : "");

  const n = pending.count;

  return (
    <div className="space-y-4">
      {loading ? (
        // Skeleton mirrors the populated layout (greeting + hero + 4 tiles + action grid) so a cold
        // start never flashes blank/janky content — same technique as Dashboard's loading block.
        <>
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-[150px] w-full rounded-lg" />
          <div className="grid grid-cols-4 gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[86px] rounded-md" />
            ))}
          </div>
          <Skeleton className="h-5 w-32" />
          <div className="grid grid-cols-2 gap-2">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        </>
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
      ) : (
        <>
          {/* Greeting header (not inside Hero — mirrors Dashboard) */}
          <div className="space-y-1">
            <h1 className="break-words text-2xl font-extrabold tracking-tight text-foreground">
              Salom, {displayName} 👋
            </h1>
            <p className="truncate text-sm font-semibold text-muted-foreground">{groupContext}</p>
          </div>

          {/* Single coral primary lives here — only when there's a queue to send them to. */}
          {n > 0 ? (
            <Hero
              coverLabel="Baholash navbati"
              title={`${n} ta ish sizni kutmoqda`}
              meta="Eng eskisidan boshlab tez baholang"
              ctaLabel="Baholash"
              onCtaClick={() => navigate("/tg/teacher/grade")}
            />
          ) : (
            <Card className="flex flex-col items-center gap-2 py-6 text-center">
              <StatusChip kind="ok" label="Hammasi baholandi ✅" />
              <p className="text-sm font-semibold text-muted-foreground">
                Baholash navbati bo'sh — yangi ishlar kelganda shu yerda ko'rinadi.
              </p>
            </Card>
          )}

          {/* "Bugun" strip folded into tiles. Every value is backed by a real query (see header). */}
          <div className="grid grid-cols-4 gap-2">
            <StatTile icon={<ClipboardCheck />} label="Kutilmoqda" value={n} highlight />
            <StatTile icon={<Users />} label="Guruhlar" value={groupsCount} />
            <StatTile icon={<GraduationCap />} label="O'quvchilar" value={studentsTotal} />
            <StatTile icon={<Activity />} label="Faol" value={studentsTotal > 0 ? `${activePct}%` : "—"} />
          </div>

          {/* Phase-2 actions — DISABLED ghost tiles ("tez orada"), never coral. */}
          <SectionHeader title="Boshqa amallar" />
          <div className="grid grid-cols-2 gap-2">
            {COMING_SOON.map(({ icon: Icon, label }) => (
              <Button
                key={label}
                variant="ghost"
                disabled
                className="h-auto flex-col gap-1 py-3"
                aria-disabled="true"
                title="Tez orada"
              >
                <Icon />
                <span className="text-[13px] font-bold">{label}</span>
                <span className="text-[9px] font-semibold uppercase tracking-wide opacity-70">tez orada</span>
              </Button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
