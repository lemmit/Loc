// `vitest` stand-in for emitted unit suites run under the behavioral
// harness: route describe/it/expect to the harness installed on
// globalThis by run.mjs (the same `createHarness()` the playground's
// Tests tab uses), instead of the real test runner.
export const describe = (...a) => globalThis.__loomUnit.describe(...a);
export const it = (...a) => globalThis.__loomUnit.it(...a);
export const test = (...a) => globalThis.__loomUnit.it(...a);
export const expect = (...a) => globalThis.__loomUnit.expect(...a);
