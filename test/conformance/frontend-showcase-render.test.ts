import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeFlutterParity } from "../../src/generator/flutter/parity.js";
import { repoRoot } from "../_helpers/examples.js";
import { generateSystemFiles } from "../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Cross-frontend FEATURE-COMPLETENESS matrix — the frozen who-renders-what gate.
//
// `showcase-completeness.test.ts` proves `examples/showcase.ddd` exercises every
// language feature and every walker primitive — but only against the REACT
// registry. Each other frontend runs its own smaller, hand-picked example, so a
// feature React renders can silently fail to render on Vue / Svelte / Angular /
// Feliz / Flutter / Phoenix-HEEx, with nothing to catch it (their build gates
// never see `showcase.ddd`).
//
// This drives the WHOLE showcase UI surface — the hand-written `Console` (explicit
// api params + forms + operations + a slot/action user component), the scaffolded
// `Admin`, and the sugar-bound `Ops` — through EVERY frontend generator, in the
// fast suite (no docker / no framework compiler). Each `frontend × ui` cell must
// either render cleanly or be a FROZEN, reasoned gap in `GAPS` below.
//
// Two failure modes count as "does not render":
//   1. a THROW — the generator fails-fast on a construct it cannot emit
//      (e.g. Feliz's expr/action fail-fast, Vue's prop-kind guard);
//   2. a SILENT-FALLBACK marker — the shared walker emits a "not supported"
//      comment for an unrenderable primitive/seam.
//
// The freeze is BIDIRECTIONAL, exactly like `heex-parity.test.ts`:
//   - a cell that starts failing WITHOUT a `GAPS` entry fails CI (a new silent
//     gap — write the renderer or add a reasoned entry);
//   - a `GAPS` cell that now renders ALSO fails CI (the gap closed — delete the
//     entry, a welcome direction).
//
// Generation-level only; compiling each frontend's output stays the per-frontend
// build gate's job (`generated-{react,vue,svelte,angular,feliz,flutter}-build.yml`,
// and `elixir-vanilla-build.yml` for the HEEx row's `mix compile`).
// ---------------------------------------------------------------------------

/** Frozen, reasoned gaps — `"<frontend>:<ui>"` → WHY it does not render today.
 *  Adding a NEW gap here is a reviewed decision; closing one means deleting the
 *  entry. Keep EMPTY-by-default discipline: an entry is debt, not a resting state. */
const GAPS: Record<string, string> = {
  // The four static-bundle frontends and Feliz render the whole showcase UI
  // surface against `FALLBACK_MARKERS`. (Vue's user-component slot/action
  // props, once a gap here, now render: the slot is template `<slot>`, the
  // action a callback prop — page-shell.ts / vue-target.ts.)  The two entries
  // below are the Flutter row's first-run findings; both are FILED, not fixed,
  // and both are `flutterTarget.renderComment` drops — the widget and
  // everything under it collapse to `const SizedBox.shrink() /* … */`.

  // FINDING F1 — `Kitchen`'s
  //     QueryView { of: …, single: true, data: row => OperationForm { row.rename } }
  // The instance-qualified operation form resolves its aggregate through
  // `ctx.paramTypes.get("row")` (`_walker/primitives/forms.ts` →
  // `emitFormOfOperation`).  A `QueryView { data: … }` render-lambda binding is
  // not registered there, so the form degrades to
  //     Form(row.rename): 'row' is not an in-scope aggregate instance
  // and the operation form vanishes from the page.
  //
  // NOT Flutter-specific — measured on this same cell, react / vue / svelte /
  // feliz emit the byte-equivalent comment in their own syntax
  // (`{/* … */}` / `<!-- … -->` / `(* … *)`), and Angular emits neither the form
  // NOR a comment.  They stay green here only because `FALLBACK_MARKERS` cannot
  // see that wording; the Flutter row sees it because `analyzeFlutterParity`
  // treats ANY `/* … */` in emitted Dart as a diagnostic.  Widening the shared
  // marker list flips five currently-green cells amber, so it is its own slice —
  // filed, not smuggled in here.
  "flutter:Console":
    "F1 — QueryView `data:` lambda binding is not in `paramTypes`, so " +
    "`OperationForm { row.rename }` degrades (shared walker; react/vue/svelte/feliz same, unseen)",

  // FINDING F2 — every scaffolded Detail page's operation surface.
  // `scaffoldOperations` (macros/stdlib/scaffold/_body-builders.ts) emits the
  // INSTANCE-QUALIFIED shape whenever the ops sit inside the Detail QueryView's
  // `data` lambda: `Modal { trigger: Button {…}, OperationForm { data.<op> } }`.
  // Flutter's `renderModal` (`flutter/flutter-target.ts`) only understands the
  // by-name shape (`OperationForm { of: <Agg>, op: <op> }`) and otherwise emits
  //     Modal: OperationForm child must name of: <Agg> and op: <public op>
  // so the ENTIRE operations row of `EngineerDetail` and `SquadDetail` is a
  // `SizedBox.shrink()` — every write action on a scaffolded Flutter app is
  // missing.  The fix is a Flutter `renderModal` arm for the instance-qualified
  // child (the shared walker already has one); filed for the next batch.
  "flutter:Admin":
    "F2 — Flutter `renderModal` only matches `OperationForm { of:, op: }`, but " +
    "`scaffoldOperations` emits `OperationForm { data.<op> }`, dropping the whole ops row",
};

