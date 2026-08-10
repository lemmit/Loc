// ---------------------------------------------------------------------------
// The .NET backend's validation-message catalog + lookup (M-T1.11).
//
// `Localization/LoomMessages.cs`, resolved from the FluentValidation arm of the
// domain-exception filter — the single 422 chokepoint that already reads a
// messaged rule's `.WithErrorCode("msg.<hash>")` off each `ValidationFailure`.
//
// WHY A GENERATED STATIC MAP rather than `IStringLocalizer`.  ASP.NET's
// localization stack keys off satellite `.resx` assemblies: a `.resx` is XML that
// has to be declared as an `EmbeddedResource`, run through resgen at build, and
// reached through a `ResourceManager` rooted at a type — a build-pipeline
// dependency for what is one dictionary lookup, and one more thing that can go
// wrong in the emitted `.csproj`.  (The Java and Phoenix backends DO use their
// ecosystem's catalog — `ResourceBundle` and gettext both read plain text the
// emitter can write directly.)
//
// ADDING A LOCALE is a regeneration: `ddd i18n sync` owns the per-locale files at
// the SYSTEM level and codegen bakes them in here.  Today only the source
// language ships, so every request resolves to the authored English — the seam is
// in place with byte-identical wire VALUES.
// ---------------------------------------------------------------------------

import { lines } from "../../../util/code-builder.js";
import type { ValidationMessage } from "../../_i18n/validation-catalog.js";

/** C# string-literal escape: backslash + double-quote — the same shape
 *  `JSON.stringify` produces, matching `validator-emit.ts`'s local helper. */
function csStringLiteral(value: string): string {
  return JSON.stringify(value);
}

/** Path of the emitted catalog inside the .NET project. */
export const CS_MESSAGES_PATH = "Localization/LoomMessages.cs";

/** `Localization/LoomMessages.cs` — the source-language catalog plus the
 *  locale-aware lookup the 422 filter resolves each `errors[].code` through. */
export function renderCsMessages(ns: string, messages: readonly ValidationMessage[]): string {
  return lines(
    "// Auto-generated.  Validation-message catalog (Loom i18n, M-T1.11).",
    "//",
    "// Keys are the stable content-hash codes the wire validators attach to a",
    "// messaged invariant / check / precondition (errors[].code), identical to the",
    "// keys in the system's .loom/messages.en.json and on every other backend.",
    "// A locale with no entry for a code falls back to the authored source-language",
    "// text, so an untranslated message still reads correctly.",
    "using System;",
    "using System.Collections.Generic;",
    "",
    `namespace ${ns}.Localization;`,
    "",
    "public static class LoomMessages",
    "{",
    "    private static readonly Dictionary<string, Dictionary<string, string>> Catalog = new(StringComparer.Ordinal)",
    "    {",
    '        ["en"] = new(StringComparer.Ordinal)',
    "        {",
    ...messages.map(
      (m) => `            [${csStringLiteral(m.code)}] = ${csStringLiteral(m.text)},`,
    ),
    "        },",
    "    };",
    "",
    "    /// <summary>",
    '    /// Resolve a message <paramref name="code"/> for the current request\'s',
    '    /// locale, falling back to <paramref name="fallback"/> (the authored',
    "    /// source-language text) when the code is absent, unknown, or untranslated.",
    "    /// </summary>",
    "    public static string Localize(string? code, string fallback)",
    "    {",
    "        if (string.IsNullOrEmpty(code)) return fallback;",
    // The ambient carrier holds the Accept-Language header VERBATIM (D-CTX-SHAPE
    // — it is the request-stable input, not a catalog-shaped one), so the
    // normalisation to a lookup tag lives here.
    `        var header = ${ns}.Domain.Common.RequestContext.Current?.Locale ?? "en";`,
    "        var first = header.Split(',')[0].Split(';')[0].Trim().ToLowerInvariant();",
    "        if (first.Length == 0) return fallback;",
    "        if (Catalog.TryGetValue(first, out var exact) && exact.TryGetValue(code, out var hit))",
    "            return hit;",
    "        var dash = first.IndexOf('-');",
    "        if (dash > 0)",
    "        {",
    "            var primary = first.Substring(0, dash);",
    "            if (Catalog.TryGetValue(primary, out var byPrimary) && byPrimary.TryGetValue(code, out var alt))",
    "                return alt;",
    "        }",
    "        return fallback;",
    "    }",
    "}",
  );
}
