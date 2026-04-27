import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { lazy, Suspense } from "react";
import { AuthProvider } from "@/contexts/AuthContext";
import { RequireAuth } from "@/components/RequireAuth";
import { HtmlLangSync } from "@/components/HtmlLangSync";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import Dashboard from "./pages/Dashboard";
import CoursePage from "./pages/CoursePage";
import LessonPage from "./pages/LessonPage";
import QuizPage from "./pages/QuizPage";
import Settings from "./pages/Settings";
import NotFound from "./pages/NotFound";
import Landing from "./pages/Landing";

// Lazy-load admin pages (code-split)
const AdminDashboard = lazy(() => import("./pages/admin/AdminDashboard"));
const AdminCourses = lazy(() => import("./pages/admin/AdminCourses"));
const AdminCourseEditor = lazy(() => import("./pages/admin/AdminCourseEditor"));
const AdminUsers = lazy(() => import("./pages/admin/AdminUsers"));
const AdminSettings = lazy(() => import("./pages/admin/AdminSettings"));
const AdminDeploy = lazy(() => import("./pages/admin/AdminDeploy"));
const AdminAIAnalytics = lazy(() => import("./pages/admin/AdminAIAnalytics"));
const AdminAudit = lazy(() => import("./pages/admin/AdminAudit"));
const AdminBunnyDiagnostics = lazy(() => import("./pages/admin/AdminBunnyDiagnostics"));

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, refetchOnWindowFocus: false } },
});

const AdminFallback = () => (
  <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">Loading…</div>
);

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <HtmlLangSync />
        <AuthProvider>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
            <Route path="/course/:courseId" element={<RequireAuth><CoursePage /></RequireAuth>} />
            <Route path="/lesson/:courseId/:lessonId" element={<RequireAuth><LessonPage /></RequireAuth>} />
            <Route path="/quiz/:moduleId" element={<RequireAuth><QuizPage /></RequireAuth>} />
            <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />

            <Route path="/admin" element={<Navigate to="/admin/dashboard" replace />} />
            <Route path="/admin/dashboard" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminDashboard /></Suspense></RequireAuth>} />
            <Route path="/admin/courses" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminCourses /></Suspense></RequireAuth>} />
            <Route path="/admin/courses/:courseId" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminCourseEditor /></Suspense></RequireAuth>} />
            <Route path="/admin/users" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminUsers /></Suspense></RequireAuth>} />
            <Route path="/admin/settings" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminSettings /></Suspense></RequireAuth>} />
            <Route path="/admin/deploy" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminDeploy /></Suspense></RequireAuth>} />
            <Route path="/admin/ai-analytics" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminAIAnalytics /></Suspense></RequireAuth>} />
            <Route path="/admin/audit" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminAudit /></Suspense></RequireAuth>} />
            <Route path="/admin/diagnostics/bunny" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminBunnyDiagnostics /></Suspense></RequireAuth>} />

            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
