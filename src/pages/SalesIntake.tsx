import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { UserPlus, CheckCircle2, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

type TierOpt = { id: string; name: string };
type CourseOpt = { id: string; title: string; tiers: TierOpt[]; groups: string[] };
type Recent = { name: string; status: string; cls: string };

// Staff-only sales-intake form (Phase 0 / M18). The route is wrapped in
// RequireAuth staffOnly, so only a logged-in teacher/admin can reach it. Options are
// read via the authenticated Supabase client and submissions go through the
// staff-intake edge function using the staff member's own session — there is NO
// shared secret in the browser anymore.
export default function SalesIntake() {
  const [loadingOpts, setLoadingOpts] = useState(true);
  const [courses, setCourses] = useState<CourseOpt[]>([]);

  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [username, setUsername] = useState("");
  const [course, setCourse] = useState("");
  const [tier, setTier] = useState("");
  const [group, setGroup] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [recent, setRecent] = useState<Recent[]>([]);

  useEffect(() => {
    (async () => {
      setLoadingOpts(true);
      try {
        const [{ data: oc }, { data: ot }, { data: og }] = await Promise.all([
          supabase.from("courses").select("id, title").order("title"),
          supabase.from("course_tiers").select("id, course_id, name, position").order("position"),
          supabase.from("groups").select("course_id, name").order("name"),
        ]);
        const built: CourseOpt[] = ((oc || []) as any[]).map((c) => ({
          id: c.id,
          title: c.title,
          tiers: ((ot || []) as any[]).filter((t) => t.course_id === c.id).map((t) => ({ id: t.id, name: t.name })),
          groups: ((og || []) as any[]).filter((g) => g.course_id === c.id).map((g) => g.name),
        }));
        setCourses(built);
      } catch {
        toast.error("Ulanishda xatolik");
      } finally {
        setLoadingOpts(false);
      }
    })();
  }, []);

  const selCourse = useMemo(() => courses.find((c) => c.title === course), [courses, course]);
  const tierOpts = selCourse ? [...selCourse.tiers.map((t) => t.name), "Full"] : ["Full"];

  const submit = async () => {
    if (!first.trim() || !username.trim() || !course || !tier || !group.trim()) {
      toast.error("Majburiy maydonlarni to'ldiring: ism, @username, kurs, tarif, guruh");
      return;
    }
    if (!selCourse) { toast.error("Kursni tanlang"); return; }
    const tier_id = tier === "Full" ? null : (selCourse.tiers.find((t) => t.name === tier)?.id ?? null);
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke("staff-intake", {
        body: {
          name: first.trim(), last_name: last.trim(), telegram_username: username.trim(),
          course_id: selCourse.id, tier_id, group_name: group.trim(),
          phone: phone.trim(), email: email.trim(),
        },
      });
      if (error) throw error;
      const st = (data as any)?.status as string;
      const who = `${first} ${last}`.trim();
      if (st === "created") {
        toast.success(`✅ ${first} qo'shildi`);
        setRecent((p) => [{ name: who, status: "✅ Qo'shildi", cls: "text-emerald-600" }, ...p].slice(0, 20));
      } else if (st === "updated" || st === "matched" || st === "already_in_group") {
        toast.message(`✔️ ${first} allaqachon platformada`);
        setRecent((p) => [{ name: who, status: "✔️ Allaqachon bor", cls: "text-sky-600" }, ...p].slice(0, 20));
      } else {
        const msg = (data as any)?.message || st || "xatolik";
        toast.error(`⚠️ ${msg}`);
        setRecent((p) => [{ name: who, status: `⚠️ ${st || "xato"}`, cls: "text-amber-600" }, ...p].slice(0, 20));
      }
      // Keep course/tier/group for the next student; clear the per-student fields.
      setFirst(""); setLast(""); setUsername(""); setPhone(""); setEmail("");
    } catch (e: any) {
      toast.error(e?.message || "Yuborishda xatolik");
    } finally {
      setSubmitting(false);
    }
  };

  if (loadingOpts) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
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
            <Select value={course} onValueChange={(v) => { setCourse(v); setTier(""); setGroup(""); }}>
              <SelectTrigger><SelectValue placeholder="Kursni tanlang" /></SelectTrigger>
              <SelectContent>
                {courses.map((c) => <SelectItem key={c.id} value={c.title}>{c.title}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>Tarif <span className="text-rose-500">*</span></Label>
              <Select value={tier} onValueChange={setTier} disabled={!course}>
                <SelectTrigger><SelectValue placeholder="Tarif" /></SelectTrigger>
                <SelectContent>
                  {tierOpts.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Guruh <span className="text-rose-500">*</span></Label>
              <Input value={group} onChange={(e) => setGroup(e.target.value)} list="grp-list" placeholder="Guruh nomi" disabled={!course} />
              <datalist id="grp-list">
                {(selCourse?.groups || []).map((g) => <option key={g} value={g} />)}
              </datalist>
            </div>
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
