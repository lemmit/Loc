// ---------------------------------------------------------------------------
// HEEx presentational primitive renderers.
//
// The closed-primitive component library for the Phoenix LiveView target
// (Breadcrumbs / Anchor / Modal / Form / Table / QueryView / KeyValueRow /
// Stack / Heading / Card / Badge / Button / Icon / …).  Split out of
// heex-walker-core.ts so the 2k-line walker reads as two cohesive halves:
// this file holds the leaf renderers dispatched by name through the walker
// registry (src/generator/_walker/registry.ts).  They consume the core
// walker engine (renderExpr / renderChild / renderInTemplate /
// renderPrimitive) but the engine only ever reaches them via the registry,
// so the dependency is one-directional (primitives -> core).
// ---------------------------------------------------------------------------

import { createInputFields } from "../../ir/enrich/wire-projection.js";
import type { EnumIR, ExprIR, TypeIR, ValueObjectIR } from "../../ir/types/loom-ir.js";
import { humanize, plural, snake } from "../../util/naming.js";
import { iconA11yAttr } from "../_walker/a11y-emit.js";
import {
  escapeHeexAttr,
  escapeHeexText,
  indent,
  type PrimitiveSpec,
  renderChild,
  renderExpr,
  renderInTemplate,
  renderPrimitive,
  type WalkContext,
} from "./heex-walker-core.js";

// ---------------------------------------------------------------------------
// Scaffold expander primitive renderers.
// Each function is called from renderCall when the primitive name matches.
// These emit proper Phoenix/HEEx structures — no <!-- TODO --> comments.
// ---------------------------------------------------------------------------

/** Render an attribute *value* as either a quoted literal or a HEEx `{…}`
 *  expression, depending on whether the arg is a compile-time literal.
 *
 *  A *dynamic* value (anything but a `literal`) is an Elixir expression and
 *  MUST ride a `{…}` expression attribute — emitting it inside quotes (e.g.
 *  `id="<%= … %>"` or `data-testid="x <> y"`) produces a HEEx tokenizer
 *  ParseError ("expected attribute name").  This is the single seam that
 *  every primitive funnels dynamic attribute values through, so the bug class
 *  can't reappear one renderer at a time. */
export function attrValue(arg: ExprIR, ctx: WalkContext): string {
  return arg.kind === "literal"
    ? `"${escapeHeexAttr(arg.value)}"`
    : `{${renderExpr(arg, { ...ctx, position: "template" })}}`;
}

/** The trailing ` data-testid=…` attribute for a primitive call, or `""` when
 *  no `testid:` is given.  A literal renders as `data-testid="x"`; a dynamic
 *  `testid:` renders as `data-testid={<expr>}` (see {@link attrValue}). */
export function testIdAttr(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  const idx = (expr.argNames ?? []).indexOf("testid");
  const arg = idx >= 0 ? expr.args[idx] : undefined;
  return arg ? ` data-testid=${attrValue(arg, ctx)}` : "";
}

/** `Breadcrumbs(items...)` → `<nav aria-label="breadcrumb">` with
 *  a list of spans/links.  Positional children are each an Anchor
 *  (link) or Text (current page) from the scaffold expander. */
export function renderBreadcrumbs(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  const items = expr.args.map((a) => renderChild(a, ctx));
  const itemsHeex = items
    .map((item, i) =>
      i < items.length - 1
        ? `  <li class="breadcrumb-item">${item}</li>\n  <li class="breadcrumb-sep" aria-hidden="true">/</li>`
        : `  <li class="breadcrumb-item breadcrumb-current" aria-current="page">${item}</li>`,
    )
    .join("\n");
  return `<nav aria-label="breadcrumb">\n  <ol class="breadcrumbs">\n${indent(itemsHeex, 2)}\n  </ol>\n</nav>`;
}

/** `Anchor("label", to: "/path")` → `<.link navigate={~p"/path"}>label</.link>`
 *  A literal internal route uses the verified-route `~p` sigil; a literal
 *  external URL falls back to `<a href="...">`.  A *dynamic* `to:` (e.g.
 *  `"/x/" <> id`) is an Elixir expression, so it must ride a HEEx EXPRESSION
 *  attribute — `<.link navigate={<expr>}>` — never a quoted literal attribute
 *  (which would emit `href="…" <> id"`, a HEEx tokenizer ParseError).
 *  `testid:` becomes `data-testid`. */
export function renderAnchor(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let label = "";
  let toLiteral: string | undefined;
  let toExpr = "";
  const positional: ExprIR[] = [];
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (!name) {
      positional.push(arg);
    } else if (name === "to") {
      if (arg.kind === "literal") {
        toLiteral = arg.value;
      } else {
        toExpr = renderExpr(arg, { ...ctx, position: "template" });
      }
    }
  }
  label = positional[0] ? renderInTemplate(positional[0], ctx) : "";
  const testidAttr = testIdAttr(expr, ctx);
  if (toLiteral !== undefined) {
    if (toLiteral.startsWith("/")) {
      return `<.link navigate={~p"${toLiteral}"}${testidAttr}>${label}</.link>`;
    }
    return `<a href="${toLiteral}"${testidAttr}>${label}</a>`;
  }
  // Dynamic route expression — emit it as a HEEx expression attribute.
  return `<.link navigate={${toExpr}}${testidAttr}>${label}</.link>`;
}

/** `Modal(trigger: Button(...), title: "…", OperationForm(of: Agg, op: x))`
 *  → a `<.button phx-click={show_modal(id)}>` trigger followed by
 *  a `<.modal id=…>` hosting a `<.simple_form for={@<op>_form}>`
 *  whose inputs are the operation's params.  Registers an
 *  `kind:"operation"` FormBinding the LiveView emitter turns into
 *  the `@<op>_form` assign + `validate_<op>`/`submit_<op>`
 *  handle_event clauses.  The `OperationForm(of:, op:)` child is consumed
 *  here (never visited by renderChild) — mirrors the React
 *  walker's `emitModal`. */
