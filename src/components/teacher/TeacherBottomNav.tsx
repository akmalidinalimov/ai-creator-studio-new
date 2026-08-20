import { Link, useLocation } from "react-router-dom";
import { Home, ClipboardCheck, Users, BarChart3, BookOpen, type LucideIcon } from "lucide-react";
import { usePendingGrading } from "@/hooks/usePendingGrading";

/**
 * TeacherBottomNav — the teacher Mini App's only navigation chrome (TeacherShell renders
 * no desktop TopNav/sidebar). Cloned from `StudentBottomNav`: same fixed bottom bar,
 * `env(safe-area-inset-bottom)` padding, `grid grid-cols-5 h-14`, and active-route styling
 * (`text-primary font-semibold`). Uzbek labels.
 *
 * Bosh + Baholash are live in Phase 1; Guruhlar + Statistika went live in Phase 2 (Tasks 1 + 3);
 * Darslar (browse + watch the course you teach, review-only — no lesson_progress writes) went
 * live alongside TeacherLessons.tsx. Same `BookOpen` icon as the student `StudentBottomNav`'s
 * Darslar tab, for label/icon consistency across the two shells. Baholash carries a coral
 * (`bg-cta`) count badge fed by `usePendingGrading().count`.
 *
 * NOTE: unlike `StudentBottomNav` this is NOT `md:hidden` — the teacher shell has no other nav,
 * so the bar must stay visible at every width (the shell is mobile-first / `max-w-2xl` anyway).
 * 5 tabs at `text-[11px]` labels still fit without wrapping/overflow on a 360px-wide screen.
 */
type Tab = {
  to: string;
  label: string;
  icon: LucideIcon;
  match: (p: string) => boolean;
  badge?: number;
  disabled?: boolean;
};

export function TeacherBottomNav() {
  const loc = useLocation();
  const { count } = usePendingGrading();

  const tabs: Tab[] = [
    { to: "/tg/teacher", label: "Bosh", icon: Home, match: (p) => p === "/tg/teacher" },
    {
      to: "/tg/teacher/grade",
      label: "Baholash",
      icon: ClipboardCheck,
      match: (p) => p.startsWith("/tg/teacher/grade"),
      badge: count,
    },
    {
      to: "/tg/teacher/groups",
      label: "Guruhlar",
      icon: Users,
      match: (p) => p.startsWith("/tg/teacher/groups"),
    },
    {
      to: "/tg/teacher/lessons",
      label: "Darslar",
      icon: BookOpen,
      match: (p) => p.startsWith("/tg/teacher/lessons"),
    },
    {
      to: "/tg/teacher/stats",
      label: "Statistika",
      icon: BarChart3,
      match: (p) => p.startsWith("/tg/teacher/stats"),
    },
  ];

  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-30 bg-background/95 backdrop-blur border-t border-border animate-fade-in"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Teacher navigation"
    >
      <div className="grid grid-cols-5 h-14">
        {tabs.map((t) => {
          const Icon = t.icon;

          // Phase-2 tab: dimmed, non-navigable, tagged "tez orada" (a plain <div>, no <Link>).
          if (t.disabled) {
            return (
              <div
                key={t.to}
                aria-disabled="true"
                title="Tez orada"
                className="flex min-w-0 flex-col items-center justify-center gap-0.5 px-0.5 text-[11px] min-h-[44px] text-muted-foreground/40 cursor-not-allowed select-none"
              >
                <Icon className="h-6 w-6" aria-hidden />
                <span className="w-full truncate text-center leading-none">{t.label}</span>
                <span className="text-[8px] font-semibold uppercase leading-none tracking-wide">tez orada</span>
              </div>
            );
          }

          const active = t.match(loc.pathname);
          return (
            <Link
              key={t.to}
              to={t.to}
              className={`flex min-w-0 flex-col items-center justify-center gap-0.5 px-0.5 text-[11px] min-h-[44px] transition-transform active:scale-[0.96] ${
                active ? "text-primary font-semibold" : "text-muted-foreground"
              }`}
              aria-current={active ? "page" : undefined}
            >
              <span className="relative inline-flex">
                <Icon className="h-6 w-6" aria-hidden />
                {typeof t.badge === "number" && t.badge > 0 && (
                  <span
                    className="absolute -top-1.5 -right-2 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-cta px-1 text-[9px] font-bold text-cta-foreground ring-2 ring-background"
                    aria-label={`${t.badge} ta baholash kutilmoqda`}
                  >
                    {t.badge > 99 ? "99+" : t.badge}
                  </span>
                )}
              </span>
              <span className="w-full truncate text-center">{t.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
