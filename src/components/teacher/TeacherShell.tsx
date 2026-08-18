import type { ReactNode } from "react";
import { useMiniApp } from "@/lib/telegram/MiniAppContext";
import { useTelegramViewport } from "@/lib/telegram/useTelegramViewport";
import { TeacherBottomNav } from "./TeacherBottomNav";

/**
 * TeacherShell — mobile shell wrapper for the teacher Mini App (`/tg/teacher/*`).
 *
 * Dark, mobile-first, and deliberately WITHOUT the desktop `TopNav`/sidebar (`PageShell`) —
 * the only chrome is `TeacherBottomNav`. Mirrors the student shell's content wrapper: a
 * `max-w-2xl` centered column with `overflow-x-hidden` and a bottom padding reserve
 * (`6rem + safe-area`) so the fixed bottom nav never covers a screen's last CTA.
 *
 * It re-consumes `useTelegramViewport` so the safe-area / `--tg-viewport-stable-height` CSS
 * vars are published even on a direct `/tg/teacher*` deep-link open (idempotent with the
 * gate's own call; a strict no-op in web mode where `webApp === null`). The container height
 * tracks the Telegram stable viewport when present, falling back to `100vh` on the web.
 */
export function TeacherShell({ children }: { children: ReactNode }) {
  const { webApp } = useMiniApp();
  useTelegramViewport(webApp);

  return (
    <div
      className="bg-background text-foreground"
      style={{ minHeight: "var(--tg-viewport-stable-height, 100vh)" }}
    >
      <main className="max-w-2xl mx-auto px-4 pt-6 pb-[calc(6rem_+_env(safe-area-inset-bottom))] overflow-x-hidden animate-fade-in">
        {children}
      </main>
      <TeacherBottomNav />
    </div>
  );
}
