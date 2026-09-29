import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { likeEscape, normUsername } from "./username.ts";

// Mirrors Postgres ILIKE with the default "\" escape, to prove the escaped pattern is an exact match.
function ilike(value: string, pattern: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) { re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue; }
    if (c === "%") re += ".*";
    else if (c === "_") re += ".";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "is").test(value);
}

Deno.test("unescaped '_' is a wildcard — the bug this helper exists for", () => {
  assertEquals(ilike("alice1", "a_ice1"), true);
});

Deno.test("likeEscape: an underscore username matches only itself (case-insensitive)", () => {
  assertEquals(ilike("alice1", likeEscape("a_ice1")), false);
  assertEquals(ilike("a_ice1", likeEscape("a_ice1")), true);
  assertEquals(ilike("A_Ice1", likeEscape("a_ice1")), true);
  assertEquals(ilike("xa_ice1", likeEscape("a_ice1")), false);
});

Deno.test("likeEscape: % and backslash are literal too", () => {
  assertEquals(likeEscape("a%b\\c_d"), "a\\%b\\\\c\\_d");
  assertEquals(ilike("aXXb", likeEscape("a%b")), false);
});

Deno.test("suffix pattern keeps the @-prefixed variant but stays exact otherwise", () => {
  const p = `%${likeEscape("madina_azv")}`;
  assertEquals(ilike("@Madina_Azv", p), true);
  assertEquals(ilike("madinaXazv", p), false);
});

Deno.test("normUsername", () => {
  assertEquals(normUsername("  @@Madina_Azv "), "madina_azv");
  assertEquals(normUsername(null), "");
});
