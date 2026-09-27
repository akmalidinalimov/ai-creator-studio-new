#!/usr/bin/env node
// Author-time guard against HARDCODED FOREIGN SUPABASE PROJECTS anywhere outside migrations
// (prevention hierarchy layer 3). The migration half of this class is E6 in
// scripts/check-migration-grants.mjs; both read the same deny-list from scripts/supabase-refs.mjs.
//
// WHY THIS EXISTS. Production moved off the original Lovable-hosted project on 2026-07-05. Three
// things kept addressing the old one, and none of them could be seen from production:
//   * track_video_progress(), a replayed migration, sent internal_fn_secret() there on every lesson
//     completion for twelve weeks (fixed by 20260926161000). E6 now catches that shape in migrations.
//   * docs/sheet-onboarding/apps-script.gs, the script pasted into the sales intake Google Sheet,
//     POSTed every new student there. Production's audit log has 81 `sheet_import` rows, the last at
//     2026-07-05 14:03:59 UTC (the cutover copy) and none since. Anything the sheet sent after that went
//     to a database the platform never reads, while the sheet said "✅ Imported".
//   * scripts_test_import.mjs (repo root) posted SUPABASE_SERVICE_ROLE_KEY there.
// E6 only reads supabase/migrations/**, so the last two sat in the repo unflagged. This reads the rest.
//
// RULES (all ERRORS; there is no legitimate new use of a foreign project):
//   F1  a KNOWN foreign ref, in any form and any case, in a file not on ALLOWLIST.
//   F2  a Supabase project address (host, dashboard link, --project-ref) whose ref is not production,
//       in ANY file. This catches the NEXT foreign project, whose ref nobody can list in advance.
//   F3  a known foreign ref written as an ADDRESS inside an allowlisted file whose entry does not set
//       mayLink. Allowlisted prose may NAME the old project; it may not point at it. apps-script.gs
//       itself lived under docs/, and a URL in a doc is one copy-paste away from being config again.
//   F4  a stale ALLOWLIST entry: the file is gone, or no longer mentions a known foreign ref. This keeps
//       the list minimal without anyone having to remember to prune it.
//   F5  an ALLOWLIST entry without a substantive reason.
//
// SCOPE. `git ls-files --cached --others --exclude-standard`: every tracked file plus every new file git
// would let you add, so a hit fails locally before it is committed. Skipped: supabase/migrations/**
// (E6/E7 own those and are comment-aware) and binary files (a NUL byte in the first 8000 bytes, the
// same test git uses). Only path:line:col and the matched ref are printed, never the line itself,
// because an untracked file can hold a secret.
//
// It fails CLOSED: if git cannot list the files, or the scan finds nothing to read, it exits non-zero
// instead of reporting a clean pass over nothing.
//
// CI: chained onto `npm run lint:footguns`, which CI already runs as a blocking step. Agent PRs may never
// touch .github/**, so extending that npm script is how a real gate lands.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PRODUCTION_REF, KNOWN_FOREIGN_REFS } from "./supabase-refs.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Files that must keep NAMING a known foreign ref. Exact paths only, never a directory or glob: a glob
// over docs/ would have exempted apps-script.gs, the file this guard was written for. Every entry needs
// a reason. mayLink:true additionally lets the file contain the ref as an address (host / link).
const ALLOWLIST = {
  "CLAUDE.md": {
    reason: "Project instructions every session reads. They name the old project ref so a future session recognises it as foreign and never points anything at it (the stale-project incident). Prose only; no URL.",
  },
  "scripts/supabase-refs.mjs": {
    reason: "The single definition of KNOWN_FOREIGN_REFS that this guard and E6 both import. A deny-list has to name what it denies.",
  },
  "scripts/check-migration-grants.mjs": {
    reason: "The migration-side guard (E6). Its header tells the track_video_progress story and quotes the exact URL that function POSTed to, so the next reader recognises the shape.",
    mayLink: true,
  },
  "docs/CUTOVER-COMPLETE-2026-07-05.md": {
    reason: "The record of the 2026-07-05 cutover. It names the old backend as the frozen rollback target, and its rollback steps must say which project to point back at.",
  },
  "docs/streak-reconcile-restore-2026-06-19.md": {
    reason: "Written on 2026-06-19, when the old project WAS production, and records where that change was applied. Replacing the ref would falsify the record.",
  },
  "docs/superpowers/specs/2026-08-10-http-call-observability-design.md": {
    reason: "Design record of the HTTP-call observability work, which is where the stale old-project ref in migration sources was first found and written down.",
  },
  "docs/superpowers/plans/2026-08-10-http-call-observability-plan.md": {
    reason: "Implementation plan for the same work; its task list records the clean-up of that stale ref.",
  },
};

