// -------------------------------------------------------------------------
// Page-routing / page-reference / scaffold-filter-param checks:
// `loom.instance-effect-needs-route-id`, `loom.unknown-page-element`,
// `loom.slot-outside-component`, `loom.sub-primitive-misplaced`,
// unresolved page refs, scaffold filter params, and async/variant-match
// effect argument checks.  Split out of ui-checks.ts by packet 2.6
// (wave-2) — mechanical move, no logic change.
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import { RENDERABLE_FILTER_PRIMITIVES } from "../../../util/filter-param-kinds.js";
import {
  isWalkerPrimitive,
  WALKER_SUB_PRIMITIVE_PARENTS,
} from "../../../util/walker-primitive-names.js";
import type {
  ActionIR,
  AggregateIR,
  ComponentIR,
  ExprIR,
  FindIR,
  PageIR,
  StmtIR,
  TypeIR,
} from "../../types/loom-ir.js";
import { typeLabel } from "../../util/type-label.js";
import { walkExprChildren, walkExprDeep, walkStmtExprsDeep } from "../../util/walk.js";
import type { LoomDiagnostic } from "./diagnostic.js";
import { VIEW_EFFECT_BUILTINS, walkerRenderedExprs } from "./ui-checks-shared.js";

// -------------------------------------------------------------------------
// `loom.instance-effect-needs-route-id` (M-T6.17) — a page action whose body
// awaits an aggregate INSTANCE operation (`match await <api>.<Agg>.<op>(…)`)
// acts on the record identified by the page's route `:id`.  On a paramless page
// there is no record in scope, so the effect is user error on EVERY frontend:
// the Feliz generator gates it, and the JS frontends (React/Vue/Svelte/Angular)
// synthesize a `useParams` `id` and POST an empty-id (`id ?? ""`) request — a
// broken call.  This TARGET-AGNOSTIC check rejects it uniformly so a `.ddd`
// generates working code on every target, or fails validation on every target.
// (Workflows / non-aggregate subjects aren't record-scoped, so they're skipped.)
// -------------------------------------------------------------------------

/** True when a page `route:` binds a `:param` segment (`/orders/:id`). */

function pageRouteHasParam(route: string | undefined): boolean {
  return (route ?? "/").split("/").some((s) => s.startsWith(":"));
}

// -------------------------------------------------------------------------
// F4 — `loom.unknown-page-element`.
//
// A free call in a render-tree position (`Stack { Fooo { … } }`,
// `Text(Fooo(x))`) resolves at emit time against a fixed set: the walker
// primitive registry, the ui's declared components, a declared value object
// (a VO construction is a plain wire record), a ui `extern` function, and the
// view-effect builtins.  Anything else renders as one of two failures:
//
//   LAYOUT position → `{/* unknown layout component: Fooo */}`, a visible
//                     comment — bad, but findable.
//   TEXT SLOT       → NOTHING.  `Text(Fooo(x))` emits `<Text></Text>`; the
//                     content is silently deleted.
//
// The second is reachable by an ordinary typo and was flagged at NO tier: the
// brace form `Fooo { … }` has been rejected by the language validator
// (`loom.unknown-builder-type`) all along, but the CALL form of the same
// construct slipped through — one construct, two spellings, one gated.
//
// This check gates the call form at the IR tier, where the walker's acceptance
// set is reproducible from the enriched model.
// -------------------------------------------------------------------------

/** Names a free call in a render-tree position may legitimately carry. */

export interface CallableNames {
  components: ReadonlySet<string>;
  valueObjects: ReadonlySet<string>;
  functions: ReadonlySet<string>;
}

/** F4 — reject a render-tree call the walker cannot resolve.  One diagnostic
 *  per (host, name): a body repeating the same typo is one mistake. */

