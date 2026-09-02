import type { BoundedContextIR, TypeIR } from "../../../ir/types/loom-ir.js";
import { lines } from "../../../util/code-builder.js";
import { provenancedTypeMembers } from "../../_payload/provenanced-wire.js";
import {
  createFieldConstraints,
  createModelValidator,
  withFieldConstraint,
} from "./wire-constraints.js";

// ---------------------------------------------------------------------------
// `app/http/wire_models.py` — one Pydantic model per value object,
// shared by request and response DTOs.  Field names are the wire keys
// verbatim (DSL camelCase): the generated DTO layer is wire-shaped, so
// no alias machinery — conversion to snake_case domain happens in the
// route handlers.  Class names are the VO names, so FastAPI's OpenAPI
// components match the other backends'.
// ---------------------------------------------------------------------------

/** Name of the shared uuid-constrained string alias emitted into
 *  `app/http/wire_models.py`.  Referenced by every request-side reference
 *  (`X id`) annotation — request DTO fields, find query parameters and
 *  explicit-handler parameters alike — so the constraint and the published
 *  `format: uuid` are declared in exactly one place. */
export const PY_UUID_STR = "UuidStr";

/** Python source of the `UuidStr` alias.  `StringConstraints` supplies the
 *  VALIDATION (a failed pattern is an ordinary pydantic error, so FastAPI
 *  answers its standard 422 — the same envelope every other bad field gets),
 *  `WithJsonSchema` supplies the published SCHEMA (`{type: string, format:
 *  uuid}`) instead of the `pattern` pydantic would otherwise emit, so the
 *  spec reads identically to the other four backends'. */
const PY_UUID_STR_DEF = [
  `${PY_UUID_STR} = Annotated[`,
  "    str,",
  '    StringConstraints(pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),',
  '    WithJsonSchema({"type": "string", "format": "uuid"}),',
  "]",
];

/** The `from app.http.wire_models import …` line a routes-shaped module needs:
 *  its aliased value-object models plus `UuidStr` when the module annotates a
 *  reference-typed request field.  One import line (ruff F401 forbids the
 *  unused half, so both sides stay demand-driven). */
export function wireModelImport(
  voModelNames: readonly string[],
  refersTo: (n: string) => boolean,
): string | null {
  const names = [
    ...voModelNames.map((n) => `${n} as ${n}Model`),
    // The `Provenanced[T]` wire carrier, when this module annotates a
    // provenanced response field (M-T6.12).
    ...(refersTo(PY_PROVENANCED) ? [PY_PROVENANCED] : []),
    ...(refersTo(PY_UUID_STR) ? [PY_UUID_STR] : []),
  ];
  return names.length > 0 ? `from app.http.wire_models import ${names.join(", ")}` : null;
}

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
          // Money crosses the wire as its canonical decimal STRING in both
          // directions on every backend (Hono/.NET/Java/Phoenix) — the route
          // handler re-parses it into Decimal for the domain
          // (`pyWireToDomain`), and `to_wire` stringifies on the way out.
          return "str";
        case "string":
        case "guid":
          return "str";
        case "bool":
          return "bool";
        case "datetime":
          return dir === "request" ? "datetime" : "str";
        case "json":
          return "object";
        case "File":
          // A `File` field crosses the wire as the shared `FileRef`
          // ({url,key,contentType,size}) on every other backend — .NET's
          // `FileRef` record, java's `FileRef`, hono's zod object. Python fell
          // through to the `str` default below, so the DTO was typed `str`
          // while the DOMAIN attribute is `FileRef`: `mypy --strict` rejected
          // the handoff (`Argument "doc" … has incompatible type "str"`), and
          // the published schema said `string` where the other four said
          // object. No corpus fixture declared a `File` field until
          // `file-download.ddd` (M-T6.39), so no compile tier ever saw it.
          return "FileRef";
        default:
          return "str";
      }
    case "id":
      // A REFERENCE (`Customer id`) is a uuid on the wire and a `UUID` column
      // in Postgres.  A bare `str` let a non-uuid reach asyncpg, whose
      // `invalid input syntax for type uuid` escaped as a 500 (schemathesis
      // F2, and F3 through the query string — find parameters are annotated by
      // this same function).  `UuidStr` constrains the string AND publishes
      // `format: uuid`, so the answer is FastAPI's standard 422 and the spec
      // matches .NET's `Guid` / Java's `UUID` / Phoenix's `format: :uuid`.
      //
      // RESPONSE stays a bare `str`: the constraint is an INPUT gate, and the
      // response models are also fed by `to_wire` (which already yields the
      // stored uuid), so re-validating outbound buys nothing.
      return t.valueType === "guid" && dir === "request" ? PY_UUID_STR : "str";
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
    case "genericInstance":
      // `Provenanced[int]` (M-T6.12) — the value + lineage wire carrier as a
      // real generic model, NOT the `object` the default arm below would have
      // silently produced: a freeform `object` would erase the value's type
      // from the published OpenAPI schema, which is exactly the divergence the
      // carrier exists to remove.
      if (t.ctor === "provenanced") {
        return `${PY_PROVENANCED}[${wireFieldType(t.arg, ctx, dir, voSuffix)}]`;
      }
      return "object";
    default:
      return "object";
  }
}

