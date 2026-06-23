// Cross-backend wire parity for discriminated unions (payload-transport-layer.md,
// P4e).
//
// The tagged-union wire is identical *by construction* — every backend derives
// it from the single `unionMembers` resolver — but "identical by construction"
// is exactly the invariant that drifts later without a test pinning it.  This
// generates the same `find recent(): Order or NotFound` (the validator-pinned
// absence shape, `loom.union-find-shape-unsupported`) for Hono, .NET, and
// Phoenix and asserts each emits the same per-variant tagged shape: the `type`
// discriminator, the same variant tags (`Order`, `NotFound`), and the same
// wire field keys under each tag.
//
// Lives in the always-on `test` gate (no docker) — the discriminated-union
// complement to `paged-wire-parity.test.ts`.

import { describe, expect, it } from "vitest";
import { unionMembers } from "../../src/generator/_payload/union-wire.js";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts, type TypeIR } from "../../src/ir/types/loom-ir.js";
import { lowerFirst } from "../../src/util/naming.js";
import { generateDotnet, generateHono, generateSystemFiles } from "../_helpers/generate.js";
import { parseString, parseValid } from "../_helpers/parse.js";

const CONTEXT = `
  context Orders {
    aggregate Order ids guid { code: string  region: string }
    error NotFound { resource: string }
    repository Orders for Order { find recent(): Order or NotFound }
  }
`;

const PHX_SYSTEM = `
  system S {
    subdomain Sales {
      context Orders {
        aggregate Order ids guid { code: string  region: string }
        error NotFound { resource: string }
        repository Orders for Order { find recent(): Order or NotFound }
      }
    }
    api OrdersApi from Sales
    ui A with scaffold(subdomains: [Sales]) { }
    storage pg { type: postgres }
    resource s { for: Orders, kind: state, use: pg }
    deployable d {
      platform: elixir { foundation: ash }
      contexts: [Orders]
      dataSources: [s]
      serves: OrdersApi
      ui: A
      port: 4000
    }
  }
`;

/** variant tag → ordered wire field keys, expressed as a comparable object. */
type Shape = Record<string, string[]>;

/** The canonical shape, straight from the single source of truth
 *  (`unionMembers`) — the same resolver every backend's emitter consumes. */
async function canonical(): Promise<Shape> {
  const { model } = await parseString(CONTEXT, { validate: false });
  const ctx = allContexts(enrichLoomModel(lowerModel(model))).find((c) => c.name === "Orders")!;
  const find = ctx.repositories[0]!.finds.find((f) => f.returnType.kind === "union")!;
  const variants = (find.returnType as Extract<TypeIR, { kind: "union" }>).variants;
  const out: Shape = {};
  for (const m of unionMembers(variants, ctx)) {
    out[m.tag] =
      m.shape === "record" ? m.fields.map((f) => f.name) : m.shape === "scalar" ? ["value"] : [];
  }
  return out;
}

/** Hono: the `z.discriminatedUnion("type", […])` members. */
async function honoShape(): Promise<Shape> {
  const files = generateHono(await parseValid(CONTEXT));
  const routes = files.get("http/order.routes.ts")!;
  const body = routes.match(
    /export const OrderOrNotFound = z\.discriminatedUnion\("type", \[([\s\S]*?)\]\)/,
  )![1]!;
  const out: Shape = {};
  for (const m of body.matchAll(/z\.object\(\{([^}]*)\}\)/g)) {
    const member = m[1]!;
    const tag = member.match(/type: z\.literal\("(\w+)"\)/)![1]!;
    out[tag] = [...member.matchAll(/(\w+):/g)].map((x) => x[1]!).filter((k) => k !== "type");
  }
  return out;
}

/** .NET: the `[JsonDerivedType]` variant records (PascalCase props → camelCase
 *  wire via System.Text.Json). */
async function dotnetShape(): Promise<Shape> {
  const files = generateDotnet(await parseValid(CONTEXT));
  const key = [...files.keys()].find((k) => k.endsWith("Responses/OrderOrNotFound.cs"))!;
  const dto = files.get(key)!;
  const out: Shape = {};
  for (const m of dto.matchAll(
    /public sealed record OrderOrNotFound_(\w+)\(([^)]*)\) : OrderOrNotFound;/g,
  )) {
    const tag = m[1]!;
    const params = m[2]!.trim();
    out[tag] = params ? params.split(",").map((p) => lowerFirst(p.trim().split(/\s+/).pop()!)) : [];
  }
  return out;
}

/** Phoenix: the controller's `tag_<union>/1` struct-pattern clauses. */
async function phoenixShape(): Promise<Shape> {
  const files = await generateSystemFiles(PHX_SYSTEM);
  const key = [...files.keys()].find((k) => k.endsWith("controllers/orders_controller.ex"))!;
  const ctrl = files.get(key)!;
  const out: Shape = {};
  for (const m of ctrl.matchAll(
    /defp tag_order_or_not_found\(%[\w.]+\.(\w+)\{\} = v\), do: %\{([^}]*)\}/g,
  )) {
    const tag = m[1]!;
    // Field pairs are `key: v.field`; the discriminator (`type: "Tag"`) has no `v.`.
    out[tag] = [...m[2]!.matchAll(/(\w+): v\./g)].map((x) => x[1]!);
  }
  return out;
}

describe("discriminated unions — cross-backend wire parity (P4e)", () => {
  it("the canonical shape tags Order/NotFound with their wire fields", async () => {
    expect(await canonical()).toEqual({
      Order: ["id", "code", "region"],
      NotFound: ["resource"],
    });
  });

  it("Hono emits the canonical tagged shape", async () => {
    expect(await honoShape()).toEqual(await canonical());
  });

  it(".NET emits the canonical tagged shape (camelCased record props)", async () => {
    expect(await dotnetShape()).toEqual(await canonical());
  });

  it("Phoenix tags the success variant inline; the error variant rides a 404 (A4)", async () => {
    // Under the find re-shape (A4) the `NotFound` error variant is not a 200
    // tagged member on Phoenix — the error payload has no struct, and the absent
    // case maps to a 404 ProblemDetails (pinned by union-find-absence-parity.
    // test.ts).  The success variant tags identically to the other backends.
    expect(await phoenixShape()).toEqual({ Order: (await canonical()).Order });
  });

  it("Hono and .NET agree on the full tagged-union wire; Phoenix matches on the success variant", async () => {
    const [hono, dotnet, phoenix] = await Promise.all([honoShape(), dotnetShape(), phoenixShape()]);
    expect(hono).toEqual(dotnet);
    expect(phoenix).toEqual({ Order: hono.Order });
  });

  it("every backend uses the `type` discriminator", async () => {
    const honoSrc = generateHono(await parseValid(CONTEXT)).get("http/order.routes.ts")!;
    const dotnet = generateDotnet(await parseValid(CONTEXT));
    const dotnetSrc = dotnet.get(
      [...dotnet.keys()].find((k) => k.endsWith("OrderOrNotFound.cs"))!,
    )!;
    expect(honoSrc).toContain('z.discriminatedUnion("type"');
    expect(dotnetSrc).toContain('[JsonPolymorphic(TypeDiscriminatorPropertyName = "type")]');
  });
});
