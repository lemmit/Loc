// -------------------------------------------------------------------------
// Frontend collection-op (F3 / M-T1.3 Defect A), table-filter, controlled-
// modal-op-form, fixed-slot-arity, primitive-named-args, data-grid-
// selection, and chart-args checks.  Split out of ui-checks.ts by packet
// 2.6 (wave-2) — mechanical move, no logic change.
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import { isCollectionOp } from "../../../util/collection-ops.js";
import {
  WALKER_PRIMITIVE_NAMED_ARGS,
  walkerPrimitiveNamedArgs,
} from "../../../util/walker-primitive-args.js";
import { WALKER_PRIMITIVE_SLOTS } from "../../../util/walker-primitive-names.js";
import type {
  ComponentIR,
  ExprIR,
  PageIR,
  ProjectionIR,
  StateFieldIR,
  StmtIR,
  StoreIR,
  TypeIR,
} from "../../types/loom-ir.js";
import { typeLabel } from "../../util/type-label.js";
import {
  walkExprChildren,
  walkExprDeep,
  walkStmtChildren,
  walkStmtExprsDeep,
} from "../../util/walk.js";
import type { LoomDiagnostic } from "./diagnostic.js";
import { namedArg, walkerRenderedExprs } from "./ui-checks-shared.js";

// -------------------------------------------------------------------------
// F3 — `loom.frontend-collection-op-unsupported` (M-T1.3 Defect A).
//
// The stdlib collection ops (`src/util/collection-ops.ts`: count / sum / where
// / any / all / first / sortBy / distinct / take / skip / min / max / avg /
// join / contains / firstOrNull) are a BACKEND vocabulary.  Every backend has a
// real renderer for them (`src/generator/_expr/target.ts`'s `isCollectionOp`
// arm, one leaf table per backend); the frontend walker has NONE.  The shared
// `walker-core.ts` `member` arm emits `<recv>.<member>` and its `method-call`
// arm emits `<recv>.<member>(<args>)` — verbatim, in whatever language the
// target embeds.  Measured on `QueryView { of: X.all, data: rows => Stat(…) }`:
//
//   react/vue/svelte/angular  `rows.count` → `items.count`               TS2339
//   feliz                     `rows.count` → `allCustomers.count`        not F#
//   flutter                   `rows.count` → `customerAll.count`         not Dart
//   phoenixLiveView           `rows.count` → `Enum.count(@items)`        ✓
//
// So the failure lands at `tsc` / `ng build` / `dotnet fable` / `flutter
// analyze` — a generated project that doesn't compile, from a `.ddd` that
// validated clean.  Phoenix is the lone exception because HEEx runs a PARALLEL
// walker (`elixir/heex-walker-core.ts`'s `renderCollectionOp`) — and even there
// `join` (`Enum.map(…).join(", ")`) and `first` (`@items.first`) are invalid
// Elixir, so it is not a portable escape hatch either.
//
// The fix is the GATE, not renderers: mapping 17 ops × 6 frontends would add a
// second expression dialect to the frontend walkers, and the server-side read
// path (a repository `find`, or a `projection` read model) already computes
// these correctly, once, in the database.  So this check is TARGET-AGNOSTIC —
// same reasoning as `loom.instance-effect-needs-route-id` above: a `.ddd`
// generates working code on every target, or fails validation on every target.
//
// TWO exemptions, both grounded in a real renderer:
//
//   • `map` — the ONE op with a genuine frontend renderer on both engines:
//     native `Array.prototype.map` on the JS frontends and `Enum.map/2` on HEEx
//     (DEBT-31, `test/generator/elixir/heex-collection-ops.test.ts`).  Shipped
//     behaviour; not gated.
//   • `page { requires … }` — a gate expression is NOT walked by walker-core.
//     It goes through the closed `src/generator/_frontend/gate-expr.ts`
//     renderer, whose one admitted method IS a collection op
//     (`currentUser.permissions.contains(x)` → `.includes(x)`).  Gate
//     expressions are therefore excluded from this walk entirely.
//
// Detection needs a COLLECTION receiver, not just a catalogue NAME — lowering
// sets `isCollectionOp` from the member name alone (`lower-expr.ts`), so a
// scaffolded repository read `Sales.Customer.all` carries the catalogue name
// too (158 such reads across the repo's `.ddd` corpus, every one of them
// legitimate).  A collection receiver is recognised two ways, because page
// bodies mix TYPED and UNTYPED bindings:
//
//   • a `TypeIR` that IS a collection — `array`, or `optional<array>`.  Covers
//     `state { xs: string[] }`, a typed `derived`, a list literal, an
//     aggregate's `Line[]` field, and any chained result lowering types as an
//     array (`rows.map(…).count`).
//   • a bare ref to a lambda param the page DSL binds to a query's ROW SET —
//     `QueryView { of: X.all, data: rows => … }`.  The `data:` lambda param
//     carries no `TypeIR` (lowering leaves UI primitive lambda params at the
//     `string` placeholder), yet it is a collection by construction, and it is
//     the shape the defect was reported against.  `single: true` binds ONE
//     record instead, so that form binds nothing.
//
// Everything else stays out: a `Table(Column("Count", o => o.count))` accessor
// param is an ELEMENT, so a domain field genuinely named `count` / `first` /
// `min` never trips the gate.
// -------------------------------------------------------------------------

