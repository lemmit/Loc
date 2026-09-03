// The frontend render-degradation gate.
//
// The backends cannot silently drop an expression: `_expr/target.ts` dispatches
// over an EXHAUSTIVE `ExprIR.kind` switch with a `never` check, and each
// backend's leaf table is pinned by `intrinsic-completeness.test.ts`.  The
// frontend walker has neither.  `emitExpr` ends in a soft `default:` that
// returns `/* unsupported expr: <kind> */ undefined`, its `method-call` arm
// falls through to a VERBATIM `<recv>.<member>(<args>)`, and an unknown call
// name in a body renders as NOTHING at all.
//
// None of that was visible.  A scan of every `.ddd` in this repo finds zero
// page/component bodies using a scalar intrinsic or a value-object
// construction, so the per-frontend build gates compiled green on coverage
// they never had.
//
// This gate closes that.  It generates `expression-showcase.ddd` — the fixture
// that exercises the expression vocabulary — for every frontend and asserts the
// emitted page files carry NO degradation sentinel.  The sentinels are read out
// of the emitter sources rather than copied here, so a newly-invented
// placeholder is covered the moment it is added.
//
// KNOWN_DEGRADATIONS is a RATCHET, not a waiver list: each entry names a real
// defect with its fix slice, and the entry is deleted by the PR that fixes it.
// Adding an entry requires the same justification as adding a wire-waiver.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validate } from "../../../src/api/index.js";
import { snake } from "../../../src/util/naming.js";
import {
  generateSystemFiles,
  generateSystemFilesUnchecked,
  loadExample,
  parseString,
} from "../../_helpers/index.js";

const FIXTURE = "web/src/examples/expression-showcase.ddd";

/** Frontends the fixture is generated for, with the hosting deployable's
 *  platform and the path fragment identifying its emitted page files.
 *
 *  `hosting` names the deployment TOPOLOGY the frontend actually ships in,
 *  because the two are not interchangeable:
 *
 *   - `"spa"` — a CLIENT frontend served as a static bundle beside a separate
 *     backend, wired with `targets: <backend>`.  `enrichDeployables` backfills
 *     its `contextNames` from that target, so the page emitter sees the
 *     backend's aggregates / value objects / repositories.
 *   - `"self"` — a SELF-HOSTING backend that also renders the ui (Phoenix
 *     LiveView).  It owns its contexts directly (`contexts:` / `dataSources:`)
 *     and `targets:` is a validator ERROR on it.
 *
 *  Getting this wrong is not cosmetic — see `retargetFixture`. */
