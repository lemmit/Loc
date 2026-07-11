import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseString } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// Regression: a strict `>` / `<` numeric invariant on a NON-integer field
// (decimal / money) must emit a TRUE EXCLUSIVE wire/changeset bound on every
// backend — not the `n±1` inclusive fold, which the classifier only applies
// soundly to integer fields.  `weight > 0.5` on a decimal field previously
// emitted `z.number().min(1.5)` (and the .NET / Java / Ecto / pydantic
// equivalents), rejecting every valid value in the open interval (0.5, 1.5).
//
// The aggregate carries both a decimal field with strict bounds and an
// integer field with a strict bound, so each backend's assertions double as
// the byte-identical-integer control: `qty > 4` must still fold to the
// inclusive `>= 5` form the trick has always produced.
// ---------------------------------------------------------------------------

const DDL = (platform: string, port: number) => `
system Demo {
  subdomain S {
    context C {
      aggregate Parcel ids guid with crudish {
        weight: decimal
        qty: int
        invariant weight > 0.5
        invariant weight < 2.0
        invariant qty > 4
      }
      repository ParcelRepo for Parcel { }
    }
  }
  api ParcelApi from S
  deployable svc { platform: ${platform} contexts: [C] serves: ParcelApi port: ${port} }
}
`;

async function filesFor(platform: string, port: number): Promise<Map<string, string>> {
  const { model, errors } = await parseString(DDL(platform, port));
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

function findFile(files: Map<string, string>, re: RegExp): string {
  const hit = [...files.entries()].find(([k]) => re.test(k));
  if (!hit) throw new Error(`no file matching ${re} — have:\n${[...files.keys()].join("\n")}`);
  return hit[1];
}

describe("strict numeric bound on a decimal field emits an exclusive validator", () => {
  it("zod (node/Hono): `.gt(0.5)` / `.lt(2)`, integer bound stays `.min(5)`", async () => {
    const files = await filesFor("node", 3000);
    const routes = findFile(files, /parcel\.routes\.ts$/i);
    expect(routes).toContain(".gt(0.5)");
    expect(routes).toContain(".lt(2)");
    // No inclusive decimal fold leaked through.
    expect(routes).not.toContain(".min(1.5)");
    // Integer strict bound is byte-identical to the legacy inclusive fold.
    expect(routes).toContain(".min(5)");
  });

  it("pydantic (python): `Field(gt=0.5, lt=2)`, integer bound stays `ge=5`", async () => {
    const files = await filesFor("python", 8000);
    const routes = findFile(files, /parcel_routes\.py$/i);
    expect(routes).toMatch(/weight:.*=\s*Field\([^)]*gt=0\.5[^)]*lt=2/);
    expect(routes).not.toContain("ge=1.5");
    expect(routes).toMatch(/qty:.*=\s*Field\([^)]*ge=5/);
  });

  it("Ecto (elixir): `greater_than: 0.5` / `less_than: 2`, integer bound stays `greater_than_or_equal_to: 5`", async () => {
    const files = await filesFor("elixir", 4000);
    const changeset = findFile(files, /parcel_changeset\.ex$/i);
    expect(changeset).toContain("greater_than: 0.5");
    expect(changeset).toContain("less_than: 2");
    expect(changeset).not.toContain("greater_than_or_equal_to: 1.5");
    expect(changeset).toContain("greater_than_or_equal_to: 5");
  });

  it("FluentValidation (.NET): `.GreaterThan(0.5m)` / `.LessThan(2m)`, integer bound stays `.GreaterThanOrEqualTo(5)`", async () => {
    const files = await filesFor("dotnet", 5000);
    const validator = findFile(files, /CreateParcelCommandValidator\.cs$/i);
    expect(validator).toContain(".GreaterThan(0.5m)");
    expect(validator).toContain(".LessThan(2m)");
    expect(validator).not.toContain(".GreaterThanOrEqualTo(1.5)");
    expect(validator).toContain(".GreaterThanOrEqualTo(5)");
  });

  it("Java (Spring): strict `> 0.5` / `< 2` via BigDecimal.compareTo, integer bound stays `>= 5`", async () => {
    const files = await filesFor("java", 8080);
    const validator = findFile(files, /ParcelValidators\.java$/i);
    expect(validator).toContain('new java.math.BigDecimal("0.5")) > 0');
    expect(validator).toContain('new java.math.BigDecimal("2")) < 0');
    expect(validator).not.toContain('new java.math.BigDecimal("1.5")) >= 0');
    // Integer field keeps the plain `>= 5` inclusive fold.
    expect(validator).toContain("qty >= 5");
  });
});
