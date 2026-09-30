// Run: deno test supabase/functions/teacher-daily-digest/buttons.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { appReportRows, backlogCount, legacyReportRows, REPORT_GRADE_LABEL, REPORT_HOME_LABEL } from "./buttons.ts";
import { teacherAppButton, TEACHER_GRADE_PATH, TEACHER_HOME_PATH } from "../_shared/teacher-miniapp.ts";
import { DEFAULT_MINIAPP_BASE } from "../_shared/miniapp-button.ts";

const URL0 = "https://aicreator.academy/auth/magic?t=abc";

Deno.test("flag off: today's single magic-link button, byte-identical", () => {
  assertEquals(legacyReportRows(URL0), [[{ text: "👤 Profil / Profile", url: URL0 }]]);
  assertEquals(appReportRows({ grade: null, home: null }), null);
});

Deno.test("flag on: 📝 Baholash (N) opens the queue, 👤 Profil the teacher app — both web_app, tracked", async () => {
  const on = { on: true, watch: true };
  const grade = await teacherAppButton({ text: REPORT_GRADE_LABEL.uz(6), flag: on, chatId: 42, path: TEACHER_GRADE_PATH, src: "teacher_report", fn: "t" });
  const home = await teacherAppButton({ text: REPORT_HOME_LABEL.uz, flag: on, chatId: 42, path: TEACHER_HOME_PATH, src: "teacher_report", fn: "t" });
  assertEquals(appReportRows({ grade, home }), [
    [{ text: "📝 Baholash (6)", web_app: { url: `${DEFAULT_MINIAPP_BASE}/tg/teacher/grade?src=teacher_report` } }],
    [{ text: "👤 Profil", web_app: { url: `${DEFAULT_MINIAPP_BASE}/tg/teacher?src=teacher_report` } }],
  ]);
  // Nothing waiting → only the home button.
  assertEquals(appReportRows({ grade: null, home }), [[home!]]);
});

Deno.test("backlogCount: only a positive number shows the 📝 button", () => {
  assertEquals(backlogCount(6), 6);
  assertEquals(backlogCount("12"), 12);
  assertEquals(backlogCount(0), 0);
  assertEquals(backlogCount(null), 0);
  assertEquals(backlogCount(-3), 0);
  assertEquals(backlogCount("abc"), 0);
  assertEquals(REPORT_GRADE_LABEL.ru(3), "📝 Оценить (3)");
  assertEquals(REPORT_GRADE_LABEL.en(1), "📝 Grade (1)");
});