const TARGETS = [
  { framework: "react", platform: "static", hosting: "spa", pages: /\/src\/pages\/.*\.tsx$/ },
  { framework: "vue", platform: "static", hosting: "spa", pages: /\/src\/pages\/.*\.vue$/ },
  { framework: "svelte", platform: "static", hosting: "spa", pages: /\+page\.svelte$/ },
  { framework: "angular", platform: "static", hosting: "spa", pages: /\/src\/app\/pages\// },
  { framework: "feliz", platform: "feliz", hosting: "spa", pages: /\.fs$/ },
  { framework: "flutter", platform: "flutter", hosting: "spa", pages: /lib\/pages\// },
  {
    framework: "phoenixLiveView",
    platform: "elixir",
    hosting: "self",
    pages: /_live\.ex$|\.html\.heex$/,
  },
] as const;

/**
 * Emitted-output patterns that mean "the walker gave up".  Each corresponds to
 * a real placeholder in the emitters:
 *
 *   `/* unsupported expr: <kind> *​/ undefined`  walker-core.ts `emitExpr` default
 *   `/* TODO: method-call … *​/ undefined`       walker-core.ts unresolved receiver
 *   `/* ref: <name> *​/`                          walker-core.ts unresolved ref
 *   `// <pack> pack: no renderer for "X"`        flutter/pack.ts, feliz/pack.ts
 *   `/* X: not yet supported on <framework> *​/`  the per-primitive `default:` arms
 *
 * A rendered page containing any of them is a generated project that is broken,
 * blank, or silently wrong at that spot.
 *
 * `origins` is what keeps each pattern HONEST.  A sentinel is a copy of an
 * emitter's wording living in a second file, so the failure mode is not "the
 * regex is wrong" but "the emitter was reworded and the regex silently stopped
 * matching" — which reads as a green gate.  (It has happened: the
 * `not supported by the React walker` arm was reworded to drop React's name.)
 * Each entry names the emitter source and the EXACT template literal, and
 * `the sentinels can still fire` below asserts both directions — the template
 * is still in that file, and the pattern still matches what it renders to.
 */
const SENTINELS: ReadonlyArray<{
  label: string;
  re: RegExp;
  origins: ReadonlyArray<{ file: string; template: string }>;
}> = [
  {
    label: "unsupported expr",
    re: /unsupported expr:\s*(\w+)/g,
    origins: [
      {
        file: "src/generator/_walker/walker-core.ts",
        template: "`unsupported expr: ${expr.kind}`",
      },
    ],
  },
  {
    label: "unresolved method-call",
    re: /TODO: method-call/g,
    origins: [
      {
        file: "src/generator/_walker/walker-core.ts",
        template:
          "`/* TODO: method-call ${receiverDesc}.${expr.member}(${argsRendered}) — needs hooks {} binding */ undefined`",
      },
    ],
  },
  {
    label: "unresolved ref",
    re: /\bref:\s*\w+\s*\*\//g,
    origins: [{ file: "src/generator/_walker/walker-core.ts", template: "`ref: ${expr.name}`" }],
  },
  // `emitExpr`'s ref fallthrough — a name that resolves to no param, state,
  // derived, shell local or `let`.  Unlike the give-up COMMENTS above this one
  // emits a VALUE: `/* unresolved: Catalog */ undefined`, which then gets a
  // member access appended (`undefined.Product.all.isLoading`).  It is the most
  // damaging marker in the list — not a missing element but a guaranteed
  // TypeError, and uncompilable under `tsc --noEmit` / `svelte-check` /
  // `vue-tsc` — and it was the one shape the sentinel list did not carry.
  {
    label: "unresolved name",
    re: /unresolved:\s*(\w+)\s*\*\/\s*undefined/g,
    origins: [
      {
        file: "src/generator/_walker/walker-core.ts",
        template: "`/* unresolved: ${expr.name} */ undefined`",
      },
    ],
  },
  // BOTH self-hosting packs, not just Flutter's.  Feliz has the identical
  // fallback (`(* feliz pack: no renderer for "X" *)`) and was uncovered here,
  // so a Feliz pack that lost a renderer produced valid-but-empty F# no
  // sentinel could see.
  {
    label: "pack: no renderer",
    re: /\w+ pack: no renderer for "([^"]+)"/g,
    origins: [
      {
        file: "src/generator/flutter/pack.ts",
        template: '`// ${GIVE_UP_SENTINEL} flutter pack: no renderer for "${name}"`',
      },
      {
        file: "src/generator/feliz/pack.ts",
        template: '`(* ${GIVE_UP_SENTINEL} feliz pack: no renderer for "${name}" *)`',
      },
    ],
  },
  // `walk()`'s two give-up comments — a name that resolves to no primitive /
  // component, and a registered primitive with no renderer on this target.
  {
    label: "unknown layout component",
    re: /unknown layout component:\s*(\w+)/g,
    origins: [
      {
        file: "src/generator/_walker/walker-core.ts",
        template: "`unknown layout component: ${call.name}`",
      },
    ],
  },
  {
    label: "unknown page element",
    re: /unknown page element:\s*(\w+)/g,
    origins: [
      {
        file: "src/generator/_walker/walker-core.ts",
        template: "`unknown page element: ${expr.name}`",
      },
    ],
  },
  // Both spellings of `walk()`'s "registered primitive, no renderer here" arm:
  // the shared `walker-core.ts` comment (`not supported by the walker yet` —
  // it used to say "the React walker" even on Vue/Svelte/Angular/Feliz/Flutter)
  // and `heex-walker-core.ts`'s LiveView wording.
  {
    label: "primitive not supported",
    re: /not supported by (?:the (?:\w+ )?walker yet|Phoenix LiveView target)/g,
    origins: [
      {
        file: "src/generator/_walker/walker-core.ts",
        template: "`${call.name}: not supported by the walker yet`",
      },
      {
        file: "src/generator/elixir/heex-walker-core.ts",
        template:
          "`<%!-- ${GIVE_UP_SENTINEL} ${expr.name}: not supported by Phoenix LiveView target --%>`",
      },
    ],
  },
  // THE SHAPE THIS GATE COULD NOT SEE.  A per-primitive emitter that has
  // rendered arms for SOME frameworks ends its `switch (ctx.target.framework)`
  // in a `default:` that comments the primitive out — `Timeline`,
  // `ProvenanceInfo`, `DataGrid`, and `QueryView`'s entity-history notice all
  // do it.  The wording is "not [yet] supported ON <framework>", which is a
  // different sentence from the `not supported BY the walker` arm above, so
  // none of the seven patterns that existed before this entry matched it: a
  // primitive silently absent from three of the seven frontends looked
  // exactly like a primitive present on all seven.
  //
  // Reachable at a live call site: the fixture's `ProductHistory` page renders
  // a `Timeline`, whose `default:` arm is one deleted `case` away.
  {
    label: "primitive degraded on target",
    re: /not (?:yet )?supported on (\w+)/g,
    origins: [
      {
        file: "src/generator/_walker/primitives/timeline.ts",
        template: "`Timeline: not yet supported on ${ctx.target.framework}`",
      },
      {
        file: "src/generator/_walker/primitives/provenance-info.ts",
        template:
          '`ProvenanceInfo: provenance disclosure not yet supported on ${ctx.target.framework} (value renders without the "?")`',
      },
      {
        file: "src/generator/_walker/primitives/controls.ts",
        template: "`History is not yet supported on ${ctx.target.framework}`",
      },
      {
        file: "src/generator/_walker/primitives/data-grid.ts",
        template: "`{/* DataGrid: not supported on ${ctx.target.framework} */}`",
      },
    ],
  },
];

