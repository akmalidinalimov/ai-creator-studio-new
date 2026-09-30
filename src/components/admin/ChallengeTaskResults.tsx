import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RefreshCw } from "lucide-react";
import { reportClientError } from "@/lib/beacon";
import { impersonatingReadonly } from "@/lib/mutate";
import { prettyDate, type GroupLite, type TaskRow } from "@/components/admin/challengeTasksShared";

/**
 * «Natijalar» — the admin results tab of /admin/challenge/tasks (Daily Tasks PR-7, spec §12). Every submission for a
 * task, by group (admin_challenge_task_results), and the audited override (admin_challenge_task_override: accept /
 * reject {reason} / move {task_id} / withdraw / restore — each call writes 'challenge_task_admin_override'). The
 * engine re-settles points and queues the receipt edit; this page only asks it.
 */

type ResultSub = {
  id: number;
  user_id: string;
  name: string | null;
  group_id: string | null;
  group: string | null;
  status: string;
  reason: string | null;
  missing: string[] | null;
  hold_reason: string | null;
  points: number | null;
  late_days: number | null;
  submitted_at: string | null;
  attributed_via: string | null;
  source: string | null;
  moved_count: number | null;
  items: number | null;
};

const SUB_STATUS_UZ: Record<string, string> = {
  needs_more: "To‘liq emas", checking: "Tekshirilmoqda", accepted: "Qabul qilindi", rejected: "Rad etildi",
  withdrawn: "Chiqarilgan", merged: "Birlashtirilgan", voided: "Bekor (void)", expired: "Muddati o‘tgan",
};
const SUB_STATUS_CLASS: Record<string, string> = {
  accepted: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  checking: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  needs_more: "bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30",
  rejected: "bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/30",
};
const VIA_UZ: Record<string, string> = {
  today: "bugun", missed: "o‘tkazilgan kun", reply_to_post: "postga javob", ig_link: "IG havola", burst: "ketma-ket",
  fixup: "to‘ldirish", miniapp: "ilova", moved: "ko‘chirilgan", admin: "admin",
};
const OVERRIDE_REASON_UZ: Record<string, string> = {
  not_found: "Topshiriq topilmadi.", slot_taken: "Bu o‘quvchida shu vazifa uchun boshqa jonli topshiriq bor.",
  bad_action: "Noma’lum amal.", not_movable: "Bu holatdagi topshiriqni ko‘chirib bo‘lmaydi.", bad_target: "Maqsad vazifa noto‘g‘ri.",
  same_task: "Topshiriq allaqachon shu vazifada.", future_task: "Kelajakdagi vazifaga ko‘chirib bo‘lmaydi.",
  closed: "Kechikish oynasidan tashqarida.", too_many_moves: "Ko‘chirishlar soni tugagan.", attempts_exhausted: "Urinishlar tugagan.",
  not_withdrawable: "Bu holatdagi topshiriqni chiqarib bo‘lmaydi.", not_withdrawn: "Topshiriq chiqarilmagan.",
};

type Op = "accept" | "reject" | "move" | "withdraw" | "restore";
const OP_UZ: Record<Op, string> = { accept: "Qabul qilish", reject: "Rad etish", move: "Ko‘chirish", withdraw: "Hisobdan chiqarish", restore: "Qaytarish" };

const tashTime = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(Date.parse(iso) + 5 * 3_600_000);
  return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

