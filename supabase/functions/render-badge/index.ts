// Badge renderer (Option A): Satori (HTML→SVG) + resvg-wasm (SVG→PNG).
// Edge-native, no external image API, no per-image cost. Reads the frozen
// presets from _shared/badge-presets.ts; the only dynamic inputs are the
// student's name (always) and the module number (module_complete only).
//
// POST { key, name, moduleNo?, user_id?, dm?:boolean }  (x-internal-secret guarded)
//   → renders a 1080×1920 PNG, uploads to module-shares/badges/, returns { url }.
//   → if dm && the user has a telegram_id, also sends it as a photo with caption.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import satori from "https://esm.sh/satori@0.10.13";
import { initWasm, Resvg } from "https://esm.sh/@resvg/resvg-wasm@2.6.2";
import { resolveBadge } from "../_shared/badge-presets.ts";
import { sendTelegram } from "../_shared/telegram-send.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-internal-secret",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// ---- one-time cold-start init (fonts + wasm), cached at module scope ----
let ready: Promise<{ fonts: any[] }> | null = null;
const FONT = (w: number) =>
  `https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.16/files/inter-latin-${w}-normal.woff`;

async function boot() {
  if (!ready) {
    ready = (async () => {
      await initWasm(fetch("https://esm.sh/@resvg/resvg-wasm@2.6.2/index_bg.wasm"));
      const [r4, r7] = await Promise.all([FONT(400), FONT(700)].map((u) => fetch(u).then((r) => r.arrayBuffer())));
      return {
        fonts: [
          { name: "Inter", data: r4, weight: 400, style: "normal" },
          { name: "Inter", data: r7, weight: 700, style: "normal" },
        ],
      };
    })();
  }
  return ready;
}

// Render dimensions (9:16). 720×1280 keeps memory within the edge limit while
// staying crisp for Instagram stories. k scales the 1080-based layout numbers.
const W = 540, H = 960, k = W / 1080;
const px = (n: number) => Math.round(n * k);
// Keep emoji overhead to exactly one (the monolith glyph); strip from all text.
const noEmoji = (s: string) => s.replace(/\p{Extended_Pictographic}️?/gu, "").replace(/\s+/g, " ").trim();

// Color emoji via Twemoji (Satori calls this for each emoji glyph).
const emojiCache = new Map<string, string>();
async function loadEmoji(segment: string): Promise<string> {
  const cp = Array.from(segment).map((c) => c.codePointAt(0)!.toString(16)).filter((h) => h !== "fe0f").join("-");
  if (emojiCache.has(cp)) return emojiCache.get(cp)!;
  const svg = await fetch(`https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/${cp}.svg`).then((r) => r.ok ? r.text() : "");
  const uri = svg ? `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}` : "";
  emojiCache.set(cp, uri);
  return uri;
}

// Tiny element helper for Satori's React-element tree.
const el = (type: string, style: Record<string, unknown>, children?: any): any => ({
  type, props: { style, ...(children !== undefined ? { children } : {}) },
});
const text = (s: string, style: Record<string, unknown>) => el("div", { display: "flex", ...style }, s);

