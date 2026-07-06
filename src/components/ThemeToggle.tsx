import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

function isDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

/** Light/dark toggle. Persists to localStorage; index.html applies it pre-paint. */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => { setDark(isDark()); }, []);

  const toggle = () => {
    const next = !isDark();
    document.documentElement.classList.toggle("dark", next);
    try { localStorage.setItem("theme", next ? "dark" : "light"); } catch { /* private mode */ }
    setDark(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={dark ? "Light mode" : "Dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
    >
      {dark ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
    </button>
  );
}