export function renderModal(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let title = "";
  let triggerExpr: ExprIR | undefined;
  let openExpr: ExprIR | undefined;
  const positional: ExprIR[] = [];
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "title") {
      title =
        arg.kind === "literal"
          ? escapeHeexText(arg.value)
          : renderExpr(arg, { ...ctx, position: "template" });
    } else if (name === "trigger") {
      triggerExpr = arg;
    } else if (name === "open") {
      openExpr = arg;
    } else if (!name) {
      positional.push(arg);
    }
  }
  const formChild = positional.find(
    (c): c is Extract<ExprIR, { kind: "call" }> => c.kind === "call" && c.name === "OperationForm",
  );
  // State-controlled modal: `Modal { <children>, open: <stateBool>, title: "…" }`
  // — visibility is a page `state` field (distinct from the operation-form
  // modal).  LiveView idiom: an assign-driven conditional render
  // (`<%= if @open do %> … <% end %>`); the user closes it via a child button
  // that writes the state (`x := false` → the existing handle_event machinery).
  if (!formChild && openExpr?.kind === "ref" && ctx.stateNames.has(snake(openExpr.name))) {
    const openHeex = renderExpr(openExpr, { ...ctx, position: "template" });
    const childrenHeex = positional.map((c) => renderChild(c, ctx)).join("\n");
    const heading = title ? `      <h3 class="mb-4 text-lg font-semibold">${title}</h3>\n` : "";
    return `<%= if ${openHeex} do %>
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div class="w-full max-w-md rounded-xl border bg-white p-6 shadow-lg">
${heading}${childrenHeex}
      </div>
    </div>
    <% end %>`;
  }
  // The op-form names its operation via one of two shapes:
  //
  //   * `OperationForm(<instance>.<operation>)` — receiver is the in-scope
  //     aggregate instance (resolved via `instanceTypes`), member
  //     is the op name.  The classic Detail-page form inside a
  //     QueryView lambda binding.
  //   * `OperationForm(of: <Agg>, op: <opName>)` — flat named args; aggregate
  //     resolved directly by name, id falls back to route.  The
  //     shape `scaffoldOperations(of:)` emits so modals can live
  //     outside a QueryView lambda.
  let opName: string | undefined;
  let ofName: string | undefined;
  if (formChild) {
    const argNames = formChild.argNames ?? [];
    const ofIdx = argNames.indexOf("of");
    const opIdx = argNames.indexOf("op");
    if (ofIdx >= 0 && opIdx >= 0) {
      const ofArg = formChild.args[ofIdx];
      const opArg = formChild.args[opIdx];
      if (ofArg?.kind === "ref" && opArg?.kind === "ref") {
        ofName = ofArg.name;
        opName = opArg.name;
      }
    }
    if (!opName) {
      const opRefNode = formChild.args.find((_, i) => !formChild.argNames?.[i]);
      if (opRefNode?.kind === "member" && opRefNode.receiver.kind === "ref") {
        const instanceName = opRefNode.receiver.name;
        opName = opRefNode.member;
        ofName = ctx.instanceTypes?.get(instanceName);
      }
    }
  }
  if (!formChild || !ofName || !opName) {
    return `<!-- malformed Modal: expected trigger: Button + OperationForm(<instance>.<op>) or OperationForm(of:, op:) -->`;
  }
  const aggSnake = snake(ofName);
  const opSnake = snake(opName);
  const modalId = `${aggSnake}-op-${opSnake}-modal`;
  const formAssign = `${opSnake}_form`;

  const agg = ctx.aggregatesByName.get(ofName);
  const op = agg?.operations.find((o) => o.name === opName);
  const params = op ? op.params.map((p) => ({ name: p.name, type: p.type })) : [];

  ctx.formBindings.push({
    kind: "operation",
    name: ofName,
    op: opSnake,
    modalId,
    params,
  });

  // Trigger button surface from the `trigger: Button(...)` arg.
  let label = humanize(opName);
  let testid = "";
  if (triggerExpr && triggerExpr.kind === "call" && triggerExpr.name === "Button") {
    for (let i = 0; i < triggerExpr.args.length; i++) {
      const n = triggerExpr.argNames?.[i];
      const a = triggerExpr.args[i]!;
      if (!n && a.kind === "literal") label = a.value;
      else if (n === "testid" && a.kind === "literal") testid = a.value;
    }
  }
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  const heading = title || humanize(opName);

  const inputs =
    params.length > 0
      ? params.map(
          (p) =>
            `    ${renderFieldInputForField(
              p,
              formAssign,
              ctx.enumsByName,
              ctx.idOptionsBindings,
              ctx.valueObjectsByName,
            )}`,
        )
      : [`    <%!-- ${opSnake} has no parameters --%>`];

  return [
    `<.button phx-click={show_modal("${modalId}")}${testidAttr}>${label}</.button>`,
    `<.modal id="${modalId}">`,
    `  <:title>${heading}</:title>`,
    `  <.simple_form for={@${formAssign}} phx-change="validate_${opSnake}" phx-submit="submit_${opSnake}">`,
    ...inputs,
    `    <:actions>`,
    `      <.button type="submit">${heading}</.button>`,
    `    </:actions>`,
    `  </.simple_form>`,
    `</.modal>`,
  ].join("\n");
}

/** `CreateForm(of: Agg, testid: "...", ...)` → `<.simple_form>` with auto
 *  inputs derived from the aggregate/workflow args.
 *  `runs: Wf` (workflow form) also emits a `<.simple_form>` but
 *  tied to the workflow action name. */
export function renderForm(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  // `OperationForm(<instance>.<operation>)` is the operation-modal form —
  // owned and rendered by `renderModal` (it consumes its Form child
  // directly).  This guard makes the function total if a stray
  // op-form is ever reached without its Modal wrapper: bail before
  // pushing a bogus `kind:"aggregate"` create binding.
  const positional0 = expr.args.find((_, i) => !expr.argNames?.[i]);
  if (positional0 && positional0.kind === "member") return "";
  let ofTarget = "";
  let runsTarget = "";
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "of") {
      ofTarget =
        arg.kind === "ref" ? snake(arg.name) : renderExpr(arg, { ...ctx, position: "template" });
    } else if (name === "runs") {
      runsTarget =
        arg.kind === "ref" ? snake(arg.name) : renderExpr(arg, { ...ctx, position: "template" });
    }
  }
  const submitEvent = ofTarget ? `save_${ofTarget}` : runsTarget ? `run_${runsTarget}` : "submit";
  const testidAttr = testIdAttr(expr, ctx);
  // Register a form binding so the LiveView emitter can assign @form
  // in mount/3.  We track the PascalCase name; emitter handles
  // module-name resolution against contexts + workflows.
  const ofPascal = findPascalArg(expr, "of");
  const runsPascal = findPascalArg(expr, "runs");
  if (ofPascal) {
    ctx.formBindings.push({ kind: "aggregate", name: ofPascal });
  } else if (runsPascal) {
    ctx.formBindings.push({ kind: "workflow", name: runsPascal });
  }
  // Field inputs — derive one <.input> per user-input field on the
  // bound aggregate.  Excludes the `id` primary key (auto-generated on
  // insert).  Falls back to a single labelled placeholder if
  // the aggregate isn't in the registry — keeps the form well-formed
  // even when scaffold expansion hands us a Form referencing a name
  // the walker can't resolve (shouldn't happen in practice; the
  // validator catches unknowns upstream, but the fallback keeps the
  // emitter total).
  const inputs: string[] = [];
  if (ofPascal) {
    const agg = ctx.aggregatesByName.get(ofPascal);
    if (agg) {
      // Render the create-input contract (`createInputFields`), not raw
      // `agg.fields` — server-owned fields (`managed`/`token`/`internal`,
      // incl. `stamp` targets promoted by `promoteStampTargets`) must not
      // surface as client inputs; the LiveView save path stamps them at
      // persist.  Unlike the JS `CreateForm`, optionals stay rendered —
      // the HEEx form has no update flow to defer them to.
      for (const f of createInputFields(agg)) {
        if (f.name === "id") continue;
        inputs.push(
          `  ${renderFieldInputForField(
            f,
            "form",
            ctx.enumsByName,
            ctx.idOptionsBindings,
            ctx.valueObjectsByName,
          )}`,
        );
      }
    }
  }
  if (inputs.length === 0) {
    inputs.push(`  <.input field={@form[:_placeholder]} label="Field" />`);
  }
  return [
    `<.simple_form for={@form} phx-submit="${submitEvent}"${testidAttr}>`,
    ...inputs,
    `  <:actions>`,
    `    <.button type="submit">Submit</.button>`,
    `  </:actions>`,
    `</.simple_form>`,
  ].join("\n");
}

/** Extract a named arg whose value is a `ref` and return its
 *  PascalCase name (the source-level identifier, undisturbed).
 *  Used by renderForm to look up the `of:`/`runs:` targets in the
 *  aggregate/workflow registries.  Returns undefined if the arg
 *  isn't present or isn't a ref. */
function findPascalArg(
  expr: Extract<ExprIR, { kind: "call" }>,
  argName: string,
): string | undefined {
  for (let i = 0; i < expr.args.length; i++) {
    if (expr.argNames?.[i] !== argName) continue;
    const a = expr.args[i];
    if (a && a.kind === "ref") return a.name;
    return undefined;
  }
  return undefined;
}

