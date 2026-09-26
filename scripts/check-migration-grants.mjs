#!/usr/bin/env node
// Author-time guard against the anon-EXECUTE footgun class (prevention hierarchy layer 3).
//
// WHY THIS EXISTS. Three separate incidents, all the same shape:
//   * `cron_service_key()` returned a decrypted Vault service_role credential and `anon` could call
//     it over /rest/v1/rpc for ~83 days (closed by 20260925201000).
//   * `recalc_leaderboard_v2()` handed 685 students' activity data to anyone holding the publishable
//     key, with no guard at all (closed by 20260926101000).
//   * 20260925201000 closed `leaderboard_top(int)` and MISSED the v2 that superseded it — closing a
//     function by name leaves its successor open.
// A runtime watchdog only notices these after they ship. This fails the build instead.
//
// THE TRAP THIS EXISTS TO CATCH, above all others: most function ACLs carry the grant to the PUBLIC
// pseudo-role (`=X/postgres`), which `anon` and `authenticated` INHERIT. So
//     revoke execute on function public.f() from anon;          -- NO-OP, and looks like a fix
// leaves the function wide open. The correct form always names PUBLIC first:
//     revoke execute on function public.f() from public, anon, authenticated;
//     grant  execute on function public.f() to service_role;
// This is the same class as the video-source-column leak, where a column-level REVOKE was a no-op
// against a table-level GRANT.
//
// WHAT CHANGED IN 20260926093000, and why the rules are calibrated the way they are. A GLOBAL
// `alter default privileges for role postgres revoke execute on functions from public` now means new
// functions in schema public are born `postgres + authenticated + service_role` — NOT anon. So
// "created a function without revoking" is no longer an anon hole by itself, and making that a hard
// error would fire on every new function and train people to ignore this script. It is therefore a
// WARNING, and scoped to SECURITY DEFINER functions only, where being reachable by any signed-in
// student is the real risk (that is the 20260926072000 identity-bypass class). What remains a hard
// ERROR is what default privileges cannot protect against: an EXPLICIT grant to anon, a blanket
// grant, and the PUBLIC-omitting revoke above.
//
// GRANDFATHERING. ~200 migrations predate this script and many would fail it. Rather than a baseline
// file that has to be maintained, enforcement is keyed on the migration's own timestamp: files named
// before CUTOFF are scanned and counted so the debt stays visible, but never fail the build.
// Migrations are append-only and timestamp-named here, so this needs no upkeep.
//
// CI usage:  node scripts/check-migration-grants.mjs            (fails on errors)
//            node scripts/check-migration-grants.mjs --strict   (fails on warnings too)
// It is chained onto `npm run lint:footguns`, which CI already runs as a blocking step — deliberately,
// because agent-authored PRs may never touch .github/**, so extending the npm script is the only way
// to land a real gate.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// MIGRATIONS_DIR exists so this script can be pointed at fixtures and proved to actually CATCH the
// incidents it claims to. A guard nobody has seen fail is a guard nobody should trust.
const migrationsDir = process.env.MIGRATIONS_DIR || join(root, "supabase", "migrations");
const strict = process.argv.includes("--strict");

// Everything named at or after this timestamp has the rules enforced. It is a FLOOR, not a filename —
// no file needs to carry this exact stamp. Set to midday 2026-09-26 so that everything written from
// the introduction of these rules onward is covered, including the anon-execute watchdog migration
// that this guard exists to protect. A future date was the first draft and was wrong: it would have
// left today's own work unchecked by its own guard.
// Bump only to grandfather a deliberate exception you have argued for in the migration header —
// never to silence a finding.
const CUTOFF = "20260926120000";

// Functions deliberately reachable by `anon`. An entry MUST carry a reason: the point is that the
// next person reads why, not that the check goes quiet.
const ANON_ALLOWLIST = {
  "has_role": "Called by 124 RLS policy expressions across 63 tables, 39 of which name no role and so apply to PUBLIC including anon. A policy expression runs with the CALLER's privileges, so revoking anon makes every such policy RAISE instead of returning false. Broke the app once already: see 20260705110000_grant_has_role_to_anon.sql. Returns boolean; has_role(NULL,...) is false.",
  "get_public_setting": "Deliberately public and FIELD-WHITELISTED: returns bot_username and the bot_id parsed from before the ':' in the token, never the token itself, and only booleans for content_protection. Read by src/pages/LessonPage.tsx, a page anonymous visitors can reach. Contrast challenge_config(), which returned its settings row VERBATIM and was therefore revoked, not allowlisted — a whitelisting function cannot widen when a secret is added to its row.",
};

