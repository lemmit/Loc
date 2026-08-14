// `loom.frontend-collection-op-unsupported` (M-T1.3 Defect A).
//
// The stdlib collection ops are a BACKEND vocabulary — every backend renders
// them through `_expr/target.ts`'s `isCollectionOp` arm, the shared frontend
// walker (`_walker/walker-core.ts`) has NO such arm.  Its `member` arm emits
// `<recv>.<member>` and its `method-call` arm `<recv>.<member>(<args>)`,
// verbatim, so `QueryView { of: X.all, data: rows => Stat("n", rows.count) }`
// validated clean and then failed at `tsc` (TS2339 — `Property 'count' does
// not exist on type 'Customer[]'`), at `ng build`, at `dotnet fable`.
//
// This suite pins the gate that moves that failure to the model tier, and —
// just as importantly — pins the three things it must NOT flag:
//
//   1. a repository read (`Sales.Customer.all()`), which lowering marks
//      `isCollectionOp: true` off the NAME alone with a primitive receiver;
//   2. `.map(λ)`, the one op the frontend walkers really render (native
//      `Array.prototype.map` / HEEx `Enum.map/2`, DEBT-31);
//   3. `page { requires currentUser.permissions.contains(…) }`, a GATE
//      expression rendered by the closed `_frontend/gate-expr.ts` — whose one
//      admitted method is that very collection op.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

const CODE = "loom.frontend-collection-op-unsupported";

const wrap = (ui: string, framework = "react", webPlatform = "static") => `
system Demo {
  subdomain S {
    context C {
      aggregate Customer { name: string  tier: int }
      repository Customers for Customer { }
    }
  }
  api A from S
  ui Web {
    framework: ${framework}
    api C: A
    ${ui}
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node  contexts: [C]  dataSources: [st]  serves: A  port: 3000 }
  deployable web { platform: ${webPlatform}  targets: api  ui: Web { C: api }  port: 3001 }
}`;

async function codes(ui: string, framework = "react", webPlatform = "static"): Promise<string[]> {
  const { model, errors } = await parseString(wrap(ui, framework, webPlatform));
  if (errors.length) throw new Error(`unexpected parse/validation errors:\n${errors.join("\n")}`);
  return validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code);
}

