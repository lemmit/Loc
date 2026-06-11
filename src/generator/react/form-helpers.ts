// Moved to src/generator/_frontend/form-helpers.ts when the body
// walker became the shared core (the helpers are framework-neutral —
// they compute form metadata and TS expressions consumed by both the
// React and Svelte shells).  This shim preserves the original import
// path for react-side consumers and tests.
export * from "../_frontend/form-helpers.js";
