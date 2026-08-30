// .NET OpenAPI schema-id collisions (schemathesis finding F14).
//
// The emitter writes one wire-DTO namespace PER AGGREGATE, so a value object
// used by two aggregates emits two CLR types with the same SHORT name
// (`Api.Application.Products.Requests.MoneyRequest` /
// `…Orders.Requests.MoneyRequest`).  Swashbuckle's default schemaId selector is
// that short name, and a duplicate throws — taking the WHOLE
// `GET /openapi.json` document down with a 500, so the deployable publishes no
// contract at all (which is why `storefront-system` had to be skipped in the
// dotnet schemathesis leg).
//
// The fix is deliberately narrow: only the genuinely colliding short names are
// qualified, so the component set a collision-free project publishes stays
// SHORT — the shape the four other backends publish and `.loom/wire-spec.json`
// compares.  Both halves are pinned here: the collision is detected and
// qualified, and a collision-free project emits today's exact fallback.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { generateDotnetForContexts } from "../../../src/generator/dotnet/index.js";
import { dotnetSchemaIdOverrides } from "../../../src/generator/dotnet/schema-ids.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";

// Two contexts, one deployable — each declares its own `Money` value object and
// an aggregate carrying it.  Two `MoneyRequest` / `MoneyResponse` CLR types,
// one assembly: the F14 reproduction.
const TWO_CONTEXT_SRC = `system S {
  subdomain M {
    context Catalog {
      valueobject Money { amount: decimal  currency: string }
      aggregate Product with crudish {
        sku: string
        price: Money
      }
    }
    context Sales {
      valueobject Money { amount: decimal  currency: string }
      aggregate Order with crudish {
        reference: string
        total: Money
      }
    }
  }
}`;

// One context, one aggregate using the value object — no short name is emitted
// twice, so nothing may be qualified and Program.cs must stay as it was.
const COLLISION_FREE_SRC = `system S {
  subdomain M {
    context Catalog {
      valueobject Money { amount: decimal  currency: string }
      aggregate Product with crudish {
        sku: string
        price: Money
      }
    }
  }
}`;

// Program.cs's schema-id lambda EXACTLY as it reads with no collisions — the
// byte-identical-output assertion for every single-context / collision-free
// system (i.e. the whole existing corpus).
const UNQUALIFIED_LAMBDA = `    c.CustomSchemaIds(t =>
    {
        if (t.IsGenericType && t.GetGenericTypeDefinition().Name.StartsWith("Paged", StringComparison.Ordinal))
        {
            var inner = t.GetGenericArguments()[0].Name;
            var stem = inner.EndsWith("Response", StringComparison.Ordinal) ? inner.Substring(0, inner.Length - "Response".Length) : inner;
            return stem + "Paged";
        }
        return t.Name;
    });
`;

async function filesFrom(src: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper<Model>(services.Ddd);
  const doc = await helper(src, { validation: true });
  const loom = enrichLoomModel(lowerModel(doc.parseResult.value));
  const contexts = loom.systems.flatMap((s) => s.subdomains.flatMap((sd) => sd.contexts));
  return generateDotnetForContexts(contexts, "Api");
}

describe(".NET OpenAPI schema ids (F14)", () => {
  it("detects the colliding DTO short names across the project's namespaces", async () => {
    const files = await filesFrom(TWO_CONTEXT_SRC);

    // Precondition: the two same-named CLR types really are emitted.
    expect(files.get("Application/Products/Requests/ProductRequests.cs")).toContain(
      "public sealed record MoneyRequest(",
    );
    expect(files.get("Application/Orders/Requests/OrderRequests.cs")).toContain(
      "public sealed record MoneyRequest(",
    );

    const overrides = dotnetSchemaIdOverrides(files);
    const byFullName = new Map(overrides.map((o) => [o.clrFullName, o.schemaId]));
    expect(byFullName.get("Api.Application.Products.Requests.MoneyRequest")).toBe(
      "ProductsMoneyRequest",
    );
    expect(byFullName.get("Api.Application.Orders.Requests.MoneyRequest")).toBe(
      "OrdersMoneyRequest",
    );
    expect(byFullName.get("Api.Application.Products.Responses.MoneyResponse")).toBe(
      "ProductsMoneyResponse",
    );
    expect(byFullName.get("Api.Application.Orders.Responses.MoneyResponse")).toBe(
      "OrdersMoneyResponse",
    );

    // NARROW: a DTO whose short name is unique keeps it, so the component set
    // stays comparable with the four other backends.
    const qualifiedNames = overrides.map((o) => o.clrFullName.split(".").pop());
    expect(qualifiedNames).not.toContain("CreateProductRequest");
    expect(qualifiedNames).not.toContain("ProductResponse");
    expect(new Set(qualifiedNames)).toEqual(new Set(["MoneyRequest", "MoneyResponse"]));

    // Every published id is still unique — the point of the exercise.
    expect(new Set(overrides.map((o) => o.schemaId)).size).toBe(overrides.length);
  });

  it("emits a Program.cs lambda naming BOTH qualified ids", async () => {
    const program = (await filesFrom(TWO_CONTEXT_SRC)).get("Program.cs") ?? "";

    expect(program).toContain(
      '["Api.Application.Products.Requests.MoneyRequest"] = "ProductsMoneyRequest",',
    );
    expect(program).toContain(
      '["Api.Application.Orders.Requests.MoneyRequest"] = "OrdersMoneyRequest",',
    );
    // The lookup runs INSIDE CustomSchemaIds, after the Paged<> arm, and the
    // short-name fallback still stands for everything else.
    expect(program).toContain(
      "if (t.FullName is not null && collidingSchemaIds.TryGetValue(t.FullName, out var qualified))",
    );
    expect(program.indexOf("var collidingSchemaIds")).toBeLessThan(
      program.indexOf("c.CustomSchemaIds(t =>"),
    );
    expect(program.indexOf('return stem + "Paged";')).toBeLessThan(
      program.indexOf("collidingSchemaIds.TryGetValue"),
    );
    expect(program).toContain("        return t.Name;");
  });

  it("leaves a collision-free project byte-identical", async () => {
    const files = await filesFrom(COLLISION_FREE_SRC);
    expect(dotnetSchemaIdOverrides(files)).toEqual([]);

    const program = files.get("Program.cs") ?? "";
    expect(program).toContain(UNQUALIFIED_LAMBDA);
    expect(program).not.toContain("collidingSchemaIds");
    expect(program).not.toContain("Dictionary<string, string>");
  });
});