/** Collection ops the frontend walkers DO render, so the gate lets them through.
 *  `map` only: native `Array.prototype.map` (JS frontends) / `Enum.map/2`
 *  (HEEx) / `Iterable.map` (Dart).  Every other catalogue op emits verbatim on
 *  at least the four JS frontends.  Grow this set only alongside a real
 *  renderer on every frontend. */

const FRONTEND_RENDERED_COLLECTION_OPS: ReadonlySet<string> = new Set(["map"]);

/** True when a receiver type is a real collection — an `array`, or an
 *  `optional` wrapping one (`rows?.count`). */

function isCollectionType(t: TypeIR): boolean {
  const unwrapped = t.kind === "optional" ? t.inner : t;
  return unwrapped.kind === "array";
}

/** True when this receiver is known to hold a collection: either its `TypeIR`
 *  says so, or it is a bare ref to a row-set lambda binding (see the block
 *  above for why both are needed). */

function isCollectionReceiver(
  receiver: ExprIR,
  receiverType: TypeIR,
  rowSetBindings: ReadonlySet<string>,
): boolean {
  if (isCollectionType(receiverType)) return true;
  return receiver.kind === "ref" && rowSetBindings.has(receiver.name);
}

/** The unsupported collection-op name this node uses, or undefined.
 *  Covers BOTH spellings lowering produces: the call form
 *  (`rows.where(λ)` → `method-call` with `isCollectionOp`) and the
 *  property form (`rows.count` / `rows.first` → a plain `member`, since
 *  `lower-expr.ts` only rewrites a no-paren op into a call for the
 *  `NO_PAREN_CALL_COLLECTION_OPS` names on a TYPED collection). */

function unsupportedCollectionOp(
  e: ExprIR,
  rowSetBindings: ReadonlySet<string>,
  mapRendered: boolean,
): string | undefined {
  const named =
    e.kind === "method-call" && e.isCollectionOp
      ? e
      : e.kind === "member" && isCollectionOp(e.member)
        ? e
        : undefined;
  if (!named) return undefined;
  if (mapRendered && FRONTEND_RENDERED_COLLECTION_OPS.has(named.member)) return undefined;
  if (!isCollectionReceiver(named.receiver, named.receiverType, rowSetBindings)) return undefined;
  return named.member;
}

/** The `data:` lambda param a `QueryView` binds to a query's ROW SET, or
 *  undefined.  `single: true` binds one record, not a collection. */

function rowSetLambdaParam(e: ExprIR): string | undefined {
  if (e.kind !== "call" || e.name !== "QueryView") return undefined;
  const single = namedArg(e, "single");
  if (single?.kind === "literal" && single.lit === "bool" && single.value === "true")
    return undefined;
  const data = namedArg(e, "data");
  return data?.kind === "lambda" ? data.param : undefined;
}

/** Every expression surface of a STORE a frontend emits: the state
 *  initialisers.  (Its action bodies are walked separately, exactly as a
 *  page's are.)  A store has no `body`/`title`/`derived`, so it cannot go
 *  through `walkerRenderedExprs`. */