function buildTree(c: any) {
  const gold = c.gold;
  const ground = gold
    ? "radial-gradient(90% 46% at 50% 20%, #4A3A14 0%, #1E1A0C 52%, #0F0D06 100%)"
    : "radial-gradient(90% 46% at 50% 20%, #16453C 0%, #0C231F 52%, #08100F 100%)";
  const monoBg = gold
    ? "linear-gradient(150deg,#E6C878,#B8860B 60%,#8A6508)"
    : "linear-gradient(150deg,#2FB39B 0%,#177564 55%,#0E4A40 100%)";
  const monoGlow = gold ? "0 0 160px 24px rgba(216,180,90,.42)" : "0 0 160px 24px rgba(47,179,155,.32)";
  const ebColor = gold ? "#D8B45A" : "#7FC7B5";

  return el("div", {
    width: W, height: H, display: "flex", flexDirection: "column", alignItems: "center",
    background: ground, fontFamily: "Inter", padding: `${px(150)}px ${px(90)}px ${px(120)}px`,
  }, [
    // monolith
    el("div", {
      width: px(300), height: px(300), borderRadius: px(76), background: monoBg, display: "flex",
      alignItems: "center", justifyContent: "center", boxShadow: monoGlow, marginBottom: px(70),
    }, text(c.glyph, { fontSize: px(150), lineHeight: 1 })),
    // eyebrow
    text(c.eyebrow, { fontSize: px(26), letterSpacing: px(10), color: ebColor, fontWeight: 700, marginBottom: px(14) }),
    // title
    text(noEmoji(c.title), { fontSize: px(100), fontWeight: 700, color: "#E9C971", letterSpacing: -1, marginBottom: px(18), textAlign: "center" }),
    // rule
    el("div", { width: px(120), height: px(5), borderRadius: 3, background: "#D8B45A", marginBottom: px(44) }),
    // name
    text(c.name, { fontSize: px(60), fontWeight: 700, color: "#FFFFFF", marginBottom: px(22) }),
    // lines
    text(noEmoji(c.lnTop), { fontSize: px(34), color: "#A9CCC2", marginBottom: px(8) }),
    text(noEmoji(c.lnBold), { fontSize: px(37), fontWeight: 700, color: "#E8F5F0", marginBottom: px(60), textAlign: "center" }),
    // chip
    el("div", {
      display: "flex", border: "2px solid rgba(216,180,90,.4)", background: "rgba(216,180,90,.08)",
      borderRadius: 999, padding: `${px(16)}px ${px(36)}px`,
    }, text(noEmoji(c.chip), { fontSize: px(30), color: "#E9C971", fontWeight: 700 })),
    // spacer
    el("div", { display: "flex", flexGrow: 1 }),
    // footer
    text("AI Creators", { fontSize: px(34), fontWeight: 700, color: "#CFE8DF", marginBottom: px(10) }),
    text(c.footer, { fontSize: px(22), letterSpacing: px(4), color: "#5E8B7F" }),
  ]);
}

// Split the emoji glyph off the title/lines so the big monolith glyph is clean.
function pickGlyph(chip: string): string {
  const m = Array.from(chip).find((ch) => /\p{Extended_Pictographic}/u.test(ch));
  return m || "✨";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.headers.get("x-internal-secret") !== Deno.env.get("INTERNAL_FN_SECRET")) return json({ error: "forbidden" }, 403);

  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const { key, name, moduleNo, user_id, dm } = body;
  if (!key || !name) return json({ error: "key and name required" }, 400);

  const card = resolveBadge(key, { name, moduleNo });
  if (!card) return json({ error: "unknown key" }, 400);
  (card as any).glyph = pickGlyph(card.chip);

  try {
    const { fonts } = await boot();
    const svg = await satori(buildTree(card), { width: W, height: H, fonts, loadAdditionalAsset: async (code: string, seg: string) => code === "emoji" ? await loadEmoji(seg) : seg });
    const png = new Resvg(svg).render().asPng();

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const path = `badges/${user_id || "preview"}/${key}${moduleNo ? "-" + moduleNo : ""}.png`;
    await admin.storage.from("module-shares").upload(path, png, { upsert: true, contentType: "image/png" });
    const { data: pub } = admin.storage.from("module-shares").getPublicUrl(path);
    const url = pub.publicUrl;

    if (dm && user_id) {
      const { data: prof } = await admin.from("profiles").select("telegram_id").eq("id", user_id).maybeSingle();
      if (prof?.telegram_id) {
        // Earned badge DM — route through the shared sender so a non-delivery is a classified
        // telegram_send_failed row in admin_actions, not a silently-dropped fetch.
        await sendTelegram(
          Deno.env.get("TELEGRAM_BOT_TOKEN") || "",
          "sendPhoto",
          { chat_id: Number(prof.telegram_id), photo: url, caption: card.caption },
          { admin, purpose: "badge_award_dm", recipientId: prof.telegram_id },
        );
      }
    }
    return json({ ok: true, url });
  } catch (e) {
    console.error("render-badge", e);
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
