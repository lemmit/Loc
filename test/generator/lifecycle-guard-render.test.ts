// The canonical `create` / `destroy` `requires` gate — ENFORCEMENT, on all five
// backends, from the shared corpus fixture.
//
// The sibling gate in `test/ir/api-surface-parity.test.ts` compares the
// DECLARED error statuses, which is the half a client reads.  It is not the
// half that matters here: a backend can publish `403` and still let the request
// through, and that is exactly the failure this whole line of work started
// from — the guard was lowered into the IR, read by nobody, and the route ran
// wide open while the source said otherwise.  A declaration-only gate would
// have passed against that.
//
// So this asserts the two things a declaration cannot:
//
//   1. the CREATE path denies, and denies BEFORE the aggregate is constructed —
//      a guard evaluated after the factory has already run is not a gate;
//   2. the DESTROY path denies AFTER the row loads and against THAT row — the
//      fixture's guard reads `this.quantity`, so a backend that renders the
//      predicate against the wrong receiver (or drops the row half) is caught.
//
// Both are read off the emitted source per backend, not off a shared helper —
// five independent observations, the same reason the parity test scrapes.

import { describe, expect, it } from "vitest";
import { generateCorpusCase } from "../fixtures/corpus/harness.js";

const FEATURE = "lifecycle-guard";

/** The emitted file whose text carries the create/destroy command path. */
type Probe = {
  /** File whose basename ends with this. */
  readonly file: string;
  /** Region of that file the create gate must sit in, plus the pin that the
   *  gate actually PRECEDES construction.  Two shapes, because two emission
   *  topologies: `before` — the construction is in the same region and the
   *  denial must come first; `absent` — the region is a wrapper and the
   *  construction must not appear in it at all (Phoenix, whose gate delegates
   *  to a private fn rather than being re-indented into every arm). */
  readonly create: {
    readonly region: RegExp;
    readonly deny: RegExp;
    readonly before?: RegExp;
    readonly absent?: RegExp;
  };
  readonly destroy: {
    readonly region: RegExp;
    readonly deny: RegExp;
    /** The guard must read the LOADED row, not a bare field. */
    readonly rowRef: RegExp;
    /** The load the gate must sit after. */
    readonly after: RegExp;
  };
};

