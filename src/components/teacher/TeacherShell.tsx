import type { ReactNode } from "react";

/**
 * TeacherShell — mobile shell wrapper for the teacher Mini App (`/tg/teacher/*`).
 *
 * Task 3 placeholder: renders `children` unchanged so the routes compile and are reachable.
 * TODO(Task 4): consume `useTelegramViewport` (safe-area / stable-height vars), wrap children in
 * the `max-w-2xl mx-auto px-4 overflow-x-hidden` container with bottom padding, and render
 * `TeacherBottomNav` fixed at the bottom (no desktop TopNav/sidebar).
 */
export function TeacherShell({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
