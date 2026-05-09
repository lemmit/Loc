// Slice 11.3 — recursive body walker.
//
// Walks a page's body `ExprIR` and emits TSX for hand-written
// custom layouts that don't dispatch to one of the scaffold
// archetypes (List / Detail / Form / etc.).  Unlocks pages like:
//
//   page Welcome {
//     route: "/welcome"
//     body: Stack(
//       Heading("Welcome to Acme"),
//       Text("Pick a destination from the sidebar."),
//       Button("Go to orders")
//     )
//   }
//
// v0 stdlib (closed set):
//
//   Stack(...children)            → Mantine <Stack>...</Stack>
//   Heading("text", level: N)     → Mantine <Title order={N}>text</Title>
//   Text("text")                  → Mantine <Text>text</Text>
//   Button("label", ...)          → Mantine <Button>label</Button>
//   Card("title", content)        → Mantine <Card> with optional title
//                                    + <Card.Section>{content}</Card.Section>
//
// Each emitter follows the contract:
//   - First positional arg is the component's primary content (text /
//     label / title), unwrapped from its `ExprIR { kind: "literal" }`
//     when it's a string literal.
//   - Subsequent positional args are children (rendered recursively).
//   - Named args are picked off by hand per emitter (e.g. Heading
//     reads `level`).
//
// What v0 does NOT cover:
//   - Event handlers (onClick: () => navigate(...)).  Buttons emit
//     unwired in v0; click handling lands with the action / state
//     IR threading work.
//   - Nested arrays as children (e.g. `items: [...]`).  Spec syntax
//     is positional-only at this layer.
//   - Per-pack rendering.  v0 hardcodes Mantine output; a future
//     slice opens this through the template-pack layer (one
//     stdlib emitter per pack).
//
// What this module exports:
//   - `walkBodyToTsx(body)` — { tsx, imports } where `tsx` is the
//     JSX expression and `imports` is the Mantine specifiers that
//     need to be at the top of the page file.
//   - `isWalkableLayoutBody(body)` — predicate the page emitter
//     uses to decide whether to dispatch to the walker.

import type { ExprIR, ParamIR } from "../../ir/loom-ir.js";

/** Mantine specifiers the walker accumulates as it descends through
 *  the body.  Caller renders these as a single
 *  `import { Stack, Title, … } from "@mantine/core"` line at the
 *  top of the generated page file. */
export type MantineImport =
  | "Stack"
  | "Title"
  | "Text"
  | "Button"
  | "Card";

export interface WalkResult {
  tsx: string;
  imports: Set<MantineImport>;
  /** Slice 11.4 — names of route params the walker actually used
   *  while emitting (e.g. `Heading(name)` referenced `name`).  The
   *  page-shell generator destructures only the used names from
   *  `useParams()` so unused declarations don't trigger TS warnings. */
  usedParams: Set<string>;
  /** Slice 11.5 — true when any walked node emitted JSX that
   *  references the `navigate` symbol (e.g. `Button("…", to: …)`).
   *  The page-shell adds `import { useNavigate }` and a
   *  `const navigate = useNavigate();` line when set. */
  usesNavigate: boolean;
}

/** Component names the walker recognises.  Used by the page
 *  emitter to fast-fail dispatch when a body is neither a scaffold
 *  archetype nor a layout primitive — those pages stay silent. */
const STDLIB_LAYOUT_COMPONENTS = new Set<string>([
  "Stack",
  "Heading",
  "Text",
  "Button",
  "Card",
]);

export function isWalkableLayoutBody(body: ExprIR | undefined): boolean {
  if (!body) return false;
  if (body.kind !== "call") return false;
  return STDLIB_LAYOUT_COMPONENTS.has(body.name);
}

