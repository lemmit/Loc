// The example list AND the pack list the React build sweep runs, shared
// between the slow sweep itself (generated-react-build.test.ts, excluded
// from the fast `npm test`) and the always-on matrix drift guard
// (react-build-matrix-sync.test.ts, which DOES run in the fast suite).
// Keeping them in one place is what lets the guard pin the CI workflow
// matrix against the exact set the build test would run.
//
// Single-file examples only.  The build harness copies one .ddd into a
// temp dir before injecting the design pack, so multi-file examples with
// `import "./…"` (erp/main.ddd, fulfillment-newest.ddd) can't be built
// here — their parse/generate coverage lives in
// test/system/playground-feature-examples.test.ts.
export const reactBuildExamples = [
  { ddd: "examples/acme.ddd", reactDir: "web_app" },
  // Conformance fixture: console_web is the richest React deployable
  // (exercises every walker primitive).  injectDesign rewrites its
  // `design:` slot — the first in the source — so this cell tests the
  // full primitive surface compiling under each pack.
  //
  // `extraReactDirs` type-checks the SECOND web deployable too: `admin_web`
  // is a `with scaffold(...)` UI over the `Accounts` subdomain, whose `Squad`
  // is `softDeletable` (an `internal` field).  A scaffold that rendered that
  // off-wire field emits TSX the client DTO can't satisfy — a bug that shipped
  // undetected precisely because the gate only ever compiled the FIRST
  // deployable per example (console_web, hand-written).  Building admin_web
  // locks in that the scaffold honours the API-read projection.  Compiled once
  // (on the first pack cell) since injectDesign only rewrites console_web's
  // slot — admin_web builds identically under every pack.
  //
  // `ops_web` is the THIRD frontend deployable (the `ui: Ops` sugar binding
  // over the Hono api).  It was outside the gate entirely until the coverage
  // guard in `react-build-deployable-coverage.test.ts` derived the emitted set
  // and found it — the same silent skip `admin_web` was added to close.
  {
    ddd: "examples/showcase.ddd",
    reactDir: "console_web",
    extraReactDirs: ["admin_web", "ops_web"],
  },
  { ddd: "web/src/examples/banking-system.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/inventory-system.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/provenance-system.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/sales-system.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/storefront-system.ddd", reactDir: "web_app" },
  // Aggregate inheritance: `abstract aggregate PaymentMethod` + two
  // `extends` subtypes.  The abstract base owns no routes, so its
  // scaffolded pages must be skipped (see scaffoldAggregate.macro.ts);
  // this case guards that the React TSX still type-checks.
  { ddd: "web/src/examples/inheritance-system.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/storybook-mantine.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/storybook-shadcn.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/storybook-components.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/loom-landing.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/action-showcase.ddd", reactDir: "web_app" },
  { ddd: "web/src/examples/store-showcase.ddd", reactDir: "web_app" },
  // Dashboard KPIs read from a SINGLETON query-time `projection` (M-T1.3):
  // aggregation happens in SQL, the page binds one object (not a list), and a
  // money tile goes through `Money` inside `Stat` — a `money` is a decimal.js
  // `Decimal` client-side, so a bare React child is a TS2322.  All three are
  // emit paths nothing else in this matrix exercises.
  { ddd: "web/src/examples/dashboard-system.ddd", reactDir: "web_app" },
  // Dynamic array-of-value-object form rows (RHF useFieldArray) on both the
  // scaffolded New (`CreateForm`) and Detail (update `OperationForm`) pages —
  // guards the row templates + the op-form `fieldArrays` hoist across every
  // pack.
  { ddd: "web/src/examples/subform-showcase.ddd", reactDir: "web_app" },
  // `DataGrid` — the TanStack-backed grid, across every pack version.  It lives
  // in its own example rather than `showcase.ddd` because that fixture is
  // rendered through EVERY frontend (Feliz included) by
  // `frontend-showcase-render.test.ts`, while DataGrid ships on the four JS
  // frontends only.  This cell is what actually COMPILES each pack's
  // `primitive-data-grid.hbs` — without it the older pack versions were only
  // proven to load.
  { ddd: "web/src/examples/data-grid-showcase.ddd", reactDir: "web_app" },
  // FileUpload primitive (slice 4a): a `File`-typed field on a scaffolded
  // aggregate → the in-form `field-input-file` template (RHF Controller +
  // `api.upload`), and a standalone `FileUpload { bind: … }` → the
  // `primitive-file-upload` template.  Guards both file-upload surfaces
  // compiling under every React pack.
  { ddd: "web/src/examples/file-upload-system.ddd", reactDir: "web_app" },
  // File display in SCAFFOLDED pages (slice 4a.1): a `File`-typed field on a
  // `with scaffold` aggregate → the list/detail cell renders the FileRef's
  // `.url` (a string) rather than the raw object, which is not a ReactNode and
  // would tsc-error.  Guards the scaffold display path compiling.
  { ddd: "web/src/examples/file-scaffold-system.ddd", reactDir: "web_app" },
  // The expression-vocabulary fixture.  Every OTHER example here exercises
  // page PRIMITIVES; none of them uses a scalar intrinsic or a value-object
  // construction in a body, which is exactly why the walker's missing
  // expression arms compiled green for so long.  This cell is the compile-tier
  // half of `test/generator/_walker/render-degradation.test.ts`.
  { ddd: "web/src/examples/expression-showcase.ddd", reactDir: "web_app" },
] as const;

export interface ReactPackSpec {
  readonly family: "mantine" | "shadcn" | "mui" | "chakra";
  readonly version: string;
}

/** The `family@version` packs every example above is swept against.  Lives
 *  here (rather than in the build harness) for the same reason the example
 *  list does: the always-on drift guard pins the workflow's slim PR pack
 *  slice against it without importing the slow suite.  Adding a pack version
 *  here grows the sweep multiplicatively with no other code edit — the full
 *  CI sweep asks the harness for "all packs" per example rather than
 *  enumerating them in the workflow. */
export const reactBuildPacks: readonly ReactPackSpec[] = [
  { family: "mantine", version: "v7" },
  { family: "mantine", version: "v9" },
  { family: "shadcn", version: "v3" },
  { family: "shadcn", version: "v4" },
  { family: "mui", version: "v5" },
  { family: "mui", version: "v7" },
  { family: "chakra", version: "v2" },
  { family: "chakra", version: "v3" },
];

export function reactPackId(p: ReactPackSpec): string {
  return `${p.family}@${p.version}`;
}
