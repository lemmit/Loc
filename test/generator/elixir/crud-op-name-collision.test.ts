import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// Regression: a `crudish` aggregate injects a canonical `update` operation.
// The Phoenix backend emitted BOTH a standard CRUD `:update` action (route +
// controller `def update` + domain `define :update_<agg>`) AND the per-op
// `:update` (POST /:id/update) on top — a duplicate `def update/2` clause +
// duplicate Ash code-interface define that failed `--warnings-as-errors`.
//
// Resolution: the **operation wins** (it's the canonical cross-backend form —
// Hono/.NET serve `POST /:id/update` with an `UpdateXRequest` the conformance
// gate compares).  The redundant standard CRUD action of that name (Phoenix-
// controller-only; never in the OpenAPI/Hono) is suppressed.
const FIXTURE = `system S {
  subdomain Cat {
    context Cat {
      enum Tier { Free, Pro }
      aggregate Widget with crudish {
        name: string
        size: int
        tier: Tier
        derived display: string = name
        operation refresh() { }
      }
      repository Widgets for Widget { }
    }
  }
  api CatApi from Cat
  storage primary { type: postgres }
  resource catState { for: Cat, kind: state, use: primary }
  deployable web {
    platform: elixir
    contexts: [Cat]
    dataSources: [catState]
    serves: CatApi
    port: 4000
  }
}
`;

async function files(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(errors.join("\n"));
  return generateSystems(model).files;
}

function get(fs: Map<string, string>, re: RegExp): string {
  for (const [k, v] of fs) if (re.test(k)) return v;
  throw new Error(`no file matched ${re}`);
}

function count(haystack: string, re: RegExp): number {
  return (haystack.match(re) ?? []).length;
}

describe("phoenix CRUD-verb operation-name collision (crudish update)", () => {
  it("emits exactly one `def update` / one `define :update_widget` (no duplicate)", async () => {
    const fs = await files();
    expect(count(get(fs, /widgets_controller\.ex$/), /def update\(/g)).toBe(1);
    expect(count(get(fs, /\/cat\.ex$/), /define :update_widget\b/g)).toBe(1);
  });

  it("keeps the operation form (the cross-backend canonical), not the standard PATCH", async () => {
    const fs = await files();
    const ctrl = get(fs, /widgets_controller\.ex$/);
    const dom = get(fs, /\/cat\.ex$/);
    // Operation form: positional code-interface call (matches the `args:` define),
    // not the standard PATCH `update_widget!(id, attrs)` Map.drop form.
    expect(ctrl).toContain('update_widget!(id, params["name"], params["size"], params["tier"])');
    expect(dom).toContain("define :update_widget, action: :update, args: [:name, :size, :tier]");
    // The per-op POST route is kept; the spurious standard PATCH is gone.
    const spec = get(fs, /api_spec\.ex$/);
    expect(spec).toMatch(/\/widgets\/\{id\}\/update/);
  });

  it("still emits non-CRUD-verb operations (the suppression is targeted)", async () => {
    const fs = await files();
    expect(get(fs, /widgets_controller\.ex$/)).toContain("def refresh(");
    expect(get(fs, /\/cat\.ex$/)).toContain("define :refresh_widget");
  });
});
