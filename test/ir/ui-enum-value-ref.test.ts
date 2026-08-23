// A bare enum-member reference in a `ui` body — `o.vis == Public`.
//
// A page / component / store body has NO enclosing `ctx` (a ui sits at the
// system level and may read several contexts through its api params), and both
// enum scans in `resolveNameRef` were gated on `env.ctx`.  So the reference
// lowered to `refKind: "unknown"` and every frontend emitted an unresolved
// placeholder — `/* unresolved: Public */ undefined` on the shared-walker
// frontends, an undeclared identifier in Dart, an unbound variable on HEEx —
// with ZERO diagnostics at parse.  Valid `.ddd` in, silently wrong app out.
//
// The lowering half of the fix stamps `refKind: "enum-value"` (with the owning
// `enumName`) for those refs, exactly as a context body already did.  Two
// invariants have to hold alongside it: a same-named local still SHADOWS the
// enum member, and an `e2e` test body — also ctx-less — must keep leaving the
// name unresolved so `loom.e2e-unresolved-ref` can tell the author to write the
// wire string (test/ir/e2e-unresolved-ref.test.ts).

import { describe, expect, it } from "vitest";
import type { ExprIR } from "../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../_helpers/index.js";

const SOURCE = (pageDecls: string): string => `
system EnumRef {
  subdomain Ops {
    context Ops {
      enum Visibility { Public, Private }
      aggregate Doc with crudish {
        title: string
        vis: Visibility
      }
      repository Docs for Doc { }
    }
  }
  api OpsApi from Ops
  ui Web {
    api ops: OpsApi
    page Board {
      route: "/board"
${pageDecls}
    }
  }
  storage primary { type: postgres }
  resource opsState { for: Ops, kind: state, use: primary }
  deployable svc { platform: node contexts: [Ops] dataSources: [opsState] serves: OpsApi port: 4000 }
  deployable web { platform: react targets: svc ui: Web { ops: svc } port: 3000 }
}
`;

/** Every `ref` IR anywhere in an expression tree, in no particular order. */
function refs(e: unknown, out: Array<Extract<ExprIR, { kind: "ref" }>> = []) {
  if (!e || typeof e !== "object") return out;
  if (Array.isArray(e)) {
    for (const x of e) refs(x, out);
    return out;
  }
  const node = e as { kind?: string };
  if (node.kind === "ref") out.push(e as Extract<ExprIR, { kind: "ref" }>);
  for (const v of Object.values(e)) refs(v, out);
  return out;
}

async function pageRefs(pageDecls: string) {
  const model = await buildLoomModel(SOURCE(pageDecls));
  const page = model.systems[0].uis[0].pages[0];
  return refs(page.body);
}

describe("ui body — bare enum-value reference", () => {
  it("stamps `enum-value` + the owning enum on a page-body ref", async () => {
    const found = (await pageRefs(`      body: Stack { Text(Public) }`)).find(
      (r) => r.name === "Public",
    );
    expect(found).toBeDefined();
    expect(found?.refKind).toBe("enum-value");
    expect(found?.enumName).toBe("Visibility");
    expect(found?.type).toEqual({ kind: "enum", name: "Visibility" });
  });

  it("resolves it in a comparison against an enum-typed state field", async () => {
    const cmp = (
      await pageRefs(`      state { vis: Visibility = Public }
      body: Stack { Text(vis == Public ? "pub" : "priv") }`)
    ).filter((r) => r.name === "Public");
    expect(cmp.length).toBeGreaterThan(0);
    for (const r of cmp) expect(r.refKind).toBe("enum-value");
  });

  it("still lets a same-named page binding shadow the enum member", async () => {
    const found = (
      await pageRefs(`      state { Public: bool = false }
      body: Stack { Text(Public) }`)
    ).find((r) => r.name === "Public");
    // A page `state` field binds as a local, resolved BEFORE any enum scan.
    expect(found?.refKind).toBe("let");
  });
});
