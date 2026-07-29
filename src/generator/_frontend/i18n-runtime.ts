// ---------------------------------------------------------------------------
// The generated frontend translation runtime (M-T1.11) — framework-AGNOSTIC,
// shared across every JS/TS frontend (React, Vue, Svelte, …).  It lives in the
// `_frontend/` shared seam (not `react/`) so a frontend generator imports it
// without a sibling-platform edge (pipeline-layering.test.ts).
//
// Emits two files into each app that has extractable user-visible text:
//
//   locales/en.json — the source-language catalog (key → English), the same
//     `{ key: message }` shape as `.loom/messages.en.json`, scoped to this
//     deployable's UI. Translators add `<locale>.json` siblings and PR them.
//   i18n.ts — the `t(key, default, values?)` lookup shim: returns the active
//     locale's string for `key` (falling back to the source-language default)
//     and substitutes `{name}` ICU placeholders from `values`.
//
// Deliberately NOT react-intl: `messages[key] ?? default` + a `{name}` regex
// covers plain literals and simple interpolation with no runtime dependency and
// no design-pack template change. ICU format suffixes (plural/select/number)
// arrive with a later react-intl slice that upgrades this shim in place — the
// `t(...)` call sites the walker emits stay the same.
// ---------------------------------------------------------------------------

import type { UiIR } from "../../ir/types/loom-ir.js";
import { collectUiMessages } from "../_walker/i18n-extract.js";

/** Build the flat, key-sorted `{ key: message }` catalog for one UI. */
function buildUiCatalog(ui: UiIR): Record<string, string> {
  const byKey = new Map<string, string>();
  // Same key ⇒ same content hash ⇒ same message; collapses repeats.
  for (const { key, message } of collectUiMessages(ui)) byKey.set(key, message);
  const out: Record<string, string> = {};
  for (const key of [...byKey.keys()].sort()) out[key] = byKey.get(key)!;
  return out;
}

/** `src/locales/en.json` — the source-language catalog for this UI. */
export function renderLocaleCatalog(ui: UiIR): string {
  return `${JSON.stringify(buildUiCatalog(ui), null, 2)}\n`;
}

/** `src/i18n.ts` — the `t(key, default, values?)` lookup + interpolation shim. */
export function renderI18nModule(): string {
  return `// Generated translation runtime (Loom i18n, M-T1.11).
// Source-language lookup with a per-key fallback and \`{name}\` interpolation. To
// add a locale, drop a \`src/locales/<locale>.json\` file, import it below, and
// register it in \`catalogs\`. (ICU format suffixes — plural/select/number — arrive
// with a later Loom release that swaps this shim for react-intl; the
// \`t(key, default, values)\` call sites stay the same.)
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
 *  substitute \`{name}\` placeholders from \`values\`. An unknown placeholder is
 *  left verbatim so a missing arg is visible rather than blank. */
export function t(
  key: string,
  defaultMessage: string,
  values?: Record<string, string | number>,
): string {
  const message = messages[key] ?? defaultMessage;
  if (values === undefined) return message;
  return message.replace(/\\{(\\w+)\\}/g, (whole, name: string) =>
    values[name] === undefined ? whole : String(values[name]),
  );
}
`;
}
