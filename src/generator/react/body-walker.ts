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

import type { ImportSpec, LoadedPack } from "./templating/loader.js";
import type {
  ExprIR,
  ParamIR,
  StateFieldIR,
  StmtIR,
  TypeIR,
  UiApiParamIR,
} from "../../ir/loom-ir.js";
import { camel, pascal, plural, snake } from "../../util/naming.js";

/** Per-source named-import map — `from` module → set of named
 *  exports the page needs from it.  Replaces the old single-source
 *  `Set<MantineImport>` so primitives ported through the pack
 *  contract can declare their own imports (shadcn pulls
 *  `@/components/ui/button`, lucide-react, etc., not just Mantine).
 *
 *  Existing emit functions that haven't yet been ported to the
 *  pack contract use `addMantineImport` (below) which appends to
 *  this map keyed by `"@mantine/core"`.  The page-shell consumer
 *  iterates the map and emits one `import` line per source. */
export type ImportMap = Map<string, Set<string>>;

/** Append a named-import to the walker's per-source import map.
 *  Idempotent — duplicate names dedupe inside the Set per source. */
function addImport(ctx: WalkContext, from: string, ...names: string[]): void {
  let s = ctx.imports.get(from);
  if (!s) {
    s = new Set();
    ctx.imports.set(from, s);
  }
  for (const n of names) s.add(n);
}

/** Convenience for the (still many) emit functions that haven't been
 *  ported to the pack contract yet — they all want named imports
 *  from `@mantine/core`.  Keeps call sites compact and grep-able
 *  while the migration finishes. */
function addMantineImport(ctx: WalkContext, ...names: string[]): void {
  addImport(ctx, "@mantine/core", ...names);
}

/** Render a primitive through the pack and merge its declared
 *  imports into the context.  Each primitive's `imports` entry in
 *  pack.json drives the `<from>` and `<named>` set added to the
 *  page's import block.  When the pack manifest doesn't list a
 *  primitive in `imports`, we render anyway and rely on the
 *  template emitting whatever module-free JSX it wants
 *  (e.g. shadcn's primitives that emit only `<div className=…>`
 *  need no imports). */
function renderPrimitive(
  ctx: WalkContext,
  name: string,
  templateCtx: unknown,
): string {
  const specs: ImportSpec[] = ctx.pack.manifest.imports?.[name] ?? [];
  for (const spec of specs) addImport(ctx, spec.from, ...spec.named);
  return ctx.pack.render(name, templateCtx);
}

/** Render the page's import block from the per-source map.  One
 *  `import { … } from "<from>";` line per source, alphabetically
 *  sorted within each line and sources sorted by `from`.  Empty
 *  map renders as an empty string so callers can splice the
 *  result without a guard. */
export function renderImportLines(imports: ImportMap): string {
  if (imports.size === 0) return "";
  const lines = [...imports.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([from, named]) =>
      `import { ${[...named].sort().join(", ")} } from "${from}";\n`,
    );
  return lines.join("");
}

export interface WalkResult {
  tsx: string;
  imports: ImportMap;
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
  /** Slice 11.18 — names of user-defined components the walker
   *  invoked while emitting (e.g. `WelcomeBox("Alice")` →
   *  `<WelcomeBox name="Alice" />`).  The shell emits per-name
   *  imports from `@/components/<Name>`. */
  usedUserComponents: Set<string>;
  /** Slice 11.19 — true when the walked tree referenced `Slot()`
   *  (the children-prop placeholder).  Component shells with this
   *  set add a `children?: React.ReactNode` prop to their typed
   *  Props interface. */
  usesChildren: boolean;
  /** Slice 11.24 — collected api-hook usages.  Each unique
   *  `<paramName>.<aggregate>.<op>` reference in the body becomes
   *  one entry — the shell emits a `const <varName> = use<Op>()`
   *  declaration at page-top + an import.  Body refs are
   *  rewritten to use the local var. */
  usedApiHooks: Map<string, ApiHookUse>;
}

/** A single auto-injected React Query hook call.  Generated when
 *  the walker detects `<param>.<aggregate>.<op>(args?)` in body
 *  position; consumed by `renderCustomLayoutPage` / `renderUserComponentFile`
 *  to emit the per-page hook plumbing. */
export interface ApiHookUse {
  /** Local variable name in the generated React file
   *  (e.g. `customerAll`, `customerById`). */
  varName: string;
  /** React Query hook function name to import + call
   *  (e.g. `useAllCustomers`, `useCustomerById`). */
  hookName: string;
  /** Module-relative import path (e.g. `../api/customer`). */
  importFrom: string;
  /** Pre-rendered args to pass to the hook call (only set for
   *  parameterized queries like `byId(id)` — emitted at
   *  hook-decl time at page-top).  Rendered eagerly via the main
   *  WalkContext so any param/state refs in the args propagate
   *  to `usedParams` / `usesState` for the shell. */
  argsRendered: string[];
}

/** Component names the walker recognises.  Used by the page
 *  emitter to fast-fail dispatch when a body is neither a scaffold
 *  archetype nor a layout primitive — those pages stay silent. */
const STDLIB_LAYOUT_COMPONENTS = new Set<string>([
  "Stack",
  "Group",
  "Grid",
  "Container",
  "Tabs",
  "Toolbar",
  "Empty",
  "Field",
  "NumberField",
  "PasswordField",
  "Toggle",
  "Loader",
  "Anchor",
  "Image",
  "Avatar",
  "Slot",
  "Heading",
  "Text",
  "Button",
  "Card",
  "Stat",
  "Badge",
  "Divider",
]);

