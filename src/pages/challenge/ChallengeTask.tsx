import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";
import { PageShell } from "@/components/Layout";
import { Button, Card, EmptyState, SectionHeader, Skeleton, StatusChip } from "@/components/ui-kit";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useMiniApp } from "@/lib/telegram/MiniAppContext";
import { impersonatingReadonly } from "@/lib/mutate";
import {
  correctSubmission, formatTaskDate, loadMyTasks, prepareTask, statusTone, tashkentDateOf, type CorrectionOp,
  type MyTasks, type Prepare,
} from "@/lib/dailyTasks";
import { TaskPostText } from "@/components/challenge/TaskPostText";
import { InstagramHandleInline } from "@/components/challenge/InstagramHandleInline";
import DailyTaskSubmit from "@/components/challenge/DailyTaskSubmit";

const LIVE = new Set(["needs_more", "checking", "accepted"]);

/**
 * /challenge/tasks/:taskId — one daily task (Daily Tasks PR-7): the post as the bot posts it, the student's work and
 * its status, the «Ilovadan topshirish» form when the engine says they may submit now, and the one-tap corrections
 * (not a submission / restore / move to another open day). Deep link: start_param "dt_<id>".
 * Every decision is the engine's (prepare_miniapp, my_challenge_tasks, the my_* correction RPCs); this page renders.
 */
