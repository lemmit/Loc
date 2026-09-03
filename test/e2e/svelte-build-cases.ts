// Shared case lists for the svelte build harness — imported by both
// generated-svelte-build.test.ts (the opt-in build gate) and
// svelte-build-matrix-sync.test.ts (the fast CI-matrix drift guard).

/** Single-file examples with a svelte deployable named `web`. */
export const svelteBuildExamples = [
  "examples/svelte-shop.ddd",
  // `auth: ui` guard (D-AUTH-OIDC): builds the emitted AuthGate.svelte +
  // session client + <AuthGate> wrap against real SvelteKit types.
  "test/e2e/fixtures/svelte-build/auth-ui.ddd",
  // `store Cart { … }` shared client-side state (Stage 5): builds the emitted
  // `$state` runes module + the page/component `$derived` store bindings
  // against real SvelteKit/svelte-check.  Svelte sibling of the React
  // store-showcase matrix case.
  "web/src/examples/svelte-store-showcase.ddd",
  // File upload (M-T1.2 slice 4b): builds a `File` CreateForm field
  // (`field-input-file`) + a standalone `FileUpload(bind:)`
  // (`primitive-file-upload`) against real SvelteKit/svelte-check.
  "web/src/examples/svelte-file-upload.ddd",
  // DataGrid (M-T1.1 slice 10): the grid's markup lands in a HOISTED SIBLING
  // component, not the page — with its own pack / `$lib/format` / `$lib/i18n`
  // imports and the walker-built header+cell fragments.  No other case reaches
  // that file, and an unimported name there is a runtime `ReferenceError` on
  // Svelte rather than a build failure, so svelte-check over it is the gate.
  "web/src/examples/svelte-data-grid.ddd",
  // Optional fields (M-FT.22): a nullable scalar bound into a pack's typed
  // input, an optional VALUE OBJECT read on the detail page and bound in an
  // op-form group, and an optional `File`.  svelte-check is the only gate that
  // sees any of it — a null dereference through an optional field compiles
  // fine and fails at runtime everywhere else.
  "test/e2e/fixtures/svelte-build/optional-fields.ddd",
] as const;

export const sveltePacks = ["shadcnSvelte@v1", "flowbite@v1"] as const;
