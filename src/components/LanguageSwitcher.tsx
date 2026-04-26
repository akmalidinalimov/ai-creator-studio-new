import { Globe, Check } from "lucide-react";
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
  const currentLabel = SUPPORTED_LANGUAGES.find((l) => l.code === current)?.label || "O'zbekcha";

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
        {variant === "icon" ? (
          <Button variant="ghost" size="icon" aria-label="Change language">
            <Globe className="h-4 w-4" />
          </Button>
        ) : (
          <Button variant="ghost" size="sm" className="gap-1.5">
            <Globe className="h-4 w-4" />
            <span className="text-xs">{currentLabel}</span>
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {SUPPORTED_LANGUAGES.map((lang) => (
          <DropdownMenuItem
            key={lang.code}
            onClick={() => handleChange(lang.code)}
            className="flex items-center justify-between"
          >
            <span>{lang.label}</span>
            {current === lang.code && <Check className="h-3.5 w-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
