// Generated translation runtime (Loom i18n, M-T1.11).
// Plain source-language lookup with a per-key fallback. To add a locale, drop a
// `src/locales/<locale>.json` file, import it below, and register it in
// `catalogs`. (ICU placeholders/plurals arrive with a later Loom release, which
// upgrades this module; the `t(key, default)` call sites stay the same.)
import en from "./locales/en.json";

type Catalog = Record<string, string>;

const catalogs: Record<string, Catalog> = { en: en as Catalog };

function activeLocale(): string {
  const nav = typeof navigator !== "undefined" ? navigator.language : "en";
  const lang = nav.split("-")[0] ?? "en";
  return catalogs[lang] ? lang : "en";
}

const messages: Catalog = catalogs[activeLocale()] ?? catalogs.en ?? {};

/** Translate a message key, falling back to the source-language default. */
export function t(key: string, defaultMessage: string): string {
  return messages[key] ?? defaultMessage;
}
