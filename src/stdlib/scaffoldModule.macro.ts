import type { Module } from "../macro-api/index.js";
import { defineMacro } from "../macro-api/index.js";

/** Composer: invokes `scaffoldContext` for each bounded context in
 * the named module.  Top of the per-element scaffold composer
 * chain — `scaffold(modules: [M])` itself fans this macro across
 * the user-supplied module list.
 *
 * Unfolding `with scaffoldModule(of: Sales)` produces one
 * `with scaffoldContext(of: <Ctx>)` per context inside Sales. */
export default defineMacro({
  name: "scaffoldModule",
  target: "ui",
  apiVersion: 1,
  description:
    "Fans `scaffoldContext` across every bounded context in the named " +
    "module.  Mid-level composer in the scaffold-macro family.",
  params: {
    of: { kind: "ref", of: "Module" },
  },
  expand({ target, args, invokeMacro }) {
    const mod = args.of as Module;
    const out: unknown[] = [];
    for (const ctx of mod.contexts ?? []) {
      out.push(...invokeMacro("scaffoldContext", { target, args: { of: ctx } }));
    }
    return out as never[];
  },
});
