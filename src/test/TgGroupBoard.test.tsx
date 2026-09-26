import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import uzLocale from "@/i18n/locales/uz.json";
import ruLocale from "@/i18n/locales/ru.json";
import enLocale from "@/i18n/locales/en.json";

// The board calls ONE edge function; everything else is rendering. Mock just that call.
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: h.invoke } } }));

import i18n from "@/i18n";
import TgGroupBoard from "@/pages/TgGroupBoard";

// The Uzbek strings exactly as they were hard-coded in TgGroupBoard.tsx before i18n (ASCII
// apostrophes, emoji, casing and punctuation included). The Uzbek board must not change by a byte.
const ORIGINAL_UZ = {
  title: "Guruh reytingi",
  openInTelegram: "Bu sahifani Telegram bot ichidagi <b>📊 Guruh reytingi</b> tugmasi orqali oching.",
  loadError: "Ruxsat yo'q yoki xatolik",
  noGroups: "Guruh topilmadi.",
  empty: "Hali ma'lumot yo'q",
  statActive: "Faol",
  statCompletion: "Tugallanish",
  statBadges: "Nishon",
  statPending: "Kutilmoqda",
  weekly: "🔥 SHU HAFTA",
  allTime: "🏆 UMUMIY TOP",
  shareHint: "Skrinshot qiling va guruhga ulashing",
};
const UZ_VISIBLE = [
  "Guruh reytingi", "Faol", "Tugallanish", "Nishon", "Kutilmoqda",
  "🔥 SHU HAFTA", "🏆 UMUMIY TOP", "Hali ma'lumot yo'q", "Skrinshot qiling va guruhga ulashing",
];

const BOARD = {
  role: "teacher",
  groups: [{
    group_id: "g1", group_name: "5.0 · A", tier_name: null, teacher_name: "Ustoz",
    stats: {
      total_students: 30, active_students: 12, badges_earned: 7, avg_completion_pct: 41,
      homework_submitted: 20, homework_avg_score: 8.5, pending_homework: 3, total_xp: 5000,
    },
    weekly: [], // → the empty-board text
    alltime: [{ board: "alltime", rank: 1, first_name: "Ali", last_initial: "V", xp: 1200, level: 4, current_streak: 2 }],
  }],
};

type TgWindow = Window & { Telegram?: unknown };
function inTelegram() {
  (window as TgWindow).Telegram = { WebApp: { initData: "query_id=x&user=%7B%22id%22%3A1%7D&hash=y", ready() {}, expand() {} } };
}

beforeEach(() => {
  h.invoke.mockReset();
  delete (window as TgWindow).Telegram;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as TgWindow).Telegram;
  document.head.querySelectorAll('script[src*="telegram-web-app"]').forEach((s) => s.remove());
});

describe("TgGroupBoard locale contract", () => {
  it("keeps the Uzbek strings byte-identical to the original hard-coded ones", () => {
    expect(uzLocale.miniapp.groupBoard).toEqual(ORIGINAL_UZ);
    expect(uzLocale.miniapp.retry).toBe("Qayta urinish"); // the retry button reuses miniapp.retry
  });

  it("has the same keys, non-empty, in uz/ru/en — and the bold button markup in every language", () => {
    const keys = Object.keys(ORIGINAL_UZ).sort();
    for (const loc of [uzLocale, ruLocale, enLocale]) {
      const gb = loc.miniapp.groupBoard as Record<string, string>;
      expect(Object.keys(gb).sort()).toEqual(keys);
      for (const k of keys) expect(gb[k].trim().length).toBeGreaterThan(0);
      expect(gb.openInTelegram).toMatch(/<b>📊 [^<]+<\/b>/);
    }
  });

  it("keeps the queue-truncation placeholders identical across languages", () => {
    const ph = (s: string) => (s.match(/\{\{\w+\}\}/g) || []).sort();
    const uz = ph(uzLocale.profile.tQueueTruncated);
    expect(uz).toEqual(["{{hidden}}", "{{shown}}", "{{total}}"]);
    expect(ph(ruLocale.profile.tQueueTruncated)).toEqual(uz);
    expect(ph(enLocale.profile.tQueueTruncated)).toEqual(uz);
    for (const loc of [uzLocale, ruLocale, enLocale]) expect(loc.profile.tQueueRefresh.length).toBeGreaterThan(0);
  });
});

describe("TgGroupBoard rendering", () => {
  it("renders the exact original Uzbek text in uz", async () => {
    await i18n.changeLanguage("uz");
    inTelegram();
    h.invoke.mockResolvedValue({ data: BOARD, error: null });
    render(<TgGroupBoard />);
    expect(await screen.findByText("5.0 · A")).toBeInTheDocument();
    for (const s of UZ_VISIBLE) expect(screen.getByText(s)).toBeInTheDocument();
  });

  it.each([
    ["ru", ["Рейтинг группы", "Активные", "Прогресс", "Награды", "На проверке", "🔥 ЭТА НЕДЕЛЯ", "🏆 ОБЩИЙ ТОП", "Пока нет данных", "Сделайте скриншот и поделитесь в группе"]],
    ["en", ["Group board", "Active", "Completion", "Badges", "Pending", "🔥 THIS WEEK", "🏆 ALL-TIME TOP", "No data yet", "Take a screenshot and share it with the group"]],
  ])("renders %s with no Uzbek left over", async (lng, expected) => {
    await i18n.changeLanguage(lng);
    inTelegram();
    h.invoke.mockResolvedValue({ data: BOARD, error: null });
    render(<TgGroupBoard />);
    expect(await screen.findByText("5.0 · A")).toBeInTheDocument();
    for (const s of expected) expect(screen.getByText(s)).toBeInTheDocument();
    for (const s of UZ_VISIBLE) expect(screen.queryByText(s)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/miniapp\./); // no raw i18n key leaked
  });

  it("shows the translated error + retry when the edge function refuses", async () => {
    await i18n.changeLanguage("uz");
    inTelegram();
    h.invoke.mockResolvedValue({ data: null, error: new Error("401") });
    render(<TgGroupBoard />);
    expect(await screen.findByText("Ruxsat yo'q yoki xatolik")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Qayta urinish" })).toBeInTheDocument();

    await act(async () => { await i18n.changeLanguage("en"); });
    expect(screen.getByText("No access, or something went wrong")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("outside Telegram: the open-via-button hint keeps its bold button label", async () => {
    await i18n.changeLanguage("uz");
    vi.useFakeTimers();
    render(<TgGroupBoard />);
    const script = document.head.querySelector('script[src*="telegram-web-app"]');
    expect(script).not.toBeNull();
    await act(async () => { script!.dispatchEvent(new Event("error")); });
    await act(async () => { vi.advanceTimersByTime(5000); });
    const bold = screen.getByText("📊 Guruh reytingi");
    expect(bold.tagName).toBe("B");
    expect(bold.parentElement!.textContent).toBe("Bu sahifani Telegram bot ichidagi 📊 Guruh reytingi tugmasi orqali oching.");
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
