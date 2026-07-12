// PostToolUse hook: syntax-check Supabase edge functions the moment they're edited.
// Deno isn't installed on this machine and CI's `deno test` only type-checks files
// imported by tests — so a syntax slip in the 6.9k-line telegram-bot-webhook/index.ts
// would otherwise surface only at deploy time. esbuild (already here via vite) parses
// the file in ~100ms. Exit 2 feeds the parse error straight back to Claude to fix.
import { execFileSync } from "node:child_process";

const raw = await new Promise((res) => {
  let d = "";
  process.stdin.on("data", (c) => (d += c));
  process.stdin.on("end", () => res(d));
});

let input;
try { input = JSON.parse(raw); } catch { process.exit(0); }

if (!/^(Edit|Write|MultiEdit)$/.test(input.tool_name || "")) process.exit(0);
const filePath = String(input.tool_input?.file_path || "").replace(/\\/g, "/");
if (!/supabase\/functions\/.+\.ts$/.test(filePath)) process.exit(0);
// win32 needs shell:true for npx.cmd — so refuse paths with shell metacharacters.
if (!/^[A-Za-z0-9_\-./: ]+$/.test(filePath)) process.exit(0);

try {
  execFileSync(
    "npx",
    ["--no-install", "esbuild", filePath, "--loader:.ts=ts", "--target=esnext", "--format=esm",
     "--outfile=" + (process.platform === "win32" ? "NUL" : "/dev/null")],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" },
  );
} catch (e) {
  const out = `${e.stderr || ""}${e.stdout || ""}`.slice(0, 2000);
  console.error(`Edge function failed esbuild syntax check — fix before proceeding:\n${out}`);
  process.exit(2);
}
process.exit(0);
