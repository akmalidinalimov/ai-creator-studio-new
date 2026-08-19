import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { lazy, Suspense } from "react";
import { AuthProvider } from "@/contexts/AuthContext";
import { RequireAuth } from "@/components/RequireAuth";
import { useAuth } from "@/contexts/AuthContext";
import { HtmlLangSync } from "@/components/HtmlLangSync";
import ImpersonationBanner from "@/components/ImpersonationBanner";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { MiniAppProvider } from "@/lib/telegram/MiniAppContext";
import { TelegramGate } from "@/lib/telegram/TelegramGate";
import { TeacherShell } from "@/components/teacher/TeacherShell";

const StudentOrStaffRedirect = ({ children }: { children: JSX.Element }) => {
  const { role } = useAuth();
  if (role === "admin" || role === "teacher") return <Navigate to="/admin/dashboard" replace />;
  return children;
};

const TeacherDashboardRedirect = () => {
  const search = typeof window !== "undefined" ? window.location.search : "";
  return <Navigate to={`/admin/dashboard${search}`} replace />;
};
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";
import NotFound from "./pages/NotFound";
import Landing from "./pages/Landing";
import AuthMagicLink from "./pages/AuthMagicLink";
import SalesIntake from "./pages/SalesIntake";
import { Privacy, Terms } from "./pages/Legal";

// Lazy-load the authenticated pages so they stay out of the initial bundle.
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Lessons = lazy(() => import("./pages/Lessons"));
const CoursePage = lazy(() => import("./pages/CoursePage"));
const LessonPage = lazy(() => import("./pages/LessonPage"));
const QuizPage = lazy(() => import("./pages/QuizPage"));
const Settings = lazy(() => import("./pages/Settings"));
const Leaderboard = lazy(() => import("./pages/Leaderboard"));
const Profile = lazy(() => import("./pages/Profile"));
const Homework = lazy(() => import("./pages/Homework"));
const ModuleHomework = lazy(() => import("./pages/ModuleHomework"));


// Lazy-load admin pages (code-split)
const AdminDashboard = lazy(() => import("./pages/admin/AdminDashboard"));
const AdminCourses = lazy(() => import("./pages/admin/AdminCourses"));
const AdminCourseEditor = lazy(() => import("./pages/admin/AdminCourseEditor"));
const AdminUsers = lazy(() => import("./pages/admin/AdminUsers"));
const AdminStudentDetail = lazy(() => import("./pages/admin/AdminStudentDetail"));
const AdminUsersDuplicates = lazy(() => import("./pages/admin/AdminUsersDuplicates"));
const AdminSettings = lazy(() => import("./pages/admin/AdminSettings"));
const AdminBatchTexts = lazy(() => import("./pages/admin/AdminBatchTexts"));
const AdminDeploy = lazy(() => import("./pages/admin/AdminDeploy"));
const AdminAIAnalytics = lazy(() => import("./pages/admin/AdminAIAnalytics"));
const AdminAudit = lazy(() => import("./pages/admin/AdminAudit"));
const AdminBotDebug = lazy(() => import("./pages/admin/AdminBotDebug"));
const AdminBunnyDiagnostics = lazy(() => import("./pages/admin/AdminBunnyDiagnostics"));
const AdminNotifications = lazy(() => import("./pages/admin/AdminNotifications"));
const AdminBroadcast = lazy(() => import("./pages/admin/AdminBroadcast"));
const TgBroadcast = lazy(() => import("./pages/TgBroadcast"));
const TgGroupBoard = lazy(() => import("./pages/TgGroupBoard"));
// Teacher Mini App (/tg/teacher/*) — staff-only mobile shell (Phase 1).
const TeacherHome = lazy(() => import("./pages/teacher/TeacherHome"));
const TeacherGrade = lazy(() => import("./pages/teacher/TeacherGrade"));
const AdminGroups = lazy(() => import("./pages/admin/AdminGroups"));
const GroupDetail = lazy(() => import("./pages/admin/GroupDetail"));
const AdminHomework = lazy(() => import("./pages/admin/AdminHomework"));
const AdminHomeworkHealth = lazy(() => import("./pages/admin/AdminHomeworkHealth"));
const TeacherHomework = lazy(() => import("./pages/TeacherHomework"));
const AdminEngagement = lazy(() => import("./pages/admin/AdminEngagement"));
const AdminTeacherStats = lazy(() => import("./pages/admin/AdminTeacherStats"));
const AdminStatistics = lazy(() => import("./pages/admin/AdminStatistics"));