export function isWalkableLayoutBody(
  body: ExprIR | undefined,
  userComponents: ReadonlyMap<string, readonly ParamIR[]> = new Map(),
): boolean {
  if (!body) return false;
  if (body.kind === "call") {
    if (STDLIB_LAYOUT_COMPONENTS.has(body.name)) return true;
    // Slice 11.18 — calls to user-defined components are walker-
    // eligible too (resolved via the supplied map).
    return userComponents.has(body.name);
  }
  // Slice 11.17 — top-level conditional bodies dispatch through the
  // walker as long as either branch is walkable.  Powers patterns
  // like `body: loading ? Empty("…") : Stack(…)`.
  if (body.kind === "ternary") {
    return (
      isWalkableLayoutBody(body.then, userComponents) ||
      isWalkableLayoutBody(body.otherwise, userComponents)
    );
  }
  return false;
}

export function walkBodyToTsx(
  body: ExprIR,
  /** Loaded design pack — drives per-pack rendering for primitives
   *  ported through the pack contract.  Emits not yet ported still
   *  call `addMantineImport` directly; the pack reference is unused
   *  by them and harmless to thread through. */
  pack: LoadedPack,
  /** Slice 11.4 — names of the page's route params; refs to these
   *  names emit as `{name}` JSX expressions (resolved by
   *  `useParams()` at render time). */
  paramNames: ReadonlySet<string> = new Set(),
  /** Slice 11.7 — names of the page's `state {}` fields; refs in
   *  body position emit as `{name}` JSX expressions (resolved by
   *  `useState` in the shell), and `:=` assignments in event-
   *  handler lambdas lower to the React `setX(...)` setter. */
  stateNames: ReadonlySet<string> = new Set(),
  /** Slice 11.18 — user-defined components known to this UI.  When
   *  the walker sees a `call` whose name matches a key here, it
   *  emits `<Name prop1={arg1} … />` (mapping positional args to
   *  the component's declared param names) instead of the
   *  "unknown component" placeholder.  Required for cross-component
   *  composition (one component invoking another). */
  userComponents: ReadonlyMap<string, readonly ParamIR[]> = new Map(),
  /** Slice 11.24 — UI api parameters.  Each entry maps a local
   *  handle (e.g. `Sales`) to an api name (e.g. `SalesApi`).
   *  Body refs of the form `<paramName>.<aggregate>.<op>` get
   *  detected by the walker, hoisted to a hook call at page top,
   *  and rewritten to the local hook variable. */
  apiParams: ReadonlyArray<UiApiParamIR> = [],
): WalkResult {
  const apiParamNames = new Map<string, string>();
  for (const p of apiParams) apiParamNames.set(p.name, p.apiName);
  const ctx: WalkContext = {
    imports: new Map(),
    pack,
    paramNames,
    usedParams: new Set(),
    usesNavigate: false,
    stateNames,
    usesState: false,
    usesRouterLink: false,
    userComponents,
    usedUserComponents: new Set(),
    usesChildren: false,
    apiParamNames,
    usedApiHooks: new Map(),
  };
  const tsx = walk(body, ctx, 0);
  return {
    tsx,
    imports: ctx.imports,
    usedParams: ctx.usedParams,
    usesNavigate: ctx.usesNavigate,
    usesState: ctx.usesState,
    usesRouterLink: ctx.usesRouterLink,
    usedUserComponents: ctx.usedUserComponents,
    usesChildren: ctx.usesChildren,
    usedApiHooks: ctx.usedApiHooks,
  };
}

interface WalkContext {
  imports: ImportMap;
  pack: LoadedPack;
  paramNames: ReadonlySet<string>;
  usedParams: Set<string>;
  usesNavigate: boolean;
  stateNames: ReadonlySet<string>;
  usesState: boolean;
  usesRouterLink: boolean;
  userComponents: ReadonlyMap<string, readonly ParamIR[]>;
  usedUserComponents: Set<string>;
  usesChildren: boolean;
  apiParamNames: ReadonlyMap<string, string>;
  usedApiHooks: Map<string, ApiHookUse>;
}

function walk(expr: ExprIR, ctx: WalkContext, depth: number): string {
  // Slice 11.24 — api hook injection (JSX-child position).
  // Detect `<param>.<aggregate>.<op>` rooted at a UiApiParam.
  // In JSX-child position, the local hook var is brace-wrapped.
  const hookUse = tryDetectApiHook(expr, ctx);
  if (hookUse) {
    registerApiHook(hookUse, ctx);
    return `{${hookUse.varName}}`;
  }
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
    case "Container":
      return emitContainer(call, ctx, depth);
    case "Tabs":
      return emitTabs(call, ctx, depth);
    case "Toolbar":
      return emitToolbar(call, ctx, depth);
    case "Empty":
      return emitEmpty(call, ctx, depth);
    case "Field":
      return emitField(call, ctx, depth);
    case "NumberField":
      return emitNumberField(call, ctx, depth);
    case "PasswordField":
      return emitPasswordField(call, ctx, depth);
    case "Toggle":
      return emitToggle(call, ctx, depth);
    case "Loader":
      return emitLoader(call, ctx, depth);
    case "Anchor":
      return emitAnchor(call, ctx, depth);
    case "Image":
      return emitImage(call, ctx, depth);
    case "Avatar":
      return emitAvatar(call, ctx, depth);
    case "Slot":
      return emitSlot(call, ctx, depth);
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
    default: {
      // Slice 11.18 — names not in the stdlib dispatch table fall
      // through to user-component invocation when they match a
      // registered ComponentIR.  Otherwise the original
      // "unknown component" placeholder fires.
      if (ctx.userComponents.has(call.name)) {
        return emitUserComponent(call, ctx, depth);
      }
      return `{/* unknown layout component: ${call.name} */}`;
    }
  }
}

