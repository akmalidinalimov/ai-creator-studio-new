import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { impersonatingReadonly, mutate } from "@/lib/mutate";
import {
  ACCEPT_KINDS, ACCEPT_LABEL_UZ, KIND_LABEL_UZ, LABEL_UZ, LIMITS, MAX_GROUP_MIN, MAX_REQUIRE_GROUPS, POST_MAX_CHARS,
  REQUIRE_KINDS, REQUIRE_LABELS, acceptsFor, deriveFromFormat, parseMessageUrl, requiresProblem, requiresValid,
  taskSaveMessage, telegramHtmlRuns,
  type AcceptKind, type CalendarConfig, type RequireKind, type RequireLabel, type RequiresGroup, type TaskSource, type TaskStatus,
  type TaskType,
} from "@/lib/dailyTasksPlan";
import {
  POST_STATE_UZ, postLink, prettyDate, SOURCE_UZ, STATUS_UZ, type GroupLite, type PostRow, type TaskRow,
} from "@/components/admin/challengeTasksShared";
import { toast } from "sonner";
import { Plus, X, RefreshCw, Link2, Trash2 } from "lucide-react";

type Preview = { text: string; length: number; max: number; day_no: number; points: number; late_points: number; requires_problem: string | null };

type Form = {
  type: TaskType;
  task_date: string;
  title: string;
  body: string;
  learn_line: string;
  submit_hint: string;
  accepts: AcceptKind[];
  requires: RequiresGroup[];
  min_text_chars: string;
  min_duration_sec: string;
  minutes: string;
  points: string;
  check_rubric: string;
  requires_tag: boolean;
  source: TaskSource;
};

