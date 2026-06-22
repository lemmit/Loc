// ---------------------------------------------------------------------------
// Domain-service emission (Java / Spring) — domain-services.md, v1 Shape A.
//
// Each `domainService Pricing { operation quote(...) {...} }` lowers to a
// stateless calculator class in `<base>.domain.services`:
//
//   public final class Pricing {
//       private Pricing() {
//       }
//       public static BigDecimal quote(Order order, Customer customer) { ... }
//   }
//
// This reuses the EXACT envelope the `<Agg>Criteria` emitter already ships
// (public final class + private ctor + public static factory methods) —
// the only difference is the method body, which renders through the shared
// Java statement/expression path (`renderJavaStatements` / `renderJavaExpr`)
// with `this` unbound: parameters resolve as bare locals (refKind `param`),
// there is no aggregate receiver.
//
// A `require`/`precondition` lowers to the same
// `if (!(...)) throw new DomainException(...)` shape every aggregate
// operation emits.  An `or`-union return (`money or CouponExpired`) reuses
// the shipped exception-less union machinery (`returnUnionSpec` +
// `renderJavaDomainUnionFiles`): the sealed interface + variant records are
// emitted into the same `domain.services` package, and the body's tagged
// `return` arm constructs `<Union>_<Tag>(…)` via `renderJavaStatements`
// when threaded the `returnUnion` context.
//
// A member call from anywhere (`Pricing.quote(order, customer)`) is rendered
// by `JAVA_TARGET`'s domain-service call leaf (render-expr.ts) →
// `Pricing.quote(...)`, so this emitter owns only the declaration side.
// ---------------------------------------------------------------------------

import type {
  DomainServiceIR,
  DomainServiceOperationIR,
  EnrichedBoundedContextIR,
  OperationIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst } from "../../../util/naming.js";
import type { UnionMember } from "../../_payload/union-wire.js";
import { collectJavaTypeImports, type JavaRenderContext, renderJavaType } from "../render-expr.js";
import { collectJavaStmtImports, renderJavaStatements } from "../render-stmt.js";
import { type JavaReturnUnionSpec, renderJavaDomainUnionFiles, returnUnionSpec } from "./unions.js";

export interface DomainServiceFile {
  name: string;
  content: string;
}

/** All domain-service files for one context: one calculator class per
 *  declared `domainService`, plus the sealed-union files any `or`-union
 *  return needs (emitted into the same `domain.services` package). */
export function renderJavaDomainServices(
  ctx: EnrichedBoundedContextIR,
  pkg: string,
  basePkg: string,
  /** Resolves the package an aggregate's entity class lives in — so a
   *  signature naming an aggregate (`quote(cart: Cart, …)`) imports it
   *  from its (byFeature) home package. */
  entityPkgOf: (aggName: string) => string,
): DomainServiceFile[] {
  if (ctx.domainServices.length === 0) return [];
  const aggNames = new Set(ctx.aggregates.map((a) => a.name));
  const out: DomainServiceFile[] = [];
  for (const svc of ctx.domainServices ?? []) {
    // Collect the distinct op-return unions of this service (keyed by name),
    // so the sealed interface + variant records are emitted once each.
    const unions = new Map<string, JavaReturnUnionSpec>();
    for (const op of svc.operations) {
      const spec = returnUnionSpec(op as unknown as OperationIR, ctx);
      if (spec && !unions.has(spec.name)) unions.set(spec.name, spec);
    }
    out.push({
      name: `${svc.name}.java`,
      content: renderService(svc, ctx, pkg, basePkg, unions, aggNames, entityPkgOf),
    });
    // Domain-side union files land in the same package (sealed `permits`
    // requires the interface + records co-locate).
    for (const spec of unions.values()) {
      for (const file of renderJavaDomainUnionFiles(spec, pkg, basePkg)) {
        out.push({ name: file.name, content: file.content });
      }
    }
  }
  return out;
}