/** The showcase UIs' three binding forms, plus the api each targets.
 *
 *  `bind` is the CLIENT form (a frontend deployable wired with `targets:`);
 *  `selfBind` re-points the same ui at the self-hosting deployable itself,
 *  which is the only legal shape on Phoenix — `targets:` is a validator ERROR
 *  on a backend deployable, and `enrichDeployables` backfills `contextNames`
 *  from `targets:` only when `descriptorFor(platform).isFrontend`.  Getting
 *  that wrong emits from a system whose deployable resolved `contextNames: []`
 *  — pages with zero aggregates in scope, which is the "gate that never reaches
 *  the thing it names" shape (#2642's `retargetFixture`, experience_gathered
 *  §59/§63).  `generateSystemFiles` asserting phase ④ is what keeps it honest. */
const UIS: Record<string, { bind: string; selfBind: string; api: string }> = {
  Console: {
    bind: "ui: Console { Projects: dotnetApi, Delivery: dotnetApi, Accounts: dotnetApi }",
    selfBind: "ui: Console { Projects: feCell, Delivery: feCell, Accounts: feCell }",
    api: "dotnetApi",
  },
  Ops: { bind: "ui: Ops", selfBind: "ui: Ops", api: "honoApi" },
  Admin: { bind: "ui: Admin", selfBind: "ui: Admin", api: "honoApi" },
};

/** Silent-degradation markers the shared/per-frontend walkers emit when they
 *  cannot render a construct (the fail-fast path THROWS instead).  The Feliz
 *  procedural pack emits `(* feliz pack: no renderer for "X" *)` — a compile-clean
 *  F# block comment — when its `RENDERERS` table lacks a primitive; catching that
 *  substring here is what makes a silently-dropped Feliz primitive fail this
 *  matrix (the load-time `REQUIRED_PRIMITIVES` gate never runs for the procedural
 *  pack — see `feliz-pack-groundwork.test.ts` for its structural sibling).
 *
 *  `\w+ pack: no renderer` also covers Flutter's identical fallback
 *  (`// flutter pack: no renderer for "X"`, `flutter/pack.ts`). */
const FALLBACK_MARKERS = [
  "not supported",
  "unsupported expr",
  "unknown layout component",
  "pack: no renderer",
];

