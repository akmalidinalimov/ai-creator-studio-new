import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Plus, BookOpen, Pencil, Clock } from "lucide-react";
import { toast } from "sonner";

interface CourseRow {
  id: string; title: string; tagline: string | null; cover_url: string | null;
  duration_hours: number | null; published: boolean; updated_at: string; lesson_count: number;
}

export default function AdminCourses() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [tagline, setTagline] = useState("");
  const [description, setDescription] = useState("");

  const load = async () => {
    setLoading(true);
    const { data: cs } = await supabase
      .from("courses")
      .select("id, title, tagline, cover_url, duration_hours, published, updated_at, modules(lessons(id))")
      .order("updated_at", { ascending: false });
    const rows: CourseRow[] = (cs || []).map((c: any) => ({
      id: c.id, title: c.title, tagline: c.tagline, cover_url: c.cover_url,
      duration_hours: c.duration_hours, published: c.published, updated_at: c.updated_at,
      lesson_count: (c.modules || []).reduce((s: number, m: any) => s + (m.lessons?.length || 0), 0),
    }));
    setCourses(rows);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const togglePublished = async (c: CourseRow, value: boolean) => {
    setCourses((prev) => prev.map((x) => x.id === c.id ? { ...x, published: value } : x));
    const { error } = await supabase.from("courses").update({ published: value }).eq("id", c.id);
    if (error) {
      toast.error(error.message);
      setCourses((prev) => prev.map((x) => x.id === c.id ? { ...x, published: !value } : x));
    } else {
      toast.success(value ? t("admin.courses.coursePublished") : t("admin.courses.courseUnpublished"));
    }
  };

  const handleCreate = async () => {
    if (!title.trim()) { toast.error(t("admin.courses.titleRequired")); return; }
    setCreating(true);
    const { data, error } = await supabase.from("courses").insert({
      title: title.trim(), tagline: tagline.trim() || null, description: description.trim() || null, published: false,
    }).select("id").single();
    setCreating(false);
    if (error) { toast.error(error.message); return; }
    toast.success(t("admin.courses.courseCreated"));
    setOpen(false);
    setTitle(""); setTagline(""); setDescription("");
    navigate(`/admin/courses/${data.id}`);
  };

  return (
    <PageShell>
      <div className="space-y-6">
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">{t("admin.courses.title")}</h1>
            <p className="text-muted-foreground mt-1">{t("admin.courses.subtitle")}</p>
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button><Plus className="h-4 w-4" />{t("admin.courses.newCourse")}</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>{t("admin.courses.createTitle")}</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div className="space-y-1.5"><Label>{t("admin.courses.fieldTitle")}</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("admin.courses.fieldTitlePh")} /></div>
                <div className="space-y-1.5"><Label>{t("admin.courses.fieldTagline")}</Label><Input value={tagline} onChange={(e) => setTagline(e.target.value)} placeholder={t("admin.courses.fieldTaglinePh")} /></div>
                <div className="space-y-1.5"><Label>{t("admin.courses.fieldDescription")}</Label><Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} /></div>
                <p className="text-xs text-muted-foreground">{t("admin.courses.savedAsDraft")}</p>
              </div>
              <DialogFooter><Button onClick={handleCreate} disabled={creating}>{t("admin.courses.createAndEdit")}</Button></DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {loading ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[0,1,2].map((i) => <Skeleton key={i} className="h-56 rounded-xl" />)}
          </div>
        ) : courses.length === 0 ? (
          <Card className="p-10 text-center">
            <BookOpen className="h-8 w-8 mx-auto text-muted-foreground" />
            <p className="mt-3 text-muted-foreground">{t("admin.courses.empty")}</p>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {courses.map((c) => (
              <Card key={c.id} className="overflow-hidden shadow-soft hover:shadow-elevated transition-shadow flex flex-col">
                <div className="aspect-video bg-muted flex items-center justify-center text-muted-foreground border-b">
                  {c.cover_url ? (
                    <img src={c.cover_url} alt={c.title} className="w-full h-full object-cover" />
                  ) : (
                    <BookOpen className="h-8 w-8" />
                  )}
                </div>
                <div className="p-5 flex-1 flex flex-col">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className={`text-[11px] px-2 py-0.5 rounded-full ${c.published ? "bg-foreground text-background" : "bg-muted text-muted-foreground"}`}>
                      {c.published ? t("admin.courses.published") : t("admin.courses.draft")}
                    </span>
                    <span className="text-[11px] text-muted-foreground">{new Date(c.updated_at).toLocaleDateString()}</span>
                  </div>
                  <h3 className="text-lg font-semibold tracking-tight truncate">{c.title}</h3>
                  <p className="text-sm text-muted-foreground line-clamp-2 mt-1 min-h-[2.5rem]">{c.tagline || "—"}</p>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mt-3">
                    <span className="flex items-center gap-1"><BookOpen className="h-3.5 w-3.5" /> {t("admin.courses.lessonsCount", { n: c.lesson_count })}</span>
                    <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {t("admin.courses.hours", { n: c.duration_hours ?? 0 })}</span>
                  </div>
                  <div className="flex items-center justify-between mt-5 pt-4 border-t">
                    <div className="flex items-center gap-2">
                      <Switch checked={c.published} onCheckedChange={(v) => togglePublished(c, v)} />
                      <span className="text-xs text-muted-foreground">{c.published ? t("admin.courses.live") : t("admin.courses.hidden")}</span>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => navigate(`/admin/courses/${c.id}`)}>
                      <Pencil className="h-3.5 w-3.5" /> {t("admin.courses.edit")}
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}