export function walkBodyToTsx(
  body: ExprIR,
  /** Slice 11.4 — names of the page's route params; refs to these
   *  names emit as `{name}` JSX expressions (resolved by
   *  `useParams()` at render time). */
  paramNames: ReadonlySet<string> = new Set(),
): WalkResult {
  const ctx: WalkContext = {
    imports: new Set(),
    paramNames,
    usedParams: new Set(),
    usesNavigate: false,
  };
  const tsx = walk(body, ctx, 0);
  return {
    tsx,
    imports: ctx.imports,
    usedParams: ctx.usedParams,
    usesNavigate: ctx.usesNavigate,
  };
}

interface WalkContext {
  imports: Set<MantineImport>;
  paramNames: ReadonlySet<string>;
  usedParams: Set<string>;
  usesNavigate: boolean;
}

function walk(expr: ExprIR, ctx: WalkContext, depth: number): string {
  switch (expr.kind) {
    case "call":
      return emitComponent(expr, ctx, depth);
    case "literal":
      // String literal in a child position becomes a JSX text node.
      // Other literal kinds (int / decimal / bool) stay as
      // expression-bracketed JS literals.
      if (expr.lit === "string") return escapeJsxText(expr.value);
      if (expr.lit === "bool") return `{${expr.value}}`;
      if (expr.lit === "null") return `{null}`;
      return `{${expr.value}}`;
    case "ref":
      // Slice 11.4 — refs that match a route param name emit as
      // JSX expressions (`{name}`).  React Router's `useParams()`
      // brings these into scope at render time; the page-shell
      // generator destructures the used names.  Refs that don't
      // match a param emit as a placeholder JSX comment so the
      // build error stays visible.
      if (ctx.paramNames.has(expr.name)) {
        ctx.usedParams.add(expr.name);
        return `{${expr.name}}`;
      }
      return `{/* ref: ${expr.name} */}`;
    default:
      return `{/* unsupported expr: ${expr.kind} */}`;
  }
}

function emitComponent(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  switch (call.name) {
    case "Stack":
      return emitStack(call, ctx, depth);
    case "Heading":
      return emitHeading(call, ctx, depth);
    case "Text":
      return emitText(call, ctx, depth);
    case "Button":
      return emitButton(call, ctx, depth);
    case "Card":
      return emitCard(call, ctx, depth);
    default:
      return `{/* unknown layout component: ${call.name} */}`;
  }
}

function emitStack(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  ctx.imports.add("Stack");
  // Every positional arg is a child; ignore named args in v0.
  const children = positionalChildren(call, ctx, depth + 1);
  if (children.length === 0) return `<Stack />`;
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return `<Stack>\n${indent}${children.join(`\n${indent}`)}\n${closeIndent}</Stack>`;
}

function emitHeading(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  ctx.imports.add("Title");
  // First positional is the heading text — accepts a string
  // literal OR a ref (e.g. a route-param name).  Optional `level:`
  // named arg controls Mantine's <Title order={N}> (1..6, default
  // 2).
  const text = firstPositionalContent(call, ctx) ?? '"Heading"';
  const level = numericNamed(call, "level") ?? 2;
  void depth;
  return `<Title order={${level}}>${unwrapTextLiteral(text)}</Title>`;
}

function emitText(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  ctx.imports.add("Text");
  const text = firstPositionalContent(call, ctx) ?? '""';
  void depth;
  return `<Text>${unwrapTextLiteral(text)}</Text>`;
}

function emitButton(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  ctx.imports.add("Button");
  const label = firstPositionalContent(call, ctx) ?? '"Button"';
  void depth;
  // Slice 11.5 — `to:` named arg wires the button to a React
  // Router navigate call.  Accepts either a string-literal path
  // (`to: "/orders"`) or a route-param ref (`to: id` → resolves
  // through useParams in the shell — the param name is added to
  // usedParams for shell destructuring).  Anything else falls
  // back to an unwired button + a placeholder comment so the
  // gap is visible.
  const to = stringOrRefArgValue(call, "to", ctx);
  if (to) {
    ctx.usesNavigate = true;
    return `<Button onClick={() => navigate(${to})}>${unwrapTextLiteral(label)}</Button>`;
  }
  // No action wiring — bare button.
  return `<Button>${unwrapTextLiteral(label)}</Button>`;
}

