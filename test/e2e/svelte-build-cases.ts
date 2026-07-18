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
] as const;

export const sveltePacks = ["shadcnSvelte@v1", "flowbite@v1"] as const;