/** The full diagnostics (not just codes) for message assertions. */
async function diags(ui: string) {
  const { model, errors } = await parseString(wrap(ui));
  if (errors.length) throw new Error(`unexpected parse/validation errors:\n${errors.join("\n")}`);
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

/** A page whose `QueryView` binds `rows` to the aggregate's `findAll` rows. */
const queryViewPage = (statValue: string) => `
  page X {
    route: "/x"
    body: QueryView { of: C.Customer.all, data: rows => Stat("n", ${statValue}) }
  }`;

describe("loom.frontend-collection-op-unsupported — the gate", () => {
  it("flags the property form (`rows.count`) — the reported defect", async () => {
    expect(await codes(queryViewPage("rows.count"))).toContain(CODE);
  });

  it("flags the call form (`rows.count()`)", async () => {
    expect(await codes(queryViewPage("rows.count()"))).toContain(CODE);
  });

  it("flags every other catalogue op reachable from a page body", async () => {
    for (const op of [
      "rows.where(o => o.tier > 1).count",
      "rows.sum(o => o.tier)",
      "rows.any(o => o.tier > 1)",
      "rows.all(o => o.tier > 1)",
      "rows.min(o => o.tier)",
      "rows.max(o => o.tier)",
      "rows.avg(o => o.tier)",
      "rows.distinct",
      "rows.take(3)",
      "rows.skip(3)",
      "rows.sortBy(o => o.tier)",
      'rows.map(o => o.name).join(", ")',
      "rows.first",
      "rows.firstOrNull",
    ]) {
      expect(await codes(queryViewPage(op)), `expected ${op} to be gated`).toContain(CODE);
    }
  });

  it("is target-agnostic — the same body fails on every SPA frontend", async () => {
    for (const [framework, platform] of [
      ["react", "static"],
      ["vue", "static"],
      ["svelte", "static"],
      ["angular", "static"],
      ["feliz", "feliz"],
      ["flutter", "flutter"],
    ] as const) {
      expect(
        await codes(queryViewPage("rows.count"), framework, platform),
        `expected the gate on ${framework}`,
      ).toContain(CODE);
    }
  });

  it("fires on Phoenix/HEEx too, even though its parallel walker maps `count`", async () => {
    // HEEx renders `Enum.count(@items)` here — but `join` / `first` are still
    // invalid Elixir, so it is not a portable escape hatch.  The gate stays
    // target-agnostic: the `.ddd` works on every target or fails on every one.
    const src = `
system Demo {
  subdomain S {
    context C {
      aggregate Customer { name: string  tier: int }
      repository Customers for Customer { }
    }
  }
  api A from S
  ui Web {
    page X { route: "/x"  body: QueryView { of: C.Customer.all, data: rows => Stat("n", rows.count) } }
  }
  deployable phoenixApp { platform: elixir  contexts: [C]  serves: A  ui: Web  port: 4000 }
}`;
    const { model, errors } = await parseString(src);
    if (errors.length) throw new Error(`unexpected parse/validation errors:\n${errors.join("\n")}`);
    expect(validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code)).toContain(
      CODE,
    );
  });

  it("reports ONE diagnostic per (host, op) — a repeated read is one mistake", async () => {
    const found = (
      await diags(`
      page X {
        route: "/x"
        body: QueryView { of: C.Customer.all, data: rows =>
          Stack(Stat("a", rows.count), Stat("b", rows.count), Stat("c", rows.sum(o => o.tier))) }
      }`)
    ).filter((d) => d.code === CODE);
    expect(found.map((d) => d.message.match(/`\.(\w+)`/)?.[1]).sort()).toEqual(["count", "sum"]);
  });

  it("names the op and points at the server-side read path", async () => {
    const d = (await diags(queryViewPage("rows.count"))).find((x) => x.code === CODE)!;
    expect(d.severity).toBe("error");
    expect(d.message).toContain("`.count`");
    expect(d.message).toContain("projection");
  });

  it("covers a page `derived` binding, a `state` initialiser and an action body", async () => {
    // `derived` — hoisted to a `useMemo` / `computed` / `$derived` by the walker.
    expect(
      await codes(`
      page X {
        route: "/x"
        derived n: int = [1, 2, 3].count
        body: Text("x")
      }`),
    ).toContain(CODE);
    // `state` initialiser.
    expect(
      await codes(`
      page X {
        route: "/x"
        state { n: int = [1, 2, 3].count }
        body: Text("x")
      }`),
    ).toContain(CODE);
    // Named action body — statements walk too.
    expect(
      await codes(`
      page X {
        route: "/x"
        state { n: int = 0 }
        action bump() { n := [1, 2, 3].count }
        body: Button("go", onClick: bump)
      }`),
    ).toContain(CODE);
  });

  it("covers a component body, not just a page", async () => {
    expect(
      await codes(`
      component Totals(rows: Customer[]) { body: Stat("n", rows.count) }
      page X { route: "/x"  body: Text("x") }`),
    ).toContain(CODE);
  });
});

describe("loom.frontend-collection-op-unsupported — what it must NOT flag", () => {
  it("leaves a repository read alone (`C.Customer.all` carries the flag off the NAME)", async () => {
    // `all` is BOTH a catalogue op and the auto-`findAll` read.  Lowering marks
    // the read `isCollectionOp: true` with a primitive receiver; requiring a
    // collection receiver is what keeps every scaffolded list page clean.
    expect(
      await codes(`
      page X {
        route: "/x"
        body: QueryView { of: C.Customer.all, data: rows => Table(Column("Name", o => o.name), rows: rows) }
      }`),
    ).not.toContain(CODE);
  });

  it("leaves `.map(λ)` alone — the one op the frontend walkers render (DEBT-31)", async () => {
    expect(
      await codes(`
      page X {
        route: "/x"
        body: Stack { For { each: [1, 2, 3].map(n => n), n => Bold { "x" } } }
      }`),
    ).not.toContain(CODE);
  });

  it("leaves a `requires` gate's `.contains(…)` alone — gate-expr.ts renders it", async () => {
    // `page { requires … }` is NOT walked by walker-core; it goes through the
    // closed `_frontend/gate-expr.ts`, whose one admitted method is exactly
    // this collection op (`.contains(x)` → `.includes(x)`).
    const src = `
system Demo {
  user { id: string  permissions: string[] }
  subdomain S {
    permissions { read }
    context C {
      aggregate Customer { name: string }
      repository Customers for Customer { }
    }
  }
  api A from S
  ui Web {
    framework: react
    api C: A
    page X { route: "/x"  requires currentUser.permissions.contains(permissions.read)  body: Text("x") }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node  contexts: [C]  dataSources: [st]  serves: A  port: 3000 }
  deployable web { platform: static  targets: api  ui: Web { C: api }  port: 3001 }
}`;
    const { model, errors } = await parseString(src);
    if (errors.length) throw new Error(`unexpected parse/validation errors:\n${errors.join("\n")}`);
    expect(validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code)).not.toContain(
      CODE,
    );
  });

  it("leaves a BACKEND collection op alone — the gate is frontend-only", async () => {
    // Same op, same catalogue, real renderer: an aggregate `derived` folds on
    // every backend.  Nothing about this check touches the domain layer.
    const src = `
system Demo {
  subdomain S {
    context C {
      valueobject Line { price: int }
      aggregate Order {
        lines: Line[]
        derived lineCount: int = lines.count
      }
      repository Orders for Order { }
    }
  }
  api A from S
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node  contexts: [C]  dataSources: [st]  serves: A  port: 3000 }
}`;
    const { model, errors } = await parseString(src);
    if (errors.length) throw new Error(`unexpected parse/validation errors:\n${errors.join("\n")}`);
    expect(validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code)).not.toContain(
      CODE,
    );
  });
});

