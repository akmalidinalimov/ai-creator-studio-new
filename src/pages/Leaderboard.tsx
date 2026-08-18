import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { cn } from "@/lib/utils";
import { formatXp } from "@/lib/xp";
import {
  Card,
  SectionHeader,
  XpPill,
  RewardChip,
  Button,
  EmptyState,
  Skeleton,
} from "@/components/ui-kit";

/* Group-only rating: each student sees ONLY their own group, ranked by XP.
   No cross-group / whole-course mixing (owner decision, 2026-07-06).
   CRITICAL data rule (xp-ranking-primitive lesson, xp-data-sources.md): this screen's XP MUST
   come from group_leaderboard()'s `total_xp` column, which is actually user_group_rating_xp —
   NOT user_course_xp/user_xp.total_xp. Labelled "Guruh reytingi XP" per the brief. */

interface Row {
  rank: number; user_id: string; first_name: string; last_initial: string;
  total_xp: number; level: number; current_streak: number; is_me: boolean;
}

type BoardKind = "alltime" | "weekly";

// How many ranks show inline (podium + rows) before we fall back to the sticky "your rank" bar.
// 10 matches the top-10 convention already used elsewhere for group boards (group_student_leaderboard's
// default _limit, the weekly Telegram board's top-10 post) — not an arbitrary new number.
const VISIBLE_LIMIT = 10;
const GROUP_LEADERBOARD_LIMIT = 50;

/** Start (00:00) of the current week, Monday-anchored, in Asia/Tashkent (fixed UTC+5, no DST),
 *  returned as a UTC ISO string. Mirrors Dashboard.tsx's tashkentWeekStartIso() / the server's
 *  `date_trunc('week', now() at time zone 'Asia/Tashkent')` convention (xp-data-sources.md). */
function tashkentWeekStartIso(): string {
  const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
  const shifted = new Date(Date.now() + TASHKENT_OFFSET_MS);
  const dow = shifted.getUTCDay();
  const daysSinceMonday = (dow + 6) % 7;
  const mondayShiftedMs = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() - daysSinceMonday,
    0, 0, 0, 0,
  );
  return new Date(mondayShiftedMs - TASHKENT_OFFSET_MS).toISOString();
}

/** Re-ranks the same member roster by a different score function (used to turn the all-time
 *  roster into the Haftalik board — same members, different XP window). Tie-break mirrors the
 *  server's own order (score desc, streak desc, id) for a stable, deterministic result. */
function rankByScore(base: Row[], scoreOf: (r: Row) => number): Row[] {
  return [...base]
    .sort((a, b) => scoreOf(b) - scoreOf(a) || b.current_streak - a.current_streak || a.user_id.localeCompare(b.user_id))
    .map((r, i) => ({ ...r, total_xp: scoreOf(r), rank: i + 1 }));
}

/** Visual podium order: silver (2nd) left, gold (1st) raised center, bronze (3rd) right — the
 *  classic 2-1-3 layout from the mockup. Degrades to [silver, gold] for 2, or [gold] for 1 —
 *  no undefined slots, no empty-slot artifacts (Step 2 edge case: groups with <3 students). */
function podiumOrder(top: Row[]): Row[] {
  if (top.length >= 3) return [top[1], top[0], top[2]];
  if (top.length === 2) return [top[1], top[0]];
  return top;
}

function initialOf(name: string): string {
  return (name || "?").trim().charAt(0).toUpperCase() || "?";
}

function PodiumSlot({ row, locale, youLabel }: { row: Row; locale: string; youLabel: string }) {
  const isFirst = row.rank === 1;
  const medal = isFirst ? "👑" : row.rank === 2 ? "🥈" : "🥉";
  return (
    <div className={cn("flex flex-shrink-0 flex-col items-center text-center", isFirst ? "w-24" : "w-20")}>
      <div className="relative mb-1.5">
        <div
          className={cn(
            "grid place-items-center rounded-2xl font-extrabold text-white",
            isFirst ? "size-16 text-lg" : "size-[52px] text-base",
          )}
          style={{
            background:
              "conic-gradient(from 200deg, hsl(var(--primary)), color-mix(in srgb, hsl(var(--cta)) 70%, hsl(var(--primary))))",
            boxShadow: isFirst ? "0 0 0 3px hsl(var(--cta))" : undefined,
          }}
        >
          {initialOf(row.first_name)}
        </div>
        <span className="absolute -bottom-1 -right-1 text-base leading-none">{medal}</span>
      </div>
      {/* NOT font-display: Unbounded's digits corrupt under the global font-feature-settings. */}
      <div className="max-w-full truncate text-xs font-bold text-foreground">
        {row.first_name}{row.is_me ? ` (${youLabel})` : ""}
      </div>
      <div className="text-[11px] font-semibold tabular-nums text-muted-foreground">{formatXp(row.total_xp, locale)}</div>
    </div>
  );
}