function emitStack(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Every positional arg is a child; ignore named args in v0.
  const children = positionalChildren(call, ctx, depth + 1);
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-stack", {
    hasChildren: children.length > 0,
    childrenBlock: children.join(`\n${indent}`),
    indent,
    closeIndent,
  });
}

function emitGroup(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const children = positionalChildren(call, ctx, depth + 1);
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-group", {
    hasChildren: children.length > 0,
    childrenBlock: children.join(`\n${indent}`),
    indent,
    closeIndent,
  });
}

function emitGrid(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Each child wraps in a per-pack column container (Mantine's
  // <Grid.Col span="auto">; shadcn's plain `<div>` since gap is
  // on the parent).  v0 gives every column equal weight; a future
  // slice can read a `span:` named arg per child.
  const children = positionalChildren(call, ctx, depth + 2);
  const colIndent = "  ".repeat(depth + 1);
  const childIndent = "  ".repeat(depth + 2);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-grid", {
    hasChildren: children.length > 0,
    children,
    colIndent,
    childIndent,
    closeIndent,
  });
}

function emitContainer(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Container(...children) — max-width centred wrapper.  Optional
  // `size:` named arg controls the max-width per pack idiom
  // (Mantine "xs"|"sm"|"md"|"lg"|"xl"; shadcn maps to a tailwind
  // max-w utility).
  const children = positionalChildren(call, ctx, depth + 1);
  const size = stringNamed(call, "size");
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-container", {
    hasChildren: children.length > 0,
    childrenBlock: children.join(`\n${indent}`),
    indent,
    closeIndent,
    size,
    hasSize: size !== undefined,
  });
}

function emitTabs(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Tabs(Tab("Overview", body), Tab("Settings", body))
  // Each positional child must be a `Tab(label, body)` call;
  // anything else lands as a placeholder so the page still
  // compiles.  Tab labels must be string literals in v0; non-
  // literal labels fall back to indexed slugs `tab-1`, …
  const positionals = positionalArgs(call);
  const tabs = positionals.map((arg, i) => {
    if (arg.kind !== "call" || arg.name !== "Tab") {
      return {
        value: `tab-${i + 1}`,
        label: `Tab ${i + 1}`,
        bodyJsx: "{/* missing tab body */}",
      };
    }
    const tabPositionals = positionalArgs(arg);
    const labelArg = tabPositionals[0];
    const bodyArg = tabPositionals[1];
    const labelStr =
      labelArg && labelArg.kind === "literal" && labelArg.lit === "string"
        ? labelArg.value
        : `Tab ${i + 1}`;
    return {
      value: slugify(labelStr) || `tab-${i + 1}`,
      label: escapeJsxText(labelStr),
      bodyJsx: bodyArg
        ? walk(bodyArg, ctx, depth + 2)
        : "{/* missing tab body */}",
    };
  });
  return renderPrimitive(ctx, "primitive-tabs", {
    tabs,
    hasTabs: tabs.length > 0,
    defaultValue: tabs[0]?.value ?? "",
    indent: "  ".repeat(depth + 1),
    innerIndent: "  ".repeat(depth + 2),
    closeIndent: "  ".repeat(depth),
  });
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
  // as Group, but with space-between justification (canonical
  // page-header layout: left-aligned + right-aligned cluster).
  const children = positionalChildren(call, ctx, depth + 1);
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-toolbar", {
    hasChildren: children.length > 0,
    childrenBlock: children.join(`\n${indent}`),
    indent,
    closeIndent,
  });
}

function emitEmpty(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Empty("No results yet") — empty-state placeholder.  No
  // dedicated component on either pack; both compose a centred
  // dimmed text block.  The first positional is the message;
  // refs / ops welcome (routes through renderTextContent).
  const msg = firstPositionalContent(call, ctx) ?? '"No results."';
  void depth;
  return renderPrimitive(ctx, "primitive-empty", {
    text: unwrapTextLiteral(msg),
  });
}

/** Build the dual label representations input primitives need:
 *  `labelAttr` for an `label="..."` JSX attribute (Mantine's
 *  TextInput/Switch take label this way) and `labelText` for a
 *  child-text position (shadcn pairs `<Label>...</Label>` next to
 *  the input).  Both come from the same first-positional content
 *  source. */
function inputLabelForms(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
): { labelAttr: string; labelText: string } {
  const raw = firstPositionalContent(call, ctx) ?? '""';
  return {
    labelAttr: unwrapAsAttr(raw),
    labelText: unwrapTextLiteral(raw),
  };
}

function emitField(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Field("Label", bind: <state-field>) — controlled text input
  // bound to a state field.  `bind:` required; without it the
  // input falls back to a label-only stub.
  void depth;
  const { labelAttr, labelText } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined
    ? "set" + bind[0]!.toUpperCase() + bind.slice(1)
    : undefined;
  return renderPrimitive(ctx, "primitive-field", {
    labelAttr,
    labelText,
    bind,
    setter,
    hasBind: bind !== undefined,
  });
}

