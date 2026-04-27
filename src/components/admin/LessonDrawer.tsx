import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDropzone } from "react-dropzone";
import { Upload, Trash2, FileText, X, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface Props { lessonId: string; onClose: () => void; onChanged: () => void }

const MAX_INLINE_UPLOAD = 2 * 1024 * 1024 * 1024; // 2 GB

export const LessonDrawer = ({ lessonId, onClose, onChanged }: Props) => {
  const { t } = useTranslation();
  const [lesson, setLesson] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ pct: number; mbps: number; etaSec: number; fileName: string } | null>(null);
  const cancelRef = useRef<{ aborted: boolean }>({ aborted: false });

  const load = useCallback(async () => {
    const { data } = await supabase.from("lessons").select("*").eq("id", lessonId).maybeSingle();
    setLesson(data);
  }, [lessonId]);

  useEffect(() => { load(); }, [load]);

  const update = async (patch: any) => {
    setLesson((l: any) => ({ ...l, ...patch }));
    const { error } = await supabase.from("lessons").update(patch).eq("id", lessonId);
    if (error) toast.error(error.message);
  };

  const onDrop = async (files: File[]) => {
    if (!files[0]) return;
    const file = files[0];
    if (file.size > MAX_INLINE_UPLOAD) {
      toast.error("File too large (max 2 GB). Use Bunny Stream or Mux for bigger files.");
      return;
    }
    setUploading(true);
    cancelRef.current.aborted = false;
    setUploadProgress({ pct: 0, mbps: 0, etaSec: 0, fileName: file.name });
    try {
      const ext = file.name.split(".").pop() || "mp4";
      const path = `${lessonId}/video-${Date.now()}.${ext}`;
      // Use signed upload URL for direct browser->storage upload (no edge function)
      const { data: signed, error: signErr } = await supabase.storage.from("lesson-videos").createSignedUploadUrl(path);
      if (signErr) throw signErr;

      const xhr = new XMLHttpRequest();
      const start = Date.now();
      const promise = new Promise<void>((resolve, reject) => {
        xhr.open("PUT", signed.signedUrl, true);
        xhr.setRequestHeader("Content-Type", file.type || "video/mp4");
        xhr.setRequestHeader("x-upsert", "true");
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          const elapsed = (Date.now() - start) / 1000;
          const mb = e.loaded / (1024 * 1024);
          const mbps = elapsed > 0 ? mb / elapsed : 0;
          const etaSec = mbps > 0 ? (e.total - e.loaded) / (1024 * 1024) / mbps : 0;
          setUploadProgress({ pct: Math.round((e.loaded / e.total) * 100), mbps, etaSec, fileName: file.name });
        };
        xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`));
        xhr.onerror = () => reject(new Error("Network error"));
        xhr.onabort = () => reject(new Error("Upload cancelled"));
        (cancelRef.current as any).xhr = xhr;
        xhr.send(file);
      });
      await promise;

      // Capture duration and thumbnail
      const blobUrl = URL.createObjectURL(file);
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.src = blobUrl;
      const meta = await new Promise<{ duration: number; thumb: Blob | null }>((res) => {
        v.onloadedmetadata = async () => {
          const dur = isFinite(v.duration) ? Math.round(v.duration) : 0;
          v.currentTime = Math.min(1, dur / 2);
          v.onseeked = async () => {
            try {
              const canvas = document.createElement("canvas");
              canvas.width = v.videoWidth || 640;
              canvas.height = v.videoHeight || 360;
              canvas.getContext("2d")!.drawImage(v, 0, 0, canvas.width, canvas.height);
              const blob = await new Promise<Blob | null>((r) => canvas.toBlob((b) => r(b), "image/jpeg", 0.85));
              res({ duration: dur, thumb: blob });
            } catch { res({ duration: dur, thumb: null }); }
          };
        };
        setTimeout(() => res({ duration: 0, thumb: null }), 8000);
      });
      URL.revokeObjectURL(blobUrl);

      let thumbnail_path: string | null = null;
      if (meta.thumb) {
        const tpath = `${lessonId}/thumb-${Date.now()}.jpg`;
        const { error: tErr } = await supabase.storage.from("lesson-thumbs").upload(tpath, meta.thumb, {
          cacheControl: "31536000", upsert: true, contentType: "image/jpeg",
        });
        if (!tErr) thumbnail_path = tpath;
      }

      await update({
        video_provider: "upload",
        video_storage_path: path,
        video_url: null,
        provider_video_id: null,
        duration_seconds: meta.duration || lesson?.duration_seconds || 0,
        thumbnail_path: thumbnail_path || lesson?.thumbnail_path || null,
      });

      toast.success("Video uploaded");
      onChanged();
    } catch (e: any) {
      if (!cancelRef.current.aborted) toast.error(e?.message || "Upload failed");
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  };

  const cancelUpload = () => {
    cancelRef.current.aborted = true;
    (cancelRef.current as any).xhr?.abort?.();
  };

  const removeVideo = async () => {
    if (lesson?.video_storage_path) {
      await supabase.storage.from("lesson-videos").remove([lesson.video_storage_path]);
    }
    await update({ video_storage_path: null, video_url: null, provider_video_id: null, thumbnail_path: null, duration_seconds: 0 });
    toast.success("Video removed");
  };

  const deleteLesson = async () => {
    if (!confirm("Delete this lesson permanently?")) return;
    setSaving(true);
    if (lesson?.video_storage_path) await supabase.storage.from("lesson-videos").remove([lesson.video_storage_path]);
    if (lesson?.thumbnail_path) await supabase.storage.from("lesson-thumbs").remove([lesson.thumbnail_path]);
    const { error } = await supabase.from("lessons").delete().eq("id", lessonId);
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success("Lesson deleted");
    onChanged();
    onClose();
  };

  const dz = useDropzone({
    onDrop,
    accept: { "video/*": [".mp4", ".mov", ".webm", ".m4v"] },
    multiple: false,
    disabled: uploading,
  });

  if (!lesson) return null;

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-xl flex flex-col p-0">
        <SheetHeader className="px-5 py-4 border-b">
          <SheetTitle className="text-base">Edit lesson</SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input value={lesson.title || ""} onChange={(e) => setLesson((l: any) => ({ ...l, title: e.target.value }))} onBlur={(e) => update({ title: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea value={lesson.description || ""} onChange={(e) => setLesson((l: any) => ({ ...l, description: e.target.value }))} onBlur={(e) => update({ description: e.target.value })} rows={3} />
          </div>

          <Tabs value={lesson.video_provider === "upload" ? "upload" : "embed"} onValueChange={(v) => v === "upload" ? update({ video_provider: "upload", provider_video_id: null }) : update({ video_provider: "youtube" })}>
            <TabsList className="w-full">
              <TabsTrigger value="upload" className="flex-1">Upload video</TabsTrigger>
              <TabsTrigger value="embed" className="flex-1">Embed URL</TabsTrigger>
            </TabsList>
            <TabsContent value="upload" className="space-y-3">
              {lesson.video_storage_path && !uploading && (
                <div className="border rounded-md p-3 flex items-center justify-between gap-2 bg-muted/20">
                  <div className="text-xs truncate flex-1">
                    <div className="font-medium text-foreground">Video uploaded</div>
                    <div className="text-muted-foreground truncate">{lesson.video_storage_path}</div>
                    {lesson.duration_seconds ? <div className="text-muted-foreground">{Math.round(lesson.duration_seconds / 60)} min</div> : null}
                  </div>
                  <Button size="sm" variant="ghost" onClick={removeVideo}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>
                </div>
              )}
              {uploading && uploadProgress && (
                <div className="border rounded-md p-3 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="truncate flex-1">{uploadProgress.fileName}</span>
                    <Button variant="ghost" size="icon" onClick={cancelUpload}><X className="h-3.5 w-3.5" /></Button>
                  </div>
                  <div className="h-2 bg-muted rounded overflow-hidden">
                    <div className="h-full bg-foreground transition-all" style={{ width: `${uploadProgress.pct}%` }} />
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{uploadProgress.pct}%</span>
                    <span>{uploadProgress.mbps.toFixed(1)} MB/s</span>
                    <span>~{Math.ceil(uploadProgress.etaSec)}s left</span>
                  </div>
                </div>
              )}
              {!uploading && (
                <div
                  {...dz.getRootProps()}
                  className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${dz.isDragActive ? "border-foreground bg-muted/40" : "border-border hover:bg-muted/20"}`}
                >
                  <input {...dz.getInputProps()} />
                  <Upload className="h-6 w-6 mx-auto text-muted-foreground" />
                  <div className="mt-2 text-sm">Drag &amp; drop or <span className="underline">click to browse</span></div>
                  <div className="text-xs text-muted-foreground mt-1">mp4, mov, webm — up to 2 GB</div>
                  <div className="text-[11px] text-muted-foreground mt-2">For bigger libraries (30h+ courses, 500+ students), use the Embed tab with Bunny Stream for global CDN + HLS.</div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="embed" className="space-y-3">
              <div className="space-y-1.5">
                <Label>Provider</Label>
                <Select value={lesson.video_provider === "upload" ? "youtube" : lesson.video_provider} onValueChange={(v) => update({ video_provider: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="youtube">YouTube</SelectItem>
                    <SelectItem value="vimeo">Vimeo</SelectItem>
                    <SelectItem value="mux">Mux (HLS)</SelectItem>
                    <SelectItem value="bunny">Bunny Stream (HLS)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Video ID or URL</Label>
                <Input
                  value={lesson.provider_video_id || ""}
                  onChange={(e) => setLesson((l: any) => ({ ...l, provider_video_id: e.target.value }))}
                  onBlur={(e) => {
                    let v = e.target.value.trim();
                    // Extract YouTube ID from URL if needed
                    if (lesson.video_provider === "youtube") {
                      const m = v.match(/(?:v=|youtu\.be\/|embed\/)([\w-]{6,})/);
                      if (m) v = m[1];
                    }
                    if (lesson.video_provider === "vimeo") {
                      const m = v.match(/vimeo\.com\/(\d+)/);
                      if (m) v = m[1];
                    }
                    update({ provider_video_id: v });
                  }}
                  placeholder={
                    lesson.video_provider === "youtube" ? "dQw4w9WgXcQ or full URL"
                    : lesson.video_provider === "vimeo" ? "123456789 or full URL"
                    : lesson.video_provider === "bunny" ? "<library_id>/<video_guid>"
                    : "Mux Playback ID"
                  }
                />
                <p className="text-[11px] text-muted-foreground">
                  {lesson.video_provider === "bunny" && "Bunny gives you a Library ID and Video GUID. Format: 12345/abc-def-..."}
                  {lesson.video_provider === "mux" && "Use the Mux Playback ID."}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>Duration (seconds)</Label>
                <Input type="number" value={lesson.duration_seconds || 0} onChange={(e) => setLesson((l: any) => ({ ...l, duration_seconds: parseInt(e.target.value) || 0 }))} onBlur={(e) => update({ duration_seconds: parseInt(e.target.value) || 0 })} />
              </div>
            </TabsContent>
          </Tabs>

          <div className="space-y-1.5">
            <Label>Transcript</Label>
            <Textarea value={lesson.transcript || ""} onChange={(e) => setLesson((l: any) => ({ ...l, transcript: e.target.value }))} onBlur={(e) => update({ transcript: e.target.value })} rows={4} placeholder="Paste a transcript to power the AI Study Assistant" />
          </div>

          <div className="border-t pt-4 flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={lesson.published} onCheckedChange={(v) => update({ published: v })} />
              <span>{lesson.published ? "Published" : "Draft"}</span>
            </label>
            <Button variant="ghost" size="sm" onClick={deleteLesson} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4 text-destructive" />} Delete lesson
            </Button>
          </div>
        </div>
        <div className="border-t px-5 py-3 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
};