export function checkUnknownPageElements(
  host: PageIR | ComponentIR,
  where: string,
  names: CallableNames,
  diags: LoomDiagnostic[],
): void {
  const flagged = new Set<string>();
  for (const root of walkerRenderedExprs(host)) {
    walkExprDeep(root, (e) => {
      if (e.kind !== "call" || e.callKind !== "free") return;
      const name = e.name;
      if (flagged.has(name)) return;
      if (
        isWalkerPrimitive(name) ||
        names.components.has(name) ||
        names.valueObjects.has(name) ||
        names.functions.has(name) ||
        VIEW_EFFECT_BUILTINS.has(name) ||
        // A sibling action referenced as a value (`onClick: bump`) lowers to an
        // `action-ref`, not a call; a call to one only appears in an action
        // BODY, which `loom.unresolved-action-ref` owns.
        host.actions.some((a) => a.name === name)
      ) {
        return;
      }
      flagged.add(name);
      diags.push({
        severity: "error",
        code: "loom.unknown-page-element",
        message: diagMessage("loom.unknown-page-element", { where, name }),
        source: where,
      });
    });
  }
}

// -------------------------------------------------------------------------
// `loom.slot-outside-component` — `Slot { }` is the CHILDREN passthrough of a
// `component`: the walker sets `usesChildren`, the component shell declares the
// matching children parameter, and the call site's extra positionals fill it.
//
// A page has no caller and therefore no children parameter, so the same
// `Slot { }` in a PAGE body emits an UNBOUND children reference on every
// frontend — `{children}` (React: TS2304), `<slot />` (Vue: an empty slot that
// can never be filled), `{@render children?.()}` (Svelte: an undeclared prop),
// `<ng-content>`, `props.children` (Feliz: a missing record field — F# compile
// error) and `(child ?? const SizedBox.shrink())` (Flutter: an undeclared
// field).  Two of the six do not compile; the other four render nothing.
//
// It is a PLACEMENT mistake, not a per-target gap, so it belongs at the IR
// tier alongside `loom.unknown-page-element` — one gate, all six frontends.
// -------------------------------------------------------------------------

/** Reject `Slot { }` in a PAGE body — one diagnostic per page, however many
 *  slots it spells: a page repeating the mistake made it once. */

export function checkSlotOutsideComponent(
  page: PageIR,
  where: string,
  diags: LoomDiagnostic[],
): void {
  let flagged = false;
  for (const root of walkerRenderedExprs(page)) {
    walkExprDeep(root, (e) => {
      if (flagged || e.kind !== "call" || e.callKind !== "free" || e.name !== "Slot") return;
      flagged = true;
      diags.push({
        severity: "error",
        code: "loom.slot-outside-component",
        message: diagMessage("loom.slot-outside-component", { where }),
        source: where,
      });
    });
  }
}

// -------------------------------------------------------------------------
// `loom.sub-primitive-misplaced` — `Tab` and `Column` are the walker's two
// `group: "sub"` primitives: they have NO top-level renderer of their own.
// Their parent consumes them inline — `emitTabs` scans its positional args for
// `Tab(...)`, `emitTable` / `emitDataGrid` scan theirs for `Column(...)`.
//
// Spelled anywhere else (`Stack { Tab("x") }`, a bare `Column(…)` in a page
// body, a `Column` under a `Tabs`) the call reaches the walker's own dispatch,
// which finds a registered primitive with no `tsx` entry and emits a COMMENT:
// `{/* Tab: not supported by the walker yet */}` on the JSX family (React /
// Vue / Svelte / Angular / Feliz / Flutter), `<%!-- Tab: … --%>` on HEEx.  The
// element — and everything nested inside it — silently disappears from the
// rendered page.  Nothing compiles-errors, so no build gate sees it either.
//
// This is a PLACEMENT contract, not a per-target gap — exactly the shape of
// `loom.slot-outside-component` above, and gated the same way: once, at the IR
// tier, for all seven render targets.  The legal parents come from
// `WALKER_SUB_PRIMITIVE_PARENTS`, which `walker-stdlib-completeness.test.ts`
// pins against the registry's `a11y.owns`, so a new sub-primitive cannot land
// without declaring where it belongs.
// -------------------------------------------------------------------------

