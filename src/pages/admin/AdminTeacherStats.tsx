import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { GraduationCap } from "lucide-react";

type Row = {
  teacher_id: string;
  name: string;
  telegram_username: string | null;
  active_days: number;
  days_window: number;
  hours_by_day: number[];
  week_hours: number;
  questions: number;
  answered: number;
  answer_rate: number | null;
  median_wait_min: number | null;
  graded: number;
  grading_med_min: number | null;
};

const DAYS = 7;

function fmtDur(min: number | null | undefined): string {
  if (min == null) return "—";
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 1440) return `${(min / 60).toFixed(1)}h`;
  return `${(min / 1440).toFixed(1)}d`;
}

/** Weekday labels (uz) for the last n days, oldest→newest, in Asia/Tashkent. */
function buildDayLabels(n: number): string[] {
  const WD = ["Ya", "Du", "Se", "Cho", "Pa", "Ju", "Sha"]; // 0=Sun
  const base = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent" }).format(new Date());
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(base + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - (n - 1 - i));
    out.push(WD[d.getUTCDay()]);
  }
  return out;
}

function hourCellCls(h: number): string {
  if (h <= 0) return "bg-muted text-muted-foreground";
  if (h <= 1) return "bg-primary/20 text-foreground";
  if (h <= 3) return "bg-primary/45 text-foreground";
  return "bg-primary/75 text-primary-foreground";
}

export default function AdminTeacherStats() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const labels = useMemo(() => buildDayLabels(DAYS), []);

  const reload = async () => {
    setLoading(true); setErr(null);
    const { data, error } = await supabase.rpc("admin_teacher_weekly" as any, { p_days: DAYS });
    if (error) setErr(error.message || "Ma'lumotni yuklab bo'lmadi");
    else setRows(((data as any[]) || []) as Row[]);
    setLoading(false);
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  // sort by who's most present in chat this week
  const sorted = useMemo(() => [...rows].sort((a, b) => b.week_hours - a.week_hours || a.name.localeCompare(b.name)), [rows]);

  return (
    <PageShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><GraduationCap className="h-6 w-6" /> Teacher Statistics</h1>
          <p className="text-sm text-muted-foreground">So'nggi 7 kun — har bir o'qituvchi guruh chatida qancha vaqt bo'lgan va savollarga javob berganmi.</p>
        </div>

        {err && (
          <div className="rounded border border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400 text-sm p-3">
            ⚠️ {err} <button className="underline ml-2" onClick={reload}>Qayta urinish</button>
          </div>
        )}

        <Card className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">O'qituvchi</TableHead>
                <TableHead className="whitespace-nowrap text-center">Faol kunlar</TableHead>
                <TableHead className="text-center">Har kuni soat (chatda) · so'nggi 7 kun</TableHead>
                <TableHead className="whitespace-nowrap text-center">Hafta jami</TableHead>
                <TableHead className="whitespace-nowrap text-center">Savollarga javob</TableHead>
                <TableHead className="whitespace-nowrap text-center">Baholash</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">Yuklanmoqda…</TableCell></TableRow>
              ) : sorted.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">O'qituvchilar topilmadi.</TableCell></TableRow>
              ) : sorted.map((r) => {
                const hours = r.hours_by_day || [];
                return (
                  <TableRow key={r.teacher_id}>
                    <TableCell className="font-medium whitespace-nowrap">
                      {r.name}
                      {r.telegram_username && <span className="block text-[11px] text-muted-foreground">@{r.telegram_username}</span>}
                    </TableCell>
                    <TableCell className="text-center whitespace-nowrap">
                      <span className="font-semibold">{r.active_days}</span>
                      <span className="text-muted-foreground text-xs"> / {r.days_window}</span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-center gap-1">
                        {labels.map((lbl, i) => {
                          const h = hours[i] ?? 0;
                          return (
                            <div key={i} className="flex flex-col items-center gap-0.5 w-9">
                              <div className="text-[10px] text-muted-foreground">{lbl}</div>
                              <div className={`w-8 h-8 rounded flex items-center justify-center text-xs font-medium ${hourCellCls(h)}`} title={`${lbl}: ${h} soat faol`}>
                                {h > 0 ? h : ""}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </TableCell>
                    <TableCell className="text-center whitespace-nowrap font-semibold">{r.week_hours}h</TableCell>
                    <TableCell className="text-center whitespace-nowrap">
                      {r.questions > 0 ? (
                        <span>
                          <span className="font-semibold">{r.answer_rate}%</span>
                          <span className="text-muted-foreground text-xs"> ({r.answered}/{r.questions})</span>
                          <span className="block text-[11px] text-muted-foreground">~{fmtDur(r.median_wait_min)} kutish</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-xs">ma'lumot yig'ilmoqda</span>
                      )}
                    </TableCell>
                    <TableCell className="text-center whitespace-nowrap">{fmtDur(r.grading_med_min)}<span className="block text-[11px] text-muted-foreground">{r.graded} ta</span></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>

        <div className="text-xs text-muted-foreground space-y-1">
          <p><b>Faol kunlar</b> — 7 kundan nechtasida o'qituvchi guruhga kamida bitta xabar yozgan.</p>
          <p><b>Har kuni soat</b> — o'sha kuni chatda faol bo'lgan soatlar soni (bir xabar yozgan har xil soat = 1). Bu sekundomer emas — qachon yozganiga qarab hisoblanadi.</p>
          <p><b>Savollarga javob</b> — o'quvchi o'qituvchini <b>belgilagan (@), unga javob bergan yoki "ustoz" degan</b> savollardan nechtasiga o'qituvchi/admin javob bergan. Bu bugundan boshlab to'planadi (eski xabarlarda bu ma'lumot yo'q).</p>
          <p><b>Baholash</b> — uy ishlarini o'rtacha qancha vaqtda baholaydi (asosiy ish — ko'p o'qituvchi chatdan ko'ra shu bilan band).</p>
        </div>
      </div>
    </PageShell>
  );
}
