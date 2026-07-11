// Cross-backend emission parity for `Repo.findAll(<Criterion>)` (criterion.md,
// use site 3).
//
// `findAll(<Criterion>)` has no per-backend emitter: the enrich pass desugars
// it to a synthetic `findAllBy<Criterion>` RetrievalIR, so it rides whatever
// each backend already does for an author-declared `retrieval` + `Repo.run`.
// That structural equivalence is the whole correctness argument — and the
// strict build gates already compile the equivalent author-declared shape
// (`dotnet-build/dapper.ddd`'s `retrieval … { where: NameIs(n) }`,
// `java-build/retrieval.ddd`, `elixir-vanilla-build/vanilla-ref-collections.ddd`,
// `python-build/domain.ddd`).  What no gate pinned was that the *desugar*
// keeps producing that shape on every backend; if `synthesizeFindAllRetrievals`
// or a backend's retrieval emitter drifts, this fast (no-docker) test catches
// it the moment the run method or its workflow call site stops being wired.
//
// Lives in the always-on `test` gate (like `union-find-absence-parity`).
// Asserts, per backend, that BOTH the parameterless and the parameterised
// findAll wire end-to-end: the `findAllBy<Criterion>` retrieval is emitted AND
// invoked from the workflow (the name must appear in ≥2 generated files — the
// run-method/spec/read-action definition plus the workflow call site).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** The same findAll workflow per backend — only the platform (and the ui
 *  wiring Phoenix's scaffold wants) varies. */
function system(platform: string, ui: boolean): string {
  return `
system S {
  subdomain Sales {
    context Orders {
      enum Status { Draft, Cancelled }
      aggregate Order { code: string  status: Status  region: string }
      repository Orders for Order { }
      criterion ActiveOrder of Order = status != Cancelled
      criterion InRegion(rgn: string) of Order = region == rgn
      command C { region: string }
      workflow W {
        create(c: C) {
          let active = Orders.findAll(ActiveOrder, page: { offset: 0, limit: 50 })
          let regional = Orders.findAll(InRegion(c.region), page: { offset: 0, limit: 50 })
          for o in active { }
        }
      }
    }
  }
  api OrdersApi from Sales
  ${ui ? "ui A with scaffold(subdomains: [Sales]) { }" : ""}
  storage pg { type: postgres }
  resource s { for: Orders, kind: state, use: pg }
  deployable d {
    platform: ${platform}
    contexts: [Orders]
    dataSources: [s]
    serves: OrdersApi
    ${ui ? "ui: A" : ""}
    port: 4000
  }
}`;
}

const BACKENDS = ["node", "dotnet", "java", "python", "elixir", "elixir"] as const;

/** Count generated files whose content mentions the `findAllBy<Criterion>`
 *  retrieval, tolerant of each backend's casing (`runFindAllByActiveOrder`,
 *  `find_all_by_active_order`, `FindAllByActiveOrderSpec`, …). */
function filesMentioning(files: Map<string, string>, criterion: string): number {
  // Build a separator-insensitive matcher: findAll<sep>by<sep><criterion>.
  const parts = `find all by ${criterion}`.split(" ");
  const re = new RegExp(parts.join("[\\s_]?"), "i");
  let n = 0;
  for (const content of files.values()) if (re.test(content)) n++;
  return n;
}

describe("Repo.findAll(<Criterion>) — cross-backend emission parity", () => {
  for (const platform of BACKENDS) {
    const ui = platform === "elixir";
    it(`${platform}: both findAll retrievals are emitted and invoked`, async () => {
      const files = await generateSystemFiles(system(platform, ui));
      // Each criterion's synthetic retrieval must appear in ≥2 files: its
      // definition (run method / Specification / Ash read action / repo impl)
      // and the workflow call site that invokes it.  A single-file hit would
      // mean the desugar emitted a dangling reference (or only the call).
      expect(
        filesMentioning(files, "active order"),
        `${platform}: findAllByActiveOrder should be both defined and invoked`,
      ).toBeGreaterThanOrEqual(2);
      expect(
        filesMentioning(files, "in region"),
        `${platform}: parameterised findAllByInRegion should be both defined and invoked`,
      ).toBeGreaterThanOrEqual(2);
    });
  }
});