/** Reject a sub-primitive call that is not a direct positional child of one of
 *  its declared parents.  One diagnostic per (host, sub-primitive name): a body
 *  misplacing three `Column`s made one mistake. */

export function checkSubPrimitivePlacement(
  host: PageIR | ComponentIR,
  where: string,
  diags: LoomDiagnostic[],
): void {
  const flagged = new Set<string>();
  /** Recursive descent carrying the name of the IMMEDIATELY enclosing call, so
   *  the check keys on the parent/child edge the emitters actually read (a
   *  direct positional arg), not on "somewhere under a Tabs". */
  const visit = (e: ExprIR, parentCall: string | undefined): void => {
    if (e.kind === "call" && e.callKind === "free") {
      const parents = WALKER_SUB_PRIMITIVE_PARENTS.get(e.name);
      if (parents && !(parentCall !== undefined && parents.has(parentCall))) {
        if (!flagged.has(e.name)) {
          flagged.add(e.name);
          diags.push({
            severity: "error",
            code: "loom.sub-primitive-misplaced",
            message: diagMessage("loom.sub-primitive-misplaced", {
              where,
              name: e.name,
              parents: [...parents].map((p) => `'${p}'`).join(" or "),
            }),
            source: where,
          });
        }
      }
    }
    // Only a free CALL can be a legal parent (`Tabs(Tab(…), Tab(…))`); anything
    // else resets the parent to `undefined` so a sub-primitive smuggled through
    // a lambda, a member access or a `match` arm is still reported.
    const nextParent = e.kind === "call" ? e.name : undefined;
    walkExprChildren(e, {
      expr: (c) => visit(c, nextParent),
      stmt: (s) => walkStmtExprsDeep(s, (c) => visit(c, undefined)),
    });
  };
  for (const root of walkerRenderedExprs(host)) visit(root, undefined);
}

// -------------------------------------------------------------------------
// `loom.scaffold-filter-param-unsupported` — the scaffolded list page's
// filter bar drops a find it cannot render an input for.
//
// `filterFindsForAggregate` (src/macros/stdlib/scaffold/_body-builders.ts)
// wires one filter input per param of every array-returning `find`, and the
// arm is ALL-OR-NOTHING: a find with a single unrenderable param is skipped
// whole.  It renders `string`, `int`, `long` and `<X> id`; `decimal`/`money`,
// `enum`, `bool`, `datetime` and `guid` are held back for reasons that live in
// the FRONTEND emitters, not in the macro (see
// `src/util/filter-param-kinds.ts`).  Until this gate the skip was silent: the
// author declared `find byStatus(s: Status): Order[]`, the scaffolded list
// page came out with no `Status` filter, and nothing anywhere said why.
//
// A WARNING, not an error: an aggregate may legitimately carry finds the
// author never wanted in the bar (a workflow's lookup, a criterion-backed
// read).  It is also suppressed when the page's own body already references
// the find — a hand-written or overridden `page List` that binds it is doing
// exactly what the message would ask for.
// -------------------------------------------------------------------------

/** Whether the scaffolded filter bar can render an input for a find param. */

function filterParamRenderable(t: TypeIR): boolean {
  if (t.kind === "id") return true;
  return t.kind === "primitive" && RENDERABLE_FILTER_PRIMITIVES.has(t.name);
}

/** Every name a page body READS through a call or member access — enough to
 *  tell "the author already bound this find here" from "the bar dropped it". */

function namesReadByBody(host: PageIR | ComponentIR): Set<string> {
  const out = new Set<string>();
  for (const root of walkerRenderedExprs(host)) {
    walkExprDeep(root, (e) => {
      if (e.kind === "call") out.add(e.name);
      else if (e.kind === "method-call") out.add(e.member);
      else if (e.kind === "member") out.add(e.member);
    });
  }
  return out;
}

