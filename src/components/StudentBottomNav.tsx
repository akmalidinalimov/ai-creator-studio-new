import { Link, useLocation } from "react-router-dom";
import { Home, Trophy, User, BookOpen, ClipboardCheck } from "lucide-react";
import { usePendingHomework } from "@/hooks/usePendingHomework";

export function StudentBottomNav() {
  const loc = useLocation();
  const pendingHomework = usePendingHomework();
  // Always visible, including on lesson pages (Fix 3 — the nav used to disappear on /lesson/*,
  // leaving students with no way back to Darslar/Bosh short of the browser/Telegram back
  // gesture). LessonPage.tsx reserves bottom padding so this fixed nav never covers its CTAs.

  const tabs = [
    { to: "/dashboard", label: "Bosh", icon: Home, match: (p: string) => p === "/dashboard" },
    { to: "/lessons", label: "Darslar", icon: BookOpen, match: (p: string) => p.startsWith("/lessons") },
    { to: "/homework", label: "Vazifa", icon: ClipboardCheck, match: (p: string) => p.startsWith("/homework"), dot: pendingHomework },
    { to: "/leaderboard", label: "Reyting", icon: Trophy, match: (p: string) => p.startsWith("/leaderboard") },
    {
      to: "/profile",
      label: "Profil",
      icon: User,
      match: (p: string) =>
        p.startsWith("/profile") || p.startsWith("/settings") || p.startsWith("/badges") || p.startsWith("/activity"),
    },
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
              <span className="relative inline-flex">
                <Icon className="h-6 w-6" aria-hidden />
                {t.dot && (
                  <span
                    className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary ring-2 ring-background"
                    aria-hidden
                  />
                )}
              </span>
              <span>{t.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
