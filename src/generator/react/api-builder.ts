// Moved to `src/generator/_frontend/api-module.ts` (shared with the
// Vue frontend — TanStack Query's call surface is identical across
// react-query and vue-query; only the import specifier diverges).
// Re-export shim so react-side import paths stay stable.
export * from "../_frontend/api-module.js";
