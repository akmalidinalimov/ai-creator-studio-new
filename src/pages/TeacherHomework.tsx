import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toast } from "sonner";

interface Row {
  id: string; assignment_id: string; user_id: string;
  submitted_text: string; submitted_image_url: string | null;
  submitted_at: string; score: number | null; score_feedback: string | null; is_late: boolean;
  scored_at: string | null;
  user_name: string; user_group: string | null; assignment_title: string; max_score: number;
}

export default function TeacherHomework() {
  const { user, role } = useAuth();
  const [pending, setPending] = useState<Row[]>([]);
  const [scored, setScored] = useState<Row[]>([]);
  const [open, setOpen] = useState<Row | null>(null);
  const [scope, setScope] = useState<string[] | null>(null); // user_ids in scope, null = all (admin)

  useEffect(() => {
    (async () => {
      if (role === "teacher" && user) {
        const { data: gs } = await supabase.from("groups").select("id").eq("teacher_id", user.id);
        const gIds = (gs || []).map((g: any) => g.id);
        if (gIds.length === 0) { setScope([]); return; }
        const { data: ps } = await supabase.from("profiles").select("id").in("group_id", gIds);
        setScope((ps || []).map((p: any) => p.id));
      } else {
        setScope(null);
      }
    })();
  }, [user, role]);

  const load = async () => {
    if (scope === undefined) return;
    let q = supabase.from("homework_submissions").select("*");
    if (scope) {
      if (scope.length === 0) { setPending([]); setScored([]); return; }
      q = q.in("user_id", scope);
    }
    const { data: subs } = await q.order("submitted_at", { ascending: false });
    const all = (subs || []) as any[];
    if (!all.length) { setPending([]); setScored([]); return; }
    const aIds = Array.from(new Set(all.map(s => s.assignment_id)));
    const uIds = Array.from(new Set(all.map(s => s.user_id)));
    const [{ data: assigns }, { data: profs }, { data: groups }] = await Promise.all([
      supabase.from("homework_assignments").select("id, title, max_score").in("id", aIds),
      supabase.from("profiles").select("id, name, last_name, group_id").in("id", uIds),
      supabase.from("groups").select("id, name"),
    ]);
    const aMap = new Map((assigns || []).map((a: any) => [a.id, a]));
    const pMap = new Map((profs || []).map((p: any) => [p.id, p]));
    const gMap = new Map((groups || []).map((g: any) => [g.id, g.name]));
    const enriched: Row[] = all.map((s: any) => {
      const a: any = aMap.get(s.assignment_id) || {};
      const p: any = pMap.get(s.user_id) || {};
      return {
        ...s,
        assignment_title: a.title || "",
        max_score: a.max_score || 10,
        user_name: [p.name, p.last_name].filter(Boolean).join(" ") || "—",
        user_group: p.group_id ? (gMap.get(p.group_id) as string) : null,
      };
    });
    setPending(enriched.filter(r => r.score == null));
    setScored(enriched.filter(r => r.score != null));
  };
  useEffect(() => { load(); }, [scope]);

  const saveScore = async (id: string, score: number, feedback: string) => {
    const max = open?.max_score || 10;
    if (!Number.isFinite(score) || score < 0 || score > max) { toast.error(`Bal 0–${max} bo'lishi kerak`); return; }
    const { error } = await supabase.from("homework_submissions").update({
      score, score_feedback: feedback || null, scored_by: user?.id, scored_at: new Date().toISOString(),
    }).eq("id", id);
    if (error) toast.error(error.message);
    else { toast.success("Baholandi"); setOpen(null); load(); }
  };

  const reset = async (id: string) => {
    const { error } = await supabase.from("homework_submissions").update({
      score: null, scored_by: null, scored_at: null,
    }).eq("id", id);
    if (error) toast.error(error.message);
    else { toast.success("Talabaga qaytarildi"); setOpen(null); load(); }
  };

  return (
    <PageShell>
      <div className="max-w-5xl space-y-5">
        <h1 className="text-3xl font-semibold tracking-tight">📝 Uy vazifalari</h1>
        <Tabs defaultValue="pending">
          <TabsList>
            <TabsTrigger value="pending">Kutilmoqda ({pending.length})</TabsTrigger>
            <TabsTrigger value="scored">Baholangan ({scored.length})</TabsTrigger>
          </TabsList>
          <TabsContent value="pending"><Table rows={pending} onOpen={setOpen} /></TabsContent>
          <TabsContent value="scored"><Table rows={scored} onOpen={setOpen} scored /></TabsContent>
        </Tabs>
      </div>

      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
          {open && <Drawer row={open} onSave={saveScore} onReset={reset} />}
        </SheetContent>
      </Sheet>
    </PageShell>
  );
}

