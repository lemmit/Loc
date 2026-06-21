import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { buildLoomModel } from "../_helpers/ir.js";

// The python / elixir backends do NOT consume `contextStamps` yet — the
// `auditable` audit columns are emitted but never populated.  `validateStampSupport`
// fails fast (never a silent drop), mirroring the java / dotnet stamp gates.
// A `with auditable` aggregate on each of these deployables must error with the
// per-family `loom.<family>-stamp-unsupported` code; the supported backends
// (java / dotnet / node — which now applies stamps via the Hono write hooks) and
// stamp-free models stay clean.

const src = (platform: string) => `
  system PS {
    user { id: guid  name: string }
    subdomain D { context Shop {
      aggregate Order with auditable { code: string }
      repository Orders for Order { }
    }}
    api A from D
    storage primary { type: postgres }
    resource st { for: Shop, kind: state, use: primary }
    deployable api { platform: ${platform}, contexts: [Shop], dataSources: [st], serves: A, port: 8081, auth: required }
  }
`;

describe("lifecycle-stamp backend support gate", () => {
  it.each([
    ["python", "loom.python-stamp-unsupported"],
    ["elixir", "loom.elixir-stamp-unsupported"],
  ])("gates `with auditable` on the %s backend fail-fast", async (platform, code) => {
    const loom = await buildLoomModel(src(platform));
    const errors = validateLoomModel(loom).filter((d) => d.code === code);
    expect(errors.length, `expected a ${code} diagnostic`).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain("does not yet apply lifecycle stamps");
  });

  it.each([
    "dotnet",
    "java",
    "node",
  ])("does NOT gate `with auditable` on the %s backend", async (platform) => {
    const loom = await buildLoomModel(src(platform));
    const stampErrors = validateLoomModel(loom).filter((d) =>
      /stamp-unsupported$/.test(d.code ?? ""),
    );
    expect(stampErrors).toEqual([]);
  });

  it("a stamp-free aggregate on node is clean", async () => {
    const loom = await buildLoomModel(`
      system PS {
        subdomain D { context Shop {
          aggregate Order { code: string }
          repository Orders for Order { }
        }}
        api A from D
        storage primary { type: postgres }
        resource st { for: Shop, kind: state, use: primary }
        deployable api { platform: node, contexts: [Shop], dataSources: [st], serves: A, port: 8081 }
      }
    `);
    const stampErrors = validateLoomModel(loom).filter((d) =>
      /stamp-unsupported$/.test(d.code ?? ""),
    );
    expect(stampErrors).toEqual([]);
  });
});
