import type { AggregateIR, BoundedContextIR, TypeIR } from "../../ir/types/loom-ir.js";
import { lowerFirst, upperFirst } from "../../util/naming.js";

// ---------------------------------------------------------------------------
// Per-aggregate extern handler registry.
//
// For every aggregate that declares at least one `operation X(...) extern`
// we emit `domain/<aggName>-extern.ts`, which exposes:
//
//   - a typed `externHandlers` registry holding one slot per extern op,
//   - a `register<Op><Agg>Handler(fn)` helper per op,
//   - a `verify<Agg>ExternHandlersRegistered()` startup gate that throws
//     if any slot is still null.
//
// The user calls `register*Handler(...)` from their own code (typically
// during app bootstrap, before `app.listen()`).  The auto Hono route
// looks up the handler from `externHandlers` and dispatches.
// ---------------------------------------------------------------------------

export function buildExternHandlersFile(agg: AggregateIR, ctx: BoundedContextIR): string {
  const externOps = agg.operations.filter((o) => o.extern);
  if (externOps.length === 0) return "";
  const usedVOs = collectVOs(externOps, ctx);

  // Whether any extern op's request shape carries a money parameter
  // — gates the per-file `import Decimal from "decimal.js";` so the
  // generated `<Op><Agg>Request` interface can reference `Decimal`.
  const externUsesMoney = externOps.some((op) =>
    op.params.some((p) => typeRefMentionsMoney(p.type)),
  );

  const lines: string[] = [];
  lines.push("// Auto-generated.  Do not edit by hand.");
  if (externUsesMoney) {
    lines.push(`import Decimal from "decimal.js";`);
  }
  lines.push(`import type { ${agg.name} } from "./${lowerFirst(agg.name)}";`);
  if (usedVOs.length > 0) {
    lines.push(`import type { ${usedVOs.join(", ")} } from "./value-objects";`);
  }
  // Re-export so user-supplied handler code can throw the same
  // typed error the framework wrap would synthesise — useful for
  // user code that wants to attribute a downstream failure to a
  // specific extern without losing the framework envelope.
  lines.push(`export { ExternHandlerError } from "./errors";`);
  lines.push("");

  // Per-op request type matching the wire body shape.  The runtime
  // body comes off `c.req.valid("json")` already coerced by the route's
  // Zod schema (decimals → number, datetimes → Date, ids → string).
  for (const op of externOps) {
    if (op.params.length === 0) {
      lines.push(`export type ${upperFirst(op.name)}${agg.name}Request = Record<string, never>;`);
      continue;
    }
    lines.push(`export interface ${upperFirst(op.name)}${agg.name}Request {`);
    for (const p of op.params) {
      lines.push(`  ${p.name}: ${wireTsType(p.type)};`);
    }
    lines.push("}");
  }
  lines.push("");

  for (const op of externOps) {
    lines.push(
      `export type ${upperFirst(op.name)}${agg.name}Handler = (aggregate: ${agg.name}, request: ${upperFirst(op.name)}${agg.name}Request) => Promise<void>;`,
    );
  }
  lines.push("");

  lines.push("interface ExternHandlerRegistry {");
  for (const op of externOps) {
    lines.push(
      `  ${lowerFirst(op.name)}${agg.name}: ${upperFirst(op.name)}${agg.name}Handler | null;`,
    );
  }
  lines.push("}");
  lines.push("");

  lines.push("export const externHandlers: ExternHandlerRegistry = {");
  for (const op of externOps) {
    lines.push(`  ${lowerFirst(op.name)}${agg.name}: null,`);
  }
  lines.push("};");
  lines.push("");

  for (const op of externOps) {
    lines.push(
      `export function register${upperFirst(op.name)}${agg.name}Handler(fn: ${upperFirst(op.name)}${agg.name}Handler): void {`,
    );
    lines.push(`  externHandlers.${lowerFirst(op.name)}${agg.name} = fn;`);
    lines.push("}");
  }
  lines.push("");

  lines.push(`export function verify${agg.name}ExternHandlersRegistered(): void {`);
  for (const op of externOps) {
    lines.push(`  if (externHandlers.${lowerFirst(op.name)}${agg.name} === null) {`);
    lines.push(
      `    throw new Error("Missing extern handler for '${op.name}' on aggregate '${agg.name}'. Call register${upperFirst(op.name)}${agg.name}Handler(...) before app.listen().");`,
    );
    lines.push("  }");
  }
  lines.push("}");
  lines.push("");

  // Dev-stub registrations — accept any request as a no-op so a generated
  // stack boots end-to-end without the caller having to wire real handlers
  // first.  Runs at module load (before createApp/verify); call
  // register<Op><Agg>Handler(...) AFTER importing this module to override
  // for production.  The framework still runs preconditions + invariants
  // around the call, so the stub's empty body is safe for parity tests.
  for (const op of externOps) {
    lines.push(
      `register${upperFirst(op.name)}${agg.name}Handler(async () => { /* dev-stub: replace via register${upperFirst(op.name)}${agg.name}Handler(...) */ });`,
    );
  }

  return lines.join("\n") + "\n";
}

