import { useEffect, useRef, useState, useCallback } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CheckCircle2, Circle, ChevronRight, ChevronLeft, Send, Sparkles, Bookmark, Clock, LayoutList } from "lucide-react";
import { toast } from "sonner";
import { ProtectedVideo } from "@/components/lesson/ProtectedVideo";
import { BunnyVideoPlayer } from "@/components/BunnyVideoPlayer";

interface Msg { role: "user" | "assistant"; content: string }

const LANGUAGES = [
  { code: "en", label: "English" }, { code: "ru", label: "Русский" },
  { code: "uz", label: "O'zbek" }, { code: "es", label: "Español" },
  { code: "pt", label: "Português" }, { code: "ar", label: "العربية" },
  { code: "fr", label: "Français" }, { code: "de", label: "Deutsch" },
  { code: "hi", label: "हिन्दी" }, { code: "zh", label: "中文" },
];
function detectLang(): string {
  if (typeof navigator === "undefined") return "en";
  const code = (navigator.language || "en").toLowerCase().split("-")[0];
  return LANGUAGES.some((l) => l.code === code) ? code : "en";
}

export default function LessonPage() {
  const { courseId, lessonId } = useParams();
  const { user, session } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [lesson, setLesson] = useState<any>(null);
  const [modules, setModules] = useState<any[]>([]);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ last_position_seconds: number } | null>(null);
  const [notes, setNotes] = useState("");
  const [bookmarks, setBookmarks] = useState<any[]>([]);
  const [bmLabel, setBmLabel] = useState("");
  const [chatHistory, setChatHistory] = useState<Msg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [language, setLanguage] = useState<string>(detectLang());
  const [protectionSettings, setProtectionSettings] = useState<any | undefined>(undefined);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Load protection settings + preferred language
  useEffect(() => {
    supabase.rpc("get_public_setting", { _key: "content_protection" }).then(({ data }) => {
      if (data) setProtectionSettings(data);
    });
  }, []);
  useEffect(() => {
    if (!user) return;
    supabase.from("profiles").select("preferred_language").eq("id", user.id).maybeSingle().then(({ data }) => {
      const pl = (data as any)?.preferred_language;
      if (pl && LANGUAGES.some((l) => l.code === pl)) setLanguage(pl);
    });
  }, [user]);

  const onLanguageChange = (code: string) => {
    setLanguage(code);
    if (user) supabase.from("profiles").update({ preferred_language: code }).eq("id", user.id).then(() => {});
  };


  // Load
  useEffect(() => {
    if (!lessonId || !user || !courseId) return;
    (async () => {
      const { data: l } = await supabase.from("lessons").select("*, modules(course_id)").eq("id", lessonId).maybeSingle();
      setLesson(l);
      const { data: ms } = await supabase
        .from("modules")
        .select("*, lessons(id, title, position)")
        .eq("course_id", courseId)
        .order("position", { ascending: true });
      (ms || []).forEach((m: any) => m.lessons.sort((a: any, b: any) => a.position - b.position));
      setModules(ms || []);
      const lessonIds = (ms || []).flatMap((m: any) => m.lessons.map((x: any) => x.id));
      const { data: prog } = await supabase.from("lesson_progress").select("lesson_id, completed_at, last_position_seconds")
        .eq("user_id", user.id).in("lesson_id", lessonIds.length ? lessonIds : ["00000000-0000-0000-0000-000000000000"]);
      setCompleted(new Set((prog || []).filter((p: any) => p.completed_at).map((p: any) => p.lesson_id)));
      const cur = (prog || []).find((p: any) => p.lesson_id === lessonId);
      setProgress(cur || null);

      const { data: n } = await supabase.from("lesson_notes").select("body").eq("user_id", user.id).eq("lesson_id", lessonId).maybeSingle();
      setNotes(n?.body || "");
      const { data: bm } = await supabase.from("lesson_bookmarks").select("*").eq("user_id", user.id).eq("lesson_id", lessonId).order("timestamp_seconds");
      setBookmarks(bm || []);
      const { data: hist } = await supabase.from("ai_chat_messages").select("role, content").eq("user_id", user.id).eq("lesson_id", lessonId).order("created_at").limit(50);
      setChatHistory((hist || []) as Msg[]);
    })();
  }, [lessonId, courseId, user]);

  // Resume
  useEffect(() => {
    if (videoRef.current && progress?.last_position_seconds) {
      videoRef.current.currentTime = progress.last_position_seconds;
    }
  }, [progress, lesson]);

  // Save position every 5s + auto-complete at 90%
  useEffect(() => {
    if (!user || !lessonId) return;
    const id = setInterval(async () => {
      const v = videoRef.current; if (!v || v.paused) return;
      const cur = Math.floor(v.currentTime);
      const dur = v.duration || 0;
      const isComplete = dur > 0 && cur / dur >= 0.9;
      await supabase.from("lesson_progress").upsert({
        user_id: user.id, lesson_id: lessonId,
        last_position_seconds: cur,
        seconds_watched: cur,
        completed_at: isComplete ? new Date().toISOString() : null,
      }, { onConflict: "user_id,lesson_id" });
      if (isComplete) setCompleted((s) => new Set(s).add(lessonId));
    }, 5000);
    return () => clearInterval(id);
  }, [user, lessonId]);

  // Notes autosave (debounced)
  useEffect(() => {
    if (!user || !lessonId) return;
    const t = setTimeout(async () => {
      await supabase.from("lesson_notes").upsert({ user_id: user.id, lesson_id: lessonId, body: notes }, { onConflict: "user_id,lesson_id" });
    }, 700);
    return () => clearTimeout(t);
  }, [notes, user, lessonId]);

  const markComplete = async () => {
    if (!user || !lessonId) return;
    await supabase.from("lesson_progress").upsert({
      user_id: user.id, lesson_id: lessonId, completed_at: new Date().toISOString(),
      last_position_seconds: Math.floor(videoRef.current?.currentTime || 0),
    }, { onConflict: "user_id,lesson_id" });
    setCompleted((s) => new Set(s).add(lessonId));
    toast.success(t("lesson.markedCompleteToast"));
  };

  const flat = modules.flatMap((m) => m.lessons.map((l: any) => ({ ...l, moduleTitle: m.title })));
  const idx = flat.findIndex((l: any) => l.id === lessonId);
  const prev = idx > 0 ? flat[idx - 1] : null;
  const next = idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : null;

  const goNext = async () => {
    await markComplete();
    if (next) navigate(`/lesson/${courseId}/${next.id}`);
  };

  const insertTimestamp = () => {
    const v = videoRef.current; if (!v) return;
    const t = Math.floor(v.currentTime);
    const m = Math.floor(t / 60); const s = (t % 60).toString().padStart(2, "0");
    setNotes((n) => `${n}${n && !n.endsWith("\n") ? " " : ""}[${m}:${s}] `);
  };

  const addBookmark = async () => {
    if (!user || !lessonId || !videoRef.current) return;
    const ts = Math.floor(videoRef.current.currentTime);
    const defaultLabel = `${t("lesson.bookmarks.atPrefix")} ${Math.floor(ts / 60)}:${(ts % 60).toString().padStart(2, "0")}`;
    const { data } = await supabase.from("lesson_bookmarks").insert({ user_id: user.id, lesson_id: lessonId, timestamp_seconds: ts, label: bmLabel || defaultLabel }).select().single();
    if (data) setBookmarks([...bookmarks, data].sort((a, b) => a.timestamp_seconds - b.timestamp_seconds));
    setBmLabel("");
  };

  const seekTo = (sec: number) => { if (videoRef.current) { videoRef.current.currentTime = sec; videoRef.current.play(); } };

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

  const provider = lesson.video_provider || "upload";
  const bunnyRaw: string = lesson.provider_video_id || lesson.video_url || "";
  const [bunnyLib, bunnyGuid] = bunnyRaw.includes("/") ? bunnyRaw.split("/") : ["", ""];

  const renderPlayer = () => {
    if (provider === "bunny") {
      if (!bunnyLib || !bunnyGuid) {
        return (
          <div className="aspect-video w-full bg-black flex items-center justify-center p-6 text-center text-white/80 text-sm">
            {t("lesson.bunny.invalidId")}
          </div>
        );
      }
      return (
        <BunnyVideoPlayer
          ref={(h) => { (videoRef as any).current = h?.video || null; }}
          libraryId={bunnyLib}
          videoGuid={bunnyGuid}
          watermarkEmail={user?.email || "student"}
        />
      );
    }
    if (provider === "youtube" && lesson.provider_video_id) {
      return (
        <iframe
          className="w-full aspect-video"
          src={`https://www.youtube.com/embed/${lesson.provider_video_id}?rel=0&modestbranding=1`}
          title={lesson.title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      );
    }
    if (provider === "vimeo" && lesson.provider_video_id) {
      return (
        <iframe
          className="w-full aspect-video"
          src={`https://player.vimeo.com/video/${lesson.provider_video_id}`}
          title={lesson.title}
          allow="autoplay; fullscreen; picture-in-picture"
          allowFullScreen
        />
      );
    }
    if (provider === "mux" && lesson.provider_video_id) {
      // Mux HLS could be wired similarly to Bunny; for now use ProtectedVideo with the URL.
      const muxUrl = `https://stream.mux.com/${lesson.provider_video_id}.m3u8`;
      return (
        <ProtectedVideo src={muxUrl} videoRef={videoRef} watermarkText={user?.email || "student"} settings={protectionSettings} />
      );
    }
    // Upload / direct URL
    if (lesson.video_url) {
      return (
        <ProtectedVideo src={lesson.video_url} videoRef={videoRef} watermarkText={user?.email || "student"} settings={protectionSettings} />
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
      <div className="grid lg:grid-cols-[1fr_340px] gap-6">
        <div className="space-y-5 min-w-0">
          <div className="text-xs text-muted-foreground">
            <Link to={`/course/${courseId}`} className="hover:text-foreground">AI Creators</Link>
            <span className="mx-2">/</span>
            <span>{lesson.title}</span>
          </div>

          <Card className="overflow-hidden bg-black shadow-elevated">
            {renderPlayer()}
          </Card>


          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight">{lesson.title}</h1>
              <p className="text-sm text-muted-foreground mt-1">{lesson.description}</p>
            </div>
            <div className="flex gap-2">
              {prev && <Button variant="outline" size="sm" asChild><Link to={`/lesson/${courseId}/${prev.id}`}><ChevronLeft className="h-4 w-4" />{t("lesson.prev")}</Link></Button>}
              <Button variant="outline" size="sm" onClick={markComplete}><CheckCircle2 className="h-4 w-4" />{t("lesson.markComplete")}</Button>
              {next && <Button size="sm" onClick={goNext}>{t("lesson.next")}<ChevronRight className="h-4 w-4" /></Button>}
            </div>
          </div>

          <Tabs defaultValue="notes">
            <TabsList>
              <TabsTrigger value="description">{t("lesson.tabs.description")}</TabsTrigger>
              <TabsTrigger value="notes">{t("lesson.tabs.notes")}</TabsTrigger>
              <TabsTrigger value="bookmarks">{t("lesson.tabs.bookmarks")}</TabsTrigger>
              <TabsTrigger value="transcript">{t("lesson.tabs.transcript")}</TabsTrigger>
            </TabsList>
            <TabsContent value="description"><Card className="p-5 text-sm leading-relaxed">{lesson.description}</Card></TabsContent>
            <TabsContent value="notes">
              <Card className="p-5 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{t("lesson.notes.autosave")}</span>
                  <Button size="sm" variant="ghost" onClick={insertTimestamp}><Clock className="h-3.5 w-3.5" />{t("lesson.notes.insertTimestamp")}</Button>
                </div>
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("lesson.notes.placeholder")} rows={10} className="resize-none" />
              </Card>
            </TabsContent>
            <TabsContent value="bookmarks">
              <Card className="p-5 space-y-3">
                <div className="flex gap-2">
                  <Input placeholder={t("lesson.bookmarks.labelPlaceholder")} value={bmLabel} onChange={(e) => setBmLabel(e.target.value)} />
                  <Button size="sm" onClick={addBookmark}><Bookmark className="h-3.5 w-3.5" />{t("lesson.bookmarks.addAtCurrent")}</Button>
                </div>
                <ul className="divide-y">
                  {bookmarks.length === 0 && <li className="text-sm text-muted-foreground py-4">{t("lesson.bookmarks.empty")}</li>}
                  {bookmarks.map((b) => (
                    <li key={b.id} className="py-2 flex items-center justify-between gap-3">
                      <button onClick={() => seekTo(b.timestamp_seconds)} className="text-sm hover:text-foreground text-left flex-1">
                        <span className="font-mono text-xs text-muted-foreground mr-2">{Math.floor(b.timestamp_seconds / 60)}:{(b.timestamp_seconds % 60).toString().padStart(2, "0")}</span>
                        {b.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            </TabsContent>
            <TabsContent value="transcript">
              <Card className="p-5 text-sm leading-relaxed text-muted-foreground whitespace-pre-wrap">
                {lesson.transcript || t("lesson.transcript.unavailable")}
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        <aside className="space-y-5 lg:sticky lg:top-20 h-fit">
          <Card className="overflow-hidden shadow-soft">
            <div className="px-4 py-3 border-b bg-muted/30 text-xs font-medium text-muted-foreground">{t("lesson.sidebar.courseContent")}</div>
            <div className="max-h-[300px] overflow-y-auto scrollbar-thin">
              {modules.map((m, mi) => (
                <div key={m.id}>
                  <div className="px-4 py-2 text-xs font-medium text-muted-foreground border-b bg-muted/10">{t("lesson.sidebar.moduleN", { n: mi + 1 })}</div>
                  {m.lessons.map((l: any) => (
                    <Link key={l.id} to={`/lesson/${courseId}/${l.id}`}
                      className={`flex items-center gap-2 px-4 py-2 text-sm border-b last:border-b-0 hover:bg-muted/40 ${l.id === lessonId ? "bg-muted/60 font-medium" : ""}`}>
                      {completed.has(l.id) ? <CheckCircle2 className="h-3.5 w-3.5 text-foreground" /> : <Circle className="h-3.5 w-3.5 text-muted-foreground" />}
                      <span className="truncate">{l.title}</span>
                    </Link>
                  ))}
                </div>
              ))}
            </div>
          </Card>

          <Card className="shadow-soft flex flex-col" style={{ minHeight: 320 }}>
            <div className="px-4 py-3 border-b flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              <span className="text-sm font-medium">{t("lesson.ai.title")}</span>
              <div className="ml-auto">
                <Select value={language} onValueChange={onLanguageChange}>
                  <SelectTrigger className="h-7 text-xs w-[120px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LANGUAGES.map((l) => <SelectItem key={l.code} value={l.code} className="text-xs">{l.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex-1 max-h-[300px] overflow-y-auto p-3 space-y-3 scrollbar-thin">
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
                <Input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder={t("lesson.ai.placeholder")} disabled={chatLoading} />
                <Button type="submit" size="icon" disabled={chatLoading || !chatInput.trim()}><Send className="h-4 w-4" /></Button>
              </form>
            </div>
          </Card>
        </aside>
      </div>
    </PageShell>
  );
}
