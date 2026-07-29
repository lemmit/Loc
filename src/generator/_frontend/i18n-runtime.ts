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
//     and locale-formats its ICU placeholders (`{name}`, `{total, number,
//     ::currency/USD}`, `{d, date, ::yMMMd}`) from `values` via
//     `@formatjs/intl-messageformat`.
//
// The lookup half stays a tiny `messages[key] ?? default` map — no react-intl
// provider, no design-pack template change. The formatting half is
// `@formatjs/intl-messageformat` (the standalone ICU engine react-intl itself
// builds on) so a `, number` / `, date` format suffix (M-T1.11) locale-formats
// at runtime. The `t(key, default, values?)` call sites the walker emits are
// unchanged. (Plural/select — brace-bodied ICU — are a later slice; the same
// engine already supports them, only the grammar/extractor gate them out.)
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

/** `src/i18n.ts` — the `t(key, default, values?)` lookup + ICU-format shim. */
export function renderI18nModule(): string {
  return `// Generated translation runtime (Loom i18n, M-T1.11).
// Source-language lookup with a per-key fallback and ICU message formatting via
// \`@formatjs/intl-messageformat\`. To add a locale, drop a
// \`src/locales/<locale>.json\` file, import it below, and register it in
// \`catalogs\`. The \`t(key, default, values)\` call sites are stable — a message
// may carry plain \`{name}\` holes or locale-formatted ones
// (\`{total, number, ::currency/USD}\`, \`{d, date, ::yMMMd}\`).
import { IntlMessageFormat } from "@formatjs/intl-messageformat";
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
 *  ICU-format its placeholders from \`values\` in the active locale. A
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
`;
}
