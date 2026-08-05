// The derivation's error statuses are the RESOLVED statuses, and its
// operation set is the SERVED set.
//
// Before this suite, `deriveContextOperations` disagreed with every backend on
// four counts, each invisible to the parity gate because its fixture never
// exercised the case:
//
//   1. An error-payload absence union (`Order or Missing`) fell through to
//      `findSingle` → [] — both variants are `entity` in TypeIR, so
//      `absenceUnionSuccess` (which keys on entity-vs-non-entity) missed the
//      shape — while every backend declares the payload's resolved status.
//   2. `httpStatus` overrides never reached the derivation: the structural
//      conflicts (`ReferencedInUse` / `Disallowed` / `ConcurrencyConflict`)
//      were hardcoded 409, and the union-absent status was pinned 404, so a
//      remapped api published one contract and the derivation typed another.
//   3. A `private` operation was lifted — typing a client call to a route no
//      backend mounts.
//   4. An abstract inheritance base's aggregate surface was lifted — Hono,
//      python and the java contract all skip abstract bases wholesale.
//
// These are exactly the facts the route builders will render once they consume
// the derivation, which is why they must be pinned here first: a wrong status
// in `ApiOperationIR` stops being a typed-client nuisance and becomes a wrong
// OpenAPI declaration on five backends at once.

import { describe, expect, it } from "vitest";
import type { BoundedContextIR, LoomModel } from "../../src/ir/types/loom-ir.js";
import {
  type ApiOperationIR,
  absenceUnionAbsent,
  apiSurfaceCoverage,
  deriveContextOperations,
  isAllFind,
  relativeOpPath,
  successStatus,
} from "../../src/ir/util/api-surface.js";
import { buildLoomModel } from "../_helpers/ir.js";

/** One system, parameterized by the api's httpStatus block and the Orders
 *  context body — the same skeleton the sibling api-surface suites use. */
const SYS = (ctxBody: string, apiBody = "{ }"): string => `
system P {
  subdomain D {
    context Orders {
${ctxBody}
    }
  }
  api SalesApi from D ${apiBody}
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: node contexts: [Orders] dataSources: [st] port: 3000 }
}
`;

function orders(model: LoomModel): BoundedContextIR {
  const ctx = model.systems
    .flatMap((s) => s.subdomains)
    .flatMap((sd) => sd.contexts)
    .find((c) => c.name === "Orders");
  expect(ctx, "Orders context lowered").toBeDefined();
  return ctx!;
}

function opByKey(ops: ApiOperationIR[], method: string, path: string): ApiOperationIR | undefined {
  return ops.find((o) => o.method === method && o.path === path);
}

