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
  // Skip framework-only schemas: Swashbuckle and OpenApiSpex emit a small
  // pool of envelope / error types that the application never authors.
  // Their presence in one backend's spec but not another's would otherwise
  // surface as parity noise.
  const FRAMEWORK_SCHEMAS = new Set([
    // Swashbuckle (.NET) error envelopes
    "ProblemDetails",
    "ValidationProblemDetails",
    "HttpValidationProblemDetails",
  ]);
  return new Set(
    Object.keys(spec.components?.schemas ?? {}).filter((n) => !FRAMEWORK_SCHEMAS.has(n)),
  );
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
    diff.paramTypeDiffs.length === 0
  );
}
