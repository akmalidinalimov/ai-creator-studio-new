import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ChevronDown, ChevronRight, ClipboardCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { cn } from "@/lib/utils";
import { formatXp } from "@/lib/xp";
import { getHomeworkStateChip, type AssignableItem } from "@/lib/homeworkAssignable";
import { Button, Card, EmptyState, Skeleton, StatusChip } from "@/components/ui-kit";
import HomeworkSubmit from "@/components/homework/HomeworkSubmit";
import { useTelegramBackOverride } from "@/lib/telegram/useTelegramBackButton";
import { fetchHomeworkBriefs, HomeworkBriefText } from "@/components/homework/HomeworkBrief";

/* Module-end homework screen (module-homework feature, 2026-08-18). Reached by tapping a
 * module's "Uy vazifasi" step row in Darslar (src/pages/Lessons.tsx) — this REPLACES the video
 * player for that step with text (title + prompt explaining the task) + the same submit widget
 * the Vazifa tab's picker uses (HomeworkSubmit — src/components/homework/HomeworkSubmit.tsx).
 * It is purely additive: does not gate module completion or lesson progression, and reuses the
 * already-shipped student_assignable_homework() RPC + submit-homework edge fn (no new backend).
 *
 * Prompt text: the shared HomeworkBrief (src/components/homework/HomeworkBrief.tsx) — the SAME
 * description + "what you can upload" the Vazifa tab's picker shows (prompt_<lang> → … →
 * description; a step without text shows its parent's).
 *
 * Coral discipline: Button variant="primary" is the ONE coral CTA per screen (see
 * ui-kit/Button.tsx's own comment). When a module has multiple homework tasks, only ONE can be
 * expanded at a time (single-select accordion via `expandedId`) so at most one HomeworkSubmit
 * — and therefore at most one coral submit button — is ever visible together. A module with a
 * single task skips the accordion entirely and shows it directly, per the brief.
 */

