import React, { createContext, useContext, useState } from "react";
import type { Lang, TranslationKey } from "./translations";
import { translations, getLangLocale } from "./translations";

interface LangCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: TranslationKey) => string;
  n: (val: number, digits?: number) => string;
}

const LanguageContext = createContext<LangCtx>({
  lang: "de",
  setLang: () => {},
  t: (key) => key as string,
  n: (val) => val.toFixed(1),
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const stored = (localStorage.getItem("cadtomie_lang") as Lang | null) ?? "de";
  const [lang, setLangState] = useState<Lang>(stored);

  const setLang = (l: Lang) => {
    localStorage.setItem("cadtomie_lang", l);
    setLangState(l);
  };

  const t = (key: TranslationKey): string => {
    const dict = translations[lang] as Record<string, string>;
    const fallback = translations.en as Record<string, string>;
    return dict[key] ?? fallback[key] ?? (key as string);
  };

  const n = (val: number, digits = 1): string =>
    val.toLocaleString(getLangLocale(lang), {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });

  return (
    <LanguageContext.Provider value={{ lang, setLang, t, n }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useTranslation() {
  return useContext(LanguageContext);
}
