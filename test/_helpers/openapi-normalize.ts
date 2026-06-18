// ---------------------------------------------------------------------------
// OpenAPI normalization — reduce a generated OpenAPI document to a canonical,
// dialect-agnostic normal form so specs emitted by different backends
// (Swashbuckle / @hono/zod-openapi / OpenApiSpex) can be compared.
//
// Extracted from test/e2e/e2e.test.ts so the cross-backend parity check and
// its unit tests share one implementation.  Pure functions only — no I/O.
// ---------------------------------------------------------------------------

export interface OpenApiPathItem {
  [method: string]: unknown;
}

export interface OpenApiSchema {
  type?: string;
  properties?: Record<string, unknown>;
  items?: OpenApiSchema;
  $ref?: string;
  required?: string[];
}

export interface OpenApiSpec {
  paths?: Record<string, OpenApiPathItem>;
  components?: { schemas?: Record<string, OpenApiSchema> };
}

export type ResponseSchema = OpenApiSchema & {
  nullable?: boolean;
  oneOf?: unknown[];
  anyOf?: unknown[];
  $ref?: string;
};

export type ResponseCardinality = "array" | "object" | "nullable";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** Infrastructure endpoints that aren't part of the public contract. */
function isInfraPath(p: string): boolean {
  // /ready joins /health: both are probe endpoints (k8s livenessProbe /
  // readinessProbe).  .NET's `app.MapGet` auto-registers them in the
  // OpenAPI doc; Hono uses raw `app.get(...)` and skips registration;
  // Phoenix's OpenApiSpex emitter doesn't surface them.  All three
  // back-ends serve the endpoints at runtime — we just filter them out
  // of the parity diff because they're infrastructure, not contract.
  return p === "/health" || p === "/ready" || p === "/openapi.json" || p.startsWith("/swagger");
}

/**
 * Field-name set for a named component schema.  Both backends produce
 * `<Agg>Response`, so we line up `properties`'s keys.  Doesn't recurse into
 * nested schemas (`price` shows up once).
 *
 * Co-located provenance (`<field>_provenance`) is a TS/Hono-only wire
 * extension — only the TS backend persists lineage — so it's excluded
 * here; otherwise it would read as a Hono-only field and trip cross-
 * backend diffs.
 */
export function fieldSet(spec: OpenApiSpec, schemaName: string): Set<string> {
  const schema = spec.components?.schemas?.[schemaName];
  if (!schema?.properties) return new Set();
  return new Set(Object.keys(schema.properties).filter((k) => !k.endsWith("_provenance")));
}

/**
 * Normalised *type* signature for one property schema — the structural kind,
 * dialect-folded so the three backends' equivalent shapes read identically:
 *
 *   - nullable union (`oneOf`/`anyOf` with a `null` member — zod-openapi) or
 *     OAS-3.1 `type: ["string","null"]` → the underlying non-null type
 *     (optionality is already covered by `requiredSet`, so it's folded out);
 *   - `$ref` → `ref:<ComponentName>` (so a property pointing at a different
 *     nested schema across backends is caught);
 *   - `array` → `array<element-signature>`;
 *   - otherwise the JSON `type` (`string` / `integer` / `number` / …).
 *
 * `format` is deliberately NOT part of the signature: it's the most
 * dialect-divergent facet (Swashbuckle emits `int32`/`date-time` where the
 * others omit it) and path-parameter formats are already compared by
 * `pathParamSignatures`.  This dimension targets the structural-kind blind
 * spot — e.g. a field that is `string` on one backend and `integer` on
 * another — which nothing else catches.
 */
function propTypeSig(schema: unknown): string {
  if (!schema || typeof schema !== "object") return "unknown";
  const s = schema as {
    type?: string | string[];
    $ref?: string;
    items?: unknown;
    oneOf?: unknown[];
    anyOf?: unknown[];
  };
  // Fold nullable unions down to the single non-null member.
  const union = s.oneOf ?? s.anyOf;
  if (Array.isArray(union)) {
    const nonNull = union.filter((m) => {
      const t = (m as { type?: string | string[] }).type;
      return !(t === "null" || (Array.isArray(t) && t.every((x) => x === "null")));
    });
    if (nonNull.length === 1) return propTypeSig(nonNull[0]);
    return nonNull.map(propTypeSig).sort().join("|");
  }
  if (s.$ref) {
    const m = s.$ref.match(/^#\/components\/schemas\/(.+)$/);
    return m ? `ref:${m[1]}` : "ref";
  }
  let t = s.type;
  if (Array.isArray(t)) t = t.find((x) => x !== "null");
  if (t === "array") return `array<${propTypeSig(s.items)}>`;
  return t ?? "object";
}

/**
 * Per-property normalised type signature for a named component schema —
 * `Map<propertyName, signature>` (see `propTypeSig`).  Drives the
 * `propertyTypeDiffs` dimension, which catches same-name-different-type
 * drift inside request/response bodies that the name/required/cardinality
 * dimensions miss.
 */
export function propertyTypes(spec: OpenApiSpec, schemaName: string): Map<string, string> {
  const schema = spec.components?.schemas?.[schemaName];
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(props)) {
    if (k.endsWith("_provenance")) continue;
    out.set(k, propTypeSig(v));
  }
  return out;
}