function storeRenderedExprs(store: StoreIR): ExprIR[] {
  const out: ExprIR[] = [];
  for (const s of store.state) if (s.init) out.push(s.init);
  return out;
}

// -------------------------------------------------------------------------
// `loom.page-primitive-extra-children` — the ARITY twin of the multi-child
// container sweep (#2567's `Card`, and `Tab` alongside this change).
//
// A container primitive (`Stack`, `Card`, `Tab`, …) renders EVERY positional
// as a child.  A handful of primitives are not containers at all: they are
// fixed SLOT shapes whose pack templates interpolate a known number of
// positions and have nowhere to put an extra one —
//
//   Stat(label, value)          two stacked text elements, `{{{label}}}` +
//                               `{{{value}}}` on all 15 packs
//   KeyValueRow(label, value)   a `<dt>`/`<dd>` pair; the value cell takes ONE
//                               already-walked element on Feliz/Flutter
//   Modal(trigger:, OperationForm(…))
//                               renders the TRIGGER button only — the dialog
//                               body is the op-form's generated field set
//
// A positional past a shape's slot count was read by nobody: the content
// vanished from every frontend while still landing in
// `.loom/messages.en.json`, the same translators-get-a-key-nothing-renders
// symptom `Tab` had.  Widening the packs is not the fix here (there is no
// second value slot to widen INTO), so this is the honest gate — the other
// half of #2567's fix-or-gate rule.
//
// MEMBERSHIP is no longer hand-listed here.  It was, and it covered exactly
// `Stat` / `KeyValueRow` / the op-form `Modal` while every other fixed-arity
// read in the primitive table stayed unguarded — `EnumBadge { "x", "dropped" }`
// and `Image { "/a.png", "/dropped.png", alt: "a" }` both parsed clean and both
// emitted only the first positional.  The slot counts now come from the ONE
// declaration of each primitive's argument surface,
// `WALKER_PRIMITIVE_SLOTS` in `src/util/walker-primitive-names.ts`, which a
// completeness test pins against the emitters' own positional reads.  A new primitive declares
// its contract there or the completeness test fails; it can no longer land
// silently outside this gate.
// -------------------------------------------------------------------------

/** The positional args of a lowered call (named args carry an `argNames` entry
 *  at the same index).  Mirrors the walker's `positionalArgs`, which lives in
 *  the generator layer and cannot be imported here. */

function positionalArgsOf(e: Extract<ExprIR, { kind: "call" }>): ExprIR[] {
  return e.args.filter((_, i) => !e.argNames?.[i]);
}

/** Visit every free call the walker DISPATCHES AS A PRIMITIVE.
 *
 *  A call sitting in the RECEIVER position of a member / method-call is not
 *  one: the walker hands the whole access to `emitExpr`, never to the
 *  primitive registry.  That distinction is load-bearing because a
 *  user-declared value object may share a primitive's NAME —
 *  `Stat { "valueObject", Money(9.99, "USD").currency }` in
 *  `web/src/examples/expression-showcase.ddd` constructs the VO `Money`, and
 *  reading it as the `Money` PRIMITIVE would reject shipped source over an
 *  arity the emitter never applies to it.  So the receiver chain is skipped
 *  while the ARGUMENTS are still walked (`rows.map(r => Text { r.name })`
 *  renders its lambda body). */

function walkRenderedPrimitives(
  e: ExprIR,
  visit: (call: Extract<ExprIR, { kind: "call" }>) => void,
): void {
  if (e.kind === "member" || e.kind === "method-call") {
    const receiver = e.receiver;
    walkExprChildren(e, {
      expr: (c) => {
        if (c !== receiver) walkRenderedPrimitives(c, visit);
      },
      stmt: (s) => walkStmtExprsDeep(s, (c) => walkRenderedPrimitives(c, visit)),
    });
    return;
  }
  if (e.kind === "call" && e.callKind === "free") visit(e);
  walkExprChildren(e, {
    expr: (c) => walkRenderedPrimitives(c, visit),
    stmt: (s) => walkStmtExprsDeep(s, (c) => walkRenderedPrimitives(c, visit)),
  });
}

