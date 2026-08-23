// Cross-backend regression for `loom.domain-service-cross-context-read`
// (the emitted-output half; the validator half is
// `test/ir/domain-service-validation.test.ts`).
//
// THE SHAPE.  A `domainService` in context `Ordering` whose body reads context
// `Billing`'s repository.  `lowerDomainService` indexes the repositories it
// resolves reads against from the ENCLOSING context's members alone, so the
// receiver never lowers to a `repo-read` Call — it stays a `ref` with
// `refKind: "unknown"`.  Consequences, all silent before the gate:
// `classifyDomainServiceTier` calls the op `pure`, `readPortsForOperation`
// derives no port so no backend threads a repository handle in, and every
// backend renders the unresolved receiver VERBATIM.
//
// This test does two things, in this order:
//
//   1. proves the emission is genuinely broken on ALL FIVE backends (the
//      evidence that made this a model-level gate rather than five per-backend
//      fixes), and
//   2. proves phase ⑦ rejects the model, so no user reaches that emission.
//
// `generateSystemFiles` asserts phases ① and ④ but deliberately does NOT run
// phase ⑦ (`validateLoomModel`) — which is exactly why the emission below was
// reachable in the first place, and why (2) is asserted separately here.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../_helpers/generate.js";
import { parseString } from "../_helpers/parse.js";

/** `context Ordering`'s `Naming.isFree` reads `context Billing`'s `Customers`.
 *  Both contexts ride ONE deployable, so this is not a distribution question —
 *  the two contexts are compiled into the same project and the name still does
 *  not resolve. */
const SRC = (platform: string) => `
system Shop {
  subdomain Sales {
    context Billing {
      aggregate Customer { name: string }
      repository Customers for Customer {
        find byName(name: string): Customer? where this.name == name
      }
    }
    context Ordering {
      aggregate Order { ref: string }
      repository Orders for Order { }
      domainService Naming {
        operation isFree(r: string): bool {
          return Customers.byName(r) == null
        }
      }
    }
  }
  storage primary { type: postgres }
  resource billingState { for: Billing, kind: state, use: primary }
  resource orderingState { for: Ordering, kind: state, use: primary }
  deployable app {
    platform: ${platform}
    contexts: [Billing, Ordering]
    dataSources: [billingState, orderingState]
    port: 4000
  }
}
`;

/**
 * Per backend: the generated domain-service file, and the DANGLING IDENTIFIER
 * it renders for the unresolved cross-context receiver.  Captured 2026-08-23 by
 * generating this exact system on each backend:
 *
 *   TS      `return Customers.byName(r) === null;` in a file importing nothing
 *           that defines `Customers`               → TS2304.
 *   .NET    `Customers.ByName(r)` in a static class → CS0103.
 *   Java    `Customers.byName(r)`                   → "cannot find symbol".
 *   Python  `Customers.by_name(r)`                  → NameError (F821).
 *   Phoenix `is_nil(customers.by_name(r))` — the ref is snake-cased into a
 *           LOCAL that was never bound            → "undefined variable".
 *
 * If a backend ever learns to render a cross-context read for real, the gate is
 * what has to change first — this table is the evidence it rests on.
 */
const BACKENDS: { platform: string; file: string; dangling: string }[] = [
  { platform: "node", file: "domain/services.ts", dangling: "Customers.byName(r)" },
  { platform: "dotnet", file: "Domain/Services/Naming.cs", dangling: "Customers.ByName(r)" },
  { platform: "java", file: "domain/services/Naming.java", dangling: "Customers.byName(r)" },
  { platform: "python", file: "app/domain/services/naming.py", dangling: "Customers.by_name(r)" },
  { platform: "elixir", file: "domain/services/naming.ex", dangling: "customers.by_name(r)" },
];

function bySuffix(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  if (!key) {
    throw new Error(`no generated file ending in ${suffix}; got:\n${[...files.keys()].join("\n")}`);
  }
  return files.get(key)!;
}

describe("domainService cross-context read — the emission the gate stands in front of", () => {
  for (const { platform, file, dangling } of BACKENDS) {
    it(`${platform} emits a dangling identifier for the cross-context receiver`, async () => {
      const out = bySuffix(await generateSystemFiles(SRC(platform)), file);
      expect(out).toContain(dangling);
      // Nothing in the file defines or imports the receiver — that is what
      // makes it dangling rather than merely oddly named.
      const definitions = out
        .split("\n")
        .filter((l) => /import|using|defmodule|require|from /.test(l) && /Customers/i.test(l));
      expect(definitions).toEqual([]);
    });
  }

  it("phase ⑦ rejects the model, so none of that emission is reachable", async () => {
    const { model, errors } = await parseString(SRC("node"));
    expect(errors).toEqual([]); // phases ① + ④ are clean — this was the SILENT part
    const diags = validateLoomModel(enrichLoomModel(lowerModel(model)));
    const hit = diags.find((d) => d.code === "loom.domain-service-cross-context-read");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
    expect(hit!.source).toBe("Ordering/Naming.isFree");
  });

  it("the gate is platform-independent — it fires for every backend's system", async () => {
    for (const { platform } of BACKENDS) {
      const { model } = await parseString(SRC(platform));
      const diags = validateLoomModel(enrichLoomModel(lowerModel(model)));
      expect(
        diags.filter((d) => d.code === "loom.domain-service-cross-context-read"),
        `expected the cross-context gate to fire on platform ${platform}`,
      ).toHaveLength(1);
    }
  });
});
