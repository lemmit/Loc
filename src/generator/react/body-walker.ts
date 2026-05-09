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

import type { ExprIR } from "../../ir/loom-ir.js";

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

export function walkBodyToTsx(body: ExprIR): WalkResult {
  const ctx: WalkContext = { imports: new Set() };
  const tsx = walk(body, ctx, 0);
  return { tsx, imports: ctx.imports };
}

interface WalkContext {
  imports: Set<MantineImport>;
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
      // Bare references (e.g. `customerId` in scope) emit as JS
      // identifiers wrapped in JSX braces.  v0 doesn't yet thread
      // page params + state into render scope; if a `ref` makes it
      // here it usually means the user wrote a name that isn't a
      // component but the parser accepted it.  Emit a placeholder
      // comment so the build error surfaces clearly.
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
  // First positional is the heading text.  Optional `level:` named
  // arg controls Mantine's <Title order={N}> (1..6, default 2).
  const text = firstPositionalText(call) ?? "Heading";
  const level = numericNamed(call, "level") ?? 2;
  void depth;
  return `<Title order={${level}}>${escapeJsxText(text)}</Title>`;
}

function emitText(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  ctx.imports.add("Text");
  const text = firstPositionalText(call) ?? "";
  void depth;
  return `<Text>${escapeJsxText(text)}</Text>`;
}

function emitButton(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  ctx.imports.add("Button");
  const label = firstPositionalText(call) ?? "Button";
  void depth;
  // Slice 11.3 v0 — buttons emit unwired (no onClick).  Action
  // threading lands with the state / event-handler IR slice.
  return `<Button>${escapeJsxText(label)}</Button>`;
}

function emitCard(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  ctx.imports.add("Card");
  ctx.imports.add("Title");
  // Card("title", content) — first positional title; second
  // positional is the body.  Mantine's Card uses Card.Section for
  // the visual block separation.
  const title = firstPositionalText(call) ?? "";
  const positionals = positionalArgs(call);
  // v0: the title is the first positional STRING.  If positional
  // 0 is a string, positional 1 is the content; otherwise
  // positional 0 IS the content (no title).
  const titleArg = positionals[0];
  const titleIsString =
    titleArg !== undefined &&
    titleArg.kind === "literal" &&
    titleArg.lit === "string";
  const contentExpr: ExprIR | undefined = titleIsString
    ? positionals[1]
    : positionals[0];
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  const inner: string[] = [];
  if (titleIsString) {
    inner.push(`<Title order={3}>${escapeJsxText(title)}</Title>`);
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
 *  function component + return. */
export function renderCustomLayoutPage(
  pageName: string,
  body: ExprIR,
): string {
  const { tsx, imports } = walkBodyToTsx(body);
  const importLine =
    imports.size > 0
      ? `import { ${[...imports].sort().join(", ")} } from "@mantine/core";\n`
      : "";
  return `// Auto-generated.  Do not edit by hand.
${importLine}
export default function ${pageName}() {
  return (
    ${indentJsx(tsx, "    ")}
  );
}
`;
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
