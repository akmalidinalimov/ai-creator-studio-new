// Run: deno test supabase/functions/broadcast-drainer/
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { siteButtonPath } from "./site-link.ts";

const SITE = ["https://www.aicreator.academy", "https://aicreator.academy"];

Deno.test("our site's links map to their path (+query)", () => {
  assertEquals(siteButtonPath("https://aicreator.academy/lessons", SITE), "/lessons");
  assertEquals(siteButtonPath("https://www.aicreator.academy/course/abc?x=1", SITE), "/course/abc?x=1");
  assertEquals(siteButtonPath("https://aicreator.academy", SITE), "/");
});

Deno.test("anything else is left alone", () => {
  assertEquals(siteButtonPath("https://instagram.com/aicreators", SITE), null);
  assertEquals(siteButtonPath("http://aicreator.academy/lessons", SITE), null);
  assertEquals(siteButtonPath("https://aicreator.academy.evil.com/x", SITE), null);
  assertEquals(siteButtonPath("https://aicreator.academy/auth/magic?t=abc", SITE), null);
  assertEquals(siteButtonPath("not a url", SITE), null);
  assertEquals(siteButtonPath(null, SITE), null);
  assertEquals(siteButtonPath("https://aicreator.academy/x", ["", "garbage"]), null);
});
