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
  return (
    p === "/health" || p === "/ready" || p === "/openapi.json" || p.startsWith("/swagger")
  );
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
