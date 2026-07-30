// Generated translation runtime (Loom i18n, M-T1.11).
// Source-language lookup with a per-key fallback and ICU message formatting via
// `intl-messageformat`. To add a locale, drop a
// `src/locales/<locale>.json` file, import it below, and register it in
// `catalogs`. The `t(key, default, values)` call sites are stable — a message
// may carry plain `{name}` holes or locale-formatted ones
// (`{total, number, ::currency/USD}`, `{d, date, ::yMMMd}`).
import { IntlMessageFormat } from "intl-messageformat";
import en from "./locales/en.json";

type Catalog = Record<string, string>;

const catalogs: Record<string, Catalog> = { en: en as Catalog };

function activeLocale(): string {
  const nav = typeof navigator !== "undefined" ? navigator.language : "en";
  const lang = nav.split("-")[0] ?? "en";
  return catalogs[lang] ? lang : "en";
}

const locale = activeLocale();
const messages: Catalog = catalogs[locale] ?? catalogs.en ?? {};

/** Translate a message key, falling back to the source-language default, then
 *  ICU-format its placeholders from `values` in the active locale. A
 *  value-less message returns verbatim (no parse cost). */
export function t(
  key: string,
  defaultMessage: string,
  values?: Record<string, string | number | boolean | Date>,
): string {
  const message = messages[key] ?? defaultMessage;
  if (values === undefined) return message;
  return new IntlMessageFormat(message, locale).format(values) as string;
}
