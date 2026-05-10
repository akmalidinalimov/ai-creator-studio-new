import { Link, useLocation } from "react-router-dom";
import { Home, Trophy, User, Award, BarChart3 } from "lucide-react";

export function StudentBottomNav() {
  const loc = useLocation();
  // Hide on lesson pages so the video has more room (and avoids overlap with sticky next-lesson CTA).
  if (loc.pathname.startsWith("/lesson/")) return null;

  const tabs = [
    { to: "/dashboard", label: "Dars", icon: Home, match: (p: string) => p === "/dashboard" },
    { to: "/activity", label: "Statistika", icon: BarChart3, match: (p: string) => p.startsWith("/activity") },
    { to: "/badges", label: "Nishon", icon: Award, match: (p: string) => p.startsWith("/badges") },
    { to: "/leaderboard", label: "Reyting", icon: Trophy, match: (p: string) => p.startsWith("/leaderboard") },
    { to: "/settings", label: "Profil", icon: User, match: (p: string) => p.startsWith("/settings") },
  ];

  return (
    <nav
      className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-background/95 backdrop-blur border-t border-border animate-fade-in"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Student navigation"
    >
      <div className="grid grid-cols-5 h-14">
        {tabs.map((t) => {
          const active = t.match(loc.pathname);
          const Icon = t.icon;
          return (
            <Link
              key={t.to}
              to={t.to}
              className={`flex flex-col items-center justify-center gap-0.5 text-[11px] min-h-[44px] transition-transform active:scale-[0.96] ${
                active ? "text-primary font-semibold" : "text-muted-foreground"
              }`}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="h-6 w-6" aria-hidden />
              <span>{t.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
