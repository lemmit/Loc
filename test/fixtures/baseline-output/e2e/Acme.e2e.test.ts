// Auto-generated.  Do not edit by hand.
import { describe, it, expect } from "vitest";

// Override per environment; defaults match the docker-compose ports.
const ENDPOINTS: Record<string, string> = {
  api: process.env.E2E_API_BASE ?? "http://localhost:8080",
  catalog_web: process.env.E2E_CATALOG_WEB_BASE ?? "http://localhost:3000",
  catalog_api: process.env.E2E_CATALOG_API_BASE ?? "http://localhost:8081",
  web_app: process.env.E2E_WEB_APP_BASE ?? "http://localhost:3001",
};

async function __post(url: string, body: unknown): Promise<any> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  // Check the status BEFORE parsing: a 404 (or any error) often carries a
  // non-JSON body (e.g. Hono's "404 Not Found"), and parsing it first would
  // mask the real status behind an opaque "JSON Parse error".
  if (!r.ok) throw new Error(`POST ${url} → ${r.status} ${r.statusText}${text ? ": " + text : ""}`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`POST ${url} → ${r.status}: expected JSON, got ${JSON.stringify(text.slice(0, 200))}`);
  }
}

async function __get(url: string): Promise<any> {
  const r = await fetch(url);
  const text = await r.text();
  if (!r.ok) throw new Error(`GET ${url} → ${r.status} ${r.statusText}${text ? ": " + text : ""}`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`GET ${url} → ${r.status}: expected JSON, got ${JSON.stringify(text.slice(0, 200))}`);
  }
}

async function __getQuery(url: string, params: Record<string, unknown>): Promise<any> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v != null) qs.set(k, String(v));
  }
  const full = qs.toString().length > 0 ? `${url}?${qs}` : url;
  return __get(full);
}

describe("Acme e2e", () => {
  it("create a product, look it up by id", async () => {
    const base = ENDPOINTS["api"];
    const p = await __post(`${base}/products`, ({ sku: "WIDGET-1", price: ({ amount: 9.99, currency: "USD" }) }));
    const read = await __get(`${base}/products/${p.id}`);
    expect(read.sku === "WIDGET-1").toBe(true);
  });

  it("create then confirm an order with one line", async () => {
    const base = ENDPOINTS["api"];
    const prod = await __post(`${base}/products`, ({ sku: "WIDGET-2", price: ({ amount: 5.00, currency: "USD" }) }));
    const ord = await __post(`${base}/orders`, ({ customerId: "cust-001", status: "Draft", placedAt: "2024-01-01T00:00:00Z" }));
    await __post(`${base}/orders/${ord.id}/add_line`, ({ productId: prod.id, qty: 3 }));
    await __post(`${base}/orders/${ord.id}/confirm`, {});
    const read = await __get(`${base}/orders/${ord.id}`);
    expect(read.status === "Confirmed").toBe(true);
    expect(read.lines.length === 1).toBe(true);
  });

  it("by_customer query returns matching orders", async () => {
    const base = ENDPOINTS["api"];
    const ord = await __post(`${base}/orders`, ({ customerId: "cust-002", status: "Draft", placedAt: "2024-01-02T00:00:00Z" }));
    const list = await __getQuery(`${base}/orders/by_customer`, ({ customerId: "cust-002" }));
    expect(list.length >= 1).toBe(true);
  });

});
