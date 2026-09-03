// -------------------------------------------------------------------------
// Lazy-loaded user-component support checks (Feliz / Angular component
// deferral) — `loom.user-component-unsupported` and its per-target
// deferral analyses.  Split out of ui-checks.ts by packet 2.6 (wave-2) —
// mechanical move, no logic change.
// -------------------------------------------------------------------------

import { diagMessage } from "../../../diagnostics/messages.js";
import { pagedReturn } from "../../stdlib/generics.js";
import type { AggregateIR, ComponentIR, ExprIR, FindIR, UiIR } from "../../types/loom-ir.js";
import { walkExprDeep } from "../../util/walk.js";
import type { LoomDiagnostic } from "./diagnostic.js";

/** One deferral: what the emitter filtered on, in the emitter's own terms. */

interface ComponentDeferral {
  reason: string;
  /** The emitter site this arm mirrors — quoted in the diagnostic so the next
   *  reader can check the arm against the filter rather than trusting it. */
  emitter: string;
}

/** Lookups the deferral arms need — the ui's api handles plus the domain
 *  vocabulary the api-read patterns resolve against. */

interface DeferCtx {
  aggByName: ReadonlyMap<string, AggregateIR>;
  apiParamNames: ReadonlySet<string>;
  aggNames: ReadonlySet<string>;
  /** aggregate name → its repository's user finds, by name.  A read that
   *  resolves to one is hoisted as a REACTIVE query on Angular (its args are
   *  re-read lazily), which is what exempts it from the input-fed-read arm. */
  findsByAggregate: ReadonlyMap<string, ReadonlyMap<string, FindIR>>;
}

/** The api read a walked expression denotes, mirroring the walker's
 *  `tryDetectApiHook` patterns A/B (`<handle>.<Agg>.<op>`) and D/E
 *  (`<Agg>.<op>`, no handle) — the aggregate-rooted ones, which are the only
 *  patterns the arms below key on.  Returns `undefined` for anything else. */

function detectAggregateRead(
  e: ExprIR,
  ctx: DeferCtx,
): { aggregate: string; operation: string; args: readonly ExprIR[] } | undefined {
  if (e.kind === "member" && e.receiver.kind === "member") {
    const inner = e.receiver;
    if (inner.receiver.kind === "ref" && ctx.apiParamNames.has(inner.receiver.name)) {
      return { aggregate: inner.member, operation: e.member, args: [] };
    }
  }
  if (e.kind === "method-call" && e.receiver.kind === "member") {
    const inner = e.receiver;
    if (inner.receiver.kind === "ref" && ctx.apiParamNames.has(inner.receiver.name)) {
      return { aggregate: inner.member, operation: e.member, args: e.args };
    }
  }
  if (e.kind === "member" && e.receiver.kind === "ref" && ctx.aggNames.has(e.receiver.name)) {
    return { aggregate: e.receiver.name, operation: e.member, args: [] };
  }
  if (e.kind === "method-call" && e.receiver.kind === "ref" && ctx.aggNames.has(e.receiver.name)) {
    return { aggregate: e.receiver.name, operation: e.member, args: e.args };
  }
  return undefined;
}

/** The walker's standard aggregate operations (`walker-core.ts`
 *  `STANDARD_AGG_OPS`) — the ops whose hook args are NOT rewritten into a
 *  reactive query bag. */

const STANDARD_AGG_OPS: ReadonlySet<string> = new Set([
  "all",
  "byId",
  "create",
  "update",
  "delete",
]);

/** True when a read is hoisted as a REACTIVE query — a user `find`, or a
 *  paged `all`, whose rendered args become a query bag the query re-reads
 *  (`adjustFindHookArgs` in `src/generator/_walker/walker-core.ts`).  Such a
 *  read is exempt from the Angular input-fed-read filter: its args are wrapped
 *  in a `() => (…)`, so an `@Input()` is read lazily rather than in the
 *  constructor. */

function isReactiveQueryRead(aggregate: string, operation: string, ctx: DeferCtx): boolean {
  const find = ctx.findsByAggregate.get(aggregate)?.get(operation);
  if (!find) return false;
  const paged = pagedReturn(find.returnType) !== null;
  return !STANDARD_AGG_OPS.has(operation) || paged;
}

/** Names read by an expression — every `ref`, at any depth.  Used to ask
 *  whether a read's ARGUMENT reaches for a component parameter, which is what
 *  the Angular filter asks of the RENDERED argument text. */

