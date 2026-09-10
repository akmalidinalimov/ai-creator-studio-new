import "./lib/impersonationGuard";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import "./i18n";
import { reloadForChunkError, stripChunkReloadParam } from "./lib/chunkReload";
import { installGlobalBeacons, reportClientError } from "./lib/beacon";
import { installDomTranslateGuard } from "./lib/domTranslateGuard";
import { installStaleBuildCheck } from "./lib/staleBuild";

// Crash guard (MUST run before React renders): neutralize the removeChild /
// insertBefore NotFoundError that in-page translation (Google Translate) and some
// extensions trigger by mutating React's DOM — it otherwise unmounts the whole app
// and, on a lesson page, reads to the student as the video reloading / logging out.
// See src/lib/domTranslateGuard.ts.
installDomTranslateGuard();

// Client error/health beacon: report uncaught errors / rejections so browser-side failures are
// DB-visible + alertable before a student complains (see src/lib/beacon.ts).
installGlobalBeacons();

// Stale-deploy recovery. Vite fires `vite:preloadError` on window BEFORE the
// failed dynamic import rethrows into React, so we can force a single cache-
// busting reload to pick up the freshly deployed index + chunk manifest instead
// of white-screening a long-open tab. Guarded against loops (see chunkReload.ts).
window.addEventListener("vite:preloadError" as any, (e: Event) => {
  reportClientError({ type: "chunk_load", message: String((e as any)?.payload?.message || "vite:preloadError") });
  if (reloadForChunkError()) e.preventDefault();
});

// Stale-build recovery for the Telegram Mini App: the webview is kept alive / cached across our (several
// times a day) deploys, so a resumed webview can be running an old build whose lazy chunks the deploy
// removed. This proactively detects a version change on resume and pulls the fresh build, so a re-opened
// Mini App never shows a stale / non-loading screen. See src/lib/staleBuild.ts.
installStaleBuildCheck();

// If we just came back from a cache-bust reload, drop the ?cb= marker so it
// doesn't linger in / get shared from the URL.
stripChunkReloadParam();

createRoot(document.getElementById("root")!).render(<App />);
