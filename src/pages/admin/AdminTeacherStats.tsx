import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  ungraded_backlog: number;
  last_active: string | null;
};

const DAYS = 7;

function fmtDur(min: number | null | undefined): string {
  if (min == null) return "—";
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 1440) return `${(min / 60).toFixed(1)}h`;
  return `${(min / 1440).toFixed(1)}d`;
}

/** Relative "last online" with a recency color. */
function fmtAgo(iso: string | null | undefined): { text: string; cls: string } {
  if (!iso) return { text: "hech qachon", cls: "text-muted-foreground" };
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  let text: string;
  if (min < 1) text = "hozir";
  else if (min < 60) text = `${min} daqiqa oldin`;
  else if (min < 1440) text = `${Math.floor(min / 60)} soat oldin`;
  else text = `${Math.floor(min / 1440)} kun oldin`;
  const cls = min < 1440 ? "text-emerald-600 dark:text-emerald-400"
    : min < 4320 ? "text-amber-600 dark:text-amber-400"
    : "text-rose-600 dark:text-rose-400";
  return { text, cls };
}

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
  if (h <= 0) return "bg-muted text-muted-foreground/50";
  if (h <= 1) return "bg-primary/25 text-foreground";
  if (h <= 3) return "bg-primary/50 text-foreground";
  return "bg-primary/80 text-primary-foreground";
}

/** Status from what the teacher actually does. */
function statusOf(r: Row): { label: string; cls: string } {
  if (r.week_hours > 0) return { label: "💬 Chatda faol", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30" };
  if (r.graded > 0) return { label: "✅ Baholaydi", cls: "bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30" };
  return { label: "⚠️ Faol emas", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30" };
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

  // most-working first: by homework graded, then chat hours
  const sorted = useMemo(
    () => [...rows].sort((a, b) => b.graded - a.graded || b.week_hours - a.week_hours || a.name.localeCompare(b.name)),
    [rows]
  );

  return (
    <PageShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><GraduationCap className="h-6 w-6" /> Teacher Statistics</h1>
          <p className="text-sm text-muted-foreground">So'nggi 7 kun — har bir o'qituvchining asosiy ishi (baholash) va guruh chatidagi faolligi.</p>
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
                <TableHead className="whitespace-nowrap">Holat</TableHead>
                <TableHead className="whitespace-nowrap">Oxirgi faollik</TableHead>
                <TableHead className="whitespace-nowrap">Baholash <span className="font-normal text-muted-foreground">(asosiy ish)</span></TableHead>
                <TableHead className="whitespace-nowrap">Guruh chatida</TableHead>
                <TableHead className="whitespace-nowrap">Savollarga javob</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">Yuklanmoqda…</TableCell></TableRow>
              ) : sorted.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">O'qituvchilar topilmadi.</TableCell></TableRow>
              ) : sorted.map((r) => {
                const st = statusOf(r);
                const hours = r.hours_by_day || [];
                return (
                  <TableRow key={r.teacher_id}>
                    <TableCell className="font-medium whitespace-nowrap align-top">
                      {r.name}
                      {r.telegram_username && <span className="block text-[11px] text-muted-foreground">@{r.telegram_username}</span>}
                    </TableCell>
                    <TableCell className="align-top"><Badge variant="outline" className={`text-[11px] whitespace-nowrap ${st.cls}`}>{st.label}</Badge></TableCell>
                    <TableCell className="align-top whitespace-nowrap">
                      {(() => { const a = fmtAgo(r.last_active); return <span className={`text-xs ${a.cls}`} title={r.last_active ? new Date(r.last_active).toLocaleString() : ""}>{a.text}</span>; })()}
                    </TableCell>
                    <TableCell className="align-top whitespace-nowrap">
                      <div className="text-lg font-semibold leading-none">{fmtDur(r.grading_med_min)}</div>
                      <div className="text-[11px] text-muted-foreground mt-1">
                        {r.graded} ta baholandi
                        {r.ungraded_backlog > 0 && <span className="text-amber-600 dark:text-amber-400"> · {r.ungraded_backlog} navbatda</span>}
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="text-xs whitespace-nowrap mb-1">
                        <span className="font-semibold">{r.active_days}/{r.days_window}</span> kun · <span className="font-semibold">{r.week_hours}h</span>
                      </div>
                      <div className="flex items-end gap-0.5">
                        {labels.map((lbl, i) => {
                          const h = hours[i] ?? 0;
                          return (
                            <div key={i} className="flex flex-col items-center gap-0.5">
                              <div className={`w-5 h-5 rounded-sm flex items-center justify-center text-[10px] font-medium ${hourCellCls(h)}`} title={`${lbl}: ${h} soat`}>
                                {h > 0 ? h : ""}
                              </div>
                              <div className="text-[8px] text-muted-foreground leading-none">{lbl}</div>
                            </div>
                          );
                        })}
                      </div>
                    </TableCell>
                    <TableCell className="align-top whitespace-nowrap">
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
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>

        <div className="text-xs text-muted-foreground space-y-1">
          <p><b>Holat</b> — "Baholaydi" = uy ishlarini tekshiradi, lekin guruh chatida yozmaydi; "Chatda faol" = chatda ham bor; "Faol emas" = 7 kunda baholamagan ham, chatda ham yo'q.</p>
          <p><b>Baholash (asosiy ish)</b> — uy ishini o'rtacha qancha vaqtda baholaydi · nechta baholadi · nechtasi navbatda. Ko'p o'qituvchining asosiy ishi shu.</p>
          <p><b>Guruh chatida</b> — 7 kunda nechta kun va har kuni necha soat guruhda faol bo'lgan. O'qituvchining <b>anonim</b> (guruh nomidan / guruh rasmi bilan) javoblari ham hisobga olinadi — barcha mavzular va umumiy chat. Shaxsiy DM hisobga olinmaydi.</p>
          <p><b>Savollarga javob</b> — o'quvchi o'qituvchini belgilagan (@), unga javob bergan yoki "ustoz" degan savollardan nechtasiga javob berilgan. Bugundan to'planadi.</p>
        </div>
      </div>
    </PageShell>
  );
}
