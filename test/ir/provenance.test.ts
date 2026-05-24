import { AstUtils } from "langium";
import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrichments.js";
import { lowerModel } from "../../src/ir/lower.js";
import { stmtHasProv } from "../../src/ir/prov-id.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import { isProperty, type Model, type Property } from "../../src/language/generated/ast.js";
import { generateSystems } from "../../src/system/index.js";
import { captureSnapshots } from "../../src/system/loomsnap.js";

// ---------------------------------------------------------------------------
// `provenanced` stored-field modifier — per-write-site rule snapshots
// instrumented on the TypeScript/Hono backend.  Covers the grammar flag,
// IR lowering, code emission + emission toggle, and the `ddd snapshot`
// capture artefact.
// ---------------------------------------------------------------------------

const services = createDddServices(NodeFileSystem);
const parse = parseHelper<Model>(services.Ddd);

async function parseModel(
  src: string,
): Promise<{ model: Model; errors: string[]; warnings: string[] }> {
  const doc = await parse(src, { validation: true });
  const diags = doc.diagnostics ?? [];
  return {
    model: doc.parseResult.value,
    errors: diags.filter((d) => d.severity === 1).map((d) => d.message),
    warnings: diags.filter((d) => d.severity === 2).map((d) => d.message),
  };
}

const SYSTEM = (body: string) => `
system S {
  module M {
    context C {
      aggregate Cart ids guid {
        label: string display
        total: int provenanced
        discount: int
${body}
        operation applyTotal(base: int, qty: int) {
          total := base * qty - discount
        }
      }
      repository Carts for Cart {
        find byLabel(label: string): Cart? where this.label == label
      }
    }
  }
  deployable api { platform: hono, modules: M, port: 3000 }
}
`;

