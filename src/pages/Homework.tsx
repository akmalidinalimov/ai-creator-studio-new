import { Fragment, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowLeft, CheckCircle2, ChevronRight, ClipboardCheck, Clock, Plus, Star } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { cn } from "@/lib/utils";
import { formatXp } from "@/lib/xp";
import { effectiveLeafGrades } from "@/lib/homeworkStats";
import { getHomeworkStateChip, type AssignableItem } from "@/lib/homeworkAssignable";
import { Card, SectionHeader, StatTile, StatusChip, XpPill, Button, EmptyState, Skeleton } from "@/components/ui-kit";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import HomeworkSubmit from "@/components/homework/HomeworkSubmit";

/* Vazifa (homework) hub. Mockup: data-screen="homework" + "hw-detail" + "upload".
 *
 * Item 4 (2026-08-18) added the real in-app submit flow on top of the originally read-only
 * hub (Task 2.6): "Yangi vazifa topshirish" now opens a picker (student_assignable_homework()
 * RPC — supabase/migrations/20260818160000_*.sql) instead of linking out to the group's
 * Telegram topic, the student picks a leaf assignment, uploads a photo (+ optional note),
 * and submit-homework (supabase/functions/submit-homework/index.ts) writes the submission —
 * same table, same XP triggers, same teacher-DM queue the bot capture paths use, so grading
 * and notifications are untouched. See doPicker* state below and the PickerList component at
 * the bottom of this file. The read-only summary/filter/graded-detail views below are
 * unchanged.
 *
 * Data model: homework_submissions has UNIQUE(assignment_id, user_id) — one row per
 * assignment for this student, so "submission" and "assignment" are 1:1 here. Effective
 * score reuses effectiveLeafGrades() (src/lib/homeworkStats.ts) — the SAME fallback
 * HomeworkProfileSection.tsx/HomeworkSection.tsx use: a resubmission clears the live
 * `score` but the last *scored* entry in previous_attempts still counts until the new
 * grade lands. On top of that we layer the score_is_stale override those two components
 * also apply independently: a stale row (score present but flagged awaiting-regrade)
 * must NOT read as freshly "graded" just because a number happens to be sitting in
 * `score` — see status derivation below.
 *
 * "Redo" status: the brief asks for a StatusChip kind="redo" row, but there is no
 * "needs resubmit" flag anywhere in the schema (only `score_is_stale`, which means the
 * opposite — already resubmitted, awaiting a NEW grade). Per the brief's own fallback
 * instruction, nothing here is fabricated into "redo": every non-graded row buckets as
 * "waiting". The redo UI path (chip + "Qayta yuklash") stays wired for forward
 * compatibility but is never reached by real data today — documented in the task report.
 *
 * Images: submitted_image_url is a PRIVATE `homework_images` bucket path (needs
 * createSignedUrl, mirrors TeacherHomework.tsx's Drawer) — resolved lazily only when a
 * graded row is opened, not for the whole list. Newer multi-media submissions carry a
 * `media` jsonb array (see 20260707020000_homework_multimedia.sql); only items with a
 * direct http(s) `url` can be inlined as an <img> — Telegram-hosted-only entries
 * (file_id/msg_url, no url) can't be embedded without a bot-API proxy, so they're
 * skipped rather than shown broken. Per the storage retention design (hybrid delete —
 * docs/superpowers/specs/2026-08-17-ui-redesign-design.md §6.3), a signed-URL failure or
 * an empty resolved set is NOT treated as an error: it renders a graceful "image
 * unavailable" note, never a broken <img>.
 */

type MediaItem = { kind?: string; url?: string; msg_url?: string; file_id?: string };

interface SubmissionRaw {
  id: string;
  assignment_id: string;
  submitted_at: string;
  submitted_text: string | null;
  submitted_image_url: string | null;
  media: MediaItem[] | null;
  score: number | null;
  score_feedback: string | null;
  score_is_stale: boolean | null;
  scored_by: string | null;
  scored_at: string | null;
  previous_attempts: any[] | null;
  homework_assignments: {
    id: string;
    title: string;
    max_score: number;
    modules: { title: string | null; position: number | null } | null;
  } | null;
}

type HwStatus = "graded" | "waiting" | "redo";

