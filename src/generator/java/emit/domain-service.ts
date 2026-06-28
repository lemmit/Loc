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
//
// READING tier (domain-services.md rev. 4, Slice 1) — a service whose body runs
// read-only repository queries (`Accounts.byHolder(holder)`, lowered to a
// `repo-read` Call).  On Java the idiom is a SPRING BEAN, not a static utility:
//
//   @Service
//   public class Registration {
//       private final AccountRepository accountsRepository;
//       public Registration(AccountRepository accountsRepository) {
//           this.accountsRepository = accountsRepository;
//       }
//       @Transactional(readOnly = true)
//       public boolean isEmailAvailable(String holder) {
//           return accountsRepository.byHolder(holder) == null;
//       }
//   }
//
// One constructor-injected `<Aggregate>Repository` per DISTINCT read-port the
// service's operations consume (derived, not stamped, by `readPortsForOperation`
// — the SAME derivation the orchestrating workflow uses to wire the handle).
// The read methods become INSTANCE methods carrying `@Transactional(readOnly =
// true)`, and the `repo-read` arm renders against the injected field.  A PURE
// service (zero read-ports across all its ops) stays the static utility class —
// BYTE-IDENTICAL to the pre-rev.4 shell, no `@Service`, no ctor.
// ---------------------------------------------------------------------------

