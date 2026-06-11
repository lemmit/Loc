// Shared case lists for the svelte build harness — imported by both
// generated-svelte-build.test.ts (the opt-in build gate) and
// svelte-build-matrix-sync.test.ts (the fast CI-matrix drift guard).

/** Single-file examples with a svelte deployable named `web`. */
export const svelteBuildExamples = ["examples/svelte-shop.ddd"] as const;

export const sveltePacks = ["shadcnSvelte@v1", "flowbite@v1"] as const;
