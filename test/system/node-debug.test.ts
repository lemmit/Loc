import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseValid } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// M18 phase 8 slice 1 — Node debug wiring (docs/old/plans/dap-node-debug.md).
//
// The spike proved: plain `node --enable-source-maps` chains through the
// phase-5 `.ts.map` sidecars straight to `.ddd` coordinates, PROVIDED
// relative imports carry an explicit `.ts` extension (Node's ESM loader
// never probes extensions the way tsx/tsup's esbuild does) — see the design
// note for the full reproduction, including the ONE known gap (value-object
// constructors emit a non-erasable `public readonly` parameter-property
// shape that trips Node's own type-stripping; tracked as a separate
// follow-up, not fixed by this slice).
//
// This suite pins the emission itself: --sourcemap gates a `debug` script,
// `allowImportingTsExtensions` in tsconfig.json, the import-extension
// rewrite, and the NODE half of the system-root `.vscode/launch.json` — one
// `type: node` config per node-family deployable, byte-identical to the M18
// shape. (M26 extended the same launch.json to also carry `coreclr`/`java`
// configs for dotnet/java deployables via `PlatformSurface.debugLaunch`;
// the full cross-backend fan-out is pinned in launch-config.test.ts. Here
// we only assert node's own config stays exactly as M18 shipped it.)
// ---------------------------------------------------------------------------

// Two node deployables (so "one config per node deployable" is a real
// fan-out, not a single-element coincidence) plus one dotnet deployable
// (post-M26 that dotnet deployable ALSO earns a `coreclr` config — this
// suite checks node's configs are unchanged alongside it).
const SOURCE = `
system NodeDebugDemo {
  subdomain Sales {
    context Orders {
      valueobject Money {
        amount: int
        currency: string
      }

      aggregate Order {
        customerName: string
        total: Money
        operation confirm() {
          precondition total.amount > 0
        }
      }
      repository Orders for Order { }
    }
  }

  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  api SalesApi from Sales

  deployable honoApi   { platform: node   contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 3000 }
  deployable honoApi2  { platform: node   contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 3002 }
  deployable dotnetApi { platform: dotnet contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
}
`;

// Deployable names run through `serviceSlug` (camelCase -> snake_case) before
// becoming the output path prefix — see src/system/index.ts.
const HONO_SLUG = "hono_api";
const HONO2_SLUG = "hono_api2";

describe("Node debug wiring (--sourcemap only)", () => {
  it("flag-off: emits no debug script, no allowImportingTsExtensions, no launch.json, extensionless imports", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model).files;

    expect(files.has(".vscode/launch.json")).toBe(false);

    const pkg = JSON.parse(files.get(`${HONO_SLUG}/package.json`)!) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.debug).toBeUndefined();

    const tsconfig = JSON.parse(files.get(`${HONO_SLUG}/tsconfig.json`)!) as {
      compilerOptions: Record<string, unknown>;
    };
    expect(tsconfig.compilerOptions.allowImportingTsExtensions).toBeUndefined();

    const orderTs = files.get(`${HONO_SLUG}/domain/order.ts`)!;
    expect(orderTs).toContain(`from "./ids"`);
    expect(orderTs).not.toMatch(/from ".*\.ts"/);
  });

  it("flag-on: node deployable's package.json carries the debug script", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;

    const pkg = JSON.parse(files.get(`${HONO_SLUG}/package.json`)!) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.debug).toBe("node --enable-source-maps index.ts");
    // No stripping flag by default — targets the docker image's node:24
    // (unflagged type stripping); see the design note's Phase B decision.
    expect(pkg.scripts.debug).not.toContain("--experimental-strip-types");
  });

  it("flag-on: tsconfig.json carries allowImportingTsExtensions", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;

    const tsconfig = JSON.parse(files.get(`${HONO_SLUG}/tsconfig.json`)!) as {
      compilerOptions: Record<string, unknown>;
    };
    expect(tsconfig.compilerOptions.allowImportingTsExtensions).toBe(true);
    // noEmit must stay true too — TS5097's other half of the precondition.
    expect(tsconfig.compilerOptions.noEmit).toBe(true);
  });

  it("flag-on: relative imports across the node deployable carry their real extension", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;

    const orderTs = files.get(`${HONO_SLUG}/domain/order.ts`)!;
    // `Ids` is a value import (runtime-used); `Money` stays `import type` (an
    // erasable, whole-statement-elided import — Node never loads
    // value-objects.ts through it, which is exactly why the aggregate-only
    // debugging story holds even though value-objects.ts itself doesn't
    // load under type stripping, see the design note).
    expect(orderTs).toContain(`from "./ids.ts"`);
    expect(orderTs).toMatch(/import type \{ Money \} from ".\/value-objects\.ts"/);

    const indexTs = files.get(`${HONO_SLUG}/index.ts`)!;
    expect(indexTs).toContain(`from "./http/index.ts"`);
    expect(indexTs).not.toMatch(/from "\.\/http\/index"[^.]/);
  });

  it("flag-on: .vscode/launch.json carries one byte-identical node config per node deployable (alongside M26's dotnet config)", async () => {
    const model = await parseValid(SOURCE);
    const files = generateSystems(model, { sourcemap: true }).files;

    const raw = files.get(".vscode/launch.json");
    expect(raw).toBeDefined();
    const launch = JSON.parse(raw!) as {
      version: string;
      configurations: {
        type: string;
        request: string;
        name: string;
        program: string;
        cwd: string;
        runtimeArgs: string[];
        skipFiles: string[];
      }[];
    };
    expect(launch.version).toBe("0.2.0");
    // Two node deployables + one dotnet deployable → three configs post-M26.
    expect(launch.configurations).toHaveLength(3);

    // The two NODE configs are exactly M18's shape, unchanged by M26.
    const nodeCfgs = launch.configurations.filter((c) => c.type === "node");
    expect(nodeCfgs).toHaveLength(2);
    const bySlug = new Map(nodeCfgs.map((c) => [c.program.split("/")[1], c] as const));
    for (const slug of [HONO_SLUG, HONO2_SLUG]) {
      const cfg = bySlug.get(slug);
      expect(cfg, `missing launch config for ${slug}`).toBeDefined();
      expect(cfg!.type).toBe("node");
      expect(cfg!.request).toBe("launch");
      expect(cfg!.program).toBe(`\${workspaceFolder}/${slug}/index.ts`);
      expect(cfg!.cwd).toBe(`\${workspaceFolder}/${slug}`);
      expect(cfg!.runtimeArgs).toEqual(["--enable-source-maps"]);
      expect(cfg!.skipFiles).toEqual(["<node_internals>/**"]);
    }
    // The dotnet deployable earns a `coreclr` config (M26) — pinned in
    // detail by launch-config.test.ts; here just prove it now appears.
    expect(launch.configurations.some((c) => c.type === "coreclr")).toBe(true);
  });

  it("flag-on: no launch.json is emitted when no deployable has a debug story (python-only)", async () => {
    // python has no `debugLaunch` seam, so a python-only system emits no
    // launch.json — the honest replacement for the pre-M26 "dotnet-only ⇒
    // no launch.json" case (dotnet now DOES earn a coreclr config).
    const PYTHON_ONLY = `
system PythonOnlyDemo {
  subdomain Sales {
    context Orders {
      aggregate Order { customerName: string }
      repository Orders for Order { }
    }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  api SalesApi from Sales
  deployable pyApi { platform: python contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8000 }
}
`;
    const model = await parseValid(PYTHON_ONLY);
    const files = generateSystems(model, { sourcemap: true }).files;
    expect(files.has(".vscode/launch.json")).toBe(false);
  });
});
