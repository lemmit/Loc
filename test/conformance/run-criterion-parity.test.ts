// Cross-backend emission parity for `Repo.run(<Criterion>)`
// (read-path-architecture.md, "`run` takes a criterion").
//
// A criterion passed directly to `run` rides the SAME synthetic
// `findAllBy<Criterion>` retrieval as `Repo.findAll(<Criterion>)` — so it has no
// per-backend emitter and must emit identically to `findAll` on every backend.
// This is the `run`-flavoured sibling of `findall-parity.test.ts`: it pins that
// the criterion-run desugar keeps producing the `findAllBy<Criterion>` retrieval
// (defined AND invoked — ≥2 files) on node/dotnet/java/python/elixir, so the
// first-class-criterion surface can't silently drop the filter on any target.
//
// Lives in the always-on `test` gate (no docker).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** The same criterion-run workflow per backend — only the platform (and the ui
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
          let active = Orders.run(ActiveOrder, page: { offset: 0, limit: 50 })
          let regional = Orders.run(InRegion(c.region), page: { offset: 0, limit: 50 })
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

const BACKENDS = ["node", "dotnet", "java", "python", "elixir"] as const;

/** Count generated files mentioning the `findAllBy<Criterion>` retrieval,
 *  tolerant of each backend's casing / separators. */
function filesMentioning(files: Map<string, string>, criterion: string): number {
  const parts = `find all by ${criterion}`.split(" ");
  const re = new RegExp(parts.join("[\\s_]?"), "i");
  let n = 0;
  for (const content of files.values()) if (re.test(content)) n++;
  return n;
}

describe("Repo.run(<Criterion>) — cross-backend emission parity", () => {
  for (const platform of BACKENDS) {
    const ui = platform === "elixir";
    it(`${platform}: both criterion runs emit and invoke findAllBy<Criterion>`, async () => {
      const files = await generateSystemFiles(system(platform, ui));
      expect(
        filesMentioning(files, "active order"),
        `${platform}: run(ActiveOrder) should emit findAllByActiveOrder (defined + invoked)`,
      ).toBeGreaterThanOrEqual(2);
      expect(
        filesMentioning(files, "in region"),
        `${platform}: run(InRegion(...)) should emit findAllByInRegion (defined + invoked)`,
      ).toBeGreaterThanOrEqual(2);
    });
  }
});
