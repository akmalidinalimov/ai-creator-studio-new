import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SUPPORTED_LANGUAGES, type LanguageCode } from "@/i18n";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import UZ from "country-flag-icons/react/3x2/UZ";
import RU from "country-flag-icons/react/3x2/RU";
import US from "country-flag-icons/react/3x2/US";

interface Props {
  variant?: "icon" | "compact";
}

const FLAG_MAP: Record<LanguageCode, React.ComponentType<{ className?: string; title?: string }>> = {
  uz: UZ,
  ru: RU,
  en: US,
};

const Flag = ({ code, className }: { code: LanguageCode; className?: string }) => {
  const Component = FLAG_MAP[code];
  return (
    <Component
      className={`inline-block rounded-[2px] shadow-sm ring-1 ring-black/10 ${className ?? ""}`}
      title={code.toUpperCase()}
    />
  );
};

export const LanguageSwitcher = ({ variant = "icon" }: Props) => {
  const { i18n } = useTranslation();
  const { user } = useAuth();
  const current = (i18n.resolvedLanguage || i18n.language || "uz").slice(0, 2) as LanguageCode;
  const currentLang = SUPPORTED_LANGUAGES.find((l) => l.code === current) || SUPPORTED_LANGUAGES[0];

  const handleChange = async (code: LanguageCode) => {
    await i18n.changeLanguage(code);
    try {
      localStorage.setItem("lng", code);
    } catch {
      // ignore
    }
    if (user) {
      supabase
        .from("profiles")
        .update({ preferred_language: code } as any)
        .eq("id", user.id)
        .then(() => {});
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 px-2"
          aria-label="Change language"
        >
          <Flag code={currentLang.code} className="h-4 w-6" />
          <span className="text-xs font-medium">{currentLang.short}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {SUPPORTED_LANGUAGES.map((lang) => (
          <DropdownMenuItem
            key={lang.code}
            onClick={() => handleChange(lang.code)}
            className="flex items-center justify-between gap-2"
          >
            <span className="flex items-center gap-2">
              <Flag code={lang.code} className="h-4 w-6" />
              <span>{lang.label}</span>
              <span className="text-xs text-muted-foreground">({lang.short})</span>
            </span>
            {current === lang.code && <Check className="h-3.5 w-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