function emitToggle(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Toggle("Label", bind: <bool state>) — controlled bool input.
  void depth;
  const { labelAttr, labelText } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined
    ? "set" + bind[0]!.toUpperCase() + bind.slice(1)
    : undefined;
  return renderPrimitive(ctx, "primitive-toggle", {
    labelAttr,
    labelText,
    bind,
    setter,
    hasBind: bind !== undefined,
  });
}

function emitNumberField(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // NumberField("Label", bind: <int|decimal state>) — controlled
  // number input.  Setter is wrapped with `typeof v === "number"
  // ? v : 0` so binding stays type-safe across the
  // string-or-number onChange union.
  void depth;
  const { labelAttr, labelText } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined
    ? "set" + bind[0]!.toUpperCase() + bind.slice(1)
    : undefined;
  return renderPrimitive(ctx, "primitive-number-field", {
    labelAttr,
    labelText,
    bind,
    setter,
    hasBind: bind !== undefined,
  });
}

function emitPasswordField(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // PasswordField("Label", bind: <string state>) — visibility-
  // toggle text input.  Same bind-shape as Field.
  void depth;
  const { labelAttr, labelText } = inputLabelForms(call, ctx);
  const bind = stateBindArg(call, "bind", ctx);
  const setter = bind !== undefined
    ? "set" + bind[0]!.toUpperCase() + bind.slice(1)
    : undefined;
  return renderPrimitive(ctx, "primitive-password-field", {
    labelAttr,
    labelText,
    bind,
    setter,
    hasBind: bind !== undefined,
  });
}

function emitLoader(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Loader() — spinner.  Optional `size:` string literal.
  void depth;
  const size = stringNamed(call, "size");
  return renderPrimitive(ctx, "primitive-loader", {
    size,
    hasSize: size !== undefined,
  });
}

function emitAnchor(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Anchor("label", to: "/path") — text-style link.  With `to:`,
  // routes via React Router's Link; without, falls through to a
  // bare anchor (no href — visible no-op).
  void depth;
  const label = firstPositionalContent(call, ctx) ?? '"link"';
  const to = stringOrRefArgValue(call, "to", ctx);
  if (to) ctx.usesRouterLink = true;
  return renderPrimitive(ctx, "primitive-anchor", {
    label: unwrapTextLiteral(label),
    to,
    hasTo: to !== undefined,
  });
}

function emitImage(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Image(src: "...", alt: "...") — packs render a styled image
  // tag.  Both attrs accept string literals or refs.
  void depth;
  const src = stringOrRefArgValue(call, "src", ctx);
  const alt = stringOrRefArgValue(call, "alt", ctx);
  return renderPrimitive(ctx, "primitive-image", {
    src,
    alt,
    hasSrc: src !== undefined,
    hasAlt: alt !== undefined,
  });
}

function emitAvatar(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Avatar(src: "...", alt: "...") — packs render a circle-cropped
  // image.  Without src, packs render their user-icon fallback.
  void depth;
  const src = stringOrRefArgValue(call, "src", ctx);
  const alt = stringOrRefArgValue(call, "alt", ctx);
  return renderPrimitive(ctx, "primitive-avatar", {
    src,
    alt,
    hasSrc: src !== undefined,
    hasAlt: alt !== undefined,
  });
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
  // First positional is the heading text — accepts a string
  // literal OR a ref (e.g. a route-param name).  Optional `level:`
  // named arg controls the heading rank (1..6, default 2).
  const text = firstPositionalContent(call, ctx) ?? '"Heading"';
  const level = numericNamed(call, "level") ?? 2;
  void depth;
  return renderPrimitive(ctx, "primitive-heading", {
    text: unwrapTextLiteral(text),
    level,
  });
}

function emitText(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const text = firstPositionalContent(call, ctx) ?? '""';
  void depth;
  return renderPrimitive(ctx, "primitive-text", {
    text: unwrapTextLiteral(text),
  });
}

