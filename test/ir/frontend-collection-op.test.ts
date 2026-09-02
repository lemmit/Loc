// `loom.frontend-collection-op-unsupported` (M-T1.3 Defect A, M-T1.20).
//
// The stdlib collection ops started as a BACKEND vocabulary — every backend
// rendered them through `_expr/target.ts`'s `isCollectionOp` arm, the frontend
// walkers had NO such arm.  The shared `walker-core.ts` `member` arm emitted
// `<recv>.<member>` and its `method-call` arm `<recv>.<member>(<args>)`,
// VERBATIM, so `QueryView { of: X.all, data: rows => Stat("n", rows.count) }`
// validated clean and then failed at `tsc` (TS2339 — `Property 'count' does
// not exist on type 'Customer[]'`), at `ng build`, at `dotnet fable`.  Hence
// this gate.
//
// The gate is now a REMAINDER.  Nine of the seventeen ops have a real
// per-target renderer behind `WalkerTarget.renderCollectionOp` (and, on the
// HEEx parallel walker, its own `renderCollectionOp`), so this suite pins two
// things that must both stay true:
//
//   • the nine RESHAPING ops are ACCEPTED on every frontend — the split is
//     uniform, with no per-framework carve-out left (`WalkerTarget.exprLambda`
//     retired the Feliz `map` one);
//   • the eight the frontends disagree about on REPRESENTATION are still
//     REFUSED — `sum`/`min`/`max`/`avg` (arithmetic folds over `money`, an
//     object on JS/HEEx and a native scalar on F#/Dart), `first`/`firstOrNull`
//     (partiality + the optional type), `distinct`/`contains` (value equality,
//     which Flutter's models don't define).
//
// …plus the three things it must NOT flag at all:
//
//   1. a repository read (`Sales.Customer.all()`), which lowering marks
//      `isCollectionOp: true` off the NAME alone with a primitive receiver;
//   2. a BACKEND collection op — the gate is frontend-only;
//   3. `page { requires currentUser.permissions.contains(…) }`, a GATE
//      expression rendered by the closed `_frontend/gate-expr.ts` — whose one
//      admitted method is that very collection op.
//
// What each ACCEPTED op actually emits, per target, is
// `test/generator/_walker/collection-ops.test.ts`; this file owns the gate.

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
  it("flags the ARITHMETIC folds — money is an object on JS/HEEx, a scalar on F#/Dart", async () => {
    // `avg` desugars at lowering into `count == 0 ? null : sum(λ) / count`, so
    // it is refused via its `sum` — which is why it belongs in this group and
    // not with the reshaping ops its `count` half now renders.
    for (const op of [
      "rows.sum(o => o.tier)",
      "rows.min(o => o.tier)",
      "rows.max(o => o.tier)",
      "rows.avg(o => o.tier)",
    ]) {
      expect(await codes(queryViewPage(op)), `expected ${op} to be gated`).toContain(CODE);
    }
  });

  it("flags the PARTIAL / optional-returning ops — `undefined` here, a raise on F#/Dart", async () => {
    for (const op of ["rows.first", "rows.firstOrNull"]) {
      expect(await codes(queryViewPage(op)), `expected ${op} to be gated`).toContain(CODE);
    }
  });

  it("flags the EQUALITY ops — Flutter's wire models define no `operator ==`", async () => {
    expect(await codes(queryViewPage("rows.distinct")), "expected rows.distinct gated").toContain(
      CODE,
    );
    // `contains` needs a TYPED collection receiver to be a collection op at
    // all: `string.contains` is also a scalar intrinsic, and lowering keys
    // `isCollectionOp` off the receiver TYPE to tell the two apart
    // (`lower-expr.ts`).  A `QueryView` row-set binding carries the `string`
    // placeholder, so `rows.contains(x)` lowers as the substring test, not as
    // membership — pre-existing, and not this gate's to decide.
    expect(
      await codes(`
      page X {
        route: "/x"
        state { tags: string[] = [] }
        body: Text(string(tags.contains("x")))
      }`),
      "expected a typed `.contains` gated",
    ).toContain(CODE);
  });

  it("flags the call form as well as the property form", async () => {
    // `sum` in both spellings: the call form lowers to a `method-call` with
    // `isCollectionOp`, `distinct` written without parens to a plain `member`.
    expect(await codes(queryViewPage("rows.sum(o => o.tier)"))).toContain(CODE);
    expect(await codes(queryViewPage("rows.distinct"))).toContain(CODE);
  });

  it("is target-agnostic — a refused op fails on every SPA frontend", async () => {
    for (const [framework, platform] of [
      ["react", "static"],
      ["vue", "static"],
      ["svelte", "static"],
      ["angular", "static"],
      ["feliz", "feliz"],
      ["flutter", "flutter"],
    ] as const) {
      expect(
        await codes(queryViewPage("rows.sum(o => o.tier)"), framework, platform),
        `expected the gate on ${framework}`,
      ).toContain(CODE);
    }
  });

  it("…and target-agnostic the other way: an ACCEPTED op is clean on every frontend", async () => {
    // The half that used to be impossible.  `rows.count` is the exact body the
    // defect was reported against; `rows.where(λ).count` is the chained form
    // whose receiver types as an array only because lowering tracked the chain.
    for (const [framework, platform] of [
      ["react", "static"],
      ["vue", "static"],
      ["svelte", "static"],
      ["angular", "static"],
      ["feliz", "feliz"],
      ["flutter", "flutter"],
    ] as const) {
      for (const op of ["rows.count", "rows.where(o => o.tier > 1).count"]) {
        expect(
          await codes(queryViewPage(op), framework, platform),
          `expected ${op} to be accepted on ${framework}`,
        ).not.toContain(CODE);
      }
    }
  });

  it("keeps refusing an op off an EXPLICITLY-PAGED binding — it is not a row set", async () => {
    // `paged: true` binds the `Paged<T>` ENVELOPE, not the rows — that is what
    // lets a scaffolded body read `rows.items` and `rows.totalPages`.  So
    // `rows.count` there would be a `.length` on an object: a type error on the
    // JSX frontends and a silently different value elsewhere.  The row-set
    // scope declines it, so the op is still refused — the same answer as before
    // the reshaping ops were ungated, and the same answer the WALKER gives
    // (both read `rowSetLambdaParam`).
    expect(
      await codes(`
      page X {
        route: "/x"
        body: QueryView { of: C.Customer.all, paged: true, data: rows => Stat("n", rows.count) }
      }`),
    ).toContain(CODE);
  });

  it("accepts every RESHAPING op from a page body", async () => {
    for (const op of [
      "rows.count",
      "rows.where(o => o.tier > 1).count",
      "rows.any(o => o.tier > 1)",
      "rows.all(o => o.tier > 1)",
      "rows.take(3).count",
      "rows.skip(3).count",
      "rows.sortBy(o => o.tier).count",
      "rows.sortBy(o => o.tier, true).count",
      'rows.map(o => o.name).join(", ")',
    ]) {
      expect(await codes(queryViewPage(op)), `expected ${op} to be accepted`).not.toContain(CODE);
    }
  });

  it("fires on Phoenix/HEEx too — its parallel walker gets the same split", async () => {
    // HEEx does NOT consume the shared `walkBody`; `elixir/heex-walker-core.ts`
    // is a separate engine with its own `renderCollectionOp`.  It renders the
    // same nine ops (see `test/generator/elixir/heex-collection-ops.test.ts`)
    // and refuses the same eight, so the gate stays target-agnostic: a `.ddd`
    // works on every target or fails on every one.
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
    page X { route: "/x"  body: QueryView { of: C.Customer.all, data: rows => Stat("n", rows.sum(o => o.tier)) } }
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
          Stack(Stat("a", rows.first), Stat("b", rows.first), Stat("c", rows.sum(o => o.tier))) }
      }`)
    ).filter((d) => d.code === CODE);
    expect(found.map((d) => d.message.match(/`\.(\w+)`/)?.[1]).sort()).toEqual(["first", "sum"]);
  });

  it("names the op and points at the server-side read path", async () => {
    const d = (await diags(queryViewPage("rows.sum(o => o.tier)"))).find((x) => x.code === CODE)!;
    expect(d.severity).toBe("error");
    expect(d.message).toContain("`.sum`");
    expect(d.message).toContain("projection");
  });

  it("names the ops it DOES render, so the remainder reads as a boundary", async () => {
    // The message has to distinguish "not implemented yet" from "these six
    // frontends disagree about what this MEANS" — otherwise the honest gate
    // reads as an arbitrary one.
    const d = (await diags(queryViewPage("rows.first"))).find((x) => x.code === CODE)!;
    for (const op of ["count", "where", "sortBy", "join"]) {
      expect(d.message, `expected the message to name the rendered op ${op}`).toContain(
        `\`${op}\``,
      );
    }
  });

  it("covers a page `derived` binding, a `state` initialiser and an action body", async () => {
    // `derived` — hoisted to a `useMemo` / `computed` / `$derived` by the walker.
    expect(
      await codes(`
      page X {
        route: "/x"
        derived n: int = [1, 2, 3].first
        body: Text("x")
      }`),
    ).toContain(CODE);
    // `state` initialiser.
    expect(
      await codes(`
      page X {
        route: "/x"
        state { n: int = [1, 2, 3].first }
        body: Text("x")
      }`),
    ).toContain(CODE);
    // Named action body — statements walk too.
    expect(
      await codes(`
      page X {
        route: "/x"
        state { n: int = 0 }
        action bump() { n := [1, 2, 3].first }
        body: Button("go", onClick: bump)
      }`),
    ).toContain(CODE);
  });

  it("covers a component body, not just a page", async () => {
    expect(
      await codes(`
      component Totals(rows: Customer[]) { body: Stat("n", rows.first) }
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

  it("leaves `.map(λ)` alone — a rendered op on every frontend (DEBT-31)", async () => {
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
// The per-framework carve-out is GONE, and this describe is what keeps it gone.
//
// `map` used to be exempt everywhere EXCEPT Feliz: the walker had no lambda
// seam, so `<recv>.map(<args>)` came out with a hardcoded JS arrow — the right
// code on the JS frontends, valid Dart on Flutter, HEEx running its own engine,
// and verbatim JavaScript inside an `.fs` file on Feliz, which `dotnet fable`
// rejects.  `WalkerTarget.exprLambda` closed that (Feliz renders
// `(fun n -> …)`), so the accepted set is once again uniform — which is what
// makes this check target-agnostic in FACT and not just in intent.
//
// A per-framework carve-out is a thing worth being able to reintroduce, and a
// thing worth noticing: these tests fail loudly if one comes back by accident.
// ---------------------------------------------------------------------------
describe("loom.frontend-collection-op-unsupported — no per-framework carve-out", () => {
  const mapBody = `
      page X {
        route: "/x"
        body: Stack { For { each: [1, 2, 3].map(n => n), n => Bold { "x" } } }
      }`;

  it("accepts `.map(λ)` on EVERY frontend, Feliz included", async () => {
    for (const [framework, platform] of [
      ["react", "static"],
      ["vue", "static"],
      ["svelte", "static"],
      ["angular", "static"],
      ["feliz", "feliz"],
      ["flutter", "flutter"],
    ] as const) {
      expect(
        await codes(mapBody, framework, platform),
        `expected \`.map\` to stay clean on ${framework}`,
      ).not.toContain(CODE);
    }
  });

  it("accepts it on a Feliz ui detected only by its HOST deployable's platform", async () => {
    // The legacy binding leaves `ui { framework: … }` unset, so the framework
    // came from the hosting deployable — the shape the old carve-out had to
    // consult both channels for.  Kept as a regression: a reintroduced
    // carve-out that reads only `ui.framework` would still pass the test above.
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
    expect(validateLoomModel(enrichLoomModel(lowerModel(model))).map((d) => d.code)).not.toContain(
      CODE,
    );
  });

  it("refuses the SAME ops on Feliz as everywhere else — the split is uniform", async () => {
    for (const op of ["rows.sum(o => o.tier)", "rows.first", "rows.distinct"]) {
      expect(
        await codes(queryViewPage(op), "feliz", "feliz"),
        `expected ${op} to stay gated on feliz`,
      ).toContain(CODE);
    }
    for (const op of ["rows.count", "rows.sortBy(o => o.tier).count"]) {
      expect(
        await codes(queryViewPage(op), "feliz", "feliz"),
        `expected ${op} to be accepted on feliz`,
      ).not.toContain(CODE);
    }
  });
});