/**
 * What keeps `FALLBACK_MARKERS` HONEST — every give-up wording it is meant to
 * read, pinned to the emitter that writes it.
 *
 * A marker is a copy of an emitter's wording living in a second file, so the
 * dangerous failure is not "the substring is wrong" but "the emitter was
 * reworded and the list silently stopped matching" — which reads as a green
 * gate over output it can no longer recognise.  #2642 hit exactly this: the
 * `not supported by the React walker` arm was reworded to drop React's name.
 *
 * Each entry names the emitter source and the EXACT template literal; the test
 * below asserts BOTH directions — the template is still in that file, and some
 * `FALLBACK_MARKERS` entry still matches what it renders to.
 *
 * The Phoenix entry is why the HEEx row needs no scanner of its own: LiveView's
 * parallel engine has exactly ONE give-up arm, and its wording is a superset of
 * the shared `"not supported"` marker.  (Deliberately NOT pinned: HEEx's benign
 * `<%!-- <op> has no parameters --%>` note, which is information rather than
 * degradation, and the `For:` / `Chart:` shape guards, which no valid showcase
 * body can reach — a pattern nothing in this matrix can trip proves nothing.)
 */
const MARKER_ORIGINS: ReadonlyArray<{ label: string; file: string; template: string }> = [
  {
    label: "shared walker: registered primitive with no renderer on this target",
    file: "src/generator/_walker/walker-core.ts",
    template: "`${call.name}: not supported by the walker yet`",
  },
  {
    label: "shared walker: name resolves to no primitive or component",
    file: "src/generator/_walker/walker-core.ts",
    template: "`unknown layout component: ${call.name}`",
  },
  {
    label: "shared walker: expression kind with no frontend rendering",
    file: "src/generator/_walker/walker-core.ts",
    template: "`unsupported expr: ${expr.kind}`",
  },
  {
    label: "HEEx engine: registered primitive with no `heex` renderer",
    file: "src/generator/elixir/heex-walker-core.ts",
    template: "`<%!-- ${expr.name}: not supported by Phoenix LiveView target --%>`",
  },
  {
    label: "Feliz pack: primitive missing from the RENDERERS table",
    file: "src/generator/feliz/pack.ts",
    template: '`(* feliz pack: no renderer for "${name}" *)`',
  },
  {
    label: "Flutter pack: primitive missing from the RENDERERS table",
    file: "src/generator/flutter/pack.ts",
    template: '`// flutter pack: no renderer for "${name}"`',
  },
];

/** `flutterTarget.renderComment` — the shape EVERY Flutter walker fallback
 *  takes, and the reason `analyzeFlutterParity` can be trusted as this row's
 *  scanner: generated Dart otherwise uses only `//` banner comments, so a
 *  `/* … *​/` in a `.dart` file is always a diagnostic.  Pinned so a change of
 *  comment syntax fails here instead of silently emptying the scan. */
const FLUTTER_COMMENT_ORIGIN = {
  file: "src/generator/flutter/flutter-target.ts",
  template: "renderComment: (text: string) => `const SizedBox.shrink() /* ${text} */`,",
};

interface Frontend {
  /** Matrix key. */
  readonly name: string;
  /** The injected cell deployable for one ui. */
  readonly deployable: (ui: string) => string;
  /** Emitted paths carrying this frontend's RENDERED output.  Omitted = the
   *  whole deployable (a frontend project is nothing but rendered output). */
  readonly rendered?: RegExp;
  /** Target-specific scan layered on top of `FALLBACK_MARKERS`. */
  readonly extraScan?: (emitted: ReadonlyArray<readonly [string, string]>) => string | null;
}

/** A client frontend served as a static/self-built bundle beside a backend. */
const spa =
  (platform: string) =>
  (ui: string): string =>
    `    deployable feCell { platform: ${platform} targets: ${UIS[ui]!.api} ${UIS[ui]!.bind} port: 3900 }`;

