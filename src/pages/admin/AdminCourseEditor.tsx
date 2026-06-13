import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { LessonDrawer } from "@/components/admin/LessonDrawer";
import { ModuleQuizEditor } from "@/components/admin/ModuleQuizEditor";
import { KnowledgeManager } from "@/components/admin/KnowledgeManager";
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors, DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy, arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  GripVertical, Plus, ChevronDown, ChevronRight, Trash2, ExternalLink, Eye, EyeOff, Image as ImageIcon, Upload, MoreVertical, Layers,
} from "lucide-react";
import { toast } from "sonner";

interface Lesson { id: string; title: string; position: number; published: boolean; video_storage_path: string | null; video_url: string | null; provider_video_id: string | null; video_provider: string; duration_seconds: number | null; }
interface Module { id: string; title: string; summary: string | null; position: number; lessons: Lesson[] }

export default function AdminCourseEditor() {
  const { courseId } = useParams();
  const { t } = useTranslation();
  const { user } = useAuth();
  const [course, setCourse] = useState<any>(null);
  const [modules, setModules] = useState<Module[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set());
  const [drawerLessonId, setDrawerLessonId] = useState<string | null>(null);
  const [quizModuleId, setQuizModuleId] = useState<string | null>(null);
  const coverInput = useRef<HTMLInputElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const load = async () => {
    if (!courseId) return;
    setLoading(true);
    const { data: c } = await supabase.from("courses").select("*").eq("id", courseId).maybeSingle();
    setCourse(c);
    const { data: ms } = await supabase
      .from("modules")
      .select("*, lessons(id, title, position, published, video_storage_path, video_url, provider_video_id, video_provider, duration_seconds)")
      .eq("course_id", courseId)
      .order("position", { ascending: true });
    const sorted: Module[] = (ms || []).map((m: any) => ({
      ...m,
      lessons: (m.lessons || []).sort((a: any, b: any) => a.position - b.position),
    }));
    setModules(sorted);
    if (expandedModules.size === 0 && sorted[0]) setExpandedModules(new Set([sorted[0].id]));
    setLoading(false);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [courseId]);

  const updateCourse = async (patch: Record<string, any>) => {
    setCourse((c: any) => ({ ...c, ...patch }));
    const { error } = await (supabase.from("courses") as any).update(patch).eq("id", courseId!);
    if (error) toast.error(error.message);
  };

  const addModule = async () => {
    const pos = modules.length;
    const { data, error } = await supabase.from("modules").insert({
      course_id: courseId!, title: "New module", position: pos,
    }).select("*, lessons(id, title, position, published, video_storage_path, video_url, provider_video_id, video_provider, duration_seconds)").single();
    if (error) { toast.error(error.message); return; }
    const m: Module = { ...(data as any), lessons: [] };
    setModules((prev) => [...prev, m]);
    setExpandedModules((s) => new Set(s).add(m.id));
  };

  const updateModule = async (id: string, patch: Partial<Module>) => {
    setModules((prev) => prev.map((m) => m.id === id ? { ...m, ...patch } as Module : m));
    const { lessons: _omit, ...dbPatch } = patch as any;
    const { error } = await (supabase.from("modules") as any).update(dbPatch).eq("id", id);
    if (error) toast.error(error.message);
  };

  const deleteModule = async (id: string) => {
    if (!confirm(t("admin.courseEditor.deleteModuleConfirm"))) return;
    const { error } = await supabase.from("modules").delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    setModules((prev) => prev.filter((m) => m.id !== id));
    toast.success(t("admin.courseEditor.moduleDeleted"));
  };

  const addLesson = async (moduleId: string) => {
    const mod = modules.find((m) => m.id === moduleId);
    if (!mod) return;
    const pos = mod.lessons.length;
    const { data, error } = await supabase.from("lessons").insert({
      module_id: moduleId, title: "New lesson", position: pos, video_provider: "upload", published: false,
    }).select("id, title, position, published, video_storage_path, video_url, provider_video_id, video_provider, duration_seconds").single();
    if (error) { toast.error(error.message); return; }
    setModules((prev) => prev.map((m) => m.id === moduleId ? { ...m, lessons: [...m.lessons, data as Lesson] } : m));
    setDrawerLessonId(data.id);
  };

  const onModuleDragEnd = async (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = modules.findIndex((m) => m.id === active.id);
    const newIdx = modules.findIndex((m) => m.id === over.id);
    const next = arrayMove(modules, oldIdx, newIdx);
    setModules(next);
    await Promise.all(next.map((m, i) => supabase.from("modules").update({ position: i }).eq("id", m.id)));
  };

  const onLessonDragEnd = async (moduleId: string, e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const mod = modules.find((m) => m.id === moduleId)!;
    const oldIdx = mod.lessons.findIndex((l) => l.id === active.id);
    const newIdx = mod.lessons.findIndex((l) => l.id === over.id);
    const nextLessons = arrayMove(mod.lessons, oldIdx, newIdx);
    setModules((prev) => prev.map((m) => m.id === moduleId ? { ...m, lessons: nextLessons } : m));
    await Promise.all(nextLessons.map((l, i) => supabase.from("lessons").update({ position: i }).eq("id", l.id)));
  };

  const uploadCover = async (file: File) => {
    if (!courseId) return;
    const ext = file.name.split(".").pop() || "jpg";
    const path = `${courseId}/cover-${Date.now()}.${ext}`;
    const { error } = await supabase.storage.from("course-covers").upload(path, file, {
      cacheControl: "31536000", upsert: true, contentType: file.type,
    });
    if (error) { toast.error(error.message); return; }
    const { data: pub } = supabase.storage.from("course-covers").getPublicUrl(path);
    await updateCourse({ cover_url: pub.publicUrl });
    toast.success(t("admin.courseEditor.coverUploaded"));
  };

  const totalLessons = modules.reduce((s, m) => s + m.lessons.length, 0);
  const totalSeconds = modules.reduce((s, m) => s + m.lessons.reduce((ls, l) => ls + (l.duration_seconds || 0), 0), 0);
  const totalHours = (totalSeconds / 3600).toFixed(1);

  if (loading) return <PageShell><Skeleton className="h-96" /></PageShell>;
  if (!course) return <PageShell><p>{t("admin.courseEditor.notFound")}</p></PageShell>;

  return (
    <PageShell>
      <div className="space-y-6">
        <div className="text-xs text-muted-foreground">
          <Link to="/admin/courses" className="hover:text-foreground">{t("admin.courseEditor.breadcrumbCourses")}</Link>
          <span className="mx-2">/</span>
          <span>{course.title}</span>
        </div>

        {/* Header card */}
        <Card className="p-5 md:p-6 shadow-soft space-y-4">
          <div className="flex flex-col md:flex-row gap-5">
            <button
              type="button"
              onClick={() => coverInput.current?.click()}
              className="relative w-full md:w-56 aspect-video shrink-0 rounded-lg border bg-muted overflow-hidden group"
            >
              {course.cover_url ? (
                <img src={course.cover_url} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
                  <ImageIcon className="h-6 w-6" />
                  <span className="text-xs mt-1">{t("admin.courseEditor.addCover")}</span>
                </div>
              )}
              <div className="absolute inset-0 bg-foreground/0 group-hover:bg-foreground/40 transition-colors flex items-center justify-center text-background opacity-0 group-hover:opacity-100">
                <Upload className="h-5 w-5" />
              </div>
            </button>
            <input
              type="file" accept="image/*" hidden ref={coverInput}
              onChange={(e) => e.target.files?.[0] && uploadCover(e.target.files[0])}
            />
            <div className="flex-1 space-y-3 min-w-0">
              <Input
                value={course.title}
                onChange={(e) => setCourse((c: any) => ({ ...c, title: e.target.value }))}
                onBlur={(e) => updateCourse({ title: e.target.value })}
                className="text-xl font-semibold"
              />
              <Input
                value={course.tagline || ""}
                onChange={(e) => setCourse((c: any) => ({ ...c, tagline: e.target.value }))}
                onBlur={(e) => updateCourse({ tagline: e.target.value })}
                placeholder={t("admin.courseEditor.shortTagline")}
              />
              <Textarea
                value={course.description || ""}
                onChange={(e) => setCourse((c: any) => ({ ...c, description: e.target.value }))}
                onBlur={(e) => updateCourse({ description: e.target.value, duration_hours: parseFloat(totalHours) })}
                rows={3}
                placeholder={t("admin.courseEditor.fullDescription")}
              />
              <div className="flex flex-wrap items-center gap-4 pt-1">
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={course.published} onCheckedChange={(v) => updateCourse({ published: v })} />
                  {course.published ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                  <span>{course.published ? t("admin.common.published") : t("admin.common.draft")}</span>
                </label>
                <span className="text-xs text-muted-foreground">{t("admin.courseEditor.modulesLessons", { modules: modules.length, lessons: totalLessons, hours: totalHours })}</span>
                <Button size="sm" variant="outline" asChild>
                  <a href={`/course/${courseId}`} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-3.5 w-3.5" /> {t("admin.courseEditor.viewAsStudent")}
                  </a>
                </Button>
              </div>
            </div>
          </div>
        </Card>

        {/* Per-course tiers (access levels) */}
        <CourseTiers courseId={courseId!} moduleCount={modules.length} />

        {/* Per-course AI override */}
        <CourseAIOverride courseId={courseId!} initial={course} onSaved={(patch) => setCourse((c: any) => ({ ...c, ...patch }))} />

        {/* Modules */}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onModuleDragEnd}>
          <SortableContext items={modules.map((m) => m.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-3">
              {modules.map((m, mi) => (
                <SortableModule
                  key={m.id}
                  module={m}
                  index={mi}
                  expanded={expandedModules.has(m.id)}
                  onToggle={() => setExpandedModules((s) => {
                    const n = new Set(s); n.has(m.id) ? n.delete(m.id) : n.add(m.id); return n;
                  })}
                  onUpdate={(patch) => updateModule(m.id, patch)}
                  onDelete={() => deleteModule(m.id)}
                  onAddLesson={() => addLesson(m.id)}
                  onEditLesson={(id) => setDrawerLessonId(id)}
                  onLessonDragEnd={(e) => onLessonDragEnd(m.id, e)}
                  sensors={sensors}
                  onOpenQuiz={() => setQuizModuleId(m.id)}
                  t={t}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        <Button onClick={addModule} variant="outline" className="w-full">
          <Plus className="h-4 w-4" /> {t("admin.courseEditor.addModule")}
        </Button>

        {drawerLessonId && (
          <LessonDrawer
            lessonId={drawerLessonId}
            onClose={() => setDrawerLessonId(null)}
            onChanged={load}
          />
        )}
        {quizModuleId && (
          <ModuleQuizEditor
            moduleId={quizModuleId}
            onClose={() => setQuizModuleId(null)}
          />
        )}
      </div>
    </PageShell>
  );
}

function SortableModule({
  module: m, index, expanded, onToggle, onUpdate, onDelete, onAddLesson, onEditLesson, onLessonDragEnd, sensors, onOpenQuiz, t,
}: any) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: m.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  return (
    <Card ref={setNodeRef} style={style} className="overflow-hidden shadow-soft">
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/20">
        <button {...attributes} {...listeners} className="touch-none p-1 cursor-grab text-muted-foreground hover:text-foreground" aria-label="Drag module">
          <GripVertical className="h-4 w-4" />
        </button>
        <button onClick={onToggle} className="text-muted-foreground hover:text-foreground p-1" aria-label="Toggle">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <span className="text-xs text-muted-foreground tabular-nums w-16">{t("admin.courseEditor.moduleN", { n: index + 1 })}</span>
        <Input
          value={m.title}
          onChange={(e) => onUpdate({ title: e.target.value })}
          onBlur={(e) => onUpdate({ title: e.target.value })}
          className="flex-1 h-8"
        />
        <span className="text-xs text-muted-foreground hidden sm:inline">{t("admin.courseEditor.lessonsCount", { n: m.lessons.length })}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Module actions">
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="h-4 w-4 mr-2" /> {t("admin.courseEditor.deleteModule")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {expanded && (
        <div className="p-4 space-y-3">
          <Textarea
            value={m.summary || ""}
            onChange={(e) => onUpdate({ summary: e.target.value })}
            onBlur={(e) => onUpdate({ summary: e.target.value })}
            placeholder={t("admin.courseEditor.moduleSummary")}
            rows={2}
          />
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onLessonDragEnd}>
            <SortableContext items={m.lessons.map((l: Lesson) => l.id)} strategy={verticalListSortingStrategy}>
              <ul className="border rounded-md divide-y">
                {m.lessons.length === 0 && <li className="p-3 text-sm text-muted-foreground text-center">{t("admin.courseEditor.noLessons")}</li>}
                {m.lessons.map((l: Lesson, j: number) => (
                  <SortableLesson key={l.id} lesson={l} index={j} onEdit={() => onEditLesson(l.id)} t={t} />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={onAddLesson}><Plus className="h-3.5 w-3.5" /> {t("admin.courseEditor.addLesson")}</Button>
            <Button variant="ghost" size="sm" onClick={onOpenQuiz}>{t("admin.courseEditor.editModuleQuiz")}</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function SortableLesson({ lesson: l, index, onEdit, t }: { lesson: Lesson; index: number; onEdit: () => void; t: (k: string) => string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: l.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };
  const hasVideo = !!l.video_storage_path || !!l.provider_video_id || !!l.video_url;
  const status = !l.published ? { label: t("admin.courseEditor.lessonStatus.draft"), cls: "bg-muted text-muted-foreground" }
                : !hasVideo ? { label: t("admin.courseEditor.lessonStatus.noVideo"), cls: "bg-amber-100 text-amber-900" }
                : { label: t("admin.courseEditor.lessonStatus.hasVideo"), cls: "bg-foreground text-background" };
  return (
    <li ref={setNodeRef} style={style} className="flex items-center gap-2 px-3 py-2 hover:bg-muted/30">
      <button {...attributes} {...listeners} className="touch-none p-1 cursor-grab text-muted-foreground hover:text-foreground" aria-label="Drag lesson">
        <GripVertical className="h-4 w-4" />
      </button>
      <span className="text-xs text-muted-foreground tabular-nums w-6">{index + 1}.</span>
      <span className="flex-1 text-sm truncate">{l.title}</span>
      <span className="text-[10px] text-muted-foreground hidden sm:inline">{Math.round((l.duration_seconds || 0) / 60)}m</span>
      <span className={`text-[10px] px-2 py-0.5 rounded-full ${status.cls}`}>{status.label}</span>
      <Button variant="ghost" size="sm" onClick={onEdit}>{t("admin.common.edit")}</Button>
    </li>
  );
}

function CourseTiers({ courseId, moduleCount }: { courseId: string; moduleCount: number }) {
  const { t } = useTranslation();
  const [tiers, setTiers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    const { data } = await supabase.from("course_tiers" as any).select("*").eq("course_id", courseId).order("position");
    setTiers((data as any[]) || []);
    setLoading(false);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [courseId]);

  const addTier = async () => {
    const { data, error } = await (supabase.from("course_tiers" as any).insert({
      course_id: courseId, name: t("admin.tiers.newTier"), module_limit: null, position: tiers.length,
    }) as any).select("*").single();
    if (error) { toast.error(error.message); return; }
    setTiers((p) => [...p, data]);
  };
  const patchTier = async (id: string, patch: any) => {
    setTiers((p) => p.map((x) => x.id === id ? { ...x, ...patch } : x));
    const { error } = await (supabase.from("course_tiers" as any) as any).update(patch).eq("id", id);
    if (error) toast.error(error.message);
  };
  const removeTier = async (id: string) => {
    if (!confirm(t("admin.tiers.deleteConfirm"))) return;
    const { error } = await (supabase.from("course_tiers" as any) as any).delete().eq("id", id);
    if (error) { toast.error(error.message); return; }
    setTiers((p) => p.filter((x) => x.id !== id));
  };
  const parseLimit = (v: string): number | null => v.trim() === "" ? null : Math.max(1, parseInt(v, 10) || 1);

  return (
    <Card className="p-5 md:p-6 shadow-soft space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-semibold text-sm">{t("admin.tiers.title")}</h3>
        </div>
        <Button size="sm" variant="outline" onClick={addTier}><Plus className="h-3.5 w-3.5" /> {t("admin.tiers.add")}</Button>
      </div>
      {loading ? null : tiers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("admin.tiers.emptyHint")}</p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t("admin.tiers.hint")}</p>
          {tiers.map((ti) => (
            <div key={ti.id} className="flex items-center gap-2 flex-wrap">
              <Input
                value={ti.name || ""}
                onChange={(e) => setTiers((p) => p.map((x) => x.id === ti.id ? { ...x, name: e.target.value } : x))}
                onBlur={(e) => patchTier(ti.id, { name: e.target.value })}
                className="max-w-[200px]"
                placeholder={t("admin.tiers.namePh")}
              />
              <div className="flex items-center gap-1.5">
                <Input
                  type="number" min={1} max={moduleCount || undefined}
                  value={ti.module_limit ?? ""}
                  onChange={(e) => setTiers((p) => p.map((x) => x.id === ti.id ? { ...x, module_limit: parseLimit(e.target.value) } : x))}
                  onBlur={(e) => patchTier(ti.id, { module_limit: parseLimit(e.target.value) })}
                  className="w-24"
                  placeholder={t("admin.tiers.all")}
                />
                <span className="text-xs text-muted-foreground">{t("admin.tiers.ofModules", { n: moduleCount })}</span>
              </div>
              <Button size="sm" variant="ghost" onClick={() => removeTier(ti.id)}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function CourseAIOverride({ courseId, initial, onSaved }: { courseId: string; initial: any; onSaved: (p: any) => void }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(!!initial?.ai_system_prompt);
  const [prompt, setPrompt] = useState<string>(initial?.ai_system_prompt || "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const patch = { ai_system_prompt: enabled ? prompt : null };
    const { error } = await (supabase.from("courses") as any).update(patch).eq("id", courseId);
    setBusy(false);
    if (error) return toast.error(error.message);
    onSaved(patch);
    toast.success(t("admin.courseEditor.ai.savedToast"));
  };

  return (
    <Card className="p-5 shadow-soft space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">{t("admin.courseEditor.ai.title")}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("admin.courseEditor.ai.desc")}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={enabled} onCheckedChange={setEnabled} /> {enabled ? t("admin.courseEditor.ai.customOn") : t("admin.courseEditor.ai.customOff")}
        </label>
      </div>
      {enabled && (
        <>
          <Textarea rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("admin.courseEditor.ai.promptPh")} />
          <div className="flex justify-end">
            <Button onClick={save} disabled={busy}>{busy ? t("admin.common.saving") : t("admin.courseEditor.ai.savePrompt")}</Button>
          </div>
        </>
      )}

      <div className="pt-4 border-t space-y-2">
        <div>
          <h4 className="font-medium text-sm">{t("admin.courseEditor.ai.kbTitle")}</h4>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("admin.courseEditor.ai.kbDesc")}
          </p>
        </div>
        <KnowledgeManager scope="course" courseId={courseId} />
      </div>
    </Card>
  );
}