const AdminAnalytics = lazy(() => import("./pages/admin/AdminAnalytics"));
const AnalyticsFunnel = lazy(() => import("./pages/admin/AnalyticsFunnel"));
const AnalyticsCohorts = lazy(() => import("./pages/admin/AnalyticsCohorts"));
const AnalyticsLessons = lazy(() => import("./pages/admin/AnalyticsLessons"));
const AnalyticsHeatmap = lazy(() => import("./pages/admin/AnalyticsHeatmap"));
const AnalyticsTeachers = lazy(() => import("./pages/admin/AnalyticsTeachers"));

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, refetchOnWindowFocus: false } },
});

const AdminFallback = () => (
  <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">Loading…</div>
);

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <ImpersonationBanner />
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <HtmlLangSync />
        <ErrorBoundary label="app-root">
        <MiniAppProvider>
        <TelegramGate>
        <AuthProvider>
          <Suspense fallback={<AdminFallback />}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/auth/magic" element={<AuthMagicLink />} />
            {/* Passwordless sales intake form: no login — gated by the ?code= in the link. */}
            <Route path="/intake" element={<SalesIntake />} />
            <Route path="/tg/broadcast" element={<Suspense fallback={<AdminFallback />}><TgBroadcast /></Suspense>} />
            <Route path="/tg/group-board" element={<Suspense fallback={<AdminFallback />}><TgGroupBoard /></Suspense>} />
            {/* Teacher Mini App (staff-only). RequireAuth staffOnly bounces students to /dashboard
                before TeacherShell renders. TeacherShell + pages fleshed out in Tasks 4/5/6. */}
            <Route path="/tg/teacher" element={<RequireAuth staffOnly><TeacherShell><Suspense fallback={<AdminFallback />}><TeacherHome /></Suspense></TeacherShell></RequireAuth>} />
            <Route path="/tg/teacher/grade" element={<RequireAuth staffOnly><TeacherShell><Suspense fallback={<AdminFallback />}><TeacherGrade /></Suspense></TeacherShell></RequireAuth>} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/terms" element={<Terms />} />

            <Route path="/dashboard" element={<RequireAuth><StudentOrStaffRedirect><Dashboard /></StudentOrStaffRedirect></RequireAuth>} />
            <Route path="/lessons" element={<RequireAuth><Lessons /></RequireAuth>} />
            <Route path="/course/:courseId" element={<RequireAuth><CoursePage /></RequireAuth>} />
            <Route path="/lesson/:courseId/:lessonId" element={<RequireAuth><LessonPage /></RequireAuth>} />
            <Route path="/quiz/:moduleId" element={<RequireAuth><QuizPage /></RequireAuth>} />
            <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
            <Route path="/leaderboard" element={<RequireAuth><Leaderboard /></RequireAuth>} />
            <Route path="/homework" element={<RequireAuth><Homework /></RequireAuth>} />
            {/* Module-end homework (Darslar → module's "Uy vazifasi" step row) — module-homework
                feature, 2026-08-18. Complements (does not replace) the Vazifa tab above. */}
            <Route path="/homework/module/:moduleId" element={<RequireAuth><ModuleHomework /></RequireAuth>} />
            {/* Folded into Profil (Task 2.5) — the 5-tab nav's Profil tab already treats these
                paths as Profil (see StudentBottomNav). */}
            <Route path="/badges" element={<Navigate to="/profile" replace />} />
            <Route path="/activity" element={<Navigate to="/profile" replace />} />
            <Route path="/profile" element={<RequireAuth><Profile /></RequireAuth>} />

            <Route path="/admin" element={<Navigate to="/admin/dashboard" replace />} />
            <Route path="/teacher" element={<TeacherDashboardRedirect />} />
            <Route path="/teacher/dashboard" element={<TeacherDashboardRedirect />} />
            <Route path="/admin/dashboard" element={<RequireAuth staffOnly><Suspense fallback={<AdminFallback />}><AdminDashboard /></Suspense></RequireAuth>} />
            <Route path="/admin/courses" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminCourses /></Suspense></RequireAuth>} />
            <Route path="/admin/courses/:courseId" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminCourseEditor /></Suspense></RequireAuth>} />
            <Route path="/admin/users" element={<RequireAuth staffOnly><Suspense fallback={<AdminFallback />}><AdminUsers /></Suspense></RequireAuth>} />
            <Route path="/admin/users/duplicates" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminUsersDuplicates /></Suspense></RequireAuth>} />
            <Route path="/admin/users/:id" element={<RequireAuth staffOnly><Suspense fallback={<AdminFallback />}><AdminStudentDetail /></Suspense></RequireAuth>} />
            <Route path="/admin/settings" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminSettings /></Suspense></RequireAuth>} />
            <Route path="/admin/batch-texts" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminBatchTexts /></Suspense></RequireAuth>} />
            <Route path="/admin/deploy" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminDeploy /></Suspense></RequireAuth>} />
            <Route path="/admin/ai-analytics" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminAIAnalytics /></Suspense></RequireAuth>} />
            <Route path="/admin/audit" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminAudit /></Suspense></RequireAuth>} />
            <Route path="/admin/diagnostics/bunny" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminBunnyDiagnostics /></Suspense></RequireAuth>} />
            <Route path="/admin/bot-debug" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminBotDebug /></Suspense></RequireAuth>} />
            <Route path="/admin/notifications" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminNotifications /></Suspense></RequireAuth>} />
            <Route path="/admin/broadcast" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminBroadcast /></Suspense></RequireAuth>} />
            <Route path="/admin/groups" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminGroups /></Suspense></RequireAuth>} />
            <Route path="/admin/groups/:id" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><GroupDetail /></Suspense></RequireAuth>} />
            <Route path="/admin/engagement" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminEngagement /></Suspense></RequireAuth>} />
            <Route path="/admin/teacher-stats" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminTeacherStats /></Suspense></RequireAuth>} />
            <Route path="/admin/statistics" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminStatistics /></Suspense></RequireAuth>} />
            {/* Legacy routes → merged engagement hub */}
            <Route path="/admin/reengagement" element={<Navigate to="/admin/engagement?tab=reengagement" replace />} />
            <Route path="/admin/nudges" element={<Navigate to="/admin/engagement" replace />} />
            <Route path="/admin/homework" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminHomework /></Suspense></RequireAuth>} />
            <Route path="/admin/homework-health" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminHomeworkHealth /></Suspense></RequireAuth>} />
            <Route path="/teacher/homework" element={<RequireAuth staffOnly><Suspense fallback={<AdminFallback />}><TeacherHomework /></Suspense></RequireAuth>} />
            
            <Route path="/admin/analytics" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminAnalytics /></Suspense></RequireAuth>} />
            <Route path="/admin/analytics/funnel" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AnalyticsFunnel /></Suspense></RequireAuth>} />
            <Route path="/admin/analytics/cohorts" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AnalyticsCohorts /></Suspense></RequireAuth>} />
            <Route path="/admin/analytics/lessons" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AnalyticsLessons /></Suspense></RequireAuth>} />
            <Route path="/admin/analytics/heatmap" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AnalyticsHeatmap /></Suspense></RequireAuth>} />
            <Route path="/admin/analytics/teachers" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AnalyticsTeachers /></Suspense></RequireAuth>} />

            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
        </AuthProvider>
        </TelegramGate>
        </MiniAppProvider>
        </ErrorBoundary>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