export default function ChallengeTask() {
  const { taskId: raw } = useParams();
  const taskId = /^[1-9][0-9]{0,11}$/.test(String(raw ?? "")) ? Number(raw) : null;
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { webApp } = useMiniApp();
  const [prep, setPrep] = useState<Prepare | { error: string } | null>(null);
  const [mine, setMine] = useState<MyTasks | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const lng = i18n.language || "uz";

  useEffect(() => {
    if (taskId === null) return;
    let alive = true;
    setPrep(null);
    void Promise.all([prepareTask(taskId), loadMyTasks()]).then(([p, m]) => {
      if (!alive) return;
      setPrep(p);
      setMine(m.ok ? m : null);
    });
    return () => { alive = false; };
  }, [taskId, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const back = (
    <button type="button" onClick={() => navigate("/challenge/tasks")}
      className="inline-flex items-center gap-1 text-[12.5px] font-bold text-muted-foreground">
      <ArrowLeft className="size-3.5" />
      {t("dailyTasks.task.backToList")}
    </button>
  );

  if (taskId === null) {
    return <PageShell><div className="mx-auto max-w-2xl space-y-4">{back}<EmptyState icon="🔎" title={t("dailyTasks.task.notFound")} body="" /></div></PageShell>;
  }

  const mt = mine?.tasks.find((x) => x.id === taskId) ?? null;
  const p = prep && !("error" in prep) ? prep : null;
  const hidden = mine !== null && (!mine.enabled || !mine.miniapp);
  const topicUrl = p?.topic_url ?? mine?.topic_url ?? null;
  const sub = mt?.submission ?? null;
  const task = p?.task ?? null;
  const title = task?.title ?? mt?.title ?? "";
  const date = task?.date ?? mt?.date ?? null;
  const isIg = (task?.type ?? mt?.type) === "instagram";
  const readonly = impersonatingReadonly();

  const openTopic = (url: string) => { try { webApp?.openTelegramLink?.(url); } catch { /* the <a> is the fallback */ } };
  const topicLink = topicUrl ? (
    <a href={topicUrl} target="_blank" rel="noopener noreferrer" onClick={() => openTopic(topicUrl)}
      className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-bold text-foreground">
      📌 {t("dailyTasks.openTopic")}
    </a>
  ) : null;

  // move targets: the student's OTHER open tasks dated on or before the day the work was first posted (the engine
  // re-checks: never a future task, never later than the late window — I5)
  const firstDay = tashkentDateOf(sub?.submitted_at);
  const targets = (mine?.tasks ?? []).filter((x) => x.id !== taskId && x.open && (!firstDay || x.date <= firstDay));
  const canFix = !!sub && !!mt && !mt.closed && !readonly;

  const fix = async (op: CorrectionOp, target?: number) => {
    if (!sub || busy) return;
    setBusy(true);
    try {
      const r = await correctSubmission(op, sub.id, target);
      if (r.reason === "impersonation_readonly") return; // expected preview no-op
      if (r.ok) toast.success(t(`dailyTasks.fix.ok.${op}`));
      else toast.error(t(`dailyTasks.fix.reasons.${r.reason ?? "default"}`, { defaultValue: t("dailyTasks.fix.reasons.default") }));
      reload();
    } finally {
      setBusy(false);
    }
  };

  const missing = (sub?.missing ?? []).map((l) => t(`dailyTasks.labels.${l}`, { defaultValue: l })).join(", ");

  return (
    <PageShell>
      <div className="mx-auto max-w-2xl space-y-4">
        {back}
        {prep === null ? (
          <>
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-40 w-full rounded-md" />
            <Skeleton className="h-24 w-full rounded-md" />
          </>
        ) : "error" in prep && !mt ? (
          <EmptyState icon="⚠️" title={t("common.errorTitle")} body={t("dailyTasks.loadError")}
            cta={<Button variant="secondary" size="sm" onClick={reload}>{t("common.retry")}</Button>} />
        ) : hidden ? (
          <EmptyState icon="📅" title={t("dailyTasks.topicOnlyTitle")} body={t("dailyTasks.topicOnlyBody")} cta={topicLink} />
        ) : (
          <>
            <div className="space-y-1">
              <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                {mt?.day_no ? `${t("dailyTasks.dayNo", { n: mt.day_no })} · ` : ""}{date ? formatTaskDate(date, lng) : ""}
                {isIg ? ` · 📸 ${t("dailyTasks.instagram")}` : ""}
              </div>
              <h1 className="break-words text-2xl font-extrabold tracking-tight text-foreground">{title || t("dailyTasks.task.notFound")}</h1>
            </div>

            {p?.text && (
              <Card className="p-4">
                <TaskPostText html={p.text} />
              </Card>
            )}

            {sub && (
              <>
                <SectionHeader title={t("dailyTasks.task.yourWork")} />
                <Card className="space-y-2 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusChip kind={statusTone(sub.status)} label={t(`dailyTasks.status.${sub.status}`, { defaultValue: String(sub.status) })} />
                    {sub.status === "accepted" && Number(sub.points ?? 0) > 0 && (
                      <span className="text-sm font-extrabold text-foreground">{t("dailyTasks.task.pointsEarned", { n: sub.points })}</span>
                    )}
                    {sub.late_days ? <span className="text-xs font-semibold text-muted-foreground">{t("dailyTasks.late", { days: sub.late_days })}</span> : null}
                  </div>
                  {sub.status === "needs_more" && missing && <p className="text-sm font-semibold text-foreground">{t("dailyTasks.missing", { items: missing })}</p>}
                  {canFix && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {LIVE.has(String(sub.status)) && (
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmWithdraw(true)}>❌ {t("dailyTasks.fix.withdraw")}</Button>
                      )}
                      {sub.status === "withdrawn" && (
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void fix("restore")}>↩️ {t("dailyTasks.fix.restore")}</Button>
                      )}
                      {LIVE.has(String(sub.status)) && targets.map((x) => (
                        <Button key={x.id} variant="ghost" size="sm" disabled={busy} onClick={() => void fix("move", x.id)}>
                          📌 {t("dailyTasks.fix.moveTo", { date: formatTaskDate(x.date, lng) })}
                        </Button>
                      ))}
                    </div>
                  )}
                </Card>
              </>
            )}

            {isIg && <InstagramHandleInline />}

            {p?.ok && task ? (
              <>
                <SectionHeader title={t("dailyTasks.submit.title")} />
                <Card className="space-y-3 p-4">
                  <p className="text-xs font-semibold text-muted-foreground">{t("dailyTasks.task.whereBody")}</p>
                  <DailyTaskSubmit key={`${task.id}:${reloadKey}`} task={task} topicUrl={topicUrl} onDone={reload} />
                </Card>
              </>
            ) : p && p.reason ? (
              <Card className="space-y-3 p-4">
                <p className="text-sm font-semibold text-foreground">
                  {t(`dailyTasks.reasons.${p.reason}`, { defaultValue: t("dailyTasks.submit.errors.generic") })}
                </p>
                {topicLink}
              </Card>
            ) : null}
          </>
        )}
      </div>

      <AlertDialog open={confirmWithdraw} onOpenChange={setConfirmWithdraw}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dailyTasks.fix.withdraw")}</AlertDialogTitle>
            <AlertDialogDescription>{t("dailyTasks.fix.confirmWithdraw")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirmWithdraw(false); void fix("withdraw"); }}>{t("dailyTasks.fix.withdraw")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}