/** Emit a `<.input>` for a single aggregate field.  Picks the HTML
 *  input type from the IR type and labels it from a humanized name.
 *  Enum + `X id` + value-object types lower to higher-shape elements
 *  (`<.input type="select" …>`, `<.inputs_for :let={…}>`); the rest
 *  dispatch to `htmlInputTypeForIRType`. */
function renderFieldInputForField(
  f: { name: string; type: TypeIR },
  formAssign = "form",
  enumsByName?: ReadonlyMap<string, EnumIR>,
  /** Side-effect sink for `X id` field types.  When the walker
   *  encounters `customerId: Customer id`, it pushes "Customer"
   *  here; renderMount in liveview-emit.ts iterates these and
   *  loads the target list at mount so the select's
   *  `options={@<x_snake>_options}` resolves. */
  idOptionsBindings?: Set<string>,
  /** Workspace-wide VO registry.  When supplied, VO-typed fields
   *  render as `<.inputs_for :let={X_form}>` nested-form blocks
   *  with one `<.input>` per VO field (recursing through this
   *  function).  Without it (tests / fallbacks), VOs default to
   *  text input. */
  valueObjectsByName?: ReadonlyMap<string, ValueObjectIR>,
  /** Sigil prefix for the form field reference.  Top-level callers
   *  use the default `@` (form is a LiveView assign — `@form[:f]`).
   *  Recursive nested-form callers pass `""` because the nested
   *  form is a local variable bound by `:let={…}` (`f_form[:sub]`,
   *  no `@`). */
  assignPrefix = "@",
): string {
  const fieldName = snake(f.name);
  const label = humanize(f.name);
  // Enum fields render as `<.input type="select" options={[...]}>`.
  // Phoenix CoreComponents' `<.input>` accepts an `options` list of
  // strings (when label == value) or `{label, value}` tuples.  Loom
  // enums have a flat string list; the label IS the value.  Falls
  // back to text input when the enum can't be resolved (registry
  // empty or name unknown) so the form stays valid.
  const inner = f.type.kind === "optional" ? f.type.inner : f.type;
  if (inner.kind === "enum" && enumsByName) {
    const en = enumsByName.get(inner.name);
    if (en) {
      const options = en.values.map((v) => JSON.stringify(v)).join(", ");
      return `<.input field={${assignPrefix}${formAssign}[:${fieldName}]} type="select" label="${label}" options={[${options}]} />`;
    }
  }
  // `X id` fields render as `<.input type="select" options={@x_options}>`.
  // The options assign is populated by `renderMount` (liveview-emit.ts)
  // from the walker's `idOptionsBindings` set.  Falls back to text
  // input when the binding sink isn't threaded (e.g. tests calling
  // the helper directly).
  if (inner.kind === "id" && idOptionsBindings) {
    idOptionsBindings.add(inner.targetName);
    const optionsVar = `${snake(inner.targetName)}_options`;
    return `<.input field={${assignPrefix}${formAssign}[:${fieldName}]} type="select" label="${label}" options={@${optionsVar}} />`;
  }
  // Value-object fields render as `<.inputs_for :let={<f>_form}>`
  // with one nested `<.input>` per VO field.  The `:let` local
  // variable shadows the outer form scope, so the recursive call
  // passes assignPrefix="" — `f_form[:sub]` instead of `@f_form[:sub]`.
  // The Ecto changeset's embedded-schema cast handles the nested-changeset
  // wiring at validate time.  Falls back to text input when the VO
  // registry isn't threaded or the type's name isn't found.
  if (inner.kind === "valueobject" && valueObjectsByName) {
    const vo = valueObjectsByName.get(inner.name);
    if (vo) {
      const nestedFormVar = `${fieldName}_form`;
      // Single-line emission keeps the multi-line indent from the
      // outer template unbroken — the caller prefixes a fixed number
      // of spaces and that prefix applies to the whole `<fieldset>`
      // block.  HEEx is whitespace-tolerant; the rendered DOM nests
      // identically.
      const subInputs = vo.fields
        .map((sub) =>
          renderFieldInputForField(
            sub,
            nestedFormVar,
            enumsByName,
            idOptionsBindings,
            valueObjectsByName,
            "",
          ),
        )
        .join(" ");
      return `<fieldset><legend>${label}</legend><.inputs_for :let={${nestedFormVar}} field={${assignPrefix}${formAssign}[:${fieldName}]}>${subInputs}</.inputs_for></fieldset>`;
    }
  }
  const inputType = htmlInputTypeForIRType(f.type);
  const isDecimal = f.type.kind === "primitive" && f.type.name === "decimal";
  const isMoney = f.type.kind === "primitive" && f.type.name === "money";
  // money fields render as text inputs with a decimal-format pattern
  // — number inputs can carry "1e10" notation that's lossy on parse;
  // text + pattern preserves the precise string the wire expects.
  const extraAttrs = isDecimal
    ? ` step="0.01"`
    : isMoney
      ? ` pattern="^-?\\d+(\\.\\d+)?$" inputmode="decimal"`
      : "";
  return `<.input field={${assignPrefix}${formAssign}[:${fieldName}]} type="${inputType}" label="${label}"${extraAttrs} />`;
}

/** Map a TypeIR to the HTML `<input type="…">` attribute the form
 *  inputs use.  Defaults to "text" for anything not specifically mapped —
 *  including T id, enum (until the select variant lands), and
 *  value-object embeds (which would be split into per-leaf inputs
 *  in a deeper pass — out of scope here). */
function htmlInputTypeForIRType(t: TypeIR): string {
  if (t.kind === "optional") return htmlInputTypeForIRType(t.inner);
  if (t.kind !== "primitive") return "text";
  switch (t.name) {
    case "int":
    case "long":
    case "decimal":
      return "number";
    case "money":
      return "text";
    case "bool":
      return "checkbox";
    case "datetime":
      return "datetime-local";
    default:
      return "text";
  }
}

/** `For { each: <coll>, empty?: <markup>, <item> => <markup> }` →
 *  `<%= for <item> <- <coll> do %> … <% end %>` — LiveView's
 *  for-comprehension block.  No keyed wrapper: the `key:` arg is a
 *  client-framework reconciliation hint (React/Vue/Svelte) with no
 *  HEEx analogue, so it's accepted-and-ignored here.  The loop
 *  variable is a plain local (bare `snake(name)`), so item refs in the
 *  body resolve through `renderRef`'s unknown-refKind fall-through —
 *  same mechanism the Table `<:col :let={row}>` slot relies on.
 *
 *  An `empty:` arm wraps the comprehension in an `Enum.empty?/1` guard
 *  (`for` has no native else clause).  The collection is read twice —
 *  fine for the page DSL's simple `each:` refs / assigns. */
export function renderFor(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let coll: ExprIR | undefined;
  let itemLam: Extract<ExprIR, { kind: "lambda" }> | undefined;
  let emptyExpr: ExprIR | undefined;
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (arg.kind === "lambda") {
      // First positional (or `render:`) lambda is the item renderer;
      // a `key:` lambda has no HEEx analogue and is skipped.
      if (name === undefined || name === "render") itemLam ??= arg;
      continue;
    }
    if (name === "each") coll = arg;
    else if (name === "empty") emptyExpr = arg;
    else if (name === undefined) coll ??= arg;
  }
  if (!coll) {
    return `<%!-- For: missing 'each:' collection expression --%>`;
  }
  if (!itemLam?.body) {
    return `<%!-- For: missing item lambda --%>`;
  }
  const itemVar = snake(itemLam.param);
  const collHeex = renderExpr(coll, { ...ctx, position: "template" });
  const body = renderChild(itemLam.body, ctx);
  const loop = [`<%= for ${itemVar} <- ${collHeex} do %>`, indent(body, 2), `<% end %>`].join("\n");
  if (!emptyExpr) return loop;
  const emptyBody = renderChild(emptyExpr, ctx);
  return [
    `<%= if Enum.empty?(${collHeex}) do %>`,
    indent(emptyBody, 2),
    `<% else %>`,
    indent(loop, 2),
    `<% end %>`,
  ].join("\n");
}