// -------------------------------------------------------------------------
// `loom.table-filter-unsupported` / `loom.table-filter-server-paged` (M-T1.1)
//
// `Table { filter: <state> }` binds a search box above the table that narrows
// the rows client-side.  It renders on the six frameworks that ride the shared
// `walkBody` core — all six declare the `renderFilteredRows` +
// `renderFilterInput` seams — and on NOBODY else:
//
//   * HEEx runs a parallel engine (`elixir/heex-primitives.ts` `renderTable`),
//     whose `else if` chain handles `rows` / `testid` / sort / page and lets
//     `filter:` fall through into nothing.  No seam, no marker, no diagnostic.
//   * A SERVER-PAGED table's rows are one server window, so a client filter
//     would narrow that page rather than the result set — `table.ts` gates it
//     off (`!serverPaged`) and drops the arg.  This is the common case, not the
//     exotic one: `auto-paged-table.ts` REWRITES the simplest hand-written
//     `QueryView { of: X.all, data: rows => Table { rows: rows, filter: q } }`
//     into the server-paged shape, so the natural spelling loses its filter
//     with `ddd parse` reporting `0 error(s), 0 warning(s)` and the bound state
//     field left as a dead `useState`.
//
// Rendering it is a real slice on both sides (a `filter` param threaded into
// the generated `list/4` + a `handle_event` on LiveView; a server-side filter
// param on the paged read), so this is the honest half meanwhile.
// -------------------------------------------------------------------------

/** Frontends whose walker renders `Table { filter: … }` — the six that declare
 *  `renderFilteredRows` + `renderFilterInput` on their `WalkerTarget`.
 *
 *  EXPORTED so its own test can prove the gate still bites: with the six
 *  shipping frameworks listed, "the check works" and "the check is
 *  unreachable" look identical from outside, and the only honest way to tell
 *  them apart is to remove one and watch the diagnostic come back — the same
 *  discipline `CHART_FRAMEWORKS` uses. */

export const TABLE_FILTER_FRAMEWORKS: ReadonlySet<string> = new Set([
  "react",
  "vue",
  "svelte",
  "angular",
  "feliz",
  "flutter",
]);

/** True when a `Table` call carries a `filter:` bound to a page-state ref —
 *  exactly what `emitTable`'s `refArgName(call, "filter")` reads. */

function tableFilterRef(e: Extract<ExprIR, { kind: "call" }>): string | undefined {
  const i = (e.argNames ?? []).indexOf("filter");
  if (i < 0) return undefined;
  const arg = e.args[i];
  return arg?.kind === "ref" ? arg.name : undefined;
}

/** True when the call declares `serverPaged: true` — the flag `emitTable` reads
 *  and `auto-paged-table.ts` stamps on the rewritten hand-written table. */

function tableIsServerPaged(e: Extract<ExprIR, { kind: "call" }>): boolean {
  const i = (e.argNames ?? []).indexOf("serverPaged");
  if (i < 0) return false;
  const arg = e.args[i];
  return arg?.kind === "literal" && arg.lit === "bool" && arg.value === "true";
}

export function checkTableFilterSupport(
  host: PageIR | ComponentIR,
  where: string,
  framework: string,
  deployable: string,
  diags: LoomDiagnostic[],
): void {
  let flaggedUnsupported = false;
  let flaggedPaged = false;
  for (const root of walkerRenderedExprs(host)) {
    walkRenderedPrimitives(root, (e) => {
      if (e.name !== "Table") return;
      const filter = tableFilterRef(e);
      if (filter === undefined) return;
      if (!TABLE_FILTER_FRAMEWORKS.has(framework)) {
        if (flaggedUnsupported) return;
        flaggedUnsupported = true;
        diags.push({
          severity: "error",
          code: "loom.table-filter-unsupported",
          message: diagMessage("loom.table-filter-unsupported", {
            where,
            filter,
            framework,
            deployable,
          }),
          source: where,
        });
        return;
      }
      if (!tableIsServerPaged(e) || flaggedPaged) return;
      flaggedPaged = true;
      diags.push({
        severity: "error",
        code: "loom.table-filter-server-paged",
        message: diagMessage("loom.table-filter-server-paged", { where, filter }),
        source: where,
      });
    });
  }
}

