import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { LogOut, Settings, Shield, LayoutDashboard, BookOpen, Users, Rocket, BarChart3, FileText } from "lucide-react";

export const Logo = ({ className = "" }: { className?: string }) => (
  <Link to="/dashboard" className={`flex items-center gap-2 font-semibold tracking-tight ${className}`}>
    <span className="inline-block w-6 h-6 rounded-md bg-foreground" aria-hidden />
    <span className="text-[15px]">AI Creators</span>
  </Link>
);

export const TopNav = () => {
  const { user, role, signOut } = useAuth();
  const navigate = useNavigate();
  const loc = useLocation();

  const initials = (user?.user_metadata?.name || user?.email || "?")
    .split(/[\s@]/)[0]
    .slice(0, 2)
    .toUpperCase();

  const linkCls = (active: boolean) =>
    `text-sm font-medium transition-colors ${active ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`;

  const isAdmin = role === "admin";
  const adminLinks = [
    { to: "/admin/dashboard", label: "Dashboard", match: (p: string) => p === "/admin/dashboard" || p === "/admin" },
    { to: "/admin/courses", label: "Courses", match: (p: string) => p.startsWith("/admin/courses") },
    { to: "/admin/users", label: "Users", match: (p: string) => p.startsWith("/admin/users") },
  ];

  return (
    <header className="sticky top-0 z-30 w-full border-b border-border bg-background/80 backdrop-blur-md">
      <div className="container flex h-14 items-center justify-between gap-4">
        <div className="flex items-center gap-6 min-w-0">
          <Logo />
          <nav className="hidden md:flex items-center gap-5">
            {!isAdmin && (
              <Link to="/dashboard" className={linkCls(loc.pathname === "/dashboard")}>Dashboard</Link>
            )}
            {isAdmin && adminLinks.map((l) => (
              <Link key={l.to} to={l.to} className={linkCls(l.match(loc.pathname))}>{l.label}</Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2">
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
                <div className="text-sm font-medium">{user?.user_metadata?.name || (isAdmin ? "Admin" : "Student")}</div>
                <div className="text-xs text-muted-foreground truncate">{user?.email}</div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {!isAdmin && (
                <DropdownMenuItem onClick={() => navigate("/dashboard")}>
                  <LayoutDashboard className="mr-2 h-4 w-4" /> Dashboard
                </DropdownMenuItem>
              )}
              {isAdmin && (
                <>
                  <DropdownMenuItem onClick={() => navigate("/admin/dashboard")}>
                    <Shield className="mr-2 h-4 w-4" /> Admin dashboard
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate("/admin/courses")}>
                    <BookOpen className="mr-2 h-4 w-4" /> Courses
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate("/admin/users")}>
                    <Users className="mr-2 h-4 w-4" /> Users
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate("/admin/settings")}>
                    <Settings className="mr-2 h-4 w-4" /> Settings
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate("/admin/ai-analytics")}>
                    <BarChart3 className="mr-2 h-4 w-4" /> AI Analytics
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate("/admin/audit")}>
                    <FileText className="mr-2 h-4 w-4" /> Audit log
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate("/admin/deploy")}>
                    <Rocket className="mr-2 h-4 w-4" /> Deploy
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem onClick={() => navigate("/settings")}>
                <Settings className="mr-2 h-4 w-4" /> My settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={async () => {
                  await signOut();
                  navigate("/login");
                }}
              >
                <LogOut className="mr-2 h-4 w-4" /> Sign out
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
