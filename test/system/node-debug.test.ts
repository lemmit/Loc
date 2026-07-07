import { describe, expect, it } from "vitest";
import { generateSystems } from "../../src/system/index.js";
import { parseValid } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// M18 phase 8 slice 1 — Node debug wiring (docs/plans/dap-node-debug.md).
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
// rewrite, and a system-root `.vscode/launch.json` — one config per
// node-family deployable, none of it touching non-node deployables or the
// flag-off run.
// ---------------------------------------------------------------------------

// Two node deployables (so "one config per node deployable" is a real
// fan-out, not a single-element coincidence) plus one dotnet deployable
// (so the launch.json filter is proven to EXCLUDE non-node platforms, not
// just happen to only see node ones).
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

  it("flag-on: .vscode/launch.json carries one config per node-family deployable, excludes dotnet", async () => {
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
    expect(launch.configurations).toHaveLength(2);

    const bySlug = new Map(launch.configurations.map((c) => [c.program.split("/")[1], c] as const));
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
    // No config mentions the dotnet deployable's slug.
    expect(launch.configurations.some((c) => c.program.includes("dotnet_api"))).toBe(false);
  });

  it("flag-on: no launch.json is emitted when a system has no node-family deployable", async () => {
    const DOTNET_ONLY = `
system DotnetOnlyDemo {
  subdomain Sales {
    context Orders {
      aggregate Order { customerName: string }
      repository Orders for Order { }
    }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  api SalesApi from Sales
  deployable dotnetApi { platform: dotnet contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
}
`;
    const model = await parseValid(DOTNET_ONLY);
    const files = generateSystems(model, { sourcemap: true }).files;
    expect(files.has(".vscode/launch.json")).toBe(false);
  });
});
