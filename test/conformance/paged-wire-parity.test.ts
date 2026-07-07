// Cross-backend wire parity for `paged` (payload-transport-layer.md, P3).
//
// The paged envelope is identical *by construction* — every backend that emits
// it derives its DTO from the single `genericShape("paged")` registry — but
// "identical by construction" is exactly the kind of invariant that drifts
// later without a test pinning it.  This generates the same paged find for Hono,
// .NET and Elixir (vanilla Phoenix+Ecto) and asserts each emits the same ordered
// wire key set (`items, page, pageSize, total, totalPages`), so a divergence in
// any backend's emitter fails here rather than silently breaking the contract.
//
// (The Elixir leg was restored when gap §1 closed — the vanilla repository now
// emits the paged envelope map keyed `items/page/pageSize/total/totalPages`,
// serialised to the canonical camelCase JSON at the controller — bringing the
// `paged` wire-key parity back to a 3-backend cross-check.)
//
// Lives in the always-on `test` gate (no docker) — complements the live
// OpenAPI parity e2e, which boots showcase.ddd's backends.

import { describe, expect, it } from "vitest";
import { genericShape } from "../../src/ir/stdlib/generics.js";
import { lowerFirst } from "../../src/util/naming.js";
import { generateDotnet, generateHono, generateSystemFiles } from "../_helpers/generate.js";
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

// Elixir is a backend, not a single-project generator — wrap the same context in
// a full vanilla-Phoenix system so `generateSystemFiles` emits its repository.
const ELIXIR_SYSTEM = `
system PagedShop {
  subdomain Sales {
    context Orders {
      aggregate Order ids guid { code: string  region: string }
      repository Orders for Order { find recent(): Order paged }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
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

/** Ordered keys of the vanilla-Elixir repository's paged envelope map — the atom
 *  keys of the `%{ items: …, page: …, pageSize: …, total: …, totalPages: … }`
 *  the `recent/2` find returns (Jason serialises atom keys verbatim, so these
 *  ARE the wire JSON keys). */
async function elixirKeys(): Promise<string[]> {
  const files = await generateSystemFiles(ELIXIR_SYSTEM);
  const repoKey = [...files.keys()].find((k) => k.endsWith("/orders/order_repository.ex"))!;
  const repo = files.get(repoKey)!;
  // Slice out the `recent/2` envelope map body and read its keys in order.
  const fn = repo.match(/def recent\([^)]*\) do[\s\S]*?\{:ok,\s*%\{([\s\S]*?)\}\s*\}\s*end/)![1]!;
  return [...fn.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]!);
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

  it("Elixir (vanilla Phoenix) emits the canonical envelope key order", async () => {
    expect(await elixirKeys()).toEqual(CANONICAL);
  });

  it("all three backends agree on the paged wire shape", async () => {
    const [hono, dotnet, elixir] = await Promise.all([honoKeys(), dotnetKeys(), elixirKeys()]);
    expect(hono).toEqual(dotnet);
    expect(elixir).toEqual(hono);
  });
});
