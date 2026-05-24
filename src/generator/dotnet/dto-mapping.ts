import { wireShapeFor } from "../../ir/enrichments.js";
import type {
  AggregateIR,
  BoundedContextIR,
  EntityPartIR,
  IdValueType,
  TypeIR,
  ValueObjectIR,
} from "../../ir/loom-ir.js";
import { upperFirst } from "../../util/naming.js";
import { renderCsType } from "./render-expr.js";

// ---------------------------------------------------------------------------
// Wire-shape DTO mapping helpers.
//
// These functions translate between the IR's domain types (with `X id`,
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
export function wireType(t: TypeIR, ctx: BoundedContextIR, dir: "request" | "response"): string {
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
      return `IReadOnlyList<${wireType(t.element, ctx, dir)}>`;
    case "optional":
      return `${wireType(t.inner, ctx, dir)}?`;
  }
}

/** Map a wire-shaped expression to a domain-typed argument for a command. */
export function wireToCommandArgument(
  expr: string,
  t: TypeIR,
  ctx: BoundedContextIR,
  usings?: Set<string>,
): string {
  switch (t.kind) {
    case "primitive":
      if (t.name === "datetime") {
        // Wire is a string; coerce to UTC DateTime regardless of whether
        // the caller sent a Z-suffixed value (most clients) or a naive
        // datetime-local string (browser <input type="datetime-local">).
        // CultureInfo + DateTimeStyles live in System.Globalization,
        // outside the SDK's implicit-usings set — record the dependency
        // so the file emitter adds the directive.
        usings?.add("System.Globalization");
        return `DateTime.Parse(${expr}, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal)`;
      }
      return expr;
    case "id":
      return `new ${t.targetName}Id(${expr})`;
    case "enum":
      return `Enum.Parse<${t.name}>(${expr})`;
    case "valueobject": {
      const vo = ctx.valueObjects.find((v) => v.name === t.name);
      if (!vo) return expr;
      const args = vo.fields
        .map((f) => wireToCommandArgument(`${expr}.${upperFirst(f.name)}`, f.type, ctx, usings))
        .join(", ");
      return `new ${t.name}(${args})`;
    }
    case "entity":
      return expr;
    case "array":
      return `${expr}.Select(__e => ${wireToCommandArgument("__e", t.element, ctx, usings)}).ToList()`;
    case "optional":
      return `(${expr} is null ? null : ${wireToCommandArgument(`${expr}!`, t.inner, ctx, usings)})`;
  }
}

/** Project a domain expression to its wire-shape Response. */
export function projectToResponse(domainExpr: string, t: TypeIR, ctx: BoundedContextIR): string {
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
        .map((f) => projectToResponse(`${domainExpr}.${upperFirst(f.name)}`, f.type, ctx))
        .join(", ");
      return `new ${t.name}Response(${args})`;
    }
    case "entity": {
      const part =
        ctx.aggregates
          .flatMap((a) => a.parts.map((p) => ({ part: p, agg: a })))
          .find((x) => x.part.name === t.name) ??
        ctx.aggregates.map((a) => ({ part: a, agg: a })).find((x) => x.part.name === t.name);
      if (!part) return domainExpr;
      return projectEntityExpr(domainExpr, part.part, ctx);
    }
    case "array":
      return `${domainExpr}.Select(__e => ${projectToResponse("__e", t.element, ctx)}).ToList()`;
    case "optional":
      // `is { } __v` pattern works for both nullable value types
      // (Nullable<T>, requires .Value to unwrap) and nullable reference
      // types — binds the unwrapped value so the inner recursion's
      // `.ToUniversalTime()` / `.Value` etc. type-check correctly.
      return `(${domainExpr} is { } __v ? ${projectToResponse("__v", t.inner, ctx)} : null)`;
  }
}

