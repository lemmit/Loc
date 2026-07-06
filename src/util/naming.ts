/** Uppercase the first character only — the rest is left untouched.
 *  Intended for identifiers that are already camelCase / PascalCase
 *  (`"addLine" → "AddLine"`), NOT a full case converter: a snake_case
 *  input keeps its underscores (`"add_line" → "Add_line"`). */
export function upperFirst(input: string): string {
  if (!input) return input;
  return input[0]!.toUpperCase() + input.slice(1);
}

/** Lowercase the first character only — the rest is left untouched.
 *  See {@link upperFirst}: input is assumed already camel/Pascal. */
export function lowerFirst(input: string): string {
  if (!input) return input;
  return input[0]!.toLowerCase() + input.slice(1);
}

export function snake(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

export function plural(input: string): string {
  if (input.endsWith("y") && !/[aeiou]y$/.test(input)) {
    return input.slice(0, -1) + "ies";
  }
  if (/(s|x|z|ch|sh)$/.test(input)) return input + "es";
  return input + "s";
}

/** Per-workflow-scoped name for an emitted workflow `function` helper.
 *  A workflow body is not a class, so its `function` helpers are emitted as
 *  file/module-scoped helpers — and workflows share a generated file, so the
 *  helper is namespaced by its workflow (`placeOrder` + `slaDays`).  The call
 *  site (render-expr, `callKind: "workflow-fn"`) and the definition site (each
 *  backend's workflow emitter) must agree byte-for-byte, so BOTH route through
 *  these — one per target-language casing.  Source identifiers are already
 *  camelCase, so first-letter casing is all that's needed.  See docs/workflow.md. */
export function workflowFnCamel(wf: string, fn: string): string {
  return `${lowerFirst(wf)}${upperFirst(fn)}`;
}
export function workflowFnPascal(wf: string, fn: string): string {
  return `${upperFirst(wf)}${upperFirst(fn)}`;
}
export function workflowFnSnake(wf: string, fn: string): string {
  return `${snake(wf)}_${snake(fn)}`;
}

/** Convert an identifier (camelCase, PascalCase, snake_case) into a
 *  human-friendly Title Case label suitable for UI display.
 *  Examples: "customerId" → "Customer Id"; "placedAt" → "Placed At";
 *  "addLine" → "Add Line"; "order_total" → "Order Total".
 *  Common acronyms are passed through capitalised, not split. */
export function humanize(input: string): string {
  if (!input) return input;
  const words = input
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
    .split(/\s+/);
  return words.map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1))).join(" ");
}

// ---------------------------------------------------------------------------
// Target-language keyword escaping for emitted local identifiers.
//
// A Loom `let`-binding may be named after a reserved word in a target
// language — `let base = …` is legal Loom but `base` is a C# keyword, so
// `var base = …` fails to compile.  Each backend renders the *same* local
// name at the binding AND every `refKind: "let"` use; routing both through the
// matching `escape<Lang>Ident` keeps the rename consistent.
//
// Only names that actually collide with a reserved word are rewritten — a
// non-keyword name passes through byte-identically (no churn for the common
// case).  This is a cross-layer naming concern (the generators are the
// consumers), so it lives here alongside the other casing helpers.
// ---------------------------------------------------------------------------

/** C# reserved keywords.  Escaped with the verbatim-identifier prefix
 *  (`@base`), the idiomatic C# escape. */
const CSHARP_KEYWORDS = new Set([
  "abstract",
  "as",
  "base",
  "bool",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "checked",
  "class",
  "const",
  "continue",
  "decimal",
  "default",
  "delegate",
  "do",
  "double",
  "else",
  "enum",
  "event",
  "explicit",
  "extern",
  "false",
  "finally",
  "fixed",
  "float",
  "for",
  "foreach",
  "goto",
  "if",
  "implicit",
  "in",
  "int",
  "interface",
  "internal",
  "is",
  "lock",
  "long",
  "namespace",
  "new",
  "null",
  "object",
  "operator",
  "out",
  "override",
  "params",
  "private",
  "protected",
  "public",
  "readonly",
  "ref",
  "return",
  "sbyte",
  "sealed",
  "short",
  "sizeof",
  "stackalloc",
  "static",
  "string",
  "struct",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "uint",
  "ulong",
  "unchecked",
  "unsafe",
  "ushort",
  "using",
  "virtual",
  "void",
  "volatile",
  "while",
]);

/** TypeScript / JavaScript reserved words (the strict-mode + module set that
 *  cannot be a binding name).  Escaped with a trailing underscore. */
const TS_KEYWORDS = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "await",
]);