function renderService(
  svc: DomainServiceIR,
  ctx: EnrichedBoundedContextIR,
  pkg: string,
  basePkg: string,
  unions: ReadonlyMap<string, JavaReturnUnionSpec>,
  aggNames: ReadonlySet<string>,
  entityPkgOf: (aggName: string) => string,
): string {
  const javaImports = new Set<string>();
  const methodBlocks = svc.operations.map((op) => renderOperation(op, ctx, unions, javaImports));
  // Drop a trailing blank line so the class closes cleanly.
  const body = methodBlocks.flat();
  while (body.length > 0 && body[body.length - 1] === "") body.pop();

  // Aggregate types named in any signature live in their own (byFeature)
  // package; import each one whose home differs from this services package.
  const sigAggs = new Set<string>();
  for (const op of svc.operations) {
    for (const p of op.params) collectAggNames(p.type, aggNames, sigAggs);
    if (op.returnType) collectAggNames(op.returnType, aggNames, sigAggs);
  }
  const aggImports = [...sigAggs]
    .map((a) => ({ a, pkg: entityPkgOf(a) }))
    .filter((e) => e.pkg !== pkg)
    .sort((x, y) => x.a.localeCompare(y.a))
    .map((e) => `import ${e.pkg}.${e.a};`);

  return lines(
    `package ${pkg};`,
    ``,
    ...[...javaImports].sort().map((i) => `import ${i};`),
    javaImports.size > 0 ? `` : null,
    `import ${basePkg}.domain.common.*;`,
    `import ${basePkg}.domain.enums.*;`,
    `import ${basePkg}.domain.ids.*;`,
    `import ${basePkg}.domain.valueobjects.*;`,
    ...aggImports,
    ``,
    `/** Stateless domain service — pure calculators (domain-services.md). */`,
    `public final class ${svc.name} {`,
    `    private ${svc.name}() {`,
    `    }`,
    ``,
    ...body,
    `}`,
    ``,
  );
}

function renderOperation(
  op: DomainServiceOperationIR,
  ctx: EnrichedBoundedContextIR,
  unions: ReadonlyMap<string, JavaReturnUnionSpec>,
  javaImports: Set<string>,
): string[] {
  for (const p of op.params) collectJavaTypeImports(p.type, javaImports);
  if (op.returnType) collectJavaTypeImports(op.returnType, javaImports);
  collectJavaStmtImports(op.body, javaImports);

  const spec = op.returnType ? unions.get(unionKeyOf(op, ctx)) : undefined;
  const renderCtx: JavaRenderContext = spec
    ? { thisName: "this", returnUnion: unionRenderCtx(spec) }
    : { thisName: "this" };

  const params = op.params.map((p) => `${renderJavaType(p.type)} ${p.name}`).join(", ");
  // A union return renders as the sealed interface type; a plain return as
  // the declared type; absent ⇒ void.
  const retType = op.returnType ? (spec ? spec.name : renderJavaType(op.returnType)) : "void";
  const bodyText = renderJavaStatements(op.body, renderCtx);
  return [
    `    public static ${retType} ${lowerFirst(op.name)}(${params}) {`,
    ...(bodyText.length > 0 ? [bodyText] : []),
    `    }`,
    ``,
  ];
}

/** The union name keyed in the per-service union map for this op (or "" when
 *  the op doesn't return a union). */
function unionKeyOf(op: DomainServiceOperationIR, ctx: EnrichedBoundedContextIR): string {
  const spec = returnUnionSpec(op as unknown as OperationIR, ctx);
  return spec ? spec.name : "";
}

/** The `{ name, members }` slice of a return-union spec the render context
 *  needs for tagged returns. */
function unionRenderCtx(spec: JavaReturnUnionSpec): { name: string; members: UnionMember[] } {
  return { name: spec.name, members: spec.members };
}

/** Collect aggregate-typed names reachable through a TypeIR (entity refs
 *  whose name is a declared aggregate of this context), so the service
 *  file imports each aggregate class it names in a signature. */
function collectAggNames(t: TypeIR, aggNames: ReadonlySet<string>, into: Set<string>): void {
  switch (t.kind) {
    case "entity":
      if (aggNames.has(t.name)) into.add(t.name);
      break;
    case "array":
      collectAggNames(t.element, aggNames, into);
      break;
    case "optional":
      collectAggNames(t.inner, aggNames, into);
      break;
    case "union":
      for (const v of t.variants) collectAggNames(v, aggNames, into);
      break;
    case "genericInstance":
      collectAggNames(t.arg, aggNames, into);
      break;
  }
}