/**
 * RATCHET — every entry is a live defect with a named fix slice.  Delete the
 * entry in the PR that lands the fix; never add one to make a red build green.
 *
 * Keyed `<framework>:<sentinel label>`.
 */
const KNOWN_DEGRADATIONS: ReadonlyMap<string, string> = new Map([
  // EMPTY — and the "still real" test below keeps it honest in both
  // directions: a NEW sentinel fails the per-target scan above, and a
  // re-added entry that no longer fires fails as stale.
  //
  // EMPTY IS NOT THE SAME AS UNREACHABLE, and the gap between the two is worth
  // stating because it is exactly where the two rows below were re-created in
  // miniature.  This scan drives ONE fixture (`expression-showcase.ddd`), which
  // declares no user components at all — so the ratchet cannot see the shapes
  // that BOTH remaining component emitters still filter out (a `slot` /
  // `action` / optional param, a Feliz body needing the route `id` or a store
  // or a `byId` read, an Angular read fed by an `@Input()`).  Those are no
  // longer silent: each is now an honest `loom.user-component-deferred-target`
  // validation error, which is what keeps them out of this ratchet — the
  // sentinel is unreachable from input the compiler ACCEPTS.  The gate's arms
  // are pinned, one per (framework, shape), against the emitters' real output
  // in `test/ir/user-component-deferred.test.ts`, and the linkage between the
  // two files is asserted at the bottom of this one.
  //
  // The last two rows were "user components are not emitted on Angular /
  // Feliz": a declared `component TierBadge(…)` produced no component on
  // either frontend, so `ctx.userComponents` never learned the name and every
  // use site rendered `unknown layout component: TierBadge` — declaration and
  // use vanishing together.  Both now emit for real (Angular: a standalone
  // `@Component` class at `src/app/components/<Name>.ts` via the page shell's
  // component mode, `src/generator/angular/components-emit.ts`; Feliz: an F#
  // props function spliced into `App.fs` ahead of the page views,
  // `src/generator/feliz/component-emit.ts`).
]);

/**
 * RATCHET — targets whose walker still emits Loom's own intrinsic SPELLING
 * verbatim instead of translating it (`toUpper` rather than `.toUpperCase()` /
 * `.ToUpper()` / `String.upcase`).  Deleted per target by slice 4.
 *
 * Verbatim emission is not sentinel-shaped, so the sentinel scan above cannot
 * see it — which is precisely how it survived: it produces output that *looks*
 * like code.
 */
const KNOWN_VERBATIM_INTRINSICS: ReadonlySet<string> = new Set([
  // `feliz` was retired here by the F# table in `fs-expr.ts`
  // (`FS_INTRINSIC_RENDERERS` + `renderFsIntrinsic`), wired into BOTH the view
  // path (`felizTarget.renderIntrinsic`) and the MVU update path.
  // `flutter` was retired here by the Dart table in `dart-expr.ts`
  // (`DART_INTRINSIC_RENDERERS` + `renderDartIntrinsic`) — Flutter has only
  // ONE dispatch path (view and Notifier/action bodies both route through the
  // shared `emitExpr`), so one seam (`flutterTarget.renderIntrinsic`) covers both.
  // `phoenixLiveView` was retired here by reusing the domain-side
  // `ELIXIR_INTRINSIC_RENDERERS` table (`render-expr.ts`) directly in
  // `heex-walker-core.ts`'s `renderMethodCall` — HEEx page bodies always
  // render in-memory (never an Ecto query filter), so the plain `String.*`/
  // `Decimal.*` arm is the only one a page body ever needs.
]);

/** The fixture's own two-deployable tail: a `node` backend plus a `static`
 *  bundle host wired to it with `targets:`.  Matched exactly (and asserted
 *  present) so a fixture edit can never silently turn the self-hosting
 *  retarget below into a no-op. */
const SPA_DEPLOYABLES = `  deployable api {
    platform: node
    contexts: [Products]
    dataSources: [productsState]
    serves: CatalogApi
    port: 3000
  }

  deployable web_app {
    platform: static
    targets: api
    port: 3001
    ui: Showcase { Catalog: api }
  }`;

/** The SELF-HOSTING tail: one deployable that owns the contexts AND renders
 *  the ui — the shape a Phoenix LiveView app actually ships in.  The api
 *  handle binds to the deployable itself, since it serves `CatalogApi`. */
const SELF_HOSTED_DEPLOYABLE = (platform: string): string => `  deployable web_app {
    platform: ${platform}
    contexts: [Products]
    dataSources: [productsState]
    serves: CatalogApi
    ui: Showcase { Catalog: web_app }
    port: 3001
  }`;

