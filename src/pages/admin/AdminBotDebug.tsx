import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight, Check, X } from "lucide-react";

interface InboxRow {
  id: number;
  received_at: string;
  update_type: string | null;
  chat_id: number | null;
  chat_type: string | null;
  chat_title: string | null;
  message_thread_id: number | null;
  message_id: number | null;
  from_user_id: number | null;
  from_username: string | null;
  text_preview: string | null;
  raw_update: any;
  resolution: any;
}

const Tick = ({ ok }: { ok: boolean | undefined | null }) =>
  ok ? <Check className="h-4 w-4 text-emerald-600 inline" /> : <X className="h-4 w-4 text-rose-500 inline" />;

export default function AdminBotDebug() {
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [kpi, setKpi] = useState<{ h1: number; h24: number; gm1h: number; det24: number }>({ h1: 0, h24: 0, gm1h: 0, det24: 0 });

  const load = async () => {
    const { data } = await supabase
      .from("webhook_inbox" as any)
      .select("*")
      .order("received_at", { ascending: false })
      .limit(100);
    setRows((data as any) || []);
    const now = Date.now();
    const list = (data as any[]) || [];
    const h1 = list.filter((r) => now - new Date(r.received_at).getTime() < 3600_000).length;
    const h24 = list.filter((r) => now - new Date(r.received_at).getTime() < 86400_000).length;
    const gm1h = list.filter((r) => (r.chat_type === "supergroup" || r.chat_type === "group") && now - new Date(r.received_at).getTime() < 3600_000).length;
    const det24 = list.filter((r) => r.resolution?.homework_detector_fired && now - new Date(r.received_at).getTime() < 86400_000).length;
    setKpi({ h1, h24, gm1h, det24 });
    setLoading(false);
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const toggle = (id: number) => {
    setExpanded((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const fmt = (iso: string) => new Date(iso).toLocaleTimeString();

  return (
    <PageShell>
      <div className="space-y-6">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Bot debug</h1>
            <p className="text-muted-foreground mt-1">Live Telegram webhook inbox + homework pipeline resolution. Auto-refresh 5s.</p>
          </div>
          <Button asChild variant="outline" size="sm"><Link to="/admin/dashboard">Back</Link></Button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="p-4"><div className="text-xs text-muted-foreground">Updates / 1h</div><div className="text-2xl font-semibold">{kpi.h1}</div></Card>
          <Card className="p-4"><div className="text-xs text-muted-foreground">Updates / 24h</div><div className="text-2xl font-semibold">{kpi.h24}</div></Card>
          <Card className="p-4"><div className="text-xs text-muted-foreground">Group msgs / 1h</div><div className="text-2xl font-semibold">{kpi.gm1h}</div></Card>
          <Card className="p-4"><div className="text-xs text-muted-foreground">HW detector / 24h</div><div className="text-2xl font-semibold">{kpi.det24}</div></Card>
        </div>

        <Card className="overflow-hidden shadow-soft">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs">
                <tr>
                  <th className="text-left p-2 w-8"></th>
                  <th className="text-left p-2">Received</th>
                  <th className="text-left p-2">Chat</th>
                  <th className="text-left p-2">Thread</th>
                  <th className="text-left p-2">From</th>
                  <th className="text-left p-2">Text</th>
                  <th className="text-left p-2">Resolution</th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">Loading…</td></tr>}
                {!loading && rows.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">No webhook events yet.</td></tr>}
                {rows.map((r) => {
                  const open = expanded.has(r.id);
                  const res = r.resolution || {};
                  return (
                    <>
                      <tr key={r.id} className="border-t hover:bg-muted/20 cursor-pointer" onClick={() => toggle(r.id)}>
                        <td className="p-2 align-top">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
                        <td className="p-2 align-top text-xs text-muted-foreground" title={new Date(r.received_at).toLocaleString()}>{fmt(r.received_at)}</td>
                        <td className="p-2 align-top">
                          <div className="text-xs"><Badge variant="outline">{r.chat_type || "—"}</Badge></div>
                          <div className="text-xs text-muted-foreground">{r.chat_title || r.chat_id}</div>
                        </td>
                        <td className="p-2 align-top text-xs">{r.message_thread_id || "—"}</td>
                        <td className="p-2 align-top text-xs">
                          <div>{r.from_username ? `@${r.from_username}` : (r.from_user_id || "—")}</div>
                        </td>
                        <td className="p-2 align-top text-xs max-w-[220px] truncate">{(r.text_preview || "").slice(0, 60)}</td>
                        <td className="p-2 align-top text-xs whitespace-nowrap">
                          <span title="chat→group"><Tick ok={!!res.resolved_chat_to_group_id} /></span>{" "}
                          <span title="thread→module"><Tick ok={!!res.resolved_thread_to_module_id} /></span>{" "}
                          <span title="profile"><Tick ok={!!res.resolved_profile_id} /></span>{" "}
                          <span title="assignment"><Tick ok={!!res.matched_assignment_id} /></span>{" "}
                          <span title="detector fired"><Tick ok={!!res.homework_detector_fired} /></span>{" "}
                          <span title="student DM"><Tick ok={!!res.student_dm_sent} /></span>{" "}
                          <span title="teacher DM"><Tick ok={!!res.teacher_dm_sent} /></span>
                          {res.skip_reason && <span className="ml-2 text-rose-600">{res.skip_reason}</span>}
                        </td>
                      </tr>
                      {open && (
                        <tr key={r.id + "-d"} className="border-t bg-muted/10">
                          <td colSpan={7} className="p-4 space-y-3">
                            <div>
                              <div className="text-xs font-semibold mb-1">resolution</div>
                              <pre className="text-xs bg-background p-3 rounded border overflow-x-auto">{JSON.stringify(r.resolution, null, 2)}</pre>
                            </div>
                            <div>
                              <div className="text-xs font-semibold mb-1">raw_update</div>
                              <pre className="text-xs bg-background p-3 rounded border overflow-x-auto">{JSON.stringify(r.raw_update, null, 2)}</pre>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </PageShell>
  );
}