/** `Table(Column(...), ..., rows: ref("rows"), ...)` →
 *  `<.table id="..." rows={@rows}>` with `<:col :let={row}>` slots. */
export function renderTable(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let rowsExpr = "@items";
  const cols: ExprIR[] = [];
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (!name) {
      // positional — Column nodes
      cols.push(arg);
    } else if (name === "rows") {
      rowsExpr = renderExpr(arg, { ...ctx, position: "template" });
    }
    // testid handled via the shared helpers below; striped / highlight /
    // sticky / rowTestid / keyExpr — ignored in HEEx (Mantine-specific props;
    // CoreComponents.table doesn't use them)
  }
  // `<.table>` requires an `id` (Phoenix.Component hook contract); reuse
  // `testid:` for it, defaulting to "data-table".  When `testid:` is supplied
  // it ALSO emits as `data-testid` so Playwright/lvtest selectors match TSX.
  // A dynamic `testid:` rides `id={…}` / `data-testid={…}` expression
  // attributes — never quoted literals (see attrValue).
  const testidIdx = (expr.argNames ?? []).indexOf("testid");
  const testidArg = testidIdx >= 0 ? expr.args[testidIdx] : undefined;
  const idAttr = testidArg ? attrValue(testidArg, ctx) : `"data-table"`;
  const testidAttr = testIdAttr(expr, ctx);
  const colSlots = cols
    .map((c) =>
      c.kind === "call"
        ? renderTableColumn(c, ctx)
        : `<:col :let={_row} label="Column">${renderChild(c, ctx)}</:col>`,
    )
    .join("\n");
  return [
    `<.table id=${idAttr}${testidAttr} rows={${rowsExpr}}>`,
    colSlots.length > 0 ? indent(colSlots, 2) : `  <:col :let={_row} label="Data"></:col>`,
    `</.table>`,
  ].join("\n");
}

/** Render a `Column("label", accessor_lambda)` node as a
 *  `<:col :let={row} label="...">...</:col>` slot.  Called only from
 *  `renderTable` — never registered as a top-level primitive because
 *  Column nodes are always children of Table in the expander output. */
export function renderTableColumn(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  if (expr.name !== "Column") {
    // Unexpected shape — emit a stub slot.
    return `<:col :let={_row} label="Column">${renderChild(expr, ctx)}</:col>`;
  }
  // First positional arg: label string
  // Second positional arg: accessor lambda `fn cell -> renderCell(cell) end`
  let label = "Column";
  let cellHeex = "<%= row %>";
  const labelArg = expr.args.find((_, i) => !expr.argNames?.[i]);
  const lambdaArg = expr.args.find((a, i) => !expr.argNames?.[i] && a.kind === "lambda");
  const positionals = expr.args.filter((_, i) => !expr.argNames?.[i]);
  if (positionals[0]) {
    label =
      positionals[0].kind === "literal"
        ? positionals[0].value
        : renderExpr(positionals[0], { ...ctx, position: "template" });
  }
  void labelArg;
  const accessor = lambdaArg ?? positionals[1];
  if (accessor && accessor.kind === "lambda" && accessor.body) {
    // The row variable is a :let={o} slot binding — a local variable, NOT
    // a LiveView assign.  Do NOT add it to stateNames (which would give
    // it an `@` prefix).  The renderRef fall-through for "unknown" refKind
    // returns bare `snake(name)`, which is exactly what we want inside the
    // <:col :let={o}> slot.
    cellHeex = renderChild(accessor.body, ctx);
  }
  return `<:col :let={${renderColLetVar(accessor, ctx)}} label="${label}">${cellHeex}</:col>`;
}

/** Extract the row variable name from a Column accessor lambda for the
 *  `:let={row}` binding.  Falls back to `"row"` when shape is unexpected. */
function renderColLetVar(accessor: ExprIR | undefined, _ctx: WalkContext): string {
  if (accessor && accessor.kind === "lambda") return snake(accessor.param);
  return "row";
}

/** `QueryView(of: expr, loading: ..., error: ..., empty: ..., data: rows => ...)` →
 *  LiveView-idiomatic conditional rendering.
 *
 *  The `data:` lambda's parameter (usually `rows` or `data`) maps to a
 *  LiveView assign (`@items` or `@data`).  mount() is responsible for
 *  pre-loading (or setting nil for lazy loading).  The success branch
 *  renders the lambda body directly — the Table primitive reads its
 *  own `rows={…}` from the same assign, so no for-loop is needed here. */
/** Resolve the aggregate PascalCase name out of a `QueryView`
 *  `of:` argument.  The scaffold-expander emits one of:
 *    detail  → method-call `<api>.<Agg>.byId(id)` (receiver is a
 *              member `{receiver: ref(api), member: Agg}`), or the
 *              no-api fallback `<Agg>.byId(id)` (receiver ref(Agg))
 *    list    → member access `<api>.<Agg>.all` (the `.all` is the
 *              outer member; its receiver is `<api>.<Agg>`), or the
 *              fallback bare `ref(Agg)` / `<Agg>.all`. */
function resolveQueryAggregate(arg: ExprIR): string | undefined {
  if (arg.kind === "method-call") {
    if (arg.receiver.kind === "member") return arg.receiver.member;
    if (arg.receiver.kind === "ref") return arg.receiver.name;
  }
  if (arg.kind === "member") {
    // `<api>.<Agg>.all` → receiver is `<api>.<Agg>` (a member);
    // `<Agg>.all` → receiver is ref(Agg).
    if (arg.receiver.kind === "member") return arg.receiver.member;
    if (arg.receiver.kind === "ref") return arg.receiver.name;
    return arg.member;
  }
  if (arg.kind === "ref") return arg.name;
  return undefined;
}

