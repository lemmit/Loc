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
import { tryDetectApiHook } from "../_walker/api-hook-detector.js";
import { skipsEntityHistoryRead } from "../_walker/history-read.js";
import { queryShape } from "../_walker/paged-query.js";
import { simpleAccessorField } from "../_walker/primitives/data-grid-shape.js";
import { gridCols } from "../_walker/shared/args.js";
import {
  escapeHeexAttr,
  escapeHeexText,
  indent,
  isAttrRenderable,
  localizedHeexAttr,
  type PrimitiveSpec,
  positionalRole,
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
 *  can't reappear one renderer at a time.
 *
 *  A value that is not renderable as an attribute at all (a LIST / OBJECT /
 *  LAMBDA — see `isAttrRenderable`) degrades to the empty string: these call
 *  sites (`src:`, `alt:`, `id:`, `testid:`) have a required attribute to fill,
 *  and an empty one is inert markup where the raw splice was a render-time
 *  crash in Phoenix's attribute escaper. */
export function attrValue(arg: ExprIR, ctx: WalkContext): string {
  if (!isAttrRenderable(arg)) return `""`;
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
  label = positional[0] ? renderInTemplate(positional[0], ctx, "anchor") : "";
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
      // A user-visible named slot (`modalTitle`) — translated under i18n
      // (M-T1.11), the raw escaped literal otherwise (byte-identical).
      title =
        arg.kind === "literal"
          ? renderInTemplate(arg, ctx, "modalTitle")
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
  //     resolved directly by name, id falls back to route.  The by-name shape
  //     for a hand-written page with no loaded record (the scaffold's Detail
  //     modals are instance-qualified inside the QueryView data lambda).
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
  // Without an explicit `testid:`, each table on the page gets its own default
  // id — `data-table`, then `data-table-2`, … — because `<.table>`'s `id` must
  // be unique for LiveView's DOM patching (and for a11y).  The first keeps the
  // bare name, so a single-table page is byte-identical to before.
  const seq = ++ctx.tableSeq.value;
  const idAttr = testidArg ? attrValue(testidArg, ctx) : `"data-table${seq > 1 ? `-${seq}` : ""}"`;
  const testidAttr = testIdAttr(expr, ctx);

  // ---- Interactive controls (M-T1.1, HEEx leg) ----------------------------
  // `sortKey:`/`sortDir:`/`page:` are bare page-state refs; `serverPaged:` +
  // `totalPages:` come from the scaffold's paged `all` QueryView.  Sorting and
  // paging are SERVER-driven here: the header buttons and pager write state,
  // and the hoisted `handle_event` clauses (liveview-emit.ts) re-run
  // `list_<agg>s/4` with the new arguments.  Absent args ⇒ every branch below
  // is skipped and the emitted table is byte-identical to before.
  const sortKey = stateRefArg(expr, "sortKey", ctx);
  const sortDir = stateRefArg(expr, "sortDir", ctx);
  const pageRef = stateRefArg(expr, "page", ctx);
  const sortActive = sortKey !== undefined && sortDir !== undefined;
  if (sortActive || pageRef !== undefined) {
    ctx.tableControls.push({ sortKey, sortDir, page: pageRef });
  }
  // The active sort feeds the header indicator + `aria-sort`.
  const sortAttrs = sortActive ? ` sort_key={@${sortKey}} sort_dir={@${sortDir}}` : "";

  const colSlots = cols
    .map((c, i) =>
      c.kind === "call"
        ? renderTableColumn(c, ctx, sortActive, i)
        : `<:col :let={_row} label="Column ${i + 1}">${renderChild(c, ctx)}</:col>`,
    )
    .join("\n");
  const table = [
    `<.table id=${idAttr}${testidAttr}${sortAttrs} rows={${rowsExpr}}>`,
    colSlots.length > 0 ? indent(colSlots, 2) : `  <:col :let={_row} label="Data"></:col>`,
    `</.table>`,
  ].join("\n");

  // The pager renders as a sibling BELOW the table (HEEx tolerates multiple
  // roots, so no fragment wrapper is needed — the JSX `wrapMultiRoot` seam has
  // no HEEx analogue).  Server mode reads the page count off the envelope's
  // `totalPages`; a client-side (non-server-paged) list has no count to show
  // without slicing in the template, so the pager is server-only here.
  const totalPagesArg = namedArg(expr, "totalPages");
  const serverPaged = isTrueLit(namedArg(expr, "serverPaged"));
  if (pageRef !== undefined && serverPaged && totalPagesArg) {
    const totalPages = renderPagedEnvelopeRead(totalPagesArg, ctx);
    return `${table}\n<.pager page={@${pageRef}} total_pages={${totalPages}} />`;
  }
  return table;
}

/** Read a field off the paged envelope (`rows.totalPages` → `@items.totalPages`).
 *
 *  The envelope is a plain map whose keys are the CAMELCASE wire names every
 *  backend agrees on (`items` / `page` / `pageSize` / `total` / `totalPages` —
 *  see the repository emitter), NOT snake-cased Elixir idiom.  The generic
 *  member-access renderer snake-cases, which would emit `@items.total_pages`
 *  and raise a `KeyError` at render time, so the field name is preserved
 *  verbatim here and only the receiver goes through `renderExpr`. */
function renderPagedEnvelopeRead(arg: ExprIR, ctx: WalkContext): string {
  if (arg.kind === "member") {
    const receiver = renderExpr(arg.receiver, { ...ctx, position: "template" });
    return `${receiver}.${arg.member}`;
  }
  return renderExpr(arg, { ...ctx, position: "template" });
}

/** True when a named arg is the boolean literal `true`. */
function isTrueLit(arg: ExprIR | undefined): boolean {
  return arg?.kind === "literal" && arg.value === "true";
}

/** Read a named arg that must be a bare page-state reference (`sortKey:
 *  sortKey`), returning the snake-cased assign name.  Undefined when the arg is
 *  absent, isn't a plain ref, or doesn't name a declared `state {}` field — the
 *  last guard keeps a hand-written `Table(page: someLocal)` from emitting a
 *  `@some_local` that no assign backs. */
function stateRefArg(
  call: Extract<ExprIR, { kind: "call" }>,
  name: string,
  ctx: WalkContext,
): string | undefined {
  const arg = namedArg(call, name);
  if (arg?.kind !== "ref") return undefined;
  const assign = snake(arg.name);
  return ctx.stateNames.has(assign) ? assign : undefined;
}

/** Render a `Column("label", accessor_lambda)` node as a
 *  `<:col :let={row} label="...">...</:col>` slot.  Called only from
 *  `renderTable` — never registered as a top-level primitive because
 *  Column nodes are always children of Table in the expander output. */
export function renderTableColumn(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
  /** True when the enclosing Table carries an active `sortKey:`/`sortDir:`
   *  pair.  Only then does a `sortable:` column emit `sort_field`, which is
   *  what turns its header into a `phx-click="loom-sort"` button. */
  sortActive = false,
  /** 0-based position in the enclosing Table, for the `Column N` fallback
   *  header a non-literal label gets (see below). */
  index = 0,
): string {
  if (expr.name !== "Column") {
    // Unexpected shape — emit a stub slot.
    return `<:col :let={_row} label="Column ${index + 1}">${renderChild(expr, ctx)}</:col>`;
  }
  // First positional arg: label string
  // Second positional arg: accessor lambda `fn cell -> renderCell(cell) end`
  //
  // The header is a STATIC attribute on the `<:col>` slot, so only a string
  // LITERAL can supply it, and it must be entity-escaped: a label carrying a
  // `"` used to close the attribute mid-word (`label="Na"me"`) and the whole
  // template failed to parse.  A non-literal header (a state ref, a
  // concatenation) has no attribute spelling at all — it used to splice the
  // rendered Elixir expression inside the quotes (`label="@q"`), so the column
  // was headed with a variable name.  Both now degrade to the JSX side's
  // `Column N` fallback (`_walker/primitives/table.ts`'s `emitColumn`), so the
  // two frontends show the same header for the same source.
  let cellHeex = "<%= row %>";
  const lambdaArg = expr.args.find((a, i) => !expr.argNames?.[i] && a.kind === "lambda");
  const positionals = expr.args.filter((_, i) => !expr.argNames?.[i]);
  const labelArg = positionals[0];
  const isLiteralLabel = labelArg?.kind === "literal" && labelArg.lit === "string";
  const label = isLiteralLabel ? labelArg.value : `Column ${index + 1}`;
  // The header is a user-visible slot (`columnHeader`, M-T1.11): a plain literal
  // rides `pgettext` through the `{…}` expression-attribute form the `<:col>`
  // slot's `label` takes.  Off i18n it is the quoted literal — byte-identical.
  // A NON-literal header keeps the escaped `Column N` fallback (HEEx has no
  // attribute interpolation for an arbitrary expression here).
  const labelAttrValue = isLiteralLabel
    ? localizedHeexAttr(labelArg, ctx, "columnHeader")
    : undefined;
  const accessor = lambdaArg ?? positionals[1];
  if (accessor && accessor.kind === "lambda" && accessor.body) {
    // The row variable is a :let={o} slot binding — a local variable, NOT
    // a LiveView assign.  Do NOT add it to stateNames (which would give
    // it an `@` prefix).  The renderRef fall-through for "unknown" refKind
    // returns bare `snake(name)`, which is exactly what we want inside the
    // <:col :let={o}> slot.
    cellHeex = renderChild(accessor.body, ctx);
  }
  // A `sortable:` column sorts by its explicit `field:`, else by the accessor's
  // member (`o => o.name` → `"name"`) — the same resolution the JSX
  // `emitColumn` does.  A column whose field can't be resolved stays a plain
  // (unsortable) header rather than emitting a sort key the server can't map.
  const sortField = sortActive ? columnSortField(expr) : undefined;
  const sortAttr = sortField ? ` sort_field="${sortField}"` : "";
  const labelAttr = labelAttrValue
    ? `label=${labelAttrValue}`
    : `label="${escapeHeexAttr(label)}"`;
  return `<:col :let={${renderColLetVar(accessor, ctx)}} ${labelAttr}${sortAttr}>${cellHeex}</:col>`;
}

/** The field a `sortable:` Column sorts by: the explicit `field:` string arg,
 *  else the accessor lambda's simple member (`o => o.sku` → `"sku"`).
 *  Undefined for a non-sortable column or an accessor too complex to map. */
function columnSortField(expr: Extract<ExprIR, { kind: "call" }>): string | undefined {
  if (!isTrueLit(namedArg(expr, "sortable"))) return undefined;
  const fieldArg = namedArg(expr, "field");
  if (fieldArg?.kind === "literal" && fieldArg.lit === "string") return fieldArg.value;
  const accessor = expr.args.find((a, i) => !expr.argNames?.[i] && a.kind === "lambda");
  if (accessor?.kind === "lambda" && accessor.body?.kind === "member") {
    const body = accessor.body;
    if (body.receiver.kind === "ref") return body.member;
  }
  return undefined;
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

/** The argument list of a `QueryView` `of:` call, rendered as handler-position
 *  Elixir.  Only a `method-call` carries args (`<api>.<Agg>.all(page, …)`); a
 *  plain member access (`<api>.<Agg>.all`) has none, so the load stays the
 *  parameterless `list_<agg>s()` it has always been. */
function queryCallArgs(arg: ExprIR | undefined, ctx: WalkContext): string[] | undefined {
  if (arg?.kind !== "method-call" || arg.args.length === 0) return undefined;
  return arg.args.map((a) => renderExpr(a, { ...ctx, position: "handler" }));
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
  // Resolve the read's SHAPE up front, from the IR rather than from the flags.
  // `paged:` / `single:` are opt-INs; the facts behind them are properties of
  // the find, and taking them from the flags alone is what made a hand-written
  // `QueryView { of: X.all }` render `Enum.empty?/1` against the paged envelope
  // MAP (never empty, so the empty arm was dead and `<.table rows={…}>`
  // iterated the map's key/value pairs) and a `byId` read without `single:`
  // raise `Protocol.UndefinedError` on a struct.  Same derivation the JSX
  // walker uses — see `_walker/paged-query.ts`.
  //
  // Pre-scanned rather than read inside the arg loop below: `data:` may precede
  // `single:` in source order, and the data-lambda branch needs the answer.
  const names = expr.argNames ?? [];
  const litTrue = (i: number): boolean => {
    const a = i >= 0 ? expr.args[i] : undefined;
    return a?.kind === "literal" && a.value === "true";
  };
  const ofNode = expr.args[names.indexOf("of")];
  // Entity-history read: Phoenix maps the read onto `list_<aggs>` (the LIST,
  // not the trail), so the whole view is skipped with a visible comment until
  // the LiveView read layer learns the derived `history(id)` find.  See
  // `_walker/history-read.ts` — one predicate, shared with the JSX walker, so
  // the two engines can't disagree about which targets serve this read.
  if (skipsEntityHistoryRead("phoenixLiveView", ofNode, ctx.aggregatesByName)) {
    return `<%!-- entity history not yet supported on phoenixLiveView --%>`;
  }
  // Detector context, shared by the shape derivation and the Pattern H probe
  // below so the two can't answer from different name sets.
  const detectCtx = {
    apiParamNames: new Set(ctx.ui.apiParams.map((p) => p.name)),
    aggregatesByName: ctx.aggregatesByName,
    bcByAggregate: ctx.bcByAggregate,
    projectionsByName: ctx.projectionsByName,
    listShapedProjections: ctx.listShapedProjections,
  };
  const shape = ofNode ? queryShape(ofNode, detectCtx) : { paged: false, single: false };
  // Pattern H — `QueryView { of: <api>.<Projection> }` (M-T1.3 Phase 1).  The
  // read resolves to the query-time projection's own `run/1`, in-process: a
  // LiveView deployable hosts its contexts in the SAME OTP app, so what the SPA
  // frontends reach over `GET /projections/<slug>` is one function call here.
  //
  // Probed BEFORE the arg loop because the projection also names the assign
  // (below) — a fact the loop's `data:` branch would otherwise decide first.
  const detected = ofNode ? tryDetectApiHook(ofNode, detectCtx) : null;
  const projectionRead = detected?.kind === "projection" ? detected.aggregateName : undefined;
  // A projection read names its assign after the PROJECTION (`:order_totals`),
  // not after the `data:` lambda's parameter.  The param-derived name is fine
  // for the aggregate arms — a page rarely carries two — but the scaffolded
  // dashboard puts ONE KPI `QueryView` PER AGGREGATE on `Home`, each written by
  // the same macro with the same lambda param `t`.  Named off the param, every
  // one of them would assign `:t` and the last load would win: every tile
  // showing the same aggregate's numbers, with nothing to see in the diff.
  if (projectionRead) assignName = snake(projectionRead);
  // Flag OR fact: an author may still opt in explicitly (the scaffold does),
  // but omitting the flag no longer means "not paged" / "not single".
  const isSingle = litTrue(names.indexOf("single")) || shape.single;
  const explicitPaged = litTrue(names.indexOf("paged"));
  const isPaged = explicitPaged || shape.paged;
  // AUTO-paged: the read is paged but the body was written for a collection, so
  // the lambda binding unwraps to the envelope's rows — the LiveView twin of
  // the JSX walker's `.data.items` unwrap.  Without it a hand-written
  // `Table { rows: rows }` passed the whole envelope MAP as `rows=`, and
  // `<.table>` iterated its key/value pairs.  An explicit `paged: true` body
  // (the scaffold) reads `rows.items` itself, so it binds the envelope.
  const autoPaged = !explicitPaged && !isSingle && shape.paged;

  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "of") {
      ofArgNode = arg;
      ofExpr = renderExpr(arg, { ...ctx, position: "template" });
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
        // A projection read already took its assign from the projection name.
        if (!projectionRead) assignName = dataVar === "rows" ? "items" : dataVar;
        // Build a remapping so ref("rows") → @items, ref("data") → @data, etc.
        const remapping = new Map<string, string>([
          [dataVar, autoPaged ? `${assignName}.items` : assignName],
        ]);
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
  if (projectionRead) {
    // The projection load takes no arguments (the read IS the row) and no
    // `listArgs` — a query-time projection has no page/sort surface.
    ctx.queryBindings.push({
      kind: isSingle ? "single" : "list",
      assign: assignName,
      aggregate: projectionRead,
      source: "projection",
    });
  }
  const aggName = projectionRead
    ? undefined
    : ofArgNode
      ? resolveQueryAggregate(ofArgNode)
      : undefined;
  if (aggName) {
    ctx.queryBindings.push({
      kind: isSingle ? "single" : "list",
      assign: assignName,
      aggregate: aggName,
      // Forward the `of:` call's arguments to the load block.  A paged scaffold
      // list is `<api>.<Agg>.all(pageNum, 10, sortKey, sortDir)`; without these
      // the emitted `list_<agg>s()` takes the repository defaults and the page
      // never moves off 1.  HANDLER position — the load block is a function
      // body, so state refs must render `socket.assigns.<f>`, not `@<f>`.
      listArgs: queryCallArgs(ofArgNode, ctx),
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
  // The row label is a user-visible slot (`keyValue`), so a plain literal rides
  // the translation runtime under i18n (M-T1.11) and stays raw otherwise.
  const label = positionals[0] ? renderInTemplate(positionals[0], ctx, "keyValue") : "Field";
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
  // Decorative loading placeholder — hidden from assistive tech (the loading
  // state is announced elsewhere; real content announces once loaded).
  return `<div class="skeleton" aria-hidden="true"${testidAttr}>\n${lines}\n</div>`;
}

/** A Loom `color:` → the daisyUI alert modifier.  The renderer used to emit the
 *  raw colour (`alert-red`), which matches no class in either HEEx pack's CSS —
 *  so a coloured alert rendered unstyled.  Mirrors the mapping the JSX packs and
 *  the (vestigial) `primitive-alert.heex.hbs` templates already use. */
function alertVariant(color: string): string {
  switch (color) {
    case "yellow":
      return "alert-warning";
    case "green":
      return "alert-success";
    case "blue":
      return "alert-info";
    default:
      return "alert-error";
  }
}

/** `Alert("message", title?)` → `<div class="alert">`.
 *
 *  `title:` is a USER-VISIBLE slot (`alertTitle` in `USER_VISIBLE_SLOTS`), so it
 *  is extracted into the catalog whether or not it renders — dropping it here
 *  handed a translator a string the app never showed (the class of defect
 *  `user-visible-slot-coverage.test.ts` now gates).  Emitted as the same leading
 *  bold line the JSX packs use, and translated through the shared role. */
export function renderAlert(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let color = "red";
  let message = "";
  let title = "";
  let testid = "";
  const positionals = expr.args.filter((_, i) => !expr.argNames?.[i]);
  if (positionals[0]) message = renderInTemplate(positionals[0], ctx, "alert");
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "color" && arg.kind === "literal") color = arg.value;
    else if (name === "testid" && arg.kind === "literal") testid = arg.value;
    else if (name === "title") title = renderInTemplate(arg, ctx, "alertTitle");
  }
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  const titleEl = title ? `<p class="font-medium">${title}</p>` : "";
  return `<div class="alert ${alertVariant(color)}" role="alert"${testidAttr}>${titleEl}${message}</div>`;
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

/** `FileLink(<file-ref>)` → a plain download anchor for a `File` field.  The
 *  `File` wire value is a JSON map (`%{"url" => …, "key" => …}`, string keys —
 *  Ecto `:map`), so `url`/`key` read via bracket access.  Null-guarded: an
 *  optional `File?` that is `nil` renders an em-dash (a required `File` is
 *  always truthy). */
export function renderFileLink(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let testid = "";
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name === "testid" && arg.kind === "literal") testid = arg.value;
  }
  const testidAttr = testid ? ` data-testid="${escapeHeexAttr(testid)}"` : "";
  const positionals = expr.args.filter((_, i) => !expr.argNames?.[i]);
  const valueArg = namedArg(expr, "value") ?? positionals[0];
  if (!valueArg) return `<span${testidAttr}>—</span>`;
  const recv = renderExpr(valueArg, { ...ctx, position: "template" });
  return `<%= if ${recv} do %><a href={${recv}["url"]} download${testidAttr}><%= ${recv}["key"] %></a><% else %><span>—</span><% end %>`;
}

/** The value of a named arg on a call, or undefined. */
function namedArg(expr: Extract<ExprIR, { kind: "call" }>, name: string): ExprIR | undefined {
  for (let i = 0; i < expr.args.length; i++) {
    if (expr.argNames?.[i] === name) return expr.args[i];
  }
  return undefined;
}

/** `ProvenanceInfo(of: <record>, field: "<name>")` → a native `<details>`
 *  disclosure over the co-located `<field>_provenance` lineage (the "?" that
 *  reveals where a provenanced value came from — docs/provenance.md).
 *
 *  Unlike the JSX frontends — which consume a camelCase JSON wire — the LiveView
 *  renders SERVER-SIDE straight from the Ecto struct.  The co-located jsonb
 *  column (`schema-emit.ts`, `<field>_provenance` via the pass-through
 *  `Provenance.Json` type) loads as a STRING-keyed map, so the lineage reads via
 *  bracket access: `snapshotId` (rule), `computedValue`, and the `inputs` list
 *  (each `path` = `value`) — the SAME camelCase member names
 *  `renderProvenancedAssign` stores and the JSON wire carries (RS-1/RS-18; the
 *  members were snake_case here until the elixir wire-golden leg showed the
 *  divergence, and this reader had to move with them).  Null-guarded with
 *  `<%= if … %>`: an un-provenanced row (column `nil`) renders nothing, so the
 *  value still shows on its own.  The `inputs` fan-out is a `for`-comprehension
 *  (LiveView's list idiom) rather than the JS `.map` — the topology divergence
 *  that keeps this a parallel HEEx renderer, not the shared walker. */
export function renderProvenanceInfo(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  const recordArg = namedArg(expr, "of");
  const fieldArg = namedArg(expr, "field");
  if (!recordArg || fieldArg?.kind !== "literal") {
    return "<!-- ProvenanceInfo: missing record or field -->";
  }
  const record = renderExpr(recordArg, { ...ctx, position: "template" });
  // `<field>_provenance` — snake_cased to match `provColumn` / the schema field.
  const lineage = `${record}.${snake(fieldArg.value)}_provenance`;
  const testid = testIdAttr(expr, ctx);
  return [
    `<%= if ${lineage} do %>`,
    `  <details class="loom-provenance"${testid}>`,
    `    <summary aria-label="How this value was computed">?</summary>`,
    `    <dl class="loom-provenance-tree">`,
    `      <div><dt>Rule</dt><dd><code><%= ${lineage}["snapshotId"] %></code></dd></div>`,
    `      <div><dt>Value</dt><dd><%= ${lineage}["computedValue"] %></dd></div>`,
    `      <%= for inp <- ${lineage}["inputs"] || [] do %>`,
    `        <div><dt><%= inp["path"] %></dt><dd><%= inp["value"] %></dd></div>`,
    `      <% end %>`,
    `    </dl>`,
    `  </details>`,
    `<% end %>`,
  ].join("\n");
}

/** `Timeline(of: <entries>)` → the entity's audit trail as an ordered list
 *  (docs/audit.md).  The HEEx twin of the JSX renderers: same markup, same
 *  semantics, so a Phoenix app shows the history a React one does.
 *
 *  Written rather than pinned as a parity gap because Phoenix is one of the
 *  backends that serves `/history` — a TSX-only Timeline would be exactly the
 *  silent LiveView degradation `heex-parity.test.ts` exists to catch.
 *
 *  Entries cross the wire as string-keyed maps, hence `e["action"]` rather than
 *  `e.action`. */
export function renderTimeline(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  const entriesArg = namedArg(expr, "of") ?? expr.args.find((_, i) => !expr.argNames?.[i]);
  if (!entriesArg) return "<!-- Timeline: missing entries -->";
  const entries = renderExpr(entriesArg, { ...ctx, position: "template" });
  const testid = testIdAttr(expr, ctx);
  return [
    `<ol class="loom-timeline"${testid}>`,
    `  <%= for e <- ${entries} || [] do %>`,
    `    <li class="loom-timeline-entry">`,
    `      <span class="loom-timeline-action"><%= e["action"] %></span>`,
    `      <time datetime={to_string(e["at"])}><%= e["at"] %></time>`,
    `      <%= if e["actor"] do %>`,
    `        <span class="loom-timeline-actor"><%= e["actor"] %></span>`,
    `      <% end %>`,
    `      <%= if (e["changes"] || []) != [] do %>`,
    `        <dl class="loom-timeline-changes">`,
    `          <%= for c <- e["changes"] || [] do %>`,
    `            <div>`,
    `              <dt><%= c["field"] %></dt>`,
    `              <dd><%= c["before"] || "\u2014" %> \u2192 <%= c["after"] || "\u2014" %></dd>`,
    `            </div>`,
    `          <% end %>`,
    `        </dl>`,
    `      <% end %>`,
    `    </li>`,
    `  <% end %>`,
    `</ol>`,
  ].join("\n");
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
/** Tailwind utility classes for the pure-LAYOUT primitives.
 *
 *  These live in the WALKER, not in a design pack, and that split is the whole
 *  HEEx pack contract: a pack owns the design VOCABULARY (the `<.button>` /
 *  `<.table>` / `<.card>` function components in `core_components.ex`), while
 *  flex/grid geometry is design-neutral — daisyUI adds a component vocabulary,
 *  not a layout one, so `coreComponents` and `daisyui` would carry byte-
 *  identical copies of these strings.  Both packs build Tailwind through the
 *  same assets pipeline and both scan `../lib/<app>_web/**\/*.*ex`, so a literal
 *  class emitted here survives either pack's production purge.
 *
 *  The strings mirror the shadcn (Tailwind) React templates — `primitive-stack`
 *  = `flex flex-col gap-4`, `primitive-toolbar` = `… justify-between …` — so a
 *  page laid out on React and on Phoenix reads the same. */
const LAYOUT_CLASSES = {
  Stack: "flex flex-col gap-4",
  Group: "flex flex-row items-center gap-4",
  Toolbar: "flex flex-row items-center justify-between gap-4",
  Grid: "grid gap-4",
  Container: "container mx-auto px-4",
} as const;

/** `Container(size: "md")` → the max-width utility for that size.
 *
 *  Sizes mirror the vuetify pack's pixel ladder (540 / 720 / 960 / 1140 / 1320)
 *  at the nearest Tailwind step; an absent or unrecognised `size:` keeps the
 *  default centred `container` (what the shadcn template emits). */
const CONTAINER_MAX_W: Record<string, string> = {
  xs: "max-w-xl",
  sm: "max-w-3xl",
  md: "max-w-5xl",
  lg: "max-w-6xl",
  xl: "max-w-7xl",
};

/** Per-primitive HEEx spec for the generic `renderPrimitive` helper.
 *  Listed inline so the small set is easy to scan.  The registered
 *  per-primitive exports (`renderStack`, `renderHeading`, …) bind to
 *  these specs; the typed dispatch table at
 *  src/generator/_walker/registry.ts wires them up by name. */
const CLOSED_PRIMITIVE_SPECS: Record<string, PrimitiveSpec> = {
  Stack: {
    tag: "div",
    staticAttrs: ["class"],
    takesChildren: true,
    baseClass: LAYOUT_CLASSES.Stack,
  },
  // Heading is rendered by the bespoke `renderHeading` (raw `<h{n}>` with a
  // structure-derived rank), not through this generic spec table.
  Text: { tag: "p", takesChildren: true },
  // `Card`/`Paper` render through the PACK's `<.card>` function component (see
  // `renderCard`) — the card surface is design vocabulary, and the two packs
  // spell it differently (daisyUI `card card-bordered` + `card-body`, neutral
  // Tailwind on coreComponents).  The spec's `passThroughAttrs` names the
  // component's own attrs; `title`/`variant`/`shadow` are supplied by the
  // renderer, so nothing here has to be authored to reach the tag.
  Card: { tag: ".card", takesChildren: true },
  // `{role:"toolbar", needsName:true}` — "Actions" is the FALLBACK name; an
  // author's `label:` overrides it (and translates), which needs
  // `labelAsAriaLabel` or the label lands as a bogus `label=` attr on the div
  // while the hardcoded default stays the accessible name.
  Toolbar: {
    tag: "div",
    staticAttrs: ["class"],
    takesChildren: true,
    labelAsAriaLabel: true,
    extraAttrs: ['role="toolbar"', 'aria-label="Actions"'],
    baseClass: LAYOUT_CLASSES.Toolbar,
  },
  Group: {
    tag: "div",
    staticAttrs: ["class"],
    takesChildren: true,
    baseClass: LAYOUT_CLASSES.Group,
  },
  // `Empty("No results yet")` carries the author's message in positional 0 (the
  // `empty` user-visible slot).  It rendered as a childless `<.empty />`, so the
  // message was discarded and every Phoenix app showed the core component's
  // hardcoded English "No items." instead — a content defect, not just an i18n
  // one.  `.empty` now takes an inner block (keeping that text as its fallback).
  Empty: { tag: ".empty", takesChildren: true },
  Badge: { tag: ".badge", takesChildren: true },
  // `to:`/`disabled:`/`type:`/`variant:` are the four knobs `<.button>` declares
  // (`to` = render as a nav link, `variant` = the pack's rank vocabulary,
  // `disabled`/`type` its global/`attr`).  Everything else a `Button` can carry
  // (`icon:`, `loading:`, `iconPosition:`) is dropped: an undeclared attribute
  // on a Phoenix function component is a compile WARNING, i.e. a build failure
  // under `mix compile --warnings-as-errors`.
  Button: {
    tag: ".button",
    takesChildren: true,
    labelAsAriaLabel: true,
    passThroughAttrs: ["to", "disabled", "type", "variant"],
    staticAttrs: ["variant", "type"],
  },
  // --- inline-emphasis primitives — plain HTML inline elements, the
  //     Phoenix analogue of the TSX `<strong>`/`<em>`/`<code>` spans. ---
  Bold: { tag: "strong", takesChildren: true },
  Italic: { tag: "em", takesChildren: true },
  InlineCode: { tag: "code", takesChildren: true },
  // --- scaffold expander primitives ---
  // `Paper` is a titleless `Card` (same surface, no header) — same pack
  // component, so the two stay visually consistent by construction.
  Paper: { tag: ".card", takesChildren: true },
  // `Grid`'s per-breakpoint column classes come from `cols:` (see `renderGrid`);
  // each child rides its own `<div>` grid item, mirroring the JSX packs' column
  // wrapper so a multi-root child (a `Table` + its pager) occupies ONE cell.
  Grid: { tag: "div", staticAttrs: ["class"], takesChildren: true, childWrapper: "div" },
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
  const text = positional[0] ? renderInTemplate(positional[0], ctx, "heading") : "";
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

/** `Divider(label?)` → `<hr />`, or rule-text-rule when a `label:` is given.
 *
 *  LiveView has no labelled-divider component, but "no component" is not a
 *  reason to DROP the label: it is a user-visible slot (`dividerLabel`), so it
 *  reached `.loom/messages.en.json` while rendering nowhere — a translator
 *  translating text the app never showed.  Every JSX pack composes the same
 *  three-element form for exactly this reason (#2388), so HEEx does too. */
export function renderDivider(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  let testid = "";
  let label = "";
  for (let i = 0; i < expr.args.length; i++) {
    const arg = expr.args[i]!;
    const name = expr.argNames?.[i];
    if (name === "testid" && arg.kind === "literal") testid = arg.value;
    else if (name === "label") label = renderInTemplate(arg, ctx, "dividerLabel");
  }
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  if (!label) return `<hr${testidAttr} />`;
  return (
    `<div class="flex items-center gap-3 my-4"${testidAttr}>` +
    `<hr class="flex-1" />` +
    `<span class="text-sm opacity-70">${label}</span>` +
    `<hr class="flex-1" />` +
    `</div>`
  );
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
  const label = positionals[0] ? renderInTemplate(positionals[0], ctx, "statLabel") : "";
  const value = positionals[1] ? renderInTemplate(positionals[1], ctx, "statValue") : "";
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

/** `Money(value, currency?, decimals?)` → a money span.  An optional
 *  `currency:` literal prefixes the amount; `decimals:` is left to the value's
 *  natural precision.
 *
 *  The amount renders through `to_string/1`, not `Decimal.to_string/1`, because
 *  the three things a `Money { … }` slot is handed are not all Decimals:
 *
 *    - an AGGREGATE field read is a `%Decimal{}` — `to_string/1` dispatches
 *      String.Chars to `Decimal.to_string/1`, byte-identical output;
 *    - a query-time PROJECTION field is already a STRING (money rides the
 *      Elixir wire as `to_string(...)` — RS-24), and `Decimal.to_string/1`
 *      raises FunctionClauseError on a binary;
 *    - a LITERAL (`Money(value: 9.99)`) is a float, which raises the same way.
 *
 *  So the narrower cast was wrong for two of the three, and identical for the
 *  third.  The TYPED money cast (`string(x: money)` in `render-expr.ts`) keeps
 *  `Decimal.to_string/1` — there the operand's type is known. */
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
  return `<span class="money"${testidAttr}>${prefix}<%= to_string(${val}) %></span>`;
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
  // `body` is EVERY panel child, not just the first: `Tab { "Ovw", Text { "A" },
  // Text { "B" } }` used to read `pos[1]` alone and drop `B` (the JSX engine's
  // twin defect — `_walker/primitives/layout.ts`).  A panel is a children
  // container like `Card`, which this engine already walks correctly.
  const tabs: Array<{
    label: string;
    /** The caption already rendered for HEEx TEXT position — a `<%= pgettext(…)
     *  %>` call under i18n, undefined when the raw escaped label is right. */
    labelHeex?: string;
    slug: string;
    body: ExprIR[];
  }> = [];
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
      tabs.push({
        label,
        // The caption is a user-visible slot (`tabLabel`, M-T1.11): under i18n
        // it renders through `pgettext`, else as the escaped literal.  The SLUG
        // stays derived from the source literal — a per-locale anchor would
        // break every `JS.show` selector this switcher is built on.
        labelHeex: labelArg ? renderInTemplate(labelArg, ctx, "tabLabel") : undefined,
        slug: snake(label) || `tab-${idx}`,
        body: pos.slice(1),
      });
    } else {
      // Bare positional (e.g. `Tabs(Card(...), Card(...))`) — its own panel.
      tabs.push({ label: `Tab ${idx}`, slug: `tab-${idx}`, body: [arg] });
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
      return `    <button type="button" role="tab" id="${id}-tab-${t.slug}" data-tabs-tab="${id}" class="tab${active}" phx-click={${js}}>${t.labelHeex ?? esc(t.label)}</button>`;
    })
    .join("\n");
  const panels = tabs
    .map((t, i) => {
      const hidden = i === 0 ? "" : " hidden";
      const body = t.body.map((child) => renderChild(child, ctx)).join("\n");
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
  let labelArg: ExprIR | undefined;
  let bind: string | undefined;
  let testid = "";
  let optionsExpr: ExprIR | undefined;
  let seenPositional = false;
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (!name) {
      if (!seenPositional) {
        labelArg = arg;
        if (arg.kind === "literal") label = arg.value;
      }
      seenPositional = true;
    } else if (name === "bind" && arg.kind === "ref") bind = arg.name;
    else if (name === "options") optionsExpr = arg;
    else if (name === "testid" && arg.kind === "literal") testid = arg.value;
  }
  // The label is a user-visible slot (`inputLabel`, M-T1.11): a plain literal
  // rides `pgettext` through the `{…}` expression-attribute form, so the
  // most-read prose in any generated form translates like the `Select…`
  // placeholder beside it already did.  Off i18n it is the quoted literal —
  // byte-identical.
  const labelValue = labelArg ? localizedHeexAttr(labelArg, ctx, "inputLabel") : undefined;
  const labelAttr = labelValue
    ? ` label=${labelValue}`
    : label
      ? ` label="${label.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`
      : "";
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

/** `FileUpload { "Label", bind: <File state> }` → a LiveView-native file input.
 *
 *  Unlike the JSX frontends (which POST the file to `/files` and bind the
 *  returned FileRef), Phoenix has no such endpoint — LiveView streams uploads
 *  over its own channel.  So this renders the idiomatic `allow_upload` flow: a
 *  `<.live_file_input>` inside a `phx-change` form, an `allow_upload/3` seeded
 *  in `mount/3` (with `auto_upload: true`), and a `handle_<field>_progress/3`
 *  consumer that persists the completed entry and assigns the resulting FileRef
 *  map (`%{ "url", "key", "contentType", "size" }` — the wire FileRef shape)
 *  into the bound `:<field>` page-state assign.  The `allow_upload` +
 *  progress-consumer emission is driven by the `UploadBinding` this pushes onto
 *  `ctx.uploadBindings` (consumed in liveview-emit.ts); the `phx-change`
 *  validate handler (required for a live-file-input form) is hoisted here the
 *  same way `controlledInput` hoists its write-back clause.
 *
 *  An unbound (or non-`File`-state) `bind:` renders a disabled plain file input
 *  — there's nothing to two-way bind to — mirroring `controlledInput`'s stub. */
export function renderFileUpload(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  let labelArg: ExprIR | undefined;
  let bind: string | undefined;
  let testid = "";
  let seenPositional = false;
  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (!name) {
      if (!seenPositional) labelArg = arg;
      seenPositional = true;
    } else if (name === "bind" && arg.kind === "ref") bind = arg.name;
    else if (name === "testid" && arg.kind === "literal") testid = arg.value;
  }
  // The label is a user-visible slot (`inputLabel`, M-T1.11) — rendered in TEXT
  // position here (the `<label>` wraps the input), so it rides `renderInTemplate`,
  // which yields `<%= pgettext(…) %>` under i18n and the escaped literal off it.
  const labelText = labelArg ? renderInTemplate(labelArg, ctx, "inputLabel") : "";
  const testidAttr = testid ? ` data-testid="${escapeHeexAttr(testid)}"` : "";
  const field = bind ? snake(bind) : undefined;
  if (!field || !ctx.stateNames.has(field)) {
    // Nothing to two-way bind to — a disabled plain file input, so the page
    // still renders (validators catch a genuinely-unresolvable bind upstream).
    return `<label class="block text-sm font-medium">${labelText}<input type="file" disabled${testidAttr} /></label>`;
  }
  // One allow_upload / progress consumer per bound field (mount + module body).
  if (!ctx.uploadBindings.some((u) => u.field === field)) {
    ctx.uploadBindings.push({ field });
  }
  // A live-file-input form must carry a `phx-change`; hoist the (no-op) clause
  // once per field.  `phx-submit` reuses it so an accidental Enter can't trigger
  // a native (page-navigating) submit.
  const validateEvent = `validate_${field}`;
  if (!ctx.handlers.some((h) => h.name === validateEvent)) {
    ctx.handlers.push({
      name: validateEvent,
      paramsPattern: "_params",
      body: [`    {:noreply, socket}`],
    });
  }
  return [
    `<form phx-change="${validateEvent}" phx-submit="${validateEvent}" class="loom-file-upload">`,
    `  <label class="block text-sm font-medium">`,
    labelText ? `    ${labelText}` : "",
    `    <.live_file_input upload={@uploads.${field}}${testidAttr} />`,
    `  </label>`,
    `</form>`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}
/** The literal value of a named arg, or undefined when absent / non-literal. */
function stringNamedLit(expr: Extract<ExprIR, { kind: "call" }>, name: string): string | undefined {
  const arg = namedArg(expr, name);
  return arg?.kind === "literal" && arg.lit === "string" ? arg.value : undefined;
}

/** `Card("Title", …children)` / `Paper(…children)` → the pack's `<.card>`.
 *
 *  The card SURFACE is design vocabulary (border/elevation/padding/title
 *  typography), so it goes through the pack's function component rather than
 *  hardcoded classes in the walker — `daisyui` renders `card card-bordered
 *  bg-base-100` + `card-body`/`card-title`, `coreComponents` a neutral
 *  `rounded-lg border border-zinc-200 bg-white` — exactly the split
 *  `<.button>` / `<.table>` / `<.badge>` already use.
 *
 *  Title handling mirrors the JSX `emitCard`: positional 0 is the title when it
 *  is text-LIKE (not itself a primitive call), every remaining positional is a
 *  body child.  It is a user-visible slot (`cardTitle`), so it rides the
 *  translation runtime as an ATTRIBUTE expression under i18n (D-I18N-ATTR).
 *  `variant:`/`shadow:` are CONSUMED as component attrs — the pack maps them to
 *  its own elevation idiom — rather than leaking as bare HTML attributes. */
function renderCardLike(
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
  takesTitle: boolean,
): string {
  const positional = expr.args.filter((_, i) => !expr.argNames?.[i]);
  const titleArg = takesTitle && positional[0]?.kind !== "call" ? positional[0] : undefined;
  const bodyExprs = titleArg ? positional.slice(1) : positional;

  const attrs: string[] = [];
  if (titleArg) {
    const value =
      localizedHeexAttr(titleArg, ctx, positionalRole("Card", 0)) ?? attrValue(titleArg, ctx);
    attrs.push(`title=${value}`);
  }
  for (const knob of ["variant", "shadow"] as const) {
    const value = stringNamedLit(expr, knob);
    if (value) attrs.push(`${knob}="${escapeHeexAttr(value)}"`);
  }
  const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
  // A Card is a heading-nesting level (like the JSX `emitCard`): a `Heading`
  // inside it derives a rank one deeper (accessibility.md Phase 2).
  const childCtx: WalkContext = { ...ctx, headingDepth: (ctx.headingDepth ?? 0) + 1 };
  const children = bodyExprs.map((c) => renderChild(c, childCtx)).join("\n");
  const testidAttr = testIdAttr(expr, ctx);
  if (children.length === 0) return `<.card${attrStr}${testidAttr} />`;
  return `<.card${attrStr}${testidAttr}>\n${indent(children, 2)}\n</.card>`;
}

export function renderCard(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  return renderCardLike(expr, ctx, true);
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
/** `Paper(…children)` — a Card with no title slot (positional 0 is a child). */
export function renderPaper(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  return renderCardLike(expr, ctx, false);
}

/** `Grid(cols: 3 | [3,2,1], …children)` → a CSS grid.
 *
 *  `cols:` is read through the SHARED `gridCols` reader the JSX walker uses, so
 *  `cols: [3, 2, 1]` means `[desktop, tablet, mobile]` on Phoenix exactly as it
 *  does on React — and it is CONSUMED into the class list.  It used to fall
 *  through the generic named-attr path as `cols={[3, 2, 1]}`: a LIST reaching
 *  Phoenix's attribute escaper, i.e. a page that compiles and then raises on
 *  first render.
 *
 *  Tailwind is mobile-first, so the breakpoint ladder reads
 *  `grid-cols-<mobile> md:grid-cols-<tablet> lg:grid-cols-<desktop>` — the same
 *  spelling the shadcn `primitive-grid` template emits. */
export function renderGrid(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  const cols = gridCols(expr);
  const colClasses = cols
    ? `grid-cols-${cols.mobile} md:grid-cols-${cols.tablet} lg:grid-cols-${cols.desktop}`
    : "grid-cols-3";
  return renderPrimitive(
    { ...CLOSED_PRIMITIVE_SPECS.Grid!, baseClass: `${LAYOUT_CLASSES.Grid} ${colClasses}` },
    expr,
    ctx,
  );
}

/** `Container(size: "md", …children)` → a centred max-width wrapper.
 *
 *  `size:` is CONSUMED into a `max-w-*` utility (see {@link CONTAINER_MAX_W});
 *  it used to leak as `size="md"`, an attribute no `<div>` has. */
export function renderContainer(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  const size = stringNamedLit(expr, "size");
  const maxW = size ? CONTAINER_MAX_W[size] : undefined;
  const baseClass = maxW ? `mx-auto w-full px-4 ${maxW}` : LAYOUT_CLASSES.Container;
  return renderPrimitive({ ...CLOSED_PRIMITIVE_SPECS.Container!, baseClass }, expr, ctx);
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
export function renderCodeBlock(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
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
    } else if (name === "title") {
      // The caption is a user-visible slot (`codeBlockTitle`) — translated
      // under i18n, the raw escaped literal otherwise.  The code SOURCE below
      // is deliberately not one.
      title = renderInTemplate(arg, ctx, "codeBlockTitle");
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
      `  <div class="loom-code-block-title">${title}</div>\n` +
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
  let labelArg: ExprIR | undefined;
  let decorative = false;
  for (let i = 0; i < expr.args.length; i++) {
    const argName = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (argName === "name" && arg.kind === "literal") name = arg.value;
    else if (argName === "svg" && arg.kind === "literal") customSvg = arg.value;
    else if (argName === "size" && arg.kind === "literal") size = arg.value;
    else if (argName === "testid" && arg.kind === "literal") testid = arg.value;
    else if (argName === "label") {
      labelArg = arg;
      if (arg.kind === "literal") label = arg.value;
    } else if (argName === "decorative" && arg.kind === "literal")
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
  const svg = customSvg ?? "";
  const sizeClass = size ? ` loom-icon-${size}` : "";
  const testidAttr = testid ? ` data-testid="${testid}"` : "";
  // Decorative-by-default (icon a11y contract): hidden from assistive tech
  // unless a `label:` gives it meaning, in which case the glyph becomes a NAMED
  // `role="img"`.  HEEx shares the HTML spelling with the JSX/markup packs
  // (`iconA11yAttr`), so the shape below matches theirs arm for arm: a literal
  // name is translated under i18n (HEEx's `{pgettext(…)}` attribute form),
  // static otherwise; a DYNAMIC name binds the expression rather than folding
  // the icon back to decorative and silently dropping the author's request.
  //
  // The STATIC arm still goes through the shared `iconA11yAttr` rather than
  // being respelled here: it owns the escaping (`escapeHtmlAttr`, which covers
  // `<`/`>` that HEEx's attribute funnel does not), so routing around it would
  // change the i18n-OFF bytes on a hostile label.
  const named = labelArg !== undefined && label !== "" && !decorative;
  const bound = named
    ? (localizedHeexAttr(labelArg!, ctx, "iconLabel") ??
      (label === undefined
        ? `{${renderExpr(labelArg!, { ...ctx, position: "template" })}}`
        : undefined))
    : undefined;
  const a11yAttr = bound ? ` role="img" aria-label=${bound}` : iconA11yAttr({ label, decorative });
  return `<span class="loom-icon${sizeClass}"${testidAttr}${a11yAttr}>${svg}</span>`;
}

// ---------------------------------------------------------------------------
// Chart (M-T1.3 Phase 4, HEEx leg).
// ---------------------------------------------------------------------------

/** `Chart { kind: "bar"|"line", of: <api>.<Projection>, x: r => …, y: r => … }`
 *  → a call into the generated `LoomChart.chart/1` function component.
 *
 *  The JSX targets reach a charting LIBRARY through the design pack
 *  (`@mantine/charts`, recharts, `@mui/x-charts`).  LiveView has no such
 *  library — and needs none: the rows are ALREADY on the server, in an assign,
 *  so the geometry is arithmetic and the chart is inline SVG, server-rendered
 *  and JS-free.  (The parity ledger long carried "no JS-free LiveView charting"
 *  as the reason Phoenix had no Chart; the premise was simply wrong.)
 *
 *  Emission is a component CALL rather than inline markup for the same reason
 *  the projection loader is a function: the scale/axis maths is Elixir, and
 *  HEEx is a markup template — computing a max and a per-bar rect in `<% %>`
 *  blocks inside the page body would be both unreadable and untestable.  The
 *  component is emitted once per deployable (`renderLoomChartComponent`,
 *  liveview-emit.ts) and invoked fully qualified, the same way a user
 *  `component` is.
 *
 *  The data binding rides the SAME projection QueryBinding a `QueryView` push —
 *  so the page gets its `defp load_<proj>/1`, and the chart reads the assign. */
export function renderChart(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  const names = expr.argNames ?? [];
  const at = (name: string): ExprIR | undefined => {
    const i = names.indexOf(name);
    return i >= 0 ? expr.args[i] : undefined;
  };
  const kindArg = at("kind");
  // `loom.chart-kind-invalid` pins the kind to "line" | "bar"; the bar default
  // only keeps the renderer total under IR that skipped validation.
  const isLine = kindArg?.kind === "literal" && kindArg.value === "line";
  const ofArg = at("of");

  // Pattern H, exactly as `renderQueryView` resolves it — one detector, so a
  // chart and a query view can't disagree about what `<api>.<Proj>` means.
  const detected = ofArg
    ? tryDetectApiHook(ofArg, {
        apiParamNames: new Set(ctx.ui.apiParams.map((p) => p.name)),
        aggregatesByName: ctx.aggregatesByName,
        projectionsByName: ctx.projectionsByName,
      })
    : null;
  const projection = detected?.kind === "projection" ? detected.aggregateName : undefined;
  if (!projection) {
    // Unreachable from valid input — `loom.chart-of-not-grouped` (ui-checks)
    // rejects any `of:` that isn't a grouped readable projection.
    return `<%!-- Chart: unresolved 'of:' projection --%>`;
  }
  const assign = snake(projection);
  ctx.queryBindings.push({
    kind: "list",
    assign,
    aggregate: projection,
    source: "projection",
  });
  ctx.chartUsed.value = true;

  // `x:`/`y:` unwrap to accessor field names through the SAME leaf the TSX emit
  // and a `DataGrid` `Column` use, then to the SNAKE keys the projection loader
  // rekeys the wire row to (`orderCount` → `:order_count`) — the component
  // reads them with `Map.get/2`.
  const dataKey = snake(simpleAccessorField(at("x")) ?? "");
  const seriesField = snake(simpleAccessorField(at("y")) ?? "");

  // A chart is an image of data (registry a11y contract `role="img"` +
  // `needsName`), so the component carries a derived accessible name — the same
  // sentence the TSX emit derives, so the two frontends read alike to a screen
  // reader.
  const label = `${isLine ? "Line" : "Bar"} chart of ${projection}: ${seriesField} by ${dataKey}`;
  const testid = testIdAttr(expr, ctx).replace(/^ data-testid=/, "");
  const testidAttr = testid ? ` testid=${testid}` : "";
  return (
    `<${ctx.appModule}Web.Components.LoomChart.chart` +
    ` kind="${isLine ? "line" : "bar"}"` +
    ` rows={@${assign}}` +
    ` x={:${dataKey}}` +
    ` y={:${seriesField}}` +
    ` label="${escapeHeexAttr(label)}"${testidAttr} />`
  );
}
