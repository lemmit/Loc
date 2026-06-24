// Cross-backend wire parity for `paged` (payload-transport-layer.md, P3).
//
// The paged envelope is identical *by construction* — every backend that emits
// it derives its DTO from the single `genericShape("paged")` registry — but
// "identical by construction" is exactly the kind of invariant that drifts
// later without a test pinning it.  This generates the same paged find for Hono
// and .NET and asserts each emits the same ordered wire key set
// (`items, page, pageSize, total, totalPages`), so a divergence in either
// backend's emitter fails here rather than silently breaking the contract.
//
// (The Elixir backend — plain Phoenix+Ecto, the only foundation — does not
// emit the paged envelope: a paged find returns a bare serialized array, so it
// is out of scope for this wire-key parity.)
//
// Lives in the always-on `test` gate (no docker) — complements the live
// OpenAPI parity e2e, which boots showcase.ddd's backends.

import { describe, expect, it } from "vitest";
import { genericShape } from "../../src/ir/stdlib/generics.js";
import { lowerFirst } from "../../src/util/naming.js";
import { generateDotnet, generateHono } from "../_helpers/generate.js";
import { parseValid } from "../_helpers/parse.js";

// The canonical wire key order, straight from the single source of truth.
const CANONICAL = genericShape("paged")
  .fields({ kind: "entity", name: "Order" })
  .map((f) => f.name);

const CONTEXT = `
  context Orders {
    aggregate Order ids guid { code: string  region: string }
    repository Orders for Order { find recent(): Order paged }
  }
`;

/** Ordered keys of the Hono `OrderPaged` zod object. */
async function honoKeys(): Promise<string[]> {
  const files = generateHono(await parseValid(CONTEXT));
  const routes = files.get("http/order.routes.ts")!;
  const body = routes.match(/export const OrderPaged = z\.object\(\{([^}]*)\}\)/)![1]!;
  return [...body.matchAll(/(\w+):/g)].map((m) => m[1]!);
}

/** Ordered fields of the .NET generic `Paged<T>` record, lower-cased to the
 *  JSON wire form (System.Text.Json camelCases record properties). */
async function dotnetKeys(): Promise<string[]> {
  const files = generateDotnet(await parseValid(CONTEXT));
  const common = files.get("Domain/Common/DomainException.cs")!;
  const params = common.match(/record Paged<T>\(([^)]*)\)/)![1]!;
  return params.split(",").map((p) => lowerFirst(p.trim().split(/\s+/).pop()!));
}

describe("paged — cross-backend wire parity (P3)", () => {
  it("the canonical envelope is items/page/pageSize/total/totalPages (1-based)", () => {
    expect(CANONICAL).toEqual(["items", "page", "pageSize", "total", "totalPages"]);
  });

  it("Hono emits the canonical envelope key order", async () => {
    expect(await honoKeys()).toEqual(CANONICAL);
  });

  it(".NET emits the canonical envelope key order (camelCased record props)", async () => {
    expect(await dotnetKeys()).toEqual(CANONICAL);
  });

  it("both backends agree on the paged wire shape", async () => {
    const [hono, dotnet] = await Promise.all([honoKeys(), dotnetKeys()]);
    expect(hono).toEqual(dotnet);
  });
});
