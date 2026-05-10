import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Moon } from "lucide-react";

type Row = {
  id: string;
  name: string;
  telegram_username: string | null;
  telegram_id?: number | null;
  days_since: number | null;
};

type BucketKey = "3" | "4" | "5" | "6" | "7" | "inf";
const BUCKET_ORDER: BucketKey[] = ["3", "4", "5", "6", "7", "inf"];

export function InactiveStudentsList({ rows }: { rows: Row[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Record<BucketKey, boolean>>({
    "3": true, "4": true, "5": true, "6": true, "7": true, inf: true,
  });

  const buckets = useMemo(() => {
    const map: Record<BucketKey, Row[]> = { "3": [], "4": [], "5": [], "6": [], "7": [], inf: [] };
    rows.forEach((r) => {
      const d = r.days_since;
      if (d == null || d < 3) return;
      if (d > 7) map.inf.push(r);
      else map[String(d) as BucketKey].push(r);
    });
    BUCKET_ORDER.forEach((k) => {
      map[k].sort((a, b) => (b.days_since || 0) - (a.days_since || 0));
    });
    return map;
  }, [rows]);

  const totalShown = BUCKET_ORDER.reduce((s, k) => s + buckets[k].length, 0);

  const bucketLabel = (k: BucketKey) =>
    k === "inf"
      ? t("admin.dashboard.inactiveList.bucketOver7", { defaultValue: "7+ kun ∞" })
      : t("admin.dashboard.inactiveList.bucket", { n: k, defaultValue: `${k} kun` });

  const daysParen = (d: number | null) =>
    d == null ? "" : d > 7 ? "∞" : t("admin.dashboard.inactiveList.daysShort", { n: d, defaultValue: `${d} kun` });

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Moon className="h-4 w-4 text-amber-600" />
          <h3 className="font-semibold text-sm">
            {t("admin.dashboard.inactiveList.title", { defaultValue: "Faol bo'lmagan o'quvchilar (3+ kun)" })}
          </h3>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">{totalShown}</span>
      </div>

      {totalShown === 0 ? (
        <div className="text-sm text-muted-foreground py-6 text-center">
          {t("admin.dashboard.inactiveList.empty", { defaultValue: "Hammasi faol 🎉" })}
        </div>
      ) : (
        <div className="space-y-2">
          {BUCKET_ORDER.map((k) => {
            const list = buckets[k];
            const isOpen = open[k];
            return (
              <div key={k} className="border rounded-md">
                <button
                  type="button"
                  onClick={() => setOpen((o) => ({ ...o, [k]: !o[k] }))}
                  className="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/40 transition text-left"
                >
                  <div className="flex items-center gap-2 text-sm">
                    {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    <span className="font-medium">{bucketLabel(k)}</span>
                  </div>
                  <span className="text-xs tabular-nums text-muted-foreground">{list.length}</span>
                </button>
                {isOpen && (
                  <div className="border-t">
                    {list.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-muted-foreground">0</div>
                    ) : (
                      <ul className="divide-y">
                        {list.map((r) => (
                          <li key={r.id} className="px-3 py-2 flex items-center justify-between gap-3 text-sm">
                            <div className="min-w-0 truncate">
                              <span className="font-medium">{r.name}</span>
                              {r.telegram_username ? (
                                <a
                                  href={`https://t.me/${r.telegram_username}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="ml-2 text-primary hover:underline"
                                >@{r.telegram_username}</a>
                              ) : (
                                <span className="ml-2 text-muted-foreground">—</span>
                              )}
                            </div>
                            <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                              ({daysParen(r.days_since)})
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
