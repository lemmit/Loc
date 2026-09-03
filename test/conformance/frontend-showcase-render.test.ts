import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { GIVE_UP_SENTINEL } from "../../src/generator/_walker/give-up.js";
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
  // Console declares `Panel(head: slot, onPick: action(Project))`, a shape the
  // angular and feliz component emitters DEFER (no content-projection channel
  // through `ngComponentOutletInputs`; no F# props-record spelling).  The
  // deferral used to be INVISIBLE to this matrix — Panel has no call site in a
  // Console page, so the declaration vanished with no marker — and is now an
  // honest phase-⑦ refusal (`loom.user-component-deferred-target`), which
  // this matrix records as the THROW below.  Closing either entry means the
  // emitter grew the shape (delete the ui-checks arm in the same PR).
  "angular:Console": "Panel's slot/action params are refused for an angular host",
  "feliz:Console": "Panel's slot/action params are refused for a feliz host",

  // The four static-bundle frontends, Feliz AND Flutter render the whole
  // showcase UI surface against `FALLBACK_MARKERS`.  (Vue's user-component
  // slot/action props, once a gap here, now render: the slot is template
  // `<slot>`, the action a callback prop — page-shell.ts / vue-target.ts.  The
  // two Flutter findings that were frozen here — F1, an `OperationForm { row.<op> }`
  // inside a `single:` QueryView, and F2, the whole operations row of every
  // scaffolded Detail page — both traced to `flutterTarget` matching only the
  // by-name `OperationForm { of:, op: }` child, and both closed when
  // `renderModal` / `renderOperationForm` grew the instance-qualified arm and
  // `forms-emit.ts`'s collector learned to emit the widget for it.)
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

/** The ONE marker every walker give-up carries (`_walker/give-up.ts`).
 *
 *  This used to be a hand-kept list of four give-up WORDINGS, and it saw one of
 *  the thirty-six the walkers actually emit.  `Timeline: not yet supported on …`
 *  does not contain the substring `"not supported"` it looked for; the `Icon`
 *  fallback is built from a variable, so it has no static wording to list at
 *  all; the rest were simply never added.  Every give-up now routes through
 *  `giveUp(...)`, which prefixes the sentinel, so this matches on STRUCTURE
 *  rather than on a copy of an emitter's prose — the failure mode the old list's
 *  own header warned about (#2642 reworded an arm and the list stopped matching
 *  in silence).
 *
 *  `walker-give-up-routing.test.ts` is what keeps this honest: it fails if any
 *  walker file emits a degradation without going through the helper. */
const FALLBACK_MARKERS = [GIVE_UP_SENTINEL];

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

/** A client frontend served as a static/self-built bundle beside a backend.
 *  `auth: ui` — Console's ProjectList gates on `requires currentUser.role`,
 *  and a currentUser read without a session binding is refused at phase ⑦
 *  (`loom.current-user-needs-auth-ui`), matching the shipped web deployables.
 *  (The HEEx cell satisfies the same gate through its `auth: required`.) */
const spa =
  (platform: string) =>
  (ui: string): string =>
    `    deployable feCell { platform: ${platform} targets: ${UIS[ui]!.api} ${UIS[ui]!.bind} port: 3900 auth: ui }`;

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
    // No `extraScan`: the parallel HEEx engine's single give-up arm carries the
    // same sentinel the shared walker's do (`heex-walker-core.ts`).
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
  // THE GATE ON THE GATE — can the scan still fire?
  //
  // The old version of this test pinned six copied WORDINGS to the emitters
  // that wrote them, because the marker list was prose duplicated in this file
  // and its dangerous failure was a silent rewording (#2642).  The sentinel
  // removes that class: there is one marker, it is imported from the emitter
  // side, and `walker-give-up-routing.test.ts` fails if a give-up skips it.
  //
  // What still needs proving is that a give-up REACHES the output at all — a
  // marker no emitted file can ever contain is a green gate over nothing.  So
  // this renders a construct no target can render (`Icon` with a name the
  // builtin registry does not have — deliberately the case the old wording list
  // could never cover, since that fallback's text is built from a variable) and
  // asserts the scan sees it.
  // -------------------------------------------------------------------------
  it("the give-up scan can still fire — an unrenderable construct carries the sentinel", async () => {
    const emitted = await generateSystemFiles(
      base.replace('Icon { name: "arrow-right" }', 'Icon { name: "no-such-icon-in-the-registry" }'),
    );
    const hit = [...emitted].some(
      ([, content]) => typeof content === "string" && content.includes(GIVE_UP_SENTINEL),
    );
    expect(
      hit,
      "an unknown icon name emitted no give-up the matrix can see — either the walker " +
        "stopped marking degradations, or `giveUp()` no longer carries the sentinel; " +
        "either way every cell below is now passing over output it cannot read",
    ).toBe(true);
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