/** The `format` of a property schema, peeled through nullable unions —
 *  `undefined` when none is declared.  Drives the format check, which is
 *  deliberately conservative: it only flags when BOTH backends declare a
 *  format and they DIFFER (e.g. `date-time` vs `date`).  A format declared
 *  on one side but omitted on the other is the dominant dialect asymmetry
 *  (Swashbuckle emits `int32`/`uuid` where Ash/zod omit it) and is *not*
 *  flagged — that would be noise, not a contract break. */
function propFormat(schema: unknown): string | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const s = schema as { format?: string; oneOf?: unknown[]; anyOf?: unknown[] };
  const union = s.oneOf ?? s.anyOf;
  if (Array.isArray(union)) {
    const nonNull = union.filter((m) => (m as { type?: string }).type !== "null");
    if (nonNull.length === 1) return propFormat(nonNull[0]);
  }
  return s.format;
}

/** Per-property declared `format` for a named component schema — only props
 *  that declare one (see `propFormat`). */
export function propertyFormats(spec: OpenApiSpec, schemaName: string): Map<string, string> {
  const schema = spec.components?.schemas?.[schemaName];
  const props = (schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(props)) {
    if (k.endsWith("_provenance")) continue;
    const f = propFormat(v);
    if (f !== undefined) out.set(k, f);
  }
  return out;
}

/**
 * All named component schemas in a spec, minus framework-emitted noise
 * (e.g. Swashbuckle's `ProblemDetails`, OpenApiSpex's internal types) that
 * isn't part of the cross-backend contract.  Used by the parity diff to
 * automatically pick up new shared schemas — request bodies, list
 * responses, view responses — as the showcase grows, rather than relying
 * on a hardcoded "schemas to check" list that goes stale.
 */
export function schemaNames(spec: OpenApiSpec): Set<string> {
  // The shared RFC 7807 `ProblemDetails` error body (#706) and the named
  // list-response wrappers (`<Agg>ListResponse`, full-form-view
  // `<View>Response`) (#705) are COMPARED across backends — all three
  // publish them.  Only the genuinely-per-backend schemas are filtered:
  const IDIOMATIC_SCHEMAS = new Set([
    // Swashbuckle (.NET) model-state validation envelopes — auto-emitted
    // for `[ApiController]` 400s; no cross-backend counterpart.  (The
    // shared `ProblemDetails` body is NOT filtered — it's compared.)
    "ValidationProblemDetails",
    "HttpValidationProblemDetails",
    // Co-located provenance lineage is a TS/Hono-only wire extension
    // (only the TS backend persists lineage) — consistent with the
    // per-field `_provenance` exclusion in `fieldSet` / `requiredSet`.
    "ProvenanceLineage",
  ]);
  const schemas = spec.components?.schemas ?? {};
  return new Set(Object.keys(schemas).filter((n) => !IDIOMATIC_SCHEMAS.has(n)));
}

/**
 * Required-field set for a named component schema.  Each backend emits a
 * `required: [...]` array on object schemas; drift here is a contract
 * change clients would notice (a field flipping required → optional).
 */
export function requiredSet(spec: OpenApiSpec, schemaName: string): Set<string> {
  const schema = spec.components?.schemas?.[schemaName];
  return new Set((schema?.required ?? []).filter((k) => !k.endsWith("_provenance")));
}

/**
 * Enum value-set per named component schema.  All three backends model a
 * DSL enum (`Visibility`, `BuildState`) as a named string schema carrying
 * an `enum: [...]` constraint.  The *value set* is behavioural — a client
 * sees which values are accepted — so it is compared even though each
 * backend may name / case the component differently.  Returns a sorted
 * value list per enum-bearing schema; non-enum schemas are absent.
 */
export function enumValueSets(spec: OpenApiSpec): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    const en = (schema as { enum?: unknown[] }).enum;
    if (Array.isArray(en) && en.length > 0) {
      out.set(name, en.map((v) => String(v)).sort());
    }
  }
  return out;
}

