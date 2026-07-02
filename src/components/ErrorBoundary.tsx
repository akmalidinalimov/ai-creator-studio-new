import { Component, type ErrorInfo, type ReactNode } from "react";

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
          onClick={() => window.location.reload()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          Yangilash / Обновить / Reload
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;