/** Slice 11.5 — read a named arg as a navigation target.  String
 *  literals come back JSON-quoted (`"\"/orders\""`); refs to a
 *  route param come back as a JS template literal that interpolates
 *  the param at render time (so `to: id` → `` `${id}` ``).  Returns
 *  undefined when the arg isn't present or isn't a recognised
 *  navigation source. */
function stringOrRefArgValue(
  call: ExprIR & { kind: "call" },
  name: string,
  ctx: WalkContext,
): string | undefined {
  const argNames = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] !== name) continue;
    const a = call.args[i]!;
    if (a.kind === "literal" && a.lit === "string") {
      return JSON.stringify(a.value);
    }
    if (a.kind === "ref" && ctx.paramNames.has(a.name)) {
      ctx.usedParams.add(a.name);
      return `\`\${${a.name}}\``;
    }
  }
  return undefined;
}

function emitCard(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  ctx.imports.add("Card");
  // Card("title", content) — first positional title (string or
  // ref); second positional is the body.  Mantine's Card uses
  // Card.Section for the visual block separation.
  const positionals = positionalArgs(call);
  const titleArg = positionals[0];
  const titleIsTextLike =
    titleArg !== undefined &&
    (titleArg.kind === "literal" && titleArg.lit === "string"
      || (titleArg.kind === "ref" && ctx.paramNames.has(titleArg.name)));
  const contentExpr: ExprIR | undefined = titleIsTextLike
    ? positionals[1]
    : positionals[0];
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  const inner: string[] = [];
  if (titleIsTextLike && titleArg) {
    ctx.imports.add("Title");
    const titleStr = renderTextContent(titleArg, ctx) ?? '""';
    inner.push(`<Title order={3}>${unwrapTextLiteral(titleStr)}</Title>`);
  }
  if (contentExpr) {
    inner.push(walk(contentExpr, ctx, depth + 1));
  }
  if (inner.length === 0) return `<Card />`;
  return `<Card withBorder padding="md">\n${indent}${inner.join(`\n${indent}`)}\n${closeIndent}</Card>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function positionalArgs(call: ExprIR & { kind: "call" }): ExprIR[] {
  const argNames = call.argNames ?? [];
  const out: ExprIR[] = [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] === undefined) out.push(call.args[i]!);
  }
  return out;
}

function positionalChildren(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string[] {
  return positionalArgs(call).map((a) => walk(a, ctx, depth));
}

function firstPositionalText(call: ExprIR & { kind: "call" }): string | undefined {
  const positionals = positionalArgs(call);
  const first = positionals[0];
  if (!first) return undefined;
  if (first.kind === "literal" && first.lit === "string") return first.value;
  return undefined;
}

/** Slice 11.4 — return the JSX-render shape of the first
 *  positional arg as a TEXT-position content.  Quoted strings
 *  come back as `"text"` (so callers wrap them in {} when needed
 *  or strip the quotes for direct JSX text); refs come back as
 *  `{name}` (already JSX-expression-wrapped).  Returns undefined
 *  when the first positional isn't a recognisable text source. */
function firstPositionalContent(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
): string | undefined {
  const positionals = positionalArgs(call);
  const first = positionals[0];
  if (!first) return undefined;
  return renderTextContent(first, ctx);
}

function renderTextContent(
  expr: ExprIR,
  ctx: WalkContext,
): string | undefined {
  if (expr.kind === "literal" && expr.lit === "string") {
    return JSON.stringify(expr.value);
  }
  if (expr.kind === "ref") {
    if (ctx.paramNames.has(expr.name)) {
      ctx.usedParams.add(expr.name);
      return `{${expr.name}}`;
    }
    // Slice 11.4 — unresolved ref in text position emits a JSX
    // comment so the user sees the unresolved name in the
    // generated file (the page still compiles; the comment makes
    // the gap visible).
    return `{/* ref: ${expr.name} */}`;
  }
  return undefined;
}

/** Slice 11.4 helper — `firstPositionalContent` returns either a
 *  `"quoted string"` or a `{paramRef}` JSX expression.  Components
 *  embedding the result in JSX text need quoted strings unwrapped
 *  to bare text; JSX expressions stay verbatim. */
function unwrapTextLiteral(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return escapeJsxText(JSON.parse(s) as string);
  }
  return s;
}

function numericNamed(
  call: ExprIR & { kind: "call" },
  name: string,
): number | undefined {
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

function escapeJsxText(s: string): string {
  // Replace `{` and `}` (which JSX would interpret as expression
  // delimiters) with their HTML entity equivalents.  Apostrophes /
  // quotes are fine inside JSX text.
  return s.replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");
}

/** Render the page-file shell around a walked body — imports +
 *  function component + return.
 *
 *  Slice 11.4 — when the page has typed route params, the walker
 *  is given their names.  If the body referenced any of them
 *  (`Heading(name)`, `Text(customerId)`), the shell adds a
 *  `useParams<{ name: string, customerId: string }>()` hook and
 *  destructures the names so the JSX expressions resolve at
 *  render time.  Unused params are NOT destructured (avoids TS
 *  "declared but never read" warnings) — but the type parameter
 *  always lists every declared param so the typed shape stays
 *  intact regardless of usage. */
export function renderCustomLayoutPage(
  pageName: string,
  body: ExprIR,
  params: ParamIR[] = [],
): string {
  const paramNames = new Set(params.map((p) => p.name));
  const { tsx, imports, usedParams, usesNavigate } = walkBodyToTsx(
    body,
    paramNames,
  );
  const mantineImport =
    imports.size > 0
      ? `import { ${[...imports].sort().join(", ")} } from "@mantine/core";\n`
      : "";
  const hasParams = params.length > 0;
  const routerSpecifiers: string[] = [];
  if (hasParams) routerSpecifiers.push("useParams");
  if (usesNavigate) routerSpecifiers.push("useNavigate");
  const reactRouterImport = routerSpecifiers.length > 0
    ? `import { ${routerSpecifiers.join(", ")} } from "react-router-dom";\n`
    : "";
  const paramsType = hasParams
    ? `<{ ${params.map((p) => `${p.name}: ${typeRefAsTsString(p)}`).join("; ")} }>`
    : "";
  const used = [...usedParams].sort();
  const paramsLine = used.length > 0
    ? `  const { ${used.join(", ")} } = useParams${paramsType}();\n`
    : hasParams
      ? `  useParams${paramsType}();\n`
      : "";
  const navigateLine = usesNavigate
    ? `  const navigate = useNavigate();\n`
    : "";
  return `// Auto-generated.  Do not edit by hand.
${reactRouterImport}${mantineImport}
export default function ${pageName}() {
${paramsLine}${navigateLine}  return (
    ${indentJsx(tsx, "    ")}
  );
}
`;
}

/** Render a `ParamIR` (route param) as the TS type the
 *  `useParams<{...}>()` generic should declare for it.  Slice 11.4
 *  v0 — every route param is `string` at the React-Router level;
 *  the original Loom type intent (e.g. `Id<Order>`) is preserved
 *  in the IR but doesn't affect the typed-useParams shape today.
 *  A future slice can layer `z.coerce` or similar at the page-
 *  shell to convert to the declared types. */
function typeRefAsTsString(p: ParamIR): string {
  void p;
  return "string";
}

/** Indent every line of a JSX fragment by a given prefix.  First
 *  line is left as-is (the surrounding template provides its
 *  prefix). */
function indentJsx(tsx: string, prefix: string): string {
  const lines = tsx.split("\n");
  return lines
    .map((l, i) => (i === 0 ? l : prefix + l))
    .join("\n");
}