/** Build a `Set<"METHOD path">` from an OpenAPI spec's `paths`. */
export function collectOps(spec: OpenApiSpec): Set<string> {
  const out = new Set<string>();
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    if (isInfraPath(p)) continue;
    for (const m of Object.keys(item)) {
      const method = m.toUpperCase();
      if (HTTP_METHODS.includes(method)) {
        out.add(`${method} ${normalisePath(p)}`);
      }
    }
  }
  return out;
}

/**
 * Build `Map<"METHOD path", cardinality>` — the cardinality of each
 * operation's 2xx response body.
 *
 * `array`    — response wraps the schema in `type: array`.
 * `nullable` — schema with `nullable: true` (Swashbuckle) or a `oneOf`/`anyOf`
 *              union with `null` (zod-openapi).
 * `object`   — single, required-present.
 *
 * Default for an unknown shape is `object` so a missing 200 doesn't
 * false-positive.
 */
export function collectResponseShapes(spec: OpenApiSpec): Map<string, ResponseCardinality> {
  const out = new Map<string, ResponseCardinality>();
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    if (isInfraPath(p)) continue;
    for (const [m, raw] of Object.entries(item)) {
      const method = m.toUpperCase();
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) continue;
      const op = raw as {
        responses?: Record<string, { content?: Record<string, { schema?: ResponseSchema }> }>;
      };
      const ok = op.responses?.["200"] ?? op.responses?.["201"];
      const schema = ok?.content?.["application/json"]?.schema;
      out.set(`${method} ${normalisePath(p)}`, classifyShape(schema, spec));
    }
  }
  return out;
}

/**
 * Classify a response schema as `array` / `nullable` / `object`,
 * dereferencing a single-step `$ref` to a top-level component if present
 * (zod-openapi emits the list type as a named component, e.g.
 * `ProductListResponse`).  Components don't transitively ref each other in
 * the generated specs, so one hop suffices.
 */
export function classifyShape(
  schema: ResponseSchema | undefined,
  spec: OpenApiSpec,
): ResponseCardinality {
  if (!schema) return "object";
  let resolved: ResponseSchema = schema;
  if (schema.$ref) {
    const m = schema.$ref.match(/^#\/components\/schemas\/(.+)$/);
    if (m) {
      const target = spec.components?.schemas?.[m[1]!];
      if (target) resolved = target as ResponseSchema;
    }
  }
  if (resolved.type === "array") return "array";
  if (
    resolved.nullable === true ||
    (resolved.oneOf?.some((x) => (x as { type?: string }).type === "null") ?? false) ||
    (resolved.anyOf?.some((x) => (x as { type?: string }).type === "null") ?? false)
  ) {
    return "nullable";
  }
  return "object";
}

/**
 * Normalise OpenAPI path templates so differently-named path parameters
 * (`{id}` vs `{productId}`) collapse into a single representation across the
 * emitters, and trailing slashes drop.
 */
export function normalisePath(p: string): string {
  return (
    p
      // Strip the universal `/api` base mount so parity compares logical
      // operations regardless of how each backend renders the prefix in its
      // OpenAPI: path-embedded for hono/dotnet/java/python (`/api/builds`),
      // scope/servers-relative for phoenix (`/builds`).  `/api` is the shared
      // base across every backend, so it's noise for op-set parity.
      .replace(/^\/api(?=\/|$)/, "")
      .replace(/\{[^}]+\}/g, "{id}")
      .replace(/\/+$/, "") || "/"
  );
}

/**
 * Resolve a schema reference to its component name.  Returns the bare
 * `<Name>` from `#/components/schemas/<Name>` (the OpenAPI 3 convention
 * all three backends emit), or `null` for non-component refs (inline
 * schemas, malformed `$ref`).  Used by `requestBodySchemas` /
 * `responseBodySchemas` to surface schema-binding drift between
 * backends.
 */
