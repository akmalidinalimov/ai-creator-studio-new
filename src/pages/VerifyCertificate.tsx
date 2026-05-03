import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, ShieldAlert } from "lucide-react";

interface Cert {
  serial_no: string;
  student_full_name: string;
  course_name: string;
  issued_at: string;
  pdf_url: string | null;
  revoked_at: string | null;
}

export default function VerifyCertificate() {
  const { token } = useParams<{ token: string }>();
  const [loading, setLoading] = useState(true);
  const [cert, setCert] = useState<Cert | null>(null);

  useEffect(() => {
    (async () => {
      if (!token) { setLoading(false); return; }
      const { data } = await supabase
        .from("certificates")
        .select("serial_no, student_full_name, course_name, issued_at, pdf_url, revoked_at")
        .eq("verification_token", token)
        .maybeSingle();
      setCert(data as Cert | null);
      setLoading(false);
    })();
  }, [token]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <Card className="max-w-lg w-full p-8 text-center">
        {loading ? (
          <div className="text-muted-foreground">Yuklanmoqda…</div>
        ) : !cert ? (
          <div className="space-y-3">
            <XCircle className="h-16 w-16 text-destructive mx-auto" />
            <h1 className="text-2xl font-bold">Sertifikat topilmadi</h1>
            <p className="text-muted-foreground">Certificate not found / Сертификат не найден</p>
          </div>
        ) : cert.revoked_at ? (
          <div className="space-y-3">
            <ShieldAlert className="h-16 w-16 text-amber-500 mx-auto" />
            <h1 className="text-2xl font-bold">Bu sertifikat bekor qilingan</h1>
            <p className="text-muted-foreground">This certificate has been revoked</p>
            <div className="text-sm text-muted-foreground pt-3">
              <div>{cert.student_full_name}</div>
              <div className="font-mono">{cert.serial_no}</div>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <CheckCircle2 className="h-16 w-16 text-green-600 mx-auto" />
            <h1 className="text-2xl font-bold text-green-700">Bu sertifikat haqiqiy</h1>
            <p className="text-sm text-muted-foreground">This certificate is valid</p>
            <div className="space-y-2 text-left bg-muted/40 rounded-lg p-4 mt-4">
              <Row label="Talaba / Student" value={cert.student_full_name} />
              <Row label="Kurs / Course" value={cert.course_name} />
              <Row label="Serial" value={cert.serial_no} mono />
              <Row label="Sana / Issued" value={new Date(cert.issued_at).toLocaleDateString("en-CA")} />
            </div>
            {cert.pdf_url && (
              <Button asChild className="w-full">
                <a href={cert.pdf_url} target="_blank" rel="noreferrer">📥 PDF yuklab olish</a>
              </Button>
            )}
            <div className="pt-4 text-xs text-muted-foreground">
              <Link to="/" className="underline hover:text-foreground">AI Creators platformasidan</Link>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium text-right ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}
