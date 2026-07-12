// Domain-service emission (TS / Hono) — domain-services.md, v1 Shape A.
//
// Each `domainService Pricing { operation quote(...) {...} }` lowers to an
// exported namespace of pure functions:
//
//   export namespace Pricing {
//     export function quote(cart: Cart, customer: Customer): Money { ... }
//   }
//
// The operation bodies render through the shared TS statement/expression
// path (`renderTsStatements` / `renderTsExpr`) — parameters resolve as
// bare locals (refKind `param`), there is no `this`.  An `or`-union return
// reuses the EXACT exception-less union shape the aggregate operations emit
// (`renderOperationReturnType`): `{ type: "Ok"; ... } | { type:
// "CouponExpired"; ... }` — no new union machinery.
//
// A member call from anywhere (`Pricing.quote(cart, customer)`) is rendered
// by `TS_TARGET.domainServiceCall` (render-expr.ts) → `Pricing.quote(...)`.
//
// Imports are computed precisely from the rendered output (mirroring the
// per-aggregate import narrowing in aggregate.ts): only the value objects /
// enums / aggregate classes the signatures and bodies actually reference are
// imported, so the file passes `tsc --noEmit` with no unused locals.

import type {
  BoundedContextIR,
  DomainServiceIR,
  DomainServiceOperationIR,
  EnumIR,
  TypeIR,
  ValueObjectIR,
} from "../../../ir/types/loom-ir.js";
import {
  type ReadPort,
  readPortsForOperation,
} from "../../../ir/util/domain-service-read-ports.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst } from "../../../util/naming.js";
import { renderTsType } from "../render-expr.js";
import { renderTsStatements } from "../render-stmt.js";
import { PORT_POOL_DOMAIN_SPEC, repoPortName } from "../repository-port-builder.js";
import { renderOperationReturnType } from "./aggregate.js";

/** Emit the `domain/services.ts` file for a context's domain services, or
 *  `undefined` when the context declares none. */
export function renderDomainServices(ctx: BoundedContextIR): string | undefined {
  if (ctx.domainServices.length === 0) return undefined;

  // Render every service body first, then derive the import surface from the
  // emitted text + the declared signature types.
  const rendered = ctx.domainServices.map((svc) => renderService(svc, ctx));
  const body = rendered.join("\n");
  // Strip string-literal contents so a symbol that only appears inside a
  // quoted message doesn't count as a reference (same guard as aggregate.ts).
  const scanBody = body
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");

  const voNames = new Set(ctx.valueObjects.map((v: ValueObjectIR) => v.name));
  const enumNames = new Set(ctx.enums.map((e: EnumIR) => e.name));
  const aggNames = new Set(ctx.aggregates.map((a) => a.name));

  // Types named in any signature (params + returns) — these always need an
  // import even when the body never re-mentions them.
  const sigTypeNames = new Set<string>();
  for (const svc of ctx.domainServices ?? []) {
    for (const op of svc.operations) {
      for (const p of op.params) collectTypeNames(p.type, sigTypeNames);
      if (op.returnType) collectTypeNames(op.returnType, sigTypeNames);
    }
  }
  const referenced = (n: string): boolean =>
    sigTypeNames.has(n) || new RegExp(`\\b${n}\\b`).test(scanBody);

  const usedVoOrEnum = [...voNames, ...enumNames].filter(referenced).sort();
  const usedAggs = [...aggNames].filter(referenced).sort();
  const usesMoney = /\bDecimal\b/.test(scanBody) || /money/.test([...sigTypeNames].join(" "));
  const usesIds = /\bIds\.\w/.test(scanBody) || sigCarriesId(ctx);
  // Read-port repository classes (domain-services.md rev. 4): a `reading`-tier
  // op takes a `<Aggregate>Repository` handle, imported as a VALUE type from the
  // generated repository module (the param annotation is a type position, but
  // the class is exported as a value, so a plain `import type` keeps it).
  const readPortRepos = collectReadPortRepos(ctx).sort((a, b) =>
    a.aggregate.localeCompare(b.aggregate),
  );

  return (
    lines(
      "// Domain services — stateless pure calculators (domain-services.md).",
      "// Auto-generated: do not edit.",
      usesMoney ? 'import Decimal from "decimal.js";' : null,
      usesIds ? 'import * as Ids from "./ids";' : null,
      usedVoOrEnum.length > 0
        ? `import { ${usedVoOrEnum.join(", ")} } from "./value-objects";`
        : null,
      ...usedAggs.map((n) => `import type { ${n} } from "./${lowerFirst(n)}";`),
      // Read-port repository handles are typed against the domain-side PORT
      // (audit S7 — hexagonal), NOT the concrete infra repository: the domain
      // layer must not import from `db/`.  The orchestrating workflow injects
      // the concrete `<Agg>Repository` (which `implements` the port) at the
      // call site.
      readPortRepos.length > 0
        ? `import type { ${readPortRepos
            .map((p) => repoPortName(p.aggregate))
            .join(", ")} } from "${PORT_POOL_DOMAIN_SPEC}";`
        : null,
      "",
      body,
    ) + "\n"
  );
}

