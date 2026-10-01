import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CalendarCheck, ChevronRight } from "lucide-react";
import { Card, SectionHeader, StatusChip } from "@/components/ui-kit";
import { dailyTaskPath } from "@/lib/miniappLinks";
import { DT_OPEN_TIME, loadMyTasks, scopeOf, statusTone, taskStatus, tashkentToday, type MyTasks } from "@/lib/dailyTasks";

/**
 * The Dashboard's «Kunlik vazifa» card (Daily Tasks PR-7). Renders NOTHING unless the account is a challenge STUDENT
 * (scopeOf: my_challenge_tasks did not answer not_in_challenge / staff / inactive) AND the daily tasks are live AND the
 * Mini App path is on (platform_settings.challenge_tasks enabled + miniapp) — so it stays hidden while miniapp=false,
 * for everyone outside the challenge, and for staff and inactive profiles.
 *
 * Its streak and points are the DAILY-TASK ones (challenge_task + challenge_task_streak XP) — not the activity streak
 * chip or the XP tiles right above it — so they carry their own labels («Vazifa seriyasi», «Vazifa bali»).
 */
export function DailyTasksCard() {
  const { t } = useTranslation();
  const [data, setData] = useState<MyTasks | null>(null);

  useEffect(() => {
    let alive = true;
    void loadMyTasks().then((r) => { if (alive && r.ok && scopeOf(r) === "student" && r.enabled && r.miniapp) setData(r); });
    return () => { alive = false; };
  }, []);

  if (!data) return null;
  const today = tashkentToday();
  const task = data.tasks.find((x) => x.date === today) ?? null;
  const status = task ? taskStatus(task) : null;

  return (
    <>
      <SectionHeader title={t("dailyTasks.dashboard.title")} action={<Link to="/challenge/tasks">{t("dailyTasks.dashboard.action")}</Link>} />
      <Link to={task ? dailyTaskPath(task.id) : "/challenge/tasks"} className="block">
        <Card className="flex items-center gap-3 cursor-pointer hover:bg-tint/40 transition-colors">
          <div className="grid size-[42px] flex-none place-items-center rounded-md bg-primary text-primary-foreground">
            <CalendarCheck className="size-[22px]" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14.5px] font-extrabold text-foreground">
              {task ? `${task.type === "instagram" ? "📸 " : ""}${task.title}` : t("dailyTasks.dashboard.todayNone")}
            </div>
            <div className="text-xs font-semibold text-muted-foreground">
              {t("dailyTasks.dashboard.taskStreak", { days: data.streak })} · {t("dailyTasks.dashboard.taskPoints", { points: data.points })}
            </div>
          </div>
          {status && <StatusChip kind={statusTone(status)} label={t(`dailyTasks.status.${status}`, { defaultValue: status, time: DT_OPEN_TIME })} />}
          <ChevronRight className="size-[18px] flex-none text-muted-foreground" />
        </Card>
      </Link>
    </>
  );
}