function LeaderboardRow({
  row, locale, youLabel, elevated,
}: { row: Row; locale: string; youLabel: string; elevated?: boolean }) {
  return (
    <Card
      className={cn(
        "mb-2 flex items-center gap-3 p-3",
        row.is_me && "border-cta/50 bg-accent-soft",
        elevated && "shadow-elevated",
      )}
    >
      <span className="w-6 flex-none text-center text-sm font-bold text-muted-foreground tabular-nums">
        {formatXp(row.rank, locale)}
      </span>
      <div className="grid size-9 flex-none place-items-center rounded-md bg-tint text-[13px] font-extrabold text-primary">
        {initialOf(row.first_name)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-bold text-foreground">
          {row.first_name}{row.last_initial ? ` ${row.last_initial}.` : ""}{row.is_me ? ` (${youLabel})` : ""}
        </div>
      </div>
      <span className="flex-none text-[13.5px] font-extrabold tabular-nums text-foreground">
        {formatXp(row.total_xp, locale)}
      </span>
    </Card>
  );
}

export default function Leaderboard() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const [allTime, setAllTime] = useState<Row[]>([]);
  const [weekly, setWeekly] = useState<Row[]>([]);
  const [groupName, setGroupName] = useState<string | null>(null);
  const [board, setBoard] = useState<BoardKind>("alltime");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const [boardRes, pubRes] = await Promise.all([
          supabase.rpc("group_leaderboard" as any, { uid: user.id, _limit: GROUP_LEADERBOARD_LIMIT }),
          supabase.rpc("public_profile" as any, { _uid: user.id }),
        ]);
        if (boardRes.error) throw boardRes.error;
        if (cancelled) return;
        const members = ((boardRes.data as any) || []) as Row[];
        setAllTime(members);
        const pub: any = Array.isArray(pubRes.data) ? pubRes.data[0] : pubRes.data;
        setGroupName(pub?.group_name || null);

        // Haftalik board: same member roster, re-scored with the windowed primitive
        // (granted to `authenticated`, computes the exact Monday-Tashkent boundary the
        // teacher/admin digest boards already use — 20260810205006_group_student_leaderboard.sql).
        // No batched "my group, this week" RPC exists for a plain student — group_student_leaderboard
        // is admin/teacher-only (checked via has_role/teacher_id, not callable by a regular
        // student's own session) — so this is N parallel per-member calls, paid once per page
        // load (not per toggle click). _course_id is passed null: the function's own contract
        // says a null course yields the plain windowed total, the same graceful fallback
        // group_leaderboard() itself uses for a student with no resolvable course — acceptable
        // for a v1 frontend-only task (only affects the rare dual-enrolled student, and only on
        // the Haftalik tab; the Umumiy board is byte-for-byte the existing, exact RPC).
        if (members.length > 0) {
          const sinceIso = tashkentWeekStartIso();
          const weeklyScores = await Promise.all(
            members.map(async (r) => {
              try {
                const { data, error: rpcError } = await supabase
                  .rpc("user_group_rating_xp_since" as any, { _uid: r.user_id, _course_id: null, _since: sinceIso });
                return rpcError || typeof data !== "number" ? 0 : data;
              } catch {
                return 0;
              }
            }),
          );
          if (cancelled) return;
          const scoreByUser = new Map(members.map((r, i) => [r.user_id, weeklyScores[i]]));
          setWeekly(rankByScore(members, (r) => scoreByUser.get(r.user_id) ?? 0));
        } else {
          setWeekly([]);
        }
      } catch (e) {
        if (cancelled) return;
        console.error("[Leaderboard] load failed", e);
        setError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user, reloadKey]);

  const locale = i18n.language;
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  const displayed = board === "weekly" ? weekly : allTime;
  const me = displayed.find((r) => r.is_me);
  const podiumCount = Math.min(3, displayed.length);
  const podium = displayed.slice(0, podiumCount);
  const listRows = displayed.slice(podiumCount, VISIBLE_LIMIT);
  const stickyMe = me && me.rank > VISIBLE_LIMIT ? me : null;
  const noActivity = displayed.length > 0 && displayed[0].total_xp <= 0;
  const rank3 = displayed[2];
  const xpGapToTop3 = me && rank3 && me.rank > 3 ? Math.max(rank3.total_xp - me.total_xp, 0) : 0;
  const showNudge = !!me && me.rank > 3 && xpGapToTop3 > 0;

  return (
    <PageShell>
      <div className="mx-auto max-w-2xl space-y-4">
        {loading ? (
          <>
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-11 w-full rounded-2xl" />
            <div className="flex items-end justify-center gap-2">
              <Skeleton className="h-20 w-20 rounded-2xl" />
              <Skeleton className="h-24 w-24 rounded-2xl" />
              <Skeleton className="h-20 w-20 rounded-2xl" />
            </div>
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </>
        ) : error ? (
          <EmptyState
            icon={offline ? "📡" : "⚠️"}
            title={offline ? t("common.offlineTitle") : t("common.errorTitle")}
            body={offline ? t("common.offlineBody") : t("leaderboard.loadError")}
            cta={
              <Button variant="secondary" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
                {t("common.retry")}
              </Button>
            }
          />
        ) : allTime.length === 0 ? (
          <EmptyState icon="🏆" title={t("leaderboard.noGroupTitle")} body={t("profile.noGroup")} />
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">
                  {t("leaderboard.title")}
                </h1>
                <p className="truncate text-sm font-semibold text-muted-foreground">
                  {groupName ? `${groupName} · ` : ""}
                  {t("leaderboard.subtitleCount", { count: formatXp(allTime.length, locale) })}
                </p>
              </div>
              <div className="flex flex-none flex-col items-end gap-1.5">
                {me && <RewardChip>#{formatXp(me.rank, locale)}</RewardChip>}
              </div>
            </div>

            <div className="flex gap-1 rounded-2xl bg-tint p-1" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={board === "weekly"}
                onClick={() => setBoard("weekly")}
                className={cn(
                  "flex-1 rounded-xl px-3 py-2 text-[13px] font-bold transition-colors",
                  board === "weekly" ? "bg-card text-foreground shadow-soft" : "text-muted-foreground",
                )}
              >
                {t("leaderboard.toggleWeekly")}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={board === "alltime"}
                onClick={() => setBoard("alltime")}
                className={cn(
                  "flex-1 rounded-xl px-3 py-2 text-[13px] font-bold transition-colors",
                  board === "alltime" ? "bg-card text-foreground shadow-soft" : "text-muted-foreground",
                )}
              >
                {t("leaderboard.toggleAllTime")}
              </button>
            </div>
            <p className="-mt-2 text-center text-[11px] font-semibold text-muted-foreground">
              {t("leaderboard.xpSourceNote")}
            </p>

            {noActivity ? (
              <EmptyState icon="🌱" title={t("leaderboard.noActivityTitle")} body={t("leaderboard.noActivityBody")} />
            ) : (
              <>
                <div className="flex items-end justify-center gap-2">
                  {podiumOrder(podium).map((r) => (
                    <PodiumSlot key={r.user_id} row={r} locale={locale} youLabel={t("profile.you")} />
                  ))}
                </div>

                {listRows.length > 0 && (
                  <>
                    <SectionHeader title={t("leaderboard.rankedTitle")} />
                    <div>
                      {listRows.map((r) => (
                        <LeaderboardRow
                          key={r.user_id}
                          row={r}
                          locale={locale}
                          youLabel={t("profile.you")}
                        />
                      ))}
                    </div>
                  </>
                )}

                {showNudge && (
                  <Card className="flex flex-wrap items-center gap-2 border-cta/40 bg-accent-soft">
                    <span className="text-[13px] font-bold text-foreground">{t("leaderboard.nudgeToTop3")}</span>
                    <XpPill xp={xpGapToTop3} locale={locale} />
                  </Card>
                )}
              </>
            )}
          </>
        )}
      </div>

      {!loading && !error && !noActivity && stickyMe && (
        <div className="sticky bottom-[76px] z-20 mx-auto mt-3 max-w-2xl md:bottom-4">
          <LeaderboardRow
            row={stickyMe}
            locale={locale}
            youLabel={t("profile.you")}
            elevated
          />
        </div>
      )}
    </PageShell>
  );
}
