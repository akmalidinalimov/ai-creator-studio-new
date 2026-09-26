// Pins cron-engagement's reminder rules (they must not drift while the function is optimised) and the
// paginator's "never trust a short page" property. Run: deno test supabase/functions/cron-engagement/
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchAllKeyset, reminderWindows, type WindowUser, ymdInTz } from "./core.ts";

// Asia/Tashkent is UTC+5 all year, so "HH:MM Tashkent" = UTC + 5 h.
const tashkent = (day: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.parse(`${day}T00:00:00Z`) + ((h - 5) * 60 + m) * 60_000);
};
const user = (o: Partial<WindowUser> = {}): WindowUser => ({
  timezone: "Asia/Tashkent", reminder_time: "20:00:00", created_at: "2026-01-01T00:00:00Z",
  last_daily_reminder_at: null, last_streak_warning_at: null, ...o,
});
const D = "2026-09-26";

Deno.test("quiet hours: nothing before 08:00 local", () => {
  assertEquals(reminderWindows(user(), tashkent(D, "07:59")).quiet, true);
  assertEquals(reminderWindows(user(), tashkent(D, "08:00")).quiet, false);
});

Deno.test("daily window is reminder_time ±30 min, inclusive", () => {
  const at = (t: string) => reminderWindows(user(), tashkent(D, t)).daily;
  assertEquals([at("19:29"), at("19:30"), at("20:00"), at("20:30"), at("20:31")], [false, true, true, true, false]);
});

Deno.test("daily dedup is per LOCAL day, not per UTC day", () => {
  const now = tashkent(D, "19:30");
  // 01:00 Tashkent on the 26th is 20:00 UTC on the 25th: already sent "today" locally.
  assertEquals(reminderWindows(user({ last_daily_reminder_at: "2026-09-25T20:00:00Z" }), now).daily, false);
  // 23:00 Tashkent on the 25th: yesterday locally.
  assertEquals(reminderWindows(user({ last_daily_reminder_at: "2026-09-25T18:00:00Z" }), now).daily, true);
});

Deno.test("reminder_time quirks are preserved", () => {
  // "00:30" → hour 0 is falsy → treated as 20, minute 30 kept: window 20:00-21:00.
  assertEquals(reminderWindows(user({ reminder_time: "00:30:00" }), tashkent(D, "20:45")).daily, true);
  // A reminder time inside quiet hours never fires.
  assertEquals(reminderWindows(user({ reminder_time: "07:30:00" }), tashkent(D, "08:00")).daily, false);
  // null → 20:00.
  assertEquals(reminderWindows(user({ reminder_time: null }), tashkent(D, "19:45")).daily, true);
  assertEquals(reminderWindows(user({ reminder_time: "15:00:00" }), tashkent(D, "14:30")).daily, true);
});

Deno.test("streak window is 21:00 ±30 min, once per local day", () => {
  const at = (t: string, last: string | null = null) => reminderWindows(user({ last_streak_warning_at: last }), tashkent(D, t)).streak;
  assertEquals([at("20:29"), at("20:30"), at("21:30"), at("21:31")], [false, true, true, false]);
  assertEquals(at("21:00", tashkent(D, "20:35").toISOString()), false);
});

Deno.test("drip window is 12:00 ±30 min, accounts at least 3 days old", () => {
  const at = (t: string, created = "2026-01-01T00:00:00Z") => reminderWindows(user({ created_at: created }), tashkent(D, t)).drip;
  assertEquals([at("11:29"), at("11:30"), at("12:30"), at("12:31")], [false, true, true, false]);
  const now = tashkent(D, "12:00");
  assertEquals(at("12:00", new Date(now.getTime() - 3 * 86_400_000 + 60_000).toISOString()), false); // 2.99 days
  assertEquals(at("12:00", new Date(now.getTime() - 3 * 86_400_000).toISOString()), true);
});

Deno.test("an unparseable timezone falls back to UTC; missing ones to Tashkent", () => {
  const now = new Date("2026-09-26T20:00:00Z"); // 01:00 in Tashkent
  assertEquals(reminderWindows(user({ timezone: "Moskva" }), now).daily, true); // live data has this value
  assertEquals(reminderWindows(user({ timezone: "Asia/Samarqand " }), now).hour, 20);
  assertEquals(reminderWindows(user({ timezone: null }), now).quiet, true);
  assertEquals(reminderWindows(user({ timezone: "" }), now).tz, "Asia/Tashkent");
  assertEquals(ymdInTz("Swed", now), "2026-09-26");
  assertEquals(ymdInTz("Asia/Tashkent", now), "2026-09-27");
});

// A minimal PostgREST-like builder over an array, with a server-side row cap smaller than the page size —
// the case where "a short page means done" would silently truncate.
function fakeTable(rows: { id: string }[], cap: number, failOnCall = -1) {
  let calls = 0;
  const admin = {
    from: (_t: string) => {
      let after: string | null = null;
      let limit = Infinity;
      const q = {
        select: (_s: string) => q,
        gt: (_k: string, v: string) => { after = v; return q; },
        order: (_k: string, _o: unknown) => q,
        limit: (n: number) => { limit = n; return q; },
        then: (res: (v: unknown) => unknown) => {
          calls++;
          if (calls === failOnCall) return Promise.resolve({ data: null, error: { message: "boom" } }).then(res);
          const data = rows.filter((r) => after === null || r.id > after).slice(0, Math.min(limit, cap));
          return Promise.resolve({ data, error: null }).then(res);
        },
      };
      return q;
    },
  };
  return admin;
}

Deno.test("fetchAllKeyset reads every row even when the server caps below the page size", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `id-${String(i).padStart(2, "0")}` }));
  const r = await fetchAllKeyset(fakeTable(rows, 3), "t", "id", "id", (q) => q);
  assertEquals(r.error, null);
  assertEquals(r.rows.map((x) => x.id), rows.map((x) => x.id));
});

Deno.test("fetchAllKeyset reports a failed page instead of returning a partial read as complete", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `id-${String(i).padStart(2, "0")}` }));
  const r = await fetchAllKeyset(fakeTable(rows, 3, 2), "t", "id", "id", (q) => q);
  assertEquals(r.error, "boom");
});
