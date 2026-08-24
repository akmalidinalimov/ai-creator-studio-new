import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  // Stamp the deployed commit into the bundle so the client-error beacon can tag
  // each event with the exact build it came from (Vercel sets VERCEL_GIT_COMMIT_SHA
  // at build; falls back to "dev" for local builds). Read via import.meta.env.VITE_APP_VERSION.
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(
      process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "dev",
    ),
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
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