/** The generic wire-carrier model's Python name. */
export const PY_PROVENANCED = "Provenanced";
/** The carrier model's type variable. */
const PY_PROV_TYPEVAR = "_ProvT";

/** `class Provenanced(BaseModel, Generic[_ProvT])` — the value + lineage
 *  carrier a `provenanced` field ships as (M-T6.12).  A classic `TypeVar` +
 *  `Generic[T]` rather than PEP-695 `class Provenanced[T]`, so the model does
 *  not depend on pydantic's newer generic-syntax support.  `lineage` is the
 *  opaque `ProvLineage` audit blob (`json` in the IR — Loom does not model its
 *  interior), nullable for a field that has never been written. */
function provenancedModel(): string[] {
  return [
    "",
    "",
    `${PY_PROV_TYPEVAR} = TypeVar("${PY_PROV_TYPEVAR}")`,
    "",
    "",
    `class ${PY_PROVENANCED}(BaseModel, Generic[${PY_PROV_TYPEVAR}]):`,
    `    """A provenanced field's value together with the lineage of the write`,
    "    that produced it — the same { value, lineage } object every other Loom",
    "    backend serves.  Storage keeps the two apart (a typed value column plus a",
    '    jsonb lineage column); only the wire folds them."""',
    "",
    ...provenancedTypeMembers({ kind: "none" }).map((m) =>
      m.type
        ? `    ${m.name}: ${PY_PROV_TYPEVAR}`
        : `    ${m.name}: dict[str, object] | None${m.optional ? " = None" : ""}`,
    ),
  ];
}

export function renderPyWireModels(ctx: BoundedContextIR): string {
  const models = ctx.valueObjects.map((vo) => {
    // A VO's own `invariant`s ride the SAME wire carriers the aggregate
    // command DTOs use (`Field(...)` + `@model_validator`).  Pydantic
    // validates a nested VO model on request parse, so a malformed VO field
    // is rejected at the wire boundary with 422 — matching the node (Zod
    // `<VO>Schema`) and Elixir (VO changeset) backends, instead of falling
    // through to the domain constructor's `DomainError` → 400.
    const available = new Set(vo.fields.map((f) => f.name));
    const constraints = createFieldConstraints(vo.invariants, available);
    const validator = createModelValidator(vo.invariants, available, vo.name);
    return lines(
      "",
      "",
      `class ${vo.name}(BaseModel):`,
      vo.fields.map((f) =>
        withFieldConstraint(
          f.name,
          wireFieldType(f.type, ctx, "request", ""),
          constraints.get(f.name),
        ),
      ),
      validator,
    );
  });
  // The `Provenanced[T]` carrier model — emitted here (beside the VO models) so
  // every routes module imports one definition instead of re-declaring the
  // shape per aggregate.
  const hasProv = ctx.aggregates.some(
    (a) =>
      a.fields.some((f) => f.provenanced) ||
      a.parts.some((p) => p.fields.some((f) => f.provenanced)),
  );
  const body = models.join("") + (hasProv ? lines(...provenancedModel()) : "");
  const uses = (n: string): boolean => new RegExp(`\\b${n}\\b`).test(body);
  const enumNames = ctx.enums.map((e) => e.name).filter(uses);
  const pydanticNames = [
    ctx.valueObjects.length > 0 || hasProv ? "BaseModel" : null,
    uses("Field") ? "Field" : null,
    // `UuidStr` is emitted unconditionally (every routes module imports it for
    // its reference-typed request annotations), so its two pydantic pieces are
    // always in the import list.
    "StringConstraints",
    // A messaged single-field rule raises through `ValidationError.
    // from_exception_data` so the error carries the field's `loc` (M-T1.11).
    uses("ValidationError") ? "ValidationError" : null,
    "WithJsonSchema",
    uses("model_validator") ? "model_validator" : null,
  ].filter((n): n is string => n != null);
  return lines(
    `"""Pydantic wire models for value objects.  Auto-generated."""`,
    "",
    uses("datetime") ? "from datetime import datetime" : null,
    uses("Decimal") ? "from decimal import Decimal" : null,
    hasProv ? "from typing import Annotated, Generic, TypeVar" : "from typing import Annotated",
    "",
    `from pydantic import ${pydanticNames.join(", ")}`,
    uses("PydanticCustomError")
      ? `from pydantic_core import ${uses("InitErrorDetails") ? "InitErrorDetails, PydanticCustomError" : "PydanticCustomError"}`
      : null,
    enumNames.length > 0 ? "" : null,
    enumNames.length > 0 ? `from app.domain.value_objects import ${enumNames.join(", ")}` : null,
    "",
    PY_UUID_STR_DEF,
    models.join(""),
    hasProv ? provenancedModel() : null,
    "",
  );
}