const numOrNull = (s: string): number | null => {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

function formFrom(task: TaskRow | null, date: string): Form {
  if (!task) {
    return {
      type: "general", task_date: date, title: "", body: "", learn_line: "", submit_hint: "",
      accepts: ["text", "photo", "document"], requires: [{ any: ["photo", "image_doc"], min: 1, label: "screenshot" }],
      min_text_chars: "", min_duration_sec: "", minutes: "", points: "", check_rubric: "", requires_tag: true, source: "manual",
    };
  }
  const type: TaskType = task.type === "instagram" ? "instagram" : "general";
  return {
    type,
    task_date: task.task_date,
    title: task.title,
    body: task.body,
    learn_line: task.learn_line ?? "",
    submit_hint: task.submit_hint ?? "",
    accepts: ACCEPT_KINDS.filter((k) => task.accepts.includes(k)),
    requires: requiresValid(task.requires) ? (task.requires as RequiresGroup[]) : [],
    min_text_chars: task.min_text_chars?.toString() ?? "",
    min_duration_sec: task.min_duration_sec?.toString() ?? "",
    minutes: task.minutes?.toString() ?? "",
    points: task.points?.toString() ?? "",
    check_rubric: task.check_rubric ?? "",
    requires_tag: task.requires_tag ?? type === "instagram",
    source: (["manual", "import", "ai_draft", "retro"].includes(task.source) ? task.source : "manual") as TaskSource,
  };
}

function payloadOf(f: Form, courseId: string, status: TaskStatus) {
  return {
    course_id: courseId,
    task_date: f.task_date,
    type: f.type,
    title: f.title.trim(),
    body: f.body,
    learn_line: f.learn_line.trim() || null,
    submit_hint: f.submit_hint.trim() || null,
    accepts: f.accepts,
    requires: f.requires as unknown as Json,
    min_text_chars: numOrNull(f.min_text_chars),
    min_duration_sec: numOrNull(f.min_duration_sec),
    minutes: numOrNull(f.minutes),
    points: numOrNull(f.points),
    check_rubric: f.check_rubric.trim() || null,
    requires_tag: f.type === "instagram" ? f.requires_tag : null,
    source: f.source,
    status,
  };
}

function Counter({ n, max }: { n: number; max: number }) {
  return <span className={`text-[11px] tabular-nums ${n > max ? "text-rose-600 font-medium" : "text-muted-foreground"}`}>{n}/{max}</span>;
}

/**
 * The day drawer: edit / approve / cancel one task, its `requires` (what MUST be sent), a live preview of the
 * exact post (rendered by SQL -- the same function the approve guard measures), and the per-group links of a
 * task staff posted by hand.
 */
export function ChallengeTaskDrawer({
  open, onOpenChange, task, date, courseId, cfg, groups, posts, onChanged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  task: TaskRow | null;
  date: string;
  courseId: string;
  cfg: CalendarConfig;
  groups: GroupLite[];
  posts: PostRow[];
  onChanged: () => void;
}) {
  const [f, setF] = useState<Form>(() => formFrom(task, date));
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [linkBusy, setLinkBusy] = useState<string | null>(null);
  const [linkInfo, setLinkInfo] = useState<Record<string, string>>({});

  // Reset the form whenever another task / date is opened, the saved row changes, or the drawer re-opens
  // (derived state, adjusted during render -- no effect needed).
  const taskKey = `${task?.id ?? "new"}:${task?.updated_at ?? ""}:${date}:${open}`;
  const [formKey, setFormKey] = useState(taskKey);
  if (formKey !== taskKey) {
    setFormKey(taskKey);
    setF(formFrom(task, date));
    setLinks({});
    setLinkInfo({});
  }

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const status: TaskStatus = (task?.status as TaskStatus) ?? "draft";
  const problem = useMemo(() => requiresProblem(f.type, f.requires, f.accepts), [f.type, f.requires, f.accepts]);
  const derived = useMemo(() => (task?.plan_format ? deriveFromFormat(task.plan_format, f.type) : null), [task?.plan_format, f.type]);
  const defaultPoints = cfg.defaultPoints[f.type];

  // Live preview: rendered by SQL (admin_challenge_task_preview), debounced.
  const draftJson = JSON.stringify({ ...payloadOf(f, courseId, status), id: task?.id ?? null });
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const { data, error } = await supabase.rpc("admin_challenge_task_preview", { _draft: JSON.parse(draftJson) as Json });
      if (cancelled) return;
      if (error) { setPreviewErr(error.message); setPreview(null); return; }
      const d = (data ?? {}) as Record<string, unknown>;
      if (typeof d.error === "string") { setPreviewErr(d.error); setPreview(null); return; }
      setPreviewErr(null);
      setPreview(d as unknown as Preview);
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [draftJson, open]);

  const save = async (nextStatus: TaskStatus, okMsg: string) => {
    if (!f.task_date) { toast.error("Sanani tanlang"); return; }
    if (nextStatus === "approved" && problem) { toast.error(problem); return; }
    if (nextStatus === "approved" && preview && preview.length > POST_MAX_CHARS) {
      toast.error(`E’lon matni juda uzun: ${preview.length} / ${POST_MAX_CHARS}`);
      return;
    }
    setBusy(true);
    try {
      const payload = payloadOf(f, courseId, nextStatus);
      const r = task
        ? await mutate(() => supabase.from("challenge_tasks").update(payload).eq("id", task.id))
        : await mutate(() => supabase.from("challenge_tasks").insert(payload));
      if (!r.ok) {
        if (r.reason !== "impersonation_readonly") toast.error(r.reason === "not_saved" ? "Saqlanmadi (ruxsat yo‘q)" : taskSaveMessage(r.message));
        return;
      }
      toast.success(okMsg);
      onChanged();
      if (!task) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!task) return;
    if (!window.confirm("Bu vazifani butunlay o‘chirasizmi?")) return;
    setBusy(true);
    try {
      const r = await mutate(() => supabase.from("challenge_tasks").delete().eq("id", task.id));
      if (!r.ok) {
        if (r.reason !== "impersonation_readonly") toast.error(r.reason === "not_saved" ? "O‘chirilmadi (tasdiqlangan vazifani faqat bekor qilish mumkin)" : taskSaveMessage(r.message));
        return;
      }
      toast.success("O‘chirildi");
      onChanged();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  const setManualPost = async (groupId: string, url: string) => {
    if (!task) return;
    if (impersonatingReadonly()) return; // expected read-only no-op while previewing as a student
    if (url.trim() !== "" && !parseMessageUrl(url)) {
      toast.error("Xabar havolasi noto‘g‘ri. Xabar ustida «Havolani nusxalash»: https://t.me/c/4440955972/144/5321");
      return;
    }
    setLinkBusy(groupId);
    try {
      const { data, error } = await supabase.rpc("admin_challenge_task_set_manual_post", { _task_id: task.id, _group_id: groupId, _url: url.trim() });
      if (error) { toast.error(error.message); return; }
      const d = (data ?? {}) as Record<string, unknown>;
      if (d.state === "manual") {
        const info = d.seen_by_bot
          ? `Bot bu xabarni ko‘rgan: «${String(d.preview ?? "").slice(0, 80)}»`
          : "Bot bu xabarni ko‘rmagan (hali) — havola to‘g‘riligini o‘zingiz tekshiring";
        setLinkInfo((prev) => ({ ...prev, [groupId]: info }));
        toast.success("Havola saqlandi");
      } else {
        setLinkInfo((prev) => ({ ...prev, [groupId]: "" }));
        toast.success(d.changed ? "Havola o‘chirildi" : "O‘zgarish yo‘q");
      }
      setLinks((prev) => ({ ...prev, [groupId]: "" }));
      onChanged();
    } finally {
      setLinkBusy(null);
    }
  };

  const updateGroup = (i: number, patch: Partial<RequiresGroup>) =>
    set("requires", f.requires.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  const toggleKind = (i: number, k: RequireKind) => {
    const g = f.requires[i];
    const any = g.any.includes(k) ? g.any.filter((x) => x !== k) : REQUIRE_KINDS.filter((x) => x === k || g.any.includes(x));
    updateGroup(i, { any });
  };
  const rederive = () => {
    if (!derived) return;
    if (derived.error) { toast.error(derived.error); return; }
    setF((prev) => ({
      ...prev, requires: derived.requires, accepts: derived.accepts,
      min_duration_sec: derived.minDurationSec ? String(derived.minDurationSec) : prev.min_duration_sec,
    }));
  };

  const groupPosts = (gid: string) => posts.filter((p) => p.task_id === task?.id && p.group_id === gid && p.kind === "task");
  const bodyRuns = preview ? telegramHtmlRuns(preview.text) : [];
  const readOnlyDate = status === "approved";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {task ? "Vazifa" : "Yangi vazifa"} · {f.task_date ? prettyDate(f.task_date) : "—"}
            <Badge variant={status === "approved" ? "default" : "secondary"}>{STATUS_UZ[status]}</Badge>
            {task?.plan_ref && <Badge variant="outline">{task.plan_ref}</Badge>}
            {preview && <Badge variant="outline">{preview.day_no}-kun</Badge>}
          </SheetTitle>
          <SheetDescription>
            Tasdiqlangan vazifa shu kuni 09:00 da guruhlarning «Qo‘shimcha vazifalar» topikiga e’lon qilinadi
            {cfg.enabled ? "." : " (tizim hali yoqilmagan — hozircha hech narsa e’lon qilinmaydi)."}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 py-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label className="text-xs">Sana</Label>
              <Input type="date" value={f.task_date} disabled={readOnlyDate} onChange={(e) => set("task_date", e.target.value)} />
              {readOnlyDate && <p className="text-[11px] text-muted-foreground mt-1">Sanani o‘zgartirish uchun avval qoralamaga qaytaring</p>}
            </div>
            <div>
              <Label className="text-xs">Turi</Label>
              <Select value={f.type} onValueChange={(v) => setF((prev) => ({ ...prev, type: v as TaskType, requires_tag: v === "instagram" ? true : prev.requires_tag }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="general">📝 Oddiy (general)</SelectItem>
                  <SelectItem value="instagram">📸 Instagram</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Manba</Label>
              <Select value={f.source} onValueChange={(v) => set("source", v as TaskSource)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(SOURCE_UZ) as TaskSource[]).map((s) => <SelectItem key={s} value={s}>{SOURCE_UZ[s]}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          {f.source === "retro" && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Retro: bu kun vazifasi qo‘lda e’lon qilingan. Pastda har guruh uchun o‘sha xabar havolasini kiriting — shunda
              javoblar shu vazifaga bog‘lanadi va keyin ballar hisoblanadi.
            </p>
          )}

          <div>
            <div className="flex items-center justify-between"><Label className="text-xs">Sarlavha</Label><Counter n={f.title.trim().length} max={LIMITS.title[1]} /></div>
            <Input value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="Masalan: ChatGPT’ni o‘zingizga moslang" />
          </div>
          <div>
            <div className="flex items-center justify-between"><Label className="text-xs">Vazifa matni</Label><Counter n={f.body.length} max={LIMITS.body[1]} /></div>
            <Textarea rows={7} value={f.body} onChange={(e) => set("body", e.target.value)} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div className="flex items-center justify-between"><Label className="text-xs">💡 Nimani o‘rganasiz</Label><Counter n={f.learn_line.length} max={LIMITS.learn} /></div>
              <Textarea rows={3} value={f.learn_line} onChange={(e) => set("learn_line", e.target.value)} />
            </div>
            <div>
              <div className="flex items-center justify-between"><Label className="text-xs">📎 Topshirish (nima yuboriladi)</Label><Counter n={f.submit_hint.length} max={LIMITS.hint} /></div>
              <Textarea rows={3} value={f.submit_hint} onChange={(e) => set("submit_hint", e.target.value)} />
            </div>
          </div>

          {/* requires: what MUST be sent (G3) */}
          <div className="rounded-md border p-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">Nima yuborilishi shart</p>
                <p className="text-[11px] text-muted-foreground">Har bir qator — alohida shart (hammasi bajarilishi kerak). Qator ichidagi turlar — «yoki».</p>
              </div>
              <div className="flex gap-2">
                {derived && (
                  <Button size="sm" variant="outline" onClick={rederive} title={`Rejadagi format: ${task?.plan_format}`}>
                    <RefreshCw className="h-3.5 w-3.5 mr-1" /> Formatdan qayta hisoblash
                  </Button>
                )}
                <Button size="sm" variant="outline" disabled={f.requires.length >= MAX_REQUIRE_GROUPS}
                  onClick={() => set("requires", [...f.requires, { any: ["text"], min: 1, label: "text" }])}>
                  <Plus className="h-3.5 w-3.5 mr-1" /> Shart
                </Button>
              </div>
            </div>
            {task?.plan_format && <p className="text-xs text-muted-foreground">Rejadagi format: «{task.plan_format}»</p>}
            {derived?.flags.map((fl, i) => (
              <div key={i} className="text-xs rounded bg-amber-500/10 text-amber-800 dark:text-amber-300 px-2 py-1 flex flex-wrap items-center gap-2">
                <span>
                  {fl.kind === "count"
                    ? `Rejada «${fl.term}»: minimal son avtomatik qo‘yilmadi — tekshiring.`
                    : fl.kind === "type" ? fl.text : `Rejada «${fl.term}»: ${fl.text}`}
                </span>
                {fl.kind === "count" && fl.suggestedMin && fl.group !== null && f.requires[fl.group] && f.requires[fl.group].min !== fl.suggestedMin && (
                  <Button size="sm" variant="outline" className="h-6 px-2 text-xs"
                    onClick={() => updateGroup(fl.group as number, { min: fl.suggestedMin as number })}>
                    min = {fl.suggestedMin} qilish
                  </Button>
                )}
              </div>
            ))}
            {f.requires.length === 0 && <p className="text-xs text-muted-foreground">Shart yo‘q — qabul qilinadigan istalgan bitta element yetadi.</p>}
            {f.requires.map((g, i) => (
              <div key={i} className="rounded border bg-muted/30 p-2 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={g.label} onValueChange={(v) => updateGroup(i, { label: v as RequireLabel })}>
                    <SelectTrigger className="h-8 w-[170px]"><SelectValue /></SelectTrigger>
                    <SelectContent>{REQUIRE_LABELS.map((l) => <SelectItem key={l} value={l}>{LABEL_UZ[l]}</SelectItem>)}</SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground">kamida</span>
                  <Input type="number" min={1} max={MAX_GROUP_MIN} className="h-8 w-16" value={g.min}
                    onChange={(e) => updateGroup(i, { min: Math.max(1, Math.min(MAX_GROUP_MIN, Math.trunc(Number(e.target.value) || 1))) })} />
                  <span className="text-xs text-muted-foreground">ta</span>
                  <Button size="icon" variant="ghost" className="h-8 w-8 ml-auto" onClick={() => set("requires", f.requires.filter((_, j) => j !== i))}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {REQUIRE_KINDS.filter((k) => k !== "ig_link" || f.type === "instagram").map((k) => (
                    <button key={k} type="button" onClick={() => toggleKind(i, k)}
                      className={`text-[11px] rounded-full border px-2 py-0.5 ${g.any.includes(k) ? "bg-primary text-primary-foreground border-primary" : "text-muted-foreground"}`}>
                      {KIND_LABEL_UZ[k]}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div>
            <Label className="text-xs">Qabul qilinadigan formatlar (bot shularni yig‘adi)</Label>
            <div className="flex flex-wrap gap-3 mt-1">
              {ACCEPT_KINDS.map((k) => (
                <label key={k} className="flex items-center gap-1.5 text-xs">
                  <Checkbox checked={f.accepts.includes(k)}
                    onCheckedChange={(v) => set("accepts", ACCEPT_KINDS.filter((x) => (x === k ? v === true : f.accepts.includes(x))))} />
                  {ACCEPT_LABEL_UZ[k]}
                </label>
              ))}
            </div>
            {problem && (
              <div className="mt-2 text-xs text-rose-600 flex flex-wrap items-center gap-2">
                <span>{problem}</span>
                {requiresValid(f.requires) && acceptsFor(f.requires).some((k) => !f.accepts.includes(k)) && (
                  <Button size="sm" variant="outline" className="h-6 px-2 text-xs"
                    onClick={() => set("accepts", ACCEPT_KINDS.filter((k) => f.accepts.includes(k) || acceptsFor(f.requires).includes(k)))}>
                    Kerakli formatlarni qo‘shish
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div>
              <Label className="text-xs">Ball</Label>
              <Input type="number" min={1} max={50} value={f.points} placeholder={`${defaultPoints} (sozlama)`} onChange={(e) => set("points", e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Daqiqa (taxminan)</Label>
              <Input type="number" min={1} max={600} value={f.minutes} onChange={(e) => set("minutes", e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Min. matn (belgi)</Label>
              <Input type="number" min={1} value={f.min_text_chars} placeholder="sozlama (20)" onChange={(e) => set("min_text_chars", e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Min. ovoz/video (s)</Label>
              <Input type="number" min={1} value={f.min_duration_sec} placeholder="sozlama (3)" onChange={(e) => set("min_duration_sec", e.target.value)} />
            </div>
          </div>
          {f.type === "instagram" && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={f.requires_tag} onCheckedChange={(v) => set("requires_tag", v === true)} />
              Postda @aicreators.students belgisi talab qilinadi
            </label>
          )}
          <div>
            <div className="flex items-center justify-between"><Label className="text-xs">AI tekshiruv mezoni (talabalar ko‘rmaydi)</Label><Counter n={f.check_rubric.length} max={LIMITS.rubric} /></div>
            <Textarea rows={4} value={f.check_rubric} onChange={(e) => set("check_rubric", e.target.value)}
              placeholder="Qabul qilinadigan ish qanday ko‘rinishi kerak; nimada rad etiladi." />
          </div>

          {/* live preview (SQL renders it; the same text the approve guard measures) */}
          <div className="rounded-md border">
            <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/40">
              <span className="text-xs font-medium">Guruhdagi e’lon (ko‘rinishi)</span>
              {preview && <Counter n={preview.length} max={preview.max} />}
            </div>
            <div className="p-3 text-sm whitespace-pre-wrap break-words">
              {previewErr && <span className="text-xs text-rose-600">Ko‘rinishni olib bo‘lmadi: {previewErr}</span>}
              {!previewErr && !preview && <span className="text-xs text-muted-foreground">Yuklanmoqda…</span>}
              {bodyRuns.map((r, i) => (r.bold ? <strong key={i}>{r.text}</strong> : <span key={i}>{r.text}</span>))}
            </div>
            <div className="px-3 pb-3"><span className="inline-block rounded bg-muted px-3 py-1 text-xs">📱 Ilovada topshirish</span></div>
          </div>

          {/* manual posts (G8, G9) */}
          {task && (
            <div className="rounded-md border p-3 space-y-3">
              <div>
                <p className="text-sm font-medium flex items-center gap-1.5"><Link2 className="h-4 w-4" /> Qo‘lda e’lon qilingan xabar havolasi (har guruh uchun)</p>
                <p className="text-[11px] text-muted-foreground">
                  Vazifani bot emas, xodim e’lon qilgan bo‘lsa: «Qo‘shimcha vazifalar» topikidagi o‘sha xabar ustida «Havolani nusxalash» → shu yerga.
                  Talabalarning shu xabarga javoblari shu vazifaga bog‘lanadi.
                </p>
              </div>
              {groups.length === 0 && <p className="text-xs text-muted-foreground">Bu kursda «Qo‘shimcha vazifalar» topiki sozlangan guruh yo‘q (Admin → Guruhlar).</p>}
              {groups.map((g) => {
                const p = groupPosts(g.id)[0];
                const link = p ? postLink(p) : null;
                const noTopic = !g.daily_task_topic_id;
                return (
                  <div key={g.id} className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium">{g.name}</span>
                      {noTopic && <span className="text-amber-600">topik sozlanmagan</span>}
                      {p && <Badge variant="outline" className="text-[10px]">{POST_STATE_UZ[p.state] ?? p.state}</Badge>}
                      {link && <a href={link} target="_blank" rel="noreferrer" className="text-primary underline break-all">{link}</a>}
                    </div>
                    {!noTopic && (!p || p.state === "manual" || p.state === "queued" || p.state === "failed" || p.state === "skipped") && (
                      <div className="flex gap-2">
                        <Input className="h-8 text-xs" value={links[g.id] ?? ""} placeholder={`https://t.me/c/${String(g.daily_task_chat_id ?? "").replace(/^-100/, "")}/${g.daily_task_topic_id}/…`}
                          onChange={(e) => setLinks((prev) => ({ ...prev, [g.id]: e.target.value }))} />
                        <Button size="sm" variant="outline" className="h-8" disabled={linkBusy === g.id || !(links[g.id] ?? "").trim()}
                          onClick={() => setManualPost(g.id, links[g.id] ?? "")}>Saqlash</Button>
                        {p?.state === "manual" && (
                          <Button size="sm" variant="ghost" className="h-8" disabled={linkBusy === g.id} onClick={() => setManualPost(g.id, "")}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    )}
                    {linkInfo[g.id] && <p className="text-[11px] text-muted-foreground">{linkInfo[g.id]}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="sticky bottom-0 bg-background border-t py-3 flex flex-wrap gap-2 justify-end">
          {task && status !== "approved" && !posts.some((p) => p.task_id === task.id) && (
            <Button variant="ghost" className="text-rose-600 mr-auto" disabled={busy} onClick={remove}>O‘chirish</Button>
          )}
          {task && status !== "cancelled" && (
            <Button variant="outline" disabled={busy} onClick={() => { if (window.confirm("Vazifani bekor qilasizmi? U e’lon qilinmaydi.")) void save("cancelled", "Bekor qilindi"); }}>
              Bekor qilish
            </Button>
          )}
          {status === "approved" ? (
            <>
              <Button variant="outline" disabled={busy} onClick={() => save("draft", "Qoralamaga qaytarildi")}>Qoralamaga qaytarish</Button>
              <Button disabled={busy} onClick={() => save("approved", "Saqlandi")}>Saqlash</Button>
            </>
          ) : (
            <>
              <Button variant="outline" disabled={busy} onClick={() => save(status === "cancelled" ? "cancelled" : "draft", "Saqlandi")}>Saqlash</Button>
              <Button disabled={busy || !!problem} onClick={() => save("approved", "Tasdiqlandi")}>Tasdiqlash</Button>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
