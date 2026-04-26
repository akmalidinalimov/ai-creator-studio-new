import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { LogOut, Settings, Shield, LayoutDashboard, BookOpen, Users, Rocket, BarChart3, FileText } from "lucide-react";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

export const Logo = ({ className = "", to = "/dashboard" }: { className?: string; to?: string }) => (
  <Link to={to} className={`flex items-center gap-2 font-semibold tracking-tight ${className}`}>
    <span
      className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-primary text-primary-foreground text-[13px] font-bold ring-[3px] ring-primary/10"
      aria-hidden
    >
      A
    </span>
    <span className="text-[15px]">AI Creators</span>
  </Link>
);

export const TopNav = () => {
  const { user, role, signOut } = useAuth();
  const navigate = useNavigate();
  const loc = useLocation();
  const { t } = useTranslation();

  const initials = (user?.user_metadata?.name || user?.email || "?")
    .split(/[\s@]/)[0]
    .slice(0, 2)
    .toUpperCase();

  const linkCls = (active: boolean) =>
    `text-sm font-medium transition-colors ${active ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`;

  const isAdmin = role === "admin";
  const adminLinks = [
    { to: "/admin/dashboard", label: t("nav.dashboard"), match: (p: string) => p === "/admin/dashboard" || p === "/admin" },
    { to: "/admin/courses", label: t("nav.courses"), match: (p: string) => p.startsWith("/admin/courses") },
    { to: "/admin/users", label: t("nav.users"), match: (p: string) => p.startsWith("/admin/users") },
  ];

  return (
    <header className="sticky top-0 z-30 w-full border-b border-border bg-background/80 backdrop-blur-md">
      <div className="container flex h-14 items-center justify-between gap-4">
        <div className="flex items-center gap-6 min-w-0">
          <Logo />
          <nav className="hidden md:flex items-center gap-5">
            {!isAdmin && (
              <Link to="/dashboard" className={linkCls(loc.pathname === "/dashboard")}>{t("nav.dashboard")}</Link>
            )}
            {isAdmin && adminLinks.map((l) => (
              <Link key={l.to} to={l.to} className={linkCls(l.match(loc.pathname))}>{l.label}</Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-1">
          <LanguageSwitcher />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="text-xs bg-foreground text-background">{initials}</AvatarFallback>
                </Avatar>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="font-normal">
                <div className="text-sm font-medium">{user?.user_metadata?.name || (isAdmin ? t("nav.admin") : t("nav.student"))}</div>
                <div className="text-xs text-muted-foreground truncate">{user?.email}</div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {!isAdmin && (
                <DropdownMenuItem onClick={() => navigate("/dashboard")}>
                  <LayoutDashboard className="mr-2 h-4 w-4" /> {t("nav.dashboard")}
                </DropdownMenuItem>
              )}
              {isAdmin && (
                <>
                  <DropdownMenuItem onClick={() => navigate("/admin/dashboard")}>
                    <Shield className="mr-2 h-4 w-4" /> {t("nav.adminDashboard")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate("/admin/courses")}>
                    <BookOpen className="mr-2 h-4 w-4" /> {t("nav.courses")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate("/admin/users")}>
                    <Users className="mr-2 h-4 w-4" /> {t("nav.users")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate("/admin/settings")}>
                    <Settings className="mr-2 h-4 w-4" /> {t("nav.settings")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate("/admin/ai-analytics")}>
                    <BarChart3 className="mr-2 h-4 w-4" /> {t("nav.aiAnalytics")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate("/admin/audit")}>
                    <FileText className="mr-2 h-4 w-4" /> {t("nav.auditLog")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate("/admin/deploy")}>
                    <Rocket className="mr-2 h-4 w-4" /> {t("nav.deploy")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem onClick={() => navigate("/settings")}>
                <Settings className="mr-2 h-4 w-4" /> {t("nav.mySettings")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={async () => {
                  await signOut();
                  navigate("/login");
                }}
              >
                <LogOut className="mr-2 h-4 w-4" /> {t("nav.signOut")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
};

export const PageShell = ({ children }: { children: React.ReactNode }) => (
  <div className="min-h-screen bg-background">
    <TopNav />
    <main className="container py-6 md:py-10 animate-fade-in">{children}</main>
  </div>
);