const PROBES: Record<string, Probe> = {
  "Python/FastAPI": {
    file: "shipment_routes.py",
    create: {
      region: /async def create_shipment\([\s\S]*?\n\n/,
      deny: /raise ForbiddenError\("Forbidden: create Shipment"\)/,
      before: /created = Shipment\.create\(/,
    },
    destroy: {
      region: /async def destroy_shipment\([\s\S]*?\n\n/,
      deny: /raise ForbiddenError\("Forbidden: destroy Shipment"\)/,
      rowRef: /__loaded\.quantity/,
      after: /__loaded = await repo\./,
    },
  },
  "Hono/node": {
    file: "shipment.routes.ts",
    create: {
      region: /operationId: "createShipment"[\s\S]*?\n {2}\);/,
      deny: /throw new ForbiddenError\("Forbidden"\)/,
      before: /const created = Shipment\.create\(/,
    },
    destroy: {
      region: /operationId: "destroyShipment"[\s\S]*?\n {2}\);/,
      deny: /throw new ForbiddenError\("Forbidden"\)/,
      rowRef: /__loaded\.quantity/,
      after: /const __loaded = await repo\.getById\(/,
    },
  },
  ".NET": {
    // CQRS: the gate lives in the command handler, the only place with both the
    // principal and (for destroy) the loaded aggregate.
    file: "CreateShipmentHandler.cs",
    create: {
      region: /public async ValueTask<ShipmentId> Handle\([\s\S]*$/,
      deny: /throw new ForbiddenException\("Forbidden: create Shipment"\)/,
      before: /var aggregate = Shipment\.Create\(/,
    },
    destroy: {
      region: /^$/, // handled by the dedicated destroy probe below
      deny: /^$/,
      rowRef: /^$/,
      after: /^$/,
    },
  },
  "Java/Spring": {
    file: "ShipmentService.java",
    create: {
      region: /public ShipmentId createShipment\([\s\S]*?\n {4}\}/,
      deny: /throw new ForbiddenException\("Forbidden: create Shipment"\)/,
      before: /var aggregate = Shipment\.create\(/,
    },
    destroy: {
      region: /public void destroyShipment\([\s\S]*?\n {4}\}/,
      deny: /throw new ForbiddenException\("Forbidden: destroy Shipment"\)/,
      rowRef: /aggregate\.quantity\(\)/,
      after: /var aggregate = repository\.getById\(/,
    },
  },
  "Elixir/Phoenix": {
    file: "shipment_controller.ex",
    create: {
      region: /\n {2}def create\(conn[\s\S]*?\n {2}end\n/,
      deny: /ProblemDetails\.problem_response\(conn, 403, "Forbidden", "Forbidden: create Shipment"\)/,
      // The Phoenix gate is a wrapper: the answering body moved to
      // `defp __create_authorized`.  So the pin is that the wrapper reaches the
      // context create on NEITHER branch except through the authorized one —
      // i.e. `create_shipment(` must not appear in the wrapper at all.
      absent: /Warehouse\.create_shipment\(/,
    },
    destroy: {
      region: /\n {2}def delete\(conn[\s\S]*?\n {2}end\n/,
      deny: /ProblemDetails\.problem_response\(conn, 403, "Forbidden", "Forbidden: destroy Shipment"\)/,
      rowRef: /record\.quantity/,
      after: /case Warehouse\.get_shipment\(id\) do/,
    },
  },
};

/** .NET splits create and destroy into two handler files. */
const DOTNET_DESTROY = {
  file: "DestroyShipmentHandler.cs",
  deny: /throw new ForbiddenException\("Forbidden: destroy Shipment"\)/,
  rowRef: /aggregate\.Quantity/,
  after: /var aggregate = await _repo\.GetByIdAsync\(/,
};

const BACKEND_OF: Record<string, "node" | "python" | "dotnet" | "java" | "vanilla"> = {
  "Python/FastAPI": "python",
  "Hono/node": "node",
  ".NET": "dotnet",
  "Java/Spring": "java",
  "Elixir/Phoenix": "vanilla",
};

function fileEndingWith(files: Map<string, string>, suffix: string): string {
  const hit = [...files].find(([p]) => p.endsWith(suffix));
  expect(hit, `no emitted file ends with ${suffix} — the probe is stale`).toBeDefined();
  return hit![1];
}

describe("the canonical create/destroy `requires` gate is ENFORCED, not just declared", () => {
  for (const [label, probe] of Object.entries(PROBES)) {
    it(`${label} denies an unauthorized create before constructing`, async () => {
      const files = await generateCorpusCase(FEATURE, BACKEND_OF[label]!);
      const src = fileEndingWith(files, probe.file);
      const region = src.match(probe.create.region)?.[0];
      expect(region, `${label}: create region not found — the probe is stale`).toBeDefined();
      expect(region).toMatch(probe.create.deny);
      if (probe.create.absent) {
        expect(
          region,
          `${label}: the create wrapper reaches construction outside the authorized branch`,
        ).not.toMatch(probe.create.absent);
      } else {
        const denyAt = region!.search(probe.create.deny);
        const buildAt = region!.search(probe.create.before!);
        expect(
          buildAt,
          `${label}: create construction not found — the probe is stale`,
        ).toBeGreaterThan(-1);
        expect(
          denyAt,
          `${label}: the create gate runs AFTER construction — that is not a gate`,
        ).toBeLessThan(buildAt);
      }
    });

    if (label === ".NET") continue; // its destroy lives in a second file

    it(`${label} denies an unauthorized destroy against the loaded row`, async () => {
      const files = await generateCorpusCase(FEATURE, BACKEND_OF[label]!);
      const src = fileEndingWith(files, probe.file);
      const region = src.match(probe.destroy.region)?.[0];
      expect(region, `${label}: destroy region not found — the probe is stale`).toBeDefined();
      expect(region).toMatch(probe.destroy.deny);
      // The `this.quantity == 0` half must read the LOADED row, and the whole
      // gate must sit after that load.
      expect(region, `${label}: the destroy guard does not read the loaded row`).toMatch(
        probe.destroy.rowRef,
      );
      const loadAt = region!.search(probe.destroy.after);
      expect(loadAt, `${label}: destroy load not found — the probe is stale`).toBeGreaterThan(-1);
      expect(
        region!.search(probe.destroy.rowRef),
        `${label}: the destroy gate reads the row BEFORE loading it`,
      ).toBeGreaterThan(loadAt);
    });
  }

  it(".NET denies an unauthorized destroy against the loaded aggregate", async () => {
    const files = await generateCorpusCase(FEATURE, "dotnet");
    const src = fileEndingWith(files, DOTNET_DESTROY.file);
    expect(src).toMatch(DOTNET_DESTROY.deny);
    expect(src).toMatch(DOTNET_DESTROY.rowRef);
    expect(src.search(DOTNET_DESTROY.rowRef)).toBeGreaterThan(src.search(DOTNET_DESTROY.after));
  });
});
