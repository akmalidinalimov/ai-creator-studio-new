import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Send, FlaskConical, Download, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

type Campaign = {
  id: string;
  name: string;
  enabled: boolean;
  template_uz: string;
  template_ru: string;
  template_en: string;
  button_text_uz: string;
  button_text_ru: string;
  button_text_en: string;
  cadence_days: number[];
  created_at: string;
};

type Delivery = {
  id: string;
  profile_id: string;
  attempt_num: number;
  sent_at: string;
  clicked_at: string | null;
  activated_at: string | null;
  status: string;
  error: string | null;
  profile?: { name: string | null; last_name: string | null; telegram_username: string | null };
};

const renderTpl = (tpl: string, name: string) => (tpl || "").split("{{name}}").join(name || "do'stim");

export default function AdminReengagement() {
  const [counts, setCounts] = useState({ never_logged_in: 0, with_tg: 0, without_tg: 0 });
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [active, setActive] = useState<Campaign | null>(null);
  const [draft, setDraft] = useState<Campaign | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [page, setPage] = useState(0);
  const PAGE = 50;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [sending, setSending] = useState(false);
  const [previewName, setPreviewName] = useState("Aziza");

  const loadCounts = async () => {
    const { data, error } = await supabase.rpc("re_engagement_eligible_count");
    if (error) { toast.error(error.message); return; }
    if (data && data[0]) setCounts(data[0] as any);
  };

  const loadCampaigns = async () => {
    const { data, error } = await supabase.from("re_engagement_campaigns").select("*").order("created_at", { ascending: false });
    if (error) { toast.error(error.message); return; }
    setCampaigns((data || []) as any);
    if (!active && data && data.length) {
      setActive(data[0] as any);
      setDraft(data[0] as any);
    }
  };

  const loadDeliveries = async (campaignId: string) => {
    const { data, error } = await supabase
      .from("re_engagement_deliveries")
      .select("id, profile_id, attempt_num, sent_at, clicked_at, activated_at, status, error")
      .eq("campaign_id", campaignId)
      .order("sent_at", { ascending: false })
      .limit(500);
    if (error) { toast.error(error.message); return; }
    const rows = (data || []) as any[];
    const ids = Array.from(new Set(rows.map((r) => r.profile_id)));
    let profilesMap: Record<string, any> = {};
    if (ids.length) {
      const { data: profs } = await supabase.from("profiles").select("id, name, last_name, telegram_username").in("id", ids);
      (profs || []).forEach((p: any) => { profilesMap[p.id] = p; });
    }
    setDeliveries(rows.map((r) => ({ ...r, profile: profilesMap[r.profile_id] })));
  };

  useEffect(() => {
    loadCounts();
    loadCampaigns();
  }, []);

  useEffect(() => {
    if (active) {
      setDraft(active);
      loadDeliveries(active.id);
    }
  }, [active?.id]);

  const handleCreate = async () => {
    const { data, error } = await supabase
      .from("re_engagement_campaigns")
      .insert({ name: "Yangi kampaniya" })
      .select()
      .single();
    if (error) return toast.error(error.message);
    toast.success("Yaratildi");
    await loadCampaigns();
    setActive(data as any);
  };

  const handleSave = async () => {
    if (!draft) return;
    const { error } = await supabase
      .from("re_engagement_campaigns")
      .update({
        name: draft.name,
        enabled: draft.enabled,
        template_uz: draft.template_uz,
        template_ru: draft.template_ru,
        template_en: draft.template_en,
        button_text_uz: draft.button_text_uz,
        button_text_ru: draft.button_text_ru,
        button_text_en: draft.button_text_en,
        cadence_days: draft.cadence_days,
      })
      .eq("id", draft.id);
    if (error) return toast.error(error.message);
    toast.success("Saqlandi");
    await loadCampaigns();
    setActive(draft);
  };

  const handleTest = async () => {
    if (!draft) return;
    setSending(true);
    try {
      // Save first so the test reflects current draft
      await supabase.from("re_engagement_campaigns").update({
        template_uz: draft.template_uz, template_ru: draft.template_ru, template_en: draft.template_en,
        button_text_uz: draft.button_text_uz, button_text_ru: draft.button_text_ru, button_text_en: draft.button_text_en,
      }).eq("id", draft.id);
      const { data, error } = await supabase.functions.invoke("re-engagement-send", {
        body: { campaign_id: draft.id, mode: "test" },
      });
      if (error) throw error;
      if ((data as any)?.sent) toast.success("✅ Test xabar yuborildi @alikhanova_admin");
      else toast.error(`Test failed: ${JSON.stringify((data as any)?.errors || data)}`);
      if (active) loadDeliveries(active.id);
    } catch (e: any) {
      toast.error(e?.message || String(e));
    } finally {
      setSending(false);
    }
  };

  const handleSendAll = async () => {
    if (!draft || confirmText !== "YUBORISH") return;
    setSending(true);
    try {
      const { data, error } = await supabase.functions.invoke("re-engagement-send", {
        body: { campaign_id: draft.id, mode: "all", confirm: "YUBORISH", attempt_num: 1 },
      });
      if (error) throw error;
      const d = data as any;
      toast.success(`Yuborildi: ${d.sent}/${d.attempted} (xato: ${d.failed})`);
      setConfirmOpen(false);
      setConfirmText("");
      await loadCampaigns();
      if (active) loadDeliveries(active.id);
    } catch (e: any) {
      toast.error(e?.message || String(e));
    } finally {
      setSending(false);
    }
  };

  const filtered = useMemo(() => {
    return deliveries.filter((d) => {
      if (filter === "clicked") return !!d.clicked_at;
      if (filter === "activated") return !!d.activated_at;
      if (filter === "failed") return d.status === "failed";
      if (filter === "sent_only") return d.status === "sent" && !d.clicked_at;
      return true;
    });
  }, [deliveries, filter]);

  const paged = filtered.slice(page * PAGE, (page + 1) * PAGE);
  const totalSent = deliveries.filter((d) => d.status === "sent").length;
  const totalClicked = deliveries.filter((d) => !!d.clicked_at).length;
  const totalActivated = deliveries.filter((d) => !!d.activated_at).length;

  const exportCsv = () => {
    const rows = [["name", "telegram_username", "attempt", "sent_at", "clicked_at", "activated_at", "status"]];
    filtered.forEach((d) => rows.push([
      [d.profile?.name, d.profile?.last_name].filter(Boolean).join(" "),
      d.profile?.telegram_username || "",
      String(d.attempt_num),
      d.sent_at, d.clicked_at || "", d.activated_at || "", d.status,
    ]));
    const csv = rows.map((r) => r.map((c) => `"${(c || "").toString().replaceAll('"', '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `reengagement-${active?.id}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <PageShell>
      <div className="container py-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">🎯 Reaktivatsiya</h1>
          <p className="text-muted-foreground text-sm">Hech qachon kirmagan talabalar uchun Telegram orqali sehrli havola yuborish.</p>
        </div>

        {/* Stats tiles */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Card className="p-4">
            <div className="text-xs text-muted-foreground">Hech qachon kirmagan</div>
            <div className="text-3xl font-bold">{counts.never_logged_in}</div>
          </Card>
          <Card className="p-4">
            <div className="text-xs text-muted-foreground">Telegram bor</div>
            <div className="text-3xl font-bold text-green-600">{counts.with_tg}</div>
          </Card>
          <Card className="p-4">
            <div className="text-xs text-muted-foreground">Telegram yo'q</div>
            <div className="text-3xl font-bold text-muted-foreground">{counts.without_tg}</div>
          </Card>
        </div>

        {/* Campaign list */}
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Kampaniyalar</h2>
            <Button size="sm" onClick={handleCreate}><Plus className="h-4 w-4 mr-1" />Yangi kampaniya</Button>
          </div>
          {campaigns.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">Hech qanday kampaniya yo'q</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow><TableHead>Nom</TableHead><TableHead>Holat</TableHead><TableHead>Yaratilgan</TableHead><TableHead></TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((c) => (
                  <TableRow key={c.id} className={active?.id === c.id ? "bg-muted/50" : ""}>
                    <TableCell>{c.name}</TableCell>
                    <TableCell>{c.enabled ? <Badge className="bg-green-600">🟢 Yoqilgan</Badge> : <Badge variant="secondary">⚪ O'chirilgan</Badge>}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(c.created_at).toLocaleDateString()}</TableCell>
                    <TableCell><Button size="sm" variant="ghost" onClick={() => setActive(c)}>Ochish</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>

        {/* Editor */}
        {draft && (
          <Card className="p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">Tahrirlash</h2>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <Switch checked={draft.enabled} onCheckedChange={(v) => setDraft({ ...draft, enabled: v })} />
                  <Label className="text-sm">Yoqilgan</Label>
                </div>
                {!draft.enabled && (
                  <span className="text-xs text-red-600 flex items-center gap-1"><AlertTriangle className="h-3 w-3" />O'chirilgan — xabar ketmaydi</span>
                )}
              </div>
            </div>

            <div>
              <Label>Nom</Label>
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>

            <div>
              <Label className="mb-1 block">Preview ismi</Label>
              <Input className="max-w-xs" value={previewName} onChange={(e) => setPreviewName(e.target.value)} />
            </div>

            {(["uz", "ru", "en"] as const).map((loc) => (
              <div key={loc} className="grid grid-cols-1 md:grid-cols-2 gap-3 border-t pt-3">
                <div>
                  <Label>Matn ({loc.toUpperCase()})</Label>
                  <Textarea rows={6} value={(draft as any)[`template_${loc}`]} onChange={(e) => setDraft({ ...draft, [`template_${loc}`]: e.target.value } as any)} />
                  <Label className="mt-2 block">Tugma matni ({loc.toUpperCase()})</Label>
                  <Input value={(draft as any)[`button_text_${loc}`]} onChange={(e) => setDraft({ ...draft, [`button_text_${loc}`]: e.target.value } as any)} />
                </div>
                <div>
                  <Label>Live preview</Label>
                  <div className="border rounded-md p-3 bg-muted/30 text-sm whitespace-pre-wrap min-h-[140px]">
                    {renderTpl((draft as any)[`template_${loc}`], previewName)}
                    <div className="mt-3"><Button size="sm" disabled>{(draft as any)[`button_text_${loc}`]}</Button></div>
                  </div>
                </div>
              </div>
            ))}

            <div className="border-t pt-3">
              <Label>Cadence kunlari (vergul bilan)</Label>
              <Input
                value={(draft.cadence_days || []).join(",")}
                onChange={(e) => setDraft({ ...draft, cadence_days: e.target.value.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n)) })}
              />
            </div>

            <div className="flex flex-wrap gap-2 pt-2">
              <Button onClick={handleSave}>Saqlash</Button>
              <Button variant="outline" onClick={handleTest} disabled={sending}>
                <FlaskConical className="h-4 w-4 mr-1" />🧪 Test on me first (@alikhanova_admin)
              </Button>
              <Button
                variant="destructive"
                onClick={() => setConfirmOpen(true)}
                disabled={sending || counts.with_tg === 0}
              >
                <Send className="h-4 w-4 mr-1" />📤 Hammaga yuborish ({counts.with_tg})
              </Button>
            </div>
          </Card>
        )}

        {/* Funnel */}
        {active && (
          <Card className="p-4">
            <h2 className="font-semibold mb-3">Funnel</h2>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div><div className="text-xs text-muted-foreground">Sent</div><div className="text-2xl font-bold">{totalSent}</div></div>
              <div><div className="text-xs text-muted-foreground">Clicked</div><div className="text-2xl font-bold">{totalClicked}</div><div className="text-xs">{totalSent ? Math.round(totalClicked * 100 / totalSent) : 0}%</div></div>
              <div><div className="text-xs text-muted-foreground">Activated</div><div className="text-2xl font-bold">{totalActivated}</div><div className="text-xs">{totalSent ? Math.round(totalActivated * 100 / totalSent) : 0}%</div></div>
            </div>
          </Card>
        )}

        {/* Deliveries */}
        {active && (
          <Card className="p-4">
            <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
              <h2 className="font-semibold">Yuborilganlar ({filtered.length})</h2>
              <div className="flex gap-2">
                <select className="text-sm border rounded px-2 py-1 bg-background" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }}>
                  <option value="all">Hammasi</option>
                  <option value="sent_only">Yuborilgan</option>
                  <option value="clicked">Bosilgan</option>
                  <option value="activated">Faollashgan</option>
                  <option value="failed">Xatolik</option>
                </select>
                <Button size="sm" variant="outline" onClick={exportCsv}><Download className="h-4 w-4 mr-1" />CSV</Button>
              </div>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Ism</TableHead><TableHead>@username</TableHead><TableHead>#</TableHead>
                  <TableHead>Sent</TableHead><TableHead>Clicked</TableHead><TableHead>Activated</TableHead><TableHead>Holat</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paged.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-6">Bo'sh</TableCell></TableRow>
                ) : paged.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>{[d.profile?.name, d.profile?.last_name].filter(Boolean).join(" ") || d.profile_id.slice(0, 8)}</TableCell>
                    <TableCell>{d.profile?.telegram_username ? <a className="text-primary underline" target="_blank" rel="noreferrer" href={`https://t.me/${d.profile.telegram_username}`}>@{d.profile.telegram_username}</a> : "—"}</TableCell>
                    <TableCell>{d.attempt_num}</TableCell>
                    <TableCell className="text-xs">{new Date(d.sent_at).toLocaleString()}</TableCell>
                    <TableCell className="text-xs">{d.clicked_at ? new Date(d.clicked_at).toLocaleString() : "—"}</TableCell>
                    <TableCell className="text-xs">{d.activated_at ? new Date(d.activated_at).toLocaleString() : "—"}</TableCell>
                    <TableCell>
                      {d.activated_at ? <Badge className="bg-green-600">Activated</Badge>
                        : d.clicked_at ? <Badge className="bg-blue-600">Clicked</Badge>
                        : d.status === "failed" ? <Badge variant="destructive">Failed</Badge>
                        : <Badge variant="secondary">Sent</Badge>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {filtered.length > PAGE && (
              <div className="flex justify-between items-center mt-3">
                <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Oldingi</Button>
                <span className="text-xs text-muted-foreground">Sahifa {page + 1} / {Math.ceil(filtered.length / PAGE)}</span>
                <Button size="sm" variant="outline" disabled={(page + 1) * PAGE >= filtered.length} onClick={() => setPage(page + 1)}>Keyingi</Button>
              </div>
            )}
          </Card>
        )}

        {/* Confirm modal */}
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>⚠️ Hammaga yuborish</DialogTitle>
              <DialogDescription>
                Bu <b>{counts.with_tg}</b> ta talabaga real Telegram xabar yuboradi. Bu amalni qaytarib bo'lmaydi.
              </DialogDescription>
            </DialogHeader>
            <div>
              <Label>Tasdiqlash uchun <code>YUBORISH</code> deb yozing:</Label>
              <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="YUBORISH" />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setConfirmOpen(false); setConfirmText(""); }}>Bekor qilish</Button>
              <Button variant="destructive" disabled={confirmText !== "YUBORISH" || sending} onClick={handleSendAll}>
                {sending ? "Yuborilmoqda…" : "Yuborish"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </PageShell>
  );
}
