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
// A SECOND CLASS LIVES HERE TOO: HARDCODED FOREIGN INFRASTRUCTURE (E6, E7). On 2026-07-05 production
// was built by replaying the original project's migrations, and the replay carried forward a
// track_video_progress() that POSTed to https://wpdztrijasgmxgliwddr.supabase.co — the OLD project —
// with the old project's anon JWT inlined. For twelve weeks every lesson completion sent production's
// internal_fn_secret() to infrastructure this project does not control, and not one completion
// message reached a student (fixed by 20260926161000). Something DID flag it — ops_http_failure_watchdog
// fired 159 times ("403 × N unattributed") — but a raw net.http_post records no URL, so no alert could
// say where the requests were going; the URL itself looked exactly like every correct URL. So a
// migration now fails if it contains a Supabase project URL for any ref other than production's (E6),
// or an inline credential (E7), or a raw net.http_post that would leave any future failure just as
// untraceable (E8), or drops the attributed wrapper every caller now depends on (E9). E6 skips
// comments, so a header may explain what it removed; E7 does not, because a key in a comment is still
// a key in git history.
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
    // line comment — Postgres ends it at LF or CR
    if (sql[i] === "-" && sql[i + 1] === "-") {
      let j = i;
      while (j < n && sql[j] !== "\n" && sql[j] !== "\r") j++;
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

// Blanks COMMENTS ONLY — keeps string literals and dollar-quoted bodies, because a URL or a JWT always
// lives inside a string literal, which blankNonCode() erases. This lets a migration header explain what
// it removed (naming the old ref) without tripping E6, while any executable or literal occurrence is
// still caught.
//
// Dollar-quoted bodies are LEXED RECURSIVELY WITHIN THEIR OWN BOUNDS, because a function body is SQL
// with its own comments and strings. An earlier version tracked only single-quote parity across the
// whole file, so one apostrophe inside a body (`$c$Don't$c$`) flipped the parity for everything after
// it — hiding a real foreign URL further down, or treating a comment as code. Review found it doing
// exactly that on a real repo file. Bounding the recursion to the body means an unterminated quote
// inside a body can no longer leak past its closing tag.
//
// A comment only starts at a boundary (line start, whitespace, `(`, `,` or `;`). Real SQL comments
// always do; requiring it stops `'a--b'`-style data and dollar-quoted JSON such as `"storage/*"` from
// being mistaken for comments and blanking a URL that follows them.
function blankCommentsOnly(sql) {
  const out = sql.split("");
  const n = sql.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  const atBoundary = (i, start) => i === start || /[\s(,;]/.test(sql[i - 1]);

  const lex = (start, end) => {
    let i = start;
    while (i < end) {
      const c = sql[i];
      if (c === "'") {
        // E'...' uses backslash escapes; plain '...' uses doubled quotes.
        const isE = i > start && isEString(sql, i);
        let j = i + 1;
        while (j < end) {
          if (isE && sql[j] === "\\") { j += 2; continue; }
          if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
          if (sql[j] === "'") { j++; break; }
          j++;
        }
        i = j;
        continue;
      }
      if (c === '"') {
        let j = i + 1;
        while (j < end) {
          if (sql[j] === '"' && sql[j + 1] === '"') { j += 2; continue; }
          if (sql[j] === '"') { j++; break; }
          j++;
        }
        i = j;
        continue;
      }
      if (c === "$") {
        const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, Math.min(end, i + 64)));
        if (m) {
          const tag = m[0];
          const close = sql.indexOf(tag, i + tag.length);
          const bodyEnd = close === -1 || close >= end ? end : close;
          lex(i + tag.length, bodyEnd);            // recurse: the body is SQL with its own comments
          i = bodyEnd === end ? end : close + tag.length;
          continue;
        }
      }
      if (c === "-" && sql[i + 1] === "-" && atBoundary(i, start)) {
        let j = i;
        while (j < end && sql[j] !== "\n" && sql[j] !== "\r") j++;             // Postgres: LF or CR
        blank(i, j);
        i = j;
        continue;
      }
      if (c === "/" && sql[i + 1] === "*" && atBoundary(i, start)) {
        let depth = 1;
        let j = i + 2;
        while (j < end && depth > 0) {
          if (sql[j] === "/" && sql[j + 1] === "*") { depth++; j += 2; continue; }
          if (sql[j] === "*" && sql[j + 1] === "/") { depth--; j += 2; continue; }
          j++;
        }
        blank(i, j);
        i = j;
        continue;
      }
      i++;
    }
  };

  lex(0, n);
  return out.join("");
}

