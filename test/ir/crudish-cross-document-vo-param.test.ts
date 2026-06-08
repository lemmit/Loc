import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerProject } from "../../src/ir/lower/lower.js";
import type { AggregateIR } from "../../src/ir/types/loom-ir.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { loadProject } from "../../src/language/project-loader.js";

// Regression: a `crudish` macro synthesises one `update` param per writable
// field, typed by cloning the field's TypeRef.  Macro-emitted references
// carry no `$refNode`, so Langium's Linker skips them and `ref` stays
// undefined; lower-types then falls back to resolving the reference *text*.
// The env-local fallback only sees the current context + same-document root,
// so a field typed by a *sibling-file* shared-kernel value object / enum
// collapsed to `string` — poisoning the generated domain `update(...)`
// signature.  `lowerProject` now installs a project-global name→kind index
// that backstops the fallback across documents.

function writeProject(rootDir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
}

async function loadAggregate(entryDdd: string, name: string): Promise<AggregateIR> {
  const services = createDddServices(NodeFileSystem);
  const { all } = await loadProject(URI.file(entryDdd), services.shared);
  const loom = enrichLoomModel(lowerProject(all.map((d) => d.parseResult.value as Model)));
  for (const s of loom.systems) {
    for (const sub of s.subdomains) {
      for (const c of sub.contexts) {
        const agg = c.aggregates.find((a) => a.name === name);
        if (agg) return agg;
      }
    }
  }
  throw new Error(`aggregate ${name} not found`);
}

describe("crudish update params resolve cross-document shared-kernel types", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-xdoc-vo-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("keeps a sibling-file value-object / enum param type instead of collapsing to string", async () => {
    writeProject(tmp, {
      // Ambient shared kernel in its own document — referenced by bare name.
      "shared.ddd": `
        valueobject Money {
          amount: decimal
          currency: string
          invariant amount >= 0
        }
        enum Priority { Low, Normal, High }
      `,
      "main.ddd": `
        import "./shared.ddd"
        system Demo {
          subdomain Sales { context Orders {
            aggregate Order with crudish {
              reference: string
              price: Money
              priority: Priority = Normal
            }
          }}
        }
      `,
    });
    const agg = await loadAggregate(path.join(tmp, "main.ddd"), "Order");
    const update = agg.operations.find((o) => o.name === "update");
    expect(update).toBeDefined();
    const byName = new Map(update!.params.map((p) => [p.name, p.type]));

    // The plain primitive stays a primitive (sanity).
    expect(byName.get("reference")).toMatchObject({ kind: "primitive", name: "string" });
    // The cross-document value object keeps its VO type — the bug rendered
    // this as `{ kind: "primitive", name: "string" }`.
    expect(byName.get("price")).toMatchObject({ kind: "valueobject", name: "Money" });
    // The cross-document enum keeps its enum type.
    expect(byName.get("priority")).toMatchObject({ kind: "enum", name: "Priority" });
  });
});