function schemaRefName(
  schema: { $ref?: string; type?: string; items?: { $ref?: string } } | undefined,
): string | null {
  if (!schema) return null;
  // Direct ref: response body schema points at a named component.
  if (schema.$ref) {
    const m = schema.$ref.match(/^#\/components\/schemas\/(.+)$/);
    if (!m) return null;
    // The named component (incl. list wrappers like `ProjectListResponse`)
    // is compared by name — all three backends now emit the wrapper (#705).
    return m[1]!;
  }
  // Array wrapper: `{ type: array, items: { $ref: ... } }`.  Annotated
  // with the array marker so the diff distinguishes single-item from
  // collection bodies at a glance (`array<ProjectResponse>` reads
  // differently from `ProjectResponse`).
  if (schema.type === "array" && schema.items?.$ref) {
    const m = schema.items.$ref.match(/^#\/components\/schemas\/(.+)$/);
    return m ? `array<${m[1]}>` : null;
  }
  // Inline / non-ref shape: no single schema name to compare.
  return null;
}

/**
 * Per-operation request body schema reference.  Maps each op to the
 * component schema its `requestBody` points at — `CreateProductRequest`,
 * `RenameRequest`, etc.  Drift here catches the case where two backends
 * agree the op exists and accepts a body, but disagree on which schema
 * the body conforms to (e.g., one wired to `CreateProductRequest`, the
 * other accidentally to `UpdateProductRequest`).
 *
 * Ops with no request body get an empty-string entry; ops with an inline
 * schema (not a `$ref`) get an empty string too — backends don't usually
 * inline request schemas, so empty-vs-named drift is its own signal.
 */
export function requestBodySchemas(spec: OpenApiSpec): Map<string, string> {
  const out = new Map<string, string>();
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    if (isInfraPath(p)) continue;
    for (const [m, raw] of Object.entries(item)) {
      const method = m.toUpperCase();
      if (!HTTP_METHODS.includes(method)) continue;
      const op = raw as {
        requestBody?: {
          content?: Record<string, { schema?: { $ref?: string; type?: string } }>;
        };
      };
      const schema = op.requestBody?.content?.["application/json"]?.schema;
      out.set(`${method} ${normalisePath(p)}`, schemaRefName(schema) ?? "");
    }
  }
  return out;
}

/**
 * Per-operation `operationId` string.  OpenAPI's operationId is the
 * stable identifier client-codegen tools (NSwag, openapi-generator,
 * Heyapi, etc.) use to name generated functions.  Drift here breaks
 * codegen consumers that expect a stable handle even when paths or
 * payloads change in compatible ways.
 *
 * Ops without an operationId get an empty string — surfaces as drift
 * if one backend declares an id and another omits it.
 */
export function operationIds(spec: OpenApiSpec): Map<string, string> {
  const out = new Map<string, string>();
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    if (isInfraPath(p)) continue;
    for (const [m, raw] of Object.entries(item)) {
      const method = m.toUpperCase();
      if (!HTTP_METHODS.includes(method)) continue;
      const op = raw as { operationId?: string };
      out.set(`${method} ${normalisePath(p)}`, op.operationId ?? "");
    }
  }
  return out;
}

/**
 * Per-operation 2xx response body schema reference.  Complements
 * `collectResponseShapes` (which classifies array/object/nullable) by
 * also identifying WHICH named component the response references.  Two
 * backends agreeing on "returns an array" but disagreeing on what's
 * inside the array would be silently OK under cardinality alone; this
 * makes the array element schema explicit (`array<ProjectResponse>`).
 *
 * Ops with no 2xx body or an inline schema get an empty-string entry.
 */
export function responseBodySchemas(spec: OpenApiSpec): Map<string, string> {
  const out = new Map<string, string>();
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    if (isInfraPath(p)) continue;
    for (const [m, raw] of Object.entries(item)) {
      const method = m.toUpperCase();
      if (!HTTP_METHODS.includes(method)) continue;
      const op = raw as {
        responses?: Record<
          string,
          { content?: Record<string, { schema?: { $ref?: string; type?: string } }> }
        >;
      };
      const ok = op.responses?.["200"] ?? op.responses?.["201"];
      const schema = ok?.content?.["application/json"]?.schema;
      out.set(`${method} ${normalisePath(p)}`, schemaRefName(schema) ?? "");
    }
  }
  return out;
}

/**
 * Per-operation RFC 7807 error-response signature.  For each operation,
 * the ascending set of declared 4xx/5xx responses paired with the
 * component schema each carries under `application/problem+json` — e.g.
 * `400:ProblemDetails,404:ProblemDetails`.  Every backend declares the
 * SAME set (driven by `src/ir/util/openapi-errors.ts`), so drift here —
 * a missing status, a divergent body schema, or an error served as plain
 * `application/json` instead of `application/problem+json` (which reads as
 * `(none)`) — is a real cross-backend error-contract break.
 */
export function errorResponses(spec: OpenApiSpec): Map<string, string> {
  const PROBLEM_JSON = "application/problem+json";
  const out = new Map<string, string>();
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    if (isInfraPath(p)) continue;
    for (const [m, raw] of Object.entries(item)) {
      const method = m.toUpperCase();
      if (!HTTP_METHODS.includes(method)) continue;
      const op = raw as {
        responses?: Record<
          string,
          { content?: Record<string, { schema?: { $ref?: string; type?: string } }> }
        >;
      };
      const parts: string[] = [];
      for (const [code, resp] of Object.entries(op.responses ?? {})) {
        if (!/^[45]\d\d$/.test(code)) continue;
        const schema = resp.content?.[PROBLEM_JSON]?.schema;
        parts.push(`${code}:${schemaRefName(schema) ?? "(none)"}`);
      }
      out.set(`${method} ${normalisePath(p)}`, parts.sort().join(","));
    }
  }
  return out;
}

