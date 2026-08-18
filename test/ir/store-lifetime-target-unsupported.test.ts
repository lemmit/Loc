// ---------------------------------------------------------------------------
// `loom.store-lifetime-target-unsupported` — the `persist:` lifetime ladder is
// gated on the frontend that doesn't implement it, and on the FIELD TYPES the
// one that does can't carry.
//
// `store-checks.ts` already refuses a non-`memory` lifetime on LiveView
// (`loom.store-lifetime-liveview-invalid`), because a server-rendered
// per-process struct has no browser storage.  The SAME gap exists, ungated, on:
//
//   feliz   — `src/generator/feliz` contains ZERO references to
//       `store.lifetime`; the store folds into the single Elmish `Model` and
//       the lifetime is dropped without even a comment.
//
// `LIFETIME_UNSUPPORTED_PLATFORMS` is a RATCHET: the task that implements a
// target deletes its entry (and the matching case here), so a stale allowance
// cannot survive the fix.  FLUTTER did exactly that — `flutter/store-persist.ts`
// ships the ladder (a shared_preferences seed + a `ref.listenSelf` mirror, and
// `Uri.base` / `SystemNavigator` for the `url` tier), so the platform-wide arm
// is gone and only the narrower FIELD-scoped half of the same code remains: the
// Dart codec (`ir/util/flutter-persist-codec.ts`) has no total conversion for a
// `json` / `File` / entity / value-object / optional cell, which would
// otherwise be silently dropped from the stored state.
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
const wrap = (framework: string, platform: string, lifetime: string, cells = "count: int = 0") => `
system Demo {
  subdomain S {
    context C {
      valueobject Money { amount: int  currency: string }
      aggregate Customer { name: string }
      repository Customers for Customer { }
    }
  }
  api A from S
  ui Web {
    framework: ${framework}
    api C: A
    store Cart${lifetime ? ` persist: ${lifetime}` : ""} {
      state { ${cells} }
      action bump() { count := count + 1 }
    }
    page X { route: "/x"  body: Stack { Heading { Cart.count, level: 3 } } }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node  contexts: [C]  dataSources: [st]  serves: A  port: 3000 }
  deployable web { platform: ${platform}  targets: api  port: 3001  ui: Web { C: api } }
}`;

async function diagnostics(framework: string, platform: string, lifetime: string, cells?: string) {
  const { model, errors } = await parseString(wrap(framework, platform, lifetime, cells));
  if (errors.length) throw new Error(`unexpected parse/validation errors:\n${errors.join("\n")}`);
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

const codes = async (
  framework: string,
  platform: string,
  lifetime: string,
  cells?: string,
): Promise<string[]> =>
  (await diagnostics(framework, platform, lifetime, cells)).map((d) => d.code);

describe("loom.store-lifetime-target-unsupported — the gate", () => {
  for (const lifetime of ["local", "session", "url"] as const) {
    it(`flags \`persist: ${lifetime}\` on a feliz-hosted store`, async () => {
      expect(await codes("feliz", "feliz", lifetime)).toContain(CODE);
    });
  }

  it("is an error naming the store, the lifetime and feliz", async () => {
    const d = (await diagnostics("feliz", "feliz", "local")).find((x) => x.code === CODE);
    expect(d?.severity).toBe("error");
    expect(d?.message).toMatch(/store 'Cart'/);
    expect(d?.message).toMatch(/persist: local/);
    expect(d?.message).toMatch(/feliz/);
  });
});

describe("loom.store-lifetime-target-unsupported — the flutter FIELD-scoped half", () => {
  // The ladder ships on flutter, so the platform-wide arm is gone …
  for (const lifetime of ["local", "session", "url"] as const) {
    it(`does NOT flag \`persist: ${lifetime}\` on a flutter-hosted store of covered cells`, async () => {
      expect(await codes("flutter", "flutter", lifetime)).not.toContain(CODE);
    });
  }

  // … but a cell whose Dart codec has no total conversion is still refused,
  // because it would silently vanish from the stored state.
  for (const [what, cells] of [
    ["a value-object cell", "count: int = 0  price: Money"],
    ["a File cell", "count: int = 0  doc: File"],
    ["an optional cell", "count: int = 0  note: string?"],
    ["a json cell", "count: int = 0  blob: json"],
  ] as const) {
    it(`flags ${what}`, async () => {
      expect(await codes("flutter", "flutter", "local", cells)).toContain(CODE);
    });
  }

  it("names the offending FIELD, not just the store", async () => {
    const d = (
      await diagnostics("flutter", "flutter", "local", "count: int = 0  price: Money")
    ).find((x) => x.code === CODE);
    expect(d?.severity).toBe("error");
    expect(d?.message).toMatch(/store 'Cart'/);
    expect(d?.message).toMatch(/field 'price'/);
    expect(d?.message).toMatch(/flutter/);
  });

  it("POSITIVE CONTROL: every covered scalar + array cell passes", async () => {
    const covered =
      'count: int = 0  label: string = ""  flag: bool = false  amount: money  seenAt: datetime  tags: string[]';
    expect(await codes("flutter", "flutter", "local", covered)).not.toContain(CODE);
  });
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
