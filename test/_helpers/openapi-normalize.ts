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
 * All named component schemas in a spec, minus framework-emitted noise
 * (e.g. Swashbuckle's `ProblemDetails`, OpenApiSpex's internal types) that
 * isn't part of the cross-backend contract.  Used by the parity diff to
 * automatically pick up new shared schemas — request bodies, list
 * responses, view responses — as the showcase grows, rather than relying
 * on a hardcoded "schemas to check" list that goes stale.
 */
export function schemaNames(spec: OpenApiSpec): Set<string> {
  // The drop-in guarantee makes the component-schema *set* part of the
  // wire surface: a client binds to schemas by name, so every backend
  // must emit the same named components — including the list-response
  // wrappers (`ProjectListResponse`).  We filter out only the schemas
  // that are genuinely NOT part of the shared contract:
  const IDIOMATIC_SCHEMAS = new Set([
    // .NET framework-only validation envelopes Swashbuckle auto-emits for
    // `[ApiController]` model-state failures.  The shared error body is
    // RFC 7807 `ProblemDetails` (compared, not filtered) — these two are
    // .NET-specific validation extras with no cross-backend counterpart.
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
  const schema = spec.components?.schemas?.[schemaName] as { required?: string[] } | undefined;
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
  return p.replace(/\{[^}]+\}/g, "{id}").replace(/\/+$/, "") || "/";
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
  // Direct ref: response body schema points at a named component.  Under
  // the drop-in guarantee every backend emits the SAME named list-response
  // wrapper (`ProjectListResponse`), so we return the component name as-is
  // and compare it exactly — no resolving a named wrapper down to an
  // inline `array<…>`.
  if (schema.$ref) {
    const m = schema.$ref.match(/^#\/components\/schemas\/(.+)$/);
    return m ? (m[1] ?? null) : null;
  }
  // Inline array wrapper: `{ type: array, items: { $ref: ... } }`.  A
  // backend that inlines its list response (rather than naming a wrapper
  // component) reads as `array<Element>` — which then drifts against a
  // backend that names the wrapper, surfacing the drop-in break.
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
  for (const schema of sharedSchemas) {
    const refFields = fieldSet(ref.spec, schema);
    const otherFields = fieldSet(other.spec, schema);
    const onlyA = [...refFields].filter((f) => !otherFields.has(f)).sort();
    const onlyB = [...otherFields].filter((f) => !refFields.has(f)).sort();
    if (onlyA.length || onlyB.length) {
      fieldDiffs.push(`${schema}: only-${ref.name}=[${onlyA}] only-${other.name}=[${onlyB}]`);
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
    paramTypeDiffs,
    requestBodyDiffs,
    responseBodyDiffs,
    operationIdDiffs,
    enumValueDiffs,
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
    diff.paramTypeDiffs.length === 0 &&
    diff.requestBodyDiffs.length === 0 &&
    diff.responseBodyDiffs.length === 0 &&
    diff.operationIdDiffs.length === 0 &&
    diff.enumValueDiffs.length === 0
  );
}
