import { useCallback, useState } from "react";
import { Loader2, Play, RotateCcw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

// FeedbackVoicePlayer — student-side playback of a teacher's voice feedback note (Task 5 of
// the 2026-08-20 voice-homework-feedback feature). Shared by src/pages/Homework.tsx (web
// graded-detail view) and src/components/HomeworkProfileSection.tsx (the per-task accordion
// under /settings — see task-5-report.md for why that's the feature's second live surface).
//
// Callers gate mounting on the submission row already carrying a truthy
// score_feedback_voice_path OR score_feedback_voice_file_id (Task 1/3 columns) — this
// component itself never queries homework_submissions; it only resolves a playable URL via
// the hw-audio-url edge function (Task 4), lazily, on first tap, so opening a list with many
// graded/voice rows never fires N simultaneous invokes.
//
// Contract (Task 4): supabase.functions.invoke("hw-audio-url", { body: { submission_id } })
// → 200 { url: string } | { url: null, reason }; non-2xx body lives in error.context (pattern
// mirrored from HomeworkSubmit.tsx:207-215), not `data`.
type PlayerState = "idle" | "loading" | "ready" | "error" | "hidden";

interface FeedbackVoicePlayerProps {
  submissionId: string;
  className?: string;
}

export function FeedbackVoicePlayer({ submissionId, className }: FeedbackVoicePlayerProps) {
  const [state, setState] = useState<PlayerState>("idle");
  const [url, setUrl] = useState<string | null>(null);

  const resolve = useCallback(async () => {
    // navigator.onLine-aware: skip the invoke entirely while offline rather than hanging in
    // "loading" until the request eventually times out.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setState("error");
      return;
    }
    setState("loading");
    try {
      const { data, error } = await supabase.functions.invoke("hw-audio-url", {
        body: { submission_id: submissionId },
      });
      if (error) {
        // On an HTTP error, supabase-js puts the response body in error.context, not `data`
        // (same pattern as HomeworkSubmit.tsx's submit-homework call).
        let code = "";
        try {
          const j = await (error as any).context?.json?.();
          code = j?.error || "";
        } catch {
          // body unreadable — falls through to the generic error state below
        }
        // forbidden shouldn't happen for the owner (self/teacher-of-group/admin RBAC) — treat
        // it the same as "nothing to show" rather than surfacing an error the student can't act on.
        setState(code === "forbidden" ? "hidden" : "error");
        return;
      }
      const resolvedUrl = (data as { url?: string | null } | null)?.url ?? null;
      if (!resolvedUrl) {
        // { url: null, reason: "no_voice" | "audio_unavailable" } — render nothing per spec.
        setState("hidden");
        return;
      }
      setUrl(resolvedUrl);
      setState("ready");
    } catch {
      // Network failure / thrown exception (offline mid-flight, etc.)
      setState("error");
    }
  }, [submissionId]);

  if (state === "hidden") return null;

  return (
    <div className={cn("min-w-0", className)}>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
        <span aria-hidden>🎧</span>
        <span className="truncate">Ovozli izoh</span>
      </div>

      {state === "ready" && url ? (
        <audio controls preload="none" src={url} className="h-9 w-full max-w-[280px]">
          Brauzeringiz audio pleerni qo'llab-quvvatlamaydi.
        </audio>
      ) : state === "error" ? (
        <button
          type="button"
          onClick={() => void resolve()}
          className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border bg-tint px-2.5 py-1.5 text-[12px] font-semibold text-foreground transition-transform active:scale-[0.98]"
        >
          <RotateCcw className="size-3.5 flex-none" aria-hidden />
          <span className="truncate">Ovozni yuklab bo'lmadi — qayta urining</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void resolve()}
          disabled={state === "loading"}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-tint px-2.5 py-1.5 text-[12px] font-semibold text-foreground transition-transform active:scale-[0.98] disabled:opacity-60"
        >
          {state === "loading" ? (
            <Loader2 className="size-3.5 flex-none animate-spin" aria-hidden />
          ) : (
            <Play className="size-3.5 flex-none" aria-hidden />
          )}
          <span className="truncate">{state === "loading" ? "Yuklanmoqda…" : "Tinglash"}</span>
        </button>
      )}
    </div>
  );
}
