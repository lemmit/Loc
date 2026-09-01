// The dev-stub `x-loom-dev-claims` header must carry a declared `string[]`
// claim on EVERY backend, not just node.
//
// The bug this pins: dotnet, python, java and elixir each built their claim
// mapper over string-typed fields only, so an array claim was silently
// discarded and the field kept its built-in EMPTY LIST.  Every
// `requires currentUser.permissions.contains(…)` gate then failed closed there
// whatever the caller sent — no diagnostic, no failing test, and `docs/auth.md`
// promising the header "drives every generated backend identically".
//
// Each case asserts BOTH halves, because either alone passes vacuously:
//   • the array claim IS read from the header, and
//   • the string claim still is (the pre-existing behaviour, unbroken).
// Plus a negative: a backend must not emit a merge for a claim shape it cannot
// decode, which is what keeps `devClaimKind`'s narrowness honest.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const SOURCE = `system Guarded {
  user { id: string  permissions: string[]  seat: int }

  subdomain Ops {
    permissions { manage }

    context Warehouse {
      aggregate Shipment {
        reference: string
        create(reference: string) {
          requires currentUser.permissions.contains(permissions.manage)
        }
      }
    }
  }

  api WarehouseApi from Ops
  storage primary { type: postgres }
  resource warehouseState { for: Warehouse, kind: state, use: primary }

  deployable d {
    platform: __PLATFORM__
    contexts: [Warehouse]
    dataSources: [warehouseState]
    serves: WarehouseApi
    port: 4000
    auth: required
  }
}`;

async function filesFor(platform: string): Promise<Map<string, string>> {
  return await generateSystemFiles(SOURCE.replace("__PLATFORM__", platform));
}

/** The one emitted file carrying the dev-stub verifier, per backend. */
function stubSource(files: Map<string, string>, match: RegExp): string {
  const hit = [...files.entries()].find(
    ([path, body]) => match.test(path) && body.includes("x-loom-dev-claims"),
  );
  expect(
    hit,
    `no emitted file matching ${match} contains the x-loom-dev-claims stub. ` +
      `Emitted: ${[...files.keys()].filter((p) => match.test(p)).join(", ")}`,
  ).toBeDefined();
  return hit![1];
}

describe("dev-stub claim mapper carries a declared string[] claim", () => {
  it("python reads the array claim, still reads the string claim, and skips the int", async () => {
    const src = stubSource(await filesFor("python"), /\.py$/);
    expect(src).toContain('claims.get("permissions")');
    expect(src).toContain("isinstance(_e, str) for _e in _v");
    expect(src).toContain('overrides["permissions"] = list(_v)');
    // Unbroken: the string claim keeps its own str-guarded arm.
    expect(src).toContain('if isinstance((_v := claims.get("id")), str):');
    // Narrowness: `seat: int` is not a carryable shape, so no arm exists.
    expect(src).not.toContain('claims.get("seat")');
  });

  it("java decodes the array claim element-checked, keeps the string arm, skips the int", async () => {
    const src = stubSource(await filesFor("java"), /DevStubUserVerifier\.java$/);
    expect(src).toContain('devClaimStringList(claims, "permissions"');
    // Element-checked: a mixed array must fall back, not half-fill the list.
    expect(src).toContain("if (!e.isTextual()) return fallback;");
    expect(src).toContain('claims.get("id").isTextual()');
    expect(src).not.toContain('"seat"');
  });

  it("dotnet decodes the array claim element-checked, keeps the string arm, skips the int", async () => {
    const src = stubSource(await filesFor("dotnet"), /DevStubUserVerifier\.cs$/);
    expect(src).toContain('"permissions" => DevClaimStringList(prop.Value)');
    expect(src).toContain("if (element.ValueKind != JsonValueKind.String) return null;");
    // List<string> needs its using, or the generated project will not compile.
    expect(src).toContain("using System.Collections.Generic;");
    expect(src).toContain('"id" => prop.Value.ValueKind == JsonValueKind.String');
    expect(src).not.toContain('"seat" =>');
  });

  it("elixir decodes the array claim element-checked, keeps the string arm, skips the int", async () => {
    const src = stubSource(await filesFor("elixir"), /\.ex$/);
    expect(src).toContain('maybe_put_list_claim(:permissions, claims["permissions"])');
    expect(src).toContain("Enum.all?(value, &is_binary/1)");
    expect(src).toContain('maybe_put_claim(:id, claims["id"])');
    // Scoped to the MERGE: `build_user` reads every declared field from the
    // stub claims map, so a bare `claims["seat"]` check would match that
    // instead and pass for the wrong reason.
    expect(src).not.toContain("maybe_put_claim(:seat");
    expect(src).not.toContain("maybe_put_list_claim(:seat");
  });

  it("node still carries the array claim (the reference behaviour, unbroken)", async () => {
    const src = stubSource(await filesFor("node"), /dev-stub\.ts$/);
    // Hono spreads the decoded JSON wholesale — no per-field arm to assert, so
    // assert the spread itself is intact rather than inventing a filter here.
    expect(src).toContain("JSON.parse(Buffer.from(injected");
  });
});
