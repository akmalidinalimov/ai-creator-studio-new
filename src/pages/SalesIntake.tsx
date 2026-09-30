import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { UserPlus, CheckCircle2, Loader2, AlertTriangle, Info, X, Lock, ShieldAlert } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { describeIntakeRefusal, REFUSED_STATUS, sameCourseMoveNote } from "@/lib/courseMove";

type TierOpt = { id: string; name: string };
type CourseOpt = { id: string; title: string; published: boolean; tiers: TierOpt[]; groups: string[] };
type Recent = { name: string; status: string; cls: string };
type ResultKind = "success" | "duplicate" | "exists" | "error" | "blocked";
type Result = { kind: ResultKind; title: string; detail: string };

const BANNER: Record<ResultKind, { cls: string; Icon: typeof CheckCircle2 }> = {
  success:   { cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300", Icon: CheckCircle2 },
  duplicate: { cls: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300", Icon: AlertTriangle },
  exists:    { cls: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300", Icon: Info },
  error:     { cls: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300", Icon: AlertTriangle },
  blocked:   { cls: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300", Icon: ShieldAlert },
};

// Passwordless sales-intake form. No login: the ?code= in the link is the gate.
// Both the dropdown options and the submission go through the staff-intake edge
// function, which validates the code (x-intake-code) server-side — same model as
// sheet-sync. Sales staff just open the link and fill the form.
export default function SalesIntake() {
  const [searchParams] = useSearchParams();
  const code = (searchParams.get("code") || "").trim();

  const [loadingOpts, setLoadingOpts] = useState(true);
  const [accessDenied, setAccessDenied] = useState(false);
  const [courses, setCourses] = useState<CourseOpt[]>([]);

  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [username, setUsername] = useState("");
  const [course, setCourse] = useState("");
  const [tier, setTier] = useState("");
  const [group, setGroup] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [instagram, setInstagram] = useState("");
  const [accountType, setAccountType] = useState<"paid" | "provisional">("paid");
  const [submitting, setSubmitting] = useState(false);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  // Same-course move ("5.0 PRE -> 5.0 VIP"): the salesperson confirms. A move to ANOTHER course never gets this
  // prompt: the server refuses it (PR-3a) and the form shows why, plus an override only a signed-in admin sees.
  const [movePrompt, setMovePrompt] = useState<{ userId: string; currentGroup: string | null; waiting: number | null } | null>(null);
  const [moveTargetGroup, setMoveTargetGroup] = useState("");
  const [overridePrompt, setOverridePrompt] = useState<{ groupName: string; note: string | null } | null>(null);

  useEffect(() => {
    (async () => {
      setLoadingOpts(true);
      setAccessDenied(false);
      if (!code) { setAccessDenied(true); setLoadingOpts(false); return; }
      try {
        const { data, error } = await supabase.functions.invoke("staff-intake", {
          body: { action: "options" },
          headers: { "x-intake-code": code },
        });
        if (error || !data) { setAccessDenied(true); return; }
        const oc = (data as any).courses || [];
        const ot = (data as any).tiers || [];
        const og = (data as any).groups || [];
        const built: CourseOpt[] = (oc as any[]).map((c) => ({
          id: c.id,
          title: c.title,
          published: c.published !== false,
          tiers: (ot as any[]).filter((t) => t.course_id === c.id).map((t) => ({ id: t.id, name: t.name })),
          groups: (og as any[]).filter((g) => g.course_id === c.id).map((g) => g.name),
        }));
        setCourses(built);
      } catch {
        setAccessDenied(true);
      } finally {
        setLoadingOpts(false);
      }
    })();
  }, [code]);

  const selCourse = useMemo(() => courses.find((c) => c.title === course), [courses, course]);
  const tierOpts = selCourse ? [...selCourse.tiers.map((t) => t.name), "Full"] : ["Full"];
  // A course without tiers (e.g. Challenge 6.0) has nothing to choose: tier_id null = every module.
  const hasTiers = !!selCourse && selCourse.tiers.length > 0;

  const runIntake = async (opts: { confirmMove: boolean; groupName: string; adminOverride?: boolean }) => {
    if (!selCourse) { toast.error("Kursni tanlang"); return; }
    const tier_id = !hasTiers || tier === "Full" ? null : (selCourse.tiers.find((t) => t.name === tier)?.id ?? null);
    setSubmitting(true);
    setResult(null);
    // Capture the human-readable details now, before we clear the fields.
    const who = `${first.trim()} ${last.trim()}`.trim();
    const uname = username.trim().replace(/^@/, "");
    const courseTitle = selCourse.title;
    const groupName = opts.groupName.trim();
    const acctSuffix = accountType === "provisional" ? " 🔒 Sinov hisob (qisman to'lov — darsliksiz)." : "";
    const clearStudentFields = () => { setFirst(""); setLast(""); setUsername(""); setPhone(""); setEmail(""); };
    try {
      const payload = {
        name: first.trim(), last_name: last.trim(), telegram_username: username.trim(),
        course_id: selCourse.id, tier_id, group_name: groupName,
        phone: phone.trim(), email: email.trim(), instagram_username: instagram.trim(),
        confirm_move: opts.confirmMove,
        // Honoured only for a verified admin session with 0 waiting old-course homework (checked server-side).
        admin_override: opts.adminOverride === true,
        account_type: accountType,
      };
      // A transient network blip (common on mobile / Telegram's in-app browser) surfaces
      // as a FunctionsFetchError with no response — retry once after a short pause before
      // giving up. The server dedups by username+group, so a retry can never double-add.
      let data: any = null, error: any = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        ({ data, error } = await supabase.functions.invoke("staff-intake", {
          headers: { "x-intake-code": code },
          body: payload,
        }));
        if (error && error.name === "FunctionsFetchError" && attempt === 0) {
          await new Promise((r) => setTimeout(r, 900));
          continue;
        }
        break;
      }
      if (error) throw error;
      const st = (data as any)?.status as string;

      if (st === "exists_in_other_group") {
        // Existing student in a DIFFERENT group of the SAME course — ask before moving. Keep fields.
        setMovePrompt({
          userId: (data as any)?.userId,
          currentGroup: (data as any)?.current_group ?? null,
          waiting: typeof (data as any)?.old_course_waiting === "number" ? (data as any).old_course_waiting : null,
        });
        setMoveTargetGroup(groupName);
        setOverridePrompt(null);
        setSubmitting(false);
        return;
      }
      setMovePrompt(null);

      if (st === REFUSED_STATUS) {
        // Another course: refused. No "change group" button; keep the fields so an admin can override.
        const d = describeIntakeRefusal(data as any, uname);
        // Why an admin could not override either ("N ta vazifa baholanmaguncha...") belongs in the banner.
        setResult({ kind: "blocked", title: d.title, detail: !d.canOverride && d.overrideNote ? `${d.detail} ${d.overrideNote}` : d.detail });
        setOverridePrompt(d.canOverride ? { groupName, note: d.overrideNote } : null);
        toast.error(d.title);
        setRecent((p) => [{ name: who, status: "⛔ Boshqa kurs", cls: "text-rose-600" }, ...p].slice(0, 20));
        return;
      }
      setOverridePrompt(null);

      if (st === "created") {
        setResult({ kind: "success", title: "✅ Muvaffaqiyatli qo'shildi!", detail: `${who} (@${uname}) — ${courseTitle}, "${groupName}" guruhiga qo'shildi.${acctSuffix}` });
        toast.success(`✅ ${who || uname} qo'shildi`);
        setRecent((p) => [{ name: who, status: "✅ Qo'shildi", cls: "text-emerald-600" }, ...p].slice(0, 20));
        clearStudentFields();
      } else if (st === "already_in_group") {
        setResult({ kind: "duplicate", title: "⚠️ Dublikat! Bu talaba allaqachon mavjud", detail: `${who || uname} (@${uname}) allaqachon shu guruhda ro'yxatdan o'tgan. Qayta qo'shilmadi.` });
        toast.error(`⚠️ Dublikat: @${uname} allaqachon shu guruhda`);
        setRecent((p) => [{ name: who, status: "⚠️ Dublikat", cls: "text-rose-600" }, ...p].slice(0, 20));
      } else if (st === "updated" || st === "matched") {
        if (opts.confirmMove) {
          const overridden = (data as any)?.cross_course_override === true ? " (admin: kurs o'zgartirildi)" : "";
          setResult({ kind: "success", title: "✅ Guruh o'zgartirildi!", detail: `${who || uname} (@${uname}) endi "${groupName}" guruhida.${overridden}${acctSuffix}` });
          toast.success(`✅ Guruh o'zgartirildi: @${uname} → ${groupName}`);
          setRecent((p) => [{ name: who, status: "✅ Guruh o'zgartirildi", cls: "text-emerald-600" }, ...p].slice(0, 20));
        } else {
          setResult({ kind: "exists", title: "ℹ️ Talaba allaqachon platformada bor edi", detail: `${who || uname} (@${uname}) tizimda mavjud edi va "${courseTitle}" kursiga biriktirildi.${acctSuffix}` });
          toast.message(`ℹ️ @${uname} allaqachon bor edi — kursga qo'shildi`);
          setRecent((p) => [{ name: who, status: "ℹ️ Allaqachon bor", cls: "text-amber-600" }, ...p].slice(0, 20));
        }
        clearStudentFields();
      } else {
        const msg = (data as any)?.message || st || "Noma'lum xatolik";
        setResult({ kind: "error", title: "⚠️ Xatolik", detail: String(msg) });
        toast.error(`⚠️ ${msg}`);
        setRecent((p) => [{ name: who, status: `⚠️ ${st || "xato"}`, cls: "text-amber-600" }, ...p].slice(0, 20));
      }
    } catch (e: any) {
      const isNet = e?.name === "FunctionsFetchError" || /Failed to send a request/i.test(e?.message || "");
      const msg = isNet
        ? "Internet bilan aloqa uzildi. Iltimos, qayta urinib ko'ring."
        : (e?.message || "Yuborishda xatolik");
      setResult({ kind: "error", title: isNet ? "📶 Aloqa xatosi" : "⚠️ Xatolik", detail: String(msg) });
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const submit = () => {
    if (!first.trim() || !username.trim() || !course || (hasTiers && !tier) || !group.trim()) {
      toast.error(hasTiers
        ? "Majburiy maydonlarni to'ldiring: ism, @username, kurs, tarif, guruh"
        : "Majburiy maydonlarni to'ldiring: ism, @username, kurs, guruh");
      return;
    }
    setMovePrompt(null);
    setOverridePrompt(null);
    void runIntake({ confirmMove: false, groupName: group });
  };

  const confirmGroupMove = () => {
    if (!moveTargetGroup.trim()) { toast.error("Yangi guruhni tanlang"); return; }
    void runIntake({ confirmMove: true, groupName: moveTargetGroup });
  };

  // Admin-only: move a student to ANOTHER course. The server re-checks the admin session and 0 waiting homework.
  const confirmAdminOverride = () => {
    if (!overridePrompt) return;
    void runIntake({ confirmMove: true, groupName: overridePrompt.groupName, adminOverride: true });
  };

  if (loadingOpts) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
        <Card className="max-w-sm w-full p-6 text-center space-y-2">
          <Lock className="h-8 w-8 mx-auto text-muted-foreground" />
          <h1 className="text-lg font-semibold">Havola yaroqsiz</h1>
          <p className="text-sm text-muted-foreground">
            Bu havola noto'g'ri yoki eskirgan. To'g'ri kirish havolasidan foydalaning.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 bg-muted/30">
      <div className="mx-auto max-w-md space-y-4">
        <div className="flex items-center gap-2 pt-2">
          <UserPlus className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Talaba qo'shish</h1>
        </div>

        {result && (() => {
          const { cls, Icon } = BANNER[result.kind];
          return (
            <div className={`rounded-lg border p-3 flex items-start gap-2.5 ${cls}`} role="status" aria-live="polite">
              <Icon className="h-5 w-5 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <div className="font-semibold text-sm">{result.title}</div>
                <div className="text-sm opacity-90 break-words">{result.detail}</div>
              </div>
              <button onClick={() => setResult(null)} className="ml-auto shrink-0 opacity-60 hover:opacity-100 transition-opacity" aria-label="Yopish">
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })()}

        {movePrompt && (
          <Card className="p-4 space-y-3 border-amber-500/40 bg-amber-500/[0.06]">
            <div className="flex items-start gap-2.5 text-amber-800 dark:text-amber-200">
              <Info className="h-5 w-5 shrink-0 mt-0.5" />
              <div className="text-sm">
                <div className="font-semibold">Bu talaba boshqa guruhda</div>
                <div className="opacity-90">
                  @{username.trim().replace(/^@/, "")} allaqachon <b>"{movePrompt.currentGroup || "—"}"</b> guruhida.
                  Uni yangi guruhga o'tkazasizmi?
                </div>
                {sameCourseMoveNote(movePrompt.waiting) && (
                  <div className="opacity-90 mt-1">{sameCourseMoveNote(movePrompt.waiting)}</div>
                )}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Yangi guruh</Label>
              <Input value={moveTargetGroup} onChange={(e) => setMoveTargetGroup(e.target.value)} list="move-grp-list" placeholder="Yangi guruh nomi" />
              <datalist id="move-grp-list">
                {(selCourse?.groups || []).map((g) => <option key={g} value={g} />)}
              </datalist>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={confirmGroupMove} disabled={submitting}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Guruhni o'zgartirish"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMovePrompt(null)} disabled={submitting}>Bekor qilish</Button>
            </div>
          </Card>
        )}

        {overridePrompt && (
          // Shown ONLY when the server said a signed-in admin could override (0 waiting homework in the old
          // course). A salesperson using the link never sees it.
          <Card className="p-4 space-y-3 border-rose-500/40 bg-rose-500/[0.05]">
            <div className="flex items-start gap-2.5 text-rose-800 dark:text-rose-200">
              <ShieldAlert className="h-5 w-5 shrink-0 mt-0.5" />
              <div className="text-sm">
                <div className="font-semibold">Admin: kursni baribir o'zgartirish</div>
                {overridePrompt.note && <div className="opacity-90">{overridePrompt.note}</div>}
                <div className="opacity-90 mt-1">Yangi guruh: <b>"{overridePrompt.groupName}"</b>. Bu amal jurnalga yoziladi.</div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" onClick={confirmAdminOverride} disabled={submitting}>
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Admin sifatida o'tkazish"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setOverridePrompt(null)} disabled={submitting}>Bekor qilish</Button>
            </div>
          </Card>
        )}

        <Card className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>Ism <span className="text-rose-500">*</span></Label>
              <Input value={first} onChange={(e) => setFirst(e.target.value)} placeholder="Ali" />
            </div>
            <div className="space-y-1.5">
              <Label>Familiya</Label>
              <Input value={last} onChange={(e) => setLast(e.target.value)} placeholder="Valiyev" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Telegram username <span className="text-rose-500">*</span></Label>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="@ali_valiyev" />
          </div>

          <div className="space-y-1.5">
            <Label>Kurs <span className="text-rose-500">*</span></Label>
            <Select value={course} onValueChange={(v) => { setCourse(v); setTier(""); setGroup(""); setMovePrompt(null); setOverridePrompt(null); }}>
              <SelectTrigger><SelectValue placeholder="Kursni tanlang" /></SelectTrigger>
              <SelectContent>
                {courses.map((c) => (
                  <SelectItem key={c.id} value={c.title}>{c.published ? c.title : `${c.title} (yopiq)`}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selCourse && !selCourse.published && (
              <p className="text-xs text-amber-600 dark:text-amber-400 leading-snug">
                Bu kurs hali yopiq. Talaba qo'shiladi, lekin darslar kurs ochilgandan keyin ko'rinadi.
              </p>
            )}
            {selCourse && !hasTiers && (
              <p className="text-xs text-muted-foreground leading-snug">
                Bu kursda tarif yo'q — talaba barcha modullarga to'liq kirish oladi.
              </p>
            )}
          </div>

          <div className={hasTiers ? "grid grid-cols-2 gap-2" : ""}>
            {hasTiers && (
              <div className="space-y-1.5">
                <Label>Tarif <span className="text-rose-500">*</span></Label>
                <Select value={tier} onValueChange={setTier} disabled={!course}>
                  <SelectTrigger><SelectValue placeholder="Tarif" /></SelectTrigger>
                  <SelectContent>
                    {tierOpts.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Guruh <span className="text-rose-500">*</span></Label>
              <Input value={group} onChange={(e) => setGroup(e.target.value)} list="grp-list" placeholder="Guruh nomi" disabled={!course} />
              <datalist id="grp-list">
                {(selCourse?.groups || []).map((g) => <option key={g} value={g} />)}
              </datalist>
              {selCourse && selCourse.groups.length === 0 && (
                <p className="text-xs text-muted-foreground leading-snug">
                  Bu kursda hali guruh yo'q — yozilgan nom bilan yangi guruh yaratiladi.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>To'lov holati <span className="text-rose-500">*</span></Label>
            <Select value={accountType} onValueChange={(v) => setAccountType(v as "paid" | "provisional")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="paid">✅ To'liq to'lagan — to'liq kirish</SelectItem>
                <SelectItem value="provisional">🔒 Sinov (qisman to'lov) — darsliksiz</SelectItem>
              </SelectContent>
            </Select>
            {accountType === "provisional" && (
              <p className="text-xs text-amber-600 dark:text-amber-400 leading-snug">
                Talaba tanlangan guruh/tarifga qo'shiladi, lekin darsliklar yopiq bo'ladi. Uy vazifa, ball va statistika ishlaydi. To'liq to'lovdan keyin admin panelida yoki shu formani "To'liq to'lagan" bilan qayta yuborib ochiladi.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>Telefon</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+998…" />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="(ixtiyoriy)" />
            </div>
          </div>
          {/* Challenge 6.0: without a handle the student simply can't earn Instagram points. */}
          <div className="space-y-1.5">
            <Label>Instagram</Label>
            <Input value={instagram} onChange={(e) => setInstagram(e.target.value)} placeholder="@username (challenge uchun)" />
          </div>

          <Button className="w-full" onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <><UserPlus className="h-4 w-4 mr-1" /> Qo'shish</>}
          </Button>
        </Card>

        {recent.length > 0 && (
          <Card className="p-4">
            <div className="flex items-center gap-2 text-sm font-medium mb-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" /> Bugun qo'shilganlar ({recent.length})
            </div>
            <div className="divide-y text-sm">
              {recent.map((r, i) => (
                <div key={i} className="flex items-center justify-between py-1.5">
                  <span>{r.name || "—"}</span>
                  <span className={`text-xs ${r.cls}`}>{r.status}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