/**
 * Per-operation path-parameter type signature.  Captures what
 * `normalisePath` deliberately discards (the actual parameter type +
 * format) so the parity diff can catch drift like:
 *   Phoenix: { type: string }
 *   Hono:    { type: string, format: uuid }
 *
 * Each operation's signature is the ordered list of path-parameter
 * declarations joined by `,`.  Two backends' parameters are matched
 * positionally on the normalised path (so `/p/{productId}` and
 * `/p/{id}` align — same shape `/p/{id}` after normalisation, same
 * positional binding).
 *
 * Operations with no path parameters get an empty-signature entry so
 * "spec declares but other omits" surfaces as a mismatch, not just an
 * absence.
 */
export function pathParamSignatures(spec: OpenApiSpec): Map<string, string> {
  const out = new Map<string, string>();
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    if (isInfraPath(p)) continue;
    for (const [m, raw] of Object.entries(item)) {
      const method = m.toUpperCase();
      if (!HTTP_METHODS.includes(method)) continue;
      const op = raw as {
        parameters?: Array<{
          in?: string;
          name?: string;
          schema?: { type?: string; format?: string };
        }>;
      };
      // Path parameters in the OpenAPI sense — `in: "path"` only.
      // Query / header params are not part of the URL shape; comparing
      // those would belong to a different dimension.
      const sigs = (op.parameters ?? [])
        .filter((q) => q.in === "path")
        // Stable ordering: the spec emits them in URL order, but
        // Swashbuckle / OpenApiSpex don't guarantee that — sort by
        // name to make the diff order-independent.
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
        .map((q) => {
          const t = q.schema?.type ?? "any";
          const f = q.schema?.format ? `:${q.schema.format}` : "";
          // Anonymise param name — what we care about cross-backend is
          // the TYPE shape; matching by name would just resurface
          // the `{id}` vs `{productId}` non-issue normalisePath solves.
          return `${t}${f}`;
        })
        .join(",");
      out.set(`${method} ${normalisePath(p)}`, sigs);
    }
  }
  return out;
}

/**
 * Per-operation *query*-parameter signature.  Unlike path parameters,
 * query-parameter NAMES are part of the contract (a client sends
 * `?name=…`), so they're compared by name → type → required.  Each
 * operation's signature is the name-sorted list of
 * `<name>:<type>:<req|opt>` entries (order-independent, since dialects
 * don't agree on parameter order).
 *
 * `format` is folded out here for the same reason as `propTypeSig` — it's
 * the most dialect-divergent facet; the structural contract is name + type
 * + required.  An operation with no query parameters gets an empty
 * signature so "declares but other omits" surfaces as a mismatch.
 */
