import { describe, expect, it } from "vitest";
import type { ApiEndpoint } from "../../web/src/backend/openapi.js";
import {
  aggregateRequestTraces,
  isInfraPath,
  matchPathTemplate,
  matchRoute,
  requestFromLogLine,
} from "../../web/src/backend/route-match.js";
import type { LogLine } from "../../web/src/util/log-line.js";

// Requests → operations (M-T8.22 slice 4): the pure matcher + aggregate the
// Runtime tab's Requests view (and M-T8.20's Model-node counts) read.

const ep = (method: string, path: string, tag = "products"): ApiEndpoint => ({
  method,
  path,
  operationId: `${method.toLowerCase()} ${path}`,
  tag,
  summary: "",
  pathParams: [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!),
  queryParams: [],
  hasBody: false,
});

const ENDPOINTS: ApiEndpoint[] = [
  ep("GET", "/products"),
  ep("POST", "/products"),
  ep("GET", "/products/{id}"),
  ep("GET", "/products/search"),
  ep("PUT", "/products/{id}"),
  ep("GET", "/orders/{orderId}/lines/{lineId}", "orders"),
];

const requestEnd = (
  method: string,
  path: string,
  status: number,
  extra: Record<string, unknown> = {},
): LogLine => ({
  level: "info",
  text: "",
  structured: {
    level: "info",
    event: "request_end",
    method,
    path,
    status,
    duration_ms: 4,
    ...extra,
  },
});

describe("matchPathTemplate", () => {
  it("matches literals exactly and {params} as any one segment, scoring literals", () => {
    expect(matchPathTemplate("/products", "/products")).toBe(1);
    expect(matchPathTemplate("/products/{id}", "/products/42")).toBe(1);
    expect(matchPathTemplate("/products/search", "/products/search")).toBe(2);
    expect(matchPathTemplate("/orders/{orderId}/lines/{lineId}", "/orders/1/lines/2")).toBe(2);
  });

  it("rejects a different segment count, a different literal, or an empty param", () => {
    expect(matchPathTemplate("/products/{id}", "/products")).toBe(-1);
    expect(matchPathTemplate("/products/{id}", "/products/1/x")).toBe(-1);
    expect(matchPathTemplate("/products", "/orders")).toBe(-1);
    expect(matchPathTemplate("/products/{id}", "/products//")).toBe(-1);
  });

  it("ignores a trailing slash and a query string", () => {
    expect(matchPathTemplate("/products", "/products/")).toBe(1);
    expect(matchPathTemplate("/products/{id}", "/products/42?expand=1")).toBe(1);
  });

  it("decodes percent-encoded literal segments", () => {
    expect(matchPathTemplate("/a b/{id}", "/a%20b/1")).toBe(1);
  });
});

describe("matchRoute", () => {
  it("picks the operation by method + path, preferring the more literal template", () => {
    expect(matchRoute("GET", "/products", ENDPOINTS)?.operationId).toBe("get /products");
    expect(matchRoute("post", "/products", ENDPOINTS)?.operationId).toBe("post /products");
    expect(matchRoute("GET", "/products/42", ENDPOINTS)?.operationId).toBe("get /products/{id}");
    // `/products/search` matches BOTH `/products/{id}` and the literal — the
    // literal wins.
    expect(matchRoute("GET", "/products/search", ENDPOINTS)?.operationId).toBe(
      "get /products/search",
    );
    expect(matchRoute("PUT", "/products/7", ENDPOINTS)?.operationId).toBe("put /products/{id}");
  });

  it("returns null for an unknown path or a method the path does not serve", () => {
    expect(matchRoute("GET", "/nope", ENDPOINTS)).toBeNull();
    expect(matchRoute("DELETE", "/products/1", ENDPOINTS)).toBeNull();
    expect(matchRoute("GET", "/products/1/2", ENDPOINTS)).toBeNull();
  });
});

describe("requestFromLogLine", () => {
  it("reads a request_end line, upper-casing the method and stripping the query", () => {
    const r = requestFromLogLine(
      requestEnd("get", "/products?page=2", 200, { request_id: "7d8bedc1-aaaa" }),
    );
    expect(r).toEqual({
      method: "GET",
      path: "/products",
      status: 200,
      durationMs: 4,
      requestId: "7d8bedc1-aaaa",
    });
  });

  it("ignores every other line", () => {
    expect(requestFromLogLine({ level: "info", text: "hello" })).toBeNull();
    expect(
      requestFromLogLine({
        level: "info",
        text: "",
        structured: { level: "info", event: "request_start", method: "GET", path: "/products" },
      }),
    ).toBeNull();
    expect(
      requestFromLogLine({
        level: "info",
        text: "",
        structured: { level: "info", event: "request_end" },
      }),
    ).toBeNull();
  });
});

describe("isInfraPath", () => {
  it("classifies the spec fetch, health probes and docs as infrastructure", () => {
    for (const p of [
      "/openapi.json",
      "/health",
      "/health/ready",
      "/metrics",
      "/docs",
      "/auth/me",
    ]) {
      expect(isInfraPath(p), p).toBe(true);
    }
    expect(isInfraPath("/products")).toBe(false);
    expect(isInfraPath("/healthcheck-ish")).toBe(false);
  });
});

describe("aggregateRequestTraces", () => {
  it("counts per operation in endpoint order, keeps the last request, lists 404s newest first", () => {
    const lines: LogLine[] = [
      requestEnd("GET", "/openapi.json", 200), // infra — skipped
      requestEnd("GET", "/products", 200),
      requestEnd("GET", "/products", 200, { request_id: "second" }),
      requestEnd("GET", "/products/9", 404),
      requestEnd("GET", "/nope", 404),
      requestEnd("POST", "/products", 201),
      requestEnd("GET", "/also-nope", 404),
      requestEnd("GET", "/nope", 404),
    ];
    const t = aggregateRequestTraces(lines, ENDPOINTS);
    expect(t.total).toBe(7);
    expect(t.byOperation.map((o) => [o.endpoint.operationId, o.count, o.errors])).toEqual([
      ["get /products", 2, 0],
      ["post /products", 1, 0],
      ["get /products/{id}", 1, 1],
      ["get /products/search", 0, 0],
      ["put /products/{id}", 0, 0],
      ["get /orders/{orderId}/lines/{lineId}", 0, 0],
    ]);
    expect(t.byOperation[0]!.last?.requestId).toBe("second");
    // Unmatched: `/nope` was hit twice (most recently last), `/also-nope` once.
    expect(t.unmatched).toEqual([
      { method: "GET", path: "/nope", count: 2, lastStatus: 404 },
      { method: "GET", path: "/also-nope", count: 1, lastStatus: 404 },
    ]);
  });

  it("is empty with no lines and no endpoints", () => {
    const t = aggregateRequestTraces([], []);
    expect(t.total).toBe(0);
    expect(t.byOperation).toEqual([]);
    expect(t.unmatched).toEqual([]);
  });

  it("with no spec every domain request is unmatched (the console falls back to manual mode)", () => {
    const t = aggregateRequestTraces([requestEnd("GET", "/products", 200)], []);
    expect(t.total).toBe(1);
    expect(t.unmatched).toEqual([{ method: "GET", path: "/products", count: 1, lastStatus: 200 }]);
  });
});
