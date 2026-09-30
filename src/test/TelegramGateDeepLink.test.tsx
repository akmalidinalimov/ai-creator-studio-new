import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

// TelegramGate with a mocked Mini App context and a mocked supabase client: the deep link a watch button opens
// must survive BOTH the fresh sign-in (tg-miniapp-auth) and the cached-session fast re-open, and the button's
// open signal must be reported once, with src/ref stripped from the URL.
const C = "0b6f4e1c-2a3d-4e5f-8a9b-0c1d2e3f4a5b";
const L = "9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";

const h = vi.hoisted(() => ({
  initData: "" as string | null | undefined,
  session: null as null | { user: { id: string } },
  profileTgId: 0 as number | null,
  invoke: vi.fn(),
  setSession: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/lib/telegram/MiniAppContext", () => ({
  useMiniApp: () => ({ isMiniApp: typeof h.initData === "string", webApp: null, initData: h.initData }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("@/pages/TgNotLinked", () => ({ default: () => <div>NOT_LINKED</div> }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: h.session } }),
      setSession: (...a: unknown[]) => { h.setSession(...a); return Promise.resolve({ data: {}, error: null }); },
      signOut: () => { h.signOut(); return Promise.resolve({}); },
    },
    from: () => {
      const q: any = {
        select: () => q,
        eq: () => q,
        maybeSingle: () => Promise.resolve({ data: { telegram_id: h.profileTgId }, error: null }),
      };
      return q;
    },
    functions: { invoke: (...a: unknown[]) => h.invoke(...a) },
  },
}));

import { TelegramGate } from "@/lib/telegram/TelegramGate";

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TelegramGate>
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </TelegramGate>
    </MemoryRouter>,
  );
}

const initFor = (tgId: number, startParam?: string) =>
  new URLSearchParams({ user: JSON.stringify({ id: tgId }), auth_date: "1", hash: "h", ...(startParam ? { start_param: startParam } : {}) }).toString();

beforeEach(() => {
  h.invoke.mockReset();
  h.setSession.mockReset();
  h.signOut.mockReset();
  h.session = null;
  h.profileTgId = null;
  try { window.sessionStorage.clear(); } catch { /* ignore */ }
});
afterEach(() => cleanup());

describe("TelegramGate — fresh sign-in", () => {
  it("keeps a cold watch-button deep link, strips src, and sends the open with the sign-in", async () => {
    h.initData = initFor(7);
    h.invoke.mockResolvedValue({ data: { session: { access_token: "a", refresh_token: "r" }, target_path: "/dashboard" }, error: null });
    renderAt(`/lesson/${C}/${L}?src=daily_reminder`);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(`/lesson/${C}/${L}`));
    expect(h.invoke).toHaveBeenCalledTimes(1);
    const [fn, opts] = h.invoke.mock.calls[0];
    expect(fn).toBe("tg-miniapp-auth");
    expect(opts.body.open).toEqual({ src: "daily_reminder", ref: null, path: `/lesson/${C}/${L}` });
  });

  it("the root goes to the server's target_path (staff → /tg/teacher), no open signal", async () => {
    h.initData = initFor(7);
    h.invoke.mockResolvedValue({ data: { session: { access_token: "a", refresh_token: "r" }, target_path: "/tg/teacher" }, error: null });
    renderAt("/");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/tg/teacher"));
    expect(h.invoke.mock.calls[0][1].body.open).toBeUndefined();
  });

  it("a direct-link start_param at the root lands on /continue/<course>", async () => {
    h.initData = initFor(7, `c_${C}__daily_task`);
    h.invoke.mockResolvedValue({ data: { session: { access_token: "a", refresh_token: "r" }, target_path: `/continue/${C}` }, error: null });
    renderAt("/");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(`/continue/${C}`));
    expect(h.invoke.mock.calls[0][1].body.open).toEqual({ src: "daily_task", ref: null, path: `/continue/${C}` });
  });

  it("not_linked shows the not-linked screen", async () => {
    h.initData = initFor(7);
    h.invoke.mockResolvedValue({ data: { error: "not_linked" }, error: null });
    renderAt(`/continue/${C}?src=daily_reminder`);
    await waitFor(() => expect(screen.getByText("NOT_LINKED")).toBeInTheDocument());
  });
});

describe("TelegramGate — cached session (fast re-open)", () => {
  it("stays on the deep link, reports the open once (mode:'open'), strips src/ref", async () => {
    h.initData = initFor(7);
    h.session = { user: { id: "u1" } };
    h.profileTgId = 7;
    h.invoke.mockResolvedValue({ data: { ok: true }, error: null });
    renderAt(`/continue/${C}?src=nudge_3d&ref=${L}`);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(`/continue/${C}`));
    expect(h.setSession).not.toHaveBeenCalled();
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke.mock.calls[0][1].body).toMatchObject({ mode: "open", src: "nudge_3d", ref: L, path: `/continue/${C}` });

    // A reload of the same URL in the same Mini App session does not count the tap again.
    cleanup();
    renderAt(`/continue/${C}?src=nudge_3d&ref=${L}`);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(`/continue/${C}`));
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });

  it("a start_param at the root is honoured (Landing would otherwise send it to /dashboard)", async () => {
    h.initData = initFor(7, `c_${C}`);
    h.session = { user: { id: "u1" } };
    h.profileTgId = 7;
    renderAt("/");
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(`/continue/${C}`));
    expect(h.invoke).not.toHaveBeenCalled(); // no src → no open signal
  });

  it("a session that belongs to another Telegram user is dropped and re-authed", async () => {
    h.initData = initFor(7);
    h.session = { user: { id: "u1" } };
    h.profileTgId = 99;
    h.invoke.mockResolvedValue({ data: { session: { access_token: "a", refresh_token: "r" }, target_path: "/dashboard" }, error: null });
    renderAt(`/lesson/${C}/${L}`);
    await waitFor(() => expect(h.setSession).toHaveBeenCalled());
    expect(h.signOut).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(`/lesson/${C}/${L}`));
  });
});

describe("TelegramGate — web mode", () => {
  it("is a strict no-op outside Telegram", async () => {
    h.initData = null;
    renderAt(`/lesson/${C}/${L}?src=daily_reminder`);
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe(`/lesson/${C}/${L}?src=daily_reminder`));
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
