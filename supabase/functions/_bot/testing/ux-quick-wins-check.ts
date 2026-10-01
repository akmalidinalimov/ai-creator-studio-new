// Cross-checks the UX quick-win modules against the webhook's own source (index.ts cannot be imported by a
// test: it calls Deno.serve at load). Catches the drift a unit test cannot see:
//   A. every command advertised in a "/" list is one index.ts actually handles
//   B. the ☰ labels equal the webhook's own strings (MINIAPP_STUDENT_LABEL, PROF_T.profTeacher)
//   C. every callback the Profil card emits is routed by index.ts
//   D. the wiring: live sync on messages AND taps, the sweep on the minute tick + on demand, Bugun emas,
//      the welcome on /start, typed intents before kbHint — and no raw setChatMenuButton left in index.ts
//
//   deno run --allow-read supabase/functions/_bot/testing/ux-quick-wins-check.ts
//
// TEST INFRASTRUCTURE ONLY: no index.ts in this directory (never deployed) and not a *.test.ts (CI's
// `deno test supabase/functions/` does not run it; it needs --allow-read).
import { commandsFor } from "../../telegram-bot-webhook/bot-commands.ts";
import { STAFF_MENU_LABEL, STUDENT_MENU_LABEL } from "../../telegram-bot-webhook/menu-button.ts";
import { parseProfAction, profileRows, type ProfLabels } from "../../telegram-bot-webhook/profile-tabs.ts";

const src = (await Deno.readTextFile(new URL("../../telegram-bot-webhook/index.ts", import.meta.url))).replace(/\r\n/g, "\n");
let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures++;
};

// ── A. advertised commands are handled ──
const handled = (cmd: string): boolean =>
  src.includes(`cmd === "/${cmd}"`) || src.includes(`"/${cmd}"`) || (cmd === "start" && src.includes(`text === "/start"`));
for (const role of ["student", "teacher", "admin"] as const) {
  for (const c of commandsFor(role, "uz")) check(handled(c.command), `A ${role} /${c.command} is handled in index.ts`);
}

// ── B. labels ──
const labelBlock = /const MINIAPP_STUDENT_LABEL: Record<Locale, string> = \{([\s\S]*?)\};/.exec(src)?.[1] ?? "";
for (const l of ["uz", "ru", "en"] as const) {
  check(labelBlock.includes(`${l}: "${STUDENT_MENU_LABEL[l]}"`), `B student ☰ label (${l}) = index.ts MINIAPP_STUDENT_LABEL`);
}
const profTeacher = [...src.matchAll(/profGroup: "[^"]*", profTeacher: "([^"]*)"/g)].map((m) => m[1]);
check(
  profTeacher.length === 3 &&
    profTeacher.every((t, i) => STAFF_MENU_LABEL[(["uz", "ru", "en"] as const)[i]] === `📝 ${t}`),
  `B staff ☰ label = "📝 " + PROF_T.profTeacher (${profTeacher.join(" / ")})`,
);

// ── C. Profil callbacks are routed ──
const L: ProfLabels = { card: "c", stats: "s", badges: "b", group: "g", settings: "x", editName: "n", lang: "l" };
const web: [Record<string, unknown>, Record<string, unknown>] = [{ text: "r", url: "https://t.me/x" }, { text: "o", url: "https://t.me/y" }];
const datas = new Set<string>();
for (const v of ["card", "stats", "badges", "group"] as const) {
  for (const c of profileRows(v, L, web as never).flat()) {
    const d = (c as { callback_data?: string }).callback_data;
    if (d) datas.add(d);
  }
}
for (const d of datas) {
  const [prefix, action] = d.split(":");
  const ok = prefix === "prof"
    ? (parseProfAction(action) !== null || (action === "lang" && src.includes(`action === "lang"`)) ||
      (action === "settings" && src.includes(`action === "settings"`)))
    : (prefix === "name" && src.includes(`data.startsWith("name:")`) && src.includes(`action === "edit"`));
  check(ok, `C callback ${d} is routed`);
}

// ── D. wiring ──
check(!/tgApi\("setChatMenuButton"/.test(src), "D no raw setChatMenuButton left in index.ts (all through menu-button.ts)");
check(/syncMenuLive\(admin, msg\.chat\.id, menuSyncOpts\(persona, locale\)\)/.test(src), "D live ☰ sync on private messages");
check(/await handleCallback\(admin, cq\);[\s\S]{0,900}syncMenuLive\(admin, Number\(cq\.message\.chat\.id\)/.test(src), "D live ☰ re-sync on inline taps (after the reply)");
check(/action === "sweep_pending"[\s\S]{0,700}scheduleMenuSweepTick\(adminC, \{ base: MINIAPP_BASE \}\)/.test(src), "D sweep rides the minute tick");
check(/action === "menu_button_sweep"[\s\S]{0,400}runMenuSweepTick\(adminC, \{ base: MINIAPP_BASE, restart: body\.restart === true \}\)/.test(src), "D on-demand sweep action");
check(/if \(data === "ack:not_today"\) \{[\s\S]{0,300}handleNotToday\(/.test(src), "D Bugun emas → handleNotToday");
check((src.match(/await studentWelcome\(admin, msg\.chat\.id, profileForLocale, locale\)/g) ?? []).length === 2, "D welcome on a bare /start and a typed Start (never on a /start <arg> deep link)");
check(/typedIntent\(text\)[\s\S]{0,400}T\[locale\]\.kbHint/.test(src), "D typed intents run before kbHint");
check(/const pv = parseProfAction\(action\);[\s\S]{0,700}showProfileView\(/.test(src), "D Profil tabs edit in place");

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
if (failures) Deno.exit(1);