export function renderQueryView(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let ofExpr = "";
  let ofArgNode: ExprIR | undefined;
  let loadingHeex = `<div class="animate-pulse">Loading...</div>`;
  let errorHeex = `<div class="alert alert-error">Error loading data.</div>`;
  let emptyHeex = `<div class="empty">No items.</div>`;
  let dataHeex = "";
  let dataVar = "rows";
  let assignName = "items";
  let isSingle = false;
  let isPaged = false;

  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "of") {
      ofArgNode = arg;
      ofExpr = renderExpr(arg, { ...ctx, position: "template" });
    } else if (name === "single") {
      isSingle = arg.kind === "literal" && arg.value === "true";
    } else if (name === "paged") {
      isPaged = arg.kind === "literal" && arg.value === "true";
    } else if (name === "loading") {
      loadingHeex = renderChild(arg, ctx);
    } else if (name === "error") {
      errorHeex = renderChild(arg, ctx);
    } else if (name === "empty") {
      emptyHeex = renderChild(arg, ctx);
    } else if (name === "data") {
      if (arg.kind === "lambda") {
        dataVar = snake(arg.param);
        // Map the lambda param name to a LiveView assign.
        // Convention: "rows" → @items (list pages), "data" → @data (detail pages)
        assignName = dataVar === "rows" ? "items" : dataVar;
        // Build a remapping so ref("rows") → @items, ref("data") → @data, etc.
        const remapping = new Map<string, string>([[dataVar, assignName]]);
        // Type the data binding so a nested instance-qualified op-form
        // (`OperationForm(data.confirm)`) resolves the aggregate it operates on.
        const recordAgg = isSingle && ofArgNode ? resolveQueryAggregate(ofArgNode) : undefined;
        const innerCtx: WalkContext = {
          ...ctx,
          varRemapping: remapping,
          instanceTypes:
            recordAgg && ctx.aggregatesByName.has(recordAgg)
              ? new Map([...(ctx.instanceTypes ?? []), [arg.param, recordAgg]])
              : ctx.instanceTypes,
        };
        if (arg.body) dataHeex = renderChild(arg.body, innerCtx);
      } else {
        dataHeex = renderChild(arg, ctx);
      }
    }
  }
  void ofExpr;

  // Register the query binding so the LiveView emitter loads the
  // record(s) in handle_params (the assign the cond below reads is
  // never populated otherwise — see QueryBinding).
  const aggName = ofArgNode ? resolveQueryAggregate(ofArgNode) : undefined;
  if (aggName) {
    ctx.queryBindings.push({
      kind: isSingle ? "single" : "list",
      assign: assignName,
      aggregate: aggName,
    });
  }

  if (isSingle) {
    // Single-record (detail page).  handle_params assigns one of:
    //   nil        → still loading            → loading branch
    //   :error     → load error               → error branch
    //   :not_found → no record for that id     → empty branch
    //   record     → loaded                    → data branch
    return [
      `<%= cond do %>`,
      `  <% is_nil(@${assignName}) -> %>`,
      `    ${loadingHeex}`,
      `  <% @${assignName} == :error -> %>`,
      `    ${errorHeex}`,
      `  <% @${assignName} == :not_found -> %>`,
      `    ${emptyHeex}`,
      `  <% true -> %>`,
      `    ${dataHeex}`,
      `<% end %>`,
    ].join("\n");
  }

  // List query: check for nil (loading), error, empty, then render data.
  // The Table primitive already iterates @items internally via rows={@items},
  // so no Elixir for-loop is needed here.  When the auto-`findAll` is paged
  // (M-T2.6) the assign is the `%{items, page, …}` envelope, so the emptiness
  // guard unwraps `.items` (the pager/sort UI itself stays HEEx-pinned per the
  // M-T1.1 heex-parity reason — this is only the envelope-unwrap the flip forces).
  const emptyTarget = isPaged ? `@${assignName}.items` : `@${assignName}`;
  return [
    `<%= cond do %>`,
    `  <% is_nil(@${assignName}) -> %>`,
    `    ${loadingHeex}`,
    `  <% @${assignName} == :error -> %>`,
    `    ${errorHeex}`,
    `  <% Enum.empty?(${emptyTarget}) -> %>`,
    `    ${emptyHeex}`,
    `  <% true -> %>`,
    `    ${dataHeex}`,
    `<% end %>`,
  ].join("\n");
}

/** `KeyValueRow("Label", value_expr)` → `<div class="key-value-row">` */
export function renderKeyValueRow(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  let testid = "";
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "testid" && arg.kind === "literal") testid = arg.value;
  }
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  const positionals = expr.args.filter((_, i) => !expr.argNames?.[i]);
  const label =
    positionals[0]?.kind === "literal"
      ? escapeHeexText(positionals[0].value)
      : positionals[0]
        ? renderInTemplate(positionals[0], ctx)
        : "Field";
  const value = positionals[1] ? renderInTemplate(positionals[1], ctx) : "";
  return `<div class="key-value-row"${testidAttr}>\n  <dt class="key-value-label">${label}</dt>\n  <dd class="key-value-value">${value}</dd>\n</div>`;
}

/** `Skeleton(count: N)` → `<div class="animate-pulse">` repeated loading lines. */
export function renderSkeleton(expr: Extract<ExprIR, { kind: "call" }>, _ctx: WalkContext): string {
  let count = 3;
  let testid = "";
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "count" && arg.kind === "literal") {
      count = parseInt(arg.value, 10) || 3;
    } else if (name === "testid" && arg.kind === "literal") {
      testid = arg.value;
    }
  }
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  const lines = Array.from(
    { length: count },
    () => `  <div class="h-4 bg-gray-200 rounded animate-pulse mb-2"></div>`,
  ).join("\n");
  return `<div class="skeleton"${testidAttr}>\n${lines}\n</div>`;
}

/** `Alert("message")` → `<div class="alert">` */
export function renderAlert(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let color = "red";
  let message = "";
  let testid = "";
  const positionals = expr.args.filter((_, i) => !expr.argNames?.[i]);
  if (positionals[0]) message = renderInTemplate(positionals[0], ctx);
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "color" && arg.kind === "literal") color = arg.value;
    else if (name === "testid" && arg.kind === "literal") testid = arg.value;
  }
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  return `<div class="alert alert-${color}" role="alert"${testidAttr}>${message}</div>`;
}

/** `IdLink(value, of: Aggregate)` → `<.link navigate={...}>value</.link>` */
export function renderIdLink(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let aggName = "";
  let testid = "";
  const positionals = expr.args.filter((_, i) => !expr.argNames?.[i]);
  const valueExpr = positionals[0];
  const valueHeex = valueExpr ? renderInTemplate(valueExpr, ctx) : "";
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "of" && arg.kind === "ref") aggName = snake(plural(arg.name));
    else if (name === "testid" && arg.kind === "literal") testid = arg.value;
  }
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  if (aggName && valueExpr) {
    const idVal = renderExpr(valueExpr, { ...ctx, position: "template" });
    return `<.link navigate={~p"/${aggName}/#{${idVal}}"}${testidAttr}>${valueHeex}</.link>`;
  }
  return `<span${testidAttr}>${valueHeex}</span>`;
}

/** `DateDisplay(date_expr)` → `<time>` with formatted date. */
export function renderDateDisplay(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  let testid = "";
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "testid" && arg.kind === "literal") testid = arg.value;
  }
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  const positionals = expr.args.filter((_, i) => !expr.argNames?.[i]);
  const dateExpr = positionals[0];
  if (!dateExpr) return `<time${testidAttr}></time>`;
  const val = renderExpr(dateExpr, { ...ctx, position: "template" });
  return `<time datetime={to_string(${val})}${testidAttr}><%= Calendar.strftime(${val}, "%Y-%m-%d") %></time>`;
}

/** `EnumBadge(enum_value)` → `<.badge>` with the enum value. */
export function renderEnumBadge(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let testid = "";
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "testid" && arg.kind === "literal") testid = arg.value;
  }
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  const positionals = expr.args.filter((_, i) => !expr.argNames?.[i]);
  const val = positionals[0] ? renderInTemplate(positionals[0], ctx) : "";
  return `<span class="badge badge-enum"${testidAttr}>${val}</span>`;
}

// ---------------------------------------------------------------------------
// Closed primitive library — HEEx component dispatch.
// ---------------------------------------------------------------------------
/** Per-primitive HEEx spec for the generic `renderPrimitive` helper.
 *  Listed inline so the small set is easy to scan.  The registered
 *  per-primitive exports (`renderStack`, `renderHeading`, …) bind to
 *  these specs; the typed dispatch table at
 *  src/generator/_walker/registry.ts wires them up by name. */
const CLOSED_PRIMITIVE_SPECS: Record<string, PrimitiveSpec> = {
  Stack: { tag: "div", staticAttrs: ["class"], takesChildren: true },
  // Heading is rendered by the bespoke `renderHeading` (raw `<h{n}>` with a
  // structure-derived rank), not through this generic spec table.
  Text: { tag: "p", takesChildren: true },
  Card: { tag: "div", staticAttrs: ["class"], takesChildren: true },
  Toolbar: {
    tag: "div",
    staticAttrs: ["class"],
    takesChildren: true,
    extraAttrs: ['role="toolbar"', 'aria-label="Actions"'],
  },
  Group: { tag: "div", staticAttrs: ["class"], takesChildren: true },
  Empty: { tag: ".empty", takesChildren: false },
  Badge: { tag: ".badge", takesChildren: true },
  Button: { tag: ".button", takesChildren: true },
  // --- inline-emphasis primitives — plain HTML inline elements, the
  //     Phoenix analogue of the TSX `<strong>`/`<em>`/`<code>` spans. ---
  Bold: { tag: "strong", takesChildren: true },
  Italic: { tag: "em", takesChildren: true },
  InlineCode: { tag: "code", takesChildren: true },
  // --- scaffold expander primitives ---
  Paper: { tag: "div", staticAttrs: ["class"], takesChildren: true },
  Grid: { tag: "div", staticAttrs: ["class"], takesChildren: true },
  Container: { tag: "div", staticAttrs: ["class"], takesChildren: true },
};