// ---------------------------------------------------------------------------
// …with ONE framework carved back out of the `.map` exemption.
//
// `map` is exempt because the walker's fall-through — `<recv>.map(<args>)` with
// a hardcoded JS arrow, since there is no `exprLambda` seam — happens to BE the
// right code on the JS frontends, is valid Dart on Flutter, and HEEx runs its
// own engine.  On FELIZ it is verbatim JavaScript inside an F# file, which
// `dotnet fable` rejects: the exemption turned a build break into a SILENT one
// (0 diagnostics, unbuildable output).  Until the walker grows a lambda seam and
// Feliz renders `List.map`, `map` is gated there like every other collection op.
// ---------------------------------------------------------------------------
describe("loom.frontend-collection-op-unsupported — `.map` is exempt per FRAMEWORK", () => {
  const mapBody = `
      page X {
        route: "/x"
        body: Stack { For { each: [1, 2, 3].map(n => n), n => Bold { "x" } } }
      }`;

  it("gates `.map(λ)` on Feliz — the walker would emit a JS arrow into F#", async () => {
    expect(await codes(mapBody, "feliz", "feliz")).toContain(CODE);
  });

  it("still exempts it on every frontend whose walker really renders it", async () => {
    for (const [framework, platform] of [
      ["react", "static"],
      ["vue", "static"],
      ["svelte", "static"],
      ["angular", "static"],
      ["flutter", "flutter"],
    ] as const) {
      expect(
        await codes(mapBody, framework, platform),
        `expected \`.map\` to stay clean on ${framework}`,
      ).not.toContain(CODE);
    }
  });

  it("gates a Feliz ui detected only by its HOST deployable's platform", async () => {
    // The legacy binding leaves `ui { framework: … }` unset, so the framework
    // comes from the hosting deployable — the gate has to consult both.
    const src = `
system Demo {
  subdomain S {
    context C {
      aggregate Customer { name: string  tier: int }
      repository Customers for Customer { }
    }
  }
  api A from S
  ui Web {
    api C: A
    ${mapBody}
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node  contexts: [C]  dataSources: [st]  serves: A  port: 3000 }
  deployable web { platform: feliz  targets: api  ui: Web { C: api }  port: 3001 }
}`;
    const { model, errors } = await parseString(src);
    if (errors.length) throw new Error(`unexpected parse/validation errors:\n${errors.join("\n")}`);
    expect(validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code)).toContain(
      CODE,
    );
  });

  it("keeps gating the OTHER ops on Feliz (the carve-out is `map`-only)", async () => {
    expect(
      await codes(queryViewPage("rows.count"), "feliz", "feliz"),
      "expected `.count` to stay gated on feliz",
    ).toContain(CODE);
  });

  it("names Feliz in the message, so the carve-out is discoverable", async () => {
    const { model, errors } = await parseString(wrap(mapBody, "feliz", "feliz"));
    if (errors.length) throw new Error(`unexpected parse/validation errors:\n${errors.join("\n")}`);
    const d = validateLoomModel(enrichLoomModel(lowerModel(model))).find((x) => x.code === CODE)!;
    expect(d.message).toContain("Feliz");
  });
});