describe("provenanced — grammar", () => {
  it("sets Property.provenanced on a stored field", async () => {
    const { model, errors } = await parseModel(SYSTEM(""));
    expect(errors).toEqual([]);
    const prop = findProperty(model, "Cart", "total");
    expect(prop.provenanced).toBe(true);
    expect(findProperty(model, "Cart", "discount").provenanced).toBeFalsy();
  });

  it("coexists with `display`", async () => {
    const src = SYSTEM("").replace("label: string display", "label: string display provenanced");
    const { model, errors } = await parseModel(src);
    expect(errors).toEqual([]);
    const label = findProperty(model, "Cart", "label");
    expect(label.display).toBe(true);
    expect(label.provenanced).toBe(true);
  });

  it("is rejected on a `derived` member (grammar guard)", async () => {
    const src = SYSTEM("        derived doubled: int provenanced = total * 2\n");
    const { errors } = await parseModel(src);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("provenanced — validation", () => {
  it("warns when a provenanced field is never written", async () => {
    // `total` is provenanced but no operation assigns it here.
    const src = `
system S { module M { context C {
  aggregate Cart ids guid {
    label: string display
    total: int provenanced
    operation noop(x: int) { precondition x > 0 }
  }
  repository Carts for Cart { find byLabel(label: string): Cart? where this.label == label }
} } deployable api { platform: hono, modules: M, port: 3000 } }
`;
    const { warnings } = await parseModel(src);
    expect(warnings.some((w) => /Provenanced field 'total'.*never written/.test(w))).toBe(true);
  });

  it("does not warn when the field is written", async () => {
    const { warnings } = await parseModel(SYSTEM(""));
    expect(warnings.some((w) => /never written/.test(w))).toBe(false);
  });
});

describe("provenanced — IR lowering", () => {
  it("flags the field and attaches a prov snapshot to the write-site", async () => {
    const { model, errors } = await parseModel(SYSTEM(""));
    expect(errors).toEqual([]);
    const loom = enrichLoomModel(lowerModel(model));
    const cart = loom.systems[0]!.modules[0]!.contexts[0]!.aggregates[0]!;
    expect(cart.fields.find((f) => f.name === "total")?.provenanced).toBe(true);

    const op = cart.operations.find((o) => o.name === "applyTotal")!;
    const writes = op.statements.filter(stmtHasProv);
    expect(writes).toHaveLength(1);
    const prov = writes[0]!.prov;
    expect(prov.target).toEqual({ type: "Cart", field: "total" });
    expect(prov.exprText).toBe("base * qty - discount");
    expect(prov.snapshotId).toMatch(/^[0-9a-f]{8}$/);
  });

  it("leaves non-provenanced writes without a snapshot", async () => {
    // discount is not provenanced — an op assigning it carries no prov.
    const src = SYSTEM("        operation setDiscount(d: int) { discount := d }\n");
    const { model } = await parseModel(src);
    const loom = enrichLoomModel(lowerModel(model));
    const cart = loom.systems[0]!.modules[0]!.contexts[0]!.aggregates[0]!;
    const op = cart.operations.find((o) => o.name === "setDiscount")!;
    expect(op.statements.some(stmtHasProv)).toBe(false);
  });

  it("derives a content-addressed, stable snapshotId (same rule ⇒ same id)", async () => {
    const a = enrichLoomModel(lowerModel((await parseModel(SYSTEM(""))).model));
    const b = enrichLoomModel(lowerModel((await parseModel(SYSTEM(""))).model));
    const idOf = (loom: typeof a) =>
      loom.systems[0]!.modules[0]!.contexts[0]!.aggregates[0]!.operations.find(
        (o) => o.name === "applyTotal",
      )!.statements.filter(stmtHasProv)[0]!.prov.snapshotId;
    expect(idOf(a)).toBe(idOf(b));
  });
});

describe("provenanced — TypeScript emission", () => {
  it("emits the lineage types and the co-located backing field + history buffer", async () => {
    const { model } = await parseModel(SYSTEM(""));
    const files = generateSystems(model).files;
    expect(files.has("api/domain/provenance.ts")).toBe(true);
    expect(files.get("api/domain/provenance.ts")!).toContain("export interface ProvLineage");
    const cart = files.get("api/domain/cart.ts")!;
    expect(cart).toContain('import { type ProvLineage } from "./provenance";');
    // co-located backing field + getter + history buffer + drain
    expect(cart).toContain("private _total_provenance: ProvLineage | null;");
    expect(cart).toContain("get total_provenance(): ProvLineage | null");
    expect(cart).toContain("private _provTraces: ProvLineage[] = [];");
    expect(cart).toContain("drainProv(): ProvLineage[]");
    // inputs captured before the mutation, then both sinks fed
    expect(cart).toMatch(/const __prov_\d+ = \[.*\];\n\s*this\._total =/);
    expect(cart).toMatch(/this\._total_provenance = __lin_\d+;/);
    expect(cart).toMatch(/this\._provTraces\.push\(__lin_\d+\);/);
  });

  it("persists the co-located column and the history table in the schema", async () => {
    const { model } = await parseModel(SYSTEM(""));
    const files = generateSystems(model).files;
    const schema = files.get("api/db/schema.ts")!;
    expect(schema).toContain(", jsonb }");
    expect(schema).toContain('total_provenance: jsonb("total_provenance").$type<');
    expect(schema).toContain('export const provenanceRecords = pgTable("provenance_records"');
  });

  it("flushes the history transactionally and rides the lineage on the wire", async () => {
    const { model } = await parseModel(SYSTEM(""));
    const files = generateSystems(model).files;
    const routes = files.get("api/http/cart.routes.ts")!;
    expect(routes).toContain("await db.transaction(async (tx) => {");
    expect(routes).toContain("for (const t of aggregate.drainProv())");
    expect(routes).toContain("tx.insert(schema.provenanceRecords).values({");
    // co-located lineage is part of the response DTO, via the shared schema
    expect(routes).toContain("const ProvenanceLineage = z.object({");
    expect(routes).toContain("total_provenance: ProvenanceLineage.nullable(),");
    // toWire serialises the backing field
    const repo = files.get("api/db/repositories/cart-repository.ts")!;
    expect(repo).toContain("total_provenance: root.total_provenance");
    expect(repo).toContain("total_provenance: aggregate.total_provenance");
  });

  it("emits nothing when no field is provenanced (toggle off)", async () => {
    const src = SYSTEM("").replace("total: int provenanced", "total: int");
    const { model } = await parseModel(src);
    const files = generateSystems(model).files;
    expect(files.has("api/domain/provenance.ts")).toBe(false);
    expect(files.get("api/domain/cart.ts")).not.toContain("ProvLineage");
    expect(files.get("api/db/schema.ts")).not.toContain("provenance_records");
    expect(files.get("api/http/cart.routes.ts")).not.toContain("drainProv");
  });

  it("does not auto-emit a snapshot artefact on generate", async () => {
    const { model } = await parseModel(SYSTEM(""));
    const files = generateSystems(model).files;
    expect([...files.keys()].some((p) => p.includes("loomsnap"))).toBe(false);
  });
});

describe("provenanced — snapshot capture", () => {
  it("captures one timestamped+GUID file whose ids match the generated lineage", async () => {
    const { model } = await parseModel(SYSTEM(""));
    const loom = enrichLoomModel(lowerModel(model));
    const snaps = captureSnapshots(loom);
    expect(snaps.size).toBe(1);
    const [name, content] = [...snaps][0]!;
    expect(name).toMatch(/^\.loom\/snapshots\/\d{8}T\d{6}Z-[0-9a-f-]+\.loomsnap\.json$/);
    const doc = JSON.parse(content);
    expect(doc.system).toBe("S");
    // the write-site's snapshotId appears both in the artefact and in code.
    const id = Object.keys(doc.snapshots)[0]!;
    const gen = generateSystems(model).files.get("api/domain/cart.ts")!;
    expect(gen).toContain(`snapshotId: ${JSON.stringify(id)}`);
    expect(doc.snapshots[id].expression.text).toBe("base * qty - discount");
  });

  it("captures nothing when no provenanced field is written", async () => {
    const src = SYSTEM("").replace("total: int provenanced", "total: int");
    const { model } = await parseModel(src);
    const loom = enrichLoomModel(lowerModel(model));
    expect(captureSnapshots(loom).size).toBe(0);
  });
});

function findProperty(model: Model, agg: string, field: string): Property {
  for (const node of AstUtils.streamAst(model)) {
    if (
      isProperty(node) &&
      node.name === field &&
      AstUtils.getContainerOfType(
        node,
        (n): n is import("../../src/language/generated/ast.js").Aggregate =>
          n.$type === "Aggregate",
      )?.name === agg
    ) {
      return node;
    }
  }
  throw new Error(`property ${agg}.${field} not found`);
}
