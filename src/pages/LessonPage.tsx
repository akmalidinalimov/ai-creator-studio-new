import { useEffect, useRef, useState, useCallback } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { CheckCircle2, ChevronRight, ChevronLeft, Send, Sparkles, LayoutList } from "lucide-react";
import { toast } from "sonner";
import { ProtectedVideo } from "@/components/lesson/ProtectedVideo";
import { BunnyVideoPlayer } from "@/components/BunnyVideoPlayer";
import { HomeworkSection } from "@/components/lesson/HomeworkSection";

interface Msg { role: "user" | "assistant"; content: string }

const SUPPORTED_ASSISTANT_LANGS = ["uz", "ru", "en"] as const;
function normalizeAssistantLang(code?: string | null): "uz" | "ru" | "en" {
  const c = (code || "").toLowerCase().split("-")[0];
  return (SUPPORTED_ASSISTANT_LANGS as readonly string[]).includes(c) ? (c as any) : "uz";
}

export default function LessonPage() {
  const { courseId, lessonId } = useParams();
  const { user, session } = useAuth();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const language = normalizeAssistantLang(i18n.language);

  const [lesson, setLesson] = useState<any>(null);
  const [modules, setModules] = useState<any[]>([]);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ last_position_seconds: number } | null>(null);
  const [chatHistory, setChatHistory] = useState<Msg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [protectionSettings, setProtectionSettings] = useState<any | undefined>(undefined);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Furthest watched position + duration this session (also seeded from stored
  // progress) — used to gate manual "Mark complete" so a streak can't be earned
  // by clicking complete without genuinely watching.
  const watchMaxPosRef = useRef(0);
  const watchDurRef = useRef(0);
  // Access-gated video data. The browser NEVER reads raw video IDs from the
  // lessons table anymore (those columns are revoked from students — M05); the
  // only way to get a playable URL is the lesson-video-url edge function, which
  // enforces has_module_access + published + enrollment server-side.
  type VideoData = { url?: string; kind?: string; provider?: string; bunny?: { lib: string; guid: string }; locked?: boolean };
  const [videoData, setVideoData] = useState<VideoData | null>(null);

  useEffect(() => {
    if (!lessonId) return;
    let cancelled = false;
    setVideoData(null);
    (async () => {
      const { data, error } = await supabase.functions.invoke("lesson-video-url", { body: { lessonId } });
      if (cancelled) return;
      // A 403 (module_locked / forbidden) or any error → treat as locked/unavailable.
      if (error || !data) { setVideoData({ locked: true }); return; }
      setVideoData(data as VideoData);
    })();
    return () => { cancelled = true; };
  }, [lessonId]);


  // Load protection settings
  useEffect(() => {
    supabase.rpc("get_public_setting", { _key: "content_protection" }).then(({ data }) => {
      if (data) setProtectionSettings(data);
    });
  }, []);


  // Load
  useEffect(() => {
    if (!lessonId || !user || !courseId) return;
    (async () => {
      const { data: l } = await supabase.from("lessons")
        .select("id, title, description, module_id, position, published, video_provider, modules(course_id)")
        .eq("id", lessonId).maybeSingle();
      setLesson(l);
      const { data: ms } = await supabase
        .from("modules")
        .select("*, lessons(id, title, position)")
        .eq("course_id", courseId)
        .order("position", { ascending: true });
      (ms || []).forEach((m: any) => m.lessons.sort((a: any, b: any) => a.position - b.position));
      setModules(ms || []);

      // Tier lock (Phase 2): a direct URL into a module beyond the student's tier →
      // bounce to the course page. Mirrors CoursePage's lock (index >= moduleLimit).
      // NULL limit (every 4.0 student / admin / teacher) → never locked.
      const { data: lim } = await supabase.rpc("my_module_limit" as any, { _course_id: courseId });
      const moduleLimit = typeof lim === "number" ? lim : null;
      const moduleIdx = (ms || []).findIndex((m: any) => m.id === (l as any)?.module_id);
      if (moduleLimit != null && moduleIdx >= 0 && moduleIdx >= moduleLimit) {
        toast.error(t("lesson.tierLocked", { defaultValue: "Bu modul sizning tarifingizda mavjud emas." }));
        navigate(`/course/${courseId}`, { replace: true });
        return;
      }

      const lessonIds = (ms || []).flatMap((m: any) => m.lessons.map((x: any) => x.id));
      const { data: prog } = await supabase.from("lesson_progress").select("lesson_id, completed_at, last_position_seconds, max_position_seconds, duration_seconds_v2")
        .eq("user_id", user.id).in("lesson_id", lessonIds.length ? lessonIds : ["00000000-0000-0000-0000-000000000000"]);
      setCompleted(new Set((prog || []).filter((p: any) => p.completed_at).map((p: any) => p.lesson_id)));
      const cur = (prog || []).find((p: any) => p.lesson_id === lessonId);
      setProgress(cur || null);
      // Seed the watch-gate from previously stored progress for this lesson.
      watchMaxPosRef.current = Math.max(Number(cur?.max_position_seconds) || 0, Number(cur?.last_position_seconds) || 0);
      watchDurRef.current = Number(cur?.duration_seconds_v2) || 0;

      const { data: hist } = await supabase.from("ai_chat_messages").select("role, content").eq("user_id", user.id).eq("lesson_id", lessonId).order("created_at").limit(50);
      setChatHistory((hist || []) as Msg[]);
    })();
  }, [lessonId, courseId, user]);

  // Resume position is passed into the player via props (Bunny ?t=, native HTML5 below).
  useEffect(() => {
    if (videoRef.current && progress?.last_position_seconds) {
      videoRef.current.currentTime = progress.last_position_seconds;
    }
  }, [progress, lesson]);

  // Native HTML5 <video> tracking (upload / mux). Bunny tracking is wired via player.js.
  const lastNativeTickRef = useRef<number>(0);
  useEffect(() => {
    if (!user || !lessonId) return;
    const id = setInterval(async () => {
      const v = videoRef.current; if (!v || v.paused) return;
      const cur = v.currentTime || 0;
      const dur = v.duration || 0;
      const now = Date.now();
      const delta = lastNativeTickRef.current ? Math.min(10, (now - lastNativeTickRef.current) / 1000) : 5;
      lastNativeTickRef.current = now;
      const { data } = await supabase.rpc("track_video_progress", {
        p_lesson_id: lessonId, p_current_time: cur, p_duration: dur, p_delta_seconds: delta,
      });
      if (cur > watchMaxPosRef.current) watchMaxPosRef.current = cur;
      if (dur > 0) watchDurRef.current = dur;
      if ((data as any)?.completed) setCompleted((s) => new Set(s).add(lessonId));
      // Near-end fallback: mark complete if we're within 5s of the end.
      if (dur > 0 && cur >= dur - 5) {
        await supabase.from("lesson_progress").upsert({
          user_id: user.id, lesson_id: lessonId, completed_at: new Date().toISOString(),
        }, { onConflict: "user_id,lesson_id" });
        setCompleted((s) => new Set(s).add(lessonId));
      }
    }, 5000);
    return () => clearInterval(id);
  }, [user, lessonId]);

  // Native <video> "ended" listener — mirrors the Bunny onEnded path.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !user || !lessonId) return;
    const handler = async () => {
      await supabase.from("lesson_progress").upsert({
        user_id: user.id, lesson_id: lessonId, completed_at: new Date().toISOString(),
      }, { onConflict: "user_id,lesson_id" });
      setCompleted((s) => new Set(s).add(lessonId));
    };
    v.addEventListener("ended", handler);
    return () => v.removeEventListener("ended", handler);
  }, [user, lessonId, lesson]);

  // Bunny progress callback (player.js timeupdate ~every 5s + ended)
  const lastBunnyTickRef = useRef<number>(0);
  const onBunnyTime = useCallback(async (seconds: number, duration: number) => {
    if (!user || !lessonId) return;
    const now = Date.now();
    const delta = lastBunnyTickRef.current ? Math.min(10, (now - lastBunnyTickRef.current) / 1000) : 5;
    lastBunnyTickRef.current = now;
    const { data } = await supabase.rpc("track_video_progress", {
      p_lesson_id: lessonId, p_current_time: seconds, p_duration: duration, p_delta_seconds: delta,
    });
    if (seconds > watchMaxPosRef.current) watchMaxPosRef.current = seconds;
    if (duration > 0) watchDurRef.current = duration;
    if ((data as any)?.completed) setCompleted((s) => new Set(s).add(lessonId!));
  }, [user, lessonId]);
  const onBunnyEnded = useCallback(async () => {
    if (!user || !lessonId) return;
    await supabase.from("lesson_progress").upsert({
      user_id: user.id, lesson_id: lessonId, completed_at: new Date().toISOString(),
    }, { onConflict: "user_id,lesson_id" });
    setCompleted((s) => new Set(s).add(lessonId));
  }, [user, lessonId]);

  // Require genuinely watching ~half the lesson before a manual completion can
  // count (prevents earning a streak by clicking "Mark complete" without watching).
  // Lessons with no/unknown video duration are never blocked.
  const watchedEnough = () => {
    const dur = Number(videoRef.current?.duration) || watchDurRef.current || Number((progress as any)?.duration_seconds_v2) || 0;
    if (!dur || dur <= 0) return true;
    const pos = Math.max(
      Number(videoRef.current?.currentTime) || 0,
      watchMaxPosRef.current || 0,
      Number((progress as any)?.max_position_seconds) || 0,
    );
    return pos >= dur * 0.5;
  };

  const writeComplete = async () => {
    if (!user || !lessonId) return;
    await supabase.from("lesson_progress").upsert({
      user_id: user.id, lesson_id: lessonId, completed_at: new Date().toISOString(),
      last_position_seconds: Math.floor(videoRef.current?.currentTime || 0),
    }, { onConflict: "user_id,lesson_id" });
    setCompleted((s) => new Set(s).add(lessonId));
  };

  const markComplete = async () => {
    if (!user || !lessonId) return;
    if (!completed.has(lessonId) && !watchedEnough()) {
      toast.error(t("lesson.watchMoreToComplete"));
      return;
    }
    await writeComplete();
    toast.success(t("lesson.markedCompleteToast"));
  };

  const flat = modules.flatMap((m) => m.lessons.map((l: any) => ({ ...l, moduleTitle: m.title })));
  const idx = flat.findIndex((l: any) => l.id === lessonId);
  const prev = idx > 0 ? flat[idx - 1] : null;
  const next = idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : null;

  const goNext = async () => {
    // Complete silently only if genuinely watched; otherwise just move on.
    if (user && lessonId && (completed.has(lessonId) || watchedEnough())) {
      await writeComplete();
    }
    if (next) navigate(`/lesson/${courseId}/${next.id}`);
  };

  const sendChat = useCallback(async (text: string) => {
    if (!text.trim() || chatLoading) return;
    const userMsg: Msg = { role: "user", content: text };
    const baseHistory = chatHistory;
    setChatHistory((h) => [...h, userMsg]);
    setChatInput("");
    setChatLoading(true);

    const showRetry = () => {
      // Remove orphan empty assistant bubble (if any)
      setChatHistory((h) => h.filter((m, i) => !(i === h.length - 1 && m.role === "assistant" && !m.content)));
      toast.error(t("lesson.ai.busy"), {
        action: { label: t("common.retry"), onClick: () => { setChatHistory(baseHistory); sendChat(text); } },
      });
    };

    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/study-assistant`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ lessonId, message: text, history: chatHistory, language }),
      });

      const ct = resp.headers.get("content-type") || "";
      // Edge function now returns JSON (200) on fallback. Detect & surface retry.
      if (ct.includes("application/json")) {
        const json = await resp.json().catch(() => ({}));
        if (json?.error) {
          if (json.retryable === false) {
            toast.error(json.error);
          } else {
            showRetry();
          }
          setChatLoading(false);
          return;
        }
      }

      if (resp.status === 429) { showRetry(); setChatLoading(false); return; }
      if (!resp.ok || !resp.body) { showRetry(); setChatLoading(false); return; }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = ""; let acc = "";
      setChatHistory((h) => [...h, { role: "assistant", content: "" }]);
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) !== -1) {
            let line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            if (!line.startsWith("data: ")) continue;
            const json = line.slice(6).trim();
            if (json === "[DONE]") continue;
            try {
              const p = JSON.parse(json);
              const c = p.choices?.[0]?.delta?.content;
              if (c) { acc += c; setChatHistory((h) => h.map((m, i2) => i2 === h.length - 1 ? { ...m, content: acc } : m)); }
            } catch { buf = line + "\n" + buf; break; }
          }
        }
        // If stream ended with no content at all, show retry
        if (!acc) showRetry();
      } catch (streamErr) {
        console.error("stream error", streamErr);
        if (acc) {
          const final = acc + "\n\n_(response interrupted)_";
          setChatHistory((h) => h.map((m, i2) => i2 === h.length - 1 ? { ...m, content: final } : m));
        } else {
          showRetry();
        }
      }
    } catch (e) {
      console.error(e);
      showRetry();
    }
    setChatLoading(false);
  }, [chatLoading, chatHistory, lessonId, language, session]);


  if (!lesson) return <PageShell><div className="text-muted-foreground">{t("lesson.loading")}</div></PageShell>;

  const renderPlayer = () => {
    if (videoData?.locked) {
      return (
        <div className="aspect-video w-full bg-black flex items-center justify-center p-6 text-center text-white/80 text-sm">
          {t("lesson.video.locked", "Bu dars sizning tarifingizda mavjud emas.")}
        </div>
      );
    }
    if (!videoData) {
      return (
        <div className="aspect-video w-full bg-black flex items-center justify-center text-white/60 text-sm">
          {t("lesson.loading")}
        </div>
      );
    }
    if (videoData.provider === "bunny" && videoData.bunny?.lib && videoData.bunny?.guid) {
      return (
        <BunnyVideoPlayer
          ref={(h) => { (videoRef as any).current = h?.video || null; }}
          libraryId={videoData.bunny.lib}
          videoGuid={videoData.bunny.guid}
          watermarkEmail={user?.email || "student"}
          resumeSeconds={progress?.last_position_seconds || 0}
          onTimeUpdate={onBunnyTime}
          onEnded={onBunnyEnded}
        />
      );
    }
    if (videoData.kind === "iframe" && videoData.url) {
      return (
        <iframe
          className="w-full aspect-video"
          src={videoData.url}
          title={lesson.title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      );
    }
    if ((videoData.kind === "hls" || videoData.kind === "mp4") && videoData.url) {
      return (
        <ProtectedVideo src={videoData.url} videoRef={videoRef} watermarkText={user?.email || "student"} settings={protectionSettings} />
      );
    }
    return (
      <div className="aspect-video w-full bg-black flex items-center justify-center p-6 text-center text-white/80 text-sm">
        {t("lesson.video.unavailable")}
      </div>
    );
  };

  return (
    <PageShell>
      <div className="space-y-5 max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="text-xs text-muted-foreground">
          <Link to={`/course/${courseId}`} className="hover:text-foreground">AI Creators</Link>
          <span className="mx-2">/</span>
          <span>{lesson.title}</span>
        </div>

        <Card className="overflow-hidden bg-black shadow-elevated">
          {renderPlayer()}
        </Card>

        <div className="space-y-4">
          <div className="min-w-0">
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight break-words">{lesson.title}</h1>
          </div>
          <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2">
            {prev && (
              <Button variant="outline" size="sm" asChild className="w-full sm:w-auto min-h-[44px] sm:min-h-0">
                <Link to={`/lesson/${courseId}/${prev.id}`}><ChevronLeft className="h-4 w-4" />{t("lesson.prev")}</Link>
              </Button>
            )}
            <Button variant="outline" size="sm" asChild className="w-full sm:w-auto min-h-[44px] sm:min-h-0">
              <Link to={`/course/${courseId}`}><LayoutList className="h-4 w-4" />{t("lesson.allModules")}</Link>
            </Button>
            <Button variant="outline" size="sm" onClick={markComplete} className="w-full sm:w-auto min-h-[44px] sm:min-h-0">
              <CheckCircle2 className="h-4 w-4" />{t("lesson.markComplete")}
            </Button>
            {next && (
              <Button size="sm" onClick={goNext} className="w-full sm:w-auto min-h-[44px] sm:min-h-0">
                {t("lesson.next")}<ChevronRight className="h-4 w-4" />
              </Button>
            )}
          </div>
          {lesson.description && (
            <Card className="p-5 text-sm leading-relaxed whitespace-pre-wrap">{lesson.description}</Card>
          )}
        </div>

        {lessonId && <HomeworkSection lessonId={lessonId} />}

        <Card className="shadow-soft flex flex-col" style={{ minHeight: 320 }}>
          <div className="px-4 py-3 border-b flex items-center gap-2 flex-wrap">
            <Sparkles className="h-4 w-4" />
            <span className="text-sm font-medium">{t("lesson.ai.title")}</span>
          </div>
          <div className="flex-1 max-h-[400px] overflow-y-auto p-3 space-y-3 scrollbar-thin">
            {chatHistory.length === 0 && (
              <div className="text-xs text-muted-foreground p-2">
                {t("lesson.ai.empty")}
              </div>
            )}
            {chatHistory.map((m, i) => (
              <div key={i} className={`text-sm rounded-lg px-3 py-2 ${m.role === "user" ? "bg-foreground text-background ml-6" : "bg-muted mr-6"}`}>
                <div className="prose-tight whitespace-pre-wrap">{m.content || (chatLoading && i === chatHistory.length - 1 ? "…" : "")}</div>
              </div>
            ))}
          </div>
          <div className="p-3 border-t space-y-2">
            <div className="flex flex-wrap gap-1">
              {[
                { key: "explain", label: t("lesson.ai.chips.explain") },
                { key: "practice", label: t("lesson.ai.chips.practice") },
                { key: "summarize", label: t("lesson.ai.chips.summarize") },
                { key: "stuck", label: t("lesson.ai.chips.stuck") },
              ].map((q) => (
                <button key={q.key} onClick={() => sendChat(q.label)} disabled={chatLoading} className="text-[11px] px-2 py-1 rounded-full border hover:bg-muted disabled:opacity-50">{q.label}</button>
              ))}
            </div>
            <form onSubmit={(e) => { e.preventDefault(); sendChat(chatInput); }} className="flex gap-2">
              <Input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder={t("lesson.ai.placeholder")} disabled={chatLoading} className="min-h-[44px]" />
              <Button type="submit" size="icon" disabled={chatLoading || !chatInput.trim()} className="h-11 w-11 shrink-0"><Send className="h-4 w-4" /></Button>
            </form>
          </div>
        </Card>
      </div>
    </PageShell>
  );
}
