// Generates a PDF certificate, uploads to storage bucket "certificates",
// updates certificates.pdf_url, optionally sends Telegram celebration.
// POST { profile_id?: string, certificate_id?: string, send_telegram?: boolean }
// Auth: admin OR the owning student. Returns { pdf_url, serial_no, verification_token }.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { PDFDocument, rgb, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";
import QRCode from "https://esm.sh/qrcode@1.5.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const SITE_URL = (Deno.env.get("SITE_URL") || "https://www.aicreator.academy").replace(/\/$/, "");

function tashkentDate(): string {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit" });
  const parts = fmt.formatToParts(d);
  const y = parts.find(p => p.type === "year")?.value;
  const m = parts.find(p => p.type === "month")?.value;
  const day = parts.find(p => p.type === "day")?.value;
  return `${day}.${m}.${y}`;
}

async function buildPdf(opts: {
  fullName: string;
  courseName: string;
  serialNo: string;
  verificationUrl: string;
  dateStr: string;
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([842, 595]); // A4 landscape
  const { width, height } = page.getSize();

  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const helvObl = await pdf.embedFont(StandardFonts.HelveticaOblique);

  const ink = rgb(0.08, 0.1, 0.18);
  const accent = rgb(0.45, 0.32, 0.78);
  const muted = rgb(0.4, 0.42, 0.5);

  // Borders
  page.drawRectangle({ x: 24, y: 24, width: width - 48, height: height - 48, borderColor: ink, borderWidth: 2 });
  page.drawRectangle({ x: 36, y: 36, width: width - 72, height: height - 72, borderColor: accent, borderWidth: 0.6 });

  // Brand
  const brand = "AI CREATORS";
  const brandSize = 14;
  const brandWidth = helvBold.widthOfTextAtSize(brand, brandSize);
  page.drawText(brand, { x: (width - brandWidth) / 2, y: height - 80, size: brandSize, font: helvBold, color: accent });

  // Heading
  const heading = "SERTIFIKAT  /  CERTIFICATE";
  const headSize = 36;
  const headWidth = helvBold.widthOfTextAtSize(heading, headSize);
  page.drawText(heading, { x: (width - headWidth) / 2, y: height - 150, size: headSize, font: helvBold, color: ink });

  // Sub
  const sub = "Bu hujjat tasdiqlaydi  /  This certifies that";
  const subSize = 14;
  const subWidth = helvObl.widthOfTextAtSize(sub, subSize);
  page.drawText(sub, { x: (width - subWidth) / 2, y: height - 200, size: subSize, font: helvObl, color: muted });

  // Name
  const nameSize = 36;
  const nameWidth = helvBold.widthOfTextAtSize(opts.fullName, nameSize);
  page.drawText(opts.fullName, { x: (width - nameWidth) / 2, y: height - 260, size: nameSize, font: helvBold, color: accent });

  const lineW = Math.max(nameWidth + 80, 360);
  page.drawLine({
    start: { x: (width - lineW) / 2, y: height - 270 },
    end: { x: (width - lineW) / 2 + lineW, y: height - 270 },
    color: ink, thickness: 0.6,
  });

  // Completed
  const ctx = "muvaffaqiyatli tugatdi  /  successfully completed:";
  const ctxSize = 13;
  const ctxWidth = helv.widthOfTextAtSize(ctx, ctxSize);
  page.drawText(ctx, { x: (width - ctxWidth) / 2, y: height - 305, size: ctxSize, font: helv, color: muted });

  // Course name
  const titleSize = 22;
  const titleWidth = helvBold.widthOfTextAtSize(opts.courseName, titleSize);
  page.drawText(opts.courseName, { x: (width - titleWidth) / 2, y: height - 340, size: titleSize, font: helvBold, color: ink });

  // Date
  const dateLabel = `Sana / Date: ${opts.dateStr}`;
  const dateSize = 12;
  const dateWidth = helv.widthOfTextAtSize(dateLabel, dateSize);
  page.drawText(dateLabel, { x: (width - dateWidth) / 2, y: height - 380, size: dateSize, font: helv, color: ink });

  // Serial bottom-left
  page.drawText(opts.serialNo, { x: 60, y: 60, size: 10, font: helvBold, color: muted });
  page.drawText("Serial number", { x: 60, y: 48, size: 8, font: helv, color: muted });

  // Signature placeholder
  page.drawLine({ start: { x: width / 2 - 100, y: 90 }, end: { x: width / 2 + 100, y: 90 }, color: ink, thickness: 0.5 });
  page.drawText("AI Creators Team", { x: width / 2 - 60, y: 72, size: 10, font: helvObl, color: ink });
  page.drawText("Founder", { x: width / 2 - 25, y: 60, size: 8, font: helv, color: muted });

  // QR bottom-right
  try {
    const qrDataUrl: string = await QRCode.toDataURL(opts.verificationUrl, { margin: 0, width: 220 });
    const qrBytes = Uint8Array.from(atob(qrDataUrl.split(",")[1]), c => c.charCodeAt(0));
    const qrImg = await pdf.embedPng(qrBytes);
    const qrSize = 90;
    page.drawImage(qrImg, { x: width - 60 - qrSize, y: 60, width: qrSize, height: qrSize });
    page.drawText("Tekshirish / Verify", { x: width - 60 - qrSize, y: 48, size: 8, font: helv, color: muted });
  } catch (_) { /* ignore QR errors */ }

  return await pdf.save();
}

async function sendTelegramCelebration(admin: any, profile: any, cert: any, pdfUrl: string) {
  if (!BOT_TOKEN || !profile?.telegram_id) return;
  const verifyUrl = `${SITE_URL}/verify/${cert.verification_token}`;
  const name = (profile.name || "").trim() || "do'stim";
  const text =
    `🎉 Tabriklaymiz ${name}!\n\n` +
    `Siz AI Creators kursini muvaffaqiyatli tugatdingiz!\n` +
    `Sertifikatingiz tayyor (№ ${cert.serial_no}).\n\n` +
    `Yuklab olish va ulashish uchun pastdagi tugmani bosing 👇`;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: profile.telegram_id,
      text,
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [{ text: "📥 Yuklab olish", url: pdfUrl }],
          [{ text: "🔗 Ulashish / Verify", url: verifyUrl }],
        ],
      },
    }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Auth
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders });
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const { data: userData } = await userClient.auth.getUser();
    const callerId = userData?.user?.id;
    if (!callerId) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: corsHeaders });
    const { data: roleRow } = await admin.from("user_roles").select("role").eq("user_id", callerId).eq("role", "admin").maybeSingle();
    const isAdmin = !!roleRow;

    const body = await req.json().catch(() => ({}));
    let { profile_id, certificate_id, send_telegram } = body || {};
    if (!profile_id && !certificate_id) profile_id = callerId;

    // Try to find an existing cert; if none and target is the caller, attempt issuance.
    let cert: any = null;
    if (certificate_id) {
      const { data } = await admin.from("certificates").select("*").eq("id", certificate_id).maybeSingle();
      cert = data;
      if (cert) profile_id = cert.profile_id;
    } else {
      const { data } = await admin.from("certificates").select("*").eq("profile_id", profile_id).maybeSingle();
      cert = data;
    }

    if (!cert) {
      // Issue if eligible
      const { data: issuedId } = await admin.rpc("issue_certificate_if_eligible", { _profile_id: profile_id });
      if (issuedId) {
        const { data } = await admin.from("certificates").select("*").eq("id", issuedId).maybeSingle();
        cert = data;
      }
    }

    if (!cert) return new Response(JSON.stringify({ error: "not_eligible" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    if (!isAdmin && cert.profile_id !== callerId) {
      return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Profile (for telegram)
    const { data: profile } = await admin.from("profiles").select("name, last_name, telegram_id, preferred_locale").eq("id", cert.profile_id).maybeSingle();

    const verifyUrl = `${SITE_URL}/verify/${cert.verification_token}`;
    const dateStr = tashkentDate();
    const pdfBytes = await buildPdf({
      fullName: cert.student_full_name,
      courseName: cert.course_name,
      serialNo: cert.serial_no,
      verificationUrl: verifyUrl,
      dateStr,
    });

    // Upload to storage
    const path = `${cert.profile_id}/${cert.serial_no}.pdf`;
    const { error: upErr } = await admin.storage.from("certificates").upload(path, pdfBytes, {
      contentType: "application/pdf",
      upsert: true,
    });
    if (upErr) throw upErr;
    const { data: pub } = admin.storage.from("certificates").getPublicUrl(path);
    const pdfUrl = pub.publicUrl;

    await admin.from("certificates").update({ pdf_url: pdfUrl }).eq("id", cert.id);

    if (send_telegram && profile?.telegram_id && !cert.revoked_at) {
      await sendTelegramCelebration(admin, profile, cert, pdfUrl);
    }

    return new Response(JSON.stringify({
      ok: true,
      pdf_url: pdfUrl,
      serial_no: cert.serial_no,
      verification_token: cert.verification_token,
      verify_url: verifyUrl,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("generate-certificate error", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
