import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// `ddd generate system --sourcemap` — pins the CLI-side threading the system
// tests can't see: parseProject building `sourceTexts` from the parsed
// documents and passing it into `generateSystemsFromLoom`, so the Source Map
// v3 sidecars actually land on disk with the ABSOLUTE `.ddd` path in
// `sources`.  The v3 content itself is covered at the system/unit level
// (test/system/sourcemap*.test.ts); this is the wiring gate.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const SOURCE = `
system SmokeMap {
  subdomain Sales {
    context Orders {
      event OrderPlaced { order: Order id }
      aggregate Order {
        customerName: string
        operation confirm() {
          let note = customerName
          emit OrderPlaced { order: id }
        }
      }
      repository Orders for Order { }
    }
  }
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  api SalesApi from Sales
  deployable honoApi { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 3000 }
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-sourcemap-cli-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

describe("ddd generate system --sourcemap (CLI wiring)", () => {
  const dddPath = path.join(tmp, "smoke.ddd");
  fs.writeFileSync(dddPath, SOURCE);

  it("emits v3 sidecars with the absolute .ddd path in sources", () => {
    const outDir = path.join(tmp, "on");
    execSync(`node ${cli} generate system ${dddPath} -o ${outDir} --sourcemap`, {
      encoding: "utf8",
    });

    const mapPath = path.join(outDir, "hono_api", "domain", "order.ts.map");
    expect(fs.existsSync(mapPath), `${mapPath} not written`).toBe(true);
    const v3 = JSON.parse(fs.readFileSync(mapPath, "utf8")) as {
      version: number;
      sources: string[];
      sourcesContent?: string[];
    };
    expect(v3.version).toBe(3);
    // The ABSOLUTE path is what a debugger resolves the source through, so it
    // is the load-bearing half — and by default it is the ONLY half: the
    // source text is not inlined (see the next case).
    expect(v3.sources).toContain(dddPath);
    expect(v3.sourcesContent).toBeUndefined();

    const tsContent = fs.readFileSync(path.join(outDir, "hono_api", "domain", "order.ts"), "utf8");
    expect(tsContent.endsWith("//# sourceMappingURL=order.ts.map\n")).toBe(true);
  });

  // Every sidecar used to carry a full copy of the `.ddd` it came from — 112
  // sidecars × the whole source = 763 KB on the ERP example, against a 201 KB
  // consolidated `.loom/sourcemap.json` covering more files.  The copies are
  // pure duplication wherever `sources`' absolute path resolves (a local
  // tree), so they became opt-in.
  it("inlines the .ddd text only under --inline-sources, and that costs real bytes", () => {
    const lean = path.join(tmp, "lean");
    const fat = path.join(tmp, "fat");
    execSync(`node ${cli} generate system ${dddPath} -o ${lean} --sourcemap`, { encoding: "utf8" });
    execSync(`node ${cli} generate system ${dddPath} -o ${fat} --sourcemap --inline-sources`, {
      encoding: "utf8",
    });

    const inlined = JSON.parse(
      fs.readFileSync(path.join(fat, "hono_api", "domain", "order.ts.map"), "utf8"),
    ) as { sources: string[]; sourcesContent: string[] };
    expect(inlined.sourcesContent[inlined.sources.indexOf(dddPath)]).toBe(SOURCE);

    const bytes = (dir: string) =>
      walk(dir)
        .filter((p) => p.endsWith(".map"))
        .reduce((n, p) => n + fs.statSync(p).size, 0);
    // Same map count, materially fewer bytes.
    expect(walk(lean).filter((p) => p.endsWith(".map")).length).toBe(
      walk(fat).filter((p) => p.endsWith(".map")).length,
    );
    expect(bytes(lean)).toBeLessThan(bytes(fat));
  });

  it("emits neither sidecars nor directives without the flag", () => {
    const outDir = path.join(tmp, "off");
    execSync(`node ${cli} generate system ${dddPath} -o ${outDir}`, { encoding: "utf8" });

    const files = walk(outDir);
    expect(files.some((p) => p.endsWith(".map"))).toBe(false);
    for (const p of files.filter((f) => f.endsWith(".ts"))) {
      expect(fs.readFileSync(p, "utf8")).not.toContain("//# sourceMappingURL=");
    }
  });
});
