// Stdlib COLLECTION OPS in a page body, on all SEVEN frontend emitters.
//
// The sibling of `js-intrinsics.test.ts`, and the same defect shape: Loom's
// collection vocabulary is spelled Loom's way, and the frontend walkers had no
// arm for it, so `emitExpr`'s `member` / `method-call` fallthroughs emitted it
// VERBATIM — `rows.count` shipped as literal `rows.count`.  Measured on `main`
// before this suite existed:
//
//   react/vue/svelte  `{String((nums).count)}`               TS2339
//   angular           `{{ String(nums().count) }}`           TS2339 / ng build
//   feliz             `(string (model.Nums.count))`          not F#
//   flutter           `Text(state.nums.count.toString())`    not Dart
//   phoenixLiveView   `<%= to_string(@names.join(", ")) %>`  not Elixir
//
// `loom.frontend-collection-op-unsupported` refused all of it rather than ship
// that, which is honest but is not the same as done.  Nine of the seventeen
// ops now have a real per-target renderer and are ungated; the eight the
// frontends disagree about on REPRESENTATION stay refused (the gate suite,
// `test/ir/frontend-collection-op.test.ts`, owns that half).
//
// This suite asserts on EMITTED TEXT rather than on the gate, because the gate
// passing tells you nothing about whether the emission is right: Feliz and
// Flutter have no runtime leg here, so a wrong-but-plausible string is exactly
// what would survive a gate-only test.  The strings below were read out of
// real generated projects.
//
// Two per-target hazards are pinned explicitly because both compile-and-lie
// rather than fail loudly:
//
//   • ANGULAR — its template grammar is a SUBSET of JavaScript and rejects a
//     BLOCK-bodied arrow, which is exactly the shape the shared JS `sortBy`
//     arm has.  Measured with `@angular/compiler`'s own `parseTemplate`:
//     `Parser Error: Multi-line arrow functions are not supported`.  Angular
//     therefore overrides that ONE arm with a single-expression comparator.
//   • FELIZ — `List.take` / `List.skip` RAISE on a short list where Loom (and
//     JS `.slice`, and Dart's lazy `take`) clamp, so the arms use
//     `List.truncate` and a clamped skip.  A page reading a freshly-loaded
//     query has a short list as its ordinary case, so the raising form would
//     crash the Elmish view rather than fail to build.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

/** framework → (deployable platform, the emitted page file to read). */
const TARGETS = {
  react: ["static", "web/src/pages/x.tsx"],
  vue: ["static", "web/src/pages/x.vue"],
  svelte: ["static", "x/+page.svelte"],
  angular: ["static", "web/src/app/pages/x.component.ts"],
  feliz: ["feliz", "web/src/App.fs"],
  flutter: ["flutter", "x_page.dart"],
  phoenixLiveView: ["elixir", "x_live.ex"],
} as const satisfies Record<string, readonly [string, string]>;

type Framework = keyof typeof TARGETS;

const FRAMEWORKS = Object.keys(TARGETS) as Framework[];

/** Generate one page whose body renders `expr` over two typed `state` arrays,
 *  and return the emitted page source for `framework`. */
async function page(expr: string, framework: Framework): Promise<string> {
  const [platform, file] = TARGETS[framework];
  // Phoenix hosts its own ui from the backend deployable; the SPA frontends
  // bind a separate one against the api.
  const web =
    platform === "elixir"
      ? `deployable web { platform: elixir  contexts: [C]  dataSources: [st]  ui: Web { C: web }  serves: A  port: 4000 }`
      : `deployable api { platform: node  contexts: [C]  dataSources: [st]  serves: A  port: 3000 }
         deployable web { platform: ${platform}  targets: api  ui: Web { C: api }  port: 3001 }`;
  const files = await generateSystemFiles(`
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
    page X {
      route: "/x"
      state { names: string[] = ["b", "a"]  nums: int[] = [3, 1, 2] }
      body: Stack { Text { string(${expr}) } }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  ${web}
}`);
  const hit = [...files.entries()].find(([p]) => p.includes(file));
  if (!hit) throw new Error(`no emitted page at ${file} for ${framework}`);
  return hit[1];
}

/** One row per (op, framework) — the exact substring the emitter must produce.
 *  Written out rather than derived, so a table change has to be re-read by a
 *  human against the target language. */
