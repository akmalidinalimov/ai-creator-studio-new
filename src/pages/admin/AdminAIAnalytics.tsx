import { useEffect, useMemo, useState } from "react";
import { PageShell } from "@/components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { Activity, AlertTriangle, Clock, Repeat, Server, Sparkles } from "lucide-react";

type MetricRow = {
  id: string;
  model: string | null;
  attempts: number;
  fallback_used: boolean;
  success: boolean;
  status: number | null;
  latency_ms: number;
  language: string | null;
  created_at: string;
};

type ErrorRow = {
  id: string;
  model: string | null;
  status: number | null;
  error_excerpt: string | null;
  created_at: string;
};

const RANGES = [
  { value: "1", label: "Last 24 hours" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
];

const PALETTE = ["hsl(var(--primary))", "hsl(var(--accent))", "hsl(var(--secondary))", "hsl(var(--muted-foreground))", "hsl(var(--destructive))"];

const fmtBucket = (d: Date, days: number) =>
  days <= 1 ? `${String(d.getHours()).padStart(2, "0")}:00` : `${d.getMonth() + 1}/${d.getDate()}`;

export default function AdminAIAnalytics() {
  const [days, setDays] = useState("7");
  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState<MetricRow[]>([]);
  const [errors, setErrors] = useState<ErrorRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const since = new Date(Date.now() - parseInt(days) * 86400_000).toISOString();
      const [m, e] = await Promise.all([
        supabase.from("ai_chat_metrics").select("*").gte("created_at", since).order("created_at", { ascending: true }).limit(5000),
        supabase.from("ai_chat_errors").select("*").gte("created_at", since).order("created_at", { ascending: false }).limit(50),
      ]);
      if (cancelled) return;
      setMetrics((m.data as MetricRow[]) ?? []);
      setErrors((e.data as ErrorRow[]) ?? []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [days]);

  const stats = useMemo(() => {
    const total = metrics.length;
    const errs = metrics.filter((r) => !r.success).length;
    const fallbacks = metrics.filter((r) => r.success && r.fallback_used).length;
    const successLatencies = metrics.filter((r) => r.success).map((r) => r.latency_ms);
    const avgLatency = successLatencies.length
      ? Math.round(successLatencies.reduce((a, b) => a + b, 0) / successLatencies.length)
      : 0;
    const sorted = [...successLatencies].sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
    const errorRate = total ? (errs / total) * 100 : 0;
    return { total, errs, fallbacks, avgLatency, p95, errorRate };
  }, [metrics]);

  const timeseries = useMemo(() => {
    const d = parseInt(days);
    const buckets = d <= 1 ? 24 : d;
    const bucketMs = (d * 86400_000) / buckets;
    const start = Date.now() - d * 86400_000;
    const arr = Array.from({ length: buckets }, (_, i) => {
      const t = new Date(start + i * bucketMs);
      return { t, label: fmtBucket(t, d), requests: 0, errors: 0, latencySum: 0, latencyCount: 0 };
    });
    for (const r of metrics) {
      const idx = Math.min(buckets - 1, Math.max(0, Math.floor((new Date(r.created_at).getTime() - start) / bucketMs)));
      arr[idx].requests++;
      if (!r.success) arr[idx].errors++;
      else { arr[idx].latencySum += r.latency_ms; arr[idx].latencyCount++; }
    }
    return arr.map((b) => ({
      label: b.label,
      requests: b.requests,
      errors: b.errors,
      errorRate: b.requests ? Math.round((b.errors / b.requests) * 1000) / 10 : 0,
      avgLatency: b.latencyCount ? Math.round(b.latencySum / b.latencyCount) : 0,
    }));
  }, [metrics, days]);

  const byModel = useMemo(() => {
    const map = new Map<string, { model: string; total: number; success: number; errors: number; fallback: number; latencySum: number; latencyCount: number }>();
    for (const r of metrics) {
      const key = r.model || "unknown";
      const cur = map.get(key) ?? { model: key, total: 0, success: 0, errors: 0, fallback: 0, latencySum: 0, latencyCount: 0 };
      cur.total++;
      if (r.success) { cur.success++; cur.latencySum += r.latency_ms; cur.latencyCount++; }
      else cur.errors++;
      if (r.fallback_used) cur.fallback++;
      map.set(key, cur);
    }
    return Array.from(map.values()).map((m) => ({
      ...m,
      avgLatency: m.latencyCount ? Math.round(m.latencySum / m.latencyCount) : 0,
      shortName: m.model.split("/").pop() || m.model,
    })).sort((a, b) => b.total - a.total);
  }, [metrics]);

  const statusBreakdown = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of metrics.filter((x) => !x.success)) {
      const k = r.status ? `HTTP ${r.status}` : "Internal";
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return Array.from(map.entries()).map(([name, value]) => ({ name, value }));
  }, [metrics]);

  return (
    <PageShell>
      <div className="container py-8 space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">AI Assistant Analytics</h1>
            <p className="text-sm text-muted-foreground mt-1">Study-assistant request volume, latency, fallbacks, and errors.</p>
          </div>
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              {RANGES.map((r) => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard icon={<Activity className="size-4" />} label="Total requests" value={stats.total.toLocaleString()} />
            <StatCard icon={<Sparkles className="size-4" />} label="Avg latency" value={`${stats.avgLatency} ms`} />
            <StatCard icon={<Clock className="size-4" />} label="p95 latency" value={`${stats.p95} ms`} />
            <StatCard icon={<Repeat className="size-4" />} label="Fallback used" value={stats.fallbacks.toLocaleString()} />
            <StatCard icon={<AlertTriangle className="size-4" />} label="Error rate" value={`${stats.errorRate.toFixed(1)}%`} tone={stats.errorRate > 5 ? "warn" : "ok"} />
          </div>
        )}

        <div className="grid lg:grid-cols-2 gap-4">
          <ChartCard title="Requests over time">
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={timeseries}>
                <defs>
                  <linearGradient id="reqs" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.5} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} allowDecimals={false} />
                <Tooltip contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                <Area type="monotone" dataKey="requests" stroke="hsl(var(--primary))" fill="url(#reqs)" />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Average latency over time (ms)">
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={timeseries}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <Tooltip contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                <Line type="monotone" dataKey="avgLatency" stroke="hsl(var(--accent))" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Error rate over time (%)">
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={timeseries}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} unit="%" />
                <Tooltip contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                <Line type="monotone" dataKey="errorRate" stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Failure status codes">
            {statusBreakdown.length === 0 ? (
              <div className="h-[240px] flex items-center justify-center text-sm text-muted-foreground">No errors in this range 🎉</div>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie data={statusBreakdown} dataKey="value" nameKey="name" outerRadius={90} label>
                    {statusBreakdown.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}
                  </Pie>
                  <Legend />
                  <Tooltip contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </ChartCard>
        </div>

        <ChartCard title="Per-model breakdown">
          {byModel.length === 0 ? (
            <div className="h-32 flex items-center justify-center text-sm text-muted-foreground">No data yet.</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={byModel}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="shortName" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} allowDecimals={false} />
                  <Tooltip contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                  <Legend />
                  <Bar dataKey="success" name="Success" stackId="a" fill="hsl(var(--primary))" />
                  <Bar dataKey="errors" name="Errors" stackId="a" fill="hsl(var(--destructive))" />
                </BarChart>
              </ResponsiveContainer>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b border-border">
                      <th className="py-2 pr-4">Model</th>
                      <th className="py-2 pr-4">Total</th>
                      <th className="py-2 pr-4">Success</th>
                      <th className="py-2 pr-4">Errors</th>
                      <th className="py-2 pr-4">Fallback used</th>
                      <th className="py-2 pr-4">Avg latency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byModel.map((m) => (
                      <tr key={m.model} className="border-b border-border/50">
                        <td className="py-2 pr-4 font-mono text-xs">{m.model}</td>
                        <td className="py-2 pr-4">{m.total}</td>
                        <td className="py-2 pr-4">{m.success}</td>
                        <td className="py-2 pr-4">{m.errors}</td>
                        <td className="py-2 pr-4">{m.fallback}</td>
                        <td className="py-2 pr-4">{m.avgLatency} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </ChartCard>

        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Server className="size-4" /> Recent errors</CardTitle></CardHeader>
          <CardContent>
            {errors.length === 0 ? (
              <div className="text-sm text-muted-foreground">No errors logged in this range.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b border-border">
                      <th className="py-2 pr-4">When</th>
                      <th className="py-2 pr-4">Model</th>
                      <th className="py-2 pr-4">Status</th>
                      <th className="py-2 pr-4">Excerpt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {errors.map((e) => (
                      <tr key={e.id} className="border-b border-border/50">
                        <td className="py-2 pr-4 whitespace-nowrap">{new Date(e.created_at).toLocaleString()}</td>
                        <td className="py-2 pr-4 font-mono text-xs">{e.model || "—"}</td>
                        <td className="py-2 pr-4">{e.status ?? "—"}</td>
                        <td className="py-2 pr-4 text-xs text-muted-foreground max-w-[420px] truncate">{e.error_excerpt}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
}

const StatCard = ({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone?: "ok" | "warn" }) => (
  <Card>
    <CardContent className="p-4">
      <div className="flex items-center justify-between text-muted-foreground">
        <span className="text-xs">{label}</span>
        {icon}
      </div>
      <div className="mt-2 flex items-end gap-2">
        <div className="text-2xl font-semibold tracking-tight">{value}</div>
        {tone === "warn" && <Badge variant="destructive" className="text-[10px]">High</Badge>}
      </div>
    </CardContent>
  </Card>
);

const ChartCard = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <Card>
    <CardHeader className="pb-2"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
    <CardContent>{children}</CardContent>
  </Card>
);
