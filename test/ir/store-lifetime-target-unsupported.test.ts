// ---------------------------------------------------------------------------
// `loom.store-lifetime-target-unsupported` — the `persist:` lifetime ladder is
// gated on the frontend that doesn't implement it.
//
// `store-checks.ts` already refuses a non-`memory` lifetime on LiveView
// (`loom.store-lifetime-liveview-invalid`), because a server-rendered
// per-process struct has no browser storage.  The SAME gap existed, ungated, on
// two more targets:
//
//   flutter — `flutter/store-builder.ts` writes a `// TODO(flutter
//       full-parity)` comment and then builds the store IN-MEMORY anyway.  A
//       comment in emitted Dart is not a diagnostic: `ddd parse` is clean and
//       `flutter analyze` is clean.
//   feliz   — DRAINED (M-T1.20).  `generator/feliz/store-persist.ts` now
//       implements the full ladder: Web Storage hydration at `init`, an
//       `updateWithPersist` write-back wrapper, and a `popstate` Elmish
//       subscription for the `url` tier.  Its arm of
//       `LIFETIME_UNSUPPORTED_PLATFORMS` was deleted in the same PR, per the
//       ratchet — which is why the platform loop below is flutter-only.
//
// What SURVIVES on feliz is narrower and field-scoped: persistence there
// crosses the JS boundary per FIELD, so a field type with no total F#
// conversion (datetime / duration / guid / enum / entity / value object, and
// arrays of them) still cannot ride the ladder.  That fires the SAME code
// through the `#field` message variant — one code, two scopes, so the register
// keeps one row.
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
const wrap = (framework: string, platform: string, lifetime: string, field = "count: int = 0") => `
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
      state { ${field} }
      action bump() { }
    }
    page X { route: "/x"  body: Stack { Heading { "x", level: 3 } } }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node  contexts: [C]  dataSources: [st]  serves: A  port: 3000 }
  deployable web { platform: ${platform}  targets: api  port: 3001  ui: Web { C: api } }
}`;

async function diagnostics(framework: string, platform: string, lifetime: string, field?: string) {
  const { model, errors } = await parseString(wrap(framework, platform, lifetime, field));
  if (errors.length) throw new Error(`unexpected parse/validation errors:\n${errors.join("\n")}`);
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

const codes = async (
  framework: string,
  platform: string,
  lifetime: string,
  field?: string,
): Promise<string[]> =>
  (await diagnostics(framework, platform, lifetime, field)).map((d) => d.code);

describe("loom.store-lifetime-target-unsupported — the platform gate", () => {
  for (const lifetime of ["local", "session", "url"] as const) {
    it(`flags \`persist: ${lifetime}\` on a flutter-hosted store`, async () => {
      expect(await codes("flutter", "flutter", lifetime)).toContain(CODE);
    });
  }

  it("is an error naming the store, the lifetime and flutter", async () => {
    const d = (await diagnostics("flutter", "flutter", "local")).find((x) => x.code === CODE);
    expect(d?.severity).toBe("error");
    expect(d?.message).toMatch(/store 'Cart'/);
    expect(d?.message).toMatch(/persist: local/);
    expect(d?.message).toMatch(/flutter/);
  });
});

describe("loom.store-lifetime-target-unsupported — the feliz FIELD gate", () => {
  // The platform arm is gone; what remains is per-field, and only for a type
  // with no total F# conversion.
  it("flags a datetime field in a persisted feliz store", async () => {
    const d = (await diagnostics("feliz", "feliz", "local", "at: datetime")).find(
      (x) => x.code === CODE,
    );
    expect(d?.severity).toBe("error");
    expect(d?.message).toMatch(/field 'at'/);
    expect(d?.message).toMatch(/feliz/);
  });

  it("does NOT flag the covered scalar / array types — they ride the ladder", async () => {
    for (const field of [
      "count: int = 0",
      'note: string = ""',
      "ok: bool",
      "price: money",
      "tags: string[]",
    ]) {
      expect(await codes("feliz", "feliz", "local", field)).not.toContain(CODE);
    }
  });

  it("does NOT fire on a feliz `memory` store, whatever the field type", async () => {
    expect(await codes("feliz", "feliz", "", "at: datetime")).not.toContain(CODE);
  });
});

describe("loom.store-lifetime-target-unsupported — what it must NOT flag", () => {
  it("POSITIVE CONTROL: an in-memory store on flutter is clean", async () => {
    expect(await codes("flutter", "flutter", "")).not.toContain(CODE);
  });

  it("POSITIVE CONTROL: the ladder SHIPS on feliz now — a persisted store is clean", async () => {
    expect(await codes("feliz", "feliz", "local")).not.toContain(CODE);
    expect(await codes("feliz", "feliz", "session")).not.toContain(CODE);
    expect(await codes("feliz", "feliz", "url")).not.toContain(CODE);
  });

  it("POSITIVE CONTROL: `persist: local` on a SPA frontend is clean — it ships there", async () => {
    expect(await codes("react", "static", "local")).not.toContain(CODE);
    expect(await codes("svelte", "static", "url")).not.toContain(CODE);
  });

  // A LiveView deployable is `platform: elixir` and takes no `targets:`, so
  // this one case is driven off a synthetic IR (the same shape the existing
  // `loom.store-lifetime-liveview-invalid` case in store.test.ts uses).  The
  // point is that the gate keys on the PLATFORM set and does not widen to
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