const EXPECTED: ReadonlyArray<readonly [string, Record<Framework, string>]> = [
  [
    "nums.count",
    {
      react: "(nums).length",
      vue: "(nums).length",
      svelte: "(nums).length",
      angular: "(nums()).length",
      feliz: "(List.length model.Nums)",
      flutter: "(state.nums).length",
      phoenixLiveView: "Enum.count(@nums)",
    },
  ],
  [
    'names.join(", ")',
    {
      react: '(names).join(", ")',
      vue: '(names).join(", ")',
      svelte: '(names).join(", ")',
      angular: '(names()).join(", ")',
      feliz: '(model.Names |> String.concat ", ")',
      flutter: "(state.names).join(', ')",
      phoenixLiveView: 'Enum.join(@names, ", ")',
    },
  ],
  [
    "nums.where(n => n > 1).count",
    {
      react: "((nums).filter((n) => (n > 1))).length",
      vue: "((nums).filter((n) => (n > 1))).length",
      svelte: "((nums).filter((n) => (n > 1))).length",
      angular: "((nums()).filter((n) => (n > 1))).length",
      feliz: "(List.length (model.Nums |> List.filter (fun n -> (n > 1))))",
      flutter: "((state.nums).where((n) => (n > 1)).toList()).length",
      phoenixLiveView: "Enum.count(Enum.filter(@nums, fn n -> n > 1 end))",
    },
  ],
  [
    "nums.any(n => n > 2)",
    {
      react: "(nums).some((n) => (n > 2))",
      vue: "(nums).some((n) => (n > 2))",
      svelte: "(nums).some((n) => (n > 2))",
      angular: "(nums()).some((n) => (n > 2))",
      feliz: "(model.Nums |> List.exists (fun n -> (n > 2)))",
      flutter: "(state.nums).any((n) => (n > 2))",
      phoenixLiveView: "Enum.any?(@nums, fn n -> n > 2 end)",
    },
  ],
  [
    "nums.all(n => n > 0)",
    {
      react: "(nums).every((n) => (n > 0))",
      vue: "(nums).every((n) => (n > 0))",
      svelte: "(nums).every((n) => (n > 0))",
      angular: "(nums()).every((n) => (n > 0))",
      feliz: "(model.Nums |> List.forall (fun n -> (n > 0)))",
      flutter: "(state.nums).every((n) => (n > 0))",
      phoenixLiveView: "Enum.all?(@nums, fn n -> n > 0 end)",
    },
  ],
  [
    "names.map(s => s).count",
    {
      react: "((names).map((s) => s)).length",
      vue: "((names).map((s) => s)).length",
      svelte: "((names).map((s) => s)).length",
      angular: "((names()).map((s) => s)).length",
      // The one that used to force a per-framework carve-out in the gate: the
      // shared walker emitted the JS arrow `(s) => s` into the `.fs` file.
      feliz: "(List.length (model.Names |> List.map (fun s -> s)))",
      // `.map` alone is a lazy `Iterable`; `Table(rows:)` and `ListView` want a
      // `List`, so every sequence-producing Dart arm materialises.
      flutter: "((state.names).map((s) => s).toList()).length",
      phoenixLiveView: "Enum.count(Enum.map(@names, fn s -> s end))",
    },
  ],
  [
    "names.sortBy(s => s).count",
    {
      react: "[...(names)].sort((__a, __b) => { const ka = ((s) => s)(__a)",
      vue: "[...(names)].sort((__a, __b) => { const ka = ((s) => s)(__a)",
      svelte: "[...(names)].sort((__a, __b) => { const ka = ((s) => s)(__a)",
      // SINGLE-EXPRESSION comparator — Angular's template parser rejects the
      // block-bodied one above.  See the header.
      angular: "[...(names())].sort((__a, __b) => (((s) => s)(__a) < ((s) => s)(__b) ? -1 :",
      feliz: "(model.Names |> List.sortBy (fun s -> s))",
      // `..sort` (cascade) so the expression evaluates to the list; `List.sort`
      // itself mutates in place and returns `void`.
      flutter: "([...(state.names)]..sort((a, b) => Comparable.compare(((s) => s)(a) as Comparable",
      phoenixLiveView: "Enum.sort_by(@names, fn s -> s end)",
    },
  ],
  [
    "names.sortBy(s => s, true).count",
    {
      react: "kb < ka ? -1 : kb > ka ? 1 : 0",
      vue: "kb < ka ? -1 : kb > ka ? 1 : 0",
      svelte: "kb < ka ? -1 : kb > ka ? 1 : 0",
      angular: "((s) => s)(__b) < ((s) => s)(__a) ? -1 :",
      feliz: "(model.Names |> List.sortByDescending (fun s -> s))",
      flutter: "Comparable.compare(((s) => s)(b) as Comparable, ((s) => s)(a) as Comparable)",
      phoenixLiveView: "Enum.sort_by(@names, fn s -> s end, :desc)",
    },
  ],
  [
    "nums.take(2).count",
    {
      react: "(nums).slice(0, 2)",
      vue: "(nums).slice(0, 2)",
      svelte: "(nums).slice(0, 2)",
      angular: "(nums()).slice(0, 2)",
      // `List.truncate`, NOT `List.take` — see the header.
      feliz: "(model.Nums |> List.truncate 2)",
      flutter: "(state.nums).take(2).toList()",
      phoenixLiveView: "Enum.take(@nums, 2)",
    },
  ],
  [
    "nums.skip(1).count",
    {
      react: "(nums).slice(1)",
      vue: "(nums).slice(1)",
      svelte: "(nums).slice(1)",
      angular: "(nums()).slice(1)",
      // …and a CLAMPED skip, for the same reason.
      feliz: "(model.Nums |> List.skip (min (1) (List.length model.Nums)))",
      flutter: "(state.nums).skip(1).toList()",
      phoenixLiveView: "Enum.drop(@nums, 1)",
    },
  ],
];

