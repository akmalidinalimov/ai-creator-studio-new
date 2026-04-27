import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight, Search } from "lucide-react";

interface AuditRow {
  id: string;
  actor_user_id: string;
  action: string;
  target_user_id: string | null;
  target_resource_type: string | null;
  target_resource_id: string | null;
  details: any;
  created_at: string;
}

export default function AdminAudit() {
  const { t } = useTranslation();
  const timeAgo = (iso: string): string => {
    const ms = Date.now() - new Date(iso).getTime();
    const m = Math.floor(ms / 60_000);
    if (m < 1) return t("admin.audit.timeAgo.justNow");
    if (m < 60) return t("admin.audit.timeAgo.minutes", { n: m });
    const h = Math.floor(m / 60);
    if (h < 24) return t("admin.audit.timeAgo.hours", { n: h });
    const d = Math.floor(h / 24);
    return t("admin.audit.timeAgo.days", { n: d });
  };
  const actionLabel = (a: string) => {
    const k = `admin.audit.actions.${a}`;
    const v = t(k);
    return v === k ? a : v;
  };
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [profileMap, setProfileMap] = useState<Record<string, { name: string | null; email: string }>>({});
  const [actorFilter, setActorFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [days, setDays] = useState<string>("30");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const since = new Date(Date.now() - parseInt(days) * 86400_000).toISOString();
      const { data } = await supabase
        .from("admin_actions")
        .select("*")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(500);
      const list = (data || []) as AuditRow[];
      setRows(list);
      const userIds = Array.from(new Set(list.flatMap((r) => [r.actor_user_id, r.target_user_id].filter(Boolean) as string[])));
      if (userIds.length) {
        const { data: profs } = await supabase.from("profiles").select("id, name, email").in("id", userIds);
        const map: Record<string, { name: string | null; email: string }> = {};
        (profs || []).forEach((p: any) => { map[p.id] = { name: p.name, email: p.email }; });
        setProfileMap(map);
      }
      setLoading(false);
    })();
  }, [days]);

  const actors = useMemo(() => {
    const set = new Set(rows.map((r) => r.actor_user_id));
    return Array.from(set);
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (actorFilter !== "all" && r.actor_user_id !== actorFilter) return false;
      if (q) {
        const actor = profileMap[r.actor_user_id]?.email || "";
        const target = r.target_user_id ? profileMap[r.target_user_id]?.email || "" : "";
        return r.action.includes(q) || actor.toLowerCase().includes(q) || target.toLowerCase().includes(q);
      }
      return true;
    });
  }, [rows, actorFilter, search, profileMap]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <PageShell>
      <div className="space-y-6">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Audit log</h1>
            <p className="text-muted-foreground mt-1">Every admin action, with full payload.</p>
          </div>
          <Button asChild variant="outline" size="sm"><Link to="/admin/dashboard">← Dashboard</Link></Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search by action, actor email, target email…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
          </div>
          <Select value={actorFilter} onValueChange={setActorFilter}>
            <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actors</SelectItem>
              {actors.map((id) => (
                <SelectItem key={id} value={id}>{profileMap[id]?.email || id.slice(0, 8)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Last 24h</SelectItem>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Card className="overflow-hidden shadow-soft">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs">
                <tr>
                  <th className="text-left p-3 w-8"></th>
                  <th className="text-left p-3">When</th>
                  <th className="text-left p-3">Actor</th>
                  <th className="text-left p-3">Action</th>
                  <th className="text-left p-3">Target</th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">Loading…</td></tr>}
                {!loading && filtered.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">No actions in this range.</td></tr>}
                {filtered.map((r) => {
                  const open = expanded.has(r.id);
                  const actor = profileMap[r.actor_user_id];
                  const target = r.target_user_id ? profileMap[r.target_user_id] : null;
                  return (
                    <>
                      <tr key={r.id} className="border-t hover:bg-muted/20 cursor-pointer" onClick={() => toggle(r.id)}>
                        <td className="p-3 align-top">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</td>
                        <td className="p-3 align-top text-xs text-muted-foreground" title={new Date(r.created_at).toLocaleString()}>{timeAgo(r.created_at)}</td>
                        <td className="p-3 align-top">
                          <div className="font-medium">{actor?.name || actor?.email || r.actor_user_id.slice(0, 8)}</div>
                          {actor?.name && <div className="text-xs text-muted-foreground">{actor.email}</div>}
                        </td>
                        <td className="p-3 align-top"><Badge variant="secondary">{ACTION_LABELS[r.action] || r.action}</Badge></td>
                        <td className="p-3 align-top text-xs text-muted-foreground">
                          {target ? (target.email) : (r.target_resource_type ? `${r.target_resource_type}:${r.target_resource_id?.slice(0,8)}` : "—")}
                        </td>
                      </tr>
                      {open && (
                        <tr key={r.id + "-d"} className="border-t bg-muted/10">
                          <td colSpan={5} className="p-4">
                            <pre className="text-xs bg-background p-3 rounded border overflow-x-auto">{JSON.stringify(r.details, null, 2)}</pre>
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
