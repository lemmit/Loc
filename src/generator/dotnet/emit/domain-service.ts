// Domain-service emission (.NET / C#) — domain-services.md, v1 Shape A.
//
// Each `domainService Pricing { operation quote(...) {...} }` lowers to a
// constructor-less `public static class`:
//
//   public static class Pricing
//   {
//       public static decimal Quote(Cart cart, Customer customer) { ... }
//   }
//
// The ABSENCE of a constructor / repository injection IS the domain-layer
// guarantee made physical — a domain service can compute, never reach for
// infrastructure.  Operation bodies render through the shared C# statement /
// expression path (`renderCsStatements` / `renderCsExpr`): parameters resolve
// as bare locals (refKind `param`), there is no `this`.
//
// An `or`-union return reuses the EXACT exception-less union shape the
// aggregate operations emit: the Domain union record (`<Union>` +
// `<Union>_<Tag>(...)` variants, from `domainServiceUnionFiles`) plus a tagged
// `return` that constructs the right variant via the `returnUnion` render
// context — no new union machinery.  A member call from anywhere
// (`Pricing.Quote(cart, customer)`) is rendered by `CS_TARGET.domainServiceCall`
// (render-expr.ts).

import { unionInstanceName } from "../../../ir/stdlib/unions.js";
import type {
  BoundedContextIR,
  DomainServiceIR,
  DomainServiceOperationIR,
  EnrichedBoundedContextIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { plural, upperFirst } from "../../../util/naming.js";
import { type UnionMember, unionMembers } from "../../_payload/union-wire.js";
import { renderCsType } from "../render-expr.js";
import { collectCsStmtUsings, renderCsStatements } from "../render-stmt.js";

/** Emit `Domain/Services/<Name>.cs` per domain service in the context, plus
 *  the pure Domain union record files for any `or`-union operation returns. */
export function emitDomainServices(
  ctx: EnrichedBoundedContextIR,
  ns: string,
  out: Map<string, string>,
): void {
  for (const svc of ctx.domainServices ?? []) {
    out.set(`Domain/Services/${upperFirst(svc.name)}.cs`, renderDomainService(svc, ctx, ns));
    // Pure Domain union types for exception-less operation returns — Domain-layer
    // artifacts (the service method produces them), placed alongside the entity
    // unions under the aggregate folders.  See dotnet/cqrs/dtos.ts:domainUnionFiles
    // for the aggregate-operation twin (same record shape).
    for (const f of domainServiceUnionFiles(svc, ctx, ns)) out.set(f.name, f.content);
  }
}

function renderDomainService(
  svc: DomainServiceIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
): string {
  // Namespaces every operation body reaches into beyond the SDK implicit-usings
  // set, plus the Domain layers the signatures + variant records can name.
  const usings = new Set<string>([
    `${ns}.Domain.Common`,
    `${ns}.Domain.Enums`,
    `${ns}.Domain.ValueObjects`,
    `${ns}.Domain.Ids`,
    "System.Linq",
  ]);
  for (const op of svc.operations) collectCsStmtUsings(op.body, usings, ns);
  // Each aggregate class a signature / `or`-union variant names lives under its
  // own `Domain.<Plural>` namespace (e.g. `Cart` → `Api.Domain.Carts`), so the
  // service file imports those folders too — mirrors the criterion emitter's
  // `Domain.<plural(candidate)>` using.  Walks params + return types AND the
  // union variants (a record variant exposes an aggregate's wire fields).
  for (const op of svc.operations) {
    for (const p of op.params) addAggregateNamespaces(p.type, ctx, ns, usings);
    if (op.returnType) addAggregateNamespaces(op.returnType, ctx, ns, usings);
  }

  return lines(
    "// Auto-generated — domain service (domain-services.md). Stateless pure",
    "// calculators: no constructor, no repository injection.",
    ...[...usings].sort().map((u) => `using ${u};`),
    "",
    `namespace ${ns}.Domain.Services;`,
    "",
    `public static class ${upperFirst(svc.name)}`,
    "{",
    ...svc.operations.map((op) => renderOperation(op, ctx)),
    "}",
  );
}

/** Add the `Domain.<Plural>` namespace of every aggregate type reachable
 *  through `t` to `into` — so a signature / union variant naming an aggregate
 *  class resolves.  Only `entity` types that name an aggregate in this context
 *  contribute (value objects / enums / ids already have flat usings). */
function addAggregateNamespaces(
  t: TypeIR,
  ctx: BoundedContextIR,
  ns: string,
  into: Set<string>,
): void {
  switch (t.kind) {
    case "entity":
      if (ctx.aggregates.some((a) => a.name === t.name)) {
        into.add(`${ns}.Domain.${plural(t.name)}`);
      }
      break;
    case "array":
      addAggregateNamespaces(t.element, ctx, ns, into);
      break;
    case "optional":
      addAggregateNamespaces(t.inner, ctx, ns, into);
      break;
    case "union":
      for (const v of t.variants) addAggregateNamespaces(v, ctx, ns, into);
      break;
    case "genericInstance":
      addAggregateNamespaces(t.arg, ctx, ns, into);
      break;
  }
}

function renderOperation(op: DomainServiceOperationIR, ctx: BoundedContextIR): string {
  const params = op.params.map((p) => `${renderCsType(p.type)} ${p.name}`).join(", ");
  const retType = op.returnType ? renderCsType(op.returnType) : "void";
  // An `or`-union return threads the Domain union name + variant order so a
  // tagged `return { … }` constructs the right `<Union>_<Tag>(...)` record.
  const returnUnion =
    op.returnType?.kind === "union"
      ? {
          name: unionInstanceName(op.returnType.variants),
          members: unionMembers(op.returnType.variants, ctx) as UnionMember[],
        }
      : undefined;
  const body = renderCsStatements(
    op.body,
    returnUnion ? { thisName: "this", returnUnion } : { thisName: "this" },
  );
  return lines(
    `    public static ${retType} ${upperFirst(op.name)}(${params})`,
    "    {",
    body,
    "    }",
    "",
  );
}

/** Pure Domain union record files for a service's `or`-union operation returns.
 *  Mirrors `domainUnionFiles` (cqrs/dtos.ts) for aggregate operations: an
 *  abstract base record + one sealed variant record per arm, placed under the
 *  service's Domain folder.  No serialization attributes — Domain stays
 *  transport-agnostic; the controller maps a success variant before serializing. */
function domainServiceUnionFiles(
  svc: DomainServiceIR,
  ctx: EnrichedBoundedContextIR,
  ns: string,
): { name: string; content: string }[] {
  const files: { name: string; content: string }[] = [];
  const seen = new Set<string>();
  for (const op of svc.operations) {
    if (op.returnType?.kind !== "union") continue;
    const name = unionInstanceName(op.returnType.variants);
    if (seen.has(name)) continue;
    seen.add(name);
    files.push({
      name: `Domain/Services/${name}.cs`,
      content: renderDomainUnion(name, unionMembers(op.returnType.variants, ctx), ns),
    });
  }
  return files;
}

function renderDomainUnion(name: string, members: UnionMember[], ns: string): string {
  const memberParams = (m: UnionMember): string => {
    if (m.shape === "none") return "";
    if (m.shape === "scalar") return `${renderCsType(m.type)} Value`;
    return m.fields.map((f) => `${renderCsType(f.type)} ${upperFirst(f.name)}`).join(", ");
  };
  return lines(
    "// Auto-generated — domain-service union return (domain-services.md).",
    "using System;",
    "using System.Collections.Generic;",
    `using ${ns}.Domain.Enums;`,
    "",
    `namespace ${ns}.Domain.Services;`,
    "",
    `public abstract record ${name};`,
    "",
    ...members.map((m) => `public sealed record ${name}_${m.tag}(${memberParams(m)}) : ${name};`),
  );
}