describe("collection ops render on every frontend", () => {
  for (const [expr, expected] of EXPECTED) {
    for (const framework of FRAMEWORKS) {
      it(`${framework}: ${expr}`, async () => {
        const src = await page(expr, framework);
        expect(src, `${framework} must render ${expr}`).toContain(expected[framework]);
      });
    }
  }

  it("never leaves the Loom spelling verbatim — the failure the gate exists for", async () => {
    // The `<recv>.<loomOp>` / `<recv>.<loomOp>(` form is what shipped before:
    // literal `nums.count` in TSX, `model.Nums.count` in F#, `@names.join(", ")`
    // in HEEx.  This is the assertion that fails if a target loses its table:
    // the per-op rows above would fail too, but this one names the defect.
    // RECEIVER-ANCHORED: the point is `<the state binding>.<loomOp>`, not the op
    // name in isolation — `Enum.take(@nums, 2)` legitimately contains `.take(`,
    // and asserting on the bare name would pass for the wrong reason.
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<RegExp>]> = [
      ["nums.count", [/model\.Nums\.count/, /@nums\.count/, /state\.nums\.count/]],
      ['names.join(", ")', [/model\.Names\.join/, /@names\.join/]],
      ["nums.where(n => n > 1).count", [/model\.Nums\.where/, /@nums\.where/]],
      ["nums.any(n => n > 2)", [/model\.Nums\.any/, /@nums\.any/]],
      ["names.sortBy(s => s).count", [/model\.Names\.sortBy/, /@names\.sort_by\(event/]],
      ["nums.take(2).count", [/model\.Nums\.take/, /@nums\.take/, /state\.nums\.take\(2\)\)/]],
      ["nums.skip(1).count", [/model\.Nums\.skip/, /@nums\.skip/]],
    ];
    for (const [expr, verbatims] of cases) {
      // Feliz and HEEx are the two whose host language shares NO spelling with
      // Loom's, so a verbatim emit there is unambiguous.  (Dart really does
      // spell `take`/`skip`/`join`/`any` the way Loom does, and JS spells
      // `join` — for those the per-op rows above are the assertion that the op
      // was translated, since no substring can tell the two apart.)
      for (const framework of ["feliz", "phoenixLiveView"] as const) {
        const src = await page(expr, framework);
        for (const verbatim of verbatims) {
          expect(src, `${framework} must not emit ${expr} verbatim`).not.toMatch(verbatim);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The ORIGINAL reported shape: a `QueryView`'s `data:` row-set binding.
//
// `QueryView { of: X.all, data: rows => Stat("n", rows.count) }` is the body
// M-T1.3 Defect A was filed against, and it is the one shape whose receiver
// carries NO array `TypeIR` — lowering leaves UI-primitive lambda params at the
// `string` placeholder.  So a walker that recognised collection-op sites by
// receiver TYPE alone would decline it, fall through to the verbatim emit, and
// ship the very defect the gate was built for — while the gate, which tracks
// the row-set binding by NAME, said the body was fine.
//
// That is why both sides share ONE recognizer (`ir/util/collection-op-site.ts`)
// and the walker threads the same `rowSetBindings` scope
// (`_walker/primitives/controls.ts`).  These tests are what fail if the
// threading is dropped: the gate keeps passing and the output goes wrong, which
// is exactly the silent shape the gate exists to prevent.
// ---------------------------------------------------------------------------
describe("collection ops off a QueryView row-set binding", () => {
  async function queryViewPage(expr: string, framework: Framework): Promise<string> {
    const [platform, file] = TARGETS[framework];
    const web =
      platform === "elixir"
        ? `deployable web { platform: elixir  contexts: [C]  dataSources: [st]  ui: Web { C: web }  serves: A  port: 4000 }`
        : `deployable api { platform: node  contexts: [C]  dataSources: [st]  serves: A  port: 3000 }
           deployable web { platform: ${platform}  targets: api  ui: Web { C: api }  port: 3001 }`;
    const files = await generateSystemFiles(`
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
    page X {
      route: "/x"
      body: QueryView { of: C.Customer.all, data: rows => Stat("n", ${expr}) }
    }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  ${web}
}`);
    const hit = [...files.entries()].find(([p]) => p.includes(file));
    if (!hit) throw new Error(`no emitted page at ${file} for ${framework}`);
    return hit[1];
  }

  it("renders `rows.count` — the reported defect — on every frontend", async () => {
    for (const framework of FRAMEWORKS) {
      const src = await queryViewPage("rows.count", framework);
      // The op was TRANSLATED: some `.length` / `List.length` / `Enum.count`
      // reaches the emitted page.  (The exact receiver spelling differs per
      // target — a hook var, a Model field, an assign — so the assertion is on
      // the op, not on the whole expression.)
      expect(src, `${framework} must translate rows.count`).toMatch(
        /\.length\b|List\.length|Enum\.count/,
      );
      // …and the Loom spelling is gone.  The negative lookbehind excludes
      // Elixir's own `Enum.count(…)`, which is the TRANSLATION, not the defect;
      // what must not appear is a `.count` hanging off the row binding
      // (`items.count` / `allCustomers.count` / `customerAll.count` — the
      // literal text that used to ship on the four JS frontends, Feliz and
      // Flutter respectively).
      expect(src, `${framework} must not emit rows.count verbatim`).not.toMatch(
        /(?<!Enum)\.count\b/,
      );
    }
  });

  it("renders a chained `rows.where(λ).count` on every frontend", async () => {
    for (const framework of FRAMEWORKS) {
      const src = await queryViewPage("rows.where(o => o.tier > 1).count", framework);
      expect(src, `${framework} must translate the filter`).toMatch(
        /\.filter\(|List\.filter|Enum\.filter|\.where\(/,
      );
      expect(src, `${framework} must not emit .where verbatim in a non-Dart language`).not.toMatch(
        framework === "flutter" ? /\.sortBy\(/ : /\.where\(/,
      );
    }
  });
});

describe("collection ops in a component body, not just a page", () => {
  it("renders through the same table from a component", async () => {
    const files = await generateSystemFiles(`
system Demo {
  subdomain S {
    context C {
      aggregate Customer { name: string  tier: int }
      repository Customers for Customer { }
    }
  }
  api A from S
  ui Web {
    framework: react
    api C: A
    component Tally(rows: Customer[]) { body: Text { string(rows.where(o => o.tier > 1).count) } }
    page X { route: "/x"  body: Tally(rows: [ ]) }
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node  contexts: [C]  dataSources: [st]  serves: A  port: 3000 }
  deployable web { platform: static  targets: api  ui: Web { C: api }  port: 3001 }
}`);
    const comp = [...files.entries()].find(([p]) => p.includes("Tally"))?.[1] ?? "";
    expect(comp).toContain("((rows).filter((o) => (o.tier > 1))).length");
  });
});
