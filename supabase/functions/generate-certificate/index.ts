// Generates a minimal PDF certificate (single page, A4 landscape) using pdf-lib.
// Returns the PDF bytes directly with Content-Type: application/pdf.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { PDFDocument, rgb, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  let body: { user_id?: string; course_id?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400, headers: corsHeaders });
  }
  const { user_id, course_id } = body;
  if (!user_id || !course_id) {
    return new Response(JSON.stringify({ error: "user_id and course_id required" }), {
      status: 400,
      headers: corsHeaders,
    });
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const { data: profile } = await admin
    .from("profiles")
    .select("name, last_name, preferred_locale")
    .eq("id", user_id)
    .maybeSingle();
  const { data: course } = await admin.from("courses").select("title").eq("id", course_id).maybeSingle();

  const fullName = [profile?.name, profile?.last_name].filter(Boolean).join(" ") || "Student";
  const courseTitle = course?.title || "AI Creators";
  const locale = (profile?.preferred_locale || "uz").toLowerCase();
  const date = localizedDate(locale);

  const heading =
    locale === "ru" ? "СЕРТИФИКАТ" : locale === "en" ? "CERTIFICATE" : "SERTIFIKAT";
  const sub =
    locale === "ru"
      ? "О завершении курса"
      : locale === "en"
      ? "of Course Completion"
      : "kursni tamomlagani uchun";
  const awarded =
    locale === "ru" ? "награждается" : locale === "en" ? "is awarded to" : "topshiriladi";
  const finished =
    locale === "ru"
      ? "за успешное завершение курса"
      : locale === "en"
      ? "for successfully completing the course"
      : "kursni muvaffaqiyatli tamomlagani uchun";
  const dateLabel = locale === "ru" ? "Дата" : locale === "en" ? "Date" : "Sana";

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([842, 595]); // A4 landscape pt
  const { width, height } = page.getSize();

  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const helvObl = await pdf.embedFont(StandardFonts.HelveticaOblique);

  // Outer border
  const ink = rgb(0.08, 0.1, 0.18);
  const accent = rgb(0.45, 0.32, 0.78);
  page.drawRectangle({ x: 24, y: 24, width: width - 48, height: height - 48, borderColor: ink, borderWidth: 2 });
  page.drawRectangle({ x: 36, y: 36, width: width - 72, height: height - 72, borderColor: accent, borderWidth: 0.6 });

  // Brand wordmark
  const brand = "AI CREATORS";
  const brandSize = 14;
  const brandWidth = helvBold.widthOfTextAtSize(brand, brandSize);
  page.drawText(brand, {
    x: (width - brandWidth) / 2,
    y: height - 80,
    size: brandSize,
    font: helvBold,
    color: accent,
  });

  // Heading
  const headSize = 48;
  const headWidth = helvBold.widthOfTextAtSize(heading, headSize);
  page.drawText(heading, {
    x: (width - headWidth) / 2,
    y: height - 160,
    size: headSize,
    font: helvBold,
    color: ink,
  });

  // Subheading
  const subSize = 18;
  const subWidth = helvObl.widthOfTextAtSize(sub, subSize);
  page.drawText(sub, {
    x: (width - subWidth) / 2,
    y: height - 200,
    size: subSize,
    font: helvObl,
    color: ink,
  });

  // "is awarded to"
  const awSize = 14;
  const awWidth = helv.widthOfTextAtSize(awarded, awSize);
  page.drawText(awarded, { x: (width - awWidth) / 2, y: height - 260, size: awSize, font: helv, color: ink });

  // Name
  const nameSize = 36;
  const nameWidth = helvBold.widthOfTextAtSize(fullName, nameSize);
  page.drawText(fullName, { x: (width - nameWidth) / 2, y: height - 310, size: nameSize, font: helvBold, color: accent });

  // Underline under name
  const lineW = Math.max(nameWidth + 80, 320);
  page.drawLine({
    start: { x: (width - lineW) / 2, y: height - 320 },
    end: { x: (width - lineW) / 2 + lineW, y: height - 320 },
    color: ink,
    thickness: 0.6,
  });

  // Course context
  const ctxSize = 14;
  const ctxWidth = helv.widthOfTextAtSize(finished, ctxSize);
  page.drawText(finished, { x: (width - ctxWidth) / 2, y: height - 360, size: ctxSize, font: helv, color: ink });

  const titleSize = 22;
  const titleWidth = helvBold.widthOfTextAtSize(courseTitle, titleSize);
  page.drawText(courseTitle, { x: (width - titleWidth) / 2, y: height - 395, size: titleSize, font: helvBold, color: ink });

  // Date bottom-left, signature bottom-right
  page.drawText(`${dateLabel}: ${date}`, { x: 80, y: 80, size: 12, font: helv, color: ink });
  page.drawLine({ start: { x: width - 240, y: 95 }, end: { x: width - 80, y: 95 }, color: ink, thickness: 0.5 });
  page.drawText("AI Creators Team", { x: width - 220, y: 78, size: 11, font: helvObl, color: ink });

  const bytes = await pdf.save();
  return new Response(bytes, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/pdf" },
  });
});
