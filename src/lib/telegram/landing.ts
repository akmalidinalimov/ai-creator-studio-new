import { startParamToPath, stripTrack } from "@/lib/miniappLinks";

/**
 * Where the Mini App lands after the TelegramGate signed the user in. Pure — pinned by landing.test.ts.
 *
 *   1. A start_param that maps (t.me/<bot>/app?startapp=…) and we are at the app root → the mapped path.
 *      (A direct-link Mini App always opens the BotFather URL, i.e. the root; without this the start_param is
 *      lost to Landing's own "/" → "/dashboard" redirect.)
 *   2. Any other deep link (a web_app button to /lesson/…, /continue/…, /tg/teacher/grade, …) → kept as is.
 *   3. The root or "/dashboard" (the 🚀 Ilovani ochish keyboard and the ☰ menu button) → the server's
 *      target_path — so a teacher still lands on /tg/teacher, exactly as before.
 *
 * The src/ref tracking params are always stripped from the result: they are reported once (the open signal)
 * and must not survive into history, where a reload would count the same open again.
 */
export function resolveLanding(args: {
  pathname: string;
  search: string;
  startParam: string | null | undefined;
  serverTarget: string | null | undefined;
}): string {
  const { pathname, search, startParam, serverTarget } = args;
  const atRoot = pathname === "/" || pathname === "";
  const mapped = startParamToPath(startParam);
  if (mapped && atRoot) return mapped.path;
  if (!atRoot && pathname !== "/dashboard") return pathname + stripTrack(search);
  return serverTarget || "/dashboard";
}

/**
 * The fast (already signed-in) re-open: only a start_param at the root needs a redirect — every other path is
 * already where the user asked to be. Returns the path to navigate to, or null to stay.
 */
export function fastPathRedirect(pathname: string, startParam: string | null | undefined): string | null {
  if (pathname !== "/" && pathname !== "") return null;
  return startParamToPath(startParam)?.path ?? null;
}

/**
 * The parent screen for Telegram's native Back button when there is no in-app history to pop (a cold open
 * straight into a deep link: history.state.idx is 0). null = no sensible parent; keep navigate(-1).
 */
export function parentOf(pathname: string): string | null {
  const lesson = pathname.match(/^\/lesson\/([^/]+)\/[^/]+\/?$/);
  if (lesson) return `/course/${lesson[1]}`;
  if (/^\/course\/[^/]+\/?$/.test(pathname)) return "/dashboard";
  if (/^\/challenge\/tasks\/[^/]+\/?$/.test(pathname)) return "/challenge/tasks";
  if (/^\/tg\/teacher\/groups\/student\/[^/]+\/?$/.test(pathname)) return "/tg/teacher/groups";
  if (pathname.startsWith("/tg/teacher/")) return "/tg/teacher";
  // Staff-only standalone screens and the admin panel: leave the old behaviour alone.
  if (pathname.startsWith("/tg/") || pathname.startsWith("/admin") || pathname.startsWith("/teacher")) return null;
  return "/dashboard";
}