// Production's Supabase project ref. Any OTHER ref in a migration is foreign infrastructure.
const PRODUCTION_REF = "cdyidatkegxwhtuoqxly";

// Refs KNOWN to be foreign. These are denied anywhere in non-comment text, not only inside a URL, so
// that concatenation ('https://' || ref || '.supabase.co'), format('https://%s.supabase.co', ref) and a
// bare ref variable are all caught for the one ref we know is dangerous. wpdztrijasgmxgliwddr is the
// ORIGINAL Lovable-hosted project: still alive, not controlled by this codebase (see 20260926161000).
const KNOWN_FOREIGN_REFS = ["wpdztrijasgmxgliwddr"];

// ─────────────────────────── ops_net_post (E8, E9) ───────────────────────────
// The exact parameter list every caller of public.ops_net_post depends on, verified against the live
// catalog on 2026-09-26. Callers depend on it FOUR ways: by NAME (anon_execute_watchdog passes
// p_timeout_ms :=), by POSITION (six cron jobs pass all five in order), by TYPE, and by ARITY — the 38
// calls converted by 20260926200000 pass four arguments and rely on p_timeout_ms's DEFAULT, and other
// callers omit the later ones too. So every parameter after p_url must keep a default. Change this
// only together with a deliberate, caller-checked signature change.
const OPS_NET_POST_SHAPE = [
  { name: "p_url", type: "text", needsDefault: false },
  { name: "p_body", type: "jsonb", needsDefault: true },
  { name: "p_headers", type: "jsonb", needsDefault: true },
  { name: "p_purpose", type: "text", needsDefault: true },
  { name: "p_timeout_ms", type: "integer", needsDefault: true },
];
const OPS_NET_POST_SIGNATURE =
  "p_url text, p_body jsonb DEFAULT '{}'::jsonb, p_headers jsonb DEFAULT '{}'::jsonb, " +
  "p_purpose text DEFAULT NULL, p_timeout_ms integer DEFAULT 5000";
