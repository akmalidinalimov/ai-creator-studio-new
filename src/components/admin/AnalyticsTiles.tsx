import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { BarChart3, Radio } from "lucide-react";

export function AnalyticsTiles() {
  const [online, setOnline] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const fetchOnline = async () => {
      const { data } = await supabase.rpc("online_now_count" as any);
      if (!cancelled) setOnline(typeof data === "number" ? data : 0);
    };
    fetchOnline();
    const t = setInterval(fetchOnline, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return (
    <div className="grid sm:grid-cols-2 gap-3">
      <Card className="p-4 shadow-soft flex items-center gap-3">
        <Radio className="h-5 w-5 text-rose-500 animate-pulse" />
        <div>
          <div className="text-xs text-muted-foreground">🔴 Hozir onlayn</div>
          <div className="text-2xl font-semibold tabular-nums">{online ?? "—"}</div>
        </div>
      </Card>
      <Link to="/admin/analytics" className="block">
        <Card className="p-4 shadow-soft flex items-center gap-3 hover:border-foreground/30 transition-colors h-full">
          <BarChart3 className="h-5 w-5 text-muted-foreground" />
          <div>
            <div className="font-semibold">📊 Chuqur tahlillar</div>
            <div className="text-xs text-muted-foreground">Voronka, kohort, dars, heatmap, o'qituvchilar</div>
          </div>
        </Card>
      </Link>
    </div>
  );
}