// Per-primitive registry-facing wrappers — bind the generic
// `renderPrimitive` helper to a specific `closedPrimitive` spec so
// the typed dispatch table can reference one named function per
// primitive (rather than re-dispatching by name inside the renderer).
export function renderStack(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  return renderPrimitive(CLOSED_PRIMITIVE_SPECS.Stack!, expr, ctx);
}
/** `Heading("text", level?)` → a raw `<h{n}>` whose rank is the explicit
 *  `level:` (1..6) or, when absent, DERIVED from the enclosing `Section`/`Card`
 *  nesting depth: `min(6, 2 + headingDepth)` — matching the JSX frontends
 *  (`emitHeading` in _walker/primitives/text.ts) so ranks never skip.  At page
 *  top (depth 0) this is `<h2>`; the app shell owns the single `<h1>`.
 *
 *  Emitting a raw `<h{n}>` (vs the fixed-level `.header` CoreComponent, which
 *  always renders an `<h1>`) is what makes the derived rank observable to
 *  assistive tech — the `.header`'s subtitle/action slots are unused by Loom's
 *  `Heading` primitive, so nothing is lost.  The class mirrors `.header`'s own
 *  typography so the visual result is unchanged. */
export function renderHeading(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let level: number | undefined;
  let testid = "";
  const positional: ExprIR[] = [];
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (!name) {
      positional.push(arg);
    } else if (name === "level" && arg.kind === "literal") {
      level = Number(arg.value);
    } else if (name === "testid" && arg.kind === "literal") {
      testid = arg.value;
    }
  }
  const rank = level ?? Math.min(6, 2 + (ctx.headingDepth ?? 0));
  const text = positional[0] ? renderInTemplate(positional[0], ctx) : "";
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  return `<h${rank} class="text-lg font-semibold leading-8 text-zinc-800"${testidAttr}>${text}</h${rank}>`;
}
export function renderText(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  return renderPrimitive(CLOSED_PRIMITIVE_SPECS.Text!, expr, ctx);
}
export function renderBold(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  return renderPrimitive(CLOSED_PRIMITIVE_SPECS.Bold!, expr, ctx);
}
export function renderItalic(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  return renderPrimitive(CLOSED_PRIMITIVE_SPECS.Italic!, expr, ctx);
}
export function renderInlineCode(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  return renderPrimitive(CLOSED_PRIMITIVE_SPECS.InlineCode!, expr, ctx);
}

/** `Divider(label?)` → `<hr />`.  LiveView has no labelled-divider
 *  component; the optional `label:` is dropped (the same fallback the
 *  TSX packs that lack a labelled divider use). */
export function renderDivider(expr: Extract<ExprIR, { kind: "call" }>, _ctx: WalkContext): string {
  let testid = "";
  for (let i = 0; i < expr.args.length; i++) {
    const arg = expr.args[i]!;
    if (expr.argNames?.[i] === "testid" && arg.kind === "literal") testid = arg.value;
  }
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  return `<hr${testidAttr} />`;
}

/** `Image(src, alt)` → `<img src=… alt=… />`.  Literal attrs render as
 *  quoted strings; refs render as `{@assign}` HEEx expressions. */
export function renderImage(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let srcAttr = "";
  let altAttr = "";
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "src") srcAttr = ` src=${attrValue(arg, ctx)}`;
    else if (name === "alt") altAttr = ` alt=${attrValue(arg, ctx)}`;
  }
  const testidAttr = testIdAttr(expr, ctx);
  return `<img${srcAttr}${altAttr}${testidAttr} />`;
}

/** `Stat(label, value)` → a small headline-stat block (dimmed label +
 *  bold value), the HEEx analogue of the TSX `primitive-stat` template. */
export function renderStat(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let testid = "";
  for (let i = 0; i < expr.args.length; i++) {
    const arg = expr.args[i]!;
    if (expr.argNames?.[i] === "testid" && arg.kind === "literal") testid = arg.value;
  }
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  const positionals = expr.args.filter((_, i) => !expr.argNames?.[i]);
  const label = positionals[0] ? renderInTemplate(positionals[0], ctx) : "";
  const value = positionals[1] ? renderInTemplate(positionals[1], ctx) : "";
  return `<div class="stat"${testidAttr}>\n  <div class="stat-label text-sm text-gray-500">${label}</div>\n  <div class="stat-value text-2xl font-semibold">${value}</div>\n</div>`;
}

/** `Avatar(src?, alt?)` → a circle-cropped `<img>`, or a neutral circle
 *  placeholder when no `src:` (the HEEx analogue of the packs' user-icon
 *  fallback). */
export function renderAvatar(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let srcArg: ExprIR | undefined;
  let altArg: ExprIR | undefined;
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "src") srcArg = arg;
    else if (name === "alt") altArg = arg;
  }
  const testidAttr = testIdAttr(expr, ctx);
  const cls = "inline-block h-8 w-8 rounded-full";
  if (srcArg) {
    const altAttr = altArg ? ` alt=${attrValue(altArg, ctx)}` : ` alt=""`;
    return `<img class="${cls} object-cover" src=${attrValue(srcArg, ctx)}${altAttr}${testidAttr} />`;
  }
  return `<span class="${cls} bg-gray-200"${testidAttr}></span>`;
}

/** `Loader(size?)` → an animated spinner.  The optional `size:` is dropped
 *  (a single spinner size, like the packs that don't vary it). */
export function renderLoader(expr: Extract<ExprIR, { kind: "call" }>, _ctx: WalkContext): string {
  let testid = "";
  for (let i = 0; i < expr.args.length; i++) {
    const arg = expr.args[i]!;
    if (expr.argNames?.[i] === "testid" && arg.kind === "literal") testid = arg.value;
  }
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  return `<div class="animate-spin h-6 w-6 rounded-full border-2 border-gray-300 border-t-transparent" role="status" aria-label="Loading"${testidAttr}></div>`;
}

/** `Money(value, currency?, decimals?)` → a money span.  Money values are
 *  `Decimal` in the Phoenix domain, so the amount renders via
 *  `Decimal.to_string/1` (the same cast the HEEx expression renderer uses for
 *  money — heex-walker-core.ts).  An optional `currency:` literal prefixes the
 *  amount; `decimals:` is left to Decimal's natural precision. */
export function renderMoney(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let testid = "";
  let currency: string | undefined;
  let valueArg: ExprIR | undefined;
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "value") valueArg = arg;
    else if (name === "currency" && arg.kind === "literal") currency = arg.value;
    else if (name === "testid" && arg.kind === "literal") testid = arg.value;
    else if (!name && !valueArg) valueArg = arg;
  }
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  const val = valueArg ? renderExpr(valueArg, { ...ctx, position: "template" }) : "0";
  const prefix = currency ? `${currency} ` : "";
  return `<span class="money"${testidAttr}>${prefix}<%= Decimal.to_string(${val}) %></span>`;
}
/** `Slot()` → `{render_slot(@inner_block)}` — the children passthrough inside a
 *  user `component` body.  Flags `ctx.slotUsed` so the component emitter
 *  declares the matching `slot :inner_block`. */