function Table({ rows, onOpen, scored }: { rows: Row[]; onOpen: (r: Row) => void; scored?: boolean }) {
  if (!rows.length) return <Card className="p-8 text-center text-muted-foreground">Baholash uchun vazifa yo'q. Bot orqali talabalarni baholang.</Card>;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs text-muted-foreground">
          <tr>
            <th className="text-left px-3 py-2">Talaba</th>
            <th className="text-left px-3 py-2">Guruh</th>
            <th className="text-left px-3 py-2">Vazifa</th>
            <th className="text-left px-3 py-2">Topshirilgan</th>
            {scored && <th className="text-right px-3 py-2">Bal</th>}
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t">
              <td className="px-3 py-2.5">{r.user_name}</td>
              <td className="px-3 py-2.5 text-muted-foreground">{r.user_group || "—"}</td>
              <td className="px-3 py-2.5">{r.assignment_title}</td>
              <td className="px-3 py-2.5 text-xs">
                {new Date(r.submitted_at).toLocaleString()} {r.is_late && <Badge variant="destructive" className="ml-1">Kech</Badge>}
              </td>
              {scored && <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{r.score}/{r.max_score}</td>}
              <td className="px-3 py-2.5 text-right">
                <Button size="sm" variant="outline" onClick={() => onOpen(r)}>Ko'rish</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function Drawer({ row, onSave, onReset }: { row: Row; onSave: (id: string, s: number, f: string) => void; onReset: (id: string) => void }) {
  const [score, setScore] = useState<string>(row.score?.toString() || "");
  const [fb, setFb] = useState(row.score_feedback || "");
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      if (!row.submitted_image_url) { setImgUrl(null); return; }
      const { data } = await supabase.storage.from("homework_images").createSignedUrl(row.submitted_image_url, 600);
      setImgUrl(data?.signedUrl || null);
    })();
  }, [row.id]);
  return (
    <>
      <SheetHeader><SheetTitle>{row.user_name} — {row.assignment_title}</SheetTitle></SheetHeader>
      <div className="space-y-4 mt-4">
        <div className="text-xs text-muted-foreground">
          {new Date(row.submitted_at).toLocaleString()} {row.is_late && <Badge variant="destructive" className="ml-1">Kech topshirilgan</Badge>}
        </div>
        <Card className="p-4 whitespace-pre-wrap text-sm">{row.submitted_text || <span className="text-muted-foreground">(matn yo'q)</span>}</Card>
        {imgUrl && <img src={imgUrl} alt="submission" className="max-h-96 rounded-lg border" />}
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-1">
            <Label>Bal (0–{row.max_score})</Label>
            <Input type="number" min={0} max={row.max_score} value={score} onChange={(e) => setScore(e.target.value)} />
          </div>
          <div className="col-span-2">
            <Label>Izoh</Label>
            <Textarea rows={2} value={fb} onChange={(e) => setFb(e.target.value)} />
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => onSave(row.id, parseInt(score), fb)}>💾 Saqlash</Button>
          {row.score != null && <Button variant="outline" onClick={() => onReset(row.id)}>🔓 Talabaga qaytarish</Button>}
        </div>
      </div>
    </>
  );
}
