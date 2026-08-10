// ---------------------------------------------------------------------------
// The Python backend's validation-message catalog + lookup (M-T1.11).
//
// `app/i18n.py`, resolved from the FastAPI `RequestValidationError` handler —
// the single 422 chokepoint that already reads a messaged rule's content-hash
// `code` off `PydanticCustomError`'s type.
//
// WHY A MODULE-LEVEL DICT rather than the stdlib `gettext`.  Python's `gettext`
// resolves against COMPILED `.mo` binaries (`msgfmt`), which a text emitter
// cannot produce and a generated Dockerfile would have to compile at build
// time — a toolchain dependency for a lookup that is one dict access.  (The
// Phoenix backend DOES use gettext, because Elixir's implementation reads `.po`
// source directly at compile time; the trade differs per ecosystem.)
//
// ADDING A LOCALE is a regeneration: `ddd i18n sync` owns the per-locale files
// at the SYSTEM level and codegen bakes them in here.  Today only the source
// language ships, so every request resolves to the authored English — the
// resolution seam is in place with byte-identical wire VALUES.
// ---------------------------------------------------------------------------

import { lines } from "../../../util/code-builder.js";
import type { ValidationMessage } from "../../_i18n/validation-catalog.js";

/** The path the emitted catalog module lands at inside the project. */
export const PY_MESSAGES_MODULE_PATH = "app/i18n.py";

/** A Python string literal — `JSON.stringify` is a valid Python `str` literal
 *  for every character it escapes (`\"`, `\\`, `\n`, `\uXXXX`). */
function pyStr(value: string): string {
  return JSON.stringify(value);
}

/** `app/i18n.py` — the source-language catalog plus the locale-aware lookup the
 *  422 handler resolves each `errors[].code` through. */
export function renderPyMessagesModule(messages: readonly ValidationMessage[]): string {
  return lines(
    '"""Validation-message catalog (Loom i18n, M-T1.11).',
    "",
    "Keys are the stable content-hash codes the wire validators attach to a",
    "messaged ``invariant`` / ``check`` / ``precondition`` (``errors[].code``),",
    "identical to the keys in the system's ``.loom/messages.en.json`` and on every",
    "other backend.  A locale with no entry for a code falls back to the authored",
    "source-language text, so an untranslated message still reads correctly.",
    '"""',
    "",
    "from app.obs.log import locale",
    "",
    "MESSAGES: dict[str, dict[str, str]] = {",
    '    "en": {',
    ...messages.map((m) => `        ${pyStr(m.code)}: ${pyStr(m.text)},`),
    "    },",
    "}",
    "",
    "",
    "def _lookup_tags(tag: str) -> list[str]:",
    '    """Normalise an Accept-Language header value to lookup tags: the first',
    "    listed language without its ``;q=`` weight, then its primary subtag.  The",
    "    ambient RequestContext carries the header VERBATIM (D-CTX-SHAPE — it is the",
    "    request-stable input, not a catalog-shaped one), so the normalisation lives",
    '    here rather than at the boundary that sets it."""',
    '    first = tag.split(",")[0].split(";")[0].strip().lower()',
    "    if not first:",
    "        return []",
    '    primary = first.split("-")[0]',
    "    return [first] if primary == first else [first, primary]",
    "",
    "",
    "def localize_message(code: str | None, fallback: str) -> str:",
    '    """Resolve ``code`` for the current request\'s locale, falling back to the',
    "    authored source-language text when the code is absent, unknown, or",
    '    untranslated for that locale."""',
    "    if not code:",
    "        return fallback",
    "    for tag in _lookup_tags(locale()):",
    "        hit = MESSAGES.get(tag, {}).get(code)",
    "        if hit is not None:",
    "            return hit",
    "    return fallback",
  );
}
