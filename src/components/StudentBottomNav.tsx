import { Link, useLocation } from "react-router-dom";
import { Home, Trophy, User } from "lucide-react";

export function StudentBottomNav() {
  const loc = useLocation();
  const tabs = [
    { to: "/dashboard", label: "Bosh", icon: Home, match: (p: string) => p === "/dashboard" },
    { to: "/leaderboard", label: "🏆 Reyting", icon: Trophy, match: (p: string) => p.startsWith("/leaderboard") },
    { to: "/settings", label: "Profil", icon: User, match: (p: string) => p.startsWith("/settings") },
  ];
  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-background/95 backdrop-blur border-t border-border">
      <div className="grid grid-cols-3">
        {tabs.map((t) => {
          const active = t.match(loc.pathname);
          const Icon = t.icon;
          return (
            <Link key={t.to} to={t.to}
              className={`flex flex-col items-center justify-center py-2 text-[11px] gap-0.5 ${active ? "text-primary font-semibold" : "text-muted-foreground"}`}>
              <Icon className="h-5 w-5" />
              <span>{t.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
