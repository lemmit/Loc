// The workflow-instance BY-ID read declares the same error set on all five
// backends — and that set is the shared `errorStatuses("getById")`, not five
// hand-written copies of it.
//
// `GET /workflows/<wf>/instances/{id}` is `apiSurfaceCoverage.notLifted`: it is
// not part of `deriveAggregateOperations`, so each backend emits its declared
// responses at its own site.  Four of them already rendered the shared arm;
// .NET spelled `404` inline.  The moment schemathesis F6 added 422 to that arm
// (the correlation id is PARSED, so a malformed one answers the wire-validation
// 422), four backends moved and .NET did not — a cross-backend spec divergence
// that only the 5-way `conformance-parity` job could see, twenty minutes and a
// five-image docker build later:
//
//   GET /workflows/archival_tracker/instances/{id}:
//     node=[404:ProblemDetails,422:ProblemDetails], dotnet=[404:ProblemDetails]
//
// So this gate exists to move that failure from a docker-bound nightly-shaped
// job to a two-second per-PR check, and to state the invariant the parity diff
// can only state as "they happen to be equal": the set is DERIVED, so a change
// to the shared table moves all five or fails here.
//
// It is deliberately about a NON-DERIVED route.  For the lifted surface
// (create/getById/destroy/operations/finds), each backend's
// `api-surface-render.test.ts` already holds the line, because those routes read
// `op.errorStatuses` straight off the derivation and cannot drift by
// construction.  The hand-rolled routes are exactly where they can.

import { describe, expect, it } from "vitest";
import { errorStatuses } from "../../src/ir/util/openapi-errors.js";
import { generateSystemFiles } from "../_helpers/generate.js";

/** One observable (event-sourced) workflow, per backend — its instance routes
 *  are emitted whenever `instanceWireShape` is derived. */
const SOURCE = (platform: string) => `
system Obs {
  subdomain Ops {
    context Ops {
      aggregate Item {
        label: string
        create(label: string) { }
        operation tag() { emit ItemTagged { item: id } }
      }
      repository Items for Item { }
      event ItemTagged { item: Item id }
      event ItemCounted { item: Item id, n: int }
      workflow tracker eventSourced {
        item: Item id
        seen: int
        create(t: ItemTagged) by t.item {
          emit ItemCounted { item: t.item, n: 1 }
        }
        apply(c: ItemCounted) { seen := seen + c.n }
      }
    }
  }
  api OpsApi from Ops
  storage primary { type: postgres }
  resource opsState { for: Ops, kind: state, use: primary }
  deployable api {
    platform: ${platform}
    contexts: [Ops]
    dataSources: [opsState]
    serves: OpsApi
    port: 8080
  }
}
`;

const PLATFORMS = ["node", "dotnet", "java", "python", "elixir"] as const;
type Platform = (typeof PLATFORMS)[number];

/** Find the one emitted file whose path matches, and return its content. */
function pick(files: Map<string, string>, re: RegExp): string {
  const hits = [...files.entries()].filter(([p]) => re.test(p));
  expect(hits.length, `expected exactly one file matching ${re}, got ${hits.map(([p]) => p)}`).toBe(
    1,
  );
  return hits[0]![1];
}

/** Every declared NON-200 status on `…/instances/{id}`, ascending.
 *
 *  Each extractor reads the backend's own declaration idiom at its own site —
 *  that is the point: a shared helper would only prove the helper agrees with
 *  itself. The `{id}` route is sliced away from its `instances` LIST sibling in
 *  every case, so a status declared on the list cannot be miscounted here. */
const DECLARED: Record<Platform, (files: Map<string, string>) => number[]> = {
  node: (files) => {
    const src = pick(files, /\/http\/workflows\.ts$/);
    const at = src.indexOf('path: "/tracker/instances/{id}"');
    expect(at, "hono instance-by-id route").toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf("app.openapi(", at + 1));
    return [...block.matchAll(/^\s+(\d{3}): \{ description:/gm)]
      .map((m) => Number(m[1]))
      .filter((s) => s !== 200);
  },
  python: (files) => {
    const src = pick(files, /\/http\/workflows_routes\.py$/);
    const line = src.split("\n").find((l) => l.includes('@router.get("/tracker/instances/{id}"'));
    expect(line, "python instance-by-id route").toBeDefined();
    return [...(line ?? "").matchAll(/(\d{3}): \{"model": ProblemDetails/g)].map((m) =>
      Number(m[1]),
    );
  },
  java: (files) => {
    const src = pick(files, /OpenApiContractCustomizer\.java$/);
    const m = src.match(
      /new Route\("get", "\/api\/workflows\/tracker\/instances\/\{id\}", null, new int\[\] \{([^}]*)\}/,
    );
    expect(m, "java instance-by-id Route").not.toBeNull();
    return (m?.[1] ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
  },
  dotnet: (files) => {
    const src = pick(files, /WorkflowInstancesController\.cs$/);
    const at = src.indexOf('[HttpGet("tracker/instances/{id}")]');
    expect(at, "dotnet instance-by-id action").toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf("public async Task<IActionResult>", at));
    return [...block.matchAll(/ProducesResponseType\(typeof\(ProblemDetails\), (\d{3})\)/g)].map(
      (m) => Number(m[1]),
    );
  },
  elixir: (files) => {
    const src = pick(files, /\/api\/.*_spec\.ex$/);
    const marker = '"/workflows/tracker/instances/{id}" => %OpenApiSpex.PathItem{';
    const at = src.indexOf(marker);
    expect(at, "elixir instance-by-id path item").toBeGreaterThan(-1);
    // Start the next-path search PAST this path item's own opening token —
    // searching from `at + 1` finds the `%OpenApiSpex.PathItem{` on this very
    // line and slices an empty block, which is how this extractor first
    // reported "elixir declares []" against a file that declares both.
    const end = src.indexOf("%OpenApiSpex.PathItem{", at + marker.length);
    const block = src.slice(at, end === -1 ? undefined : end);
    return [...block.matchAll(/^\s+(\d{3}) => %OpenApiSpex\.Response\{/gm)]
      .map((m) => Number(m[1]))
      .filter((s) => s !== 200);
  },
};

describe("workflow-instance by-id read — one declared error set, five backends", () => {
  it('every backend declares exactly errorStatuses("getById")', async () => {
    // The shared arm, read live rather than hard-coded: this test must keep
    // holding when the table legitimately changes again, and must not become a
    // second copy of the very thing whose duplication caused the drift.
    const expected = [...errorStatuses("getById")];
    // A guard against the assertion going vacuous if the extractors ever return
    // nothing on every backend: the arm is non-empty by construction.
    expect(expected.length, "the shared getById arm declares something").toBeGreaterThan(0);

    const seen: Record<string, number[]> = {};
    for (const platform of PLATFORMS) {
      const files = await generateSystemFiles(SOURCE(platform));
      seen[platform] = DECLARED[platform](files).sort((a, b) => a - b);
    }
    for (const platform of PLATFORMS) {
      expect(
        seen[platform],
        `${platform} declares ${JSON.stringify(seen[platform])} on ` +
          `GET /workflows/tracker/instances/{id}; the shared matrix says ` +
          `${JSON.stringify(expected)}. Spelling the set inline at one backend's ` +
          "emit site is what made .NET miss the 422 the other four gained.",
      ).toEqual(expected);
    }
  });
});