// -------------------------------------------------------------------------
// `loom.modal-controlled-op-form-unsupported` (F2-CFE-12)
//
// `Modal { open: <stateBool>, OperationForm { … } }` combines the two modal
// shapes: the STATE-CONTROLLED shell (`emitControlledModal`) and the
// OPERATION-FORM dialog (`emitModal`'s trigger + generated field set).
// `emitModal` only reaches the controlled path when there is NO form child, so
// with both present and no `trigger:` control falls through to
// `renderComment("Modal: expects trigger: Button(...) and an
// OperationForm(<instance>.<operation>) child")` — the whole modal, form
// included, becomes a comment.  A `Tab` whose only child is that modal renders
// an empty panel, and `ddd parse` reports no error.
//
// It is NOT universal: Angular and Feliz fork the primitive and render the
// operation form (ignoring the `open:` binding, driving the dialog from their
// own trigger), and HEEx's `renderModal` handles it too.  So this is a
// per-target gap on the four that drop it, not a rejected shape.
// -------------------------------------------------------------------------

/** Frontends whose modal emitter renders an `OperationForm` child alongside an
 *  `open:` binding.  EXPORTED for the same reason as
 *  `TABLE_FILTER_FRAMEWORKS`: a gate whose Set names every target that can do
 *  the thing is indistinguishable from a dead one unless a test removes an
 *  entry and watches the diagnostic return. */

export const CONTROLLED_MODAL_OP_FORM_FRAMEWORKS: ReadonlySet<string> = new Set([
  "angular",
  "feliz",
  "phoenixLiveView",
]);

export function checkControlledModalOpForm(
  host: PageIR | ComponentIR,
  where: string,
  framework: string,
  deployable: string,
  diags: LoomDiagnostic[],
): void {
  if (CONTROLLED_MODAL_OP_FORM_FRAMEWORKS.has(framework)) return;
  let flagged = false;
  for (const root of walkerRenderedExprs(host)) {
    walkRenderedPrimitives(root, (e) => {
      if (flagged || e.name !== "Modal") return;
      if ((e.argNames ?? []).indexOf("open") < 0) return;
      const hasOpForm = positionalArgsOf(e).some(
        (a) => a.kind === "call" && a.name === "OperationForm",
      );
      if (!hasOpForm) return;
      flagged = true;
      diags.push({
        severity: "error",
        code: "loom.modal-controlled-op-form-unsupported",
        message: diagMessage("loom.modal-controlled-op-form-unsupported", {
          where,
          framework,
          deployable,
        }),
        source: where,
      });
    });
  }
}

/** Reject positionals no pack renders.  One diagnostic per (host, primitive):
 *  a body over-filling `Stat` twice made one mistake. */

export function checkFixedSlotArity(
  host: PageIR | ComponentIR,
  where: string,
  diags: LoomDiagnostic[],
): void {
  const flagged = new Set<string>();
  for (const root of walkerRenderedExprs(host)) {
    walkRenderedPrimitives(root, (e) => {
      const spec = WALKER_PRIMITIVE_SLOTS.get(e.name);
      if (spec) {
        if (positionalArgsOf(e).length <= spec.max || flagged.has(e.name)) return;
        flagged.add(e.name);
        diags.push({
          severity: "error",
          code: "loom.page-primitive-extra-children",
          message: diagMessage("loom.page-primitive-extra-children", {
            where,
            name: e.name,
            max: spec.max,
            slots: spec.slots ?? "its declared slots",
          }),
          source: where,
        });
        return;
      }
      // The op-form `Modal` shape: `primitive-modal` emits the trigger button
      // and nothing else, so every positional besides the `OperationForm`
      // child is dropped.  The state-controlled shape (`open: <state>`) IS a
      // children container and walks all of them — leave it alone.
      if (e.name !== "Modal" || flagged.has("Modal")) return;
      const positionals = positionalArgsOf(e);
      const hasOpForm = positionals.some((a) => a.kind === "call" && a.name === "OperationForm");
      if (!hasOpForm || positionals.length <= 1) return;
      flagged.add("Modal");
      diags.push({
        severity: "error",
        code: "loom.page-primitive-extra-children",
        message: diagMessage("loom.page-primitive-extra-children#modal-op-form", { where }),
        source: where,
      });
    });
  }
}

