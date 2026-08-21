import "./lib/impersonationGuard";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import "./i18n";
import { reloadForChunkError, stripChunkReloadParam } from "./lib/chunkReload";

// Stale-deploy recovery. Vite fires `vite:preloadError` on window BEFORE the
// failed dynamic import rethrows into React, so we can force a single cache-
// busting reload to pick up the freshly deployed index + chunk manifest instead
// of white-screening a long-open tab. Guarded against loops (see chunkReload.ts).
window.addEventListener("vite:preloadError" as any, (e: Event) => {
  if (reloadForChunkError()) e.preventDefault();
});

// If we just came back from a cache-bust reload, drop the ?cb= marker so it
// doesn't linger in / get shared from the URL.
stripChunkReloadParam();

createRoot(document.getElementById("root")!).render(<App />);
