import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Suspense } from "react";
import { lazyRoute } from "@/lib/lazyRoute";
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
const Dashboard = lazyRoute(() => import("./pages/Dashboard"));
const Lessons = lazyRoute(() => import("./pages/Lessons"));
const CoursePage = lazyRoute(() => import("./pages/CoursePage"));
const LessonPage = lazyRoute(() => import("./pages/LessonPage"));
const QuizPage = lazyRoute(() => import("./pages/QuizPage"));
const Settings = lazyRoute(() => import("./pages/Settings"));
const Leaderboard = lazyRoute(() => import("./pages/Leaderboard"));
const Profile = lazyRoute(() => import("./pages/Profile"));
const Homework = lazyRoute(() => import("./pages/Homework"));
const ModuleHomework = lazyRoute(() => import("./pages/ModuleHomework"));
// /continue[/:courseId] — the landing of every Mini App watch button: resolves the next unfinished lesson.
const Continue = lazyRoute(() => import("./pages/Continue"));
// /challenge/tasks[/:taskId] — Kunlik vazifalar (Challenge daily tasks, PR-7). Hidden until challenge_tasks.miniapp.
const ChallengeTasks = lazyRoute(() => import("./pages/challenge/ChallengeTasks"));
const ChallengeTask = lazyRoute(() => import("./pages/challenge/ChallengeTask"));


// Lazy-load admin pages (code-split)
const AdminDashboard = lazyRoute(() => import("./pages/admin/AdminDashboard"));
const AdminCourses = lazyRoute(() => import("./pages/admin/AdminCourses"));
const AdminCourseEditor = lazyRoute(() => import("./pages/admin/AdminCourseEditor"));
const AdminUsers = lazyRoute(() => import("./pages/admin/AdminUsers"));
const AdminStudentDetail = lazyRoute(() => import("./pages/admin/AdminStudentDetail"));
const AdminUsersDuplicates = lazyRoute(() => import("./pages/admin/AdminUsersDuplicates"));
const AdminSettings = lazyRoute(() => import("./pages/admin/AdminSettings"));
const AdminBatchTexts = lazyRoute(() => import("./pages/admin/AdminBatchTexts"));
const AdminDeploy = lazyRoute(() => import("./pages/admin/AdminDeploy"));
const AdminAIAnalytics = lazyRoute(() => import("./pages/admin/AdminAIAnalytics"));
const AdminAudit = lazyRoute(() => import("./pages/admin/AdminAudit"));
const AdminBotDebug = lazyRoute(() => import("./pages/admin/AdminBotDebug"));
const AdminBunnyDiagnostics = lazyRoute(() => import("./pages/admin/AdminBunnyDiagnostics"));
const AdminNotifications = lazyRoute(() => import("./pages/admin/AdminNotifications"));
const AdminBroadcast = lazyRoute(() => import("./pages/admin/AdminBroadcast"));
const TgBroadcast = lazyRoute(() => import("./pages/TgBroadcast"));
const TgGroupBoard = lazyRoute(() => import("./pages/TgGroupBoard"));
// Teacher Mini App (/tg/teacher/*) — staff-only mobile shell (Phase 1).
const TeacherHome = lazyRoute(() => import("./pages/teacher/TeacherHome"));
const TeacherGrade = lazyRoute(() => import("./pages/teacher/TeacherGrade"));
const TeacherGroups = lazyRoute(() => import("./pages/teacher/TeacherGroups"));
const TeacherLessons = lazyRoute(() => import("./pages/teacher/TeacherLessons"));
const TeacherStudentDetail = lazyRoute(() => import("./pages/teacher/TeacherStudentDetail"));
const TeacherStats = lazyRoute(() => import("./pages/teacher/TeacherStats"));
const TeacherBroadcast = lazyRoute(() => import("./pages/teacher/TeacherBroadcast"));
const TeacherNudges = lazyRoute(() => import("./pages/teacher/TeacherNudges"));
const AdminGroups = lazyRoute(() => import("./pages/admin/AdminGroups"));
const GroupDetail = lazyRoute(() => import("./pages/admin/GroupDetail"));
const AdminHomework = lazyRoute(() => import("./pages/admin/AdminHomework"));
const AdminHomeworkHealth = lazyRoute(() => import("./pages/admin/AdminHomeworkHealth"));
const AdminChallengeTasks = lazyRoute(() => import("./pages/admin/AdminChallengeTasks"));
const TeacherHomework = lazyRoute(() => import("./pages/TeacherHomework"));
const AdminEngagement = lazyRoute(() => import("./pages/admin/AdminEngagement"));
const AdminTeacherStats = lazyRoute(() => import("./pages/admin/AdminTeacherStats"));
const AdminStatistics = lazyRoute(() => import("./pages/admin/AdminStatistics"));

