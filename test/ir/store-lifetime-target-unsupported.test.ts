// ---------------------------------------------------------------------------
// `loom.store-lifetime-target-unsupported` — the `persist:` lifetime ladder is
// gated on the two frontends that don't implement it.
//
// `store-checks.ts` already refuses a non-`memory` lifetime on LiveView
// (`loom.store-lifetime-liveview-invalid`), because a server-rendered
// per-process struct has no browser storage.  The SAME gap exists, ungated, on
// two more targets:
//
//   flutter — `flutter/store-builder.ts` writes a `// TODO(flutter
//       full-parity)` comment and then builds the store IN-MEMORY anyway.  A
//       comment in emitted Dart is not a diagnostic: `ddd parse` is clean and
//       `flutter analyze` is clean.
//   feliz   — `src/generator/feliz` contains ZERO references to
//       `store.lifetime`; the store folds into the single Elmish `Model` and
//       the lifetime is dropped without even a comment.
//
// Both are IMPLEMENTABLE and planned.  `LIFETIME_UNSUPPORTED_PLATFORMS` is a
// RATCHET: the wave-2 task that implements a target deletes its entry (and the
// matching case here), so a stale allowance cannot survive the fix.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { LoomDiagnostic } from "../../src/ir/validate/checks/diagnostic.js";
import { validateStores } from "../../src/ir/validate/checks/store-checks.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const CODE = "loom.store-lifetime-target-unsupported";

/** `framework` and the web deployable's `platform` move together — a
 *  `platform: feliz` / `platform: flutter` deployable hosts only its own
 *  framework, which is why the gate keys on the PLATFORM. */
const wrap = (framework: string, platform: string, lifetime: string) => `
system Demo {
  subdomain S {
    context C {
      aggregate Customer { name: string }
      repository Customers for Customer { }
    }
  }
  api A from S
  ui Web {
    framework: ${framework}
    api C: A
    store Cart${lifetime ? ` persist: ${lifetime}` : ""} {
      state { count: int = 0 }
      action bump() { count := count + 1 }
    }
    page X { route: "/x"  body: Stack { Heading { Cart.count, level: 3 } } }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node  contexts: [C]  dataSources: [st]  serves: A  port: 3000 }
  deployable web { platform: ${platform}  targets: api  port: 3001  ui: Web { C: api } }
}`;

async function diagnostics(framework: string, platform: string, lifetime: string) {
  const { model, errors } = await parseString(wrap(framework, platform, lifetime));
  if (errors.length) throw new Error(`unexpected parse/validation errors:\n${errors.join("\n")}`);
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

const codes = async (framework: string, platform: string, lifetime: string): Promise<string[]> =>
  (await diagnostics(framework, platform, lifetime)).map((d) => d.code);

describe("loom.store-lifetime-target-unsupported — the gate", () => {
  for (const target of ["feliz", "flutter"] as const) {
    for (const lifetime of ["local", "session", "url"] as const) {
      it(`flags \`persist: ${lifetime}\` on a ${target}-hosted store`, async () => {
        expect(await codes(target, target, lifetime)).toContain(CODE);
      });
    }

    it(`is an error naming the store, the lifetime and ${target}`, async () => {
      const d = (await diagnostics(target, target, "local")).find((x) => x.code === CODE);
      expect(d?.severity).toBe("error");
      expect(d?.message).toMatch(/store 'Cart'/);
      expect(d?.message).toMatch(/persist: local/);
      expect(d?.message).toMatch(new RegExp(target));
    });
  }
});

describe("loom.store-lifetime-target-unsupported — what it must NOT flag", () => {
  for (const target of ["feliz", "flutter"] as const) {
    it(`POSITIVE CONTROL: an in-memory store on ${target} is clean`, async () => {
      expect(await codes(target, target, "")).not.toContain(CODE);
    });
  }

  it("POSITIVE CONTROL: `persist: local` on a SPA frontend is clean — it ships there", async () => {
    expect(await codes("react", "static", "local")).not.toContain(CODE);
    expect(await codes("svelte", "static", "url")).not.toContain(CODE);
  });

  // A LiveView deployable is `platform: elixir` and takes no `targets:`, so
  // this one case is driven off a synthetic IR (the same shape the existing
  // `loom.store-lifetime-liveview-invalid` case in store.test.ts uses).  The
  // point is that the new gate keys on the PLATFORM set and does not widen to
  // cover a target the liveview-specific code already owns.
  it("does not double-report on LiveView — that stays the liveview-specific code", () => {
    const diags: LoomDiagnostic[] = [];
    validateStores(
      {
        systems: [
          {
            uis: [
              {
                name: "Web",
                stores: [{ name: "Cart", lifetime: "url", state: [], actions: [] }],
                pages: [],
                components: [],
                framework: "phoenixLiveView",
              },
            ],
            deployables: [
              { name: "web", platform: "elixir", uiName: "Web", uiFramework: "phoenixLiveView" },
            ],
          },
        ],
      } as never,
      diags,
    );
    expect(diags.map((d) => d.code)).toContain("loom.store-lifetime-liveview-invalid");
    expect(diags.map((d) => d.code)).not.toContain(CODE);
  });
});
