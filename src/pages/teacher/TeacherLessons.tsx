// TeacherLessons — `/tg/teacher/lessons`, the Darslar (Lessons) tab.
//
// Renders INSIDE `TeacherShell` (App.tsx owns the shell + bottom nav + staff guard), so this file
// is page CONTENT only. Lets a teacher BROWSE and WATCH the published lessons of the course(s)
// they teach — backend already shipped on this branch: `teacher_courses()` RPC (junction-aware,
// published courses only) + a teacher bypass in `lesson-video-url` (module_locked/tier/enrollment
// gates skipped for a teacher of the course; still requires `published`).
//
// REVIEW-ONLY, on purpose: this screen NEVER writes `lesson_progress` and NEVER calls
// `track_video_progress` or any completion endpoint. A teacher watching a lesson to review it
// must record nothing — that's the whole reason this is its own screen instead of routing into
// the student `LessonPage` (which upserts `lesson_progress` on tick/ended and awards XP). No prop
// or callback below ever touches `lesson_progress`/XP; `BunnyVideoPlayer`'s `onTimeUpdate`/`onEnded`
// are simply left undefined (`?.()` no-ops inside the player).
//
// Three inline views behind local state (same drill-down shape as TeacherGroups.tsx):
//   • COURSE PICKER — only shown when the teacher has ≥2 courses; 0 courses → EmptyState; exactly
//     1 course skips the picker entirely and goes straight in.
//   • MODULE/LESSON LIST — an accordion (ModuleRow + nested LessonRow, ui-kit's own course-tree
//     pair — see src/pages/Lessons.tsx for the student-side precedent this mirrors). A lesson with
//     no playable video (`!has_video` — intentional homework/text step) renders a muted "Video yo'q"
//     marker and is NOT tappable.
//   • LESSON PLAYER — a lesson-detail sub-view (back button + video), fetching the URL via
//     `lesson-video-url` per tap (never the raw table columns — see the moduleIds effect below).
//
// IMPORTANT — column-level revoke (Phase 0, 20260622030000_phase0_lesson_media_protection.sql):
// `video_url`/`provider_video_id`/`video_storage_path` are REVOKEd from the `authenticated` role
// for EVERY non-admin caller — teachers included, since column-level REVOKE can't distinguish
// sub-roles of `authenticated` (the migration's own note). Selecting those columns straight from
// `lessons` would 403 for a teacher. We only ever select the non-sensitive `has_video` (generated
// boolean) + `video_provider` from the table, and resolve the actual playable URL exclusively
// through the `lesson-video-url` edge function (service-role, bypasses the column grant) — exactly
// how `LessonPage.tsx` already does it for students.
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { BunnyVideoPlayer } from "@/components/BunnyVideoPlayer";
import {
  Card,
  SectionHeader,
  Button,
  EmptyState,
  Skeleton,
  ModuleRow,
  LessonRow,
  type ModuleRowState,
} from "@/components/ui-kit";

interface TeacherCourse {
  course_id: string;
  title: string;
}

interface ModuleRec {
  id: string;
  title: string;
  position: number;
}

interface LessonRec {
  id: string;
  module_id: string;
  title: string;
  position: number;
  has_video: boolean;
  video_provider: string | null;
}

type VideoData = { url?: string; kind?: string; provider?: string; bunny?: { lib: string; guid: string } };

const offlineNow = () => typeof navigator !== "undefined" && !navigator.onLine;

