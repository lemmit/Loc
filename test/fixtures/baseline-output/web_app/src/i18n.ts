// Generated translation runtime (Loom i18n, M-T1.11).
// Source-language lookup with a per-key fallback and `{name}` interpolation. To
// add a locale, drop a `src/locales/<locale>.json` file, import it below, and
// register it in `catalogs`. (ICU format suffixes — plural/select/number — arrive
// with a later Loom release that swaps this shim for react-intl; the
// `t(key, default, values)` call sites stay the same.)
import en from "./locales/en.json";

type Catalog = Record<string, string>;

const catalogs: Record<string, Catalog> = { en: en as Catalog };

function activeLocale(): string {
  const nav = typeof navigator !== "undefined" ? navigator.language : "en";
  const lang = nav.split("-")[0] ?? "en";
  return catalogs[lang] ? lang : "en";
}

const messages: Catalog = catalogs[activeLocale()] ?? catalogs.en ?? {};

/** Translate a message key, falling back to the source-language default, and
 *  substitute `{name}` placeholders from `values`. An unknown placeholder is
 *  left verbatim so a missing arg is visible rather than blank. */
export function t(
  key: string,
  defaultMessage: string,
  values?: Record<string, string | number>,
): string {
  const message = messages[key] ?? defaultMessage;
  if (values === undefined) return message;
  return message.replace(/\{(\w+)\}/g, (whole, name: string) =>
    values[name] === undefined ? whole : String(values[name]),
  );
}