function renderService(svc: DomainServiceIR, ctx: BoundedContextIR): string {
  return lines(
    `export namespace ${svc.name} {`,
    ...svc.operations.map((op) => indentBlock(renderOperation(op, ctx))),
    "}",
    "",
  );
}

function renderOperation(op: DomainServiceOperationIR, ctx: BoundedContextIR): string {
  // Read-port parameters (domain-services.md rev. 4, Slice 1): a `reading`-tier
  // op takes one repository handle per repo it reads, AHEAD of the user params —
  // `accounts: AccountRepository` — exactly the handle the body's `repo-read`
  // arms render against (`await accounts.byHolder(holder)`) and the orchestrating
  // workflow supplies.  A PURE op has no ports, so its declaration is unchanged
  // (byte-identical).  Each read-port repository read makes the operation `async`
  // (the repo methods are awaited), and its return type is wrapped in a Promise.
  const ports = readPortsForOperation(op);
  const portParams = ports.map((p) => `${lowerFirst(p.repo)}: ${repoPortName(p.aggregate)}`);
  const userParams = op.params.map((p) => `${p.name}: ${renderTsType(p.type)}`);
  const params = [...portParams, ...userParams].join(", ");
  const isReading = ports.length > 0;
  const kw = isReading ? "export async function" : "export function";
  const ret = op.returnType
    ? `: ${isReading ? `Promise<${renderOperationReturnType(op.returnType, ctx)}>` : renderOperationReturnType(op.returnType, ctx)}`
    : "";
  return lines(`${kw} ${lowerFirst(op.name)}(${params})${ret} {`, renderTsStatements(op.body), "}");
}

/** The distinct read-port repositories (`<Aggregate>Repository` classes) every
 *  reading-tier operation in a context's domain services reads — drives the
 *  repository-class import surface.  De-duplicated by aggregate. */
function collectReadPortRepos(ctx: BoundedContextIR): ReadPort[] {
  const byAgg = new Map<string, ReadPort>();
  for (const svc of ctx.domainServices) {
    for (const op of svc.operations) {
      for (const p of readPortsForOperation(op)) {
        if (!byAgg.has(p.aggregate)) byAgg.set(p.aggregate, p);
      }
    }
  }
  return [...byAgg.values()];
}

/** Collect every named type (enum / valueobject / entity / id targetName)
 *  reachable through a TypeIR — drives signature-import narrowing. */
function collectTypeNames(t: TypeIR, into: Set<string>): void {
  switch (t.kind) {
    case "enum":
    case "valueobject":
    case "entity":
      into.add(t.name);
      break;
    case "array":
      collectTypeNames(t.element, into);
      break;
    case "optional":
      collectTypeNames(t.inner, into);
      break;
    case "union":
      for (const v of t.variants) collectTypeNames(v, into);
      break;
    case "genericInstance":
      collectTypeNames(t.arg, into);
      break;
  }
}

/** True when any signature carries an `id` type or money (`Ids.*` / Decimal
 *  imports get pulled in then even if the body text didn't re-mention them). */
function sigCarriesId(ctx: BoundedContextIR): boolean {
  const carries = (t: TypeIR): boolean => {
    switch (t.kind) {
      case "id":
        return true;
      case "array":
        return carries(t.element);
      case "optional":
        return carries(t.inner);
      case "union":
        return t.variants.some(carries);
      case "genericInstance":
        return carries(t.arg);
      default:
        return false;
    }
  };
  return ctx.domainServices.some((svc) =>
    svc.operations.some(
      (op) =>
        op.params.some((p) => carries(p.type)) || (op.returnType ? carries(op.returnType) : false),
    ),
  );
}

/** Indent a multiline block by two spaces for nesting inside the
 *  `namespace { … }` wrapper. */
function indentBlock(block: string): string {
  return block
    .split("\n")
    .map((l) => (l.length > 0 ? `  ${l}` : l))
    .join("\n");
}