/**
 * Retarget the one fixture onto a frontend.
 *
 * The `hosting` axis is the load-bearing part.  This used to be a blind
 *
 *     .replace("platform: static", `platform: ${platform}`)
 *
 * which, for `phoenixLiveView`, produced `platform: elixir` + `targets: api`
 * — a combination the VALIDATOR REJECTS (`loom.unknown`: "'targets:' is only
 * valid on a frontend deployable").  `generateSystemFiles` did not assert
 * validation back then, so nothing said so, and the leg
 * emitted anyway — from a system where `enrichDeployables` had backfilled
 * NOTHING.  That backfill (`contextNames` inherited from `targets:`) is gated
 * on `descriptorFor(d.platform).isFrontend`, and `elixir` is correctly
 * `isFrontend: false` (Phoenix self-hosts), so the deployable resolved
 * `contextNames: []`: zero aggregates, zero value objects, zero repositories.
 *
 * The leg was therefore asserting "no degradation sentinel" over pages that
 * had never resolved a single domain reference — the "gate that never reaches
 * the thing it names" shape (experience_gathered.md §59, §63).  It is exactly
 * why the VO-construction/primitive-name collision fixed in #2484 was
 * invisible here: with no value objects in scope there was no collision to
 * have.  The companion `validates cleanly` test below is what keeps this
 * honest from now on.
 */
/** The fixture's read-bearing component, and where the HEEx leg has to put it.
 *
 *  `component RecentProducts` hosts a `QueryView` on purpose: it is the shape
 *  that buys "an api read inside a component body" real per-frontend COMPILER
 *  coverage (#2654), and it works on all six JSX/markup targets.
 *
 *  It does NOT work on Phoenix.  A HEEx function component is a pure render
 *  function, so the read's `@items` assign has to come from the host page's
 *  LiveView — and only a component's `state`/`action`s are lifted there (#2646).
 *  The emitted component referenced an assign the host never made: output that
 *  passes `mix compile --warnings-as-errors` and then 500s on page load.  That
 *  is now `loom.heex-component-host-state-unsupported`, so the retargeted model
 *  is REJECTED rather than silently emitted.
 *
 *  Generating it anyway (`generateSystemFilesUnchecked`) would put this leg back
 *  to scanning output no user can obtain — the exact failure this function's own
 *  header documents.  So the HEEx leg keeps the component and moves the READ up
 *  into the page that already renders it: every other shape in the showcase
 *  still reaches the HEEx emitter, and the six JSX legs keep the
 *  read-in-component coverage unchanged.  Delete this transform when the
 *  hoisting lands and the gate's register row drains. */
const READ_IN_COMPONENT = `        QueryView { of: Catalog.Product.all, data: rows => Stack {
          For { each: rows, p => Text { p.name } }
        } }`;
const READ_IN_COMPONENT_HEADING = `        Heading { title, level: 3 },\n${READ_IN_COMPONENT}`;
const RECENT_PRODUCTS_CALL = `        RecentProducts { title: "Recent" }`;

function liftReadOutOfComponent(base: string): string {
  expect(
    base.includes(READ_IN_COMPONENT_HEADING) && base.includes(RECENT_PRODUCTS_CALL),
    "the fixture's read-bearing component changed — update READ_IN_COMPONENT, or the " +
      "phoenixLiveView leg silently stops generating",
  ).toBe(true);
  return base
    .replace(READ_IN_COMPONENT_HEADING, `        Heading { title, level: 3 }`)
    .replace(RECENT_PRODUCTS_CALL, `${RECENT_PRODUCTS_CALL},\n${READ_IN_COMPONENT}`);
}

function retargetFixture(target: { framework: string; platform: string; hosting: string }): string {
  let base = loadExample(FIXTURE).replace("framework: react", `framework: ${target.framework}`);
  if (target.framework === "phoenixLiveView") base = liftReadOutOfComponent(base);
  if (target.hosting === "self") {
    expect(
      base.includes(SPA_DEPLOYABLES),
      "the fixture's deployable tail changed — update SPA_DEPLOYABLES, or the " +
        "self-hosting retarget silently stops applying",
    ).toBe(true);
    return base.replace(SPA_DEPLOYABLES, SELF_HOSTED_DEPLOYABLE(target.platform));
  }
  return base.replace("platform: static", `platform: ${target.platform}`);
}

async function generateFor(target: {
  framework: string;
  platform: string;
  hosting: string;
}): Promise<Map<string, string>> {
  return await generateSystemFiles(retargetFixture(target));
}