// m[1] is "function" or "procedure" — a PROCEDURE named ops_net_post is never a valid replacement.
const OPS_NET_POST_CREATE_RE =
  /\bcreate\s+(?:or\s+replace\s+)?(function|procedure)\s+(?:"?public"?\s*\.\s*)?"?ops_net_post"?\s*\(/gi;
// Names ops_net_post as an object — bare, schema-qualified, "quoted", inside a list, or as a string
// literal (format('drop function %I(...)', 'ops_net_post')) — but not ops_net_post_x.
const NAMES_OPS_NET_POST = /(?:^|[\s,.('])"?ops_net_post["']?(?![A-Za-z0-9_$])/i;
// Identifier characters for Postgres's lexer: ASCII letters, digits, _, $ and every non-ASCII char.
const IDENT_CHAR = /[A-Za-z0-9_$\u0080-￿]/;

// Is the quote at text[i] the start of an E'...' string (backslash escapes)?
const isEString = (text, i) => /[eE]/.test(text[i - 1] || "") && !IDENT_CHAR.test(text[i - 2] || "");

// Index of the ')' matching the '(' at `open`, skipping '...' strings (E'...' backslash escapes
// included) and "quoted identifiers"; -1 if it never closes.
function balancedClose(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      const isE = isEString(text, i);
      i++;
      while (i < text.length) {
        if (isE && text[i] === "\\") { i += 2; continue; }
        if (text[i] === "'" && text[i + 1] === "'") { i += 2; continue; }
        if (text[i] === "'") break;
        i++;
      }
    } else if (c === '"') {
      i++;
      while (i < text.length && !(text[i] === '"' && text[i + 1] !== '"')) i += text[i] === '"' ? 2 : 1;
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Splits a parameter list at top-level commas, keeping strings (E'...' included), "identifiers" and
// nested parentheses intact.
function splitParams(list) {
  const params = [];
  let depth = 0, cur = "";
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "'" || c === '"') {
      const isE = c === "'" && isEString(list, i);
      let j = i + 1;
      while (j < list.length) {
        if (isE && list[j] === "\\") { j += 2; continue; }
        if (list[j] === c && list[j + 1] === c) { j += 2; continue; }
        if (list[j] === c) break;
        j++;
      }
      cur += list.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { params.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) params.push(cur);
  return params;
}

// Does a parameter list (the text between the parentheses) have exactly OPS_NET_POST_SHAPE — names
// (a "quoted" name is case-sensitive, as in Postgres), types, order, and a default where one is needed?
function shapeMatches(list) {
  const params = splitParams(list);
  if (params.length !== OPS_NET_POST_SHAPE.length) return false;
  const normType = (t) => {
    const s = t.replace(/"/g, "").toLowerCase().replace(/\s+/g, " ").trim().replace(/^(?:pg_catalog|public)\./, "");
    return s === "int" || s === "int4" ? "integer" : s;
  };
  return params.every((p, k) => {
    const m = /^\s*(?:(?:in|variadic)\s+)?("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)\s+([\s\S]*?)(\s+default\s+[\s\S]*|\s*=[\s\S]*)?\s*$/i.exec(p);
    if (!m) return false;
    const name = m[1].startsWith('"') ? m[1].slice(1, -1).replace(/""/g, '"') : m[1].toLowerCase();
    const want = OPS_NET_POST_SHAPE[k];
    return name === want.name && normType(m[2]) === want.type && (!want.needsDefault || Boolean(m[3]));
  });
}

// The role list of a REVOKE, stopping at GRANTED BY / CASCADE / RESTRICT.
const revokeRoles = (stmt) => {
  const from = /\bfrom\b([\s\S]*)$/i.exec(stmt);
  return from ? from[1].split(/\b(?:granted\s+by|cascade|restrict)\b/i)[0] : "";
};

// `lint:allow <rule>: <reason>` suppresses a finding on the same line — but only when the marker sits
// INSIDE A COMMENT (so it cannot be satisfied by code or a string), and only with a real reason: at
// least 20 characters, taken from that comment alone (a /* */ marker ends at its */). The marker is in
// the diff, so every use is visible to a reviewer.
function lintAllowed(raw, noComments, index, rule) {
  const start = raw.lastIndexOf("\n", index - 1) + 1;
  const endNl = raw.indexOf("\n", index);
  const line = raw.slice(start, endNl === -1 ? raw.length : endNl);
  const marker = `lint:allow ${rule}:`;
  const at = line.indexOf(marker);
  if (at === -1) return false;
  if (noComments.slice(start + at, start + at + marker.length).trim() !== "") return false; // not in a comment
  let reason = line.slice(at + marker.length);
  const close = reason.indexOf("*/");
  if (close !== -1) reason = reason.slice(0, close);
  reason = reason.trim();
  return reason.length >= 20 && /[A-Za-z]{3}/.test(reason);
}

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

  // E6 (ERROR): a Supabase project URL for any ref other than production's. This is the exact shape
  // the 2026-07-05 replay carried into track_video_progress(). Scanned on code AND string literals
  // (where URLs live) but not on comments, so a header may name the old ref when explaining a fix.
  // Covers the legacy edge-function host (<ref>.functions.supabase.co — the same service this incident
  // called), the direct DB host (db.<ref>.supabase.co) and supabase.in, not only <ref>.supabase.co.
  const noComments = blankCommentsOnly(raw);
  const e6Lines = new Set();
  for (const m of noComments.matchAll(
    /https?:\/\/(?:db\.)?([a-z0-9]{20})\.(?:functions\.)?supabase\.(?:co|in)/gi
  )) {
    if (m[1].toLowerCase() === PRODUCTION_REF) continue;
    const line = lineOf(noComments, m.index);
    e6Lines.add(line);
    push(errors, line,
      `hardcodes the Supabase project "${m[1]}", which is not production (${PRODUCTION_REF}). ` +
      `Calls to it leave this project entirely — on 2026-07-05 exactly this sent internal_fn_secret() ` +
      `to the old project on every lesson completion for twelve weeks. Use the production ref.`);
  }
  // …and the known-foreign refs ANYWHERE in non-comment text, which catches the forms a URL regex
  // cannot: string concatenation, format(), a ref held in a variable.
  for (const ref of KNOWN_FOREIGN_REFS) {
    for (const m of noComments.matchAll(new RegExp(ref, "gi"))) {
      const line = lineOf(noComments, m.index);
      if (e6Lines.has(line)) continue;                 // already reported as a URL on this line
      e6Lines.add(line);
      push(errors, line,
        `references "${ref}", the ORIGINAL project that production replaced on 2026-07-05. It is still ` +
        `alive and not controlled by this codebase; nothing here should address it, in any form.`);
    }
  }

  // E7 (ERROR): an inline credential. Whichever project it belongs to, a key does not belong in a
  // migration: an anon key goes stale when the project moves (the one removed by 20260926161000 was the
  // OLD project's), and a service_role key would be a full-database credential in git history.
  // Scanned on the RAW text, comments INCLUDED — unlike E6. A key pasted into a comment is just as
  // permanently in git history; only a URL in a comment is harmless. (An earlier version exempted
  // comments here too, which review caught: its own stated reason was git history.)
  // Also: Supabase's non-JWT key formats (sb_secret_…, and sbp_… personal access tokens), and the JWT
  // header prefix on its own, which catches a token split across `||` to dodge the full pattern.
  const e7Lines = new Set();
  const credentialPatterns = [
    /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,  // a whole JWT
    /eyJhbGciOi[A-Za-z0-9_-]{4,}/g,                                   // a JWT header ({"alg":…) on its own
    /\b(?:sb_secret_|sbp_)[A-Za-z0-9_]{8,}/g,                          // Supabase secret key / access token
  ];
  for (const re of credentialPatterns) {
    for (const m of raw.matchAll(re)) {
      const line = lineOf(raw, m.index);
      if (e7Lines.has(line)) continue;
      e7Lines.add(line);
      push(errors, line,
        // Never echo any part of the token: CI logs are not a place for credentials, even fragments.
        `contains an inline credential. Read credentials at runtime — public.cron_service_key() / ` +
        `public.internal_fn_secret() from Vault — never embed them, not even in a comment.`);
    }
  }

  // Every `create [or replace] function|procedure ops_net_post(`, with the offset of its '(' — shared by
  // the E8 exemption and E9. Strings are scanned too: dynamic DDL in EXECUTE '...' is real DDL.
  const opsNetPostCreates = [...noComments.matchAll(OPS_NET_POST_CREATE_RE)].map((m) => {
    const open = m.index + m[0].length - 1;
    const close = balancedClose(noComments, open);
    const list = close === -1 ? null : noComments.slice(open + 1, close);
    const kind = m[1].toLowerCase();
    return { index: m.index, open, close, list, kind, good: kind === "function" && list !== null && shapeMatches(list) };
  });

  // E8: a raw net.http_post / net.http_get / net.http_delete from SQL. Use public.ops_net_post(), which
  // records the URL and a purpose in ops_http_calls. This is the lesson of the incident that
  // 20260926161000 fixes: ops_http_failure_watchdog DID fire — 159 times, "403 × N unattributed" — but a
  // raw call records no URL, so no alert ever said WHERE the requests were going, and twelve weeks passed.
  // net.http_post is an ERROR: since 20260926200000 there are none left in production, and the repo
  // still holds the PRE-conversion bodies of those 25 functions — a migration that copies one forward
  // would silently revert its attribution. http_get/http_delete stay WARNINGS: ops_net_post is
  // POST-only, so there is no attributed alternative to demand yet.
  // Matched in the same forms the migration's own final invariant treats as raw: any case, spaces
  // around the dot, quoted identifiers ("net".http_post). Two exemptions:
  //   * the body of ops_net_post's own definition — the one legitimate raw call. Only a dollar-quoted
  //     body whose `as $tag$` sits in the same statement as the create, bounded by its closing tag.
  //   * a line carrying a `lint:allow E8: <reason>` comment (see lintAllowed), for text that names the
  //     call without making it — e.g. a detector's pattern, or a parser check that never runs.
  const opsNetPostBodies = [];
  for (const c of opsNetPostCreates) {
    if (c.close === -1) continue;
    const header = /^[^;]*?\bas\s+(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)/i.exec(noComments.slice(c.close + 1));
    if (!header) continue;                              // 'quoted' or BEGIN ATOMIC body: no exemption
    const bodyStart = c.close + 1 + header[0].length;
    const bodyEnd = noComments.indexOf(header[1], bodyStart);
    if (bodyEnd !== -1) opsNetPostBodies.push([bodyStart, bodyEnd]);
  }
  for (const m of noComments.matchAll(
    /(^|[^A-Za-z0-9_$])("?net"?\s*\.\s*"?http_(post|get|delete)"?)\s*\(/gi
  )) {
    const at = m.index + m[1].length;
    if (opsNetPostBodies.some(([a, b]) => at >= a && at < b)) continue;
    if (lintAllowed(raw, noComments, at, "E8")) continue;
    const isPost = m[3].toLowerCase() === "post";
    push(isPost ? errors : warnings, lineOf(noComments, at),
      `calls ${m[2].replace(/\s+/g, "")} directly. Use public.ops_net_post(p_url, p_body, p_headers, ` +
      `p_purpose, p_timeout_ms) so a failure is attributed to a URL and a purpose instead of surfacing ` +
      `as an unattributed 403 that no one can trace.` +
      (isPost ? ` If you copied a function body from an older migration, take the LIVE definition ` +
        `instead (pg_get_functiondef) — production was converted by 20260926200000 and the repo was not. ` +
        `If this text only NAMES the call, add a comment on the line: "lint:allow E8: <reason>".` : ""));
  }

  // E9 (ERROR): anything that removes, reshapes or re-opens public.ops_net_post. Since 20260926200000
  // about 52 call sites — every watchdog's own alert channel among them — depend on it by name, by
  // position, by type and by arity (see OPS_NET_POST_SHAPE). pg_depend records no dependency from a
  // PL/pgSQL body or a cron command, so Postgres allows a DROP, a RENAME or a reshaped recreate, and every
  // caller fails at its next send — including the alarms that should report it. So:
  //   (a) every create of ops_net_post must be a FUNCTION with exactly OPS_NET_POST_SHAPE — names,
  //       types, order and the defaults callers rely on. Anything else is a broken replacement or a
  //       second overload, and an overload makes every call that fits both ambiguous;
  //   (b) a DROP FUNCTION/ROUTINE naming it (alone, in a list, quoted, or as a string literal fed to
  //       format/EXECUTE), or an ALTER that renames it or moves its schema, must be followed LATER in the
  //       same file by such a create AND, after that, a revoke of EXECUTE from `authenticated`: a new
  //       function is born callable by every signed-in user under this project's default privileges
  //       (20260926093000), and ops_net_post can POST anywhere (revoked for that reason in 20260925201000);
  //   (c) changing its owner (to anyone but postgres), or revoking EXECUTE from postgres/service_role —
  //       by name or by a blanket "on all functions in schema public" — is always an error.
  // A deliberate signature change updates OPS_NET_POST_SHAPE in this file in the same PR, after
  // checking every caller in pg_proc and cron.job. A `lint:allow E9: <reason>` comment also works.
  const e9 = (index, msg) => {
    if (lintAllowed(raw, noComments, index, "E9")) return;
    push(errors, lineOf(noComments, index), msg);
  };
  const goodCreates = opsNetPostCreates.filter((c) => c.good);
  const opsRevokes = [...noComments.matchAll(/\brevoke\b[^;]*\bon\s+(?:function|routine)s?\b[^;]*/gi)]
    .filter((m) => NAMES_OPS_NET_POST.test(m[0]))
    .map((m) => ({ index: m.index, roles: revokeRoles(m[0]) }));
  // null when the file restores ops_net_post after `index`; otherwise what is missing.
  const missingAfter = (index) => {
    const c = goodCreates.find((g) => g.index > index);
    if (!c) return `without recreating it (${OPS_NET_POST_SIGNATURE}) later in the same migration`;
    if (!opsRevokes.some((v) => v.index > c.index && /\bauthenticated\b/i.test(v.roles))) {
      return `and recreates it, but never revokes EXECUTE from authenticated afterwards — under this ` +
        `project's default privileges the new function is callable by every signed-in user, and it can ` +
        `POST anywhere (20260925201000 revoked it for exactly that)`;
    }
    return null;
  };
  for (const c of opsNetPostCreates) {
    if (c.good) continue;
    e9(c.index,
      `creates public.ops_net_post${c.kind === "procedure" ? " as a PROCEDURE" : ""} with parameters ` +
      `(${c.list === null ? "unbalanced" : c.list.replace(/\s+/g, " ").trim()}). Its ~52 callers need a ` +
      `FUNCTION with exactly (${OPS_NET_POST_SIGNATURE}) — names, types, order and defaults (the ` +
      `converted calls pass four arguments). Anything else breaks them or adds an overload that makes ` +
      `their calls ambiguous.`);
  }
  for (const m of noComments.matchAll(/\bdrop\s+(?:function|routine)\b[^;]*/gi)) {
    if (!NAMES_OPS_NET_POST.test(m[0])) continue;
    const missing = missingAfter(m.index);
    if (!missing) continue;
    e9(m.index,
      `drops public.ops_net_post ${missing}. ~52 callers, including every watchdog's alert channel, ` +
      `resolve it at run time and nothing in pg_depend stops the drop.`);
  }
  for (const m of noComments.matchAll(/\balter\s+(?:function|routine)\b[^;]*/gi)) {
    if (!NAMES_OPS_NET_POST.test(m[0])) continue;
    const owner = /\bowner\s+to\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(m[0]);
    if (owner) {
      if (owner[1].toLowerCase() !== "postgres") {
        e9(m.index, `changes the owner of public.ops_net_post to ${owner[1]}. Its callers run it as postgres; do not move it.`);
      }
    } else if (/\b(?:rename|set\s+schema)\b/i.test(m[0])) {
      const missing = missingAfter(m.index);
      if (missing) {
        e9(m.index, `renames or moves public.ops_net_post ${missing} — every caller resolves it by that name at run time.`);
      }
    }
  }
  const revokesFromOwnerRoles = (roles) => /\b(?:postgres|service_role)\b/i.test(roles);
  for (const v of opsRevokes) {
    if (!revokesFromOwnerRoles(v.roles)) continue;
    e9(v.index,
      `revokes EXECUTE on public.ops_net_post from postgres or service_role — the roles every ` +
      `converted watchdog and cron job runs it as.`);
  }
  for (const m of noComments.matchAll(
    /\brevoke\b[^;]*\bon\s+all\s+(?:functions|routines)\s+in\s+schema\s+"?public"?\b[^;]*/gi
  )) {
    if (!revokesFromOwnerRoles(revokeRoles(m[0]))) continue;
    e9(m.index,
      `revokes EXECUTE on every function in schema public from postgres or service_role — that ` +
      `includes public.ops_net_post, which every converted watchdog and cron job runs as those roles.`);
  }

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