interface HwItem {
  id: string;
  assignmentId: string;
  title: string;
  moduleTitle: string;
  submittedAt: string;
  maxScore: number;
  status: HwStatus;
  effectiveScore: number | null;
  effectiveFeedback: string | null;
  submittedText: string;
  submittedImageUrl: string | null;
  media: MediaItem[];
  scoredBy: string | null;
  xpEarned: number;
}

type FilterKind = "all" | "waiting" | "graded";

// AssignableItem/AssignableState (student_assignable_homework() RPC row shape) now live in
// src/lib/homeworkAssignable.ts — shared with Lessons.tsx's module-end row and
// ModuleHomework.tsx (module-end homework feature, 2026-08-18) instead of being local to this
// file.

function relativeTime(iso: string, t: TFunction): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return t("settings.justNow");
  if (mins < 60) return t("settings.minAgo", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("settings.hourAgo", { n: hours });
  const days = Math.floor(hours / 24);
  return t("settings.dayAgo", { n: days });
}

// compressHomeworkImage/extForBlob/submit error-mapping now live in
// src/components/homework/HomeworkSubmit.tsx alongside the rest of the submit mechanics.

export default function Homework() {
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  const [items, setItems] = useState<HwItem[]>([]);
  const [teacherNames, setTeacherNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState<FilterKind>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [images, setImages] = useState<string[] | null>(null);
  const [imagesLoading, setImagesLoading] = useState(false);

  // ---- in-app submit flow (item 4; upload/submit mechanics extracted to HomeworkSubmit) ----
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerError, setPickerError] = useState(false);
  const [pickerItems, setPickerItems] = useState<AssignableItem[]>([]);
  const [stage, setStage] = useState<"list" | "upload">("list");
  const [pickedItem, setPickedItem] = useState<AssignableItem | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const subsRes = await supabase
          .from("homework_submissions")
          .select(
            "id, assignment_id, submitted_at, submitted_text, submitted_image_url, media, score, score_feedback, score_is_stale, scored_by, scored_at, previous_attempts, homework_assignments(id, title, max_score, modules(title, position))",
          )
          .eq("user_id", user.id)
          .order("submitted_at", { ascending: false });
        if (subsRes.error) throw subsRes.error;
        if (cancelled) return;

        const rows = ((subsRes.data as any[]) || []) as SubmissionRaw[];

        // Effective-score fallback — exact reuse of HomeworkProfileSection.tsx's logic.
        const leaves = rows.map((r) => ({ id: r.assignment_id, max_score: r.homework_assignments?.max_score ?? 0 }));
        const subsLite = rows.map((r) => ({
          assignment_id: r.assignment_id,
          score: r.score,
          score_feedback: r.score_feedback,
          scored_at: r.scored_at,
          previous_attempts: r.previous_attempts,
        }));
        const effByAssignment = new Map(effectiveLeafGrades(leaves, subsLite).map((e) => [e.assignment_id, e]));

        // XP actually awarded per assignment, read straight from the ledger (ref-key
        // idempotent — xp_on_homework() in 20260706090000_profile_gamification_phase1.sql:
        // +15 on submit, +25 more if scored >=9) rather than re-deriving the trigger's
        // arithmetic client-side, so this stays correct even if the award rule changes.
        const { data: xpRows } = await supabase
          .from("xp_events" as any)
          .select("amount, reason, ref_key")
          .eq("user_id", user.id)
          .in("reason", ["homework_submit", "homework_high_score"]);
        const xpByAssignment = new Map<string, number>();
        ((xpRows as any[]) || []).forEach((r) => {
          const key = typeof r.ref_key === "string" ? r.ref_key.split(":")[1] : null;
          if (!key) return;
          xpByAssignment.set(key, (xpByAssignment.get(key) || 0) + Number(r.amount || 0));
        });

        const built: HwItem[] = rows.map((r) => {
          const eff = effByAssignment.get(r.assignment_id);
          // score_is_stale = re-opened for regrade (HomeworkProfileSection/HomeworkSection
          // convention) — even if a (now-stale) number sits in `score`, this is NOT a
          // finished grade yet, so it must bucket as "waiting", not "graded".
          const isStale = !!r.score_is_stale;
          const status: HwStatus = eff?.effective_score != null && !isStale ? "graded" : "waiting";
          return {
            id: r.id,
            assignmentId: r.assignment_id,
            title: r.homework_assignments?.title || "—",
            moduleTitle: r.homework_assignments?.modules?.title || "—",
            submittedAt: r.submitted_at,
            maxScore: r.homework_assignments?.max_score ?? 10,
            status,
            effectiveScore: eff?.effective_score ?? null,
            effectiveFeedback: eff?.effective_feedback ?? null,
            submittedText: r.submitted_text || "",
            submittedImageUrl: r.submitted_image_url,
            media: Array.isArray(r.media) ? r.media : [],
            scoredBy: r.scored_by,
            xpEarned: xpByAssignment.get(r.assignment_id) || 0,
          };
        });
        setItems(built);

        // Teacher display names for the graded-detail context/feedback card. No FK-embed
        // exists from scored_by → profiles (plain uuid column), so this is a manual,
        // best-effort lookup — a missing name just falls back to a generic label.
        const teacherIds = Array.from(new Set(built.filter((i) => i.scoredBy).map((i) => i.scoredBy as string)));
        if (teacherIds.length) {
          const { data: profRows } = await supabase.from("profiles").select("id, name").in("id", teacherIds);
          const names: Record<string, string> = {};
          ((profRows as any[]) || []).forEach((p) => {
            names[p.id] = p.name || "";
          });
          if (!cancelled) setTeacherNames(names);
        }
      } catch (e) {
        if (!cancelled) {
          console.error("[Homework] load failed", e);
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

  const { gradedCount, waitingCount, avg10 } = useMemo(() => {
    let graded = 0;
    let waiting = 0;
    let earned = 0;
    let maxScored = 0;
    items.forEach((it) => {
      if (it.status === "graded") {
        graded++;
        earned += it.effectiveScore ?? 0;
        maxScored += it.maxScore;
      } else {
        waiting++; // "redo" (never produced today — see file header) folds in here too
      }
    });
    return {
      gradedCount: graded,
      waitingCount: waiting,
      avg10: maxScored > 0 ? +((earned / maxScored) * 10).toFixed(1) : null,
    };
  }, [items]);

  const filteredItems = useMemo(() => {
    if (filter === "graded") return items.filter((i) => i.status === "graded");
    if (filter === "waiting") return items.filter((i) => i.status !== "graded");
    return items;
  }, [items, filter]);

  const selected = selectedId ? (items.find((i) => i.id === selectedId) ?? null) : null;

  // Lazy image resolution — only when a graded row is opened (never for the whole list).
  useEffect(() => {
    if (!selected) {
      setImages(null);
      return;
    }
    let cancelled = false;
    setImagesLoading(true);
    (async () => {
      const urls: string[] = [];
      for (const m of selected.media) {
        if (m.kind === "photo" && typeof m.url === "string" && /^https?:\/\//.test(m.url)) urls.push(m.url);
      }
      if (urls.length === 0 && selected.submittedImageUrl) {
        const raw = selected.submittedImageUrl;
        if (/^https?:\/\//.test(raw)) {
          urls.push(raw);
        } else {
          try {
            const { data, error: signErr } = await supabase.storage.from("homework_images").createSignedUrl(raw, 600);
            if (!signErr && data?.signedUrl) urls.push(data.signedUrl);
          } catch {
            // Object purged (7-day retention policy) or otherwise inaccessible — the
            // "image unavailable" fallback below handles this gracefully.
          }
        }
      }
      if (!cancelled) {
        setImages(urls);
        setImagesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected?.id]);

  // ---- in-app submit flow (item 4) ----

  const loadPickerItems = async (preselectAssignmentId?: string) => {
    setPickerLoading(true);
    setPickerError(false);
    try {
      const { data, error } = await supabase.rpc("student_assignable_homework" as any);
      if (error) throw error;
      const rows = ((data as any[]) || []) as AssignableItem[];
      setPickerItems(rows);
      if (preselectAssignmentId) {
        const match = rows.find((r) => r.assignment_id === preselectAssignmentId);
        if (match) {
          setPickedItem(match);
          setStage("upload");
        }
      }
    } catch (e) {
      console.error("[Homework] picker load failed", e);
      setPickerError(true);
    } finally {
      setPickerLoading(false);
    }
  };

  // preselectAssignmentId: used by the "Qayta yuklash" row action (redo state) to jump
  // straight to that assignment's upload screen instead of the picker list.
  const openPicker = (preselectAssignmentId?: string) => {
    setStage("list");
    setPickedItem(null);
    setPickerOpen(true);
    void loadPickerItems(preselectAssignmentId);
  };

  const handlePickerOpenChange = (open: boolean) => {
    if (!open) {
      if (submitting) return; // never drop an in-flight submit (close/Esc/overlay tap alike)
      setStage("list");
      setPickedItem(null);
    }
    setPickerOpen(open);
  };

  const selectPickerItem = (item: AssignableItem) => {
    setPickedItem(item);
    setStage("upload");
  };

  // Called by HomeworkSubmit after a successful submit/resubmit for the picked item.
  const handleSubmitDone = () => {
    setPickerOpen(false);
    setStage("list");
    setPickedItem(null);
    setReloadKey((k) => k + 1); // refreshes the read-only hub list underneath
  };

  if (loading) {
    return (
      <PageShell>
        <div className="mx-auto max-w-2xl space-y-4">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-56" />
          <div className="grid grid-cols-3 gap-2">
            <Skeleton className="h-20 rounded-md" />
            <Skeleton className="h-20 rounded-md" />
            <Skeleton className="h-20 rounded-md" />
          </div>
          <Skeleton className="h-11 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-2xl" />
          <Skeleton className="h-16 w-full rounded-md" />
          <Skeleton className="h-16 w-full rounded-md" />
          <Skeleton className="h-16 w-full rounded-md" />
        </div>
      </PageShell>
    );
  }

  if (error) {
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    return (
      <PageShell>
        <div className="mx-auto max-w-2xl">
          <EmptyState
            icon={offline ? "📡" : "⚠️"}
            title={offline ? t("common.offlineTitle") : t("common.errorTitle")}
            body={offline ? t("common.offlineBody") : t("homework.loadError")}
            cta={
              <Button variant="secondary" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
                {t("common.retry")}
              </Button>
            }
          />
        </div>
      </PageShell>
    );
  }

  // -------------------------------------------------------------- graded detail
  if (selected) {
    const teacherName = (selected.scoredBy && teacherNames[selected.scoredBy]) || "";
    const hasMedia = selected.media.length > 0 || !!selected.submittedImageUrl;
    return (
      <PageShell>
        <div className="mx-auto max-w-2xl space-y-4">
          <div className="pt-1 text-center">
            {/* NOT font-display: Unbounded's digits corrupt under the global
                font-feature-settings (see StatTile/XpPill/PodiumSlot). */}
            <div className="text-[46px] font-extrabold leading-none tracking-tight text-good-2">
              {formatXp(selected.effectiveScore ?? 0, locale)}
              <span className="ml-1 text-base font-bold text-muted-foreground">
                /{formatXp(selected.maxScore, locale)}
              </span>
            </div>
            <div className="mt-2.5 flex items-center justify-center gap-2">
              <XpPill xp={selected.xpEarned} locale={locale} />
              <span className="text-xs font-semibold text-muted-foreground">{t("homework.xpEarnedSuffix")}</span>
            </div>
          </div>

          <Card className="flex items-center gap-3">
            <div className="grid size-[42px] flex-none place-items-center rounded-md bg-primary text-primary-foreground">
              <ClipboardCheck className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-bold text-foreground">{selected.title}</div>
              <div className="truncate text-xs font-semibold text-muted-foreground">
                {selected.moduleTitle}
                {teacherName ? ` · ${t("homework.teacherPrefix", { name: teacherName })}` : ""}
              </div>
            </div>
          </Card>

          <SectionHeader title={t("homework.yourWorkTitle")} />
          {selected.submittedText && (
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{selected.submittedText}</p>
          )}
          {imagesLoading ? (
            <div className="flex gap-2">
              <Skeleton className="size-[72px] rounded-md" />
              <Skeleton className="size-[72px] rounded-md" />
            </div>
          ) : images && images.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {images.map((u) => (
                <a key={u} href={u} target="_blank" rel="noreferrer">
                  <img src={u} alt="" className="size-[72px] rounded-md border border-border object-cover" />
                </a>
              ))}
            </div>
          ) : hasMedia ? (
            <p className="text-xs font-semibold text-muted-foreground">{t("homework.imageUnavailable")}</p>
          ) : null}

          {selected.effectiveFeedback && (
            <div className="rounded-lg border border-border bg-surface-2 p-3.5">
              <div className="mb-2 flex items-center gap-2">
                <div className="grid size-[30px] flex-none place-items-center rounded-md bg-primary text-[12px] font-extrabold text-primary-foreground">
                  {(teacherName || "O").slice(0, 1).toUpperCase()}
                </div>
                <div>
                  <div className="text-[13px] font-bold text-foreground">{teacherName || t("homework.teacherFallback")}</div>
                  <div className="text-[11px] font-semibold text-muted-foreground">{t("homework.feedbackTitle")}</div>
                </div>
              </div>
              <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-foreground/90">
                {selected.effectiveFeedback}
              </p>
            </div>
          )}

          <Button variant="ghost" block onClick={() => setSelectedId(null)}>
            <ArrowLeft className="size-4" />
            {t("homework.backToList")}
          </Button>
        </div>
      </PageShell>
    );
  }

  // -------------------------------------------------------------------- hub list
  return (
    <PageShell>
      <div className="mx-auto max-w-2xl space-y-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-foreground">{t("homework.title")}</h1>
          <p className="text-sm font-semibold text-muted-foreground">{t("homework.subtitle")}</p>
        </div>

        {items.length === 0 ? (
          <EmptyState
            icon="📝"
            title={t("homework.emptyTitle")}
            body={t("homework.emptyBody")}
            cta={
              <Button variant="primary" block onClick={() => openPicker()}>
                <Plus className="size-4" />
                {t("homework.newSubmissionCta")}
              </Button>
            }
          />
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <StatTile icon={<CheckCircle2 />} label={t("homework.statGraded")} value={formatXp(gradedCount, locale)} />
              <StatTile
                icon={<Clock />}
                label={t("homework.statWaiting")}
                value={formatXp(waitingCount, locale)}
                highlight
              />
              <StatTile
                icon={<Star />}
                label={t("homework.statAvg")}
                value={avg10 != null ? formatXp(avg10, locale) : "—"}
              />
            </div>

            <Button variant="primary" block onClick={() => openPicker()}>
              <Plus className="size-4" />
              {t("homework.newSubmissionCta")}
            </Button>

            <div className="flex gap-1 rounded-2xl bg-tint p-1" role="tablist">
              {(["all", "waiting", "graded"] as FilterKind[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={filter === f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    "flex-1 rounded-xl px-3 py-2 text-[12.5px] font-bold transition-colors",
                    filter === f ? "bg-card text-foreground shadow-soft" : "text-muted-foreground",
                  )}
                >
                  {t(`homework.filter${f === "all" ? "All" : f === "waiting" ? "Waiting" : "Graded"}`)}
                </button>
              ))}
            </div>

            {filteredItems.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">{t("homework.filterEmpty")}</p>
            ) : (
              <div>
                {filteredItems.map((it) => (
                  <HwListRow
                    key={it.id}
                    item={it}
                    locale={locale}
                    t={t}
                    onOpen={() => setSelectedId(it.id)}
                    onResubmit={() => openPicker(it.assignmentId)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <Dialog open={pickerOpen} onOpenChange={handlePickerOpenChange}>
        <DialogContent className="max-w-md gap-4 border-border bg-card p-5 text-foreground">
          <DialogHeader>
            <DialogTitle className="text-foreground">
              {stage === "list" ? t("homework.picker.title") : t("homework.picker.uploadTitle")}
            </DialogTitle>
          </DialogHeader>

          {stage === "list" ? (
            <div className="-mx-1 max-h-[65vh] overflow-y-auto px-1">
              {pickerLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-16 w-full rounded-md" />
                  <Skeleton className="h-16 w-full rounded-md" />
                  <Skeleton className="h-16 w-full rounded-md" />
                </div>
              ) : pickerError ? (
                <EmptyState
                  icon="⚠️"
                  title={t("common.errorTitle")}
                  body={t("homework.picker.loadError")}
                  cta={
                    <Button variant="secondary" size="sm" onClick={() => void loadPickerItems()}>
                      {t("common.retry")}
                    </Button>
                  }
                />
              ) : pickerItems.length === 0 ? (
                <EmptyState icon="🎉" title={t("homework.picker.emptyTitle")} body={t("homework.picker.emptyBody")} />
              ) : (
                <PickerList items={pickerItems} onSelect={selectPickerItem} t={t} locale={locale} />
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <button
                type="button"
                onClick={() => setStage("list")}
                disabled={submitting}
                className="inline-flex items-center gap-1 text-[12.5px] font-bold text-muted-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                <ArrowLeft className="size-3.5" />
                {t("homework.picker.backToPicker")}
              </button>

              <Card className="flex items-center gap-3">
                <div className="grid size-[42px] flex-none place-items-center rounded-md bg-primary text-primary-foreground">
                  <ClipboardCheck className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-bold text-foreground">{pickedItem?.title}</div>
                  <div className="truncate text-xs font-semibold text-muted-foreground">
                    {pickedItem?.module_title}
                    {pickedItem
                      ? ` · ${t("homework.picker.maxScoreLabel", { max: formatXp(pickedItem.max_score, locale) })}`
                      : ""}
                  </div>
                </div>
              </Card>

              {pickedItem && (
                <HomeworkSubmit
                  key={pickedItem.assignment_id}
                  assignment={pickedItem}
                  onSubmittingChange={setSubmitting}
                  onDone={handleSubmitDone}
                />
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

function HwListRow({
  item,
  locale,
  t,
  onOpen,
  onResubmit,
}: {
  item: HwItem;
  locale: string;
  t: TFunction;
  onOpen: () => void;
  onResubmit: () => void;
}) {
  const clickable = item.status === "graded";
  return (
    <Card
      onClick={clickable ? onOpen : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen();
              }
            }
          : undefined
      }
      className={cn(
        "mb-2 flex items-center gap-3 p-[11px]",
        clickable && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      )}
    >
      <div className="grid size-11 flex-none place-items-center rounded-md bg-primary text-primary-foreground">
        <ClipboardCheck className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-bold text-foreground">{item.title}</div>
        <div className="truncate text-[11.5px] font-semibold text-muted-foreground">
          {item.moduleTitle} · {relativeTime(item.submittedAt, t)}
        </div>
      </div>
      {item.status === "graded" ? (
        <div className="flex flex-none flex-col items-end gap-1">
          <span className="text-[15px] font-extrabold tabular-nums text-foreground">
            {formatXp(item.effectiveScore ?? 0, locale)}/{formatXp(item.maxScore, locale)}
          </span>
          <StatusChip kind="ok" label={t("homework.statusGraded")} />
        </div>
      ) : item.status === "redo" ? (
        <Button
          variant="primary"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onResubmit();
          }}
        >
          {t("homework.resubmitCta")}
        </Button>
      ) : (
        <div className="flex flex-none flex-col items-end gap-1">
          <StatusChip kind="wait" label={t("homework.statusWaiting")} />
          <span className="text-[11px] font-semibold text-gold-2">{t("homework.waitingHint")}</span>
        </div>
      )}
      {clickable && <ChevronRight className="size-4 flex-none text-muted-foreground" />}
    </Card>
  );
}

// Picker list — grouped by module (rows already arrive module-ordered from the RPC, so a
// SectionHeader is inserted whenever module_id changes rather than pre-grouping into a map).
function PickerList({
  items,
  onSelect,
  t,
  locale,
}: {
  items: AssignableItem[];
  onSelect: (item: AssignableItem) => void;
  t: TFunction;
  locale: string;
}) {
  let lastModuleId: string | null = null;
  return (
    <div>
      {items.map((item, idx) => {
        const showHeader = item.module_id !== lastModuleId;
        lastModuleId = item.module_id;
        return (
          <Fragment key={item.assignment_id}>
            {showHeader && (
              <SectionHeader
                title={t("homework.picker.moduleHeader", { n: item.module_number, title: item.module_title })}
                className={idx === 0 ? "mt-0" : undefined}
              />
            )}
            <Card
              onClick={() => onSelect(item)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(item);
                }
              }}
              className="mb-2 flex cursor-pointer items-center gap-3 p-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <div className="grid size-9 flex-none place-items-center rounded-md bg-tint text-[11px] font-extrabold text-foreground">
                V{item.step_number}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-bold text-foreground">{item.title}</div>
                <div className="truncate text-[11.5px] font-semibold text-muted-foreground">{item.module_title}</div>
              </div>
              {renderPickerStateChip(item, t, locale)}
              <ChevronRight className="size-4 flex-none text-muted-foreground" />
            </Card>
          </Fragment>
        );
      })}
    </div>
  );
}

// Chip logic now centralized in src/lib/homeworkAssignable.ts (getHomeworkStateChip) — shared
// with Lessons.tsx's module-end row and ModuleHomework.tsx's per-task chip.
function renderPickerStateChip(item: AssignableItem, t: TFunction, locale: string) {
  const chip = getHomeworkStateChip(item.state, item.score, item.max_score, t, locale);
  return <StatusChip kind={chip.kind} label={chip.label} />;
}