export function renderSlot(_expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  ctx.slotUsed.value = true;
  return `{render_slot(@inner_block)}`;
}

/** `DestroyForm(of: <Agg>)` → a confirm-delete `<.button>` that calls the
 *  aggregate's destroy context function (`destroy_<agg>!(id)`) and navigates
 *  to its list route.  Requires a canonical `destroy` (declare `destroy { }`
 *  or `with crudish`).  Hosted on a detail page, where the route `id` param is
 *  assigned as `@id`.  The delete handler is recorded as a `byId` ActionBinding
 *  and hoisted to the LiveView by the emitter (reusing `Action`'s machinery). */
export function renderDestroyForm(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  let ofName: string | undefined;
  let testid = "";
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "of" && arg.kind === "ref") ofName = arg.name;
    else if (name === "testid" && arg.kind === "literal") testid = arg.value;
  }
  if (!ofName) return `<!-- DestroyForm: expected (of: <Agg>) -->`;
  const agg = ctx.aggregatesByName.get(ofName);
  if (!agg) return `<!-- DestroyForm(of: ${ofName}): aggregate not found -->`;
  if (!agg.canonicalDestroy) {
    return `<!-- DestroyForm(of: ${ofName}): no canonical destroy — declare 'destroy { }' (or use 'with crudish') -->`;
  }
  const eventName = `destroy_${snake(ofName)}`;
  const thenRoute = `/${snake(plural(ofName))}`;
  if (!ctx.actionBindings.some((b) => b.eventName === eventName)) {
    ctx.actionBindings.push({
      agg: ofName,
      op: "destroy",
      opHuman: "Delete",
      eventName,
      thenRoute,
      byId: true,
    });
  }
  const human = humanize(ofName);
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  return `<.button phx-click="${eventName}" phx-value-id={@id} data-confirm="Delete this ${human.toLowerCase()}? This cannot be undone." class="btn-danger"${testidAttr}>Delete ${human}</.button>`;
}

/** `Tabs(Tab(label, body), …)` → a client-side tab switcher.  All panels are
 *  rendered; switching is a `Phoenix.LiveView.JS` toggle (`JS.hide`/`JS.show`
 *  + active-class) — the idiomatic LiveView way to do presentational UI state
 *  with no server round-trip and no verified-route plumbing.  Uses ARIA roles
 *  (tablist/tab/tabpanel) — same roles Mantine's `<Tabs>` emits, so a
 *  role-based e2e spec is portable across React and HEEx.  Each Tabs instance
 *  gets a unique `tabs-<n>` id so its toggle selectors stay scoped. */
export function renderTabs(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let testid = "";
  const tabs: Array<{ label: string; slug: string; body: ExprIR | undefined }> = [];
  let idx = 0;
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "testid" && arg.kind === "literal") {
      testid = arg.value;
      continue;
    }
    if (name) continue; // other named args (style, …) not consumed here
    idx++;
    if (arg.kind === "call" && arg.name === "Tab") {
      const pos = arg.args.filter((_, j) => !arg.argNames?.[j]);
      const labelArg = pos[0];
      const label = labelArg && labelArg.kind === "literal" ? labelArg.value : `Tab ${idx}`;
      tabs.push({ label, slug: snake(label) || `tab-${idx}`, body: pos[1] });
    } else {
      // Bare positional (e.g. `Tabs(Card(...), Card(...))`) — its own panel.
      tabs.push({ label: `Tab ${idx}`, slug: `tab-${idx}`, body: arg });
    }
  }
  if (tabs.length === 0) return `<!-- Tabs: no tabs -->`;
  const id = `tabs-${++ctx.tabSeq.value}`;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const triggers = tabs
    .map((t, i) => {
      const active = i === 0 ? " tab-active" : "";
      const js =
        `JS.hide(to: "[data-tabs='${id}']")` +
        ` |> JS.show(to: "#${id}-panel-${t.slug}")` +
        ` |> JS.remove_class("tab-active", to: "[data-tabs-tab='${id}']")` +
        ` |> JS.add_class("tab-active", to: "#${id}-tab-${t.slug}")`;
      return `    <button type="button" role="tab" id="${id}-tab-${t.slug}" data-tabs-tab="${id}" class="tab${active}" phx-click={${js}}>${esc(t.label)}</button>`;
    })
    .join("\n");
  const panels = tabs
    .map((t, i) => {
      const hidden = i === 0 ? "" : " hidden";
      const body = t.body ? renderChild(t.body, ctx) : "";
      return `  <div role="tabpanel" id="${id}-panel-${t.slug}" data-tabs="${id}" class="tab-panel${hidden}">\n${indent(body, 4)}\n  </div>`;
    })
    .join("\n");
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  return `<div class="tabs"${testidAttr}>\n  <div role="tablist" class="tab-bar">\n${triggers}\n  </div>\n${panels}\n</div>`;
}

// ---------------------------------------------------------------------------
// Standalone controlled inputs — Field / NumberField / PasswordField /
// MultilineField / SelectField / Toggle.  Each binds to a page `state` field
// via `bind:` and renders the app's `<.input>` core component with a
// `phx-change` that writes the new value back to the assign through a hoisted
// `handle_event` clause — the idiomatic LiveView "state-bound input" (the
// server-side analogue of the React controlled-input-over-useState).
//
// In-form inputs go through Form-level dispatch (renderFieldInputForField);
// this path only fires for inputs that appear *standalone* in a page body.
// A `bind:` that isn't a known state field renders a disabled stub (nothing
// to two-way bind to) so the page still renders.
// ---------------------------------------------------------------------------
function controlledInput(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
  type: "text" | "number" | "password" | "textarea" | "select" | "checkbox",
): string {
  let label = "";
  let bind: string | undefined;
  let testid = "";
  let optionsExpr: ExprIR | undefined;
  let seenPositional = false;
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (!name) {
      if (!seenPositional && arg.kind === "literal") label = arg.value;
      seenPositional = true;
    } else if (name === "bind" && arg.kind === "ref") bind = arg.name;
    else if (name === "options") optionsExpr = arg;
    else if (name === "testid" && arg.kind === "literal") testid = arg.value;
  }
  const labelAttr = label ? ` label="${label.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"` : "";
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  if (!bind || !ctx.stateNames.has(bind)) {
    const opt = type === "select" ? ` options={[]}` : "";
    return `<.input type="${type}" name="_unbound"${labelAttr}${opt} value="" disabled${testidAttr} />`;
  }
  const field = snake(bind);
  const isCheckbox = type === "checkbox";
  const eventName = isCheckbox ? `toggle_${field}` : `update_${field}`;
  // Hoist the write-back handler once per bound field.
  if (!ctx.handlers.some((h) => h.name === eventName)) {
    ctx.handlers.push({
      name: eventName,
      paramsPattern: `%{"${field}" => value}`,
      body: [
        `    {:noreply, assign(socket, :${field}, ${isCheckbox ? `value == "true"` : "value"})}`,
      ],
    });
  }
  const optionsAttr =
    type === "select"
      ? ` options={${optionsExpr ? renderExpr(optionsExpr, { ...ctx, position: "template" }) : "[]"}}`
      : "";
  return `<.input type="${type}" name="${field}" value={@${field}}${optionsAttr}${labelAttr} phx-change="${eventName}"${testidAttr} />`;
}