function refNamesIn(e: ExprIR): Set<string> {
  const out = new Set<string>();
  walkExprDeep(e, (x) => {
    if (x.kind === "ref") out.add(x.name);
  });
  return out;
}

/** True when the expression tree reaches for the magic route `id`
 *  (`{ kind: "id" }` — what `walker-core.ts` sets `ctx.usesRouteId` on). */

function readsRouteId(e: ExprIR | undefined): boolean {
  let found = false;
  walkExprDeep(e, (x) => {
    if (x.kind === "id") found = true;
  });
  return found;
}

/** Params the Feliz / Angular props layer has no spelling for. */

function paramDeferrals(c: ComponentIR, framework: string): ComponentDeferral[] {
  const out: ComponentDeferral[] = [];
  for (const p of c.params) {
    const inner = p.type.kind === "optional" ? p.type.inner : p.type;
    if (inner.kind === "slot") {
      out.push({
        reason: `parameter '${p.name}' is a \`slot\``,
        emitter:
          framework === "feliz"
            ? "src/generator/feliz/component-emit.ts `propType` — a slot has no props-record spelling"
            : "src/generator/angular/components-emit.ts `hasSlotOrActionParam` — `ngComponentOutletInputs` sets INPUTS and has no content-projection channel",
      });
    } else if (inner.kind === "action") {
      out.push({
        reason: `parameter '${p.name}' is an \`action\` callback`,
        emitter:
          framework === "feliz"
            ? "src/generator/feliz/component-emit.ts `propType` — an action has no props-record spelling"
            : "src/generator/angular/components-emit.ts `hasSlotOrActionParam` — a callback through the inputs object loses `this`",
      });
    } else if (framework === "feliz" && p.type.kind === "optional") {
      out.push({
        reason: `parameter '${p.name}' is optional`,
        emitter:
          "src/generator/feliz/component-emit.ts `propType` — an F# anonymous record is EXACT, so a call site omitting the field would not typecheck",
      });
    }
  }
  return out;
}

/** The Feliz filters, in `component-emit.ts` order: the `isCandidate` param /
 *  derived gates, then the post-walk `renderOne` gates. */

function felizDeferrals(c: ComponentIR, ctx: DeferCtx): ComponentDeferral[] {
  const out = [...paramDeferrals(c, "feliz")];
  // `isCandidate` → `derivedNeedsPageScope`: the route `id` is bound by a PAGE
  // view fn, not by a component function.
  for (const d of c.derived) {
    if (readsRouteId(d.expr)) {
      out.push({
        reason: `\`derived ${d.name}\` reads the route \`id\`, which only a PAGE view binds`,
        emitter: "src/generator/feliz/component-emit.ts `derivedNeedsPageScope`",
      });
    }
  }
  // `renderOne` → `result.usesRouteId`.  Three body shapes set it: an explicit
  // `id`, and the two primitives the Feliz target forks onto a dispatch that
  // carries the route id (`felizTarget.renderAction` / `renderDestroyForm` both
  // set `ctx.usesRouteId = true` before returning their F#).
  const routeIdCauses: string[] = [];
  walkExprDeep(c.body, (e) => {
    if (e.kind === "id") routeIdCauses.push("reads the route `id`");
    if (e.kind !== "call") return;
    if (e.name === "DestroyForm") {
      const ofIdx = (e.argNames ?? []).indexOf("of");
      const ofArg = ofIdx >= 0 ? e.args[ofIdx] : undefined;
      if (ofArg?.kind === "ref") {
        routeIdCauses.push("renders `DestroyForm`, which deletes the record at the route `id`");
      }
    }
    if (e.name === "Action") {
      // `felizTarget.renderAction` resolves the receiver through the walk's
      // aggregate-typed params and requires a PARAMETERLESS public op; anything
      // else renders a comment instead (and never touches `usesRouteId`).
      const argNames = e.argNames ?? [];
      const opRef = (e.args ?? []).find((_, i) => !argNames[i]);
      if (opRef?.kind !== "member" || opRef.receiver.kind !== "ref") return;
      const paramType = c.params.find(
        (p) => p.name === (opRef.receiver as { name: string }).name,
      )?.type;
      const aggName = paramType?.kind === "entity" ? paramType.name : undefined;
      const agg = aggName ? ctx.aggByName.get(aggName) : undefined;
      const op = agg?.operations.find(
        (o) => o.name === opRef.member && o.visibility === "public" && o.params.length === 0,
      );
      if (op) {
        routeIdCauses.push(
          `renders \`Action { ${opRef.receiver.name}.${opRef.member} }\`, which dispatches with the route \`id\``,
        );
      }
    }
  });
  for (const cause of [...new Set(routeIdCauses)]) {
    out.push({
      reason: `its body ${cause} — a component function has no route of its own`,
      emitter:
        "src/generator/feliz/component-emit.ts `renderOne` (`result.usesRouteId`); the route `id` is bound by a page view fn",
    });
  }
  // `renderOne` → `(result.usedStores?.size ?? 0) > 0`.
  const stores = new Set<string>();
  walkExprDeep(c.body, (e) => {
    if (e.kind === "ref" && e.refKind === "store-field" && e.storeName) stores.add(e.storeName);
    if (e.kind === "call" && e.storeAction) stores.add(e.storeAction.store);
    if (e.kind === "action-ref" && e.storeName) stores.add(e.storeName);
  });
  for (const store of [...stores].sort()) {
    out.push({
      reason: `its body reads store '${store}'`,
      emitter: "src/generator/feliz/component-emit.ts `renderOne` (`result.usedStores`)",
    });
  }
  // `renderOne` → `needsMvuScope`: a `byId` read renders `model.<Agg>ById`, a
  // Model field `collectComponentReads` deliberately does NOT declare (its
  // fetch is fired by `pageCmd` on ROUTE entry, keyed to the hosting page's
  // `Page` case — which a component has none of).
  const byIdAggs = new Set<string>();
  walkExprDeep(c.body, (e) => {
    const read = detectAggregateRead(e, ctx);
    if (read?.operation === "byId") byIdAggs.add(read.aggregate);
  });
  for (const agg of [...byIdAggs].sort()) {
    out.push({
      reason: `its body issues a \`${agg}.byId(…)\` read, whose fetch a PAGE fires on route entry`,
      emitter:
        "src/generator/feliz/wire.ts `collectBodyReads` (a component passes no `pageCase`, so no Model field is declared) + `component-emit.ts` `needsMvuScope`",
    });
  }
  return out;
}

