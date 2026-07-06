import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/contexts/AuthContext";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { LogOut, Settings, LayoutDashboard } from "lucide-react";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { ThemeToggle } from "@/components/ThemeToggle";
import { PixelDissolve } from "@/components/landing/PixelDissolve";
import { StudentBottomNav } from "@/components/StudentBottomNav";
import { AdminSidebar, AdminMobileNav } from "@/components/admin/AdminSidebar";

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

/** True when staff is inside an admin/teacher management route (where the sidebar shows). */
function isAdminArea(pathname: string) {
  return pathname.startsWith("/admin") || pathname.startsWith("/teacher");
}

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
  const isTeacher = role === "teacher";
  const isStaff = isAdmin || isTeacher;
  const showAdminNav = isStaff && isAdminArea(loc.pathname);

  return (
    <header className="sticky top-0 z-30 w-full border-b border-border bg-background/80 backdrop-blur-md">
      <div className="container flex h-14 items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          {showAdminNav && <AdminMobileNav />}
          <Logo to={isStaff ? "/admin/dashboard" : "/dashboard"} />
          <nav className="hidden md:flex items-center gap-5">
            {!isStaff && (
              <Link to="/dashboard" className={linkCls(loc.pathname === "/dashboard")}>{t("nav.dashboard")}</Link>
            )}
          </nav>
        </div>
        <div className="flex items-center gap-1">
          <ThemeToggle />
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
                <div className="text-sm font-medium">{user?.user_metadata?.name || (isAdmin ? t("nav.admin") : isTeacher ? "Teacher" : t("nav.student"))}</div>
                <div className="text-xs text-muted-foreground truncate">{user?.email}</div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {!isStaff && (
                <DropdownMenuItem asChild>
                  <Link to="/dashboard"><LayoutDashboard className="mr-2 h-4 w-4" /> {t("nav.dashboard")}</Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem asChild>
                <Link to="/settings"><Settings className="mr-2 h-4 w-4" /> {t("nav.mySettings")}</Link>
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

export const PageShell = ({ children }: { children: React.ReactNode }) => {
  const { role } = useAuth();
  const loc = useLocation();
  const isStaff = role === "admin" || role === "teacher";
  const isStudent = !isStaff;
  const showSidebar = isStaff && isAdminArea(loc.pathname);

  return (
    <div className="min-h-screen bg-background">
      {/* Brand backdrop: the logo's pixel-dissolve squares, daylight tone
          (light theme only — dark keeps a clean surface). */}
      <div className="fixed inset-0 z-0 pointer-events-none dark:hidden" aria-hidden>
        <PixelDissolve className="w-full h-full" alpha={0.3} />
      </div>
      <div className="relative z-10">
        <TopNav />
        {showSidebar ? (
          <div className="flex">
            <AdminSidebar />
            <main className="flex-1 min-w-0 px-4 md:px-6 py-6 md:py-8 animate-fade-in">{children}</main>
          </div>
        ) : (
          <main className={`container py-6 md:py-10 animate-fade-in ${isStudent ? "pb-24 md:pb-10" : ""}`}>{children}</main>
        )}
        {isStudent && <StudentBottomNav />}
      </div>
    </div>
  );
};
