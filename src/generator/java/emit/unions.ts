import { unionInstanceName } from "../../../ir/stdlib/unions.js";
import type {
  EnrichedAggregateIR,
  EnrichedBoundedContextIR,
  OperationIR,
  TypeIR,
} from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { defaultErrorStatus, errorTitle, errorTypeUri } from "../../../util/error-defaults.js";
import { type UnionMember, unionMembers } from "../../_payload/union-wire.js";
import { collectJavaTypeImports, renderJavaType } from "../render-expr.js";
import { collectWireImports, domainToWire, wireJavaType } from "./wire.js";

// ---------------------------------------------------------------------------
// Exception-less operation returns (exception-less.md) — an operation
// declaring `: A or B` produces a tagged domain union instead of
// throwing.  Two emissions per distinct union:
//
//   - **Domain side** (entity package): a sealed interface plus one
//     public record per variant, domain-typed (`OrderId`, `BigDecimal`,
//     `Instant`) — the aggregate method constructs these (the
//     render-stmt tagged-return arm), so Domain stays transport-free.
//   - **Wire side** (response-dto package): `<U>Response` — a Jackson
//     polymorphic sealed interface (`type` discriminator, the pinned
//     cross-backend tag) with wire-typed variant records.
//
// The controller translates: error variants (an `error` payload among
// the variants) → RFC-7807 ProblemDetail at their mapped status;
// success variants → 200 with the wire record.  The service threads
// the domain union through unchanged (capture → save → return).
// ---------------------------------------------------------------------------

export interface JavaReturnUnionArm {
  tag: string;
  member: UnionMember;
  isError: boolean;
  status: number;
  title: string;
  typeUri: string;
}

export interface JavaReturnUnionSpec {
  /** Domain union name (`unionInstanceName`). */
  name: string;
  members: UnionMember[];
  arms: JavaReturnUnionArm[];
}

/** Distinct op-return unions of one aggregate, keyed by union name. */
export function aggregateReturnUnions(
  agg: EnrichedAggregateIR,
  ctx: EnrichedBoundedContextIR,
): Map<string, JavaReturnUnionSpec> {
  const out = new Map<string, JavaReturnUnionSpec>();
  for (const op of agg.operations) {
    const spec = returnUnionSpec(op, ctx);
    if (spec && !out.has(spec.name)) out.set(spec.name, spec);
  }
  return out;
}

/** The op's return-union translation spec, or undefined for void ops. */
export function returnUnionSpec(
  op: OperationIR,
  ctx: EnrichedBoundedContextIR,
): JavaReturnUnionSpec | undefined {
  if (op.returnType?.kind !== "union") return undefined;
  const variants = op.returnType.variants;
  const members = unionMembers(variants, ctx);
  const isError = (v: TypeIR): boolean =>
    v.kind === "entity" && ctx.payloads.some((p) => p.name === v.name && p.kind === "error");
  const arms = members.map((m, i) => ({
    tag: m.tag,
    member: m,
    isError: isError(variants[i]!),
    status: ctx.errorStatusOverrides?.[m.tag] ?? defaultErrorStatus(m.tag),
    title: errorTitle(m.tag),
    typeUri: errorTypeUri(m.tag),
  }));
  return { name: unionInstanceName(variants), members, arms };
}

export interface UnionFile {
  name: string;
  content: string;
}

/** Domain-side union files: the sealed interface + one record per
 *  variant, all in the entity package (sealed `permits` requires it). */
