import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CalendarCheck, ChevronRight } from "lucide-react";
import { Card, SectionHeader, StatusChip } from "@/components/ui-kit";
import { dailyTaskPath } from "@/lib/miniappLinks";
import { loadMyTasks, statusTone, tashkentToday, type MyTasks } from "@/lib/dailyTasks";

/**
 * The Dashboard's «Kunlik vazifa» card (Daily Tasks PR-7). Renders NOTHING unless the student is in a challenge group
 * AND the daily tasks are live AND the Mini App path is on (platform_settings.challenge_tasks enabled + miniapp) —
 * so it stays hidden while miniapp=false, and for everyone outside the challenge.
 */
export function DailyTasksCard() {
  const { t } = useTranslation();
  const [data, setData] = useState<MyTasks | null>(null);

  useEffect(() => {
    let alive = true;
    void loadMyTasks().then((r) => { if (alive && r.ok && r.enabled && r.miniapp) setData(r); });
    return () => { alive = false; };
  }, []);

  if (!data) return null;
  const today = tashkentToday();
  const task = data.tasks.find((x) => x.date === today) ?? null;
  const status = task?.submission?.status ?? (task ? "none" : null);

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
              {t("dailyTasks.streak", { days: data.streak })} · {t("dailyTasks.points", { points: data.points })}
            </div>
          </div>
          {status && <StatusChip kind={statusTone(status)} label={t(`dailyTasks.status.${status}`, { defaultValue: status })} />}
          <ChevronRight className="size-[18px] flex-none text-muted-foreground" />
        </Card>
      </Link>
    </>
  );
}
