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

import type {
  ExprIR,
  ParamIR,
  StateFieldIR,
  StmtIR,
  TypeIR,
} from "../../ir/loom-ir.js";

/** Mantine specifiers the walker accumulates as it descends through
 *  the body.  Caller renders these as a single
 *  `import { Stack, Title, … } from "@mantine/core"` line at the
 *  top of the generated page file. */
export type MantineImport =
  | "Stack"
  | "Group"
  | "Grid"
  | "Tabs"
  | "Center"
  | "TextInput"
  | "Switch"
  | "Anchor"
  | "Image"
  | "Avatar"
  | "Title"
  | "Text"
  | "Button"
  | "Card"
  | "Badge"
  | "Divider";

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
  /** Slice 11.7 — true when any walked node emitted JSX that needs
   *  a `useState` hook in scope (state-field refs in the body or
   *  `setX(...)` calls in event handlers).  The shell emits a
   *  `useState` import + per-field `const [x, setX] = useState(...)`
   *  declarations when set. */
  usesState: boolean;
  /** Slice 11.15 — true when any walked node emitted JSX that
   *  references React Router's `Link` component (e.g.
   *  `Anchor("…", to: …)` → `<Anchor component={Link}>`).  The
   *  shell adds `Link` to the existing react-router-dom import. */
  usesRouterLink: boolean;
}

/** Component names the walker recognises.  Used by the page
 *  emitter to fast-fail dispatch when a body is neither a scaffold
 *  archetype nor a layout primitive — those pages stay silent. */
const STDLIB_LAYOUT_COMPONENTS = new Set<string>([
  "Stack",
  "Group",
  "Grid",
  "Tabs",
  "Toolbar",
  "Empty",
  "Field",
  "Toggle",
  "Anchor",
  "Image",
  "Avatar",
  "Heading",
  "Text",
  "Button",
  "Card",
  "Stat",
  "Badge",
  "Divider",
]);

export function isWalkableLayoutBody(body: ExprIR | undefined): boolean {
  if (!body) return false;
  if (body.kind === "call") return STDLIB_LAYOUT_COMPONENTS.has(body.name);
  // Slice 11.17 — top-level conditional bodies dispatch through the
  // walker as long as either branch is walkable.  Powers patterns
  // like `body: loading ? Empty("…") : Stack(…)`.
  if (body.kind === "ternary") {
    return isWalkableLayoutBody(body.then) || isWalkableLayoutBody(body.otherwise);
  }
  return false;
}

export function walkBodyToTsx(
  body: ExprIR,
  /** Slice 11.4 — names of the page's route params; refs to these
   *  names emit as `{name}` JSX expressions (resolved by
   *  `useParams()` at render time). */
  paramNames: ReadonlySet<string> = new Set(),
  /** Slice 11.7 — names of the page's `state {}` fields; refs in
   *  body position emit as `{name}` JSX expressions (resolved by
   *  `useState` in the shell), and `:=` assignments in event-
   *  handler lambdas lower to the React `setX(...)` setter. */
  stateNames: ReadonlySet<string> = new Set(),
): WalkResult {
  const ctx: WalkContext = {
    imports: new Set(),
    paramNames,
    usedParams: new Set(),
    usesNavigate: false,
    stateNames,
    usesState: false,
    usesRouterLink: false,
  };
  const tsx = walk(body, ctx, 0);
  return {
    tsx,
    imports: ctx.imports,
    usedParams: ctx.usedParams,
    usesNavigate: ctx.usesNavigate,
    usesState: ctx.usesState,
    usesRouterLink: ctx.usesRouterLink,
  };
}

