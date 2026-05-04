import type {
  AggregateIR,
  BoundedContextIR,
  EntityPartIR,
  IdValueType,
  TypeIR,
  ValueObjectIR,
} from "../../ir/loom-ir.js";
import { pascal } from "../../util/naming.js";
import { renderCsType } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Wire-shape DTO mapping helpers.
//
// These functions translate between the IR's domain types (with `Id<X>`,
// value objects, enums) and the wire-shape primitive types used in
// Request / Response DTOs.  Two directions:
//
//   - `wireType(t, ctx, "request" | "response")` — the C# type that
//     should appear on a DTO record property.
//   - `wireToCommandArgument(expr, t, ctx)` — given a wire-shaped C#
//     expression, build the domain-typed argument expression for a
//     Command's constructor.
//   - `projectToResponse(expr, t, ctx)` — given a domain expression,
//     project to its wire-shape Response counterpart.
//   - `projectEntityExpr(expr, entity, ctx)` — full entity → Response
//     projection (used by query handlers).
// ---------------------------------------------------------------------------

/**
 * What a type looks like in JSON / on the wire (primitives only).
 * `dir` selects the suffix for nested DTOs: `Request` for inputs,
 * `Response` for outputs.
 */
export function wireType(
  t: TypeIR,
  ctx: BoundedContextIR,
  dir: "request" | "response",
): string {
  void ctx;
  switch (t.kind) {
    case "primitive":
      // Datetime crosses the wire as an ISO string on both backends so
      // the cross-platform JSON contract stays symmetric and clients
      // don't have to care which platform served the response.  The
      // command-argument helpers below parse / format around this.
      if (t.name === "datetime") return "string";
      return renderCsType(t);
    case "id":
      return csIdValueClrType("guid");
    case "enum":
      return "string";
    case "valueobject":
      return `${t.name}${dir === "request" ? "Request" : "Response"}`;
    case "entity":
      return `${t.name}Response`;
    case "array":
      return `System.Collections.Generic.IReadOnlyList<${wireType(t.element, ctx, dir)}>`;
    case "optional":
      return `${wireType(t.inner, ctx, dir)}?`;
  }
}

/** Map a wire-shaped expression to a domain-typed argument for a command. */
export function wireToCommandArgument(
  expr: string,
  t: TypeIR,
  ctx: BoundedContextIR,
): string {
  switch (t.kind) {
    case "primitive":
      if (t.name === "datetime") {
        // Wire is a string; coerce to UTC DateTime regardless of whether
        // the caller sent a Z-suffixed value (most clients) or a naive
        // datetime-local string (browser <input type="datetime-local">).
        return `System.DateTime.Parse(${expr}, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal)`;
      }
      return expr;
    case "id":
      return `new ${t.targetName}Id(${expr})`;
    case "enum":
      return `System.Enum.Parse<${t.name}>(${expr})`;
    case "valueobject": {
      const vo = ctx.valueObjects.find((v) => v.name === t.name);
      if (!vo) return expr;
      const args = vo.fields
        .map((f) =>
          wireToCommandArgument(`${expr}.${pascal(f.name)}`, f.type, ctx),
        )
        .join(", ");
      return `new ${t.name}(${args})`;
    }
    case "entity":
      return expr;
    case "array":
      return `${expr}.Select(__e => ${wireToCommandArgument("__e", t.element, ctx)}).ToList()`;
    case "optional":
      return `(${expr} is null ? null : ${wireToCommandArgument(`${expr}!`, t.inner, ctx)})`;
  }
}

/** Project a domain expression to its wire-shape Response. */
export function projectToResponse(
  domainExpr: string,
  t: TypeIR,
  ctx: BoundedContextIR,
): string {
  switch (t.kind) {
    case "primitive":
      if (t.name === "datetime") {
        // Round-trip ISO 8601 with Z suffix — matches the Hono wire so
        // clients see one shape regardless of which backend served them.
        return `${domainExpr}.ToUniversalTime().ToString("o")`;
      }
      return domainExpr;
    case "id":
      return `${domainExpr}.Value`;
    case "enum":
      return `${domainExpr}.ToString()`;
    case "valueobject": {
      const vo = ctx.valueObjects.find((v) => v.name === t.name);
      if (!vo) return domainExpr;
      const args = vo.fields
        .map((f) =>
          projectToResponse(`${domainExpr}.${pascal(f.name)}`, f.type, ctx),
        )
        .join(", ");
      return `new ${t.name}Response(${args})`;
    }
    case "entity": {
      const part =
        ctx.aggregates
          .flatMap((a) => a.parts.map((p) => ({ part: p, agg: a })))
          .find((x) => x.part.name === t.name) ??
        ctx.aggregates
          .map((a) => ({ part: a, agg: a }))
          .find((x) => x.part.name === t.name);
      if (!part) return domainExpr;
      return projectEntityExpr(domainExpr, part.part, ctx);
    }
    case "array":
      return `${domainExpr}.Select(__e => ${projectToResponse("__e", t.element, ctx)}).ToList()`;
    case "optional":
      return `(${domainExpr} is null ? null : ${projectToResponse(domainExpr, t.inner, ctx)})`;
  }
}

