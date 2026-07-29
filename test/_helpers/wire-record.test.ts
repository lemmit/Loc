import { describe, expect, it } from "vitest";
import {
  applyWaivers,
  diffRecording,
  generalizePath,
  isVolatileSegment,
  pathMatches,
  renderWireReport,
  requestMatches,
  staleWaivers,
  templatePath,
  toWireEntry,
  type WireEntry,
  type WireWaiver,
} from "./wire-record.js";
import { WIRE_WAIVERS } from "./wire-waivers.js";

const entry = (o: Partial<WireEntry> & { seq: number }): WireEntry => ({
  method: "GET",
  path: "/api/products",
  status: 200,
  body: null,
  ...o,
});

describe("templatePath", () => {
  it("drops host/port and keeps the route literals", () => {
    expect(templatePath("http://localhost:8080/api/products")).toBe("/api/products");
    expect(templatePath("http://localhost:3000/api/products")).toBe("/api/products");
  });

  it("collapses a uuid path segment to {id}", () => {
    expect(templatePath("http://x/api/products/3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(
      "/api/products/{id}",
    );
  });

  it("collapses an integer path segment to {id}", () => {
    expect(templatePath("http://x/api/orders/42/lines")).toBe("/api/orders/{id}/lines");
  });

  it("collapses a long opaque token but leaves ordinary route words alone", () => {
    expect(isVolatileSegment("01HQ8XZ4KJ9M2P7R3T5V6W8Y0A")).toBe(true);
    expect(isVolatileSegment("products")).toBe(false);
    expect(isVolatileSegment("register_project")).toBe(false);
    expect(templatePath("http://x/api/workflows/register_project")).toBe(
      "/api/workflows/register_project",
    );
  });

  it("sorts query params and normalizes volatile query values", () => {
    expect(templatePath("http://x/api/products?size=10&page=2")).toBe(
      "/api/products?page=2&size=10",
    );
    // A recognized volatile VALUE shape wins (more informative than the
    // by-key token); a key-volatile param whose value has no known shape still
    // collapses, so a per-run id can never read as a route difference.
    expect(templatePath("http://x/api/lines?orderId=3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(
      "/api/lines?orderId=<uuid>",
    );
    expect(templatePath("http://x/api/lines?orderId=ord_7")).toBe(
      "/api/lines?orderId=<volatile:key>",
    );
  });

  it("survives a relative or malformed url", () => {
    expect(templatePath("/api/products?b=1&a=2")).toBe("/api/products?a=2&b=1");
  });
});

describe("toWireEntry", () => {
  it("normalizes uuids/timestamps in the body but keeps their keys", () => {
    const e = toWireEntry(
      0,
      "post",
      "http://x/api/products",
      201,
      JSON.stringify({
        id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
        createdAt: "2026-07-29T10:11:12.345Z",
        name: "Widget",
      }),
    );
    expect(e.method).toBe("POST");
    expect(e.body).toEqual({
      createdAt: "<timestamp>",
      id: "<volatile:key>",
      name: "Widget",
    });
  });

  it("keeps a non-JSON body as text and an empty body as the empty string", () => {
    expect(toWireEntry(0, "GET", "/x", 500, "Internal Server Error").body).toBe(
      "Internal Server Error",
    );
    expect(toWireEntry(0, "DELETE", "/x", 204, "").body).toBe("");
  });
});

describe("diffRecording", () => {
  it("is empty when the recordings agree", () => {
    const g = [entry({ seq: 0, body: { a: 1 } })];
    expect(diffRecording(g, [entry({ seq: 0, body: { a: 1 } })])).toEqual([]);
  });

  it("reports a request-count mismatch and nothing else", () => {
    const d = diffRecording([entry({ seq: 0 }), entry({ seq: 1 })], [entry({ seq: 0 })]);
    expect(d).toHaveLength(1);
    expect(d[0].kind).toBe("request-count");
    expect(d[0].golden).toBe(2);
    expect(d[0].actual).toBe(1);
  });

  it("short-circuits on a desynchronized ordinal instead of reporting noise", () => {
    const g = [entry({ seq: 0, path: "/api/a" }), entry({ seq: 1, body: { x: 1 } })];
    const a = [entry({ seq: 0, path: "/api/b" }), entry({ seq: 1, body: { x: 2 } })];
    const d = diffRecording(g, a);
    expect(d).toHaveLength(1);
    expect(d[0].kind).toBe("request");
  });

  it("reports a status divergence", () => {
    const d = diffRecording([entry({ seq: 0, status: 404 })], [entry({ seq: 0, status: 200 })]);
    expect(d.map((x) => x.kind)).toEqual(["status"]);
    expect(d[0].golden).toBe(404);
  });

  it("carries the body taxonomy through with a seq + request label", () => {
    const g = [entry({ seq: 0, body: { status: "pending", tags: [] } })];
    const a = [entry({ seq: 0, body: { status: "PENDING", tags: null } })];
    const d = diffRecording(g, a);
    expect(d.map((x) => x.kind).sort()).toEqual(["enum-casing", "null-vs-empty"]);
    expect(d[0].seq).toBe(0);
    expect(d[0].request).toBe("GET /api/products");
  });
});

describe("waiver matching", () => {
  const div = (path: string, kind: "value" | "enum-casing" = "value") => ({
    seq: 0,
    request: "GET /api/products",
    kind,
    path,
    golden: 1 as const,
    actual: 0 as const,
  });

  it("generalizes array indices so one waiver covers every element", () => {
    expect(generalizePath("$[3].lines[12].version")).toBe("$[*].lines[*].version");
  });

  it("matches `**.` at any depth but an exact pattern exactly", () => {
    expect(pathMatches("**.version", "$[0].version")).toBe(true);
    expect(pathMatches("**.version", "$.a.b.version")).toBe(true);
    expect(pathMatches("**.version", "$.versionTag")).toBe(false);
    expect(pathMatches("$[*].total", "$[7].total")).toBe(true);
    expect(pathMatches("$[*].total", "$[7].sub.total")).toBe(false);
  });

  it("matches a request glob one segment at a time", () => {
    expect(requestMatches("POST /api/*", "POST /api/accounts")).toBe(true);
    // A sub-resource operation is NOT a collection create — the glob must not
    // widen an "over-returns on create" waiver into "anything under /api".
    expect(requestMatches("POST /api/*", "POST /api/orders/{id}/confirm")).toBe(false);
    expect(requestMatches("POST /api/*", "GET /api/accounts")).toBe(false);
  });

  it("`**` matches any body path (only usable with another scope)", () => {
    expect(pathMatches("**", "$.anything.deep[3].x")).toBe(true);
  });

  it("scopes by request when the divergence is endpoint-shaped, not path-shaped", () => {
    const waivers: WireWaiver[] = [
      {
        backends: ["elixir"],
        request: "POST /api/*",
        path: "**",
        kinds: ["key-set"],
        reason: "RS-13 — over-returns",
      },
    ];
    const onCreate = {
      seq: 0,
      request: "POST /api/accounts",
      kind: "key-set" as const,
      path: "$.owner",
      golden: undefined,
      actual: "alice" as const,
    };
    const onOp = { ...onCreate, request: "POST /api/orders/{id}/confirm" };
    expect(applyWaivers([onCreate], "elixir", "ledger", waivers).gating).toHaveLength(0);
    expect(applyWaivers([onOp], "elixir", "ledger", waivers).gating).toHaveLength(1);
    expect(applyWaivers([onCreate], "java", "ledger", waivers).gating).toHaveLength(1);
  });

  it("splits gating from waived by backend, case, path and kind", () => {
    const waivers: WireWaiver[] = [
      { backends: ["java"], path: "**.version", kinds: ["value"], reason: "RS-11 — x" },
      { backends: ["java"], cases: ["ledger"], path: "$.total", reason: "M-T6.9 — y" },
    ];
    const divs = [div("$[0].version"), div("$.total"), div("$.name")];

    const java = applyWaivers(divs, "java", "ledger", waivers);
    expect(java.gating.map((d) => d.path)).toEqual(["$.name"]);
    expect(java.waived.map((d) => d.reason)).toEqual(["RS-11 — x", "M-T6.9 — y"]);

    // Same divergences on a backend the waiver does not name → all gate.
    expect(applyWaivers(divs, "elixir", "ledger", waivers).gating).toHaveLength(3);
    // Case-scoped waiver does not leak to another case.
    expect(applyWaivers([div("$.total")], "java", "payments", waivers).gating).toHaveLength(1);
    // Kind-scoped waiver does not cover a different kind at the same path.
    expect(
      applyWaivers([div("$[0].version", "enum-casing")], "java", "ledger", waivers).gating,
    ).toHaveLength(1);
  });
});

describe("staleWaivers (the ratchet)", () => {
  const waivers: WireWaiver[] = [
    { backends: ["java"], path: "**.version", reason: "RS-11 — a" },
    { backends: ["java"], cases: ["ledger"], path: "$.total", reason: "RS-12 — b" },
    { backends: ["python"], path: "$.x", reason: "RS-13 — c" },
  ];

  it("flags a matched-nothing waiver for this backend so a fix must delete it", () => {
    const stale = staleWaivers(waivers, "java", ["ledger", "payments"], new Set([0]));
    expect(stale.map((w) => w.reason)).toEqual(["RS-12 — b"]);
  });

  it("never flags another backend's waiver, or one whose case did not run", () => {
    expect(staleWaivers(waivers, "java", ["payments"], new Set([0]))).toEqual([]);
    expect(staleWaivers(waivers, "python", [], new Set()).length).toBe(0);
  });
});

describe("renderWireReport", () => {
  it("says so plainly when the recording matches, noting waived count", () => {
    const out = renderWireReport("java", "ledger", {
      gating: [],
      waived: [
        {
          seq: 0,
          request: "GET /x",
          kind: "value",
          path: "$.version",
          golden: 1,
          actual: 0,
          reason: "RS-11",
        },
      ],
      usedWaivers: new Set([0]),
    });
    expect(out).toContain("matches golden");
    expect(out).toContain("1 waived");
  });

  it("groups gating divergences by kind and names the golden file", () => {
    const out = renderWireReport("python", "sales", {
      gating: [
        {
          seq: 2,
          request: "GET /api/orders",
          kind: "key-set",
          path: "$.total",
          golden: 1,
          actual: undefined,
        },
        { seq: 3, request: "GET /api/orders", kind: "value", path: "$.n", golden: 1, actual: 2 },
      ],
      waived: [],
      usedWaivers: new Set(),
    });
    expect(out).toContain("wire-golden/sales.json");
    expect(out).toContain("key-set (1)");
    expect(out).toContain("value (1)");
  });
});

describe("WIRE_WAIVERS registry hygiene", () => {
  it("every waiver names a concrete exit (an RS-rule or a mission/PR id)", () => {
    for (const w of WIRE_WAIVERS) {
      expect(
        /RS-\d+|M-T\d+\.\d+|#\d+/.test(w.reason),
        `waiver at ${w.path} must name an RS-rule or mission: ${w.reason}`,
      ).toBe(true);
      expect(w.backends.length, `waiver at ${w.path} must name its backends`).toBeGreaterThan(0);
    }
  });

  it('a catch-all `path: "**"` always carries a second scope, so it can\'t become a silent filter', () => {
    for (const w of WIRE_WAIVERS) {
      if (w.path !== "**") continue;
      expect(
        Boolean(w.request) || Boolean(w.kinds?.length) || Boolean(w.cases?.length),
        `waiver on ${w.backends.join(",")} uses path "**" and must scope by request/kinds/cases: ${w.reason}`,
      ).toBe(true);
    }
  });
});

describe("waived divergences are listed, not just counted", () => {
  it("prints each waived row with its rule tag so tolerated drift stays visible", () => {
    const out = renderWireReport("dotnet", "shapes", {
      gating: [],
      waived: [
        {
          seq: 3,
          request: "GET /api/carts/{id}",
          kind: "value",
          path: "$.version",
          golden: 2,
          actual: 1,
          reason: "RS-11 — version init",
        },
      ],
      usedWaivers: new Set([0]),
    });
    expect(out).toContain("waived #3 GET /api/carts/{id} at $.version");
    expect(out).toContain("[RS-11]");
  });
});

describe("report volume", () => {
  it("caps the waived list so a systemic waiver can't bury the log", () => {
    const waived = Array.from({ length: 20 }, (_, i) => ({
      seq: i,
      request: "POST /api/accounts",
      kind: "key-set" as const,
      path: `$.f${i}`,
      golden: undefined,
      actual: i,
      reason: "RS-13 — over-returns",
    }));
    const out = renderWireReport("elixir", "ledger", {
      gating: [],
      waived,
      usedWaivers: new Set([0]),
    });
    expect(out.split("\n").filter((l) => l.includes("waived #"))).toHaveLength(6);
    expect(out).toContain("14 more waived");
  });
});

describe("WIRE_NORMALIZE — path-shaped strings", () => {
  it("templates a 7807 `instance` so the route survives but the id does not", () => {
    const e = toWireEntry(
      0,
      "POST",
      "http://x/api/listings/3f2504e0-4f89-11d3-9a0c-0305e82c3301/discontinue",
      400,
      JSON.stringify({
        type: "about:blank",
        title: "Bad Request",
        status: 400,
        detail: "Precondition failed",
        instance: "/api/listings/3f2504e0-4f89-11d3-9a0c-0305e82c3301/discontinue",
      }),
    );
    // Without this rule the golden could never match twice; collapsing the whole
    // string to one token would lose the route, which is where a divergence shows.
    expect((e.body as Record<string, unknown>).instance).toBe("/api/listings/{id}/discontinue");
    expect((e.body as Record<string, unknown>).title).toBe("Bad Request");
  });

  it("leaves an ordinary path string alone when it carries no volatile segment", () => {
    const e = toWireEntry(0, "GET", "/x", 200, JSON.stringify({ href: "/api/listings" }));
    expect((e.body as Record<string, unknown>).href).toBe("/api/listings");
  });
});
