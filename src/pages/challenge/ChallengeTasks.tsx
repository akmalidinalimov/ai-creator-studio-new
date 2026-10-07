import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import { PageShell } from "@/components/Layout";
import { Button, Card, EmptyState, Skeleton, StatusChip } from "@/components/ui-kit";
import { useMiniApp } from "@/lib/telegram/MiniAppContext";
import { dailyTaskPath } from "@/lib/miniappLinks";
import { formatTaskDate, loadMyTasks, statusTone, tashkentToday, type MyTask, type MyTasksResult } from "@/lib/dailyTasks";
import { WriteAccessCard } from "@/components/challenge/WriteAccessCard";

/**
 * /challenge/tasks — «Kunlik vazifalar» (Challenge 6.0 daily tasks, PR-7): the student's streak, points and every
 * task so far with its status. Deep link: start_param "dt". The engine's my_challenge_tasks() is the only source.
 *
 * Hidden while platform_settings.challenge_tasks.miniapp (or .enabled) is false: the page then only says where the
 * work goes (the group's «Kunlik vazifalar» topic) — the bot path, which is live independently of the Mini App.
 */
export default function ChallengeTasks() {
  const { t, i18n } = useTranslation();
  const { webApp } = useMiniApp();
  const [data, setData] = useState<MyTasksResult | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setData(null);
    void loadMyTasks().then((r) => { if (alive) setData(r); });
    return () => { alive = false; };
  }, [reloadKey]);

  // In Telegram: open in-app and STOP the <a> (it used to fire too → the topic opened twice). On the web: the <a> opens it.
  const openTopic = (e: { preventDefault: () => void }, url: string) => {
    if (!webApp?.openTelegramLink) return;
    try { webApp.openTelegramLink(url); e.preventDefault(); } catch { /* the <a> is the fallback */ }
  };
  const topicButton = (url: string | null) => url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => openTopic(e, url)}
      className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2.5 text-sm font-bold text-foreground">
      📌 {t("dailyTasks.openTopic")}
    </a>
  ) : null;

  const today = tashkentToday();
  const lng = i18n.language || "uz";

  const row = (task: MyTask) => {
    const st = task.submission?.status ?? (task.closed ? "missed" : task.open ? "open" : "none");
    const pts = task.submission?.status === "accepted" ? Number(task.submission.points ?? 0) : 0;
    return (
      <Link key={task.id} to={dailyTaskPath(task.id)} className="block">
        <Card className={`flex items-center gap-3 p-3.5 hover:bg-tint/40 transition-colors ${task.date === today ? "ring-1 ring-primary/50" : ""}`}>
          <div className="grid size-[44px] flex-none place-items-center rounded-md bg-tint text-center">
            <div className="text-[10px] font-bold leading-tight text-muted-foreground">
              {task.day_no ? t("dailyTasks.dayNo", { n: task.day_no }) : ""}
              <br />
              {task.type === "instagram" ? "📸" : "📝"}
            </div>
          </div>
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 break-words text-[14px] font-extrabold text-foreground">{task.title}</div>
            <div className="text-xs font-semibold text-muted-foreground">
              {task.date === today ? t("dailyTasks.today") : formatTaskDate(task.date, lng)}
              {pts > 0 ? ` · ${t("dailyTasks.task.pointsEarned", { n: pts })}` : ""}
              {task.submission?.late_days ? ` · ${t("dailyTasks.late", { days: task.submission.late_days })}` : ""}
            </div>
            <div className="mt-1.5">
              <StatusChip kind={st === "open" ? "wait" : statusTone(st)} label={t(`dailyTasks.status.${st}`, { defaultValue: st })} />
            </div>
          </div>
          <ChevronRight className="size-[18px] flex-none text-muted-foreground" />
        </Card>
      </Link>
    );
  };

  return (
    <PageShell>
      <div className="mx-auto max-w-2xl space-y-4">
        {data === null ? (
          <>
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-16 w-full rounded-md" />
            <Skeleton className="h-16 w-full rounded-md" />
            <Skeleton className="h-16 w-full rounded-md" />
          </>
        ) : !data.ok ? (
          data.reason === "error" ? (
            <EmptyState icon="⚠️" title={t("common.errorTitle")} body={t("dailyTasks.loadError")}
              cta={<Button variant="secondary" size="sm" onClick={() => setReloadKey((k) => k + 1)}>{t("common.retry")}</Button>} />
          ) : (
            <EmptyState icon="📅" title={t("dailyTasks.notInChallengeTitle")} body={t("dailyTasks.notInChallengeBody")} />
          )
        ) : !data.enabled || !data.miniapp ? (
          <EmptyState icon="📅" title={t("dailyTasks.topicOnlyTitle")} body={t("dailyTasks.topicOnlyBody")} cta={topicButton(data.topic_url)} />
        ) : (
          <>
            <div className="space-y-1">
              <h1 className="text-2xl font-extrabold tracking-tight text-foreground">📅 {t("dailyTasks.title")}</h1>
              <p className="text-sm font-semibold text-muted-foreground">{t("dailyTasks.subtitle")}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full border border-cta/45 bg-accent-soft px-3 py-1.5 text-[13px] font-extrabold text-foreground">🔥 {t("dailyTasks.streak", { days: data.streak })}</span>
              <span className="rounded-full border border-border bg-tint px-3 py-1.5 text-[13px] font-extrabold text-foreground">⚡ {t("dailyTasks.points", { points: data.points })}</span>
            </div>
            <WriteAccessCard />
            {data.tasks.length === 0 ? (
              <EmptyState icon="🗓️" title={t("dailyTasks.emptyTitle")} body={t("dailyTasks.emptyBody")} />
            ) : (
              <div className="space-y-2">{data.tasks.map(row)}</div>
            )}
            {topicButton(data.topic_url)}
          </>
        )}
      </div>
    </PageShell>
  );
}