/** Names of aggregates with at least one extern op. */
export function aggregatesWithExtern(ctx: BoundedContextIR): AggregateIR[] {
  return ctx.aggregates.filter((a) => a.operations.some((o) => o.extern));
}

// Wire-side TS type for an extern operation parameter.  Mirrors how the
// route's Zod schema parses each kind: `X id` and `string`/`guid` come
// off the wire as `string`; `int`/`long`/`decimal` as `number`;
// `datetime` as `Date` (Zod `z.coerce.date()`); enums as their union;
// value objects as the runtime class instance type.
function wireTsType(t: TypeIR): string {
  switch (t.kind) {
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: inner switch on the primitive name union is exhaustive (every arm returns)
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
        case "decimal":
          return "number";
        case "money":
          return "Decimal";
        case "string":
        case "guid":
          return "string";
        case "bool":
          return "boolean";
        case "datetime":
          return "Date";
        case "json":
          return "unknown";
        case "duration":
          // A5: expression-only primitive — never an extern wire param.
          throw new Error("internal: 'duration' is expression-only and never reaches the wire");
      }
    case "id":
      return "string";
    case "enum":
      return t.name;
    case "valueobject":
      return t.name;
    case "entity":
      return "unknown";
    case "array":
      return `${wireTsType(t.element)}[]`;
    case "optional":
      return `${wireTsType(t.inner)} | null`;
    case "action":
    case "slot":
      throw new Error(
        "wireTsType: 'slot' type is UI-only and should not appear on an extern operation parameter.",
      );
    case "genericInstance":
      throw new Error(
        `wireTsType: generic carrier '${t.ctor}' is not emittable yet (P3b); IR-validate should have rejected it.`,
      );
    case "union":
    case "none":
      throw new Error(
        `wireTsType: discriminated unions are not emittable yet (P4); IR-validate should have rejected '${t.kind}'.`,
      );
  }
}

function typeRefMentionsMoney(t: TypeIR): boolean {
  if (t.kind === "primitive") return t.name === "money";
  if (t.kind === "array") return typeRefMentionsMoney(t.element);
  if (t.kind === "optional") return typeRefMentionsMoney(t.inner);
  return false;
}

function collectVOs(ops: AggregateIR["operations"], ctx: BoundedContextIR): string[] {
  const names = new Set<string>();
  const knownVO = new Set(ctx.valueObjects.map((v) => v.name));
  const knownEnum = new Set(ctx.enums.map((e) => e.name));
  const visit = (t: TypeIR): void => {
    if (t.kind === "valueobject" && knownVO.has(t.name)) names.add(t.name);
    else if (t.kind === "enum" && knownEnum.has(t.name)) names.add(t.name);
    else if (t.kind === "array") visit(t.element);
    else if (t.kind === "optional") visit(t.inner);
  };
  for (const op of ops) for (const p of op.params) visit(p.type);
  return Array.from(names);
}