export default function TeacherLessons() {
  const { user } = useAuth();

  // ── Courses (teacher_courses()) ────────────────────────────────────────────────────────────
  const [courses, setCourses] = useState<TeacherCourse[] | null>(null); // null = still loading
  const [coursesError, setCoursesError] = useState(false);
  const [coursesReloadKey, setCoursesReloadKey] = useState(0);
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setCourses(null);
    setCoursesError(false);
    (async () => {
      try {
        // Not in the generated Supabase types yet (landed today) — cast the RPC name
        // (frontend-typecheck-verify convention).
        const { data, error } = await supabase.rpc("teacher_courses" as any);
        if (cancelled) return;
        if (error) throw error;
        const rows = ((data as any[]) || []) as TeacherCourse[];
        setCourses(rows);
        // Exactly one course → skip the picker, go straight in.
        if (rows.length === 1) setSelectedCourseId(rows[0].course_id);
      } catch (e) {
        if (!cancelled) {
          console.error("[TeacherLessons] teacher_courses failed", e);
          setCourses([]);
          setCoursesError(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, coursesReloadKey]);

  // ── Modules + published lessons for the selected course ──────────────────────────────────────
  const [modules, setModules] = useState<ModuleRec[]>([]);
  const [lessons, setLessons] = useState<LessonRec[]>([]);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState(false);
  const [contentReloadKey, setContentReloadKey] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!selectedCourseId) {
      setModules([]);
      setLessons([]);
      return;
    }
    let cancelled = false;
    setContentLoading(true);
    setContentError(false);
    (async () => {
      try {
        const { data: modsData, error: modsErr } = await supabase
          .from("modules")
          .select("id, title, position")
          .eq("course_id", selectedCourseId)
          .order("position", { ascending: true });
        if (modsErr) throw modsErr;
        if (cancelled) return;
        const mods = (modsData || []) as ModuleRec[];
        setModules(mods);

        const moduleIds = mods.map((m) => m.id);
        if (moduleIds.length === 0) {
          setLessons([]);
          setExpanded(new Set());
          return;
        }

        // `has_video` is a Phase-0 generated column not in the generated types — cast the table
        // name (frontend-typecheck-verify convention). See the file header for why
        // `provider_video_id`/`video_url` are deliberately NOT selected here.
        const { data: lessonsData, error: lessonsErr } = await supabase
          .from("lessons" as any)
          .select("id, module_id, title, position, has_video, video_provider")
          .eq("published", true)
          .in("module_id", moduleIds)
          .order("position", { ascending: true });
        if (lessonsErr) throw lessonsErr;
        if (cancelled) return;
        setLessons(((lessonsData as any[]) || []) as LessonRec[]);
        // Default: the first module open so a fresh course view isn't all-collapsed.
        setExpanded(mods[0] ? new Set([mods[0].id]) : new Set());
      } catch (e) {
        if (!cancelled) {
          console.error("[TeacherLessons] modules/lessons load failed", e);
          setContentError(true);
        }
      } finally {
        if (!cancelled) setContentLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedCourseId, contentReloadKey]);

  const toggleExpanded = (moduleId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(moduleId)) next.delete(moduleId);
      else next.add(moduleId);
      return next;
    });
  };

  // ── Lesson player sub-view ────────────────────────────────────────────────────────────────────
  const [openLesson, setOpenLesson] = useState<LessonRec | null>(null);
  const [videoData, setVideoData] = useState<VideoData | null>(null); // null = still loading
  const [videoErrorCode, setVideoErrorCode] = useState<string | null>(null);
  const [videoReloadKey, setVideoReloadKey] = useState(0);

  useEffect(() => {
    if (!openLesson) return;
    let cancelled = false;
    setVideoData(null);
    setVideoErrorCode(null);
    if (offlineNow()) {
      setVideoErrorCode("offline");
      return;
    }
    (async () => {
      const { data, error } = await supabase.functions.invoke("lesson-video-url", {
        body: { lessonId: openLesson.id },
      });
      if (cancelled) return;
      if (error) {
        // On an HTTP error, supabase-js puts the response body in error.context, not `data`
        // (same pattern as HomeworkSubmit.tsx:207-215 / AdminUsers.tsx's admin-impersonate call).
        let code = "";
        try {
          const j = await (error as any).context?.json?.();
          code = j?.error || "";
        } catch {
          // body unreadable — falls through to the generic message below
        }
        setVideoErrorCode(code || "generic");
        return;
      }
      setVideoData((data as VideoData) || {});
    })();
    return () => {
      cancelled = true;
    };
  }, [openLesson, videoReloadKey]);

  const openLessonPlayer = (l: LessonRec) => {
    setOpenLesson(l);
  };
  const closeLessonPlayer = () => {
    setOpenLesson(null);
    setVideoData(null);
    setVideoErrorCode(null);
  };

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // LESSON PLAYER VIEW
  // ────────────────────────────────────────────────────────────────────────────────────────────
  if (openLesson) {
    const forbidden = videoErrorCode === "forbidden" || videoErrorCode === "module_locked";
    const errorMessage = videoErrorCode
      ? forbidden
        ? "Bu darsni ko'rish uchun ruxsat yo'q"
        : videoErrorCode === "offline"
          ? "Internet yo'q — ulanishni tekshiring va qayta urining"
          : "Video yuklanmadi — qayta urining"
      : null;

    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={closeLessonPlayer} aria-label="Orqaga">
          <ChevronLeft className="size-4" />
          Darslar
        </Button>

        <h1 className="truncate text-xl font-extrabold tracking-tight text-foreground">{openLesson.title}</h1>

        <Card className="overflow-hidden bg-black p-0 shadow-elevated">
          {errorMessage ? (
            <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-white/80">
              <span>{errorMessage}</span>
              {!forbidden && (
                <Button variant="secondary" size="sm" onClick={() => setVideoReloadKey((k) => k + 1)}>
                  Qayta urinish
                </Button>
              )}
            </div>
          ) : !videoData ? (
            <Skeleton className="aspect-video w-full rounded-none" />
          ) : videoData.provider === "bunny" && videoData.bunny?.lib && videoData.bunny?.guid ? (
            // REVIEW-ONLY: no onTimeUpdate/onEnded — nothing is written for a teacher watching.
            <BunnyVideoPlayer
              libraryId={videoData.bunny.lib}
              videoGuid={videoData.bunny.guid}
              watermarkEmail={user?.email || "teacher"}
            />
          ) : videoData.kind === "iframe" && videoData.url ? (
            <iframe
              className="aspect-video w-full"
              src={videoData.url}
              title={openLesson.title}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          ) : (videoData.kind === "hls" || videoData.kind === "mp4") && videoData.url ? (
            <video className="aspect-video w-full" src={videoData.url} controls playsInline />
          ) : (
            <div className="flex aspect-video w-full items-center justify-center p-6 text-center text-sm text-white/80">
              Video mavjud emas
            </div>
          )}
        </Card>
      </div>
    );
  }

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // COURSE PICKER VIEW (only reachable with ≥2 courses and none selected yet)
  // ────────────────────────────────────────────────────────────────────────────────────────────
  if (courses && courses.length >= 2 && !selectedCourseId) {
    return (
      <div className="space-y-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-extrabold tracking-tight text-foreground">Darslar</h1>
          <p className="truncate text-sm font-semibold text-muted-foreground">{courses.length} ta kurs</p>
        </div>
        <div className="space-y-2">
          {courses.map((c) => (
            <button
              key={c.course_id}
              type="button"
              onClick={() => setSelectedCourseId(c.course_id)}
              className="block w-full text-left transition-transform active:scale-[0.99]"
            >
              <Card className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-extrabold tracking-tight text-foreground">
                    {c.title}
                  </div>
                </div>
                <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
              </Card>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ────────────────────────────────────────────────────────────────────────────────────────────
  // MODULE / LESSON LIST VIEW
  // ────────────────────────────────────────────────────────────────────────────────────────────
  const selectedCourse = courses?.find((c) => c.course_id === selectedCourseId) ?? null;
  const offline = offlineNow();

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        {courses && courses.length >= 2 && selectedCourseId && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedCourseId(null)}
            aria-label="Kurslarga qaytish"
            className="mb-1"
          >
            <ChevronLeft className="size-4" />
            Kurslar
          </Button>
        )}
        <h1 className="text-2xl font-extrabold tracking-tight text-foreground">Darslar</h1>
        {selectedCourse && (
          <p className="truncate text-sm font-semibold text-muted-foreground">{selectedCourse.title}</p>
        )}
      </div>

      {courses === null ? (
        // Courses still loading
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[84px] w-full rounded-lg" />
          ))}
        </div>
      ) : coursesError ? (
        <EmptyState
          icon={offline ? "📡" : "⚠️"}
          title={offline ? "Internet yo'q" : "Xatolik"}
          body={
            offline
              ? "Ulanishni tekshiring va qayta urinib ko'ring."
              : "Kurslaringizni yuklab bo'lmadi. Birozdan so'ng qayta urinib ko'ring."
          }
          cta={
            <Button variant="secondary" size="sm" onClick={() => setCoursesReloadKey((k) => k + 1)}>
              Qayta urinish
            </Button>
          }
        />
      ) : courses.length === 0 ? (
        <EmptyState
          icon="📚"
          title="Sizga faol kurs biriktirilmagan"
          body="Sizga guruh va kurs biriktirilganda darslar shu yerda ko'rinadi."
        />
      ) : contentLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[62px] w-full rounded-md" />
          ))}
        </div>
      ) : contentError ? (
        <EmptyState
          icon={offline ? "📡" : "⚠️"}
          title={offline ? "Internet yo'q" : "Xatolik"}
          body={
            offline
              ? "Ulanishni tekshiring va qayta urinib ko'ring."
              : "Darslarni yuklab bo'lmadi. Birozdan so'ng qayta urinib ko'ring."
          }
          cta={
            <Button variant="secondary" size="sm" onClick={() => setContentReloadKey((k) => k + 1)}>
              Qayta urinish
            </Button>
          }
        />
      ) : lessons.length === 0 ? (
        <EmptyState
          icon="🎬"
          title="Bu kursda hali dars yo'q"
          body="Dars nashr etilganda shu yerda ko'rinadi."
        />
      ) : (
        <>
          <SectionHeader title={`Modullar (${modules.length})`} />
          {modules.map((m, idx) => {
            const moduleLessons = lessons.filter((l) => l.module_id === m.id);
            const state: ModuleRowState = "available";
            const isOpen = expanded.has(m.id);
            return (
              <div key={m.id}>
                <ModuleRow
                  state={state}
                  n={idx + 1}
                  title={m.title}
                  meta={`${moduleLessons.length} ta dars`}
                  onClick={() => toggleExpanded(m.id)}
                />
                {isOpen &&
                  moduleLessons.map((l, j) => {
                    // Intentional homework/text step — no playable video, not tappable.
                    const playable = !!l.has_video;
                    return (
                      <LessonRow
                        key={l.id}
                        state="upcoming"
                        title={l.title}
                        index={j + 1}
                        meta={playable ? undefined : "Video yo'q"}
                        onClick={playable ? () => openLessonPlayer(l) : undefined}
                        className={!playable ? "opacity-60" : undefined}
                      />
                    );
                  })}
              </div>
            );
          })}
          <div className="h-2" />
        </>
      )}
    </div>
  );
}