const AdminAnalytics = lazyRoute(() => import("./pages/admin/AdminAnalytics"));
const AnalyticsFunnel = lazyRoute(() => import("./pages/admin/AnalyticsFunnel"));
const AnalyticsCohorts = lazyRoute(() => import("./pages/admin/AnalyticsCohorts"));
const AnalyticsLessons = lazyRoute(() => import("./pages/admin/AnalyticsLessons"));
const AnalyticsHeatmap = lazyRoute(() => import("./pages/admin/AnalyticsHeatmap"));
const AnalyticsTeachers = lazyRoute(() => import("./pages/admin/AnalyticsTeachers"));

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
      <Sonner position="top-center" />
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
            <Route path="/tg/teacher/groups" element={<RequireAuth staffOnly><TeacherShell><Suspense fallback={<AdminFallback />}><TeacherGroups /></Suspense></TeacherShell></RequireAuth>} />
            <Route path="/tg/teacher/groups/student/:studentId" element={<RequireAuth staffOnly><TeacherShell><Suspense fallback={<AdminFallback />}><TeacherStudentDetail /></Suspense></TeacherShell></RequireAuth>} />
            <Route path="/tg/teacher/lessons" element={<RequireAuth staffOnly><TeacherShell><Suspense fallback={<AdminFallback />}><TeacherLessons /></Suspense></TeacherShell></RequireAuth>} />
            <Route path="/tg/teacher/stats" element={<RequireAuth staffOnly><TeacherShell><Suspense fallback={<AdminFallback />}><TeacherStats /></Suspense></TeacherShell></RequireAuth>} />
            <Route path="/tg/teacher/broadcast" element={<RequireAuth staffOnly><TeacherShell><Suspense fallback={<AdminFallback />}><TeacherBroadcast /></Suspense></TeacherShell></RequireAuth>} />
            <Route path="/tg/teacher/nudges" element={<RequireAuth staffOnly><TeacherShell><Suspense fallback={<AdminFallback />}><TeacherNudges /></Suspense></TeacherShell></RequireAuth>} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/terms" element={<Terms />} />

            <Route path="/dashboard" element={<RequireAuth><StudentOrStaffRedirect><Dashboard /></StudentOrStaffRedirect></RequireAuth>} />
            <Route path="/lessons" element={<RequireAuth><Lessons /></RequireAuth>} />
            <Route path="/course/:courseId" element={<RequireAuth><CoursePage /></RequireAuth>} />
            <Route path="/lesson/:courseId/:lessonId" element={<RequireAuth><LessonPage /></RequireAuth>} />
            <Route path="/continue" element={<RequireAuth><Continue /></RequireAuth>} />
            <Route path="/continue/:courseId" element={<RequireAuth><Continue /></RequireAuth>} />
            <Route path="/challenge/tasks" element={<RequireAuth><ChallengeTasks /></RequireAuth>} />
            <Route path="/challenge/tasks/:taskId" element={<RequireAuth><ChallengeTask /></RequireAuth>} />
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
            <Route path="/admin/challenge/tasks" element={<RequireAuth adminOnly><Suspense fallback={<AdminFallback />}><AdminChallengeTasks /></Suspense></RequireAuth>} />
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