function emitButton(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const label = firstPositionalContent(call, ctx) ?? '"Button"';
  void depth;
  // Slice 11.7 — `onClick:` lambda named arg wires the button to
  // a multi-statement event handler.  Takes priority over `to:` if
  // both are written.
  const onClick = lambdaArg(call, "onClick");
  let onClickHandler: string | undefined;
  if (onClick && (onClick.block || onClick.body)) {
    onClickHandler = emitLambdaBody(onClick, ctx);
  } else {
    // Slice 11.5 — `to:` named arg wires the button to a React
    // Router navigate call.  Accepts either a string-literal path
    // or a route-param ref.
    const to = stringOrRefArgValue(call, "to", ctx);
    if (to) {
      ctx.usesNavigate = true;
      onClickHandler = `() => navigate(${to})`;
    }
  }
  return renderPrimitive(ctx, "primitive-button", {
    label: unwrapTextLiteral(label),
    onClick: onClickHandler,
    hasOnClick: onClickHandler !== undefined,
  });
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
  // Slice 11.24 — api hook injection.  Detect `<param>.<aggregate>.<op>`
  // (with optional method-call args) rooted at a UiApiParam ref.
  // When matched, register a hook usage on the context and return
  // the local hook variable name; the shell emits the
  // `const <var> = use<Op><Aggregate>(args)` declaration at page-top.
  const hookUse = tryDetectApiHook(expr, ctx);
  if (hookUse) {
    registerApiHook(hookUse, ctx);
    return hookUse.varName;
  }
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
      // Slice 11.23 — refs to `let` bindings are in scope as JS
      // const declarations earlier in the same lambda body.  The IR
      // already tags these with `refKind: "let"`; emit the bare
      // name so the generated code references the local.
      if (expr.refKind === "let") return expr.name;
      return `/* unresolved: ${expr.name} */ undefined`;
    case "binary":
      return `(${emitExpr(expr.left, ctx)} ${expr.op} ${emitExpr(expr.right, ctx)})`;
    case "unary":
      return `(${expr.op}${emitExpr(expr.operand, ctx)})`;
    case "call": {
      // Slice 11.23 — bare function call as a JS expression.  The
      // callee is emitted verbatim — the generated code expects the
      // user to import / declare `<name>` somewhere in their app
      // shell.  Powers patterns like `let n = inc(count)` and the
      // statement form `Button("…", onClick: e => { saveOrder() })`.
      const args = expr.args.map((a) => emitExpr(a, ctx)).join(", ");
      return `${expr.name}(${args})`;
    }
    case "member": {
      // Plain JS member access: `<recv>.<member>`.  Recursive
      // emit on the receiver — if it was a hook-eligible chain
      // (Slice 11.24), tryDetectApiHook at the top has already
      // returned the hook var; we just append `.<member>`.
      return `${emitExpr(expr.receiver, ctx)}.${expr.member}`;
    }
    case "method-call": {
      // Slice 11.24 — when the method-call's receiver is a hook
      // (detected by tryDetectApiHook on the receiver), emit
      // `<hookVar>.<method>(<args>)` (e.g.
      // `customerCreate.mutate({...})`).  Otherwise the call
      // is against an unresolved receiver — emit a visible TODO
      // placeholder rather than runtime-broken code.
      const recvHookUse = tryDetectApiHook(expr.receiver, ctx);
      if (recvHookUse) {
        registerApiHook(recvHookUse, ctx);
        const args = expr.args.map((a) => emitExpr(a, ctx)).join(", ");
        return `${recvHookUse.varName}.${expr.member}(${args})`;
      }
      const argsRendered = expr.args.map((a) => emitExpr(a, ctx)).join(", ");
      const receiverDesc = describeReceiver(expr.receiver);
      return `/* TODO: method-call ${receiverDesc}.${expr.member}(${argsRendered}) — needs hooks {} binding (Slice 11.24+) */ undefined`;
    }
    default:
      return `/* unsupported expr: ${expr.kind} */ undefined`;
  }
}

/** Best-effort description of an unresolved method-call receiver
 *  for the placeholder comment (so the user can see WHICH
 *  call landed as the placeholder).  Avoids invoking emitExpr
 *  on the receiver since that path emits a noisy
 *  `unresolved` comment for free identifiers — bad inside the
 *  outer placeholder. */
/** Slice 11.24 — detect `<param>.<aggregate>.<op>(args?)` rooted
 *  at a UiApiParam ref.  Returns an ApiHookUse on match, or null
 *  to fall through to generic expression handling.
 *
 *  Two patterns:
 *    A. `<param>.<aggregate>.<op>` — non-parameterized hook
 *       (e.g. `Sales.Customer.all`, `Sales.Customer.create`)
 *    B. `<param>.<aggregate>.<op>(args)` — parameterized hook
 *       (e.g. `Sales.Customer.byId(id)`)
 *
 *  Both emit one hook call at page-top.  Anything stacked on top
 *  (`.data`, `.isLoading`, `.mutate(args)`, etc.) is plain JS
 *  member access on the local hook variable — handled by the
 *  default member-access / method-call paths after this helper
 *  has rewritten the deepest 3-segment chain. */
function tryDetectApiHook(expr: ExprIR, ctx: WalkContext): ApiHookUse | null {
  // Pattern A: member(member(ref:apiParam, agg), op)
  if (expr.kind === "member" && expr.receiver.kind === "member") {
    const inner = expr.receiver;
    if (inner.receiver.kind === "ref" && ctx.apiParamNames.has(inner.receiver.name)) {
      return buildHookUse(inner.member, expr.member, [], ctx);
    }
  }
  // Pattern B: method-call(member(ref:apiParam, agg), op, args)
  if (expr.kind === "method-call" && expr.receiver.kind === "member") {
    const inner = expr.receiver;
    if (inner.receiver.kind === "ref" && ctx.apiParamNames.has(inner.receiver.name)) {
      return buildHookUse(inner.member, expr.member, expr.args, ctx);
    }
  }
  return null;
}

/** Build the ApiHookUse for a detected `<aggregate>.<op>(args?)`
 *  reference.  Naming convention matches the existing scaffold
 *  output (see `webApp/src/api/<aggregate>.ts`):
 *    `<agg>.all`    → useAll<Plural>
 *    `<agg>.byId`   → use<Single>ById  (parameterized)
 *    `<agg>.create` → useCreate<Single>
 *    `<agg>.update` → useUpdate<Single>
 *    `<agg>.delete` → useDelete<Single>
 *    `<agg>.<find>` → use<FindPascal><Single>  (custom finder)
 *
 *  The local var name is `<aggCamel><OpPascal>` — deterministic,
 *  visible in the generated file, never invented by the user. */