describe("frontend render degradation — the emitted page must not give up", () => {
  // -------------------------------------------------------------------------
  // THE FIRST GATE ON THE GATE: can each sentinel fire at all?
  //
  // Every pattern below is a copy of an emitter's wording kept in a second
  // file.  That makes the dangerous failure "the emitter was reworded" rather
  // than "the regex is wrong": the scan keeps passing, over output it can no
  // longer read.  A pattern nothing can trip proves nothing, and it proves it
  // silently — the exact shape of experience_gathered.md §59/§63.
  //
  // So each sentinel names its origin: the emitter file and the EXACT template
  // literal.  Two assertions per origin, one per direction:
  //
  //   1. the template is still IN that file           (the emitter still says it)
  //   2. the pattern matches what the template RENDERS (the regex still reads it)
  //
  // (2) substitutes every `${…}` with a concrete word and wraps the result the
  // way `renderComment` does on the JSX family, which is what the `unresolved
  // ref` pattern's trailing `*/` is matching against.
  // -------------------------------------------------------------------------
  it("the sentinels can still fire — every pattern matches its own emitter", () => {
    const broken: string[] = [];
    for (const { label, re, origins } of SENTINELS) {
      expect(
        origins.length,
        `${label}: a sentinel with no origin cannot be kept honest`,
      ).toBeGreaterThan(0);
      for (const { file, template } of origins) {
        if (!readFileSync(file, "utf8").includes(template)) {
          broken.push(`${label}: ${file} no longer contains ${template}`);
          continue;
        }
        const rendered = `/* ${template.replaceAll("`", "").replace(/\$\{[^}]*\}/g, "flutter")} */`;
        if (!new RegExp(re.source).test(rendered))
          broken.push(`${label}: /${re.source}/ does not match its own output \`${rendered}\``);
      }
    }
    expect(
      broken,
      "a degradation sentinel has drifted from the emitter it was copied from — the scan " +
        "below is reading output it can no longer recognise:\n" +
        broken.join("\n"),
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The gate ON the gate.  Every assertion below reads emitted output, so a
  // retarget that produces an INVALID system would have every downstream
  // assertion running against a system the compiler refuses.
  //
  // That is not hypothetical: the phoenixLiveView leg did exactly this until
  // this test existed — `platform: elixir` + `targets: api`, rejected by
  // `loom.unknown`, emitting pages whose deployable resolved `contextNames:
  // []`.  See `retargetFixture`.
  //
  // `generateSystemFiles` now asserts phases ①/④/⑦ itself (M-T9.34), so the
  // downstream legs can no longer emit from a refused model either way.  This
  // check stays because it runs FIRST and names the fixture: a topology
  // regression reports as itself rather than as a confusing sentinel diff
  // buried in a generate failure.
  // -------------------------------------------------------------------------
  for (const target of TARGETS) {
    it(`${target.framework}: the retargeted fixture validates cleanly`, async () => {
      const { errors } = await parseString(retargetFixture(target));
      expect(
        errors,
        `${target.framework}: the retargeted fixture does not compile, so every ` +
          `degradation assertion below runs against a system the validator rejects`,
      ).toEqual([]);
    }, 120_000);
  }

  for (const target of TARGETS) {
    it(`${target.framework}: no degradation sentinel in any emitted page`, async () => {
      const files = await generateFor(target);
      const pages = [...files.entries()].filter(([k]) => target.pages.test(k));
      expect(pages.length, `no page files matched for ${target.framework}`).toBeGreaterThan(0);

      const found: string[] = [];
      for (const [path, content] of pages) {
        for (const { label, re } of SENTINELS) {
          for (const m of content.matchAll(new RegExp(re.source, re.flags))) {
            found.push(`${label}${m[1] ? ` (${m[1]})` : ""} @ ${path}`);
          }
        }
      }

      const labels = new Set(found.map((f) => f.split(" (")[0]!.split(" @")[0]!));
      const unexpected = [...labels].filter(
        (l) => !KNOWN_DEGRADATIONS.has(`${target.framework}:${l}`),
      );
      expect(
        unexpected,
        `${target.framework}: NEW degradation(s).  Fix the emitter — do not add a ratchet entry ` +
          `to silence this.\n${found.join("\n")}`,
      ).toEqual([]);
    }, 120_000);
  }

  // -------------------------------------------------------------------------
  // The one producer the SHARED FIXTURE cannot host — proven here instead.
  //
  // `Tab` and `Column` are the walker's two `group: "sub"` primitives: no
  // top-level renderer of their own, because their parent consumes them inline
  // (`emitTabs` scans for `Tab(...)`, `emitTable` for `Column(...)`).  Spelled
  // anywhere else the call reaches `emitComponent`'s "registered primitive with
  // no `tsx`" arm and the element — with everything nested inside it —
  // disappears behind a comment.  That arm is the `primitive not supported`
  // sentinel's only reachable producer today.
  //
  // It cannot go in `expression-showcase.ddd`: `loom.sub-primitive-misplaced`
  // (#2595) rejects the placement at IR-validate, and the `validates cleanly`
  // leg above requires the fixture to compile.  That gate is the belt; this
  // comment arm is the braces, and it is still reached by an UNVALIDATED model
  // — a playground buffer mid-edit, `loom_generate` over a partial source, a
  // macro-built body.  So the sentinel gets its own purpose-built system,
  // which also proves the two spellings (`walker-core.ts`'s and the parallel
  // HEEx engine's) both still match.
  // -------------------------------------------------------------------------
  const misplacedSubPrimitive = (frontend: string): string => `
    system MisplacedSub {
      subdomain S {
        context C {
          aggregate Thing { name: string }
          repository Things for Thing { }
        }
      }
      storage db { type: postgres }
      resource st { for: C, kind: state, use: db }
      ui W {
        framework: ${frontend}
        page Home { route: "/" body: Stack { Tab { "solo" } } }
      }
      deployable api {
        platform: ${frontend === "phoenixLiveView" ? "elixir" : "node"}
        contexts: [C]
        dataSources: [st]
        port: 3000
        ${frontend === "phoenixLiveView" ? "ui: W" : ""}
      }
      ${
        frontend === "phoenixLiveView"
          ? ""
          : `deployable web { platform: static, targets: api, ui: W, port: 3001 }`
      }
    }`;

  it.each([
    ["react", /\/src\/pages\/.*\.tsx$/],
    ["phoenixLiveView", /_live\.ex$|\.html\.heex$/],
  ] as const)(
    "%s: the `primitive not supported` sentinel fires on a misplaced sub-primitive",
    async (frontend, pages) => {
      // The misplacement IS the subject: a `Tab` outside a `Tabs` is what
      // `loom.sub-primitive-misplaced` rejects, and the sentinel only exists
      // for the primitive the walker then cannot render.  Emitting from a
      // model the CLI refuses is the premise, not a stale fixture.
      const files = await generateSystemFilesUnchecked(
        misplacedSubPrimitive(frontend),
        "the solo `Tab` is the premise — loom.sub-primitive-misplaced firing is " +
          "what puts the `primitive not supported` sentinel on the path under test",
      );
      const bodies = [...files.entries()].filter(([k]) => pages.test(k)).map(([, v]) => v);
      expect(bodies.length, `no page files matched for ${frontend}`).toBeGreaterThan(0);
      const re = SENTINELS.find((s) => s.label === "primitive not supported")!.re;
      expect(
        bodies.some((b) => new RegExp(re.source).test(b)),
        `${frontend}: the misplaced \`Tab\` produced no sentinel — either the walker now ` +
          `renders it (delete this test and the sentinel with it) or the pattern has drifted:\n` +
          bodies.join("\n"),
      ).toBe(true);
    },
    120_000,
  );

  // -------------------------------------------------------------------------
  // A READ-BEARING user component — the api handle must resolve in the
  // COMPONENT's own shell, not only in a page's.
  //
  //     component RecentOrders(title: string) {
  //       body: QueryView { of: Sales.Order.all, data: rows => … }
  //     }
  //
  // This was a ratchet (`READ_BEARING_COMPONENT_BROKEN`) over React, Vue and
  // Svelte, drained by #2654.  All three component-file emitters handed the
  // component walk an EMPTY api-param list — `walkBody(…, [], …)` — where the
  // page shell passes the ui's real `ui.apiParams`.  The handle resolved to
  // nothing, `emitExpr`'s ref fallthrough emitted `undefined`, and the member
  // chain was appended to it:
  //
  //   React →  { /* unresolved: Sales */ undefined.Order.all.isLoading && ( … ) }
  //   Vue   →  <template v-if="/* unresolved: Sales */ undefined.Order.all.isLoading">
  //   Svelte→  {#if /* unresolved: Sales */ undefined.Order.all.isLoading}
  //
  // Not a missing element: a guaranteed `TypeError`, and code that fails
  // `tsc --noEmit` / `vue-tsc` / `svelte-check` (TS18050 ×7 on the React build
  // gate).  It stayed invisible because no `.ddd` in the repo put a read inside
  // a component body — the same "coverage the gate never had" this whole
  // fixture exists to end.  `expression-showcase.ddd` now hosts the shape
  // (`component RecentProducts`), so the per-frontend build gates COMPILE it;
  // this leg is the string-level twin, and the one that also covers Feliz and
  // Flutter (fixed earlier by #2568).
  //
  // Kept after the drain rather than deleted with the ratchet: the assertion
  // that survives is the one worth having — every frontend resolves the handle.
  // It scans EVERY emitted file, not just the page-path subset the sentinel
  // loop above filters to, which is what lets it see a `src/components/` file
  // at all.
  // -------------------------------------------------------------------------
  const readBearingComponent = (frontend: string): string => `
    system ReadInComponent {
      subdomain M {
        context Sales {
          aggregate Order { customerId: string }
          repository Orders for Order { }
        }
      }
      api SalesApi from M
      storage db { type: postgres }
      resource st { for: Sales, kind: state, use: db }
      ui W {
        framework: ${frontend}
        api Sales: SalesApi
        component RecentOrders(title: string) {
          body: Stack {
            Heading { title, level: 2 },
            QueryView { of: Sales.Order.all, data: rows => Stack {
              For { each: rows, o => Text { o.customerId } }
            } }
          }
        }
        page Home { route: "/" body: Stack { RecentOrders(title: "Recent") } }
      }
      deployable api {
        platform: node, contexts: [Sales], dataSources: [st], serves: SalesApi, port: 3000
      }
      deployable web {
        platform: ${frontend === "feliz" || frontend === "flutter" ? frontend : "static"}
        targets: api
        ui: W { Sales: api }
        port: 3001
      }
    }`;

  it.each([
    "react",
    "vue",
    "svelte",
    "angular",
    "feliz",
    "flutter",
  ] as const)("%s: read-bearing user component — the api handle resolves", async (frontend) => {
    const files = await generateSystemFiles(readBearingComponent(frontend));
    const re = SENTINELS.find((s) => s.label === "unresolved name")!.re;
    const hits = [...files.entries()]
      .filter(([, v]) => new RegExp(re.source).test(v))
      .map(([k]) => k);
    expect(
      hits,
      `${frontend}: a read-bearing user component emitted \`/* unresolved: … */ undefined\` — ` +
        `the component-file emitter is not threading the ui's \`apiParams\` into the component ` +
        `walk (the page shell does; make the component path match it)`,
    ).toEqual([]);
  }, 120_000);

  // -------------------------------------------------------------------------
  // A third failure mode, and the one the sentinel scan is structurally blind
  // to: output that is neither a give-up marker nor a Loom spelling, but
  // simply NOT WELL-FORMED in the target language.
  //
  // HEEx is where this bites, because its expression slots and its markup
  // share one syntax.  Both bugs fixed in #2484 landed here and neither
  // tripped a sentinel — they emitted text that merely fails `mix compile`:
  //
  //   <%= <span class="money">…</span>.currency %>   a display primitive's
  //                                                  MARKUP in a value slot
  //   <%= <%= cond do … end %> %>                    a match wrapped twice
  //
  // Both share one signature: a `<%= … %>` region whose BODY contains another
  // `<%=`, or a closing tag.  Neither is legal Elixir in an expression
  // position, and neither can occur legitimately — which makes this a cheap,
  // precise well-formedness check rather than a heuristic.  Scoped to the
  // targets whose pages are HEEx; the JSX/F#/Dart legs get their
  // well-formedness from their own compilers in the per-frontend build gates.
  // -------------------------------------------------------------------------
  for (const target of TARGETS.filter((t) => t.framework === "phoenixLiveView")) {
    it(`${target.framework}: no nested \`<%=\` or stray closing tag inside an expression slot`, async () => {
      const files = await generateFor(target);
      const pages = [...files.entries()].filter(([k]) => target.pages.test(k));
      expect(pages.length, `no page files matched for ${target.framework}`).toBeGreaterThan(0);

      const bad: string[] = [];
      for (const [path, content] of pages) {
        // Non-greedy to the FIRST `%>`, so a well-formed slot yields its own
        // body and a double-wrapped one yields a body still holding the inner
        // `<%=` — exactly the discriminator.
        for (const m of content.matchAll(/<%=([\s\S]*?)%>/g)) {
          const body = m[1] ?? "";
          if (body.includes("<%=")) bad.push(`nested <%= @ ${path}: ${m[0].slice(0, 90)}`);
          else if (body.includes("</")) bad.push(`closing tag @ ${path}: ${m[0].slice(0, 90)}`);
        }
      }
      expect(
        bad,
        `${target.framework}: emitted HEEx that will not compile — an expression slot ` +
          `contains markup or another slot.\n${bad.join("\n")}`,
      ).toEqual([]);
    }, 120_000);
  }

  // -------------------------------------------------------------------------
  // The second failure mode: not "gave up", but "emitted the Loom spelling".
  // `s.toUpper()` is not JavaScript, F#, Dart or Elixir — every target must
  // translate it through a snippet table.  Untranslated, it is a compile error
  // where the host language has no such member, and SILENTLY WRONG where it
  // has one that means something else (`replace`, `substring`).
  // -------------------------------------------------------------------------
  for (const target of TARGETS) {
    const known = KNOWN_VERBATIM_INTRINSICS.has(target.framework);
    it(`${target.framework}: no Loom intrinsic spelling survives into the page${known ? " (ratcheted)" : ""}`, async () => {
      const { INTRINSIC_SIGNATURES } = await import("../../../src/util/intrinsics.js");
      const files = await generateFor(target);
      const pages = [...files.entries()].filter(([k]) => target.pages.test(k));
      const raw = new Set<string>();
      for (const [, content] of pages) {
        for (const sig of INTRINSIC_SIGNATURES) {
          // Only the ops whose Loom spelling has NO same-named counterpart in
          // the host language would be unambiguous; rather than model that per
          // target, look for the Loom-only names, which no target legitimately
          // emits: `toUpper` / `toLower` / `divTrunc`.
          if (!["toUpper", "toLower", "divTrunc"].includes(sig.name)) continue;
          // HEEx snake-cases the member on its way out (`to_upper()`), so the
          // Loom name survives in either casing — check both.
          const spellings = [sig.name, snake(sig.name)];
          if (spellings.some((s) => new RegExp(`\\.${s}\\s*\\(`).test(content))) raw.add(sig.name);
        }
      }
      if (known) {
        expect(
          raw.size,
          `${target.framework} is ratcheted as emitting verbatim intrinsics but emitted none — ` +
            `delete it from KNOWN_VERBATIM_INTRINSICS`,
        ).toBeGreaterThan(0);
      } else {
        expect(
          [...raw],
          `${target.framework}: Loom intrinsic spelling survived into the emitted page`,
        ).toEqual([]);
      }
    }, 120_000);
  }

  // -------------------------------------------------------------------------
  // The ratchet's blind spot, closed from the other side.
  //
  // An EMPTY ratchet says "the fixture degrades nowhere", not "nothing
  // degrades".  Both remaining component emitters still FILTER shapes out of
  // their emitted set (`emitFelizUserComponents` / `emitAngularUserComponents`),
  // and a filtered component renders `unknown layout component: <Name>` at every
  // call site — the exact sentinel the two deleted rows named.  This fixture
  // declares no components, so the scan above can never see it.
  //
  // What keeps the emptiness honest is that those shapes are now REJECTED at
  // validation (`loom.user-component-deferred-target`), so the sentinel is
  // unreachable from input the compiler accepts.  This asserts BOTH halves of
  // that claim per framework — the emitter still degrades, and the validator
  // still refuses — so the day either side moves, this fails rather than the
  // gap going quiet.  The full per-(framework, shape) matrix lives in
  // `test/ir/user-component-deferred.test.ts`; this is the link, not a copy.
  // -------------------------------------------------------------------------
  const DEFERRED_COMPONENT_SHAPES = [
    { framework: "feliz", platform: "feliz", pages: /App\.fs$/ },
    { framework: "angular", platform: "angular", pages: /\/src\/app\// },
  ] as const;

  const slotComponentSystem = (platform: string) => `
system S {
  subdomain M { context Sales {
    aggregate Order with crudish { customerId: string }
    repository Orders for Order { }
  } }
  api SalesApi from M
  ui WebApp {
    api Sales: SalesApi
    component Panel(head: slot) { body: Card { head } }
    page Home { route: "/" body: Stack { Panel(head: Text { "hi" }) } }
  }
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable api { platform: node contexts: [Sales] serves: SalesApi dataSources: [salesState] port: 3000 }
  deployable web { platform: ${platform} targets: api ui: WebApp { Sales: api } port: 3005 }
}`;

  for (const target of DEFERRED_COMPONENT_SHAPES) {
    it(`${target.framework}: a deferred user component still degrades — and is now REJECTED, which is why the ratchet can be empty`, async () => {
      const src = slotComponentSystem(target.platform);
      // Unchecked on purpose: the refusal half below asserts this very model is
      // rejected; this half emits from it to prove the degradation is still real.
      const files = await generateSystemFilesUnchecked(
        src,
        "the deferral sentinel must stay reachable from the model loom.user-component-deferred-target rejects — both halves of the fix-or-gate claim are asserted here",
      );
      const pages = [...files.entries()].filter(([k]) => target.pages.test(k));
      expect(pages.length, `no page files matched for ${target.framework}`).toBeGreaterThan(0);
      expect(
        pages.some(([, c]) => c.includes("unknown layout component: Panel")),
        `${target.framework}: the component emitter no longer defers a \`slot\` param — ` +
          `delete the arm from ui-checks.ts (and this row) in the same PR`,
      ).toBe(true);
      const codes = (await validate(src)).diagnostics.map((d) => d.code);
      expect(
        codes,
        `${target.framework}: the emitter drops this component but validation accepts it — ` +
          `the sentinel is reachable from valid input again, so the ratchet's emptiness lies`,
      ).toContain("loom.user-component-deferred-target");
    }, 120_000);
  }

  it("the ratchet only lists degradations that are still real", async () => {
    // A stale entry is worse than a missing one: it hides a regression AND
    // implies work that is already done.  Prove every entry still fires.
    const stale: string[] = [];
    for (const target of TARGETS) {
      const expected = [...KNOWN_DEGRADATIONS.keys()].filter((k) =>
        k.startsWith(`${target.framework}:`),
      );
      if (expected.length === 0) continue;
      const files = await generateFor(target);
      const pages = [...files.entries()].filter(([k]) => target.pages.test(k));
      const seen = new Set<string>();
      for (const [, content] of pages)
        for (const { label, re } of SENTINELS)
          if (new RegExp(re.source).test(content)) seen.add(`${target.framework}:${label}`);
      for (const key of expected) if (!seen.has(key)) stale.push(key);
    }
    expect(stale, `ratchet entries no longer firing — delete them: ${stale.join(", ")}`).toEqual(
      [],
    );
  }, 300_000);
});