interface WalkContext {
  imports: Set<MantineImport>;
  paramNames: ReadonlySet<string>;
  usedParams: Set<string>;
  usesNavigate: boolean;
  stateNames: ReadonlySet<string>;
  usesState: boolean;
  usesRouterLink: boolean;
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
      // Slice 11.7 — refs that match a state field name emit the
      // same way; the shell brings them into scope via `useState`.
      if (ctx.stateNames.has(expr.name)) {
        ctx.usesState = true;
        return `{${expr.name}}`;
      }
      return `{/* ref: ${expr.name} */}`;
    case "ternary": {
      // Slice 11.17 — conditional rendering.  `cond ? <A /> : <B />`
      // works as a top-level body (depth 0 — JSX-element inside the
      // function's `return ( … )` parens).  In nested child
      // position, JSX requires brace-wrapping `{ cond ? … : … }`.
      const cond = emitExpr(expr.cond, ctx);
      const thenS = walk(expr.then, ctx, depth + 1);
      const elseS = walk(expr.otherwise, ctx, depth + 1);
      const inner = `${cond} ? (\n${"  ".repeat(depth + 1)}${thenS}\n${"  ".repeat(depth)}) : (\n${"  ".repeat(depth + 1)}${elseS}\n${"  ".repeat(depth)})`;
      return depth === 0 ? inner : `{${inner}}`;
    }
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
    case "Group":
      return emitGroup(call, ctx, depth);
    case "Grid":
      return emitGrid(call, ctx, depth);
    case "Tabs":
      return emitTabs(call, ctx, depth);
    case "Toolbar":
      return emitToolbar(call, ctx, depth);
    case "Empty":
      return emitEmpty(call, ctx, depth);
    case "Field":
      return emitField(call, ctx, depth);
    case "Toggle":
      return emitToggle(call, ctx, depth);
    case "Anchor":
      return emitAnchor(call, ctx, depth);
    case "Image":
      return emitImage(call, ctx, depth);
    case "Avatar":
      return emitAvatar(call, ctx, depth);
    case "Heading":
      return emitHeading(call, ctx, depth);
    case "Text":
      return emitText(call, ctx, depth);
    case "Button":
      return emitButton(call, ctx, depth);
    case "Card":
      return emitCard(call, ctx, depth);
    case "Stat":
      return emitStat(call, ctx, depth);
    case "Badge":
      return emitBadge(call, ctx, depth);
    case "Divider":
      return emitDivider(call, ctx, depth);
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

function emitGroup(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Mirror of Stack but horizontal — Mantine's <Group> is the
  // canonical row-flex container.  Same children-as-positionals
  // contract.
  ctx.imports.add("Group");
  const children = positionalChildren(call, ctx, depth + 1);
  if (children.length === 0) return `<Group />`;
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return `<Group>\n${indent}${children.join(`\n${indent}`)}\n${closeIndent}</Group>`;
}

function emitGrid(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Mantine's Grid wants each child wrapped in a <Grid.Col>.  v0
  // gives every column `span="auto"` so Mantine fills equally;
  // future slice can read a `span:` named arg per child once we
  // have a richer per-child config story.
  ctx.imports.add("Grid");
  const children = positionalChildren(call, ctx, depth + 2);
  if (children.length === 0) return `<Grid />`;
  const colIndent = "  ".repeat(depth + 1);
  const childIndent = "  ".repeat(depth + 2);
  const closeIndent = "  ".repeat(depth);
  const wrapped = children
    .map(
      (c) =>
        `<Grid.Col span="auto">\n${childIndent}${c}\n${colIndent}</Grid.Col>`,
    )
    .join(`\n${colIndent}`);
  return `<Grid>\n${colIndent}${wrapped}\n${closeIndent}</Grid>`;
}

function emitTabs(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Tabs(Tab("Overview", body), Tab("Settings", body))
  //   → Mantine <Tabs defaultValue="overview">
  //       <Tabs.List>
  //         <Tabs.Tab value="overview">Overview</Tabs.Tab>
  //         <Tabs.Tab value="settings">Settings</Tabs.Tab>
  //       </Tabs.List>
  //       <Tabs.Panel value="overview">{body}</Tabs.Panel>
  //       <Tabs.Panel value="settings">{body}</Tabs.Panel>
  //     </Tabs>
  //
  // Each positional child must be a `Tab(label, body)` call;
  // anything else lands as a comment placeholder so the page
  // still compiles.  Tab labels must be string literals in v0
  // (the tab `value` attribute is a slug derived from the label
  // — non-literal labels fall back to indexed slugs `tab-1`, …).
  ctx.imports.add("Tabs");
  const positionals = positionalArgs(call);
  type TabEntry = { value: string; label: string; body: ExprIR | undefined };
  const tabs: TabEntry[] = positionals.map((arg, i) => {
    if (arg.kind !== "call" || arg.name !== "Tab") {
      return { value: `tab-${i + 1}`, label: `Tab ${i + 1}`, body: undefined };
    }
    const tabPositionals = positionalArgs(arg);
    const labelArg = tabPositionals[0];
    const bodyArg = tabPositionals[1];
    const labelStr =
      labelArg && labelArg.kind === "literal" && labelArg.lit === "string"
        ? labelArg.value
        : `Tab ${i + 1}`;
    return { value: slugify(labelStr) || `tab-${i + 1}`, label: labelStr, body: bodyArg };
  });
  if (tabs.length === 0) return `<Tabs defaultValue="" />`;
  const indent = "  ".repeat(depth + 1);
  const innerIndent = "  ".repeat(depth + 2);
  const closeIndent = "  ".repeat(depth);
  const tabHeaders = tabs
    .map(
      (t) =>
        `<Tabs.Tab value=${JSON.stringify(t.value)}>${escapeJsxText(t.label)}</Tabs.Tab>`,
    )
    .join(`\n${innerIndent}`);
  const panels = tabs
    .map((t) => {
      const inner = t.body
        ? walk(t.body, ctx, depth + 2)
        : `{/* missing tab body */}`;
      return `<Tabs.Panel value=${JSON.stringify(t.value)}>\n${innerIndent}${inner}\n${indent}</Tabs.Panel>`;
    })
    .join(`\n${indent}`);
  return `<Tabs defaultValue=${JSON.stringify(tabs[0]!.value)}>\n${indent}<Tabs.List>\n${innerIndent}${tabHeaders}\n${indent}</Tabs.List>\n${indent}${panels}\n${closeIndent}</Tabs>`;
}

/** Slice 11.11 — kebab-case-style slugifier for Tab.value
 *  attributes.  Lowercases, strips non-alphanumerics down to
 *  hyphens, collapses runs.  Maps `"User Settings"` → `"user-
 *  settings"`. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function emitToolbar(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Toolbar(...children) — same children-as-positionals contract
  // as Group, but with `justify="space-between"` to push left- and
  // right-aligned children apart (canonical page-header layout).
  ctx.imports.add("Group");
  const children = positionalChildren(call, ctx, depth + 1);
  if (children.length === 0) return `<Group justify="space-between" />`;
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return `<Group justify="space-between">\n${indent}${children.join(`\n${indent}`)}\n${closeIndent}</Group>`;
}

function emitEmpty(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Empty("No results yet") — empty-state placeholder.  Mantine
  // has no dedicated component; v0 composes a centered dimmed
  // text block.  The first positional is the message; refs / ops
  // welcome (routes through renderTextContent).
  ctx.imports.add("Center");
  ctx.imports.add("Text");
  const msg = firstPositionalContent(call, ctx) ?? '"No results."';
  void depth;
  return `<Center mih={200}><Text c="dimmed">${unwrapTextLiteral(msg)}</Text></Center>`;
}

function emitField(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Field("Label", bind: <state-field>) — Mantine TextInput
  // bound to a state field via two-way binding (value + onChange
  // → setX).  The first positional is the label (string lit / ref
  // / binary op); `bind:` is required for v0 — without it, the
  // input is uncontrolled and falls back to a label-only stub.
  ctx.imports.add("TextInput");
  void depth;
  const label = firstPositionalContent(call, ctx) ?? '""';
  const bind = stateBindArg(call, "bind", ctx);
  if (bind === undefined) {
    return `<TextInput label=${unwrapAsAttr(label)} />`;
  }
  const setter = "set" + bind[0]!.toUpperCase() + bind.slice(1);
  return `<TextInput label=${unwrapAsAttr(label)} value={${bind}} onChange={(e) => ${setter}(e.currentTarget.value)} />`;
}

function emitToggle(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Toggle("Label", bind: <bool state field>) — Mantine Switch
  // bound to a bool state field.  Same shape as Field but
  // checked + e.currentTarget.checked.
  ctx.imports.add("Switch");
  void depth;
  const label = firstPositionalContent(call, ctx) ?? '""';
  const bind = stateBindArg(call, "bind", ctx);
  if (bind === undefined) {
    return `<Switch label=${unwrapAsAttr(label)} />`;
  }
  const setter = "set" + bind[0]!.toUpperCase() + bind.slice(1);
  return `<Switch label=${unwrapAsAttr(label)} checked={${bind}} onChange={(e) => ${setter}(e.currentTarget.checked)} />`;
}

function emitAnchor(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Anchor("label", to: "/path")        — text-style link.  Mantine's
  // <Anchor> with `component={Link}` (React Router) gives styled
  // SPA navigation; without `to:`, falls through to a bare
  // <Anchor> (no href — visible no-op for the user).
  ctx.imports.add("Anchor");
  void depth;
  const label = firstPositionalContent(call, ctx) ?? '"link"';
  const to = stringOrRefArgValue(call, "to", ctx);
  if (to) {
    ctx.usesRouterLink = true;
    return `<Anchor component={Link} to=${to}>${unwrapTextLiteral(label)}</Anchor>`;
  }
  return `<Anchor>${unwrapTextLiteral(label)}</Anchor>`;
}

function emitImage(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Image(src: "...", alt: "...")  — Mantine <Image>.
  // Both attrs accept string literals or refs; missing src falls
  // back to a comment placeholder (the `src` attr is omitted, so
  // Mantine renders its built-in fallback).
  ctx.imports.add("Image");
  void depth;
  const src = stringOrRefArgValue(call, "src", ctx);
  const alt = stringOrRefArgValue(call, "alt", ctx);
  const attrs: string[] = [];
  if (src) attrs.push(`src=${src}`);
  if (alt) attrs.push(`alt=${alt}`);
  return `<Image${attrs.length > 0 ? " " + attrs.join(" ") : ""} />`;
}

function emitAvatar(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Avatar(src: "...", alt: "...") — Mantine <Avatar>.  Without
  // src, Mantine renders the user-icon fallback.
  ctx.imports.add("Avatar");
  void depth;
  const src = stringOrRefArgValue(call, "src", ctx);
  const alt = stringOrRefArgValue(call, "alt", ctx);
  const attrs: string[] = [];
  if (src) attrs.push(`src=${src}`);
  if (alt) attrs.push(`alt=${alt}`);
  return `<Avatar${attrs.length > 0 ? " " + attrs.join(" ") : ""} />`;
}

/** Slice 11.14 — read a `bind:` named arg as a state-field name.
 *  Returns the field name when the arg is a `ref` to a known
 *  state field (and marks `usesState` on the context); otherwise
 *  undefined.  Drives controlled-input wiring in Field / Toggle. */
function stateBindArg(
  call: ExprIR & { kind: "call" },
  name: string,
  ctx: WalkContext,
): string | undefined {
  const argNames = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] !== name) continue;
    const a = call.args[i]!;
    if (a.kind === "ref" && ctx.stateNames.has(a.name)) {
      ctx.usesState = true;
      return a.name;
    }
  }
  return undefined;
}

