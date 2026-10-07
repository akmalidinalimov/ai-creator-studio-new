import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// The deployed commit, for the client-error beacon (Vercel sets VERCEL_GIT_COMMIT_SHA at build; "dev" locally).
// Written into index.html (<meta name="app-version">), NOT into the JS: a value compiled into the entry chunk changed
// its hash on EVERY deploy — even a migration-only one — and with it every lazy chunk that imports it, so every open
// Mini App lost its route chunks after each merge (2026-10-07 incident). src/lib/beacon.ts reads the meta tag.
const APP_VERSION = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "dev";
const appVersionMeta = {
  name: "app-version-meta",
  transformIndexHtml(html: string) {
    return html.replace("</head>", `  <meta name="app-version" content="${APP_VERSION}" />\n  </head>`);
  },
};

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react(), appVersionMeta, mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime", "@tanstack/react-query", "@tanstack/query-core"],
  },
  build: {
    rollupOptions: {
      output: {
        // Split heavy third-party groups out of the main bundle so the initial
        // chunk shrinks (was ~935 kB). Charts are large and only used on a few
        // analytics pages, so keep them isolated from the app entry.
        manualChunks: {
          "react-vendor": ["react", "react-dom", "react-router-dom"],
          "supabase": ["@supabase/supabase-js"],
          "charts": ["recharts"],
        },
      },
    },
  },
}));