const FRONTENDS: ReadonlyArray<Frontend> = [
  { name: "react", deployable: spa("react") },
  { name: "vue", deployable: spa("vue") },
  { name: "svelte", deployable: spa("svelte") },
  { name: "angular", deployable: spa("angular") },
  { name: "feliz", deployable: spa("feliz") },
  {
    // Flutter is self-building (the Flutter SDK, not the vite static pipeline)
    // but still a CLIENT frontend: `targets:` a backend, no db of its own.
    name: "flutter",
    deployable: spa("flutter"),
    // On top of the shared markers, run the emitter's OWN fallback scanner
    // rather than re-deriving its wording here.  `analyzeFlutterParity` is what
    // the playground's "will my app fully lower to Flutter?" badge reads; it
    // treats any `/* … */` block comment, any `// TODO(flutter …)` line and the
    // pack's `no renderer` fallback in emitted Dart as a finding.  Reusing it
    // means a NEW Flutter fallback wording is covered the day it is added.
    extraScan: (emitted) => {
      const findings = analyzeFlutterParity(new Map(emitted));
      if (findings.length === 0) return null;
      return `FLUTTER PARITY: ${findings
        .map((f) => `[${f.kind}] ${f.file}:${f.line} ${f.message}`)
        .join(" | ")}`;
    },
  },
  {
    // Phoenix LiveView — the SELF-HOSTING topology.  It owns the contexts and
    // renders the ui in one deployable; `serves:` is what lets `Console`'s api
    // params bind back to `feCell` itself.
    name: "heex",
    deployable: (ui) => `    deployable feCell {
        platform: elixir
        contexts: [Catalog, Builds, People]
        dataSources: [catalogState, buildsState, peopleState]
        serves: ProjectsApi, DeliveryApi, AccountsApi
        ${UIS[ui]!.selfBind}
        port: 3900
        auth: required
    }`,
    // A Phoenix deployable emits the WHOLE backend under `fe_cell/`, not just
    // rendered markup — and one of those backend files legitimately contains a
    // `FALLBACK_MARKERS` substring: `not_found_controller.ex` answers a 404 with
    // "... is not supported for #{conn.request_path}".  Scanning the whole
    // project would therefore report a permanent false gap.  Scope to what the
    // HEEx walker + design pack actually render.
    //
    // No `extraScan`: the parallel HEEx engine's single give-up arm already
    // spells a `FALLBACK_MARKERS` substring, and `MARKER_ORIGINS` pins it there.
    rendered: /_live\.ex$|\.heex$|_web\/components\//,
  },
];

// Anchor the injected deployable on the last static frontend deployable
// (`adminWeb`) so it lands INSIDE the system, past the top-level
// requirement/solution/migration blocks that bracket it.
const ADMIN_WEB_ANCHOR = `        ui: Admin
        port: 3003
        design: shadcn
    }`;

const base = fs.readFileSync(path.join(repoRoot, "examples", "showcase.ddd"), "utf8");

function sourceFor(frontend: Frontend, ui: string): string {
  const injected = base.replace(
    ADMIN_WEB_ANCHOR,
    `${ADMIN_WEB_ANCHOR}\n\n${frontend.deployable(ui)}\n`,
  );
  // Guard the anchor still matches — a showcase edit that moves it must fail
  // loudly here, not silently drop the whole matrix's coverage.
  if (injected === base) throw new Error("adminWeb anchor no longer matches showcase.ddd");
  return injected;
}

/** Render one cell; return the failure reason, or null when it renders clean. */
async function renderCell(frontend: Frontend, ui: string): Promise<string | null> {
  let files: Map<string, string>;
  try {
    files = await generateSystemFiles(sourceFor(frontend, ui));
  } catch (e) {
    return `THROW: ${(e as Error).message}`;
  }
  const emitted = [...files].filter(([p]) => p.startsWith("fe_cell/"));
  if (emitted.length === 0) return "no files emitted for the frontend deployable";

  const scanned = frontend.rendered
    ? emitted.filter(([p]) => frontend.rendered!.test(p))
    : [...emitted];
  // A `rendered` filter that matches nothing turns the whole scan vacuous —
  // exactly the failure this file exists to prevent, so it is an error, not a pass.
  if (scanned.length === 0)
    return `no emitted path matched ${frontend.name}'s \`rendered\` filter (${frontend.rendered})`;

  for (const [p, content] of scanned) {
    for (const marker of FALLBACK_MARKERS) {
      if (content.includes(marker)) return `MARKER "${marker}" in ${p}`;
    }
  }
  return frontend.extraScan?.(scanned) ?? null;
}