export function ChallengeTaskResults({ tasks, groups, today }: { tasks: TaskRow[]; groups: GroupLite[]; today: string }) {
  const approved = useMemo(() => tasks.filter((t) => t.status === "approved").sort((a, b) => b.task_date.localeCompare(a.task_date)), [tasks]);
  const defaultTask = approved.find((t) => t.task_date <= today) ?? approved[approved.length - 1] ?? null;
  const [taskId, setTaskId] = useState<number | null>(defaultTask?.id ?? null);
  const [subs, setSubs] = useState<ResultSub[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ sub: ResultSub; op: Op } | null>(null);
  const [reason, setReason] = useState("");
  const [moveTo, setMoveTo] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (taskId === null && defaultTask) setTaskId(defaultTask.id); }, [taskId, defaultTask]);

  const load = useCallback(async () => {
    if (taskId === null) return;
    setSubs(null);
    setErr(null);
    const { data, error } = await supabase.rpc("admin_challenge_task_results" as never, { _task_id: taskId } as never);
    if (error) {
      const missing = error.code === "PGRST202" || /could not find the function/i.test(error.message ?? "");
      setErr(missing ? "Natijalar funksiyasi hali bazada yo‘q (PR-3 migratsiyasi)." : `Yuklab bo‘lmadi: ${error.message}`);
      if (!missing) reportClientError({ type: "other", message: "admin_daily_task_results_failed", extra: { code: error.code ?? null } });
      setSubs([]);
      return;
    }
    const d = (data ?? {}) as { submissions?: ResultSub[] };
    setSubs(Array.isArray(d.submissions) ? d.submissions : []);
  }, [taskId]);

  useEffect(() => { void load(); }, [load]);

  const run = async () => {
    if (!dialog || busy || impersonatingReadonly()) return;
    const { sub, op } = dialog;
    const args: Record<string, unknown> = op === "reject" ? { reason: reason.trim() || "admin_override" } : op === "move" ? { task_id: Number(moveTo) } : {};
    if (op === "move" && !Number(moveTo)) { toast.error("Vazifani tanlang"); return; }
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("admin_challenge_task_override" as never, { _sub: sub.id, _action: op, _args: args } as never);
      if (error) {
        toast.error(error.code === "42501" ? "Faqat admin." : `Xato: ${error.message}`);
        reportClientError({ type: "other", message: "admin_daily_task_override_failed", extra: { op, code: error.code ?? null } });
        return;
      }
      const d = (data ?? {}) as { ok?: boolean; reason?: string | null; status?: string };
      if (d.ok === false) {
        toast.error(OVERRIDE_REASON_UZ[String(d.reason)] ?? `Bajarilmadi: ${d.reason ?? "?"}`);
        return;
      }
      toast.success(`${OP_UZ[op]}: bajarildi`);
      setDialog(null);
      setReason("");
      setMoveTo("");
      void load();
    } finally {
      setBusy(false);
    }
  };

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of subs ?? []) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [subs]);
  const byGroup = useMemo(() => {
    const m = new Map<string, { accepted: number; total: number }>();
    for (const s of subs ?? []) {
      const k = s.group ?? "—";
      const v = m.get(k) ?? { accepted: 0, total: 0 };
      v.total++;
      if (s.status === "accepted") v.accepted++;
      m.set(k, v);
    }
    return m;
  }, [subs]);

  const actionsFor = (s: ResultSub): Op[] => {
    if (s.status === "withdrawn") return ["restore"];
    if (["needs_more", "checking", "accepted", "rejected"].includes(s.status)) {
      return [...(s.status !== "accepted" ? ["accept" as Op] : []), ...(s.status !== "rejected" ? ["reject" as Op] : []), "move", "withdraw"];
    }
    return [];
  };

  const current = approved.find((t) => t.id === taskId) ?? null;

  if (approved.length === 0) {
    return <Card className="p-4 text-sm text-muted-foreground">Hali tasdiqlangan vazifa yo‘q.</Card>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={taskId !== null ? String(taskId) : ""} onValueChange={(v) => setTaskId(Number(v))}>
          <SelectTrigger className="w-[360px] max-w-full"><SelectValue placeholder="Vazifa" /></SelectTrigger>
          <SelectContent>
            {approved.map((t) => (
              <SelectItem key={t.id} value={String(t.id)}>{prettyDate(t.task_date)} — {t.type === "instagram" ? "📸 " : ""}{t.title}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => void load()}><RefreshCw className="h-4 w-4" /></Button>
      </div>

      {err && <Card className="p-3 text-sm text-rose-600">{err}</Card>}

      {subs && current && (
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge variant="outline">Jami: {subs.length}</Badge>
          {Object.entries(counts).map(([k, n]) => <Badge key={k} variant="outline">{SUB_STATUS_UZ[k] ?? k}: {n}</Badge>)}
          {[...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([g, v]) => (
            <Badge key={g} variant="secondary">{g}: {v.accepted}/{v.total} ✓</Badge>
          ))}
          <Badge variant="outline">«Kunlik vazifalar» topikli guruhlar: {groups.filter((g) => g.daily_task_topic_id).length}</Badge>
        </div>
      )}

      <Card className="p-0 overflow-x-auto shadow-soft">
        {subs === null ? (
          <p className="p-4 text-sm text-muted-foreground">Yuklanmoqda…</p>
        ) : subs.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Bu vazifa uchun hali topshiriq yo‘q.</p>
        ) : (
          <table className="w-full text-sm min-w-[860px]">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="text-left px-3 py-2 font-medium">O‘quvchi</th>
                <th className="text-left px-3 py-2 font-medium">Guruh</th>
                <th className="text-left px-3 py-2 font-medium">Holat</th>
                <th className="text-right px-3 py-2 font-medium">Ball</th>
                <th className="text-left px-3 py-2 font-medium">Qachon</th>
                <th className="text-left px-3 py-2 font-medium">Qanday</th>
                <th className="text-left px-3 py-2 font-medium">Izoh</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {subs.map((s) => (
                <tr key={s.id} className="border-t align-top">
                  <td className="px-3 py-2">{s.name || s.user_id.slice(0, 8)}</td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">{s.group ?? "—"}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded border px-1.5 py-px text-[11px] ${SUB_STATUS_CLASS[s.status] ?? "bg-muted text-muted-foreground border-border"}`}>
                      {SUB_STATUS_UZ[s.status] ?? s.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{s.points ?? 0}</td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap">
                    {tashTime(s.submitted_at)}{s.late_days ? <span className="text-amber-600"> · +{s.late_days} kun</span> : null}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {s.source === "miniapp" ? "📱 " : ""}{VIA_UZ[String(s.attributed_via)] ?? s.attributed_via ?? "—"} · {s.items ?? 0} ta
                    {s.moved_count ? ` · ko‘chirilgan ${s.moved_count}×` : ""}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground max-w-[220px]">
                    {[s.reason, s.hold_reason, (s.missing ?? []).length ? `yetishmaydi: ${(s.missing ?? []).join(", ")}` : null].filter(Boolean).join(" · ") || "—"}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {actionsFor(s).map((op) => (
                      <Button key={op} variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => { setDialog({ sub: s, op }); setReason(""); setMoveTo(""); }}>
                        {OP_UZ[op]}
                      </Button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <p className="text-[11px] text-muted-foreground">
        Har bir o‘zgartirish admin_actions’ga «challenge_task_admin_override» bo‘lib yoziladi; ball va guruhdagi javob xabari avtomatik yangilanadi.
      </p>

      <Dialog open={!!dialog} onOpenChange={(v) => { if (!v) setDialog(null); }}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{dialog ? `${OP_UZ[dialog.op]} — ${dialog.sub.name ?? ""}` : ""}</DialogTitle>
          </DialogHeader>
          {dialog?.op === "reject" && (
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Sabab (ixtiyoriy, audit uchun)" maxLength={200} />
          )}
          {dialog?.op === "move" && (
            <Select value={moveTo} onValueChange={setMoveTo}>
              <SelectTrigger><SelectValue placeholder="Qaysi vazifaga" /></SelectTrigger>
              <SelectContent>
                {approved.filter((t) => t.id !== taskId).map((t) => (
                  <SelectItem key={t.id} value={String(t.id)}>{prettyDate(t.task_date)} — {t.title}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {dialog && ["accept", "withdraw", "restore"].includes(dialog.op) && (
            <p className="text-sm text-muted-foreground">Tasdiqlaysizmi? Ball qayta hisoblanadi.</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>Bekor</Button>
            <Button onClick={() => void run()} disabled={busy}>{dialog ? OP_UZ[dialog.op] : ""}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
