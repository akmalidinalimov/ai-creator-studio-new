import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { PageShell } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Printer } from "lucide-react";

export function AnalyticsShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <PageShell>
      <style>{`@media print {
        nav, header, .no-print { display: none !important; }
        body { background: white !important; }
      }`}</style>
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-3 no-print">
          <div>
            <Link to="/admin/analytics" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
              <ArrowLeft className="h-3 w-3" /> Tahlillar
            </Link>
            <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight mt-1">{title}</h1>
            {subtitle && <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>}
          </div>
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5" /> 📥 PDF
          </Button>
        </div>
        <div className="hidden print:block mb-4">
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="text-xs text-muted-foreground">{new Date().toLocaleString("uz-UZ")}</p>
        </div>
        {children}
      </div>
    </PageShell>
  );
}

export function exportCsv(filename: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(","), ...rows.map((r) => headers.map((h) => escape(r[h])).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