function buildHookUse(
  aggregate: string,
  op: string,
  args: ExprIR[],
  ctx: WalkContext,
): ApiHookUse {
  const aggSingle = pascal(aggregate);
  const aggPlural = plural(aggSingle);
  let hookName: string;
  if (op === "all") hookName = `useAll${aggPlural}`;
  else if (op === "byId") hookName = `use${aggSingle}ById`;
  else if (op === "create") hookName = `useCreate${aggSingle}`;
  else if (op === "update") hookName = `useUpdate${aggSingle}`;
  else if (op === "delete") hookName = `useDelete${aggSingle}`;
  else hookName = `use${pascal(op)}${aggSingle}`;
  const varName = `${camel(aggSingle)}${pascal(op)}`;
  const importFrom = `../api/${snake(aggSingle)}`;
  // Render args via the main ctx so refs to params/state propagate
  // (param refs add to `usedParams` → the shell destructures them
  // from `useParams`; state refs are an error since the hook lives
  // before useState in the function body).
  const argsRendered = args.map((a) => emitExpr(a, ctx));
  return { varName, hookName, importFrom, argsRendered };
}

/** Register a detected hook usage on the walker context.  De-dupes
 *  by var name — if the same `<param>.<aggregate>.<op>` appears
 *  twice in the body, only one declaration is emitted at page-top. */
function registerApiHook(hook: ApiHookUse, ctx: WalkContext): void {
  if (!ctx.usedApiHooks.has(hook.varName)) {
    ctx.usedApiHooks.set(hook.varName, hook);
  }
}

/** Group api-hook imports by source file so multiple ops on one
 *  aggregate (e.g. `useAllCustomers` + `useCreateCustomer`) collapse
 *  to a single import line — matches the existing scaffold output
 *  shape (one api/<aggregate>.ts per aggregate, exporting all
 *  hooks). */
function renderApiHookImports(usedApiHooks: Map<string, ApiHookUse>): string {
  const byPath = new Map<string, Set<string>>();
  for (const h of usedApiHooks.values()) {
    let names = byPath.get(h.importFrom);
    if (!names) {
      names = new Set();
      byPath.set(h.importFrom, names);
    }
    names.add(h.hookName);
  }
  const lines: string[] = [];
  for (const [path, names] of [...byPath.entries()].sort()) {
    const sorted = [...names].sort();
    lines.push(`import { ${sorted.join(", ")} } from "${path}";\n`);
  }
  return lines.join("");
}

function describeReceiver(expr: ExprIR): string {
  if (expr.kind === "ref") return expr.name;
  if (expr.kind === "method-call") return `${describeReceiver(expr.receiver)}.${expr.member}`;
  return `<expr>`;
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
    case "call": {
      // Slice 11.23 — bare function-call statement (the
      // statement-grammar `name(args)` form).  Walker emits as a
      // plain `name(args);` line; the generated code expects the
      // user to import / declare `<name>` somewhere in their app
      // shell.
      const args = stmt.args.map((a) => emitExpr(a, ctx)).join(", ");
      return `${stmt.name}(${args});`;
    }
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
  // Card("title", content) — first positional title (anything not
  // a call counts as title); second positional is the body.
  // Slice 11.10: `Card(child)` (single non-text-like positional)
  // renders a card with no heading.
  const positionals = positionalArgs(call);
  const titleArg = positionals[0];
  const titleIsTextLike =
    titleArg !== undefined && titleArg.kind !== "call";
  const contentExpr: ExprIR | undefined = titleIsTextLike
    ? positionals[1]
    : positionals[0];
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  const titleText = titleIsTextLike && titleArg
    ? unwrapTextLiteral(renderTextContent(titleArg, ctx) ?? '""')
    : undefined;
  const contentJsx = contentExpr ? walk(contentExpr, ctx, depth + 1) : undefined;
  return renderPrimitive(ctx, "primitive-card", {
    hasTitle: titleText !== undefined,
    titleText,
    hasContent: contentJsx !== undefined,
    contentJsx,
    indent,
    closeIndent,
  });
}

function emitStat(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Stat(label, value) — small headline-stat card.  No dedicated
  // component on either pack; both compose two stacked text
  // elements (dimmed label + bold value).
  const positionals = positionalArgs(call);
  const labelArg = positionals[0];
  const valueArg = positionals[1];
  const label = labelArg ? renderTextContent(labelArg, ctx) ?? '""' : '""';
  const value = valueArg ? renderTextContent(valueArg, ctx) ?? '""' : '""';
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  return renderPrimitive(ctx, "primitive-stat", {
    label: unwrapTextLiteral(label),
    value: unwrapTextLiteral(value),
    indent,
    closeIndent,
  });
}

function emitBadge(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  const label = firstPositionalContent(call, ctx) ?? '"Badge"';
  void depth;
  return renderPrimitive(ctx, "primitive-badge", {
    label: unwrapTextLiteral(label),
  });
}

function emitSlot(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Slice 11.19 — children-prop placeholder.  `Slot()` inside a
  // component's body emits `{children}`, the React idiom for
  // rendering whatever JSX the parent passed in.  Marks usesChildren
  // on the context so the shell adds `children?: React.ReactNode`
  // to the typed Props interface.
  void call;
  void depth;
  ctx.usesChildren = true;
  return `{children}`;
}