// -------------------------------------------------------------------------
// `loom.page-primitive-unknown-arg` — the NAMED-ARGUMENT twin of the arity
// gate above.
//
// Every emitter reads its named arguments BY NAME — `stringNamed(call,
// "variant")`, `namedArgValue(call, "of")`, `lambdaArg(call, "onSubmit")`.  A
// name outside a primitive's vocabulary is therefore read by NOBODY: it, and
// whatever content it carries, vanishes from every one of the seven render
// targets.  Worse than the extra-positional case, it does not even reach
// `.loom/messages.en.json`, so a translator cannot see that a caption went
// missing; and on a fixed-slot primitive it also DISPLACES the positional the
// content was meant to fill —
//
//     Card { title: "Bob's card", Text { "x" } }   → the caption is gone
//     Tabs { Tab { title: "One", … } }             → renders as "Tab 1"
//
// `title:` is the natural spelling (it IS a legal argument on `Alert`,
// `Modal` and `CodeBlock`), which is exactly why the mistake is easy to make
// and impossible to diagnose from the output.  The shipped
// `examples/showcase.ddd` carried the same defect at a larger scale until this
// gate found it: `Section { heading:, body: Stack { … } }` emitted a literal
// `<section />`, dropping the whole inline-emphasis demo.
//
// The vocabulary is `WALKER_PRIMITIVE_NAMED_ARGS` (src/util/walker-primitive-
// args.ts), pinned mechanically against the registry, `USER_VISIBLE_SLOTS` and
// the emitters' own reads by
// `test/language/type-system/walker-primitive-args-completeness.test.ts` — so
// this gate can never reject an argument an emitter honours, and a new
// primitive cannot land without declaring what it accepts.
// -------------------------------------------------------------------------

/** Reject a named argument no emitter reads.  One diagnostic per (host,
 *  primitive, argument): a body that misspells `title:` on three `Card`s made
 *  the same mistake three times, and hears about it once. */

export function checkPrimitiveNamedArgs(
  host: PageIR | ComponentIR,
  where: string,
  diags: LoomDiagnostic[],
): void {
  const flagged = new Set<string>();
  for (const root of walkerRenderedExprs(host)) {
    walkExprDeep(root, (e) => {
      if (e.kind !== "call" || e.callKind !== "free") return;
      const accepted = walkerPrimitiveNamedArgs(e.name);
      if (accepted === undefined) return; // a component / value object / extern call
      for (const argName of e.argNames ?? []) {
        if (argName === undefined) continue;
        // A `style:` argument that survived lowering is one `hoistStyleArg`
        // (src/ir/lower/lower-expr.ts) declined to lift, i.e. not an object
        // literal — dropped there with the comment "validator surfaces a
        // clearer diagnostic".  This is that diagnostic.
        if (argName === "style") {
          if (flagged.has(`${e.name}.style`)) continue;
          flagged.add(`${e.name}.style`);
          diags.push({
            severity: "error",
            code: "loom.page-primitive-unknown-arg",
            message: diagMessage("loom.page-primitive-unknown-arg#style-not-object", {
              where,
              name: e.name,
            }),
            source: where,
          });
          continue;
        }
        if (accepted.has(argName)) continue;
        const key = `${e.name}.${argName}`;
        if (flagged.has(key)) continue;
        flagged.add(key);
        diags.push({
          severity: "error",
          code: "loom.page-primitive-unknown-arg",
          message: diagMessage("loom.page-primitive-unknown-arg", {
            where,
            name: e.name,
            arg: argName,
            known: acceptedArgsSentence(e.name),
          }),
          source: where,
        });
      }
    });
  }
}

/** The "what IS accepted here" tail of the diagnostic — the primitive's own
 *  vocabulary, or a plain statement that it takes children only. */

