import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from "sonner";
import {
  UploadCloud, FileText, Trash2, RefreshCcw, Eye, Download,
  CheckCircle2, XCircle, Loader2, AlertCircle, X,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";

type Doc = {
  id: string;
  scope: "platform" | "course";
  course_id: string | null;
  file_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number;
  page_count: number | null;
  status: "pending" | "processing" | "ready" | "failed";
  error: string | null;
  chunk_count: number;
  preview: string | null;
  created_at: string;
};

type UploadJob = {
  id: string;            // local id
  name: string;
  size: number;
  stage: "uploading" | "indexing" | "done" | "error";
  progress: number;      // 0-100 (upload progress)
  error?: string;
  documentId?: string;
};

const ACCEPT = ".pdf,.docx,.txt,.md";
const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED_EXT = ["pdf", "docx", "txt", "md"];

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function friendlyError(raw: string): string {
  const e = raw.toLowerCase();
  if (e.includes("no extractable text")) return "No extractable text. The file is likely a scanned image — convert to a text-based PDF or run OCR first.";
  if (e.includes("embed")) return "Embedding service failed. Check the Lovable AI key and credits, then re-index.";
  if (e.includes("download")) return "Could not download the file from storage. It may have been removed — re-upload it.";
  if (e.includes("lovable_api_key")) return "Missing Lovable AI key. Add it in Connectors and re-index.";
  if (e.includes("unauthorized") || e.includes("forbidden")) return "Permission denied. Sign out and back in as an admin.";
  if (e.includes("timeout") || e.includes("failed to fetch")) return "Network or timeout error during indexing. Re-index to retry.";
  return raw;
}

// Upload via XHR so we can report real progress.
async function uploadWithProgress(
  path: string,
  file: File,
  onProgress: (pct: number) => void,
): Promise<{ error?: string }> {
  // Get signed upload URL via the storage REST API path used by supabase-js
  const { data: signed, error: signErr } = await supabase.storage
    .from("ai-knowledge")
    .createSignedUploadUrl(path);
  if (signErr || !signed) return { error: signErr?.message || "Could not create upload URL" };

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", signed.signedUrl, true);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve({});
      else resolve({ error: `Upload failed (${xhr.status}): ${xhr.responseText?.slice(0, 200) || "unknown"}` });
    };
    xhr.onerror = () => resolve({ error: "Network error during upload" });
    xhr.send(file);
  });
}