export function renderJavaDomainUnionFiles(
  spec: JavaReturnUnionSpec,
  pkg: string,
  basePkg: string,
): UnionFile[] {
  const variantNames = spec.members.map((m) => `${spec.name}_${m.tag}`);
  const files: UnionFile[] = [
    {
      name: `${spec.name}.java`,
      content: lines(
        `package ${pkg};`,
        ``,
        `/** Exception-less operation return — tagged domain union. */`,
        `public sealed interface ${spec.name} permits ${variantNames.join(", ")} {`,
        `}`,
        ``,
      ),
    },
  ];
  for (const m of spec.members) {
    const imports = new Set<string>();
    const params = memberDomainParams(m, imports);
    files.push({
      name: `${spec.name}_${m.tag}.java`,
      content: lines(
        `package ${pkg};`,
        ``,
        ...[...imports].sort().map((i) => `import ${i};`),
        imports.size > 0 ? `` : null,
        `import ${basePkg}.domain.enums.*;`,
        `import ${basePkg}.domain.ids.*;`,
        `import ${basePkg}.domain.valueobjects.*;`,
        ``,
        `public record ${spec.name}_${m.tag}(${params}) implements ${spec.name} {`,
        `}`,
        ``,
      ),
    });
  }
  return files;
}

/** Wire-side union files: the Jackson-polymorphic `<U>Response` sealed
 *  interface (the pinned `type` discriminator) + wire-typed records. */
export function renderJavaUnionWireFiles(
  spec: JavaReturnUnionSpec,
  pkg: string,
  basePkg: string,
): UnionFile[] {
  const variantNames = spec.members.map((m) => `${spec.name}Response_${m.tag}`);
  const files: UnionFile[] = [
    {
      name: `${spec.name}Response.java`,
      content: lines(
        `package ${pkg};`,
        ``,
        `import com.fasterxml.jackson.annotation.JsonSubTypes;`,
        `import com.fasterxml.jackson.annotation.JsonTypeInfo;`,
        ``,
        `@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")`,
        `@JsonSubTypes({`,
        ...spec.members.map(
          (m, i) =>
            `    @JsonSubTypes.Type(value = ${spec.name}Response_${m.tag}.class, name = "${m.tag}")${i < spec.members.length - 1 ? "," : ""}`,
        ),
        `})`,
        `public sealed interface ${spec.name}Response permits ${variantNames.join(", ")} {`,
        `}`,
        ``,
      ),
    },
  ];
  for (const m of spec.members) {
    const imports = new Set<string>();
    const params = memberWireParams(m, imports);
    files.push({
      name: `${spec.name}Response_${m.tag}.java`,
      content: lines(
        `package ${pkg};`,
        ``,
        ...[...imports].sort().map((i) => `import ${i};`),
        imports.size > 0 ? `` : null,
        `import ${basePkg}.domain.enums.*;`,
        ``,
        `public record ${spec.name}Response_${m.tag}(${params}) implements ${spec.name}Response {`,
        `}`,
        ``,
      ),
    });
  }
  return files;
}

/** The controller's domain-variant → wire-record constructor args
 *  (`v` is the bound domain variant). */
export function unionWireCtorArgs(m: UnionMember): string[] {
  if (m.shape === "none") return [];
  if (m.shape === "scalar") return [domainToWire(m.type, "v.value()")];
  return m.fields.map((f) => domainToWire(eff(f.type, f.optional), `v.${f.name}()`));
}

function memberDomainParams(m: UnionMember, imports: Set<string>): string {
  if (m.shape === "none") return "";
  if (m.shape === "scalar") {
    collectJavaTypeImports(m.type, imports);
    return `${renderJavaType(m.type)} value`;
  }
  return m.fields
    .map((f) => {
      collectJavaTypeImports(f.type, imports);
      return `${renderJavaType(f.type)} ${f.name}`;
    })
    .join(", ");
}

function memberWireParams(m: UnionMember, imports: Set<string>): string {
  if (m.shape === "none") return "";
  if (m.shape === "scalar") {
    collectWireImports(m.type, imports);
    return `${wireJavaType(m.type, "Response")} value`;
  }
  return m.fields
    .map((f) => {
      const t = eff(f.type, f.optional);
      collectWireImports(t, imports);
      return `${wireJavaType(t, "Response")} ${f.name}`;
    })
    .join(", ");
}

const eff = (t: TypeIR, optional: boolean): TypeIR =>
  optional && t.kind !== "optional" ? { kind: "optional", inner: t } : t;