/** Slice 11.14 — render a renderTextContent() result as a JSX
 *  attribute value.  Quoted strings stay quoted; JSX-expression
 *  values (already brace-wrapped) stay brace-wrapped. */
function unwrapAsAttr(s: string): string {
  if (s.length >= 2 && s.startsWith("{") && s.endsWith("}")) return s;
  return s; // already a quoted string literal — JSX accepts it
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
  // Slice 11.7 — `onClick:` lambda named arg wires the button to
  // a multi-statement event handler.  Lambda block-body lowers
  // statement-by-statement: `:=` against a state field becomes
  // `setX(...)`; bare expressions are emitted as-is.  Takes
  // priority over `to:` if both are written (more general).
  const onClick = lambdaArg(call, "onClick");
  if (onClick && (onClick.block || onClick.body)) {
    const handler = emitLambdaBody(onClick, ctx);
    return `<Button onClick={${handler}}>${unwrapTextLiteral(label)}</Button>`;
  }
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

/** Slice 11.7 — extract a lambda-shaped named arg from a call.
 *  Returns the lambda IR sub-node (its `param`/`body`/`block`
 *  fields) so callers can emit the handler.  Returns undefined
 *  when the named arg is missing or isn't a lambda. */
function lambdaArg(
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

/** Render a Lambda IR as a TS arrow function suitable for an event
 *  handler position.  The lambda's source-side `param` name is
 *  dropped — v0 walker output is event-data-agnostic and emitting
 *  `() => …` keeps the generated code clean (no unused-var
 *  warnings).  Block-body lambdas emit a brace-wrapped sequence of
 *  statements; expression-body lambdas emit a single expression. */
function emitLambdaBody(
  lam: ExprIR & { kind: "lambda" },
  ctx: WalkContext,
): string {
  if (lam.block && lam.block.length > 0) {
    const stmts = lam.block.map((s) => emitStmt(s, ctx)).join(" ");
    return `() => { ${stmts} }`;
  }
  if (lam.body) {
    return `() => ${emitExpr(lam.body, ctx)}`;
  }
  return `() => {}`;
}

/** Render an `ExprIR` as a JS-expression string (NOT JSX).  Used
 *  for the right-hand side of state assignments (`count := count +
 *  1` → `count + 1`) and lambda expression bodies.  State + param
 *  refs render as bare identifiers (they're in scope via
 *  `useState` / `useParams` destructure). */
function emitExpr(expr: ExprIR, ctx: WalkContext): string {
  switch (expr.kind) {
    case "literal":
      if (expr.lit === "string") return JSON.stringify(expr.value);
      if (expr.lit === "bool") return expr.value;
      if (expr.lit === "null") return "null";
      // int / decimal / now → emit as numeric literal verbatim.
      return String(expr.value);
    case "ref":
      if (ctx.stateNames.has(expr.name)) {
        ctx.usesState = true;
        return expr.name;
      }
      if (ctx.paramNames.has(expr.name)) {
        ctx.usedParams.add(expr.name);
        return expr.name;
      }
      return `/* unresolved: ${expr.name} */ undefined`;
    case "binary":
      return `(${emitExpr(expr.left, ctx)} ${expr.op} ${emitExpr(expr.right, ctx)})`;
    case "unary":
      return `(${expr.op}${emitExpr(expr.operand, ctx)})`;
    default:
      return `/* unsupported expr: ${expr.kind} */ undefined`;
  }
}

/** Render a `StmtIR` as a TS statement string (with a trailing
 *  semicolon).  v0 supports the subset that matters for click
 *  handlers: state mutation (`:=`, `+=`, `-=`), let-binding, and
 *  bare expression statements.  emit / call statements fall
 *  through to a comment for now. */
function emitStmt(stmt: StmtIR, ctx: WalkContext): string {
  switch (stmt.kind) {
    case "assign": {
      const seg = stmt.target.segments;
      if (seg.length === 1 && ctx.stateNames.has(seg[0]!)) {
        ctx.usesState = true;
        const name = seg[0]!;
        const setter = "set" + name[0]!.toUpperCase() + name.slice(1);
        return `${setter}(${emitExpr(stmt.value, ctx)});`;
      }
      return `/* unsupported assign: ${seg.join(".")} */`;
    }
    case "add":
    case "remove": {
      // Slice 11.9 — `count += 1` / `count -= 1` lower to
      // `kind: "add"` / `kind: "remove"` in the IR (the same
      // kinds collection-mutations use; for scalar state fields
      // they're compound additions/subtractions).  Walker emits
      // `setCount(count + 1)` / `setCount(count - 1)`.
      const seg = stmt.target.segments;
      if (seg.length === 1 && ctx.stateNames.has(seg[0]!)) {
        ctx.usesState = true;
        const name = seg[0]!;
        const setter = "set" + name[0]!.toUpperCase() + name.slice(1);
        const op = stmt.kind === "add" ? "+" : "-";
        return `${setter}(${name} ${op} ${emitExpr(stmt.value, ctx)});`;
      }
      return `/* unsupported ${stmt.kind === "add" ? "+=" : "-="}: ${seg.join(".")} */`;
    }
    case "let":
      return `const ${stmt.name} = ${emitExpr(stmt.expr, ctx)};`;
    case "expression":
      return `${emitExpr(stmt.expr, ctx)};`;
    default:
      return `/* unsupported stmt: ${stmt.kind} */`;
  }
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
  // Card("title", content) — first positional title; second
  // positional is the body.  Mantine's Card uses Card.Section for
  // the visual block separation.
  //
  // Slice 11.10 — title detection: anything that's NOT a call
  // expression is treated as the title (string literals, refs,
  // binary ops, etc).  Calls are child components and skip the
  // title slot — `Card(child)` renders a card with no heading.
  const positionals = positionalArgs(call);
  const titleArg = positionals[0];
  const titleIsTextLike =
    titleArg !== undefined && titleArg.kind !== "call";
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

function emitStat(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Stat(label, value) — small headline-stat card.  Mantine has no
  // dedicated Stat component; the v0 emitter renders a Group of two
  // stacked Texts (dimmed label + bold value).  Both slots accept
  // string literals or route-param refs.
  ctx.imports.add("Stack");
  ctx.imports.add("Text");
  const positionals = positionalArgs(call);
  const labelArg = positionals[0];
  const valueArg = positionals[1];
  const label = labelArg ? renderTextContent(labelArg, ctx) ?? '""' : '""';
  const value = valueArg ? renderTextContent(valueArg, ctx) ?? '""' : '""';
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return `<Stack gap={2}>\n${indent}<Text size="sm" c="dimmed">${unwrapTextLiteral(label)}</Text>\n${indent}<Text fw={700} size="xl">${unwrapTextLiteral(value)}</Text>\n${closeIndent}</Stack>`;
}

function emitBadge(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  ctx.imports.add("Badge");
  const label = firstPositionalContent(call, ctx) ?? '"Badge"';
  void depth;
  return `<Badge>${unwrapTextLiteral(label)}</Badge>`;
}

function emitDivider(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  ctx.imports.add("Divider");
  void depth;
  // Optional `label:` named arg — Mantine Divider accepts a string
  // label rendered inline with the rule.
  const label = stringNamed(call, "label");
  if (label !== undefined) {
    return `<Divider label=${JSON.stringify(label)} labelPosition="center" />`;
  }
  return `<Divider />`;
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
    if (ctx.stateNames.has(expr.name)) {
      ctx.usesState = true;
      return `{${expr.name}}`;
    }
    // Slice 11.4 — unresolved ref in text position emits a JSX
    // comment so the user sees the unresolved name in the
    // generated file (the page still compiles; the comment makes
    // the gap visible).
    return `{/* ref: ${expr.name} */}`;
  }
  // Slice 11.10 — anything else (binary op, unary, non-string
  // literal): emit the JS-expression form wrapped as a JSX
  // expression.  Powers patterns like `Heading("Welcome, " +
  // name)`, `Text(count + 1)`, `Stat("Count", count * step)`.
  // Calls fall through to undefined — those are child components,
  // not text content, and should be walked through `walk` instead.
  if (expr.kind === "call") return undefined;
  return `{${emitExpr(expr, ctx)}}`;
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

function stringNamed(
  call: ExprIR & { kind: "call" },
  name: string,
): string | undefined {
  const argNames = call.argNames ?? [];
  for (let i = 0; i < call.args.length; i++) {
    if (argNames[i] !== name) continue;
    const a = call.args[i]!;
    if (a.kind === "literal" && a.lit === "string") return a.value;
  }
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
  state: StateFieldIR[] = [],
  /** Slice 11.12 — page-level `title:` expression.  Renders into a
   *  `useEffect` that sets `document.title` on mount and whenever
   *  any referenced param/state changes (deps array auto-derived
   *  from the title expression's refs). */
  title: ExprIR | undefined = undefined,
): string {
  const paramNames = new Set(params.map((p) => p.name));
  const stateNames = new Set(state.map((s) => s.name));
  const { tsx, imports, usedParams, usesNavigate, usesState, usesRouterLink } = walkBodyToTsx(
    body,
    paramNames,
    stateNames,
  );
  // Slice 11.12 — render the title expression through emitExpr
  // (sharing the body's tracking state so the shell destructures
  // any param/state the title references).  Compute the deps
  // array from the title's referenced names so the effect re-runs
  // when those values change.
  let titleEffect = "";
  let usesEffect = false;
  let usesStateForTitle = false;
  if (title !== undefined) {
    const titleCtx: WalkContext = {
      imports,
      paramNames,
      usedParams,
      usesNavigate,
      stateNames,
      usesState,
      usesRouterLink: false,
    };
    const titleExpr = emitExpr(title, titleCtx);
    // emitExpr may have added to usedParams; reflect title's state
    // usage separately so the shell knows whether to import useState.
    usesStateForTitle = titleCtx.usesState && !usesState;
    const refs = new Set<string>();
    collectExprRefs(title, refs);
    const deps = [...refs]
      .filter((n) => paramNames.has(n) || stateNames.has(n))
      .sort();
    titleEffect = `  useEffect(() => { document.title = ${titleExpr}; }, [${deps.join(", ")}]);\n`;
    usesEffect = true;
  }
  const effectiveUsesState = usesState || usesStateForTitle;

  const mantineImport =
    imports.size > 0
      ? `import { ${[...imports].sort().join(", ")} } from "@mantine/core";\n`
      : "";
  const hasParams = params.length > 0;
  const routerSpecifiers: string[] = [];
  if (hasParams) routerSpecifiers.push("useParams");
  if (usesNavigate) routerSpecifiers.push("useNavigate");
  if (usesRouterLink) routerSpecifiers.push("Link");
  const reactRouterImport = routerSpecifiers.length > 0
    ? `import { ${routerSpecifiers.join(", ")} } from "react-router-dom";\n`
    : "";
  // Slice 11.7 — emit the `useState` hook + per-field declaration
  // when any state ref or `:=` mutation surfaced during the walk.
  // Pages that DECLARE state but never reference it from the body
  // skip the import so unused-var warnings stay quiet (parallel to
  // how `usedParams` shapes the useParams destructure).
  // Slice 11.12 — `useEffect` joins the same React import line.
  const reactSpecifiers: string[] = [];
  if (effectiveUsesState) reactSpecifiers.push("useState");
  if (usesEffect) reactSpecifiers.push("useEffect");
  const reactImport = reactSpecifiers.length > 0
    ? `import { ${reactSpecifiers.join(", ")} } from "react";\n`
    : "";
  const stateLines = effectiveUsesState
    ? state.map((f) => `  ${renderUseState(f)}\n`).join("")
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
${reactImport}${reactRouterImport}${mantineImport}
export default function ${pageName}() {
${paramsLine}${navigateLine}${stateLines}${titleEffect}  return (
    ${indentJsx(tsx, "    ")}
  );
}
`;
}

/** Slice 11.12 — collect every name referenced in an expression
 *  (via `ref` nodes), used to derive the deps array for the
 *  title's `useEffect`.  Walks binary / unary / call subtrees. */
function collectExprRefs(expr: ExprIR, out: Set<string>): void {
  switch (expr.kind) {
    case "ref":
      out.add(expr.name);
      return;
    case "binary":
      collectExprRefs(expr.left, out);
      collectExprRefs(expr.right, out);
      return;
    case "unary":
      collectExprRefs(expr.operand, out);
      return;
    case "call":
      for (const a of expr.args) collectExprRefs(a, out);
      return;
    default:
      return;
  }
}

/** Slice 11.7 — render one `state {}` field as a React `useState`
 *  declaration: `const [name, setName] = useState<T>(init);`.  Init
 *  comes from the field's optional `=` initializer; absent
 *  initializers fall back to the type's zero value. */
function renderUseState(field: StateFieldIR): string {
  const setter = "set" + field.name[0]!.toUpperCase() + field.name.slice(1);
  const tsType = stateTypeAsTsString(field.type);
  const init = field.init !== undefined
    ? renderInitExpr(field.init)
    : zeroValueForType(field.type);
  return `const [${field.name}, ${setter}] = useState<${tsType}>(${init});`;
}

/** Render a state-field initializer ExprIR as a JS expression
 *  string.  Reuses the same shape `emitExpr` produces but runs
 *  with an empty context — initializers can't reference state or
 *  params (they evaluate at component-mount time). */
function renderInitExpr(expr: ExprIR): string {
  // Empty walker context — init expressions don't see state /
  // params (they evaluate before the hooks run).
  const dummy: WalkContext = {
    imports: new Set(),
    paramNames: new Set(),
    usedParams: new Set(),
    usesNavigate: false,
    stateNames: new Set(),
    usesState: false,
    usesRouterLink: false,
  };
  return emitExpr(expr, dummy);
}

/** Map a Loom `TypeIR` to the TS type used in `useState<T>(...)`.
 *  v0 covers the primitives that show up in click-counter-shaped
 *  toy pages; complex types fall back to `any`. */
function stateTypeAsTsString(type: TypeIR): string {
  if (type.kind === "primitive") {
    switch (type.name) {
      case "int":
      case "long":
      case "decimal":
        return "number";
      case "bool":
        return "boolean";
      case "string":
      case "datetime":
      case "guid":
        return "string";
    }
  }
  if (type.kind === "id" || type.kind === "enum") return "string";
  if (type.kind === "optional") {
    return `${stateTypeAsTsString(type.inner)} | undefined`;
  }
  return "any";
}

/** Default initial value for a state field that doesn't declare an
 *  `=` initializer.  Mirrors the spec §6 zero-value table. */
function zeroValueForType(type: TypeIR): string {
  if (type.kind === "primitive") {
    switch (type.name) {
      case "int":
      case "long":
      case "decimal":
        return "0";
      case "bool":
        return "false";
      case "string":
      case "datetime":
      case "guid":
        return '""';
    }
  }
  if (type.kind === "id" || type.kind === "enum") return '""';
  if (type.kind === "optional") return "undefined";
  return "undefined";
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
