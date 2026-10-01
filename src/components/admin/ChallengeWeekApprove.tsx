import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { IMPERSONATION_RE } from "@/lib/mutate";
import { prettyDate } from "@/components/admin/challengeTasksShared";
import { approveErrorMessage, approveSummary, parseApproveResult, type WeekApproveResult } from "@/lib/weekApproval";

/**
 * «✅ Haftani tasdiqlash» for one week of the calendar's week list (Daily Tasks PR-9). The same RPC as the bot's button
 * (challenge_tasks_approve_week, as the signed-in admin): every draft of the week dated TODAY or later goes through the
 * approve guard one by one; the ones it refuses stay drafts and are listed here with the guard's own reason. Past days
 * are never approved from here (never posted -> a miss in every streak): `drafts` counts today-and-later drafts only,
 * the button hides when none is left, and past drafts the RPC skipped are listed apart. Confirm step first.
 */
export function ChallengeWeekApprove({ weekStart, courseId, drafts, pastDrafts = 0, onDone }: {
  weekStart: string;
  courseId: string;
  /** drafts dated today or later: what the button approves */
  drafts: number;
  /** drafts of days already gone: never approved from here (only mentioned) */
  pastDrafts?: number;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WeekApproveResult | null>(null);

  const run = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("challenge_tasks_approve_week", { _week_start: weekStart, _course_id: courseId });
      if (error) {
        if (!IMPERSONATION_RE.test(error.message ?? "")) toast.error(approveErrorMessage(error.message));
        return;
      }
      const r = parseApproveResult(data);
      if (!r) {
        toast.error("Tasdiqlab bo‘lmadi — javob noto‘g‘ri");
        return;
      }
      setResult(r);
      if (r.failed.length > 0) toast.warning(approveSummary(r));
      else if (r.approved === 0 && (r.skippedPast.length > 0 || r.pastWeek)) toast.info(approveSummary(r));
      else toast.success(approveSummary(r));
      onDone();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!IMPERSONATION_RE.test(msg)) toast.error(approveErrorMessage(msg));
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <>
      {drafts > 0 && (
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={busy} onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
          ✅ Haftani tasdiqlash ({drafts})
        </Button>
      )}
      {drafts === 0 && pastDrafts > 0 && (
        <span className="text-[11px] text-muted-foreground" title="O‘tgan kun guruhlarga chiqmagan — keyin tasdiqlansa, o‘quvchilarning seriyasi buziladi">
          ⌛ O‘tgan kunlar ({pastDrafts} ta qoralama) — faqat kunni alohida (retro) tasdiqlash mumkin
        </span>
      )}
      {result && result.failed.length > 0 && (
        <div className="w-full mt-2 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-400"
          role="alert">
          <b>Tasdiqlanmadi ({result.failed.length}):</b>
          <ul className="mt-1 space-y-0.5">
            {result.failed.map((f, i) => (
              <li key={`${f.task_id ?? i}`}>
                {f.date ? prettyDate(f.date) : "?"} — «{f.title ?? ""}»: {f.error ?? "xato"}
              </li>
            ))}
          </ul>
        </div>
      )}
      {result && result.skippedPast.length > 0 && (
        <div className="w-full mt-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-400"
          role="status">
          <b>⌛ O‘tgan kun — tasdiqlanmadi ({result.skippedPast.length}):</b>
          <ul className="mt-1 space-y-0.5">
            {result.skippedPast.map((f, i) => (
              <li key={`${f.task_id ?? i}`}>{f.date ? prettyDate(f.date) : "?"} — «{f.title ?? ""}»</li>
            ))}
          </ul>
          <p className="mt-1">Guruhlarga chiqmagan kun keyin tasdiqlansa, seriyalar buziladi. Kerak bo‘lsa — kunni ochib, alohida (retro) tasdiqlang.</p>
        </div>
      )}
      <AlertDialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{drafts} ta qoralama tasdiqlansinmi?</AlertDialogTitle>
            <AlertDialogDescription>
              {prettyDate(weekStart)} haftasi. Har biri tekshiriladi (sana, format, e’lon uzunligi); o‘tmaganlari qoralama bo‘lib
              qoladi va sababi ko‘rsatiladi. Tasdiqlangan vazifa o‘z kunida guruhlarga e’lon qilinadi.
              {pastDrafts > 0 && ` O‘tgan kunlardagi ${pastDrafts} ta qoralama kiritilmaydi (ular guruhlarga chiqmagan).`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Bekor</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={(e) => { e.preventDefault(); void run(); }}>
              Ha, tasdiqlash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
