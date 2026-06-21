#!/usr/bin/env node
// Phase 0 (M11): guard against supabase/config.toml drift.
//
// - HARD ERROR on duplicate [functions.NAME] blocks. TOML "last definition wins",
//   which silently flipped admin-create-students from verify_jwt=true to false
//   (a public-function trap that nobody could see by reading the top of the file).
// - WARN on functions that have no explicit verify_jwt, or that exist on disk with
//   NO config entry at all — their gateway auth then depends on the Supabase
//   dashboard, which is not in version control (this is the root of the drift).
//
// CI usage:  node scripts/check-config-toml.mjs            (fails only on errors)
//            node scripts/check-config-toml.mjs --strict   (fails on warnings too)
//
// Flip CI to --strict once every function has an explicit, reconciled entry.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(root, "supabase", "config.toml");
const fnsDir = join(root, "supabase", "functions");
const strict = process.argv.includes("--strict");

const lines = readFileSync(configPath, "utf8").split(/\r?\n/);

const seen = new Map(); // name -> [lineNumbers]
const hasVerifyJwt = new Map(); // name -> boolean
let current = null;

lines.forEach((line, i) => {
  const header = line.match(/^\s*\[functions\.([^\]]+)\]\s*$/);
  if (header) {
    current = header[1];
    if (!seen.has(current)) seen.set(current, []);
    seen.get(current).push(i + 1);
    if (!hasVerifyJwt.has(current)) hasVerifyJwt.set(current, false);
    return;
  }
  if (current && /^\s*verify_jwt\s*=/.test(line)) hasVerifyJwt.set(current, true);
});

const errors = [];
const warnings = [];

for (const [name, lineNums] of seen) {
  if (lineNums.length > 1) {
    errors.push(`Duplicate [functions.${name}] at lines ${lineNums.join(", ")} — last-wins can silently flip verify_jwt.`);
  }
  if (!hasVerifyJwt.get(name)) {
    warnings.push(`[functions.${name}] has no explicit verify_jwt line.`);
  }
}

if (existsSync(fnsDir)) {
  const dirs = readdirSync(fnsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name);
  for (const name of dirs) {
    if (!seen.has(name)) {
      warnings.push(`supabase/functions/${name} has NO entry in config.toml — verify_jwt is whatever the dashboard says (not in git).`);
    }
  }
}

for (const w of warnings) console.warn("WARN  " + w);
for (const e of errors) console.error("ERROR " + e);

if (errors.length || (strict && warnings.length)) {
  console.error(`\nconfig.toml check FAILED: ${errors.length} error(s), ${warnings.length} warning(s).`);
  process.exit(1);
}
console.log(`config.toml check passed (${warnings.length} warning(s)).`);