function emitDivider(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  void depth;
  // Optional `label:` named arg — packs that support a labelled
  // divider can use the slot; packs that don't drop it.
  const label = stringNamed(call, "label");
  return renderPrimitive(ctx, "primitive-divider", {
    label,
    hasLabel: label !== undefined,
  });
}

function emitUserComponent(
  call: ExprIR & { kind: "call" },
  ctx: WalkContext,
  depth: number,
): string {
  // Slice 11.18 — invoke a user-defined component as a JSX element.
  // Positional args map to the component's declared param names by
  // position; named args use their `name:` prefix verbatim.  String
  // literals render as quoted attrs (`name="Alice"`); refs / binary
  // ops / non-string literals emit through emitExpr inside `{...}`.
  //
  // Slice 11.19 — positional args BEYOND the component's declared
  // param count are JSX children — wrapped between the open and
  // close tags so the component receives them via the `children`
  // prop.  Named args still go to props regardless of position.
  const params = ctx.userComponents.get(call.name) ?? [];
  ctx.usedUserComponents.add(call.name);
  const argNames = call.argNames ?? [];
  // Slice 11.19 — collect names already filled by named args so
  // positional args don't clobber them when looking up the next
  // free param slot.
  const filledByName = new Set<string>();
  for (let i = 0; i < argNames.length; i++) {
    const n = argNames[i];
    if (n !== undefined) filledByName.add(n);
  }
  const attrs: string[] = [];
  const childrenExprs: ExprIR[] = [];
  let nextParamCursor = 0;
  for (let i = 0; i < call.args.length; i++) {
    const arg = call.args[i]!;
    if (argNames[i] !== undefined) {
      attrs.push(`${argNames[i]}=${attrValue(arg, ctx)}`);
      continue;
    }
    // Advance the cursor past any params that were already filled
    // via a named arg.
    while (
      nextParamCursor < params.length &&
      filledByName.has(params[nextParamCursor]!.name)
    ) {
      nextParamCursor += 1;
    }
    const param = params[nextParamCursor];
    if (param) {
      nextParamCursor += 1;
      attrs.push(`${param.name}=${attrValue(arg, ctx)}`);
    } else {
      // No more declared params — extra positional arg becomes a
      // JSX child.
      childrenExprs.push(arg);
    }
  }
  const open = attrs.length > 0
    ? `<${call.name} ${attrs.join(" ")}`
    : `<${call.name}`;
  if (childrenExprs.length === 0) {
    return `${open} />`;
  }
  const indent = "  ".repeat(depth + 1);
  const closeIndent = "  ".repeat(depth);
  const childTsx = childrenExprs
    .map((c) => walk(c, ctx, depth + 1))
    .join(`\n${indent}`);
  return `${open}>\n${indent}${childTsx}\n${closeIndent}</${call.name}>`;
}

/** Slice 11.18 — render an ExprIR as a JSX attribute value.
 *  String literals → `"text"` (quoted attr); everything else →
 *  `{<emitExpr>}` (brace-wrapped JS expression). */
