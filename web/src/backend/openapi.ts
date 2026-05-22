// Parse an OpenAPI 3.x document (served by the booted Hono backend at
// `/openapi.json`) into a flat list of testable endpoints, and derive
// per-endpoint helpers the Backend console consumes: grouped picker
// data, example request bodies (via `openapi-sampler`), and concrete
// path building.  Pure module — no React, no DOM.

import { sample } from "openapi-sampler";

// Minimal structural typings for the slice of OpenAPI we read.  We
// keep them local rather than pulling `openapi-types` so the backend
// console stays decoupled; `openapi-sampler` accepts the same shapes.
export type JsonSchema = Record<string, unknown>;

interface OpenApiParameter {
  name: string;
  in: string;
  required?: boolean;
  schema?: JsonSchema;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    content?: Record<string, { schema?: JsonSchema }>;
  };
}

type OpenApiPathItem = {
  parameters?: OpenApiParameter[];
} & Partial<Record<HttpMethod, OpenApiOperation>>;

export interface OpenApiDoc {
  openapi?: string;
  paths?: Record<string, OpenApiPathItem>;
  components?: { schemas?: Record<string, JsonSchema> };
}

type HttpMethod = "get" | "post" | "put" | "patch" | "delete";
const METHODS: readonly HttpMethod[] = ["get", "post", "put", "patch", "delete"];

export interface QueryParam {
  name: string;
  required: boolean;
}

export interface ApiEndpoint {
  /** Upper-case HTTP verb, e.g. "POST". */
  method: string;
  /** OpenAPI path template, e.g. "/products/{id}". */
  path: string;
  operationId: string;
  /** First tag — the owning aggregate (snake-plural). "default" if none. */
  tag: string;
  summary: string;
  /** Names of `{…}` path placeholders, in path order. */
  pathParams: string[];
  queryParams: QueryParam[];
  /** application/json request-body schema, if the operation takes one. */
  requestSchema?: JsonSchema;
  /** True for write verbs that declare a JSON request body. */
  hasBody: boolean;
}

/** Sentinel `value` for the picker's "free-form / manual" entry. */
export const CUSTOM_ENDPOINT = "__custom__";

/** Flatten `paths × methods` into a list of endpoints. */
export function parseOpenApi(doc: OpenApiDoc): ApiEndpoint[] {
  const out: ApiEndpoint[] = [];
  const paths = doc.paths ?? {};
  for (const [path, item] of Object.entries(paths)) {
    if (!item) continue;
    const sharedParams = item.parameters ?? [];
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const params = [...sharedParams, ...(op.parameters ?? [])];
      const templateParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      const declaredPathParams = params
        .filter((p) => p.in === "path")
        .map((p) => p.name);
      const pathParams = [...new Set([...templateParams, ...declaredPathParams])];
      const queryParams: QueryParam[] = params
        .filter((p) => p.in === "query")
        .map((p) => ({ name: p.name, required: Boolean(p.required) }));
      const requestSchema = op.requestBody?.content?.["application/json"]?.schema;
      const hasBody =
        (method === "post" || method === "put" || method === "patch") &&
        Boolean(requestSchema);
      out.push({
        method: method.toUpperCase(),
        path,
        operationId: op.operationId ?? `${method} ${path}`,
        tag: op.tags?.[0] ?? "default",
        summary: op.summary ?? op.operationId ?? "",
        pathParams,
        queryParams,
        requestSchema,
        hasBody,
      });
    }
  }
  return out;
}

export interface EndpointGroup {
  group: string;
  items: { value: string; label: string }[];
}

/** Group endpoints by tag for a Mantine grouped `Select`.  Each item's
 *  `value` is the operationId; its `label` reads "POST /products". */
export function groupEndpointsByTag(endpoints: ApiEndpoint[]): EndpointGroup[] {
  const byTag = new Map<string, ApiEndpoint[]>();
  for (const ep of endpoints) {
    const list = byTag.get(ep.tag) ?? [];
    list.push(ep);
    byTag.set(ep.tag, list);
  }
  return [...byTag.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, list]) => ({
      group,
      items: list
        .map((ep) => ({ value: ep.operationId, label: `${ep.method} ${ep.path}` }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    }));
}

/** Build a concrete request path from an endpoint template + filled-in
 *  param values.  Unfilled path placeholders are left as `{name}` so the
 *  user sees what's still required; non-empty query values are appended. */
export function buildConcretePath(
  endpoint: ApiEndpoint,
  pathValues: Record<string, string>,
  queryValues: Record<string, string>,
): string {
  const path = endpoint.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const v = pathValues[name];
    return v && v.length > 0 ? encodeURIComponent(v) : `{${name}}`;
  });
  const qs = new URLSearchParams();
  for (const q of endpoint.queryParams) {
    const v = queryValues[q.name];
    if (v && v.length > 0) qs.set(q.name, v);
  }
  const query = qs.toString();
  return query ? `${path}?${query}` : path;
}

/** Sample an example request body from the endpoint's JSON schema.
 *  `openapi-sampler` resolves `$ref`s against the full document and
 *  honours `example`/`default`.  Returns "" if there's no schema or
 *  sampling throws (malformed/circular schema). */
export function generateExampleBody(
  schema: JsonSchema | undefined,
  doc: OpenApiDoc,
): string {
  if (!schema) return "";
  try {
    const value = sample(
      schema as Parameters<typeof sample>[0],
      { skipReadOnly: true },
      doc as Parameters<typeof sample>[2],
    );
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}
