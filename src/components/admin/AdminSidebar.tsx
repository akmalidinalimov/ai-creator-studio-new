import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import {
  LayoutDashboard,
  BookOpen,
  Users,
  UsersRound,
  ClipboardList,
  History,
  Bell,
  MessageSquare,
  BarChart3,
  Trophy,
  Settings,
  FileText,
  Rocket,
  GraduationCap,
  Sparkles,
  PanelLeftClose,
  PanelLeft,
  Menu,
} from "lucide-react";

type Item = {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** true → only admins see it; false/undefined → all staff (admin + teacher) */
  adminOnly?: boolean;
  /** matcher for the active state */
  match?: (p: string) => boolean;
};

type Section = { heading: string; items: Item[] };

const SECTIONS: Section[] = [
  {
    heading: "Asosiy",
    items: [
      { to: "/admin/dashboard", label: "Boshqaruv paneli", icon: LayoutDashboard, match: (p) => p === "/admin/dashboard" || p === "/admin" },
      { to: "/admin/courses", label: "Kurslar", icon: BookOpen, adminOnly: true, match: (p) => p.startsWith("/admin/courses") },
    ],
  },
  {
    heading: "Talabalar",
    items: [
      { to: "/admin/users", label: "Foydalanuvchilar", icon: Users, match: (p) => p.startsWith("/admin/users") },
      { to: "/admin/groups", label: "Guruhlar", icon: UsersRound, adminOnly: true, match: (p) => p.startsWith("/admin/groups") },
      { to: "/admin/homework", label: "Vazifalar", icon: ClipboardList, adminOnly: true, match: (p) => p === "/admin/homework" },
      { to: "/teacher/homework", label: "Bahalar tarixi", icon: History, match: (p) => p.startsWith("/teacher/homework") },
    ],
  },
  {
    heading: "Faollik",
    items: [
      { to: "/admin/engagement", label: "Faollik va eslatmalar", icon: Bell, adminOnly: true, match: (p) => p.startsWith("/admin/engagement") || p.startsWith("/admin/nudges") || p.startsWith("/admin/reengagement") },
      { to: "/admin/teacher-stats", label: "Teacher Statistics", icon: GraduationCap, adminOnly: true, match: (p) => p.startsWith("/admin/teacher-stats") },
      { to: "/admin/notifications", label: "Bildirishnomalar", icon: MessageSquare, adminOnly: true, match: (p) => p.startsWith("/admin/notifications") },
    ],
  },
  {
    heading: "Tahlil va sozlamalar",
    items: [
      { to: "/admin/analytics", label: "Chuqur tahlillar", icon: BarChart3, adminOnly: true, match: (p) => p.startsWith("/admin/analytics") },
      { to: "/leaderboard", label: "Reyting", icon: Trophy, match: (p) => p === "/leaderboard" },
      { to: "/admin/batch-texts", label: "Batch matnlar", icon: Sparkles, adminOnly: true, match: (p) => p.startsWith("/admin/batch-texts") },
      { to: "/admin/settings", label: "Sozlamalar", icon: Settings, adminOnly: true, match: (p) => p.startsWith("/admin/settings") },
      { to: "/admin/audit", label: "Audit jurnali", icon: FileText, adminOnly: true, match: (p) => p.startsWith("/admin/audit") },
      { to: "/admin/deploy", label: "Deploy", icon: Rocket, adminOnly: true, match: (p) => p.startsWith("/admin/deploy") },
    ],
  },
];

const COLLAPSE_KEY = "admin_sidebar_collapsed";

function useVisibleSections() {
  const { role } = useAuth();
  const isAdmin = role === "admin";
  return SECTIONS.map((s) => ({
    ...s,
    items: s.items.filter((it) => isAdmin || !it.adminOnly),
  })).filter((s) => s.items.length > 0);
}

function NavItems({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const loc = useLocation();
  const sections = useVisibleSections();
  return (
    <>
      {sections.map((section) => (
        <div key={section.heading} className="mb-1">
          {!collapsed && (
            <div className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              {section.heading}
            </div>
          )}
          {collapsed && <div className="my-2 mx-3 border-t border-border/60" />}
          {section.items.map((it) => {
            const active = it.match ? it.match(loc.pathname) : loc.pathname === it.to;
            const Icon = it.icon;
            return (
              <Link
                key={it.to}
                to={it.to}
                onClick={onNavigate}
                title={collapsed ? it.label : undefined}
                className={`flex items-center gap-3 mx-2 px-2.5 py-2 rounded-md text-sm transition-colors ${
                  active
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                } ${collapsed ? "justify-center" : ""}`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span className="truncate">{it.label}</span>}
              </Link>
            );
          })}
        </div>
      ))}
    </>
  );
}

/** Desktop persistent sidebar. Hidden below md. */
export function AdminSidebar() {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  });

  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  return (
    <aside
      className={`hidden md:flex flex-col shrink-0 border-r border-border bg-background/60 transition-[width] duration-200 ${
        collapsed ? "w-[60px]" : "w-[220px]"
      }`}
    >
      <div className="flex items-center justify-between px-3 h-12 border-b border-border sticky top-14">
        {!collapsed && <span className="text-xs font-medium text-muted-foreground tracking-wide">BOSHQARUV</span>}
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="ml-auto inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          aria-label={collapsed ? "Yon panelni ochish" : "Yon panelni yopish"}
          title={collapsed ? "Ochish" : "Yopish"}
        >
          {collapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto py-2">
        <NavItems collapsed={collapsed} />
      </nav>
    </aside>
  );
}

/** Mobile hamburger that opens the same nav in a Sheet. Hidden at md and up. */
export function AdminMobileNav() {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          className="md:hidden inline-flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          aria-label="Menyu"
        >
          <Menu className="h-5 w-5" />
        </button>
      </SheetTrigger>
      <SheetContent side="left" className="w-[260px] p-0">
        <div className="px-4 h-12 flex items-center border-b border-border text-xs font-medium text-muted-foreground tracking-wide">
          BOSHQARUV
        </div>
        <nav className="py-2 overflow-y-auto h-[calc(100vh-3rem)]">
          <NavItems collapsed={false} onNavigate={() => setOpen(false)} />
        </nav>
      </SheetContent>
    </Sheet>
  );
}
