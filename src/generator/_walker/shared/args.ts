// Pure argument-reader and string utilities for the React body walker.
//
// Everything here is a pure function of its arguments — no WalkContext,
// no shared-state mutation. Extracted from body-walker.ts so the
// per-primitive emitter modules can share them without dragging the
// walker context.

import type { ExprIR } from "../../../ir/types/loom-ir.js";
import { escapeHtmlAttr } from "../a11y-emit.js";

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function boolNamed(call: ExprIR & { kind: "call" }, name: string): boolean {
  const argNames = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] !== name) continue;
    const a = call.args[i]!;
    if (a.kind === "literal" && a.lit === "bool") return a.value === "true";
  }
  return false;
}

/** Return the value-expression of a named arg (e.g.
 *  the `<expr>` in `rows: <expr>`).  Undefined when the named arg
 *  is missing.  Distinct from `stringNamed` (string literals only)
 *  and `numericNamed` (number literals only): this keeps any
 *  expression IR for the caller to render as JS. */
export function namedArgValue(call: ExprIR & { kind: "call" }, name: string): ExprIR | undefined {
  const argNames = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] === name) return call.args[i];
  }
  return undefined;
}

/** Extract a lambda-shaped named arg from a call.
 *  Returns the lambda IR sub-node (its `param`/`body`/`block`
 *  fields) so callers can emit the handler.  Returns undefined
 *  when the named arg is missing or isn't a lambda. */
export function lambdaArg(
  call: ExprIR & { kind: "call" },
  name: string,
): (ExprIR & { kind: "lambda" }) | undefined {
  const argNames = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] !== name) continue;
    const a = call.args[i]!;
    if (a.kind === "lambda") return a;
  }
  return undefined;
}

/** Extract a named-action reference from a handler-arg slot (`onSubmit: next`,
 *  `rowAction: add`) — the named-action analogue of `lambdaArg`
 *  (named-actions-and-stores.md, Proposal A Stage 1).  Returns the resolved
 *  `action-ref` IR node (carrying the resolved `actionName` + declared
 *  `paramType`) when the named arg is exactly a bare action reference;
 *  undefined when missing or any other expression.  Call-site primitives
 *  check this BEFORE `lambdaArg` so a named action binds the hoisted handler
 *  instead of emitting an inline arrow. */
export function actionRefArg(
  call: ExprIR & { kind: "call" },
  name: string,
): (ExprIR & { kind: "action-ref" }) | undefined {
  const argNames = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] !== name) continue;
    const a = call.args[i]!;
    if (a.kind === "action-ref") return a;
  }
  return undefined;
}

/** The hoisted handler-function identifier for a named action — derived on
 *  demand from the action name (NOT stamped; invariant #4).  The action name
 *  is already a camelCase identifier in source (`next`, `setCustomer`), so the
 *  hoisted function is named identically across the JSX frontends; a bare
 *  call-site reference binds `onClick={<handlerName>}` / `handleSubmit(<handlerName>)`. */
export function actionHandlerName(actionName: string): string {
  return actionName;
}

/** Render a renderTextContent() result as an attribute value.  A
 *  brace-wrapped expression stays brace-wrapped; a quoted string
 *  literal (`JSON.stringify`'d) is re-emitted HTML-attribute-escaped
 *  inside double quotes so an embedded `"` (or `& < >`) can't break out
 *  of `attr="…"`.  A JS backslash-escaped quote does NOT work here —
 *  JSX/HTML attribute values are not JS strings and don't process
 *  backslash escapes, so `label="a\"b"` terminates at the inner quote.
 *  HTML entities decode in attribute values on every frontend (JSX,
 *  Vue, Svelte, Angular); for a value with no special chars the output
 *  is byte-identical to the previous `JSON.stringify` form. */
export function unwrapAsAttr(s: string): string {
  if (s.length >= 2 && s.startsWith("{") && s.endsWith("}")) return s;
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return `"${escapeHtmlAttr(JSON.parse(s) as string)}"`;
  }
  return s;
}

export function describeReceiver(expr: ExprIR): string {
  if (expr.kind === "ref") return expr.name;
  if (expr.kind === "method-call") return `${describeReceiver(expr.receiver)}.${expr.member}`;
  return `<expr>`;
}

export function positionalArgs(call: ExprIR & { kind: "call" }): ExprIR[] {
  const argNames = call.argNames ?? [];
  const out: ExprIR[] = [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] === undefined) out.push(call.args[i]!);
  }
  return out;
}

export function firstPositionalText(call: ExprIR & { kind: "call" }): string | undefined {
  const positionals = positionalArgs(call);
  const first = positionals[0];
  if (!first) return undefined;
  if (first.kind === "literal" && first.lit === "string") return first.value;
  return undefined;
}

/** `firstPositionalContent` returns either a `"quoted string"` or a
 *  `{paramRef}` markup expression.  Components
 *  embedding the result in markup text need quoted strings unwrapped
 *  to bare text; markup expressions stay verbatim.  `escape` is the
 *  active target's text escaper (`ctx.target.escapeText`) — defaults
 *  to the JSX escape so framework-free callers keep the v0
 *  behaviour. */
export function unwrapTextLiteral(
  s: string,
  escapeFn: (text: string) => string = escapeJsxText,
): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return escapeFn(JSON.parse(s) as string);
  }
  return s;
}

export function stringNamed(call: ExprIR & { kind: "call" }, name: string): string | undefined {
  const argNames = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] !== name) continue;
    const a = call.args[i]!;
    if (a.kind === "literal" && a.lit === "string") return a.value;
  }
  return undefined;
}

export function numericNamed(call: ExprIR & { kind: "call" }, name: string): number | undefined {
  const argNames = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] !== name) continue;
    const a = call.args[i]!;
    if (a.kind === "literal" && a.lit === "int") {
      const n = Number(a.value);
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
}

export function escapeJsxText(s: string): string {
  // Replace JSX-significant punctuation with HTML entity equivalents
  // so the emitted source compiles under `tsc --noEmit`.  `{` and
  // `}` are expression delimiters; `<` and `>` are tag delimiters
  // (TS1382 fires on a literal `>` in JSX text, even when it's an
  // arithmetic comparison or a lambda arrow inside a code snippet).
  // `&` must be escaped first so we don't double-escape the entity
  // refs the other replacements introduce.  CodeBlock source strings
  // can contain `&` (and `&&` / `&=`) so this fourth char matters
  // when arbitrary code is rendered into a `<pre><code>` block.
  // Apostrophes / quotes are fine inside JSX text.
  return s
    .replace(/&/g, "&amp;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Indent every line of a JSX fragment by a given prefix.  First
 *  line is left as-is (the surrounding template provides its
 *  prefix). */
export function indentJsx(tsx: string, prefix: string): string {
  const lines = tsx.split("\n");
  return lines.map((l, i) => (i === 0 ? l : prefix + l)).join("\n");
}