function acceptedArgsSentence(name: string): string {
  const own = WALKER_PRIMITIVE_NAMED_ARGS[name] ?? [];
  const universal = "`testid:` and `style:` are accepted on every primitive";
  if (own.length === 0) {
    return `\`${name}\` takes positional children only — pass the content as a positional argument (${universal}).`;
  }
  return `\`${name}\` accepts ${own.map((a) => `\`${a}:\``).join(", ")} (${universal}).`;
}

/** F3 — reject a stdlib collection op anywhere the frontend walker renders it.
 *  One diagnostic per (host, op name): a body reading `rows.count` twice is one
 *  authoring mistake, not two. */

export function checkFrontendCollectionOps(
  host: PageIR | ComponentIR | StoreIR,
  where: string,
  mapRendered: boolean,
  diags: LoomDiagnostic[],
): void {
  const flagged = new Set<string>();
  const report = (op: string): void => {
    if (flagged.has(op)) return;
    flagged.add(op);
    diags.push({
      severity: "error",
      code: "loom.frontend-collection-op-unsupported",
      message: diagMessage("loom.frontend-collection-op-unsupported", { where, op }),
      source: where,
    });
  };
  // Scope-tracking walk: `rowSetBindings` grows as we descend into a
  // `QueryView`'s `data:` lambda, so `rows` is recognised as a collection
  // inside that lambda and nowhere else.  (`walkExprDeep` can't thread scope,
  // hence the explicit recursion over `walkExprChildren`.)
  const visitStmt = (s: StmtIR, scope: ReadonlySet<string>): void =>
    walkStmtChildren(
      s,
      (c) => visit(c, scope),
      (n) => visitStmt(n, scope),
    );
  const visit = (e: ExprIR, rowSetBindings: ReadonlySet<string>): void => {
    const op = unsupportedCollectionOp(e, rowSetBindings, mapRendered);
    if (op !== undefined) report(op);
    const rowParam = rowSetLambdaParam(e);
    const inner: ReadonlySet<string> = rowParam
      ? new Set<string>([...rowSetBindings, rowParam])
      : rowSetBindings;
    walkExprChildren(e, {
      expr: (c) => visit(c, inner),
      stmt: (s) => visitStmt(s, inner),
    });
  };
  const empty: ReadonlySet<string> = new Set<string>();
  // `lifetime` is StoreIR's discriminator — a page/component never carries one.
  const roots = "lifetime" in host ? storeRenderedExprs(host) : walkerRenderedExprs(host);
  for (const e of roots) visit(e, empty);
  for (const action of host.actions) for (const s of action.body) visitStmt(s, empty);
}

// -------------------------------------------------------------------------
// `loom.datagrid-selection-not-state` / `loom.datagrid-selection-not-array` —
// `DataGrid(selection: <field>)` is the one piece of grid view-state the page
// can read, and the walker wires it by NAME: it emits
// `onSelectionChange={set<Field>}` against the page shell's
// `useState<...>` for that field.  The walker has no types, so it can only
// check that the name is a declared state field — and silently drops the
// selection column when it isn't.  Both halves are gated here instead, where
// the declared `TypeIR` is resolved and the diagnostic can name the field:
//
//   - not a state field  → the checkbox column vanishes with no explanation
//     (the ref might be a page param, a `let`, or a typo);
//   - not `String[]`     → the emitted `setX(ids: string[])` is assigned a
//     `string[]` against e.g. `useState<string>`, surfacing as a tsc error in
//     generated code, far from its cause in the `.ddd`.
// -------------------------------------------------------------------------

export function checkDataGridSelection(
  body: ExprIR | undefined,
  state: readonly StateFieldIR[],
  where: string,
  diags: LoomDiagnostic[],
): void {
  const byName = new Map(state.map((f) => [f.name, f.type]));
  walkExprDeep(body, (e) => {
    if (e.kind !== "call" || e.name !== "DataGrid") return;
    const arg = namedArg(e, "selection");
    if (!arg) return;
    if (arg.kind !== "ref" || !byName.has(arg.name)) {
      const label = arg.kind === "ref" ? `'${arg.name}'` : "that expression";
      diags.push({
        severity: "error",
        code: "loom.datagrid-selection-not-state",
        message: diagMessage("loom.datagrid-selection-not-state", {
          where,
          where2: where.startsWith("component") ? "component" : "page",
          label,
        }),
        source: where,
      });
      return;
    }
    const t = byName.get(arg.name)!;
    if (!isStringArray(t)) {
      diags.push({
        severity: "error",
        code: "loom.datagrid-selection-not-array",
        message: diagMessage("loom.datagrid-selection-not-array", {
          where,
          name: arg.name,
          t: typeLabel(t),
        }),
        source: where,
      });
    }
  });
}

/** True for exactly `String[]` — the selected-row-id list shape the walker
 *  emits (`onSelectionChange: (ids: string[]) => void`). */

function isStringArray(t: TypeIR): boolean {
  return t.kind === "array" && t.element.kind === "primitive" && t.element.name === "string";
}

// -------------------------------------------------------------------------
// `loom.chart-of-not-grouped` / `loom.chart-kind-invalid` /
// `loom.chart-accessor-not-field` — the `Chart` primitive's arg shapes.
// The walker resolves each arg by NAME with no types in
// scope, so a wrong shape would emit a chart keyed on an empty string or
// bound to a one-object singleton read (`.data ?? []` of an object → `[]`, a
// permanently empty chart with no diagnostic).  Gated here instead, where the
// projection inventory and its `wireShape` are resolved and the diagnostic
// can name the fix.  Whether the TARGET can render a chart at all is
// `validateChartSupport` (system-checks.ts) — same flavour/framework split as
// the projection-read gates above.
// -------------------------------------------------------------------------

export function checkChartArgs(
  body: ExprIR | undefined,
  handles: ReadonlySet<string>,
  groupedReadable: ReadonlySet<string>,
  projections: ReadonlyMap<string, ProjectionIR>,
  where: string,
  diags: LoomDiagnostic[],
): void {
  walkExprDeep(body, (e) => {
    if (e.kind !== "call" || e.name !== "Chart") return;
    const kindArg = namedArg(e, "kind");
    const kind =
      kindArg?.kind === "literal" && kindArg.lit === "string" ? kindArg.value : undefined;
    if (kind !== "line" && kind !== "bar") {
      diags.push({
        severity: "error",
        code: "loom.chart-kind-invalid",
        message: diagMessage("loom.chart-kind-invalid", {
          where,
          kind: kind !== undefined ? ` — got "${kind}"` : "",
        }),
        source: where,
      });
    }
    // `of:` must be `<ApiHandle>.<Projection>` naming a readable GROUPED
    // projection — the LIST-shaped read the chart plots one point/bar per row
    // of.  A singleton returns ONE object (nothing to plot); a keyed/folded
    // projection has no frontend client at all (F3 above).
    const of = namedArg(e, "of");
    const projName =
      of?.kind === "member" && of.receiver.kind === "ref" && handles.has(of.receiver.name)
        ? of.member
        : undefined;
    const proj = projName !== undefined ? projections.get(projName) : undefined;
    const grouped = projName !== undefined && groupedReadable.has(projName);
    if (!grouped) {
      const why =
        proj !== undefined
          ? `projection '${projName}' is not a grouped query-time projection — it has no ` +
            `'group by', so its read is not the one-row-per-group list a chart plots. Add ` +
            `\`group by <column>\` to '${projName}' (with the matching key in its 'select'), ` +
            `or bind a singleton through \`QueryView\`/\`Stat\` instead`
          : `'of:' must be \`<ApiHandle>.<Projection>\` naming a grouped (\`group by\`) ` +
            `query-time projection declared in a served context`;
      diags.push({
        severity: "error",
        code: "loom.chart-of-not-grouped",
        message: diagMessage("loom.chart-of-not-grouped", { where, why }),
        source: where,
      });
    }
    // `x:`/`y:` must be simple accessor lambdas (`r => r.status`) naming a
    // declared row field — that is what unwraps to the chart's `dataKey` /
    // series string.  A computed body has no field name to key on.
    for (const slot of ["x", "y"] as const) {
      const lam = namedArg(e, slot);
      const field =
        lam?.kind === "lambda" && lam.body?.kind === "member" && lam.body.receiver.kind === "ref"
          ? lam.body.member
          : undefined;
      if (field === undefined) {
        diags.push({
          severity: "error",
          code: "loom.chart-accessor-not-field",
          message: diagMessage("loom.chart-accessor-not-field#not-a-simple-accessor", {
            where,
            slot,
            slot2: slot === "x" ? "category axis" : "series",
          }),
          source: where,
        });
      } else if (grouped && proj && !(proj.wireShape ?? []).some((f) => f.name === field)) {
        diags.push({
          severity: "error",
          code: "loom.chart-accessor-not-field",
          message: diagMessage("loom.chart-accessor-not-field#not-a-row-field", {
            where,
            slot,
            field,
            projName,
            wireShape: (proj.wireShape ?? []).map((f) => `'${f.name}'`).join(", "),
          }),
          source: where,
        });
      }
    }
  });
}
