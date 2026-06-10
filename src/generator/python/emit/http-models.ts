import type { BoundedContextIR, TypeIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";

// ---------------------------------------------------------------------------
// `app/http/wire_models.py` — one Pydantic model per value object,
// shared by request and response DTOs.  Field names are the wire keys
// verbatim (DSL camelCase): the generated DTO layer is wire-shaped, so
// no alias machinery — conversion to snake_case domain happens in the
// route handlers.  Class names are the VO names, so FastAPI's OpenAPI
// components match the other backends'.
// ---------------------------------------------------------------------------

/** Pydantic field type for one wire-side value (REQUEST direction —
 *  money stays Decimal so the domain receives precise values). */
export function requestPyType(t: TypeIR, ctx: BoundedContextIR): string {
  return wireFieldType(t, ctx, "request", "Model");
}

/** Pydantic field type for the RESPONSE direction — `to_wire` already
 *  converted datetimes to ISO strings and the JSON layer serializes
 *  money as a number, so the model types match the projected dict. */
export function responsePyType(t: TypeIR, ctx: BoundedContextIR): string {
  return wireFieldType(t, ctx, "response", "Model");
}

function wireFieldType(
  t: TypeIR,
  ctx: BoundedContextIR,
  dir: "request" | "response",
  voSuffix: string,
): string {
  switch (t.kind) {
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "int";
        case "decimal":
          return "float";
        case "money":
          return dir === "request" ? "Decimal" : "float";
        case "string":
        case "guid":
          return "str";
        case "bool":
          return "bool";
        case "datetime":
          return dir === "request" ? "datetime" : "str";
        case "json":
          return "object";
        default:
          return "str";
      }
    case "id":
      return "str";
    case "enum":
      return t.name;
    case "valueobject":
      // Wire models share one shape across directions; the request/
      // response difference only bites on top-level scalars (datetime /
      // money), which VOs carry as their declared field types — the
      // VO model uses the response spelling (plain JSON numbers /
      // parsed datetimes accept both directions via coercion).
      return `${t.name}${voSuffix}`;
    case "entity":
      return `${t.name}Response`;
    case "array":
      return `list[${wireFieldType(t.element, ctx, dir, voSuffix)}]`;
    case "optional":
      return `${wireFieldType(t.inner, ctx, dir, voSuffix)} | None`;
    default:
      return "object";
  }
}

export function renderPyWireModels(ctx: BoundedContextIR): string {
  const models = ctx.valueObjects.map((vo) =>
    lines(
      "",
      "",
      `class ${vo.name}(BaseModel):`,
      vo.fields.map((f) => `    ${f.name}: ${wireFieldType(f.type, ctx, "request", "")}`),
    ),
  );
  const body = models.join("");
  const uses = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(body);
  const enumNames = ctx.enums.map((e) => e.name).filter(uses);
  return lines(
    `"""Pydantic wire models for value objects.  Auto-generated."""`,
    "",
    uses("datetime") ? "from datetime import datetime" : null,
    uses("Decimal") ? "from decimal import Decimal" : null,
    uses("datetime") || uses("Decimal") ? "" : null,
    ctx.valueObjects.length > 0 ? "from pydantic import BaseModel" : null,
    enumNames.length > 0 ? "" : null,
    enumNames.length > 0 ? `from app.domain.value_objects import ${enumNames.join(", ")}` : null,
    ctx.valueObjects.length === 0 ? "\n__all__: list[str] = []" : body,
    "",
  );
}
