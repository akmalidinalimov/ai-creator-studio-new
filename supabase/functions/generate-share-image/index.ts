// Generates a 1080x1080 PNG shareable image for course completion.
// Uses pdf-lib to render a PDF page at 1080x1080, then converts via @cf-wasm/resvg-js.
// Output is a PNG (≤500KB) suitable for Instagram/Telegram stories.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { Resvg, initWasm } from "https://esm.sh/@resvg/resvg-wasm@2.6.2";

let wasmReady: Promise<void> | null = null;
async function ensureWasm() {
  if (!wasmReady) {
    wasmReady = (async () => {
      const wasm = await fetch("https://esm.sh/@resvg/resvg-wasm@2.6.2/index_bg.wasm").then((r) => r.arrayBuffer());
      await initWasm(wasm);
    })();
  }
  return wasmReady;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function localizedDate(locale: string): string {
  const d = new Date();
  try {
    if (locale === "uz") {
      const dd = String(d.getDate()).padStart(2, "0");
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      return `${dd}.${mm}.${d.getFullYear()}`;
    }
    const lng = locale === "ru" ? "ru-RU" : "en-US";
    return new Intl.DateTimeFormat(lng, { year: "numeric", month: "long", day: "numeric" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

function buildSvg(opts: {
  fullName: string;
  courseTitle: string;
  date: string;
  headline: string;
  subtitle: string;
  dateLabel: string;
}): string {
  const W = 1080;
  const safeName = escapeXml(opts.fullName);
  const safeCourse = escapeXml(opts.courseTitle);
  // Truncate very long names to avoid overflow
  const displayName = safeName.length > 28 ? safeName.slice(0, 27) + "…" : safeName;
  const nameSize = displayName.length > 22 ? 64 : 84;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="0 0 ${W} ${W}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0F0A1E"/>
      <stop offset="55%" stop-color="#1B1138"/>
      <stop offset="100%" stop-color="#2D1B69"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="40%" r="55%">
      <stop offset="0%" stop-color="#7A52C8" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#7A52C8" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#C8A24A"/>
      <stop offset="100%" stop-color="#F2D27F"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${W}" fill="url(#bg)"/>
  <rect width="${W}" height="${W}" fill="url(#glow)"/>
  <rect x="40" y="40" width="${W - 80}" height="${W - 80}" fill="none" stroke="url(#accent)" stroke-width="3" rx="24"/>
  <rect x="58" y="58" width="${W - 116}" height="${W - 116}" fill="none" stroke="#C8A24A" stroke-opacity="0.25" stroke-width="1" rx="18"/>

  <!-- Wordmark -->
  <text x="${W / 2}" y="170" text-anchor="middle" fill="url(#accent)"
    font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="34" letter-spacing="8">AI CREATORS</text>

  <!-- Decorative star -->
  <g transform="translate(${W / 2}, 250)" fill="url(#accent)">
    <polygon points="0,-22 6,-7 22,-7 9,3 14,18 0,9 -14,18 -9,3 -22,-7 -6,-7"/>
  </g>

  <!-- Headline -->
  <text x="${W / 2}" y="380" text-anchor="middle" fill="#FFFFFF"
    font-family="Helvetica, Arial, sans-serif" font-weight="800" font-size="92">${escapeXml(opts.headline)}</text>

  <!-- Subtitle -->
  <text x="${W / 2}" y="450" text-anchor="middle" fill="#D6CCEF"
    font-family="Helvetica, Arial, sans-serif" font-weight="400" font-size="30">${escapeXml(opts.subtitle)}</text>

  <!-- Student name -->
  <text x="${W / 2}" y="600" text-anchor="middle" fill="url(#accent)"
    font-family="Helvetica, Arial, sans-serif" font-weight="700" font-size="${nameSize}">${displayName}</text>

  <!-- Underline -->
  <line x1="${W / 2 - 220}" y1="630" x2="${W / 2 + 220}" y2="630" stroke="url(#accent)" stroke-width="2"/>

  <!-- Course title -->
  <text x="${W / 2}" y="720" text-anchor="middle" fill="#FFFFFF"
    font-family="Helvetica, Arial, sans-serif" font-weight="600" font-size="42">${safeCourse}</text>

  <!-- Date -->
  <text x="${W / 2}" y="930" text-anchor="middle" fill="#A89BCC"
    font-family="Helvetica, Arial, sans-serif" font-weight="400" font-size="26">${escapeXml(opts.dateLabel)}: ${escapeXml(opts.date)}</text>

  <!-- Footer mark -->
  <text x="${W / 2}" y="1000" text-anchor="middle" fill="#7A6BAE"
    font-family="Helvetica, Arial, sans-serif" font-weight="400" font-size="20" letter-spacing="3">aicreators.uz</text>
</svg>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  let body: { user_id?: string; course_id?: string; locale?: string };
  try { body = await req.json(); } catch { return new Response("Bad JSON", { status: 400, headers: corsHeaders }); }
  const { user_id, course_id } = body;
  if (!user_id || !course_id) {
    return new Response(JSON.stringify({ error: "user_id and course_id required" }), { status: 400, headers: corsHeaders });
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: profile } = await admin.from("profiles").select("name, last_name, preferred_locale").eq("id", user_id).maybeSingle();
  const { data: course } = await admin.from("courses").select("title").eq("id", course_id).maybeSingle();

  const fullName = [profile?.name, profile?.last_name].filter(Boolean).join(" ") || "Student";
  const courseTitle = course?.title || "AI Creators";
  const locale = (body.locale || profile?.preferred_locale || "uz").toLowerCase();
  const date = localizedDate(locale);

  const headline = locale === "ru" ? "Поздравляем!" : locale === "en" ? "Congrats!" : "Tabriklaymiz!";
  const subtitle = locale === "ru" ? "завершил(а) курс" : locale === "en" ? "completed the course" : "kursni tugatdi";
  const dateLabel = locale === "ru" ? "Дата" : locale === "en" ? "Date" : "Sana";

  const svg = buildSvg({ fullName, courseTitle, date, headline, subtitle, dateLabel });

  try {
    const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1080 } });
    const png = resvg.render().asPng();
    return new Response(png, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "image/png" },
    });
  } catch (e) {
    console.error("share image render failed", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
