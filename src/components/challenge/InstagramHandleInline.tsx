import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { looseFrom } from "@/lib/looseTable";
import { useAuth } from "@/contexts/AuthContext";
import { Button, Card } from "@/components/ui-kit";
import { Input } from "@/components/ui/input";
import { reportClientError } from "@/lib/beacon";
import { impersonatingReadonly } from "@/lib/mutate";
import { saveInstagramHandle } from "@/lib/instagramHandleSave";

/**
 * The Instagram handle on an Instagram task (Daily Tasks PR-7, spec G28): the engine matches the screenshot to this
 * handle, so the student sets it right where they submit. Same rules and read-back as Settings (saveInstagramHandle):
 * a refused, taken, locked or silently-kept value is shown as such, never as "saved", and every failure is
 * DB-visible (client_error_events). Reports the stored handle upward so the page can show what is missing.
 */
export function InstagramHandleInline({ onHandle }: { onHandle?: (handle: string) => void }) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    (async () => {
      try {
        const { data } = await looseFrom("profiles").select("instagram_username").eq("id", user.id).maybeSingle();
        const h = String(data?.instagram_username ?? "");
        if (!alive) return;
        setSaved(h);
        setValue(h);
        onHandle?.(h);
      } catch { /* the field just starts empty */ }
      if (alive) setLoaded(true);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const fail = (msg: string, beacon: string, extra: Record<string, unknown>) => {
    setError(msg);
    toast.error(msg);
    reportClientError({ type: "other", message: beacon, extra: { surface: "daily_task", ...extra } });
  };

  const save = async () => {
    if (!user || saving || impersonatingReadonly()) return;
    setSaving(true);
    setError(null);
    try {
      const r = await saveInstagramHandle(user.id, value, saved);
      if (r.ok) {
        setSaved(r.handle);
        setValue(r.handle);
        setEditing(false);
        onHandle?.(r.handle);
        if (r.changed) toast.success(t("dailyTasks.ig.saved"));
        return;
      }
      if (r.kind === "impersonation_readonly") return;
      if (r.kind === "invalid") {
        setError(t(`settings.instagramErrors.${r.reason}`));
        return; // a typo is not a failure worth a beacon
      }
      if (r.kind === "taken") return fail(t("settings.instagramErrors.taken"), "instagram_handle_taken", { code: r.code ?? null });
      if (r.kind === "locked") return fail(r.message ?? t("settings.instagramErrors.notSaved"), "instagram_handle_save_failed", { code: r.code ?? null });
      if (r.kind === "not_stored") {
        // the DB kept the old value: show what it really holds
        const { data } = await looseFrom("profiles").select("instagram_username").eq("id", user.id).maybeSingle();
        const h = String(data?.instagram_username ?? "");
        setSaved(h);
        onHandle?.(h);
        return fail(t("settings.instagramErrors.notSaved"), "instagram_handle_not_stored", {});
      }
      return fail(t("settings.instagramErrors.notSaved"), "instagram_handle_save_failed", { code: r.code ?? null });
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;
  const readonly = impersonatingReadonly();
  return (
    <Card className="space-y-2 p-4">
      <div className="text-[13.5px] font-extrabold text-foreground">📸 {t("dailyTasks.ig.title")}</div>
      {saved && !editing ? (
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 break-all text-sm font-semibold text-foreground">{t("dailyTasks.ig.have", { handle: saved })}</span>
          <Button variant="ghost" size="sm" disabled={readonly} onClick={() => setEditing(true)}>{t("common.edit")}</Button>
        </div>
      ) : (
        <>
          {!saved && <p className="text-xs font-semibold text-muted-foreground">{t("dailyTasks.ig.none")}</p>}
          <div className="flex gap-2">
            <Input
              aria-label="Instagram"
              value={value}
              onChange={(e) => { setValue(e.target.value); if (error) setError(null); }}
              placeholder="@username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={readonly || saving}
              aria-invalid={error ? true : undefined}
            />
            <Button variant="secondary" size="sm" onClick={() => void save()} disabled={readonly || saving}>{t("dailyTasks.ig.save")}</Button>
          </div>
          {error && <p role="alert" className="text-xs font-medium text-destructive">{error}</p>}
        </>
      )}
    </Card>
  );
}