export default function ModuleHomework() {
  const { moduleId } = useParams<{ moduleId: string }>();
  const { user } = useAuth();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [items, setItems] = useState<AssignableItem[]>([]);
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [moduleTitle, setModuleTitle] = useState("");
  const [moduleNumber, setModuleNumber] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Same in-flight-submit guard the Vazifa dialog applies (Homework.tsx's handlePickerOpenChange
  // checks `submitting` before letting the dialog close) — here it locks the "back to lessons"
  // link and the accordion header toggles so a tap can't unmount the submitting HomeworkSubmit
  // mid-upload. No work is actually lost either way (HomeworkSubmit keeps its own state until
  // unmounted), this is purely about not letting the student interrupt their own upload.
  const [submitting, setSubmitting] = useState(false);
  // Telegram's native ← must not leave the page in the middle of an upload (the on-screen back is disabled too)
  useTelegramBackOverride(submitting, () => {});

  useEffect(() => {
    if (!user || !moduleId) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    (async () => {
      try {
        const { data, error: rpcErr } = await supabase.rpc("student_assignable_homework" as any);
        if (rpcErr) throw rpcErr;
        if (cancelled) return;

        const rows = (((data as any[]) || []) as AssignableItem[])
          .filter((r) => r.module_id === moduleId)
          .sort((a, b) => a.step_number - b.step_number);
        setItems(rows);
        if (rows.length) {
          setModuleTitle(rows[0].module_title);
          setModuleNumber(rows[0].module_number);
          setExpandedId(rows.length === 1 ? rows[0].assignment_id : null);

          const map = await fetchHomeworkBriefs(rows.map((r) => r.assignment_id), i18n.language);
          if (cancelled) return;
          setPrompts(map);
        }
      } catch (e) {
        if (!cancelled) {
          console.error("[ModuleHomework] load failed", e);
          setError(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, moduleId, reloadKey, i18n.language]);

  const toggleExpanded = (id: string) => {
    if (submitting) return; // never drop an in-flight submit by collapsing/switching accordion
    setExpandedId((cur) => (cur === id ? null : id));
  };

  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  const backButton = (
    <button
      type="button"
      onClick={() => navigate("/lessons")}
      disabled={submitting}
      className="-ml-2 inline-flex min-h-[44px] items-center gap-1 px-2 text-[12.5px] font-bold text-muted-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      <ArrowLeft className="size-3.5" />
      {t("moduleHomework.backToLessons")}
    </button>
  );

  return (
    <PageShell>
      <div className="mx-auto max-w-2xl space-y-4">
        {backButton}

        {loading ? (
          <>
            <Skeleton className="h-7 w-40" />
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-24 w-full rounded-md" />
            <Skeleton className="h-24 w-full rounded-md" />
          </>
        ) : error ? (
          <EmptyState
            icon={offline ? "📡" : "⚠️"}
            title={offline ? t("common.offlineTitle") : t("common.errorTitle")}
            body={offline ? t("common.offlineBody") : t("moduleHomework.loadError")}
            cta={
              <Button variant="secondary" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
                {t("common.retry")}
              </Button>
            }
          />
        ) : items.length === 0 ? (
          <EmptyState icon="📝" title={t("moduleHomework.emptyTitle")} body={t("moduleHomework.emptyBody")} />
        ) : (
          <>
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight text-foreground">{t("moduleHomework.title")}</h1>
              <p className="text-sm font-semibold text-muted-foreground">
                {moduleNumber != null
                  ? t("homework.picker.moduleHeader", { n: formatXp(moduleNumber, i18n.language), title: moduleTitle })
                  : moduleTitle}
              </p>
            </div>

            {items.map((item) => {
              const isSingle = items.length === 1;
              const isExpanded = isSingle || expandedId === item.assignment_id;
              const chip = getHomeworkStateChip(item.state, item.score, item.max_score, t, i18n.language);
              const prompt = prompts[item.assignment_id] ?? "";

              return (
                <Card key={item.assignment_id} className="space-y-3 p-4">
                  <div
                    className={cn(
                      "flex items-center gap-3",
                      !isSingle && "cursor-pointer",
                      !isSingle && submitting && "pointer-events-none opacity-70",
                    )}
                    role={!isSingle ? "button" : undefined}
                    tabIndex={!isSingle && !submitting ? 0 : undefined}
                    aria-disabled={!isSingle && submitting ? true : undefined}
                    onClick={!isSingle ? () => toggleExpanded(item.assignment_id) : undefined}
                    onKeyDown={
                      !isSingle
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              toggleExpanded(item.assignment_id);
                            }
                          }
                        : undefined
                    }
                  >
                    <div className="grid size-[42px] flex-none place-items-center rounded-md bg-primary text-primary-foreground">
                      <ClipboardCheck className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-2 break-words text-[14px] font-bold text-foreground">{item.title}</div>
                      <div className="text-xs font-semibold text-muted-foreground">
                        {t("homework.picker.maxScoreLabel", { max: formatXp(item.max_score, i18n.language) })}
                      </div>
                      <div className="mt-1.5">
                        <StatusChip kind={chip.kind} label={chip.label} />
                      </div>
                    </div>
                    {!isSingle &&
                      (isExpanded ? (
                        <ChevronDown className="size-4 flex-none text-muted-foreground" />
                      ) : (
                        <ChevronRight className="size-4 flex-none text-muted-foreground" />
                      ))}
                  </div>

                  {isExpanded && (
                    <div className="space-y-3 border-t border-border pt-3">
                      <HomeworkBriefText text={prompt} />
                      <HomeworkSubmit
                        key={item.assignment_id}
                        assignment={item}
                        onSubmittingChange={setSubmitting}
                        onDone={() => setReloadKey((k) => k + 1)}
                      />
                    </div>
                  )}
                </Card>
              );
            })}
          </>
        )}
      </div>
    </PageShell>
  );
}