describe("api-surface — resolved error statuses", () => {
  it("declares the error payload's status for an error-payload absence union find", async () => {
    // `NotFound` is stdlib (404): the union find must declare [404], not the
    // pre-fix [] that `findSingle` produced for the two-entity union shape.
    const model = await buildLoomModel(
      SYS(`
      error NotFound { resource: string }
      aggregate Order { code: string }
      repository Orders for Order { find byCode(code: string): Order or NotFound }
    `),
    );
    const find = opByKey(deriveContextOperations(orders(model)), "get", "/api/orders/by_code");
    expect(find?.errorStatuses).toEqual([404]);
  });

  it("resolves the union-absent status through the api's httpStatus override", async () => {
    // The same read every backend performs at its own emit site:
    // `errorStatusOverrides?.[tag] ?? defaultErrorStatus(tag)`.
    const model = await buildLoomModel(
      SYS(
        `
      error NotFound { resource: string }
      aggregate Order { code: string }
      repository Orders for Order { find byCode(code: string): Order or NotFound }
    `,
        "{ httpStatus NotFound -> 410 }",
      ),
    );
    const find = opByKey(deriveContextOperations(orders(model)), "get", "/api/orders/by_code");
    expect(find?.errorStatuses).toEqual([410]);
  });

  it("resolves destroy's ReferencedInUse and a when-gate's Disallowed through structuralErrorStatuses", async () => {
    const model = await buildLoomModel(
      SYS(
        `
      aggregate Order with crudish {
        code: string
        status: string
        operation cancel() when status == "Open" { status := "Cancelled" }
      }
      repository Orders for Order { }
    `,
        "{ httpStatus ReferencedInUse -> 423 httpStatus Disallowed -> 428 }",
      ),
    );
    const ops = deriveContextOperations(orders(model));
    const destroy = opByKey(ops, "delete", "/api/orders/{id}");
    expect(destroy?.errorStatuses).toEqual([404, 423]);
    const cancel = opByKey(ops, "post", "/api/orders/{id}/cancel");
    // Base operation set [400, 404, 422] plus the remapped Disallowed — and no
    // stray default 409, which is what the pre-fix hardcoding produced.
    expect(cancel?.errorStatuses).toEqual([400, 404, 422, 428]);
  });

  it("declares a union RETURN's error-arm statuses (the returning-operation set)", async () => {
    // `operation reserve(): Order or OutOfStock` — every backend's
    // returning-operation emitter declares OutOfStock's resolved status; the
    // derivation now derives the same set (error arms told apart from success
    // arms via the context's error-payload catalogue).
    const model = await buildLoomModel(
      SYS(
        `
      error OutOfStock { sku: string }
      aggregate Order {
        code: string
        create(code: string) { code := code }
        operation reserve(): Order or OutOfStock {
          return OutOfStock { sku: code }
        }
      }
      repository Orders for Order { }
    `,
        "{ httpStatus OutOfStock -> 409 }",
      ),
    );
    const op = opByKey(deriveContextOperations(orders(model)), "post", "/api/orders/{id}/reserve");
    expect(op?.errorStatuses).toEqual([400, 404, 409, 422]);
  });

  it("keeps the defaults when no httpStatus overrides exist", async () => {
    const model = await buildLoomModel(
      SYS(`
      aggregate Order with crudish {
        code: string
        status: string
        operation cancel() when status == "Open" { status := "Cancelled" }
      }
      repository Orders for Order { }
    `),
    );
    const ops = deriveContextOperations(orders(model));
    expect(opByKey(ops, "delete", "/api/orders/{id}")?.errorStatuses).toEqual([404, 409]);
    expect(opByKey(ops, "post", "/api/orders/{id}/cancel")?.errorStatuses).toEqual([
      400, 404, 409, 422,
    ]);
  });
});

describe("api-surface — the operation set is the served set", () => {
  it("does not lift a private operation (no route, no gate probe)", async () => {
    const model = await buildLoomModel(
      SYS(`
      aggregate Order {
        code: string
        status: string
        create(code: string) { code := code }
        operation cancel() { status := "Cancelled" }
        private operation recompute() when status == "Open" { status := status }
      }
      repository Orders for Order { }
    `),
    );
    const ops = deriveContextOperations(orders(model));
    expect(opByKey(ops, "post", "/api/orders/{id}/cancel")).toBeDefined();
    expect(opByKey(ops, "post", "/api/orders/{id}/recompute")).toBeUndefined();
    expect(opByKey(ops, "get", "/api/orders/{id}/can_recompute")).toBeUndefined();
  });

  it("does not lift an abstract inheritance base", async () => {
    const model = await buildLoomModel(`
system P {
  subdomain D {
    context Orders {
      abstract aggregate Party inheritanceUsing: sharedTable { name: string }
      aggregate Person extends Party { email: string }
      repository People for Person { }
    }
  }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: node contexts: [Orders] dataSources: [st] port: 3000 }
}
`);
    const ops = deriveContextOperations(orders(model));
    expect(ops.some((o) => o.aggregate === "Party")).toBe(false);
    expect(ops.some((o) => o.aggregate === "Person")).toBe(true);
  });

  it("carries the source IR node for finds and operations", async () => {
    const model = await buildLoomModel(
      SYS(`
      aggregate Order with crudish {
        code: string
        status: string
        operation cancel() when status == "Open" { status := "Cancelled" }
      }
      repository Orders for Order { find byCode(code: string): Order option }
    `),
    );
    const ops = deriveContextOperations(orders(model));
    expect(opByKey(ops, "get", "/api/orders/by_code")?.find?.name).toBe("byCode");
    expect(opByKey(ops, "post", "/api/orders/{id}/cancel")?.operation?.name).toBe("cancel");
    expect(opByKey(ops, "get", "/api/orders/{id}/can_cancel")?.operation?.name).toBe("cancel");
    // The auto-`all` find is synthesized by enrichment but still a FindIR.
    expect(opByKey(ops, "get", "/api/orders")?.find?.name).toBe("all");
  });
});