export function queryParamSignatures(spec: OpenApiSpec): Map<string, string> {
  const out = new Map<string, string>();
  for (const [p, item] of Object.entries(spec.paths ?? {})) {
    if (isInfraPath(p)) continue;
    for (const [m, raw] of Object.entries(item)) {
      const method = m.toUpperCase();
      if (!HTTP_METHODS.includes(method)) continue;
      const op = raw as {
        parameters?: Array<{
          in?: string;
          name?: string;
          required?: boolean;
          schema?: { type?: string };
        }>;
      };
      const sigs = (op.parameters ?? [])
        .filter((q) => q.in === "query")
        .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
        .map((q) => `${q.name ?? "?"}:${q.schema?.type ?? "any"}:${q.required ? "req" : "opt"}`)
        .join(",");
      out.set(`${method} ${normalisePath(p)}`, sigs);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cross-backend parity diff (pure)
//
// The e2e parity test (test/e2e/e2e.test.ts) calls `diffSpecs` for each
// (reference, other) pair after fetching both OpenAPI docs over HTTP.
// Splitting the comparison out keeps it unit-testable in the fast suite
// — the e2e wrapper only owns the docker-compose fetch.
// ---------------------------------------------------------------------------

/**
 * Result of a single (reference, other) spec comparison.  Each `[]`-typed
 * field is empty in the clean case; any non-empty entry is a contract
 * divergence the strict gate would fail on.
 */
export interface ParityDiff {
  refName: string;
  otherName: string;
  /** Operations declared on ref but missing on other. */
  onlyRef: string[];
  /** Operations declared on other but missing on ref. */
  onlyOther: string[];
  /** Per-op response-cardinality drift on the intersection (array vs object vs nullable). */
  cardMismatches: string[];
  /** Component schemas declared on ref but missing on other. */
  onlySchemasRef: string[];
  /** Component schemas declared on other but missing on ref. */
  onlySchemasOther: string[];
  /** Per-schema property-name drift on the intersection. */
  fieldDiffs: string[];
  /** Per-schema `required: [...]` drift on the intersection. */
  requiredDiffs: string[];
  /** Per-property *type* drift on the intersection of shared schemas ×
   * shared properties — a field that is e.g. `string` on one backend and
   * `integer` on another (folded over nullable/format dialect noise; see
   * `propTypeSig`).  Closes the same-name-different-type blind spot. */
  propertyTypeDiffs: string[];
  /** Per-property `format` drift — only where BOTH backends declare a
   * format and they differ (`date-time` vs `date`).  One-sided format is
   * dialect asymmetry, not a contract break, and is not flagged. */
  propertyFormatDiffs: string[];
  /** Per-op query-parameter drift on the intersection — a query param
   * present/typed/required differently across backends (compared by name;
   * see `queryParamSignatures`). */
  queryParamDiffs: string[];
  /** Per-op path-parameter type drift on the intersection (e.g. one
   * backend declares `{type: string}`, another `{type: string, format:
   * uuid}`). */
  paramTypeDiffs: string[];
  /** Per-op request-body schema drift on the intersection — two
   * backends agreeing the op exists but pointing the body at
   * different component schemas (e.g. `CreateProductRequest` vs
   * `UpdateProductRequest`). */
  requestBodyDiffs: string[];
  /** Per-op response-body schema drift on the intersection — e.g.
   * `array<ProjectResponse>` vs `array<ProjectListItem>`.  Complements
   * `cardMismatches` (which catches array-vs-object drift) by also
   * catching same-cardinality, different-payload drift. */
  responseBodyDiffs: string[];
  /** Per-op `operationId` drift on the intersection.  Compared EXACTLY:
   * the drop-in-replacement guarantee requires byte-identical
   * operationIds across backends (all three render the same canonical
   * camelCase token from the shared `openapi-ids` helper), since
   * client-codegen tools turn them into function names. */
  operationIdDiffs: string[];
  /** Per-enum value-set drift on the intersection of enum-bearing
   * component schemas — a backend accepting a different allowed-value
   * set for the same enum (`Visibility`, `BuildState`). */
  enumValueDiffs: string[];
  /** Per-op RFC 7807 error-response drift on the intersection — a
   * backend declaring a different set of 4xx/5xx responses, a different
   * body schema, or serving the error as `application/json` instead of
   * `application/problem+json`.  The error contract is part of drop-in
   * replacement: a client's error handling binds to these. */
  errorResponseDiffs: string[];
}

/**
 * Compare two OpenAPI specs across every dimension the parity gate
 * enforces.  Pure — no I/O, no logging.  Callers decide what to do with
 * the diff (log it in report mode, assert empty in strict mode).
 *
 * Naming the reference vs. other side carries through to the divergence
 * strings (`only-hono=[...]` vs `only-${otherName}=[...]`), which is how
 * the e2e test surfaces failures in its `console.warn` output.
 */
export function diffSpecs(
  ref: { name: string; spec: OpenApiSpec },
  other: { name: string; spec: OpenApiSpec },
): ParityDiff {
  const refOps = collectOps(ref.spec);
  const otherOps = collectOps(other.spec);
  const onlyRef = [...refOps].filter((o) => !otherOps.has(o)).sort();
  const onlyOther = [...otherOps].filter((o) => !refOps.has(o)).sort();

  const refCard = collectResponseShapes(ref.spec);
  const otherCard = collectResponseShapes(other.spec);
  const cardMismatches: string[] = [];
  for (const op of refCard.keys()) {
    if (!otherCard.has(op)) continue;
    if (refCard.get(op) !== otherCard.get(op)) {
      cardMismatches.push(
        `${op}: ${ref.name}=${refCard.get(op)}, ${other.name}=${otherCard.get(op)}`,
      );
    }
  }

  // Schema-presence diff + per-schema field-set / required-set diff on the
  // intersection.  Iterating the intersection keeps a missing schema out
  // of the field-set count — it only shows in `onlySchemas*`.
  const refSchemas = schemaNames(ref.spec);
  const otherSchemas = schemaNames(other.spec);
  const onlySchemasRef = [...refSchemas].filter((s) => !otherSchemas.has(s)).sort();
  const onlySchemasOther = [...otherSchemas].filter((s) => !refSchemas.has(s)).sort();
  const sharedSchemas = [...refSchemas].filter((s) => otherSchemas.has(s)).sort();

  const fieldDiffs: string[] = [];
  const requiredDiffs: string[] = [];
  const propertyTypeDiffs: string[] = [];
  const propertyFormatDiffs: string[] = [];
  for (const schema of sharedSchemas) {
    const refFields = fieldSet(ref.spec, schema);
    const otherFields = fieldSet(other.spec, schema);
    const onlyA = [...refFields].filter((f) => !otherFields.has(f)).sort();
    const onlyB = [...otherFields].filter((f) => !refFields.has(f)).sort();
    if (onlyA.length || onlyB.length) {
      fieldDiffs.push(`${schema}: only-${ref.name}=[${onlyA}] only-${other.name}=[${onlyB}]`);
    }
    // Per-property type drift on the field intersection (a field present on
    // both sides whose normalised type differs — `string` vs `integer`).
    // A field missing on one side surfaces in `fieldDiffs`, not here.
    const refTypes = propertyTypes(ref.spec, schema);
    const otherTypes = propertyTypes(other.spec, schema);
    for (const [prop, refSig] of refTypes) {
      const otherSig = otherTypes.get(prop);
      if (otherSig === undefined) continue;
      if (refSig !== otherSig) {
        propertyTypeDiffs.push(
          `${schema}.${prop}: ${ref.name}=${refSig}, ${other.name}=${otherSig}`,
        );
      }
    }
    // Per-property format drift — only where BOTH sides declare a format
    // and they differ (one-sided format is dialect asymmetry, not flagged).
    const refFmts = propertyFormats(ref.spec, schema);
    const otherFmts = propertyFormats(other.spec, schema);
    for (const [prop, refF] of refFmts) {
      const otherF = otherFmts.get(prop);
      if (otherF !== undefined && refF !== otherF) {
        propertyFormatDiffs.push(`${schema}.${prop}: ${ref.name}=${refF}, ${other.name}=${otherF}`);
      }
    }
    // Intersection-based required diff: if a field doesn't exist on a
    // side, its required status on the other side is moot — surfaces in
    // the fields diff above instead.
    const refReq = [...requiredSet(ref.spec, schema)].filter((f) => otherFields.has(f)).sort();
    const otherReq = [...requiredSet(other.spec, schema)].filter((f) => refFields.has(f)).sort();
    const onlyReqRef = refReq.filter((f) => !otherReq.includes(f));
    const onlyReqOther = otherReq.filter((f) => !refReq.includes(f));
    if (onlyReqRef.length || onlyReqOther.length) {
      requiredDiffs.push(
        `${schema}: required-only-${ref.name}=[${onlyReqRef}] required-only-${other.name}=[${onlyReqOther}]`,
      );
    }
  }

  // Per-op path-parameter type drift on the op intersection.  Catches
  // shape drift `normalisePath` deliberately hides (e.g., one backend
  // declaring `{type: string}` for `id`, another declaring `{type:
  // string, format: uuid}` — same URL shape, different contract).
  const refParams = pathParamSignatures(ref.spec);
  const otherParams = pathParamSignatures(other.spec);
  const paramTypeDiffs: string[] = [];
  for (const op of refParams.keys()) {
    if (!otherParams.has(op)) continue;
    const refSig = refParams.get(op) ?? "";
    const otherSig = otherParams.get(op) ?? "";
    if (refSig !== otherSig) {
      paramTypeDiffs.push(`${op}: ${ref.name}=[${refSig}], ${other.name}=[${otherSig}]`);
    }
  }

  // Per-op query-parameter drift on the op intersection — name/type/required
  // of `in: query` params (the parameterized finds' filters), which the
  // path-param dimension deliberately doesn't cover.
  const refQuery = queryParamSignatures(ref.spec);
  const otherQuery = queryParamSignatures(other.spec);
  const queryParamDiffs: string[] = [];
  for (const op of refQuery.keys()) {
    if (!otherQuery.has(op)) continue;
    const r = refQuery.get(op) ?? "";
    const o = otherQuery.get(op) ?? "";
    if (r !== o) {
      queryParamDiffs.push(`${op}: ${ref.name}=[${r}], ${other.name}=[${o}]`);
    }
  }

  // Per-op request-body schema-ref drift.  Catches "op exists on both
  // sides but each points its body at a different component schema" —
  // a class of mistake the schema-set + per-schema field diffs can't
  // detect because both schemas exist and both are internally fine.
  const refRequest = requestBodySchemas(ref.spec);
  const otherRequest = requestBodySchemas(other.spec);
  const requestBodyDiffs: string[] = [];
  for (const op of refRequest.keys()) {
    if (!otherRequest.has(op)) continue;
    const r = refRequest.get(op) ?? "";
    const o = otherRequest.get(op) ?? "";
    if (r !== o) {
      requestBodyDiffs.push(`${op}: ${ref.name}=${r || "(none)"}, ${other.name}=${o || "(none)"}`);
    }
  }

  // Per-op response-body schema-ref drift.  Complements cardMismatches
  // (which catches array-vs-object) by also catching same-cardinality,
  // different-payload drift (e.g. `array<ProjectResponse>` vs
  // `array<Project>` — identical cardinality, drift in the element
  // type).
  const refResponse = responseBodySchemas(ref.spec);
  const otherResponse = responseBodySchemas(other.spec);
  const responseBodyDiffs: string[] = [];
  for (const op of refResponse.keys()) {
    if (!otherResponse.has(op)) continue;
    const r = refResponse.get(op) ?? "";
    const o = otherResponse.get(op) ?? "";
    if (r !== o) {
      responseBodyDiffs.push(`${op}: ${ref.name}=${r || "(none)"}, ${other.name}=${o || "(none)"}`);
    }
  }

  // Per-op operationId drift.  Loom's cross-backend guarantee is drop-in
  // replacement: a client generated from one backend's spec must bind
  // unmodified against another.  operationId is the stable handle
  // client-codegen tools (NSwag, openapi-generator, Heyapi) turn into
  // function names, so it must be BYTE-IDENTICAL across backends — all
  // three render the same canonical camelCase token from the shared
  // `openapi-ids` helper.  Exact comparison (no case folding): a casing
  // or token difference is a real drop-in break.
  const refOpIds = operationIds(ref.spec);
  const otherOpIds = operationIds(other.spec);
  const operationIdDiffs: string[] = [];
  for (const op of refOpIds.keys()) {
    if (!otherOpIds.has(op)) continue;
    const r = refOpIds.get(op) ?? "";
    const o = otherOpIds.get(op) ?? "";
    if (r !== o) {
      operationIdDiffs.push(`${op}: ${ref.name}=${r || "(none)"}, ${other.name}=${o || "(none)"}`);
    }
  }

  // Per-enum value-set drift on the intersection of enum-bearing schemas.
  const refEnums = enumValueSets(ref.spec);
  const otherEnums = enumValueSets(other.spec);
  const enumValueDiffs: string[] = [];
  for (const [name, refVals] of refEnums) {
    const otherVals = otherEnums.get(name);
    if (!otherVals) continue;
    if (refVals.join(",") !== otherVals.join(",")) {
      enumValueDiffs.push(`${name}: ${ref.name}=[${refVals}] ${other.name}=[${otherVals}]`);
    }
  }

  // Per-op RFC 7807 error-response drift on the op intersection.  Each
  // backend declares the SAME status set per operation (from the shared
  // `openapi-errors` matrix), each carrying `ProblemDetails` under
  // `application/problem+json`.  Drift = a missing/extra status, a
  // divergent body schema, or a wrong content-type.
  const refErrors = errorResponses(ref.spec);
  const otherErrors = errorResponses(other.spec);
  const errorResponseDiffs: string[] = [];
  for (const op of refErrors.keys()) {
    if (!otherErrors.has(op)) continue;
    const r = refErrors.get(op) ?? "";
    const o = otherErrors.get(op) ?? "";
    if (r !== o) {
      errorResponseDiffs.push(`${op}: ${ref.name}=[${r}], ${other.name}=[${o}]`);
    }
  }

  return {
    refName: ref.name,
    otherName: other.name,
    onlyRef,
    onlyOther,
    cardMismatches,
    onlySchemasRef,
    onlySchemasOther,
    fieldDiffs,
    requiredDiffs,
    propertyTypeDiffs,
    propertyFormatDiffs,
    paramTypeDiffs,
    queryParamDiffs,
    requestBodyDiffs,
    responseBodyDiffs,
    operationIdDiffs,
    enumValueDiffs,
    errorResponseDiffs,
  };
}

/** True iff every dimension is empty — the diff is contract-clean. */
export function isCleanDiff(diff: ParityDiff): boolean {
  return (
    diff.onlyRef.length === 0 &&
    diff.onlyOther.length === 0 &&
    diff.cardMismatches.length === 0 &&
    diff.onlySchemasRef.length === 0 &&
    diff.onlySchemasOther.length === 0 &&
    diff.fieldDiffs.length === 0 &&
    diff.requiredDiffs.length === 0 &&
    diff.propertyTypeDiffs.length === 0 &&
    diff.propertyFormatDiffs.length === 0 &&
    diff.paramTypeDiffs.length === 0 &&
    diff.queryParamDiffs.length === 0 &&
    diff.requestBodyDiffs.length === 0 &&
    diff.responseBodyDiffs.length === 0 &&
    diff.operationIdDiffs.length === 0 &&
    diff.enumValueDiffs.length === 0 &&
    diff.errorResponseDiffs.length === 0
  );
}