/** The Angular filters, in `components-emit.ts` order. */

function angularDeferrals(c: ComponentIR, ctx: DeferCtx): ComponentDeferral[] {
  const out = [...paramDeferrals(c, "angular")];
  // `renderOne` → the input-fed-read guard.  The page shell hoists an api read
  // as a class FIELD initializer, which runs in the constructor — before
  // Angular has set any `@Input()` — so the read would fire on `undefined`.
  // A REACTIVE query is exempt: a user `find`'s args are wrapped in a
  // `() => (…)` the query re-reads, so the input is read lazily.
  const inputNames = new Set(c.params.map((p) => p.name));
  const seen = new Set<string>();
  walkExprDeep(c.body, (e) => {
    const read = detectAggregateRead(e, ctx);
    if (!read || read.args.length === 0) return;
    if (isReactiveQueryRead(read.aggregate, read.operation, ctx)) return;
    const fed = read.args.flatMap((a) => [...refNamesIn(a)]).filter((n) => inputNames.has(n));
    if (fed.length === 0) return;
    const key = `${read.aggregate}.${read.operation}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      reason:
        `its body issues a \`${key}(…)\` read whose argument reads the \`@Input()\` ` +
        `'${fed[0]}' — the hoisted read runs in the constructor, before Angular sets inputs`,
      emitter: "src/generator/angular/components-emit.ts `renderOne` (the `readsAnInput` guard)",
    });
  });
  return out;
}

/** Raise one diagnostic per (component, deferred shape) for every ui rendered
 *  by a filtering frontend. */

export function checkUserComponentSupport(
  ui: UiIR,
  framework: string,
  dName: string,
  ctx: DeferCtx,
  diags: LoomDiagnostic[],
): void {
  for (const c of ui.components) {
    // An `extern` component is a hand-written shim the emitter always wires,
    // and a bodyless one has nothing to walk.
    if (c.extern || c.body === undefined) continue;
    const deferrals = framework === "feliz" ? felizDeferrals(c, ctx) : angularDeferrals(c, ctx);
    for (const d of deferrals) {
      diags.push({
        severity: "error",
        code: "loom.user-component-deferred-target",
        message: diagMessage("loom.user-component-deferred-target", {
          name: c.name,
          uiName: ui.name,
          framework,
          dName,
          reason: d.reason,
          emitter: d.emitter,
        }),
        source: `component '${c.name}'`,
      });
    }
  }
}
