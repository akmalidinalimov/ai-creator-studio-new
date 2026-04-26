import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { toast } from "sonner";
import {
  UploadCloud, FileText, Trash2, RefreshCcw, Eye, Download,
  CheckCircle2, XCircle, Loader2, AlertCircle,
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

const ACCEPT = ".pdf,.docx,.txt,.md";
const MAX_BYTES = 20 * 1024 * 1024;

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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
  const inputRef = useRef<HTMLInputElement>(null);

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

  // Realtime: keep statuses fresh
  useEffect(() => {
    const channel = supabase
      .channel(`knowledge-${scope}-${courseId ?? "x"}`)
      .on("postgres_changes",
        { event: "*", schema: "public", table: "ai_knowledge_documents" },
        () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load, scope, courseId]);

  const handleFiles = async (files: FileList | File[]) => {
    const arr = Array.from(files);
    for (const file of arr) {
      if (file.size > MAX_BYTES) { toast.error(`${file.name}: over 20 MB`); continue; }
      const safeName = file.name.replace(/[^a-z0-9._-]/gi, "_");
      const folder = scope === "platform" ? "platform" : `course-${courseId}`;
      const path = `${folder}/${Date.now()}-${safeName}`;
      const upToast = toast.loading(`Uploading ${file.name}…`);
      const { error: upErr } = await supabase.storage.from("ai-knowledge").upload(path, file, { upsert: false });
      if (upErr) { toast.dismiss(upToast); toast.error(upErr.message); continue; }
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
      toast.dismiss(upToast);
      if (insErr || !doc) { toast.error(insErr?.message || "insert failed"); continue; }
      toast.success(`${file.name} uploaded — indexing…`);
      // Fire-and-forget ingest
      supabase.functions.invoke("ingest-knowledge", { body: { documentId: (doc as any).id } })
        .then(({ error }) => { if (error) toast.error(`${file.name}: ${error.message}`); });
    }
    load();
  };

  const reindex = async (doc: Doc) => {
    const t = toast.loading(`Re-indexing ${doc.file_name}…`);
    await supabase.from("ai_knowledge_documents").update({ status: "pending", error: null }).eq("id", doc.id);
    const { error } = await supabase.functions.invoke("ingest-knowledge", { body: { documentId: doc.id } });
    toast.dismiss(t);
    if (error) toast.error(error.message); else toast.success("Re-indexed");
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
                  {d.status === "failed" && d.error && (
                    <div className="text-xs text-destructive mt-1 flex items-start gap-1">
                      <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" /> {d.error}
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
