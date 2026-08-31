// ---------------------------------------------------------------------------
// `loom.store-lifetime-target-unsupported` — the `persist:` lifetime ladder is
// gated on the FIELD TYPES the frontends that implement it cannot carry.
//
// `store-checks.ts` refuses a non-`memory` lifetime on LiveView outright
// (`loom.store-lifetime-liveview-invalid`), because a server-rendered
// per-process struct has no browser storage.  The SAME gap once existed,
// ungated, on two SPA-adjacent targets — and both are DRAINED (M-T1.20):
//
//   feliz   — `generator/feliz/store-persist.ts` implements the full ladder:
//       Web Storage hydration at `init`, an `updateWithPersist` write-back
//       wrapper, and a `popstate` Elmish subscription for the `url` tier.
//   flutter — `generator/flutter/store-persist.ts` does the same: a
//       shared_preferences seed + a `ref.listenSelf` mirror, and `Uri.base` /
//       `SystemNavigator` for the `url` tier.
//
// `LIFETIME_UNSUPPORTED_PLATFORMS` was the RATCHET behind the platform-wide
// arm — each implementing task deleted its entry — so with both entries gone
// the set drained to empty and the arm was deleted with it (an unfireable
// gate is dead code, not a safety net).
//
// What SURVIVES on both is narrower and FIELD-scoped: persistence crosses an
// untyped boundary per field, so a type with no total conversion in that
// language's codec still cannot ride the ladder — on feliz datetime /
// duration / guid / enum / entity / value object (and arrays of them), on
// flutter json / File / entity / value object / optional.  Those fire the SAME
// code through two message variants (`#field` for feliz, `#flutter-field` for
// flutter) — one code, two scopes, so the register keeps one row.
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
      action bump() { }
    }
    page X { route: "/x"  body: Stack { Heading { "x", level: 3 } } }
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

describe("loom.store-lifetime-target-unsupported — the feliz FIELD-scoped half", () => {
  // The ladder ships on feliz, so the platform-wide arm is gone …
  for (const lifetime of ["local", "session", "url"] as const) {
    it(`does NOT flag \`persist: ${lifetime}\` on a feliz-hosted store of covered cells`, async () => {
      expect(await codes("feliz", "feliz", lifetime)).not.toContain(CODE);
    });
  }

  // … but a cell with no total F# conversion is still refused.
  it("flags a datetime cell in a persisted feliz store", async () => {
    const d = (await diagnostics("feliz", "feliz", "local", "at: datetime")).find(
      (x) => x.code === CODE,
    );
    expect(d?.severity).toBe("error");
    // The STORE lives in `source` (the CLI prints `${code} ${source}: …`); the
    // message must not repeat it — see F2-FFE-9.
    expect(d?.source).toBe("store 'Cart'");
    expect(d?.message).toMatch(/field 'at'/);
    expect(d?.message).toMatch(/feliz/);
  });

  it("does NOT flag the covered scalar / array types — they ride the ladder", async () => {
    for (const cells of [
      "count: int = 0",
      'note: string = ""',
      "ok: bool",
      "price: money",
      "tags: string[]",
    ]) {
      expect(await codes("feliz", "feliz", "local", cells)).not.toContain(CODE);
    }
  });

  it("does NOT fire on a feliz `memory` store, whatever the cell type", async () => {
    expect(await codes("feliz", "feliz", "", "at: datetime")).not.toContain(CODE);
  });
});

describe("loom.store-lifetime-target-unsupported — the flutter FIELD-scoped half", () => {
  // The ladder ships on flutter too, so the platform-wide arm is gone …
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
    expect(d?.source).toBe("store 'Cart'");
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
