// Moved to src/generator/_frontend/view-models.ts — the VMs are
// framework-neutral by design (see the header there) and are consumed
// by the shared walker + menu emitter.  Shim preserves the original
// import path for react-side consumers and tests.
export * from "../../_frontend/view-models.js";