function attrValue(expr: ExprIR, ctx: WalkContext): string {
  if (expr.kind === "literal" && expr.lit === "string") {
    return JSON.stringify(expr.value);
  }
  return `{${emitExpr(expr, ctx)}}`;
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
  pack: LoadedPack,
  params: ParamIR[] = [],
  state: StateFieldIR[] = [],
  /** Slice 11.12 — page-level `title:` expression.  Renders into a
   *  `useEffect` that sets `document.title` on mount and whenever
   *  any referenced param/state changes (deps array auto-derived
   *  from the title expression's refs). */
  title: ExprIR | undefined = undefined,
  /** Slice 11.18 — user-defined components in scope, so calls to
   *  them in the body emit as `<Name prop={…} />` instead of
   *  unknown-component placeholders. */
  userComponents: ReadonlyMap<string, readonly ParamIR[]> = new Map(),
  /** Slice 11.24 — UI api parameters.  Body refs of the form
   *  `<paramName>.<aggregate>.<op>` become hook calls injected at
   *  page-top by the walker. */
  apiParams: ReadonlyArray<UiApiParamIR> = [],
): string {
  const paramNames = new Set(params.map((p) => p.name));
  const stateNames = new Set(state.map((s) => s.name));
  const {
    tsx,
    imports,
    usedParams,
    usesNavigate,
    usesState,
    usesRouterLink,
    usedUserComponents,
    usedApiHooks,
  } = walkBodyToTsx(body, pack, paramNames, stateNames, userComponents, apiParams);
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
      pack,
      paramNames,
      usedParams,
      usesNavigate,
      stateNames,
      usesState,
      usesRouterLink: false,
      userComponents: new Map(),
      usedUserComponents: new Set(),
      usesChildren: false,
      apiParamNames: new Map(),
      usedApiHooks: new Map(),
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

  const mantineImport = renderImportLines(imports);
  // Slice 11.18 — one default-import line per user component
  // referenced in the body, sorted alphabetically.
  const userComponentImports = [...usedUserComponents]
    .sort()
    .map((name) => `import ${name} from "../components/${name}";\n`)
    .join("");
  // Slice 11.24 — api hook imports, grouped per `from` path so
  // multiple ops on the same aggregate dedupe to one import line
  // (matching the existing scaffold output's per-aggregate api file).
  const apiHookImports = renderApiHookImports(usedApiHooks);
  // Slice 11.24 — api hook declarations, emitted at page-top right
  // before the JSX return.  Each unique `<param>.<aggregate>.<op>`
  // becomes one `const <var> = use<Op><Aggregate>(args?);` line.
  const apiHookDecls = [...usedApiHooks.values()]
    .map((h) => `  const ${h.varName} = ${h.hookName}(${h.argsRendered.join(", ")});\n`)
    .join("");
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
    ? state.map((f) => `  ${renderUseState(f, pack)}\n`).join("")
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
${reactImport}${reactRouterImport}${mantineImport}${apiHookImports}${userComponentImports}
export default function ${pageName}() {
${paramsLine}${navigateLine}${stateLines}${apiHookDecls}${titleEffect}  return (
    ${indentJsx(tsx, "    ")}
  );
}
`;
}

/** Slice 11.18 — render one ComponentIR as a `.tsx` file: typed
 *  Props interface, default-export function component, useState
 *  declarations from the component's own state, body walked
 *  through the same machinery as page bodies.  Components don't
 *  have routes / titles, so the shell skips useParams /
 *  useEffect; they CAN have state and CAN invoke other user
 *  components. */
export function renderUserComponentFile(
  name: string,
  params: ParamIR[],
  state: StateFieldIR[],
  body: ExprIR,
  pack: LoadedPack,
  userComponents: ReadonlyMap<string, readonly ParamIR[]>,
): string {
  const paramNames = new Set(params.map((p) => p.name));
  const stateNames = new Set(state.map((s) => s.name));
  const {
    tsx,
    imports,
    usedParams,
    usesState,
    usesRouterLink,
    usesNavigate,
    usedUserComponents,
    usesChildren,
  } = walkBodyToTsx(body, pack, paramNames, stateNames, userComponents);
  const mantineImport = renderImportLines(imports);
  // Components don't have routes — useNavigate/Link still legal in
  // a component subtree (e.g. Button(to:) inside).
  const routerSpecifiers: string[] = [];
  if (usesNavigate) routerSpecifiers.push("useNavigate");
  if (usesRouterLink) routerSpecifiers.push("Link");
  const reactRouterImport = routerSpecifiers.length > 0
    ? `import { ${routerSpecifiers.join(", ")} } from "react-router-dom";\n`
    : "";
  const reactImport = usesState
    ? `import { useState } from "react";\n`
    : "";
  // Slice 11.19 — components that reference Slot() get a
  // `children` prop on top of their declared params.  React's
  // type is imported lazily.
  const reactTypesImport = usesChildren
    ? `import type { ReactNode } from "react";\n`
    : "";
  const userComponentImports = [...usedUserComponents]
    .sort()
    .map((n) => `import ${n} from "./${n}";\n`)
    .join("");
  // Props interface — every declared param becomes a typed field;
  // Slot()-using components also get a `children` field.
  const propLines = params.map(
    (p) => `  ${p.name}: ${typeRefAsTsString(p)};`,
  );
  if (usesChildren) propLines.push(`  children?: ReactNode;`);
  const propsType = propLines.length > 0
    ? `\nexport interface ${name}Props {\n${propLines.join("\n")}\n}\n`
    : "";
  const destructureNames = params.map((p) => p.name);
  if (usesChildren) destructureNames.push("children");
  const propDestructure = destructureNames.length > 0
    ? `{ ${destructureNames.join(", ")} }: ${name}Props`
    : "";
  const navigateLine = usesNavigate
    ? `  const navigate = useNavigate();\n`
    : "";
  const stateLines = usesState
    ? state.map((f) => `  ${renderUseState(f, pack)}\n`).join("")
    : "";
  // Suppress used-prop warnings — params declared but unused at
  // walker-emit time (e.g. typed pass-through to a child component
  // not yet wired) shouldn't trigger TS lint noise.  We reference
  // them with a `void` block when none made it into `tsx`.
  void usedParams;
  return `// Auto-generated.  Do not edit by hand.
${reactImport}${reactTypesImport}${reactRouterImport}${mantineImport}${userComponentImports}${propsType}
export default function ${name}(${propDestructure}) {
${navigateLine}${stateLines}  return (
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
function renderUseState(field: StateFieldIR, pack: LoadedPack): string {
  const setter = "set" + field.name[0]!.toUpperCase() + field.name.slice(1);
  const tsType = stateTypeAsTsString(field.type);
  const init = field.init !== undefined
    ? renderInitExpr(field.init, pack)
    : zeroValueForType(field.type);
  return `const [${field.name}, ${setter}] = useState<${tsType}>(${init});`;
}

/** Render a state-field initializer ExprIR as a JS expression
 *  string.  Reuses the same shape `emitExpr` produces but runs
 *  with an empty context — initializers can't reference state or
 *  params (they evaluate at component-mount time). */
function renderInitExpr(expr: ExprIR, pack: LoadedPack): string {
  // Empty walker context — init expressions don't see state /
  // params (they evaluate before the hooks run).
  const dummy: WalkContext = {
    imports: new Map(),
    pack,
    paramNames: new Set(),
    usedParams: new Set(),
    usesNavigate: false,
    stateNames: new Set(),
    usesState: false,
    usesRouterLink: false,
    userComponents: new Map(),
    usedUserComponents: new Set(),
    usesChildren: false,
    apiParamNames: new Map(),
    usedApiHooks: new Map(),
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
