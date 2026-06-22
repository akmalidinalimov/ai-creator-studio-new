import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowUpDown, MessageSquare, Clock, GraduationCap, AlertTriangle } from "lucide-react";

type Row = {
  teacher_id: string;
  name: string;
  telegram_username: string | null;
  groups_taught: number;
  students: number;
  active_days: number;
  days_off: number;
  avg_active_hours: number;
  last_active: string | null;
  msgs_sent: number;
  questions: number;
  answered_in_sla: number;
  response_rate: number | null;
  wait_med_min: number | null;
  unanswered: number;
  graded: number;
  grading_med_min: number | null;
  ungraded_backlog: number;
};

/** minutes → human duration */
function fmtDur(min: number | null | undefined): string {
  if (min == null) return "—";
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 1440) return `${(min / 60).toFixed(1)}h`;
  return `${(min / 1440).toFixed(1)}d`;
}

/** Composite traffic-light: grading speed + backlog + presence. */
function health(r: Row): "good" | "ok" | "bad" {
  const g = r.grading_med_min;
  const gradingBad = g != null && g > 72 * 60; // > 3 days
  const gradingGood = g != null && g <= 24 * 60; // <= 1 day
  const backlogBad = r.ungraded_backlog >= 5;
  const denom = r.active_days + r.days_off;
  const lowPresence = denom > 0 && r.active_days / denom < 0.2;
  if (gradingBad || backlogBad || lowPresence) return "bad";
  if (gradingGood && !backlogBad && !lowPresence) return "good";
  return "ok";
}
const HEALTH_CLS: Record<string, string> = {
  good: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  ok: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  bad: "bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/30",
};
const HEALTH_LBL: Record<string, string> = { good: "Yaxshi", ok: "O'rtacha", bad: "E'tibor kerak" };

type SortKey = keyof Row | "health";

