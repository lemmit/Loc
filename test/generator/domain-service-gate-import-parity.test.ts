// Cross-backend RATCHET for row `F2-CB-C7-domainservice-in-requires-guard`.
//
// A `requires` gate that calls a `domainService` renders the call UNQUALIFIED
// on four of the five backends, so each hosting file needs the matching
// import/using or the generated project does not build:
//
//   | backend | call rendered            | import needed                                |
//   |---------|--------------------------|----------------------------------------------|
//   | dotnet  | `Rules.Fee(...)`         | `using D.Domain.Services;`                   |
//   | node    | `Rules.fee(...)`         | `import { Rules } from "../domain/services"`  |
//   | java    | `Rules.fee(...)`         | `import com.loom.d.domain.services.Rules;`    |
//   | python  | `fee(...)`               | `from app.domain.services.rules import fee`   |
//   | elixir  | fully qualified          | — (nothing to import)                        |
//
// **dotnet is FIXED** (`src/generator/dotnet/render-expr.ts` —
// `collectCsExprUsings`' `ns` is now required, so no collector can silently
// drop it; pinned by `dotnet/domain-service-gate-usings.test.ts`).
//
// **node / java / python are NOT** — they live in other packets' file trees
// (`src/platform/hono/**`, `src/generator/java/**`, `src/generator/python/**`)
// and this file is the HANDOFF, kept executable so the gap cannot go quiet.
// Each entry below asserts the import is STILL missing.  When the owning packet
// fixes its backend, this test fails on that entry — delete the row and add the
// positive assertion, the way every waiver register in this repo ratchets.
//
// The gap is real on all three, reproduced from the fixture below:
//   node   `d/http/order.routes.ts`                     → TS2304 'Rules'
//   java   `.../features/orders/OrderService.java`      → cannot find symbol Rules
//   python `d/app/http/order_routes.py`                 → F821 / NameError 'fee'

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

const SRC = (platform: string) => `
system C7 {
  subdomain S {
    context Ord {
      aggregate Order {
        code: string
        quantity: int = 0
        destroy {
          requires Rules.Fee(quantity) == 0
        }
        operation touch() requires Rules.Fee(quantity) == 0 {
          quantity := quantity + 1
        }
      }
      repository Orders for Order { }
      domainService Rules {
        operation Fee(q: int): int {
          return q
        }
      }
    }
  }
  api OrdApi from S
  storage primary { type: postgres }
  resource ordState { for: Ord, kind: state, use: primary }
  deployable d {
    platform: ${platform}
    contexts: [Ord]
    dataSources: [ordState]
    serves: OrdApi
    port: 4000
  }
}
`;

function bySuffix(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no generated file ending in ${suffix}`);
  return files.get(key)!;
}

/** The three backends whose gate-site import is still missing, with the file
 *  that hosts the unqualified call, the call text proving the site is reached,
 *  and the import that MUST appear once the owning packet fixes it. */
const STILL_MISSING = [
  {
    platform: "node",
    packet: "node-ts (src/platform/hono/**)",
    file: "http/order.routes.ts",
    call: "Rules.fee(",
    missingImport: 'from "../domain/services"',
  },
  {
    platform: "java",
    packet: "java (src/generator/java/**)",
    file: "features/orders/OrderService.java",
    call: "Rules.fee(",
    missingImport: "import com.loom.d.domain.services.Rules;",
  },
  {
    platform: "python",
    packet: "python (src/generator/python/**)",
    file: "app/http/order_routes.py",
    call: "fee(",
    missingImport: "from app.domain.services.rules import",
  },
] as const;

describe("domainService in a `requires` gate — cross-backend import parity", () => {
  it("dotnet emits the using (the fixed arm)", async () => {
    const files = await generateSystemFiles(SRC("dotnet"));
    const handler = bySuffix(files, "Application/Orders/Commands/DestroyOrderHandler.cs");
    expect(handler).toContain("Rules.Fee(");
    expect(handler).toContain("using D.Domain.Services;");
  });

  it("elixir needs no import — the call leaf is fully qualified", async () => {
    const files = await generateSystemFiles(SRC("elixir"));
    const hit = [...files.values()].find((c) => c.includes("Domain.Services.Rules.fee("));
    expect(hit, "elixir should render the service call fully qualified").toBeDefined();
  });

  for (const row of STILL_MISSING) {
    it(`HANDOFF — ${row.platform} (${row.packet}) still omits its import`, async () => {
      const files = await generateSystemFiles(SRC(row.platform));
      const host = bySuffix(files, row.file);
      // The gate site is reached — if this fails the fixture drifted, not the bug.
      expect(host, `${row.platform}: gate call site moved`).toContain(row.call);
      // RATCHET: when the owning packet adds the import this fails.  Delete this
      // row from STILL_MISSING and assert the import positively instead.
      expect(
        host,
        `${row.platform} now emits "${row.missingImport}" — F2-CB-C7 is fixed on this ` +
          `backend.  Remove it from STILL_MISSING and assert the import positively.`,
      ).not.toContain(row.missingImport);
    });
  }
});