describe("api-surface — render helpers for the unification slices", () => {
  it("splits the absolute path, states the success status, and marks the auto-all find", async () => {
    const model = await buildLoomModel(
      SYS(`
      aggregate Order with crudish {
        code: string
        status: string
        operation cancel() when status == "Open" { status := "Cancelled" }
      }
      repository Orders for Order { find byCode(code: string): Order option }
    `),
    );
    const ops = deriveContextOperations(orders(model));
    const rel = new Map(ops.map((o) => [`${o.method} ${o.path}`, relativeOpPath(o)]));
    // The collection root renders as "" — a backend mounts it at its aggregate
    // base with no extra segment (and NO trailing slash, per the create arm).
    expect(rel.get("post /api/orders")).toBe("");
    expect(rel.get("get /api/orders")).toBe("");
    expect(rel.get("get /api/orders/{id}")).toBe("/{id}");
    expect(rel.get("get /api/orders/by_code")).toBe("/by_code");
    expect(rel.get("post /api/orders/{id}/cancel")).toBe("/{id}/cancel");
    expect(rel.get("get /api/orders/{id}/can_cancel")).toBe("/{id}/can_cancel");

    const byKey = (m: string, p: string) => opByKey(ops, m, p)!;
    expect(successStatus(byKey("post", "/api/orders"))).toBe(201);
    expect(successStatus(byKey("delete", "/api/orders/{id}"))).toBe(204);
    // `cancel` declares no `: T` → bodiless 204; the probe answers `{allowed}`.
    expect(successStatus(byKey("post", "/api/orders/{id}/cancel"))).toBe(204);
    expect(successStatus(byKey("get", "/api/orders/{id}/can_cancel"))).toBe(200);
    expect(successStatus(byKey("get", "/api/orders/{id}"))).toBe(200);

    expect(ops.filter(isAllFind).map((o) => o.path)).toEqual(["/api/orders"]);
  });
});

describe("api-surface — coverage honesty", () => {
  it("names the history route as not lifted", () => {
    expect(apiSurfaceCoverage.notLifted).toContain("history");
  });
});

describe("absenceUnionAbsent — the absent-variant discriminator", () => {
  it("distinguishes the none unit from an error payload, keyed on the aggregate", () => {
    const order = { kind: "entity", name: "Order" } as const;
    const missing = { kind: "entity", name: "Missing" } as const;
    const none = { kind: "none" } as const;
    expect(absenceUnionAbsent({ kind: "union", variants: [order, none] }, "Order")).toEqual({
      kind: "none",
    });
    expect(absenceUnionAbsent({ kind: "union", variants: [order, missing] }, "Order")).toEqual({
      kind: "error",
      tag: "Missing",
    });
    // Not this repository's aggregate → not an absence union for this find.
    expect(absenceUnionAbsent({ kind: "union", variants: [order, missing] }, "Person")).toEqual(
      undefined,
    );
    expect(absenceUnionAbsent({ kind: "optional", inner: order }, "Order")).toEqual(undefined);
  });
});