// ---------------------------------------------------------------------------
// The THIRD expression surface: a `store`.
//
// The gate originally walked pages and components only, so a collection op in a
// STORE escaped it entirely — and a store is not a lesser surface: its action
// bodies and state initialisers are emitted by every frontend's own store
// builder (React's zustand slice, `flutter/store-builder.ts`'s Riverpod
// notifier, the Feliz Elmish `update` arm), none of which has a collection-op
// renderer either.  Measured on `store Cart { action tidy() { tags :=
// tags.distinct() } }`: `ddd parse` clean, then the FELIZ generator CRASHES
// (`feliz/fs-expr.ts` has no leaf for `distinct`) and FLUTTER emits
// `state.tags.distinct()` — Dart that does not compile.  Same vocabulary gap as
// a page body, so the same gate, at the same call site.
// ---------------------------------------------------------------------------
describe("loom.frontend-collection-op-unsupported — store surfaces", () => {
  /** A store whose action body is the variable, plus a page so the ui renders. */
  const storeUi = (member: string) => `
  store Cart {
    state { tags: string[] }
    ${member}
  }
  page X { route: "/x"  body: Text("x") }`;

  it("flags a refused collection op in a STORE ACTION body — the reported crash", async () => {
    expect(await codes(storeUi("action tidy() { tags := tags.distinct() }"))).toContain(CODE);
  });

  it("flags it on feliz (crash) and flutter (uncompilable Dart) alike", async () => {
    for (const [framework, platform] of [
      ["feliz", "feliz"],
      ["flutter", "flutter"],
    ] as const) {
      expect(
        await codes(storeUi("action tidy() { tags := tags.distinct() }"), framework, platform),
        `expected the store gate on ${framework}`,
      ).toContain(CODE);
    }
  });

  it("keeps refusing the REPRESENTATION-divergent ops in a store action", async () => {
    for (const op of ["tags.first", "tags.distinct.count", "tags.sum(t => 1)"]) {
      expect(
        await codes(storeUi(`state { n: int = 0 }  action tidy() { n := ${op} }`)),
        `expected ${op} to be gated in a store action`,
      ).toContain(CODE);
    }
  });

  it("accepts the RESHAPING ops in a store action — the Feliz action path renders them", async () => {
    // The store action body is the one surface that does NOT go through the
    // shared walker on Feliz: `renderFsExpr` owns it, and it used to THROW on
    // any collection op it had no arm for.  It reaches the same table now.
    for (const op of [
      "tags.count",
      "tags.take(3).count",
      "tags.skip(3).count",
      "tags.sortBy(t => t).count",
      'tags.where(t => t != "").count',
    ]) {
      for (const [framework, platform] of [
        ["react", "static"],
        ["feliz", "feliz"],
        ["flutter", "flutter"],
      ] as const) {
        expect(
          await codes(
            storeUi(`state { n: int = 0 }  action tidy() { n := ${op} }`),
            framework,
            platform,
          ),
          `expected ${op} to be accepted in a store action on ${framework}`,
        ).not.toContain(CODE);
      }
    }
  });

  it("flags a collection op in a store STATE INITIALISER", async () => {
    expect(
      await codes(`
  store Cart {
    state { n: int = [1, 2, 3].first }
  }
  page X { route: "/x"  body: Text("x") }`),
    ).toContain(CODE);
  });

  it("names the store as the source, so the diagnostic points at the right host", async () => {
    const found = (await diags(storeUi("action tidy() { tags := tags.distinct() }"))).find(
      (d) => d.code === CODE,
    )!;
    expect(found.source).toBe("store 'Cart'");
    expect(found.message).toContain("`.distinct`");
  });

  it("leaves `.map(λ)` in a store alone on every frontend, Feliz included", async () => {
    const mapStore = `
  store Cart {
    state { tags: string[] }
    action shout() { tags := tags.map(t => t) }
  }
  page X { route: "/x"  body: Text("x") }`;
    expect(await codes(mapStore, "react", "static")).not.toContain(CODE);
    expect(await codes(mapStore, "flutter", "flutter")).not.toContain(CODE);
    expect(await codes(mapStore, "feliz", "feliz")).not.toContain(CODE);
  });

  it("leaves an ordinary store action alone — no false positive", async () => {
    expect(
      await codes(`
  store Cart {
    state { tags: string[]  n: int = 0 }
    action add(t: string) { tags += t  n += 1 }
    action clear() { tags := [ ]  n := 0 }
  }
  page X { route: "/x"  body: Text("x") }`),
    ).not.toContain(CODE);
  });
});