export function KnowledgeManager({
  scope,
  courseId,
}: {
  scope: "platform" | "course";
  courseId?: string;
}) {
  const { user } = useAuth();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [previewDoc, setPreviewDoc] = useState<Doc | null>(null);
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const updateJob = (id: string, patch: Partial<UploadJob>) =>
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));

  const dismissJob = (id: string) =>
    setJobs((prev) => prev.filter((j) => j.id !== id));

  const load = useCallback(async () => {
    setLoading(true);
    let q = supabase.from("ai_knowledge_documents").select("*").order("created_at", { ascending: false });
    if (scope === "platform") q = q.eq("scope", "platform");
    else q = q.eq("scope", "course").eq("course_id", courseId!);
    const { data, error } = await q;
    if (error) toast.error(error.message);
    setDocs((data as any[]) || []);
    setLoading(false);
  }, [scope, courseId]);

  useEffect(() => { load(); }, [load]);

  // Realtime: keep statuses fresh AND mark indexing jobs done/failed
  useEffect(() => {
    const channel = supabase
      .channel(`knowledge-${scope}-${courseId ?? "x"}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "ai_knowledge_documents" },
        (payload) => {
          load();
          const row: any = payload.new;
          if (!row) return;
          setJobs((prev) => prev.map((j) => {
            if (j.documentId !== row.id) return j;
            if (row.status === "ready") return { ...j, stage: "done" };
            if (row.status === "failed") return { ...j, stage: "error", error: friendlyError(row.error || "Indexing failed") };
            return j;
          }));
        })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load, scope, courseId]);

  // Auto-clear completed jobs after a delay
  useEffect(() => {
    const doneIds = jobs.filter((j) => j.stage === "done").map((j) => j.id);
    if (!doneIds.length) return;
    const t = setTimeout(() => setJobs((prev) => prev.filter((j) => !doneIds.includes(j.id))), 3500);
    return () => clearTimeout(t);
  }, [jobs]);

  const handleFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    for (const file of arr) {
      const ext = file.name.split(".").pop()?.toLowerCase() || "";
      const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      if (!ALLOWED_EXT.includes(ext)) {
        setJobs((p) => [...p, { id: jobId, name: file.name, size: file.size, stage: "error", progress: 0, error: `Unsupported file type ".${ext}". Allowed: PDF, DOCX, TXT, MD.` }]);
        continue;
      }
      if (file.size > MAX_BYTES) {
        setJobs((p) => [...p, { id: jobId, name: file.name, size: file.size, stage: "error", progress: 0, error: `File is ${fmtSize(file.size)} — limit is 20 MB.` }]);
        continue;
      }

      setJobs((p) => [...p, { id: jobId, name: file.name, size: file.size, stage: "uploading", progress: 0 }]);

      const safeName = file.name.replace(/[^a-z0-9._-]/gi, "_");
      const folder = scope === "platform" ? "platform" : `course-${courseId}`;
      const path = `${folder}/${Date.now()}-${safeName}`;

      const { error: upErr } = await uploadWithProgress(path, file, (pct) => updateJob(jobId, { progress: pct }));
      if (upErr) {
        updateJob(jobId, { stage: "error", error: friendlyError(upErr) });
        continue;
      }

      updateJob(jobId, { progress: 100, stage: "indexing" });

      const { data: doc, error: insErr } = await supabase.from("ai_knowledge_documents").insert({
        scope,
        course_id: scope === "course" ? courseId : null,
        file_path: path,
        file_name: file.name,
        mime_type: file.type || null,
        size_bytes: file.size,
        status: "pending",
        created_by: user?.id,
      } as any).select().single();

      if (insErr || !doc) {
        updateJob(jobId, { stage: "error", error: friendlyError(insErr?.message || "Could not record document") });
        continue;
      }

      updateJob(jobId, { documentId: (doc as any).id });

      const { error: fnErr } = await supabase.functions.invoke("ingest-knowledge", { body: { documentId: (doc as any).id } });
      if (fnErr) {
        updateJob(jobId, { stage: "error", error: friendlyError(fnErr.message) });
      }
      // Otherwise we wait for the realtime status update to mark "done" / "error".
    }
    load();
  };

  const reindex = async (doc: Doc) => {
    const jobId = `reindex-${doc.id}-${Date.now()}`;
    setJobs((p) => [...p, { id: jobId, name: doc.file_name, size: doc.size_bytes, stage: "indexing", progress: 100, documentId: doc.id }]);
    await supabase.from("ai_knowledge_documents").update({ status: "pending", error: null }).eq("id", doc.id);
    const { error } = await supabase.functions.invoke("ingest-knowledge", { body: { documentId: doc.id } });
    if (error) updateJob(jobId, { stage: "error", error: friendlyError(error.message) });
  };

  const remove = async (doc: Doc) => {
    if (!confirm(`Delete "${doc.file_name}"? This removes its chunks from the assistant.`)) return;
    await supabase.storage.from("ai-knowledge").remove([doc.file_path]);
    const { error } = await supabase.from("ai_knowledge_documents").delete().eq("id", doc.id);
    if (error) return toast.error(error.message);
    toast.success("Deleted");
  };

  const download = async (doc: Doc) => {
    const { data, error } = await supabase.storage.from("ai-knowledge").createSignedUrl(doc.file_path, 60);
    if (error || !data) return toast.error(error?.message || "Failed");
    window.open(data.signedUrl, "_blank");
  };

  const stats = useMemo(() => {
    const totalChunks = docs.reduce((s, d) => s + (d.chunk_count || 0), 0);
    const totalSize = docs.reduce((s, d) => s + (d.size_bytes || 0), 0);
    return { count: docs.length, totalChunks, totalSize };
  }, [docs]);

  const failedDocs = docs.filter((d) => d.status === "failed");

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault(); setDragOver(false);
          if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={`rounded-lg border-2 border-dashed p-6 text-center cursor-pointer transition-colors ${
          dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/30"
        }`}
      >
        <UploadCloud className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
        <p className="text-sm font-medium">Drag & drop files here, or click to upload</p>
        <p className="text-xs text-muted-foreground mt-1">PDF, DOCX, TXT, MD — up to 20 MB each</p>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => { if (e.target.files?.length) handleFiles(e.target.files); e.currentTarget.value = ""; }}
        />
      </div>

      {/* Per-file progress / status panel */}
      {jobs.length > 0 && (
        <Card className="p-3 space-y-3">
          {jobs.map((j) => (
            <div key={j.id} className="space-y-1.5">
              <div className="flex items-center gap-2 text-sm">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="truncate flex-1 font-medium">{j.name}</span>
                <span className="text-xs text-muted-foreground shrink-0">{fmtSize(j.size)}</span>
                <JobStageBadge stage={j.stage} progress={j.progress} />
                <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => dismissJob(j.id)} title="Dismiss">
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
              {(j.stage === "uploading" || j.stage === "indexing") && (
                <Progress
                  value={j.stage === "uploading" ? j.progress : undefined}
                  className={`h-1.5 ${j.stage === "indexing" ? "[&>div]:animate-pulse" : ""}`}
                />
              )}
              {j.stage === "error" && j.error && (
                <Alert variant="destructive" className="py-2">
                  <AlertCircle className="h-4 w-4" />
                  <AlertTitle className="text-xs">
                    {j.documentId ? "Indexing failed" : "Upload failed"}
                  </AlertTitle>
                  <AlertDescription className="text-xs">{j.error}</AlertDescription>
                </Alert>
              )}
            </div>
          ))}
        </Card>
      )}

      {failedDocs.length > 0 && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{failedDocs.length} document{failedDocs.length === 1 ? "" : "s"} failed to index</AlertTitle>
          <AlertDescription className="text-xs">
            Use the re-index button on each row to retry. Common causes: scanned image PDFs (need OCR), missing AI key, or transient network errors.
          </AlertDescription>
        </Alert>
      )}

      {loading ? (
        <div className="text-sm text-muted-foreground py-6 text-center">Loading…</div>
      ) : docs.length === 0 ? (
        <div className="text-sm text-muted-foreground italic py-4 text-center">
          No documents yet. Upload course materials, FAQs, transcripts, or any reference text — the assistant will retrieve the most relevant passages per question.
        </div>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y">
            {docs.map((d) => (
              <li key={d.id} className="p-3 flex items-center gap-3 text-sm">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{d.file_name}</div>
                  <div className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                    <span>{fmtSize(d.size_bytes)}</span>
                    {d.page_count != null && <span>{d.page_count} pages</span>}
                    <span>{d.chunk_count} chunks</span>
                    <span>{new Date(d.created_at).toLocaleDateString()}</span>
                  </div>
                  {(d.status === "processing" || d.status === "pending") && (
                    <Progress className="h-1 mt-1.5 [&>div]:animate-pulse" value={undefined} />
                  )}
                  {d.status === "failed" && d.error && (
                    <div className="text-xs text-destructive mt-1 flex items-start gap-1">
                      <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" /> {friendlyError(d.error)}
                    </div>
                  )}
                </div>
                <StatusBadge status={d.status} />
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="icon" variant="ghost" title="Preview text" onClick={() => setPreviewDoc(d)}>
                    <Eye className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" title="Download original" onClick={() => download(d)}>
                    <Download className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" title="Re-index" onClick={() => reindex(d)}>
                    <RefreshCcw className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" title="Delete" onClick={() => remove(d)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {docs.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {stats.count} document{stats.count === 1 ? "" : "s"} · {stats.totalChunks} chunks · {fmtSize(stats.totalSize)} indexed.
          The assistant retrieves the 6 most relevant chunks per student question.
        </p>
      )}

      <Dialog open={!!previewDoc} onOpenChange={(o) => !o && setPreviewDoc(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="truncate">{previewDoc?.file_name}</DialogTitle>
            <DialogDescription>
              First ~600 characters of extracted text. If this looks like gibberish, the file is likely a scanned image and needs OCR.
            </DialogDescription>
          </DialogHeader>
          <pre className="text-xs whitespace-pre-wrap bg-muted/40 rounded p-3 max-h-[50vh] overflow-auto">
            {previewDoc?.preview || "(no preview yet — re-index to generate)"}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function JobStageBadge({ stage, progress }: { stage: UploadJob["stage"]; progress: number }) {
  if (stage === "uploading") {
    return <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-blue-500/10 text-blue-600 inline-flex items-center gap-1 shrink-0">
      <Loader2 className="h-3 w-3 animate-spin" /> Uploading {progress}%
    </span>;
  }
  if (stage === "indexing") {
    return <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-amber-500/10 text-amber-600 inline-flex items-center gap-1 shrink-0">
      <Loader2 className="h-3 w-3 animate-spin" /> Indexing
    </span>;
  }
  if (stage === "done") {
    return <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-emerald-500/10 text-emerald-600 inline-flex items-center gap-1 shrink-0">
      <CheckCircle2 className="h-3 w-3" /> Ready
    </span>;
  }
  return <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-destructive/10 text-destructive inline-flex items-center gap-1 shrink-0">
    <XCircle className="h-3 w-3" /> Failed
  </span>;
}

function StatusBadge({ status }: { status: Doc["status"] }) {
  const map = {
    pending:    { icon: Loader2,        cls: "bg-muted text-muted-foreground", spin: true,  label: "Pending" },
    processing: { icon: Loader2,        cls: "bg-blue-500/10 text-blue-600",  spin: true,  label: "Indexing" },
    ready:      { icon: CheckCircle2,   cls: "bg-emerald-500/10 text-emerald-600", spin: false, label: "Ready" },
    failed:     { icon: XCircle,        cls: "bg-destructive/10 text-destructive", spin: false, label: "Failed" },
  } as const;
  const v = map[status];
  const Icon = v.icon;
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-1 shrink-0 ${v.cls}`}>
      <Icon className={`h-3 w-3 ${v.spin ? "animate-spin" : ""}`} /> {v.label}
    </span>
  );
}