/** Report each array-returning find the scaffolded filter bar had to drop. */

export function checkScaffoldFilterParams(
  page: PageIR,
  aggregateName: string,
  finds: ReadonlyMap<string, FindIR> | undefined,
  where: string,
  diags: LoomDiagnostic[],
): void {
  if (!finds || finds.size === 0) return;
  let bound: Set<string> | undefined;
  for (const find of finds.values()) {
    // `all` is the auto-`findAll` the bar renders unconditionally; the
    // synthesized paged twin and the audit-history read are not user finds.
    if (find.name === "all" || find.synthesized || find.auditHistory) continue;
    if (find.returnType.kind !== "array" || find.params.length === 0) continue;
    const bad = find.params.find((prm) => !filterParamRenderable(prm.type));
    if (!bad) continue;
    bound ??= namesReadByBody(page);
    if (bound.has(find.name)) continue;
    diags.push({
      severity: "warning",
      code: "loom.scaffold-filter-param-unsupported",
      message: diagMessage("loom.scaffold-filter-param-unsupported", {
        where,
        find: find.name,
        param: bad.name,
        type: typeLabel(bad.type),
        aggregate: aggregateName,
      }),
      source: where,
    });
  }
}

// -------------------------------------------------------------------------
// `loom.op-form-needs-route-id` — the BY-NAME operation form on a page whose
// route carries no `:id`.
//
// `OperationForm { of: <Agg>, op: <op> }` names the operation but no RECORD, so
// every frontend resolves the target from the page's route id
// (`emitFormOfOperationByName` pushes `idExpr: 'id ?? ""'`; the Angular /
// Feliz / Flutter twins do the same).  On a page whose route declares no `:id`
// that binding is `undefined`, and the form submits the operation against an
// EMPTY id — `use<Op><Agg>("")`, a request to `/<aggs>//<op>` that no backend
// route matches.
//
// Until wave 2 this shape ALSO failed to compile (`id` was never bound —
// F2-CFE-5's TS2304); binding it fixed the compile error and left the semantic
// one, which is this gate.  It is the exact twin of
// `loom.instance-effect-needs-route-id` one site over — whose message, until
// now, recommended `OperationForm` as the workaround for the very defect it
// shares.
//
// Scope is the BY-NAME shape only (`of:` + `op:` named args).  The instance
// spelling (`OperationForm { row.rename }`) carries its own record and is
// fine, and a `component` body has no route to check against.
// -------------------------------------------------------------------------

/** Reject a by-name `OperationForm` on a route with no `:id` to target. */

export function checkOpFormRouteId(page: PageIR, diags: LoomDiagnostic[]): void {
  if (pageRouteHasParam(page.route)) return;
  const flagged = new Set<string>();
  for (const root of walkerRenderedExprs(page)) {
    walkExprDeep(root, (e) => {
      if (e.kind !== "call" || e.callKind !== "free" || e.name !== "OperationForm") return;
      const names = e.argNames ?? [];
      const named = (n: string): ExprIR | undefined => {
        for (let i = 0; i < e.args.length; i++) if (names[i] === n) return e.args[i];
        return undefined;
      };
      const of = named("of");
      const op = named("op");
      if (of === undefined || op === undefined) return;
      const aggName = of.kind === "ref" ? of.name : undefined;
      const opName = op.kind === "ref" ? op.name : undefined;
      if (aggName === undefined || opName === undefined) return;
      const key = `${aggName}.${opName}`;
      if (flagged.has(key)) return;
      flagged.add(key);
      diags.push({
        severity: "error",
        code: "loom.op-form-needs-route-id",
        message: diagMessage("loom.op-form-needs-route-id", {
          name: page.name,
          route: page.route ?? "/",
          agg: aggName,
          op: opName,
        }),
        source: pageWhere(page),
      });
    });
  }
}

