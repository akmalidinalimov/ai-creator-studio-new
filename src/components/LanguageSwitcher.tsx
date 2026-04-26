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

interface Props {
  variant?: "icon" | "compact";
}

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
          size={variant === "icon" ? "sm" : "sm"}
          className="gap-1.5 px-2"
          aria-label="Change language"
        >
          <span className="text-base leading-none">{currentLang.flag}</span>
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
              <span className="text-base leading-none">{lang.flag}</span>
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