/** Convert a domain-typed expression to its wire-shape Request
 *  form.  Symmetric with `projectToResponse` (Id → `.Value`,
 *  enum → `.ToString()`, datetime → ISO string), but value-object
 *  fields wrap in `<VO>Request` rather than `<VO>Response` because
 *  they nest into request DTOs.  Used by extern dispatch (auto
 *  Mediator handler + workflow op-call) to construct an
 *  `<Op>Request` from the surrounding domain values. */
export function domainToRequestExpr(domainExpr: string, t: TypeIR, ctx: BoundedContextIR): string {
  switch (t.kind) {
    case "primitive":
      if (t.name === "datetime") {
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
        .map((f) => domainToRequestExpr(`${domainExpr}.${upperFirst(f.name)}`, f.type, ctx))
        .join(", ");
      return `new ${t.name}Request(${args})`;
    }
    case "entity":
      return domainExpr;
    case "array":
      return `${domainExpr}.Select(__e => ${domainToRequestExpr("__e", t.element, ctx)}).ToList()`;
    case "optional":
      // See projectToResponse — same pattern unwraps Nullable<T> for both
      // value and reference inner types.
      return `(${domainExpr} is { } __v ? ${domainToRequestExpr("__v", t.inner, ctx)} : null)`;
  }
}

export function projectEntityExpr(
  domainExpr: string,
  entity: AggregateIR | EntityPartIR,
  ctx: BoundedContextIR,
): string {
  // Single canonical walk — `entity.wireShape` is populated by
  // `enrichLoomModel` (src/ir/enrichments.ts).  Each wire field
  // maps to one positional argument on `new <Ent>Response(...)`,
  // in the same order both response Zod schemas (Hono / React)
  // emit.
  const fields = wireShapeFor(entity);
  const args: string[] = [];
  for (const wf of fields) {
    if (wf.source === "id") {
      args.push(`${domainExpr}.Id.Value`);
    } else if (wf.source === "containment") {
      const part = ctx.aggregates
        .flatMap((a) => a.parts)
        .find((p) => p.name === containmentPartName(wf.type));
      if (!part) continue;
      const accessor = `${domainExpr}.${upperFirst(wf.name)}`;
      args.push(
        wf.type.kind === "array"
          ? `${accessor}.Select(__e => ${projectEntityExpr("__e", part, ctx)}).ToList()`
          : projectEntityExpr(accessor, part, ctx),
      );
    } else {
      args.push(projectToResponse(`${domainExpr}.${upperFirst(wf.name)}`, wf.type, ctx));
    }
  }
  return `new ${entity.name}Response(${args.join(", ")})`;
}

export function aggregateResponseParams(agg: AggregateIR, ctx: BoundedContextIR): string {
  return responseRecordParams(agg, ctx);
}

export function entityResponseParams(part: EntityPartIR, ctx: BoundedContextIR): string {
  return responseRecordParams(part, ctx);
}

function responseRecordParams(ent: AggregateIR | EntityPartIR, ctx: BoundedContextIR): string {
  const fields = wireShapeFor(ent);
  const idValueType = isPart(ent) ? ent.parentIdValueType : ent.idValueType;
  const parts: string[] = [];
  for (const wf of fields) {
    if (wf.source === "id") {
      parts.push(`${csIdValueClrType(idValueType)} Id`);
    } else {
      parts.push(`${wireType(wf.type, ctx, "response")} ${upperFirst(wf.name)}`);
    }
  }
  return parts.join(", ");
}

function isPart(ent: AggregateIR | EntityPartIR): ent is EntityPartIR {
  // EntityPartIR carries `parentName`; AggregateIR doesn't.
  return "parentName" in ent;
}

function containmentPartName(t: TypeIR): string | undefined {
  if (t.kind === "entity") return t.name;
  if (t.kind === "array" && t.element.kind === "entity") return t.element.name;
  return undefined;
}

/** Set of value objects reachable from an aggregate's surface. */
export function valueObjectsUsedBy(agg: AggregateIR, ctx: BoundedContextIR): ValueObjectIR[] {
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