// -------------------------------------------------------------------------
// `loom.unresolved-page-ref` — the last silent-drop door in a page body.
//
// A bare name in a rendered position resolves at emit time against the route
// params, the `state { }` fields, the `derived` bindings, an enclosing
// lambda's parameter, a `<Store>.<field>` read, or a `let`.  Anything else
// lowers to `refKind: "unknown"` and the walker emits a COMMENT —
// `{/* ref: nosuchthing */}` on the four JS frontends, `Html.none` on Feliz,
// `SizedBox.shrink()` on Flutter.  `Text { nosuchthing }` therefore compiles
// green on all six with its content gone: a typo deletes the content, exactly
// like the `Text(Fooo(x))` case `loom.unknown-page-element` closed for the
// CALL spelling.  The REF spelling had no gate at any tier — this is it.
//
// Scope is deliberately the walker's own: the direct positional arguments of a
// rendered call (and the operand/arm sub-expressions inside one), never a
// member or method-call RECEIVER — `Status.Open` and `Shop.Thing.all` root at
// an `unknown` ref by design (an enum name, an api handle), and those are
// resolved by the member walk, not by the ref.
// -------------------------------------------------------------------------

/** Collect the refs a rendered slot resolves DIRECTLY, stopping at any
 *  receiver-rooted shape (member / method-call / nested call). */

function directlyRenderedRefs(e: ExprIR, out: Extract<ExprIR, { kind: "ref" }>[]): void {
  switch (e.kind) {
    case "ref":
      out.push(e);
      return;
    case "paren":
      directlyRenderedRefs(e.inner, out);
      return;
    case "unary":
      directlyRenderedRefs(e.operand, out);
      return;
    case "binary":
      directlyRenderedRefs(e.left, out);
      directlyRenderedRefs(e.right, out);
      return;
    case "ternary":
      directlyRenderedRefs(e.cond, out);
      directlyRenderedRefs(e.then, out);
      directlyRenderedRefs(e.otherwise, out);
      return;
    default:
      return;
  }
}

/** Named primitive slots whose argument is a VALUE the frontend reads and
 *  renders — as opposed to the structural slots (`of:` / `op:` / `workflow:` /
 *  `to:` / `data:` …) that name a DECLARATION the walker resolves against the
 *  model.  Only these carry the silent-drop / `undefined`-emitting failure the
 *  ref gate exists to close, so only these are scanned for unresolved refs. */

const VALUE_SLOT_ARGS: ReadonlySet<string> = new Set([
  "value",
  "label",
  "text",
  "title",
  "subtitle",
  "caption",
  "placeholder",
  "help",
  "hint",
  "alt",
  "message",
  "description",
  "emptyText",
]);

/** Reject an unresolved bare ref in a rendered slot.  One diagnostic per
 *  (host, name): a page spelling the same typo three times made one mistake. */

