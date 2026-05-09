import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { PageShell } from "@/components/Layout";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type PendingLesson = { id: string; title: string; video_storage_path: string };

export default function AdminBunnyDiagnostics() {
  const { t } = useTranslation();
  const [libraryId, setLibraryId] = useState("");
  const [videoGuid, setVideoGuid] = useState("");
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [expires, setExpires] = useState<number | null>(null);
  const [headStatus, setHeadStatus] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Migration state
  const [pending, setPending] = useState<PendingLesson[]>([]);
  const [migratingId, setMigratingId] = useState<string | null>(null);
  const [migrateLog, setMigrateLog] = useState<Record<string, string>>({});

  const loadPending = async () => {
    const { data, error } = await supabase
      .from("lessons")
      .select("id, title, video_storage_path")
      .eq("video_provider", "upload")
      .not("video_storage_path", "is", null)
      .order("title", { ascending: true });
    if (error) { toast.error(error.message); return; }
    setPending((data || []) as PendingLesson[]);
  };

  useEffect(() => { loadPending(); }, []);

  const migrateOne = async (id: string) => {
    setMigratingId(id);
    setMigrateLog((m) => ({ ...m, [id]: "Migrating…" }));
    try {
      const { data, error } = await supabase.functions.invoke("migrate-storage-to-bunny", {
        body: { lesson_id: id },
      });
      if (error) throw new Error(error.message);
      if ((data as any)?.error) throw new Error((data as any).error);
      const { libraryId: lib, videoId } = data as any;
      setMigrateLog((m) => ({ ...m, [id]: `✅ Migrated → ${lib}/${videoId}` }));
      toast.success("Lesson migrated to Bunny");
      await loadPending();
    } catch (e) {
      const msg = (e as Error).message;
      setMigrateLog((m) => ({ ...m, [id]: `❌ ${msg}` }));
      toast.error(msg);
    } finally {
      setMigratingId(null);
    }
  };

  const migrateAll = async () => {
    for (const p of pending) {
      // eslint-disable-next-line no-await-in-loop
      await migrateOne(p.id);
    }
  };


  const run = async () => {
    setLoading(true);
    setError(null);
    setSignedUrl(null);
    setExpires(null);
    setHeadStatus(null);
    try {
      const { data, error } = await supabase.functions.invoke("bunny-sign", {
        body: { library_id: libraryId.trim(), video_guid: videoGuid.trim() },
      });
      if (error) throw new Error(error.message);
      if (!data?.signed_url) throw new Error("No signed_url returned");
      setSignedUrl(data.signed_url);
      setExpires(data.expires);
      try {
        const head = await fetch(data.signed_url, { method: "HEAD" });
        setHeadStatus(head.status);
      } catch (e) {
        setHeadStatus(-1);
      }
    } catch (e) {
      setError((e as Error).message);
      toast.error((e as Error).message);
    }
    setLoading(false);
  };

  return (
    <PageShell>
      <div className="max-w-2xl space-y-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Bunny Stream diagnostics</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Test the bunny-sign edge function with arbitrary Library ID + Video GUID. Admin-only.
          </p>
        </div>
        <Card className="p-5 space-y-4">
          <div className="space-y-1.5">
            <Label>Library ID</Label>
            <Input value={libraryId} onChange={(e) => setLibraryId(e.target.value)} placeholder="646745" />
          </div>
          <div className="space-y-1.5">
            <Label>Video GUID</Label>
            <Input value={videoGuid} onChange={(e) => setVideoGuid(e.target.value)} placeholder="becca2a1-3b6a-4a4a-a4e0-a67d46d7fb22" />
          </div>
          <Button onClick={run} disabled={!libraryId || !videoGuid || loading}>
            {loading ? "Signing…" : "Sign & test"}
          </Button>
        </Card>

        {(signedUrl || error) && (
          <Card className="p-5 space-y-3 text-sm">
            {error && <div className="text-destructive">Error: {error}</div>}
            {signedUrl && (
              <>
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">Signed URL</div>
                  <div className="font-mono text-xs break-all bg-muted/40 p-2 rounded">{signedUrl}</div>
                </div>
                {expires && (
                  <div>
                    <span className="text-muted-foreground">Expires:</span>{" "}
                    {new Date(expires * 1000).toLocaleString()}
                  </div>
                )}
                <div>
                  <span className="text-muted-foreground">HEAD status:</span>{" "}
                  <span className={headStatus === 200 ? "text-green-600" : "text-amber-600"}>
                    {headStatus ?? "—"}
                  </span>
                  {headStatus === 200 && " ✅ playable"}
                  {headStatus === 401 && " ❌ token rejected"}
                  {headStatus === 404 && " ❌ video not found"}
                  {headStatus === -1 && " (CORS blocked HEAD — try opening URL directly)"}
                </div>
              </>
            )}
          </Card>
        )}
      </div>
    </PageShell>
  );
}