/** Java reserved words.  Escaped with a trailing underscore. */
const JAVA_KEYWORDS = new Set([
  "abstract",
  "assert",
  "boolean",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "class",
  "const",
  "continue",
  "default",
  "do",
  "double",
  "else",
  "enum",
  "extends",
  "final",
  "finally",
  "float",
  "for",
  "goto",
  "if",
  "implements",
  "import",
  "instanceof",
  "int",
  "interface",
  "long",
  "native",
  "new",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "short",
  "static",
  "strictfp",
  "super",
  "switch",
  "synchronized",
  "this",
  "throw",
  "throws",
  "transient",
  "try",
  "void",
  "volatile",
  "while",
  "var",
  "true",
  "false",
  "null",
]);

/** Python keywords + soft keywords unsafe as a plain binding.  Escaped with a
 *  trailing underscore. */
const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
  "match",
  "case",
]);

/** Elixir reserved words / special forms unsafe as a plain variable binding.
 *  Escaped with a trailing underscore. */
const ELIXIR_KEYWORDS = new Set([
  "true",
  "false",
  "nil",
  "when",
  "and",
  "or",
  "not",
  "in",
  "fn",
  "do",
  "end",
  "catch",
  "rescue",
  "after",
  "else",
  "def",
  "defp",
  "defmodule",
  "if",
  "unless",
  "case",
  "cond",
  "with",
  "for",
  "receive",
  "try",
  "raise",
  "import",
  "alias",
  "require",
  "use",
  "quote",
  "unquote",
]);

/** Escape a local identifier that collides with a C# keyword using the
 *  verbatim-identifier prefix (`base` → `@base`); pass through otherwise. */
export function escapeCsharpIdent(name: string): string {
  return CSHARP_KEYWORDS.has(name) ? `@${name}` : name;
}

/** Escape a local identifier that collides with a TS/JS reserved word with a
 *  trailing underscore (`new` → `new_`); pass through otherwise. */
export function escapeTsIdent(name: string): string {
  return TS_KEYWORDS.has(name) ? `${name}_` : name;
}

/** Escape a local identifier that collides with a Java reserved word with a
 *  trailing underscore (`class` → `class_`); pass through otherwise. */
export function escapeJavaIdent(name: string): string {
  return JAVA_KEYWORDS.has(name) ? `${name}_` : name;
}

/** Escape a (already snake_cased) local identifier that collides with a
 *  Python keyword with a trailing underscore (`class` → `class_`); pass
 *  through otherwise. */
export function escapePythonIdent(name: string): string {
  return PYTHON_KEYWORDS.has(name) ? `${name}_` : name;
}

/** Escape a (already snake_cased) local identifier that collides with an
 *  Elixir reserved word with a trailing underscore (`end` → `end_`); pass
 *  through otherwise. */
export function escapeElixirIdent(name: string): string {
  return ELIXIR_KEYWORDS.has(name) ? `${name}_` : name;
}

// ---------------------------------------------------------------------------
// Target-language string / regex materialization for `.ddd`-sourced values.
//
// A string literal or regex pattern written in `.ddd` source is spliced into
// generated target source.  Most backends can re-quote with `JSON.stringify`
// (C#/Java/Python/TS double-quoted string literals do NOT interpolate `{`), but
// Elixir does: a double-quoted string interpolates `#{…}` and a `~r/…/` regex
// sigil both interpolates `#{…}` AND ends at an unescaped `/`.  Left raw, a
// pattern like `"hi#{System.cmd(...)}"` executes at compile time and a `/`
// closes the sigil early — an injection / compile-break class.  These helpers
// are the single funnel every Elixir emit site shares so the escaping can't
// drift one renderer at a time.
// ---------------------------------------------------------------------------

/** A safe Elixir double-quoted string literal for a `.ddd`-sourced value.
 *  `JSON.stringify` handles `"` / `\` / control chars; the extra pass escapes
 *  `#{` → `\#{` so Elixir string interpolation can't fire (`"a#{x}"` would
 *  otherwise interpolate `x`).  Elixir reads `\#` as a literal `#`. */
export function elixirString(value: string): string {
  return JSON.stringify(value).replace(/#\{/g, "\\#{");
}

/** Escape a `.ddd`-sourced regex pattern for embedding in an Elixir `~r/…/`
 *  sigil.  A raw `/` closes the sigil and a raw `#{` interpolates; escaping
 *  both (`\/`, `\#{`) keeps the pattern a literal regex.  Regex backslashes
 *  (`\d`, `\w`) are already meaningful and pass through untouched. */
export function elixirRegexBody(pattern: string): string {
  return pattern.replace(/#\{/g, "\\#{").replace(/\//g, "\\/");
}

export function indent(text: string, level = 1, unit = "  "): string {
  const pad = unit.repeat(level);
  return text
    .split("\n")
    .map((l) => (l.length === 0 ? l : pad + l))
    .join("\n");
}
