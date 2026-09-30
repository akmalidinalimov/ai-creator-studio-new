import { useEffect } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { resolveContinueTarget } from "@/lib/nextLesson";

/**
 * /continue and /continue/:courseId — the landing of every Mini App "watch" button (daily reminder, streak
 * warning, drips, nudges, the bot's 📚 Davom etish). It shows a spinner, works out the student's next
 * unfinished lesson with the same engine as the Dashboard's resume card (lib/nextLesson.ts), and replaces
 * itself with that lesson — so the button never goes stale: it always opens where the student stopped TODAY,
 * not where they were when the message was sent. ?lesson=<uuid> asks for one lesson (honoured only when it is
 * enrolled and inside the student's module_limit). Works the same on the web.
 */
export default function Continue() {
  const { user } = useAuth();
  const { courseId } = useParams<{ courseId?: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation();

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const lessonId = new URLSearchParams(location.search).get("lesson");
    (async () => {
      let target = "/dashboard";
      try {
        target = await resolveContinueTarget(supabase, user.id, { courseId: courseId ?? null, lessonId });
      } catch (e) {
        console.error("[Continue] resolve failed — falling back to the dashboard", e);
      }
      if (!cancelled) navigate(target, { replace: true });
    })();
    return () => { cancelled = true; };
    // location.search is read once per course/user: a watch button opens this route exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, courseId]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-background text-foreground">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{t("continue.loading")}</p>
    </div>
  );
}