// Ways a Supabase project is ADDRESSED. Group 1 is always the 20-character project ref.
const ADDRESS_PATTERNS = [
  // <ref>.supabase.co, db.<ref>.supabase.co, <ref>.functions.supabase.co, and the .supabase.in forms
  { what: "a Supabase host", re: /(?<![a-z0-9-])([a-z0-9]{20})\.(?:functions\.)?supabase\.(?:co|in)(?![a-z0-9-])/gi },
  { what: "a Supabase dashboard link", re: /supabase\.com\/dashboard\/project\/([a-z0-9]{20})(?![a-z0-9])/gi },
  { what: "a --project-ref argument", re: /--project-ref[=\s]+["']?([a-z0-9]{20})(?![a-z0-9])/gi },
];

const knownForeign = new Set(KNOWN_FOREIGN_REFS.map((r) => r.toLowerCase()));
const errors = [];
const lineCol = (text, index) => {
  let line = 1, start = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < index; i = text.indexOf("\n", i + 1)) { line++; start = i + 1; }
  return `${line}:${index - start + 1}`;
};

// F5: an allowlist entry has to say why.
for (const [path, entry] of Object.entries(ALLOWLIST)) {
  if (!entry.reason || entry.reason.trim().length < 40) {
    errors.push(`scripts/check-foreign-refs.mjs — [F5] ALLOWLIST["${path}"] has no substantive reason. An exception nobody explained is how a deliberate one becomes an accident.`);
  }
}

let listed;
try {
  listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
} catch (e) {
  console.error(`foreign-ref check FAILED: could not list files with git (${e.message}). Refusing to report a pass without scanning.`);
  process.exit(1);
}
const paths = [...new Set(listed.split("\0").filter(Boolean))].sort();

let scanned = 0, skippedMigrations = 0, skippedBinary = 0;
const mentions = new Set(); // allowlisted files that still mention a known foreign ref (for F4)

for (const path of paths) {
  if (path.startsWith("supabase/migrations/")) { skippedMigrations++; continue; }
  let buf;
  try {
    if (!statSync(join(root, path)).isFile()) continue; // a nested repo/worktree dir, a deleted file
    buf = readFileSync(join(root, path));
  } catch {
    continue; // listed by the index but deleted in the working tree: nothing left to scan
  }
  if (buf.subarray(0, 8000).includes(0)) { skippedBinary++; continue; }
  scanned++;
  const text = buf.toString("utf8");
  const entry = ALLOWLIST[path];
  const reportedLines = new Set();

  // F2 / F3: the file ADDRESSES a project.
  for (const { what, re } of ADDRESS_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const ref = m[1].toLowerCase();
      if (ref === PRODUCTION_REF) continue;
      const at = lineCol(text, m.index);
      const isKnown = knownForeign.has(ref);
      if (isKnown && entry?.mayLink) continue;
      reportedLines.add(at.split(":")[0]);
      if (isKnown && entry) {
        errors.push(`${path}:${at} — [F3] addresses "${ref}" (${what}). This file is allowlisted to NAME the old project in prose, not to point at it. Write the ref without the address, or drop it.`);
      } else {
        errors.push(`${path}:${at} — [F2] addresses Supabase project "${ref}" (${what}), which is not production (${PRODUCTION_REF}). ` +
          `Anything sent there leaves production and never shows up in it. Use production, or read the endpoint from config ` +
          `(see getEndpoint_() in docs/sheet-onboarding/apps-script.gs).`);
      }
    }
  }

  // F1: the file NAMES a known foreign ref in any form (concatenation, a variable, prose, a comment).
  for (const ref of knownForeign) {
    for (const m of text.matchAll(new RegExp(ref, "gi"))) {
      if (entry) { mentions.add(path); continue; }
      const at = lineCol(text, m.index);
      if (reportedLines.has(at.split(":")[0])) continue; // already reported as an address on this line
      reportedLines.add(at.split(":")[0]);
      errors.push(`${path}:${at} — [F1] names "${ref}", the ORIGINAL project production replaced on 2026-07-05. ` +
        `It is still alive and not controlled by this codebase, so anything aimed at it silently leaves production ` +
        `(the sales sheet said "✅ Imported" for students production never received). Use ${PRODUCTION_REF}. ` +
        `If this is historical prose that must keep the name, add the exact path to ALLOWLIST in scripts/check-foreign-refs.mjs with a reason.`);
    }
  }
}

// F4: stale allowlist entries.
const listedSet = new Set(paths);
for (const path of Object.keys(ALLOWLIST)) {
  if (!listedSet.has(path)) {
    errors.push(`scripts/check-foreign-refs.mjs — [F4] ALLOWLIST entry "${path}" is stale: git does not list that file. Remove the entry.`);
  } else if (!mentions.has(path)) {
    errors.push(`scripts/check-foreign-refs.mjs — [F4] ALLOWLIST entry "${path}" is stale: the file no longer mentions a known foreign ref. Remove the entry so the list stays minimal.`);
  }
}

if (scanned === 0) {
  errors.push(`scripts/check-foreign-refs.mjs — scanned 0 files. A guard that read nothing has not passed; check that it runs inside the git checkout.`);
}

for (const e of errors) console.error("ERROR " + e);
console.log(
  `\nforeign-ref check: ${scanned} files scanned (${skippedMigrations} migrations left to E6, ${skippedBinary} binary skipped), ` +
  `${Object.keys(ALLOWLIST).length} allowlisted, ${errors.length} error(s).`
);
if (errors.length) {
  console.error(`\nforeign-ref check FAILED: ${errors.length} error(s).`);
  process.exit(1);
}
