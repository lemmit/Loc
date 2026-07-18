// Shared between the slow React-build sweep
// (generated-react-build.test.ts, excluded from the fast `npm test`)
// and the always-on matrix drift guard (react-build-matrix-sync.test.ts,
// which DOES run in the fast suite).  Keeping the list in one place is
// what lets the guard pin the CI workflow matrix against the exact set
// the build test would run.
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
  { ddd: "examples/showcase.ddd", reactDir: "console_web", extraReactDirs: ["admin_web"] },
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
  // Dynamic array-of-value-object form rows (RHF useFieldArray) on both the
  // scaffolded New (`CreateForm`) and Detail (update `OperationForm`) pages —
  // guards the row templates + the op-form `fieldArrays` hoist across every
  // pack.
  { ddd: "web/src/examples/subform-showcase.ddd", reactDir: "web_app" },
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
] as const;