export function checkUnresolvedPageRefs(
  host: PageIR | ComponentIR,
  where: string,
  names: CallableNames,
  diags: LoomDiagnostic[],
): void {
  const flagged = new Set<string>();
  for (const root of walkerRenderedExprs(host)) {
    walkExprDeep(root, (e) => {
      if (e.kind !== "call" || e.callKind !== "free") return;
      // Only calls the walker RENDERS: a stdlib primitive or a declared
      // component.  Anything else is `loom.unknown-page-element`'s business.
      if (!isWalkerPrimitive(e.name) && !names.components.has(e.name)) return;
      const slots: Extract<ExprIR, { kind: "ref" }>[] = [];
      e.args.forEach((arg, i) => {
        const argName = e.argNames?.[i];
        // A POSITIONAL arg is a rendered slot outright.  A NAMED arg is a
        // rendered slot only when the name is a VALUE slot: `Text { value:
        // nosuchthing }` emits `<Text></Text>` with the content silently gone,
        // and `Money { value: alsomissing }` emits `<MoneyValue value={ /*
        // unresolved: alsomissing */ undefined } />` — a guaranteed TypeError
        // that also fails `tsc --noEmit` / `svelte-check` / `vue-tsc`.  Scanning
        // positionals ONLY let that identical defect through on the spelling
        // authors actually use for a value.
        //
        // The other named slots are STRUCTURAL: `of:` / `op:` / `workflow:` name
        // a DECLARATION (an aggregate, an operation, a workflow), which lowers
        // to `refKind: "unknown"` by design because the walker resolves it
        // against the model rather than the page's value scope — the same class
        // as the `Status.Open` enum receiver this walk already stops at.  Every
        // scaffolded page in the corpus spells them, so reading them as value
        // slots would reject shipped output.  Keyed on the slot NAME rather than
        // on "is this a declared name?" because the latter has to enumerate
        // every declaration namespace and silently reopens the hole for the one
        // it forgets.
        if (argName !== undefined && !VALUE_SLOT_ARGS.has(argName)) return;
        directlyRenderedRefs(arg, slots);
      });
      for (const ref of slots) {
        if (ref.refKind !== "unknown" || flagged.has(ref.name)) continue;
        flagged.add(ref.name);
        diags.push({
          severity: "error",
          code: "loom.unresolved-page-ref",
          message: diagMessage("loom.unresolved-page-ref", { where, name: ref.name }),
          source: where,
        });
      }
    });
  }
}

/** The aggregate + op a `variant-match` subject awaits, when it is an aggregate
 *  INSTANCE operation — `<apiParam>.<Agg>.<op>(…)` (Pattern B) or a bare
 *  `<Agg>.<op>(…)` (Pattern E); otherwise null.  Mirrors `detectAwaitedInstanceOp`
 *  in the Feliz classifier, target-neutral. */

function resolveInstanceOpSubject(
  subject: ExprIR,
  apiParamNames: ReadonlySet<string>,
  aggNames: ReadonlySet<string>,
): { aggregate: string; op: string } | null {
  if (subject.kind !== "method-call") return null;
  const recv = subject.receiver;
  if (
    recv.kind === "member" &&
    recv.receiver.kind === "ref" &&
    apiParamNames.has(recv.receiver.name) &&
    aggNames.has(recv.member)
  ) {
    return { aggregate: recv.member, op: subject.member };
  }
  if (recv.kind === "ref" && aggNames.has(recv.name)) {
    return { aggregate: recv.name, op: subject.member };
  }
  return null;
}

/** Walk a `variant-match` subject at every depth in an action body. */

function forEachVariantMatch(
  stmts: readonly StmtIR[],
  visit: (s: Extract<StmtIR, { kind: "variant-match" }>) => void,
): void {
  for (const s of stmts) {
    if (s.kind === "variant-match") {
      visit(s);
      for (const arm of s.arms) forEachVariantMatch(arm.body, visit);
      forEachVariantMatch(s.elseBody ?? [], visit);
    }
  }
}

/** Reject an instance-op `match await` on a page with no `:id` route. */

export function checkInstanceEffectRouteId(
  page: PageIR,
  aggNames: ReadonlySet<string>,
  apiParamNames: ReadonlySet<string>,
  diags: LoomDiagnostic[],
): void {
  if (pageRouteHasParam(page.route)) return;
  for (const action of page.actions) {
    forEachVariantMatch(action.body, (s) => {
      if (!resolveInstanceOpSubject(s.subject, apiParamNames, aggNames)) return;
      diags.push({
        severity: "error",
        code: "loom.instance-effect-needs-route-id",
        message: diagMessage("loom.instance-effect-needs-route-id", {
          name: page.name,
          route: page.route ?? "/",
        }),
        source: `page '${page.name}'`,
      });
    });
  }
}

/** `loom.match-await-arg-mismatch` — the awaited op call's arguments must match
 *  the operation signature.  The request payload every frontend POSTs is built by
 *  index-aligning the call's args with the op's params, so a wrong count silently
 *  ships a broken request (React emits `{ note: undefined }`; Feliz fails the
 *  Fable compile).  Validate the arity here, target-agnostically: at most one arg
 *  per param, and every un-supplied trailing param must be `optional`. */