import type {
  DomainServiceIR,
  DomainServiceOperationIR,
  EnrichedBoundedContextIR,
  OperationIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { readPortsForOperation } from "../../../ir/util/domain-service-read-ports.js";
import { lines } from "../../../util/code-builder.js";
import { lowerFirst } from "../../../util/naming.js";
import type { UnionMember } from "../../_payload/union-wire.js";
import {
  collectJavaTypeImports,
  type JavaRenderContext,
  javaRepoField,
  renderJavaType,
} from "../render-expr.js";
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
  /** Resolves the package an aggregate's repository INTERFACE lives in — a
   *  `reading`-tier service (domain-services.md rev. 4) is a `@Service` bean
   *  with one injected `<Aggregate>Repository`, imported from that package.
   *  Optional so legacy single-context callers (only pure services) need not
   *  thread it. */
  repoPkgOf?: (aggName: string) => string,
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
      content: serviceIsReading(svc)
        ? renderReadingService(svc, ctx, pkg, basePkg, unions, aggNames, entityPkgOf, repoPkgOf)
        : renderService(svc, ctx, pkg, basePkg, unions, aggNames, entityPkgOf),
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

/** True when a service has at least one `reading`-tier operation (an op whose
 *  body runs a read-only repository query → at least one read-port).  Derived,
 *  not stamped — the same tier test the workflow call site uses. */
function serviceIsReading(svc: DomainServiceIR): boolean {
  return svc.operations.some((op) => readPortsForOperation(op).length > 0);
}

/** A `reading`-tier service (domain-services.md rev. 4, Slice 1) → a Spring
 *  `@Service` bean with constructor-injected `<Aggregate>Repository`s (one per
 *  distinct read-port across its ops) and INSTANCE methods.  The read methods
 *  carry `@Transactional(readOnly = true)`; the body's `repo-read` arms render
 *  against the injected fields.  This is the read-side analogue of the workflow
 *  `@Service` — same repo field names (`javaRepoField`), same DI shape. */
function renderReadingService(
  svc: DomainServiceIR,
  ctx: EnrichedBoundedContextIR,
  pkg: string,
  basePkg: string,
  unions: ReadonlyMap<string, JavaReturnUnionSpec>,
  aggNames: ReadonlySet<string>,
  entityPkgOf: (aggName: string) => string,
  repoPkgOf?: (aggName: string) => string,
): string {
  const javaImports = new Set<string>();
  const methodBlocks = svc.operations.map((op) =>
    renderReadingOperation(op, ctx, unions, javaImports),
  );
  const body = methodBlocks.flat();
  while (body.length > 0 && body[body.length - 1] === "") body.pop();

  // Aggregate types named in any signature (imported as a record type).
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

  // One injected repository per DISTINCT read-port aggregate (first-read order,
  // deduped) — drives the fields, the ctor, and the repository-interface
  // imports.  Sorted by aggregate for stable output.
  const readAggs = [...new Set(distinctReadAggregates(svc))].sort();
  const repoImports = readAggs
    .map((a) => ({ a, pkg: repoPkgOf?.(a) }))
    .filter((e): e is { a: string; pkg: string } => !!e.pkg && e.pkg !== pkg)
    .map((e) => `import ${e.pkg}.${e.a}Repository;`);

  const ctorParams = readAggs.map((a) => `${a}Repository ${javaRepoField(a)}`).join(", ");

  return lines(
    `package ${pkg};`,
    ``,
    ...[...javaImports].sort().map((i) => `import ${i};`),
    javaImports.size > 0 ? `` : null,
    `import org.springframework.stereotype.Service;`,
    `import org.springframework.transaction.annotation.Transactional;`,
    ``,
    ...[...repoImports].sort(),
    repoImports.length > 0 ? `` : null,
    `import ${basePkg}.domain.common.*;`,
    `import ${basePkg}.domain.enums.*;`,
    `import ${basePkg}.domain.ids.*;`,
    `import ${basePkg}.domain.valueobjects.*;`,
    ...aggImports,
    ``,
    `/** Reading-tier domain service — read-only repository orchestration`,
    ` *  (domain-services.md rev. 4). */`,
    `@Service`,
    `public class ${svc.name} {`,
    ...readAggs.map((a) => `    private final ${a}Repository ${javaRepoField(a)};`),
    ``,
    `    public ${svc.name}(${ctorParams}) {`,
    ...readAggs.map((a) => `        this.${javaRepoField(a)} = ${javaRepoField(a)};`),
    `    }`,
    ``,
    ...body,
    `}`,
    ``,
  );
}

/** Render one operation of a `reading`-tier service as an INSTANCE method
 *  carrying `@Transactional(readOnly = true)` (a reading op runs repo reads; a
 *  pure op sharing the bean stays a plain instance method, no annotation). */
function renderReadingOperation(
  op: DomainServiceOperationIR,
  ctx: EnrichedBoundedContextIR,
  unions: ReadonlyMap<string, JavaReturnUnionSpec>,
  javaImports: Set<string>,
): string[] {
  for (const p of op.params) collectJavaTypeImports(p.type, javaImports);
  if (op.returnType) collectJavaTypeImports(op.returnType, javaImports);
  collectJavaStmtImports(op.body, javaImports);

  const spec = op.returnType ? unions.get(unionKeyOf(op, ctx)) : undefined;
  // `serviceReading` lets a nested service-to-service call (a reading op calling
  // another) render as an instance call; within a single service the body only
  // reads repos, so this is a self-true predicate over this context's services.
  const renderCtx: JavaRenderContext = {
    thisName: "this",
    serviceReading: (service, calledOp) => {
      const s = ctx.domainServices.find((x) => x.name === service);
      const o = s?.operations.find((x) => x.name === calledOp);
      return o ? readPortsForOperation(o).length > 0 : false;
    },
    ...(spec ? { returnUnion: unionRenderCtx(spec) } : {}),
  };

  const params = op.params.map((p) => `${renderJavaType(p.type)} ${p.name}`).join(", ");
  const retType = op.returnType ? (spec ? spec.name : renderJavaType(op.returnType)) : "void";
  const bodyText = renderJavaStatements(op.body, renderCtx);
  const reading = readPortsForOperation(op).length > 0;
  return [
    ...(reading ? [`    @Transactional(readOnly = true)`] : []),
    `    public ${retType} ${lowerFirst(op.name)}(${params}) {`,
    ...(bodyText.length > 0 ? [bodyText] : []),
    `    }`,
    ``,
  ];
}

/** The aggregates a service's ops read, in first-read order across all ops
 *  (deduped) — one injected repository per entry. */
function distinctReadAggregates(svc: DomainServiceIR): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const op of svc.operations) {
    for (const p of readPortsForOperation(op)) {
      if (!seen.has(p.aggregate)) {
        seen.add(p.aggregate);
        order.push(p.aggregate);
      }
    }
  }
  return order;
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
