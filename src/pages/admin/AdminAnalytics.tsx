import { Link } from "react-router-dom";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { TrendingDown, Users, BookOpen, Calendar, GraduationCap } from "lucide-react";

const tiles = [
  { to: "/admin/analytics/funnel", icon: TrendingDown, title: "Konversiya voronkasi", sub: "Ro'yxatdan o'tishdan kursni tugatishgacha" },
  { to: "/admin/analytics/cohorts", icon: Users, title: "Kohortalar saqlanishi", sub: "Hafta-haftaga retention" },
  { to: "/admin/analytics/lessons", icon: BookOpen, title: "Darslar dropoff", sub: "Qaysi darsda ko'pchilik to'xtaydi" },
  { to: "/admin/analytics/heatmap", icon: Calendar, title: "O'qish issiqligi", sub: "Hafta×soat aktivligi" },
  { to: "/admin/analytics/teachers", icon: GraduationCap, title: "O'qituvchilar sifati", sub: "Composite quality score" },
];

export default function AdminAnalytics() {
  return (
    <PageShell>
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">📊 Chuqur tahlillar</h1>
          <p className="text-sm text-muted-foreground mt-1">Ma'lumotlarga asoslangan qarorlar uchun.</p>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {tiles.map((t) => (
            <Link key={t.to} to={t.to} className="block group">
              <Card className="p-5 h-full hover:border-foreground/30 transition-colors shadow-soft">
                <t.icon className="h-5 w-5 text-muted-foreground mb-3 group-hover:text-foreground" />
                <div className="font-semibold">{t.title}</div>
                <div className="text-xs text-muted-foreground mt-1">{t.sub}</div>
              </Card>
            </Link>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Ma'lumotlar har kuni 03:00 (Toshkent) da yangilanadi.</p>
      </div>
    </PageShell>
  );
}
