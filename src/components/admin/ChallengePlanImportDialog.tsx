import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { impersonatingReadonly } from "@/lib/mutate";
import {
  addDays, buildImportRows, isIsoDate, parsePlan, requiresSummary, tashkentToday, textOnlySatisfiable, WEEKDAY_SHORT_UZ,
  type CalendarConfig,
} from "@/lib/dailyTasksPlan";
import { prettyDate } from "@/components/admin/challengeTasksShared";
import { toast } from "sonner";
import { Upload } from "lucide-react";

type Existing = { task_date: string; status: string; plan_ref: string | null };

/**
 * «Rejani import qilish»: paste or upload the plan JSON (weeks[].tasks[]), pick the first date and the weekdays,
 * review what each task will require, and create DRAFTS through admin_challenge_tasks_import. Nothing is approved
 * here; a task already in the calendar (same plan_ref) is skipped, and taken dates are jumped over.
 */
export function ChallengePlanImportDialog({
  open, onOpenChange, courseId, courseTitle, cfg, existing, onImported,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  courseId: string;
  courseTitle: string;
  cfg: CalendarConfig;
  existing: Existing[];
  onImported: () => void;
}) {
  const [raw, setRaw] = useState("");
  const [start, setStart] = useState("");
  const [weekdays, setWeekdays] = useState<number[]>(cfg.weekdays);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Default: the challenge's first day. Days staff already posted by hand are entered as 'retro' afterwards, so
    // the plan keeps its order from day 1.
    setStart(cfg.windowStart ?? addDays(tashkentToday(), 1));
    setWeekdays(cfg.weekdays);
  }, [open, cfg.windowStart, cfg.weekdays]);

  const parsed = useMemo(() => (raw.trim() ? parsePlan(raw) : { tasks: [], errors: [] }), [raw]);
  const live = useMemo(() => existing.filter((e) => e.status !== "cancelled"), [existing]);
  const occupied = useMemo(() => new Set(live.map((e) => e.task_date)), [live]);
  const refs = useMemo(() => new Set(live.map((e) => e.plan_ref).filter((r): r is string => !!r)), [live]);
  const rows = useMemo(
    () => (isIsoDate(start) ? buildImportRows(parsed.tasks, {
      startDate: start, weekdays, occupiedDates: occupied, existingRefs: refs, defaultPoints: cfg.defaultPoints,
    }) : []),
    [parsed.tasks, start, weekdays, occupied, refs, cfg.defaultPoints],
  );
  const toCreate = rows.filter((r) => r.status === "new");
  const errors = rows.filter((r) => r.status === "error");
  const sameWeekdays = [...weekdays].sort().join(",") === [...cfg.weekdays].sort().join(",");
  const firstWeek = isIsoDate(start) ? addDays(start, 6) : "";
  const heldEarly = toCreate.filter((r) => r.date && r.date <= firstWeek &&
    (r.task.type === "instagram" || textOnlySatisfiable(r.derived.requires)));
  const beforeWindow = cfg.windowStart && isIsoDate(start) && start < cfg.windowStart;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 2_000_000) { toast.error("Fayl juda katta (2 MB dan ko‘p)"); return; }
    setRaw(await file.text());
  };

  const run = async () => {
    if (impersonatingReadonly()) return; // expected read-only no-op while previewing as a student
    if (errors.length > 0 || toCreate.length === 0) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("admin_challenge_tasks_import", {
        _course_id: courseId, _items: toCreate.map((r) => r.item) as unknown as Json,
      });
      if (error) { toast.error(error.message); return; }
      const d = (data ?? {}) as { created?: number; skipped?: unknown[] };
      const skipped = Array.isArray(d.skipped) ? d.skipped.length : 0;
      toast.success(`${d.created ?? 0} ta qoralama yaratildi${skipped ? `, ${skipped} ta o‘tkazib yuborildi` : ""}. Har birini ko‘rib chiqib tasdiqlang.`);
      setRaw("");
      onImported();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Rejani import qilish — {courseTitle}</DialogTitle>
          <DialogDescription>
            Reja JSON’ini (weeks[].tasks[]: title_uz, task_uz, learn_uz, submit_uz, type, points, format, auto_check, minutes) joylang yoki
            faylni yuklang. Hammasi QORALAMA bo‘lib tushadi — har birining «nima yuborilishi shart» qismini ko‘rib chiqib, keyin tasdiqlaysiz.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-2 text-sm cursor-pointer rounded-md border px-3 py-1.5 hover:bg-muted">
              <Upload className="h-4 w-4" /> JSON fayl
              <input type="file" accept=".json,application/json" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
            </label>
            {parsed.tasks.length > 0 && <span className="text-xs text-muted-foreground">{parsed.tasks.length} ta vazifa o‘qildi</span>}
          </div>
          <Textarea rows={5} value={raw} onChange={(e) => setRaw(e.target.value)} placeholder='{"weeks":[{"week":1,"tasks":[...]}]}'
            className="font-mono text-xs" />
          {parsed.errors.length > 0 && (
            <ul className="text-xs text-rose-600 list-disc pl-5">{parsed.errors.slice(0, 8).map((e, i) => <li key={i}>{e}</li>)}</ul>
          )}

          <div className="flex flex-wrap items-end gap-4">
            <div>
              <Label className="text-xs">Birinchi vazifa sanasi</Label>
              <Input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="w-[170px]" />
            </div>
            <div>
              <Label className="text-xs">Vazifa kunlari</Label>
              <div className="flex gap-2 mt-1">
                {WEEKDAY_SHORT_UZ.map((w, i) => (
                  <label key={w} className="flex items-center gap-1 text-xs">
                    <Checkbox checked={weekdays.includes(i + 1)}
                      onCheckedChange={(v) => setWeekdays((prev) => (v === true ? [...prev, i + 1] : prev.filter((d) => d !== i + 1)).sort())} />
                    {w}
                  </label>
                ))}
              </div>
            </div>
          </div>
          {!sameWeekdays && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Tanlangan kunlar sozlamadagi vazifa kunlaridan ({cfg.weekdays.map((d) => WEEKDAY_SHORT_UZ[d - 1]).join(", ")}) farq qiladi.
              Dam olish kunlari va «ertangi vazifa yo‘q» ogohlantirishlari sozlamaga qarab ishlaydi (platform_settings.challenge_tasks.task_weekdays).
            </p>
          )}
          {beforeWindow && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Boshlanish sanasi challenge oynasidan ({cfg.windowStart}) oldin — bu kunlardagi vazifalarni tasdiqlab bo‘lmaydi.
            </p>
          )}
          {heldEarly.length > 0 && !cfg.ai && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Birinchi 7 kunda {heldEarly.length} ta Instagram yoki faqat matn bilan bajariladigan vazifa bor ({heldEarly.map((r) => r.ref).join(", ")}).
              AI tekshiruvi (ai) yoqilmaguncha bunday ishlar «tekshiruvda» ushlab turiladi, ball keyin qo‘shiladi.
            </p>
          )}

          {rows.length > 0 && (
            <div className="rounded-md border overflow-x-auto">
              <table className="w-full text-xs min-w-[760px]">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="text-left px-2 py-1.5">Reja</th>
                    <th className="text-left px-2 py-1.5">Sana</th>
                    <th className="text-left px-2 py-1.5">Turi</th>
                    <th className="text-left px-2 py-1.5">Sarlavha</th>
                    <th className="text-left px-2 py-1.5">Format → nima shart</th>
                    <th className="text-left px-2 py-1.5">Holat</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.ref} className={`border-t align-top ${r.status === "exists" ? "opacity-50" : ""}`}>
                      <td className="px-2 py-1.5 font-mono">{r.ref}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{r.date ? prettyDate(r.date) : "—"}</td>
                      <td className="px-2 py-1.5">{r.task.type === "instagram" ? "📸 IG" : "📝"}</td>
                      <td className="px-2 py-1.5">{r.task.title_uz}</td>
                      <td className="px-2 py-1.5">
                        <div className="text-muted-foreground">«{r.task.format}»</div>
                        <div>{r.derived.error ? "—" : requiresSummary(r.derived.requires)}</div>
                        {r.derived.flags.filter((fl) => fl.kind !== "note").map((fl, i) => (
                          <div key={i} className="text-amber-700 dark:text-amber-400">
                            {fl.kind === "count" ? `«${fl.term}»: minimal son qo‘yilmadi — tasdiqlashdan oldin tekshiring` : fl.text}
                          </div>
                        ))}
                      </td>
                      <td className="px-2 py-1.5">
                        {r.status === "new" && <Badge variant="secondary">qoralama</Badge>}
                        {r.status === "exists" && <Badge variant="outline">kalendarda bor</Badge>}
                        {r.status === "error" && <span className="text-rose-600">{r.problems.join("; ")}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Yopish</Button>
          <Button disabled={busy || errors.length > 0 || toCreate.length === 0 || parsed.errors.length > 0} onClick={run}>
            {toCreate.length} ta qoralama yaratish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
