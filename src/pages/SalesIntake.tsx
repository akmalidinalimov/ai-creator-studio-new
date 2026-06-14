import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { UserPlus, CheckCircle2, Loader2 } from "lucide-react";

const FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sheet-sync`;

type GroupOpt = { name: string; tier: string; students: number };
type CourseOpt = { title: string; tiers: string[]; groups: GroupOpt[] };
type Recent = { name: string; status: string; cls: string };

// Public sales-intake form. Gated by a shared access code (passed as ?code= or entered once,
// cached in localStorage). Submits each student straight to the sheet-sync edge function —
// same secure, idempotent path as the Google Sheet. No platform login required.
export default function SalesIntake() {
  const [code, setCode] = useState<string>("");
  const [codeInput, setCodeInput] = useState("");
  const [authed, setAuthed] = useState(false);
  const [loadingOpts, setLoadingOpts] = useState(false);
  const [courses, setCourses] = useState<CourseOpt[]>([]);

  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [username, setUsername] = useState("");
  const [course, setCourse] = useState("");
  const [group, setGroup] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [recent, setRecent] = useState<Recent[]>([]);

  useEffect(() => {
    const url = new URLSearchParams(window.location.search);
    const c = url.get("code") || localStorage.getItem("intake_code") || "";
    if (c) setCode(c);
  }, []);

  useEffect(() => {
    if (!code) return;
    (async () => {
      setLoadingOpts(true);
      try {
        const r = await fetch(FN, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-sheet-secret": code },
          body: JSON.stringify({ options: true }),
        });
        if (r.status === 403) {
          toast.error("Noto'g'ri kirish kodi");
          localStorage.removeItem("intake_code");
          setCode(""); setAuthed(false);
          return;
        }
        const d = await r.json();
        setCourses((d.courses || []) as CourseOpt[]);
        localStorage.setItem("intake_code", code);
        setAuthed(true);
      } catch {
        toast.error("Ulanishda xatolik");
      } finally {
        setLoadingOpts(false);
      }
    })();
  }, [code]);

  const selCourse = useMemo(() => courses.find((c) => c.title === course), [courses, course]);
  const groupOpts = selCourse?.groups || [];

  const submit = async () => {
    if (!first.trim() || !username.trim() || !course || !group.trim()) {
      toast.error("Majburiy maydonlarni to'ldiring: ism, @username, kurs, guruh");
      return;
    }
    setSubmitting(true);
    try {
      // No tier is sent: the chosen group is the single source of truth for course + tier.
      const r = await fetch(FN, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-sheet-secret": code },
        body: JSON.stringify({
          rows: [{
            name: first.trim(), last_name: last.trim(), telegram_username: username.trim(),
            course, group_name: group.trim(), phone: phone.trim(), email: email.trim(),
          }],
        }),
      });
      const d = await r.json();
      const res = (d.results || [])[0] || {};
      const st = res.status as string;
      const who = `${first} ${last}`.trim();
      if (st === "created") {
        toast.success(`✅ ${first} qo'shildi`);
        setRecent((p) => [{ name: who, status: "✅ Qo'shildi", cls: "text-emerald-600" }, ...p].slice(0, 20));
      } else if (st === "updated" || st === "matched" || st === "already_in_group") {
        toast.message(`✔️ ${first} allaqachon platformada`);
        setRecent((p) => [{ name: who, status: "✔️ Allaqachon bor", cls: "text-sky-600" }, ...p].slice(0, 20));
      } else {
        toast.error(`⚠️ ${res.message || st || "xatolik"}`);
        setRecent((p) => [{ name: who, status: `⚠️ ${st || "xato"}`, cls: "text-amber-600" }, ...p].slice(0, 20));
      }
      // Keep course/tier/group for the next student; clear the per-student fields.
      setFirst(""); setLast(""); setUsername(""); setPhone(""); setEmail("");
    } catch {
      toast.error("Yuborishda xatolik");
    } finally {
      setSubmitting(false);
    }
  };

  if (!authed) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
        <Card className="w-full max-w-sm p-6 space-y-4">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">Talaba qo'shish</h1>
            <p className="text-sm text-muted-foreground">Kirish kodini kiriting.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Kirish kodi</Label>
            <Input type="password" value={codeInput} onChange={(e) => setCodeInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") setCode(codeInput.trim()); }} placeholder="••••••••" />
          </div>
          <Button className="w-full" disabled={!codeInput.trim() || loadingOpts} onClick={() => setCode(codeInput.trim())}>
            {loadingOpts ? <Loader2 className="h-4 w-4 animate-spin" /> : "Kirish"}
          </Button>
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
            <Select value={course} onValueChange={(v) => { setCourse(v); setGroup(""); }}>
              <SelectTrigger><SelectValue placeholder="Kursni tanlang" /></SelectTrigger>
              <SelectContent>
                {courses.map((c) => <SelectItem key={c.title} value={c.title}>{c.title}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Guruh <span className="text-rose-500">*</span></Label>
            <Select value={group} onValueChange={setGroup} disabled={!course}>
              <SelectTrigger><SelectValue placeholder="Guruhni tanlang" /></SelectTrigger>
              <SelectContent>
                {groupOpts.length === 0 ? (
                  <div className="px-2 py-1.5 text-sm text-muted-foreground">Bu kurs uchun guruh yo'q</div>
                ) : groupOpts.map((g) => (
                  <SelectItem key={g.name} value={g.name}>
                    {g.name} · {g.tier} · {g.students} o'quvchi
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              O'quvchi guruhning kursi va tarifini avtomatik oladi.
            </p>
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
