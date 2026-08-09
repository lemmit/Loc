// ---------------------------------------------------------------------------
// The TypeScript backend's validation-message catalog + lookup (M-T1.11).
//
// Emitted as `http/messages.ts` alongside `http/problem-details.ts`, whose
// `defaultHook` is the single 422 chokepoint that resolves every messaged rule's
// `code` before serialising `errors[]`.
//
// WHY AN INLINE MAP rather than a JSON resource.  Node has no standard message
// catalog (unlike Java's `ResourceBundle` or Elixir's gettext, which the Java /
// Phoenix backends use instead of a hand-rolled lookup), and the generated
// backend is bundled by `tsup` into `dist/` — a `fs.readFileSync` against a
// `locales/` directory would have to resolve a path relative to the BUNDLE, not
// the source, which is exactly the kind of layout coupling the emitter should
// not create.  A `const` map is a compile-time artifact with no I/O and no
// packaging step, matching the Feliz (`Map<string,string>` in `App.fs`) and
// Flutter (`const Map` in `lib/i18n.dart`) frontend catalogs.
//
// ADDING A LOCALE is a REGENERATION, not a hand-edit: `ddd i18n sync` owns the
// per-locale files at the SYSTEM level (`locales/<locale>.json`), and codegen
// bakes them in here.  Today only the source language is emitted, so every
// request resolves to the authored English — byte-identical wire VALUES to
// pre-catalog output, with the resolution seam now in place.
// ---------------------------------------------------------------------------

import { lines } from "../../../util/code-builder.js";
import type { ValidationMessage } from "../../_i18n/validation-catalog.js";

/** The path the emitted catalog module lands at inside the project. */
export const MESSAGES_MODULE_PATH = "http/messages.ts";

/** `http/messages.ts` — the source-language catalog plus the locale-aware
 *  lookup `defaultHook` resolves each `errors[].code` through. */
export function renderMessagesModule(messages: readonly ValidationMessage[]): string {
  return lines(
    "// Auto-generated.  Validation-message catalog (Loom i18n, M-T1.11).",
    "//",
    "// Keys are the stable content-hash codes the wire validators attach to a",
    "// messaged `invariant` / `check` / `precondition` (`errors[].code`), identical",
    "// to the keys in the system's `.loom/messages.en.json` and on every other",
    "// backend.  A locale with no entry for a code falls back to the authored",
    "// source-language text, so an untranslated message still reads correctly.",
    'import { requestContext } from "../obs/als";',
    "",
    "/** Source-language catalog, keyed by locale then by message code. */",
    "const MESSAGES: Record<string, Record<string, string>> = {",
    "  en: {",
    ...messages.map((m) => `    ${JSON.stringify(m.code)}: ${JSON.stringify(m.text)},`),
    "  },",
    "};",
    "",
    "/** Normalise an Accept-Language header value to a lookup tag: the first",
    " *  listed language, without its `;q=` weight, lowercased.  The ambient",
    " *  RequestContext carries the header VERBATIM (D-CTX-SHAPE — it is the",
    " *  request-stable input, not a catalog-shaped one), so the normalisation",
    " *  belongs here rather than at the boundary that sets it. */",
    "function lookupTags(locale: string): string[] {",
    '  const first = (locale.split(",")[0] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";',
    "  if (!first) return [];",
    '  const primary = first.split("-")[0] ?? first;',
    "  return primary === first ? [first] : [first, primary];",
    "}",
    "",
    "/** Resolve a message `code` for the current request's locale, falling back to",
    " *  `fallback` (the authored source-language text) when the code is absent,",
    " *  unknown, or untranslated for that locale. */",
    "export function localizeMessage(code: string | undefined, fallback: string): string {",
    "  if (!code) return fallback;",
    '  const locale = requestContext()?.locale ?? "en";',
    "  for (const tag of lookupTags(locale)) {",
    "    const hit = MESSAGES[tag]?.[code];",
    "    if (hit !== undefined) return hit;",
    "  }",
    "  return fallback;",
    "}",
  );
}
