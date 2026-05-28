import type { Subdomain } from "../../api/index.js";
import { defineMacro } from "../../api/index.js";

/** Composer: invokes `scaffoldContext` for each bounded context in
 * the named subdomain.  Top of the per-element scaffold composer
 * chain — `scaffold(subdomains: [S])` itself fans this macro across
 * the user-supplied subdomain list.
 *
 * Unfolding `with scaffoldSubdomain(of: Sales)` produces one
 * `with scaffoldContext(of: <Ctx>)` per context inside Sales. */
export default defineMacro({
  name: "scaffoldSubdomain",
  target: "ui",
  apiVersion: 1,
  description:
    "Fans `scaffoldContext` across every bounded context in the named " +
    "subdomain.  Mid-level composer in the scaffold-macro family.",
  params: {
    of: { kind: "ref", of: "Subdomain" },
  },
  expand({ target, args, invokeMacro }) {
    const mod = args.of as Subdomain;
    const out: unknown[] = [];
    for (const ctx of mod.contexts ?? []) {
      out.push(...invokeMacro("scaffoldContext", { target, args: { of: ctx } }));
    }
    return out as never[];
  },
});