// ─────────────────────────── SQL-aware scanner ───────────────────────────
// Blanks out comments and string/dollar-quoted bodies, preserving offsets and newlines so that
// reported line numbers stay true and a function BODY can never masquerade as a statement. Without
// this, a body containing the words "grant execute ... to anon" in a comment would trip every rule.
function blankNonCode(sql) {
  const out = sql.split("");
  const n = sql.length;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };

  while (i < n) {
    // line comment
    if (sql[i] === "-" && sql[i + 1] === "-") {
      let j = i;
      while (j < n && sql[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    // block comment (nestable, per Postgres)
    if (sql[i] === "/" && sql[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") { depth++; j += 2; continue; }
        if (sql[j] === "*" && sql[j + 1] === "/") { depth--; j += 2; continue; }
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    // dollar-quoted body: $tag$ ... $tag$
    if (sql[i] === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const j = end === -1 ? n : end + tag.length;
        blank(i, j);
        i = j;
        continue;
      }
    }
    // single-quoted literal, '' escapes
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j++; break; }
        j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    // double-quoted identifier — keep it, identifiers are code
    i++;
  }
  return out.join("");
}

const lineOf = (sql, index) => sql.slice(0, index).split("\n").length;

// ─────────────────────────── rules ───────────────────────────
const errors = [];
const warnings = [];
const debt = [];

function checkFile(file, raw) {
  const code = blankNonCode(raw);
  const enforced = file.slice(0, 14) >= CUTOFF;
  const push = (bucket, line, msg) => {
    const entry = `${file}:${line} — ${msg}`;
    if (!enforced) debt.push(entry);
    else bucket.push(entry);
  };

  // E1 (ERROR, always): a blanket grant over every function in the schema. There is no legitimate
  // use of this here, and it silently re-opens everything previous migrations closed.
  for (const m of code.matchAll(
    /grant\s+(?:execute|all)[\s\S]{0,80}?on\s+all\s+functions\s+in\s+schema\s+public\s+to\s+([^;]+);/gi
  )) {
    const who = m[1].toLowerCase();
    if (/\banon\b|\bpublic\b|\bauthenticated\b/.test(who)) {
      push(errors, lineOf(code, m.index),
        `blanket "grant ... on all functions in schema public to ${m[1].trim()}" re-opens every function ever closed. Grant per function instead.`);
    }
  }

  // E2 (ERROR): a file that revokes from anon/authenticated but NEVER from PUBLIC. The no-op trap.
  //
  // Deliberately FILE-SCOPED, not per-statement. An early version flagged each REVOKE that omitted
  // PUBLIC and produced a false positive on a real, CORRECT migration
  // (20260428162429_105e6ed5…sql:181): it revokes PUBLIC for a list of functions dynamically, inside
  // a DO block via EXECUTE format(...), and then revokes `authenticated` in separate plain
  // statements. Net effect is right; only the shape looked wrong. Since blankNonCode() must blank
  // dollar-quoted bodies (or a function body's own text would masquerade as statements), the scanner
  // cannot see dynamic DDL at all — so judging a single statement in isolation is unsound here.
  // A file that revokes from anon but NEVER mentions PUBLIC is, however, essentially always the bug.
  const revokesFromPublicAnywhere = /revoke[\s\S]{0,200}?from[^;]*\bpublic\b/i.test(raw);
  if (!revokesFromPublicAnywhere) {
    for (const m of code.matchAll(/revoke\s+execute\s+on\s+function\s+([\s\S]*?)\s+from\s+([^;]+);/gi)) {
      const target = m[1].replace(/\s+/g, " ").trim();
      const roles = m[2].toLowerCase();
      if (/\banon\b|\bauthenticated\b/.test(roles)) {
        push(errors, lineOf(code, m.index),
          `"revoke execute on function ${target} from ${m[2].trim()}" — and this file never revokes from PUBLIC anywhere. Most ACLs grant to the PUBLIC pseudo-role, which anon/authenticated inherit, so this is a NO-OP that looks exactly like a fix. Write: from public, anon, authenticated.`);
      }
    }
  }

  // E3 (ERROR unless allowlisted with a reason): an explicit grant of EXECUTE to anon.
  for (const m of code.matchAll(/grant\s+execute\s+on\s+function\s+([\s\S]*?)\s+to\s+([^;]+);/gi)) {
    const target = m[1].replace(/\s+/g, " ").trim();
    const roles = m[2].toLowerCase();
    if (!/\banon\b|\bpublic\b/.test(roles)) continue;
    const fnName = (target.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/) || [])[1] ||
                   target.replace(/^public\./, "").split("(")[0].trim();
    const reason = ANON_ALLOWLIST[fnName];
    if (!reason) {
      push(errors, lineOf(code, m.index),
        `grants EXECUTE on ${target} to ${m[2].trim()} — anon/PUBLIC means "anyone on the internet holding the publishable key", via /rest/v1/rpc/${fnName}. If that is intended, add "${fnName}" to ANON_ALLOWLIST in scripts/check-migration-grants.mjs with a reason, and make the function whitelist the fields it returns.`);
    }
  }

  // E4 (WARNING, SECURITY DEFINER only): created without an accompanying revoke. Since
  // 20260926093000 a new function is no longer born anon-callable, but it IS born reachable by
  // `authenticated` — which is the identity-bypass class fixed in 20260926072000. So this asks for
  // an explicit decision rather than blocking.
  const created = [];
  for (const m of code.matchAll(
    /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi
  )) {
    const name = m[1];
    // Is this one SECURITY DEFINER? Look ahead to the end of the statement's header.
    const tail = code.slice(m.index, m.index + 2000);
    if (!/security\s+definer/i.test(tail)) continue;
    created.push({ name, line: lineOf(code, m.index) });
  }
  for (const { name, line } of created) {
    // Search the RAW text, not the blanked code: this repo routinely revokes inside DO blocks via
    // EXECUTE format(...), and those bodies are blanked out. Being lenient here risks a missed
    // warning; being strict here produces false warnings on correct migrations, which is worse for a
    // guard that has to stay trusted. A name listed in a dynamic revoke loop counts as revoked.
    const revoked = new RegExp(
      `revoke\\s+execute\\s+on\\s+function\\s+(?:public\\.)?${name}\\s*\\(`, "i"
    ).test(raw) || new RegExp(`'${name}'`, "i").test(raw) && /revoke\s+execute/i.test(raw);
    const dropped = new RegExp(`drop\\s+function\\s+if\\s+exists\\s+(?:public\\.)?${name}\\s*\\(`, "i")
      .test(raw);
    if (!revoked && !dropped && !ANON_ALLOWLIST[name]) {
      push(warnings, line,
        `SECURITY DEFINER function ${name}() is created without an accompanying "revoke execute ... from public, anon, authenticated". It will be reachable by every signed-in user. Add the revoke, or allowlist it with a reason.`);
    }
  }
}

// E5 (ERROR): an allowlist entry with no real reason. Guards the guard.
for (const [fn, reason] of Object.entries(ANON_ALLOWLIST)) {
  if (!reason || reason.trim().length < 40) {
    errors.push(`scripts/check-migration-grants.mjs — ANON_ALLOWLIST["${fn}"] has no substantive reason. An allowlist without a stated reason is how a deliberate exception becomes an accident.`);
  }
}

const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
for (const f of files) checkFile(f, readFileSync(join(migrationsDir, f), "utf8"));

for (const w of warnings) console.warn("WARN  " + w);
for (const e of errors) console.error("ERROR " + e);

console.log(
  `\nmigration grant check: ${files.length} migrations scanned, enforcing from ${CUTOFF}. ` +
  `${errors.length} error(s), ${warnings.length} warning(s), ${debt.length} pre-cutoff finding(s) not enforced.`
);
if (debt.length && process.argv.includes("--show-debt")) {
  console.log("\nPre-cutoff findings (informational — these migrations are already applied):");
  for (const d of debt) console.log("  " + d);
}

if (errors.length || (strict && warnings.length)) {
  console.error(`\nmigration grant check FAILED: ${errors.length} error(s), ${warnings.length} warning(s).`);
  process.exit(1);
}
