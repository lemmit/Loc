// M-T5.20 — one `httpStatus` override moves the denial ladder on ALL FIVE
// backends, in one place.
//
// Why this exists alongside the two per-leg suites it overlaps
// (`test/generator/domain-floor-status-override.test.ts`, four backends;
// `test/generator/elixir/denial-ladder-status-override.test.ts`, elixir): those
// were written by separate work on separate halves of the ladder, and each is
// green while the OTHER half is broken.  The whole value of routing the ladder
// through `resolveErrorStatus` is that the five move TOGETHER — a mechanism that
// works on four backends and not the fifth is precisely the N-place-edit problem
// the mission set out to remove, just relocated.  Only an assertion that spans
// all five can fail on that.
//
// It also guards a real integration hazard.  The two halves resolve through
// different-shaped plumbing: the four non-elixir backends read the app-wide
// `structuralErrorStatuses` fold (widened here to carry every mapped name), while
// vanilla Phoenix merges that fold with the per-subdomain `errorStatusOverrides`
// map.  Two mechanisms reading one declaration is exactly where a double-apply or
// a silent no-op hides, and neither per-leg suite can see it.
//
// 418 is deliberate: it is not a status ANY rung defaults to, so its presence in
// the output cannot come from anywhere but the override.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

/** One aggregate carrying both ladder rungs an override can currently reach — a
 *  `precondition` (the domain floor) and a `requires` (Forbidden).  No `unique`,
 *  no `when`, no destroy, so no structural-conflict rung can contribute a status
 *  and muddy the assertion. */
const SOURCE = (platform: string, apiBody: string) => `
system Denials {
  user { id: string, level: int }
  subdomain Sales {
    context Sales {
      aggregate Order {
        total: int
        create(total: int)
        operation cancel() {
          requires currentUser.level > 2
          precondition total > 0
          total := 0
        }
      }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales ${apiBody}
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable api {
    platform: ${platform}
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    port: 8080
    auth: required
  }
}
`;

const PLATFORMS = ["node", "dotnet", "java", "python", "elixir"] as const;

async function emit(platform: string, apiBody: string): Promise<string> {
  const files = await generateSystemFiles(SOURCE(platform, apiBody));
  return [...files.values()].join("\n");
}

describe("M-T5.20 — one `httpStatus` override moves the ladder on all five backends", () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: the domain floor defaults to 422 and 418 appears nowhere`, async () => {
      const out = await emit(platform, "");
      expect(out).toContain("Unprocessable Entity");
      // The baseline for the override case below: if 418 were already present
      // for some unrelated reason, the assertion there would prove nothing.
      expect(out, "418 in the DEFAULT emission — the override assertion is void").not.toContain(
        "418",
      );
    });

    it(`${platform}: \`httpStatus DomainError -> 418\` reaches the emitted output`, async () => {
      const out = await emit(platform, "{ httpStatus DomainError -> 418 }");
      expect(out, "the override never reached this backend's emission").toContain("418");
    });

    it(`${platform}: \`httpStatus Forbidden -> 418\` reaches the emitted output`, async () => {
      const out = await emit(platform, "{ httpStatus Forbidden -> 418 }");
      expect(out, "the Forbidden rung is still hardcoded on this backend").toContain("418");
    });
  }

  it("all five agree: the SAME override is honoured by every backend", async () => {
    // The claim the per-leg suites structurally cannot make.  A backend that
    // silently ignores the clause fails here even though its own suite is green.
    const honoured = await Promise.all(
      PLATFORMS.map(
        async (p) =>
          [p, (await emit(p, "{ httpStatus DomainError -> 418 }")).includes("418")] as const,
      ),
    );
    expect(Object.fromEntries(honoured)).toEqual({
      node: true,
      dotnet: true,
      java: true,
      python: true,
      elixir: true,
    });
  });
});