export function projectEntityExpr(
  domainExpr: string,
  entity: AggregateIR | EntityPartIR,
  ctx: BoundedContextIR,
): string {
  const parts = [`${domainExpr}.Id.Value`];
  for (const f of entity.fields) {
    parts.push(projectToResponse(`${domainExpr}.${pascal(f.name)}`, f.type, ctx));
  }
  for (const c of entity.contains) {
    const part = ctx.aggregates
      .flatMap((a) => a.parts)
      .find((p) => p.name === c.partName);
    if (!part) continue;
    if (c.collection) {
      parts.push(
        `${domainExpr}.${pascal(c.name)}.Select(__e => ${projectEntityExpr("__e", part, ctx)}).ToList()`,
      );
    } else {
      parts.push(projectEntityExpr(`${domainExpr}.${pascal(c.name)}`, part, ctx));
    }
  }
  for (const d of entity.derived) {
    parts.push(projectToResponse(`${domainExpr}.${pascal(d.name)}`, d.type, ctx));
  }
  return `new ${entity.name}Response(${parts.join(", ")})`;
}

export function aggregateResponseParams(
  agg: AggregateIR,
  ctx: BoundedContextIR,
): string {
  const parts: string[] = [];
  parts.push(`${csIdValueClrType(agg.idValueType)} Id`);
  for (const f of agg.fields) {
    parts.push(`${wireType(f.type, ctx, "response")} ${pascal(f.name)}`);
  }
  for (const c of agg.contains) {
    parts.push(
      `${
        c.collection
          ? `System.Collections.Generic.IReadOnlyList<${c.partName}Response>`
          : `${c.partName}Response`
      } ${pascal(c.name)}`,
    );
  }
  for (const d of agg.derived) {
    parts.push(`${wireType(d.type, ctx, "response")} ${pascal(d.name)}`);
  }
  return parts.join(", ");
}

export function entityResponseParams(
  part: EntityPartIR,
  ctx: BoundedContextIR,
): string {
  const parts: string[] = [];
  parts.push(`${csIdValueClrType(part.parentIdValueType)} Id`);
  for (const f of part.fields) {
    parts.push(`${wireType(f.type, ctx, "response")} ${pascal(f.name)}`);
  }
  for (const c of part.contains) {
    parts.push(
      `${
        c.collection
          ? `System.Collections.Generic.IReadOnlyList<${c.partName}Response>`
          : `${c.partName}Response`
      } ${pascal(c.name)}`,
    );
  }
  for (const d of part.derived) {
    parts.push(`${wireType(d.type, ctx, "response")} ${pascal(d.name)}`);
  }
  return parts.join(", ");
}

/** Set of value objects reachable from an aggregate's surface. */
export function valueObjectsUsedBy(
  agg: AggregateIR,
  ctx: BoundedContextIR,
): ValueObjectIR[] {
  const used = new Set<string>();
  const visit = (t: TypeIR) => {
    if (t.kind === "valueobject") used.add(t.name);
    if (t.kind === "array") visit(t.element);
    if (t.kind === "optional") visit(t.inner);
  };
  for (const f of agg.fields) visit(f.type);
  for (const d of agg.derived) visit(d.type);
  for (const op of agg.operations) for (const p of op.params) visit(p.type);
  for (const part of agg.parts) {
    for (const f of part.fields) visit(f.type);
    for (const d of part.derived) visit(d.type);
  }
  return ctx.valueObjects.filter((v) => used.has(v.name));
}

export function csIdValueClrType(idValueType: IdValueType): string {
  switch (idValueType) {
    case "int":
      return "int";
    case "long":
      return "long";
    case "string":
      return "string";
    default:
      return "Guid";
  }
}