export function checkAsyncEffectArgs(
  where: string,
  actions: readonly ActionIR[],
  aggByName: ReadonlyMap<string, AggregateIR>,
  apiParamNames: ReadonlySet<string>,
  aggNames: ReadonlySet<string>,
  diags: LoomDiagnostic[],
): void {
  for (const action of actions) {
    forEachVariantMatch(action.body, (s) => {
      if (s.subject.kind !== "method-call") return;
      const resolved = resolveInstanceOpSubject(s.subject, apiParamNames, aggNames);
      const agg = resolved && aggByName.get(resolved.aggregate);
      const op = agg?.operations.find((o) => o.name === resolved!.op);
      if (!op) return; // not a resolvable aggregate op — nothing to arity-check
      const args = s.subject.args;
      const params = op.params;
      const sig = params.map((p) => `${p.name}: ${typeLabel(p.type)}`).join(", ");
      // Arity — the request payload index-aligns args → params.
      const tooMany = args.length > params.length;
      const missingRequired = params.slice(args.length).some((p) => p.type.kind !== "optional");
      if (tooMany || missingRequired) {
        diags.push({
          severity: "error",
          code: "loom.match-await-arg-mismatch",
          message: diagMessage("loom.match-await-arg-mismatch", {
            where,
            aggregate: resolved!.aggregate,
            op: resolved!.op,
            length: args.length,
            sig,
            paramsLength: params.length,
            length2: params.filter((p) => p.type.kind !== "optional").length,
          }),
          source: where,
        });
      }
      // Type — for the args we can PROVE a type of (literals), the family must
      // match the param's.  Refs / computed exprs are skipped (no false positive);
      // full expr-type inference over the args is the language-type-checker's job.
      for (let i = 0; i < Math.min(args.length, params.length); i++) {
        const arg = args[i]!;
        if (arg.kind !== "literal") continue;
        const argFam = literalFamily(arg.lit);
        const paramFam = typeFamily(params[i]!.type);
        if (!argFam || !paramFam || argFam === paramFam) continue;
        diags.push({
          severity: "error",
          code: "loom.match-await-arg-type",
          message: diagMessage("loom.match-await-arg-type", {
            where,
            aggregate: resolved!.aggregate,
            op: resolved!.op,
            argFam,
            value: arg.value,
            name: params[i]!.name,
            type: typeLabel(params[i]!.type),
            paramFam,
          }),
          source: where,
        });
      }
    });
  }
}

/** Coarse type family of a literal, or undefined when it doesn't constrain
 *  (`null` / `now`).  Used for a low-false-positive arg/param type check. */

function literalFamily(lit: string): "numeric" | "string" | "bool" | undefined {
  switch (lit) {
    case "int":
    case "long":
    case "decimal":
    case "money":
      return "numeric";
    case "string":
      return "string";
    case "bool":
      return "bool";
    default:
      return undefined; // null / now — don't constrain
  }
}

/** Coarse type family of a param type (peeling `optional`), or undefined when a
 *  literal can't be meaningfully family-checked against it (VO / entity / array).
 *  Enum + id + datetime are string-ish on the wire, so a string literal fits. */

function typeFamily(t: TypeIR): "numeric" | "string" | "bool" | undefined {
  const base = t.kind === "optional" ? t.inner : t;
  if (base.kind === "id" || base.kind === "enum") return "string";
  if (base.kind === "primitive") {
    switch (base.name) {
      case "int":
      case "long":
      case "decimal":
      case "money":
        return "numeric";
      case "bool":
        return "bool";
      case "string":
      case "json":
      case "datetime":
        return "string";
      default:
        return undefined;
    }
  }
  return undefined;
}

export function pageWhere(p: PageIR): string {
  return `page '${p.name}'`;
}