describe("frontend showcase render matrix", () => {
  // -------------------------------------------------------------------------
  // THE GATE ON THE GATE — can `FALLBACK_MARKERS` still read the emitters?
  //
  // Every marker is a copy of an emitter's wording kept in this file, so the
  // dangerous failure is "the emitter was reworded" (the scan keeps passing
  // over output it can no longer read), not "the substring is wrong".  Two
  // assertions per origin, one per direction:
  //
  //   1. the template is still IN that file        (the emitter still says it)
  //   2. some marker matches what it RENDERS to    (the list still reads it)
  //
  // (2) substitutes every `${…}` with a concrete word, which is what the
  // `pack: no renderer` marker's quoted-name shape is matched against.
  //
  // The Flutter row is the one that does NOT rely on a copied wording — it
  // reuses the emitter's own scanner — so what is pinned for it is instead the
  // comment SHAPE that scanner keys on (next test).
  // -------------------------------------------------------------------------
  it("the fallback markers can still fire — every marker matches its own emitter", () => {
    const broken: string[] = [];
    for (const { label, file, template } of MARKER_ORIGINS) {
      if (!fs.readFileSync(file, "utf8").includes(template)) {
        broken.push(`${label}: ${file} no longer contains ${template}`);
        continue;
      }
      const rendered = template.replaceAll("`", "").replace(/\$\{[^}]*\}/g, "Widget");
      if (!FALLBACK_MARKERS.some((m) => rendered.includes(m)))
        broken.push(`${label}: no FALLBACK_MARKERS entry matches its own output \`${rendered}\``);
    }
    expect(
      broken,
      "a degradation marker has drifted from the emitter it was copied from — the matrix " +
        `is reading output it can no longer recognise:\n${broken.join("\n")}`,
    ).toEqual([]);
  });

  it("the Flutter parity scan can still fire — the comment shape is unchanged", () => {
    expect(
      fs.readFileSync(FLUTTER_COMMENT_ORIGIN.file, "utf8"),
      `${FLUTTER_COMMENT_ORIGIN.file} no longer emits Flutter fallbacks as ` +
        "`const SizedBox.shrink() /* … */` — `analyzeFlutterParity` keys on that block " +
        "comment, so the flutter row's extra scan is now reading nothing",
    ).toContain(FLUTTER_COMMENT_ORIGIN.template);
    // …and the scanner still reads it.
    const seeded = analyzeFlutterParity(
      new Map([["fe_cell/lib/pages/x_page.dart", "const SizedBox.shrink() /* Seeded: dropped */"]]),
    );
    expect(
      seeded.map((f) => f.message),
      "analyzeFlutterParity no longer reads a seeded fallback",
    ).toEqual(["Seeded: dropped"]);
  });

  for (const frontend of FRONTENDS) {
    for (const ui of Object.keys(UIS)) {
      const key = `${frontend.name}:${ui}`;
      const gap = GAPS[key];
      it(`${key} ${gap ? "is a frozen gap" : "renders cleanly"}`, async () => {
        const failure = await renderCell(frontend, ui);
        if (gap) {
          // A frozen gap must STILL fail — if it renders now, delete the entry.
          expect(failure, `${key} now renders — remove it from GAPS (was: ${gap})`).not.toBeNull();
        } else {
          // Every non-gap cell must render clean — a failure is a new silent gap.
          expect(failure, `${key} does not render: ${failure}`).toBeNull();
        }
      }, 120_000);
    }
  }
});