export function renderField(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  return controlledInput(expr, ctx, "text");
}
export function renderNumberField(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  return controlledInput(expr, ctx, "number");
}
export function renderPasswordField(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  return controlledInput(expr, ctx, "password");
}
export function renderMultilineField(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  return controlledInput(expr, ctx, "textarea");
}
export function renderSelectField(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  return controlledInput(expr, ctx, "select");
}
export function renderToggle(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  return controlledInput(expr, ctx, "checkbox");
}
export function renderCard(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  // A Card is a heading-nesting level (like the JSX `emitCard`): a `Heading`
  // inside it derives a rank one deeper (accessibility.md Phase 2).  Pass a
  // depth-incremented context so `renderPrimitive`'s child walk sees it.
  return renderPrimitive(CLOSED_PRIMITIVE_SPECS.Card!, expr, {
    ...ctx,
    headingDepth: (ctx.headingDepth ?? 0) + 1,
  });
}
export function renderToolbar(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  return renderPrimitive(CLOSED_PRIMITIVE_SPECS.Toolbar!, expr, ctx);
}
export function renderGroup(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  return renderPrimitive(CLOSED_PRIMITIVE_SPECS.Group!, expr, ctx);
}
export function renderEmpty(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  return renderPrimitive(CLOSED_PRIMITIVE_SPECS.Empty!, expr, ctx);
}
export function renderBadge(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  return renderPrimitive(CLOSED_PRIMITIVE_SPECS.Badge!, expr, ctx);
}
export function renderButton(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  return renderPrimitive(CLOSED_PRIMITIVE_SPECS.Button!, expr, ctx);
}
export function renderPaper(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  return renderPrimitive(CLOSED_PRIMITIVE_SPECS.Paper!, expr, ctx);
}
export function renderGrid(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  return renderPrimitive(CLOSED_PRIMITIVE_SPECS.Grid!, expr, ctx);
}
export function renderContainer(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  return renderPrimitive(CLOSED_PRIMITIVE_SPECS.Container!, expr, ctx);
}

/** `Section(...children, id: "anchor")` → `<section id="anchor">…</section>`.
 *  Semantic anchor target for in-page navigation (matches the TSX
 *  `<section>` element exactly — same HTML semantics, no Phoenix-
 *  specific wrapping).  `id:` and `testid:` are extracted as
 *  attributes; positional children render through the standard child
 *  pipeline. */
export function renderSection(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let id: string | undefined;
  let testid = "";
  const positional: ExprIR[] = [];
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (!name) {
      positional.push(arg);
    } else if (name === "id" && arg.kind === "literal") {
      id = arg.value;
    } else if (name === "testid" && arg.kind === "literal") {
      testid = arg.value;
    }
  }
  const idAttr = id ? ` id="${id}"` : "";
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  // A Section is a heading-nesting level (like the JSX `emitSection`): a
  // `Heading` in its body derives a rank one deeper (accessibility.md Phase 2).
  const childCtx: WalkContext = { ...ctx, headingDepth: (ctx.headingDepth ?? 0) + 1 };
  const childrenHeex = positional.map((c) => renderChild(c, childCtx)).join("\n");
  if (childrenHeex.length === 0) {
    return `<section${idAttr}${testidAttr} />`;
  }
  return `<section${idAttr}${testidAttr}>\n${indent(childrenHeex, 2)}\n</section>`;
}

/** `Sticky(...children, top: "0")` → `<div style="position: sticky; top: 0; z-index: 100">…</div>`.
 *  Pins the wrapped content on scroll.  `top:` defaults to `"0"`
 *  matching the TSX `Sticky` primitive's default; the `z-index: 100`
 *  matches the Mantine pack's inline style.  `testid:` extracted
 *  the same way as `renderSection`. */
export function renderSticky(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let top = "0";
  let testid = "";
  const positional: ExprIR[] = [];
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (!name) {
      positional.push(arg);
    } else if (name === "top" && arg.kind === "literal") {
      top = arg.value;
    } else if (name === "testid" && arg.kind === "literal") {
      testid = arg.value;
    }
  }
  const style = `style="position: sticky; top: ${top}; z-index: 100"`;
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  const childrenHeex = positional.map((c) => renderChild(c, ctx)).join("\n");
  if (childrenHeex.length === 0) {
    return `<div ${style}${testidAttr} />`;
  }
  return `<div ${style}${testidAttr}>\n${indent(childrenHeex, 2)}\n</div>`;
}

/** `CodeBlock("source", title?: "…", language?: "ts")` →
 *  `<pre class="loom-code-block"><code class="language-ts">source</code></pre>`.
 *  With an optional `title:`, wraps the `<pre>` in a `<div>` with a
 *  title bar — matches the Mantine pack's `<pre>` + title pattern.
 *  Source content is HTML-escaped to keep markup safe (the source
 *  IS user code; entities are part of valid display). */
export function renderCodeBlock(
  expr: Extract<ExprIR, { kind: "call" }>,
  _ctx: WalkContext,
): string {
  let source = "";
  let title: string | undefined;
  let language = "";
  let testid = "";
  const positional: ExprIR[] = [];
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (!name) {
      positional.push(arg);
    } else if (name === "title" && arg.kind === "literal") {
      title = arg.value;
    } else if (name === "language" && arg.kind === "literal") {
      language = arg.value;
    } else if (name === "testid" && arg.kind === "literal") {
      testid = arg.value;
    }
  }
  if (positional[0]?.kind === "literal") source = positional[0].value;
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  const langClass = language ? ` class="language-${language}"` : "";
  const escaped = escapeHeexText(source);
  if (title) {
    return (
      `<div class="loom-code-block"${testidAttr}>\n` +
      `  <div class="loom-code-block-title">${escapeHeexText(title)}</div>\n` +
      `  <pre><code${langClass}>${escaped}</code></pre>\n` +
      `</div>`
    );
  }
  return `<pre class="loom-code-block"${testidAttr}><code${langClass}>${escaped}</code></pre>`;
}

/** `Icon(name: "github", size: "md")` or `Icon(svg: "<svg…>")` →
 *  `<span class="loom-icon loom-icon-md">…svg…</span>`.  The SVG
 *  content is emitted verbatim — Loom's IR has already resolved
 *  either the builtin-name lookup or the user-supplied literal
 *  before the walker sees it (matches the TSX path at
 *  `walker/primitives/icon.ts:32`). */
export function renderIcon(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let name: string | undefined;
  let customSvg: string | undefined;
  let size: string | undefined;
  let testid = "";
  let label: string | undefined;
  let decorative = false;
  for (let i = 0; i < expr.args.length; i++) {
    const argName = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (argName === "name" && arg.kind === "literal") name = arg.value;
    else if (argName === "svg" && arg.kind === "literal") customSvg = arg.value;
    else if (argName === "size" && arg.kind === "literal") size = arg.value;
    else if (argName === "testid" && arg.kind === "literal") testid = arg.value;
    else if (argName === "label" && arg.kind === "literal") label = arg.value;
    else if (argName === "decorative" && arg.kind === "literal")
      decorative = String(arg.value) === "true";
  }
  // User-supplied SVG wins; falls back to the builtin registry (same
  // precedence as the TSX emitter at `walker/primitives/icon.ts:32`).
  // Walker doesn't import the registry today — pages that pass `name:`
  // without `svg:` against an unknown builtin surface as an empty
  // icon.  Acceptable for v0; a future change can import the registry
  // and emit a `<!-- unknown icon: <name> -->` comment for unresolved
  // names matching the TSX shape.
  void name;
  void ctx;
  const svg = customSvg ?? "";
  const sizeClass = size ? ` loom-icon-${size}` : "";
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  // Decorative-by-default (icon a11y contract): hidden from assistive tech
  // unless a `label:` gives it meaning.  Same fragment the JSX/markup packs
  // render via `iconA11yAttr` — HEEx shares the HTML spelling.
  const a11yAttr = iconA11yAttr({ label, decorative });
  return `<span class="loom-icon${sizeClass}"${testidAttr}${a11yAttr}>${svg}</span>`;
}
