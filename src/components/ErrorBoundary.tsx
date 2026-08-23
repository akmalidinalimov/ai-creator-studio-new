import { Component, type ErrorInfo, type ReactNode } from "react";
import { isChunkLoadError, reloadForChunkError, hardReload } from "@/lib/chunkReload";
import { reportClientError } from "@/lib/beacon";

interface Props {
  children: ReactNode;
  /** Optional custom fallback. Receives the error and a reset callback. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Label for logging which boundary caught the error (e.g. route name). */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * Catches render/lifecycle errors in the subtree so one thrown error can't
 * white-screen the whole SPA. Wrap the router once at the top and (optionally)
 * each lazy route. Class component because React error boundaries require the
 * componentDidCatch / getDerivedStateFromError lifecycle.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface to the console (and any future telemetry) instead of swallowing.
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ""}]`, error, info.componentStack);
    // Beacon the crash so it's DB-visible (which student, which route, chunk vs. code crash).
    const chunk = isChunkLoadError(error);
    try {
      reportClientError({
        type: chunk ? "chunk_load" : "render_crash",
        message: `${error?.name || "Error"}: ${error?.message || ""}`,
        extra: { boundary: this.props.label },
      });
    } catch { /* ignore */ }
    // Stale-deploy backstop: a lazy-route chunk that 404s after a new build
    // rethrows here (through <Suspense>). If vite:preloadError didn't already
    // catch it, force ONE cache-busting reload to fetch the fresh manifest.
    // Guarded so it can never loop — if we already tried, we fall through to the
    // manual-recovery fallback below. NEVER auto-reloads a genuine code crash.
    if (chunk) reloadForChunkError();
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div
        role="alert"
        className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center"
      >
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">Nimadir noto'g'ri ketdi</h1>
          <p className="text-sm text-muted-foreground">
            Sahifani yangilab ko'ring. · Что-то пошло не так — обновите страницу. · Something went wrong.
          </p>
        </div>
        <button
          type="button"
          // Cache-busting reload (not a plain soft reload) so a stale cached
          // index.html can't keep serving the same dead chunk and loop.
          onClick={hardReload}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Yangilash / Обновить / Reload
        </button>
        {/* Escape hatch: if the reload button keeps returning to this screen, the
            browser is serving a stale cache — a hard refresh clears it. Without
            this line a trapped user just taps Reload forever. */}
        <p className="max-w-sm text-xs text-muted-foreground">
          Agar takrorlansa: Ctrl+Shift+R bosing (yoki brauzer keshini tozalang). ·
          Если повторяется: нажмите Ctrl+Shift+R или очистите кэш. ·
          If it keeps happening: hard-refresh with Ctrl+Shift+R (⌘+Shift+R on Mac) or clear your browser cache.
        </p>
      </div>
    );
  }
}

export default ErrorBoundary;