export default function AdminTeacherStats() {
  const [days, setDays] = useState(30);
  const [slaMin, setSlaMin] = useState(120);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("grading_med_min");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [detail, setDetail] = useState<Row | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true); setErr(null);
    const { data, error } = await supabase.rpc("admin_teacher_stats" as any, { p_days: days, p_sla_min: slaMin });
    if (error) setErr(error.message || "Ma'lumotni yuklab bo'lmadi");
    else setRows(((data as any[]) || []) as Row[]);
    setLoading(false);
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [days, slaMin]);

  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      let av: any, bv: any;
      if (sortKey === "health") { av = health(a); bv = health(b); }
      else { av = a[sortKey]; bv = b[sortKey]; }
      if (av == null) av = sortDir === "asc" ? Infinity : -Infinity;
      if (bv == null) bv = sortDir === "asc" ? Infinity : -Infinity;
      if (typeof av === "string") return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return arr;
  }, [rows, sortKey, sortDir]);

  const setSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "name" ? "asc" : "desc"); }
  };

  // summary tiles
  const summary = useMemo(() => {
    const n = rows.length;
    const gradeVals = rows.map((r) => r.grading_med_min).filter((x): x is number => x != null);
    const medGrade = gradeVals.length ? gradeVals.sort((a, b) => a - b)[Math.floor(gradeVals.length / 2)] : null;
    const backlog = rows.reduce((s, r) => s + (r.ungraded_backlog || 0), 0);
    const unanswered = rows.reduce((s, r) => s + (r.unanswered || 0), 0);
    return { n, medGrade, backlog, unanswered };
  }, [rows]);

  const Th = ({ k, label, className }: { k: SortKey; label: string; className?: string }) => (
    <TableHead className={`cursor-pointer select-none whitespace-nowrap ${className || ""}`} onClick={() => setSort(k)}>
      <span className="inline-flex items-center gap-1">{label}{sortKey === k && <ArrowUpDown className="h-3 w-3" />}</span>
    </TableHead>
  );

  return (
    <PageShell>
      <div className="space-y-6">
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2"><GraduationCap className="h-6 w-6" /> Teacher Statistics</h1>
            <p className="text-sm text-muted-foreground">O'qituvchilarni adolatli baholash uchun: javob berish tezligi, baholash, faollik.</p>
          </div>
          <div className="flex items-center gap-2">
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
              <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="7">So'nggi 7 kun</SelectItem>
                <SelectItem value="30">So'nggi 30 kun</SelectItem>
                <SelectItem value="90">So'nggi 90 kun</SelectItem>
              </SelectContent>
            </Select>
            <Select value={String(slaMin)} onValueChange={(v) => setSlaMin(Number(v))}>
              <SelectTrigger className="w-[150px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="120">Javob SLA: 2 soat</SelectItem>
                <SelectItem value="360">Javob SLA: 6 soat</SelectItem>
                <SelectItem value="1440">Javob SLA: 24 soat</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="p-4"><div className="text-xs text-muted-foreground">O'qituvchilar</div><div className="text-2xl font-semibold">{summary.n}</div></Card>
          <Card className="p-4"><div className="text-xs text-muted-foreground">Median baholash vaqti</div><div className="text-2xl font-semibold">{fmtDur(summary.medGrade)}</div></Card>
          <Card className="p-4"><div className="text-xs text-muted-foreground">Baholanmagan (jami)</div><div className="text-2xl font-semibold">{summary.backlog}</div></Card>
          <Card className="p-4"><div className="text-xs text-muted-foreground">SLA: javobsiz xabarlar</div><div className="text-2xl font-semibold">{summary.unanswered}</div></Card>
        </div>

        {err && (
          <div className="rounded border border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-400 text-sm p-3">
            ⚠️ {err}
            <button className="underline ml-2" onClick={reload}>Qayta urinish</button>
          </div>
        )}

        <Card className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <Th k="name" label="O'qituvchi" />
                <Th k="health" label="Holat" />
                <Th k="active_days" label="Faol kun" />
                <Th k="avg_active_hours" label="Soat/kun" />
                <Th k="grading_med_min" label="Baholash vaqti" />
                <Th k="graded" label="Baholandi" />
                <Th k="ungraded_backlog" label="Navbatda" />
                <Th k="msgs_sent" label="Guruh javoblari" />
                <Th k="response_rate" label="Javob %" />
                <Th k="wait_med_min" label="Kutish (med)" />
                <Th k="students" label="Talaba" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow><TableCell colSpan={11} className="text-center text-muted-foreground py-8">Yuklanmoqda…</TableCell></TableRow>
              ) : sorted.length === 0 ? (
                <TableRow><TableCell colSpan={11} className="text-center text-muted-foreground py-8">O'qituvchilar topilmadi.</TableCell></TableRow>
              ) : sorted.map((r) => {
                const h = health(r);
                return (
                  <TableRow key={r.teacher_id} className="cursor-pointer hover:bg-muted/40" onClick={() => setDetail(r)}>
                    <TableCell className="font-medium whitespace-nowrap">
                      {r.name}
                      {r.telegram_username && <span className="block text-[11px] text-muted-foreground">@{r.telegram_username}</span>}
                    </TableCell>
                    <TableCell><Badge variant="outline" className={`text-[11px] ${HEALTH_CLS[h]}`}>{HEALTH_LBL[h]}</Badge></TableCell>
                    <TableCell className="whitespace-nowrap">{r.active_days}<span className="text-muted-foreground text-xs"> / {r.days_off} dam</span></TableCell>
                    <TableCell>{r.avg_active_hours || 0}</TableCell>
                    <TableCell className="whitespace-nowrap">{fmtDur(r.grading_med_min)}</TableCell>
                    <TableCell>{r.graded}</TableCell>
                    <TableCell>{r.ungraded_backlog > 0 ? <Badge variant="outline" className="text-[11px] bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30">{r.ungraded_backlog}</Badge> : <span className="text-muted-foreground">0</span>}</TableCell>
                    <TableCell>{r.msgs_sent}</TableCell>
                    <TableCell>{r.response_rate != null ? `${r.response_rate}%` : <span className="text-muted-foreground">—</span>}</TableCell>
                    <TableCell className="whitespace-nowrap">{fmtDur(r.wait_med_min)}</TableCell>
                    <TableCell>{r.students}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>

        <p className="text-xs text-muted-foreground">
          ℹ️ Eng ishonchli baho — <b>baholash vaqti, hajmi va navbat</b> (har bir o'qituvchi uchun aniq).
          "Guruh javoblari / Javob % / Kutish" — <b>muhokama mavzularidagi</b> o'quvchi xabarlari bo'yicha
          (vazifa mavzulari chiqarib tashlanadi); javob = o'qituvchi/adminning o'sha mavzudagi keyingi xabari.
          Bu chatdagi faollik o'lchovi — har bir xabar savol bo'lmasligi mumkin, shuning uchun past "Javob %"
          ko'pincha o'qituvchi guruh chatida deyarli yozmasligini bildiradi (u baholash bilan shug'ullanadi).
          "Soat/kun" — faol soatlar (taxminiy, ish vaqti emas).
        </p>
      </div>

      {detail && <TeacherDetailDialog row={detail} days={days} slaMin={slaMin} onClose={() => setDetail(null)} />}
    </PageShell>
  );
}

/* ---------------- Detail dialog ---------------- */
type DayRow = { day: string; group_msgs: number; graded: number; logins: number };
type Unanswered = { group_name: string; student_name: string; asked_at: string; waited_min: number; answered: boolean };
type GroupRow = { group_id: string; group_name: string; students: number; questions: number; answered_in_sla: number; response_rate: number | null; wait_med_min: number | null; graded: number; ungraded: number };

function TeacherDetailDialog({ row, days, slaMin, onClose }: { row: Row; days: number; slaMin: number; onClose: () => void }) {
  const [daily, setDaily] = useState<DayRow[]>([]);
  const [unans, setUnans] = useState<Unanswered[]>([]);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [derr, setDerr] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true); setDerr(false);
      try {
        const [d, u, g] = await Promise.all([
          supabase.rpc("admin_teacher_activity_daily" as any, { p_teacher_id: row.teacher_id, p_days: days }),
          supabase.rpc("admin_teacher_unanswered" as any, { p_teacher_id: row.teacher_id, p_days: days, p_sla_min: slaMin }),
          supabase.rpc("admin_teacher_groups" as any, { p_teacher_id: row.teacher_id, p_days: days, p_sla_min: slaMin }),
        ]);
        if (d.error || u.error || g.error) { setDerr(true); return; }
        setDaily(((d.data as any[]) || []) as DayRow[]);
        setUnans(((u.data as any[]) || []) as Unanswered[]);
        setGroups(((g.data as any[]) || []) as GroupRow[]);
      } catch {
        setDerr(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [row.teacher_id, days, slaMin]);

  const maxAct = Math.max(1, ...daily.map((d) => d.group_msgs + d.graded + d.logins));
  const cellCls = (v: number) => {
    if (v === 0) return "bg-muted";
    const lvl = v / maxAct;
    return lvl < 0.25 ? "bg-primary/20" : lvl < 0.5 ? "bg-primary/40" : lvl < 0.75 ? "bg-primary/70" : "bg-primary";
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><GraduationCap className="h-5 w-5" /> {row.name}</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
          <Card className="p-3"><div className="text-[11px] text-muted-foreground flex items-center gap-1"><Clock className="h-3 w-3" />Baholash (med)</div><div className="text-lg font-semibold">{fmtDur(row.grading_med_min)}</div></Card>
          <Card className="p-3"><div className="text-[11px] text-muted-foreground flex items-center gap-1"><MessageSquare className="h-3 w-3" />Guruh javoblari</div><div className="text-lg font-semibold">{row.msgs_sent}</div></Card>
          <Card className="p-3"><div className="text-[11px] text-muted-foreground flex items-center gap-1"><Clock className="h-3 w-3" />Kutish (med)</div><div className="text-lg font-semibold">{fmtDur(row.wait_med_min)}</div></Card>
          <Card className="p-3"><div className="text-[11px] text-muted-foreground flex items-center gap-1"><AlertTriangle className="h-3 w-3" />Navbatda</div><div className="text-lg font-semibold">{row.ungraded_backlog}</div></Card>
        </div>

        {loading ? <p className="text-sm text-muted-foreground py-4">Yuklanmoqda…</p> : derr ? (
          <p className="text-sm text-rose-600 dark:text-rose-400 py-4">⚠️ Ma'lumotni yuklab bo'lmadi. Dialogni yopib qayta oching.</p>
        ) : (
          <>
            {/* Activity heatmap */}
            <div>
              <div className="font-semibold text-sm mb-2">Faollik ({days} kun) — guruh xabarlari, baholash, kirishlar</div>
              <div className="flex flex-wrap gap-0.5">
                {daily.map((d) => {
                  const v = d.group_msgs + d.graded + d.logins;
                  return <div key={d.day} title={`${d.day}: ${d.group_msgs} xabar · ${d.graded} baho · ${d.logins} kirish`} className={`h-4 w-4 rounded-sm ${cellCls(v)}`} />;
                })}
              </div>
            </div>

            {/* Per-group breakdown */}
            <div>
              <div className="font-semibold text-sm mb-2">Guruhlar bo'yicha</div>
              <div className="overflow-x-auto border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Guruh</TableHead>
                      <TableHead>Talaba</TableHead>
                      <TableHead>Xabarlar</TableHead>
                      <TableHead>Javob %</TableHead>
                      <TableHead>Kutish (med)</TableHead>
                      <TableHead>Baholandi</TableHead>
                      <TableHead>Navbatda</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {groups.length === 0 ? <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-4">Guruh yo'q.</TableCell></TableRow>
                    : groups.map((g) => (
                      <TableRow key={g.group_id}>
                        <TableCell className="font-medium">{g.group_name}</TableCell>
                        <TableCell>{g.students}</TableCell>
                        <TableCell>{g.questions}</TableCell>
                        <TableCell>{g.response_rate != null ? `${g.response_rate}%` : "—"}</TableCell>
                        <TableCell>{fmtDur(g.wait_med_min)}</TableCell>
                        <TableCell>{g.graded}</TableCell>
                        <TableCell>{g.ungraded}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>

            {/* Unanswered questions */}
            <div>
              <div className="font-semibold text-sm mb-2">Staff javob bermagan o'quvchi xabarlari · SLA ({unans.length}{unans.length >= 100 ? "+ (birinchi 100)" : ""})</div>
              {unans.length === 0 ? <p className="text-sm text-muted-foreground">Barcha xabarlarga o'z vaqtida javob berilgan 🎉</p> : (
                <div className="max-h-72 overflow-y-auto border rounded-md divide-y">
                  {unans.map((u, i) => (
                    <div key={i} className="p-2 text-sm flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate"><span className="font-medium">{u.student_name}</span> <span className="text-muted-foreground">· {u.group_name}</span></div>
                        <div className="text-xs text-muted-foreground">{new Date(u.asked_at).toLocaleString()}</div>
                      </div>
                      <Badge variant="outline" className={`text-[11px] shrink-0 ${u.answered ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30" : "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/30"}`}>
                        {u.answered ? `kech: ${fmtDur(u.waited_min)}` : `javobsiz · ${fmtDur(u.waited_min)}`}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
