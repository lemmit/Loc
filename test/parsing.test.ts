import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createDddServices } from "../src/language/ddd-module.js";
import type { Model } from "../src/language/generated/ast.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

async function parseExample(filename: string): Promise<{
  model: Model;
  errors: string[];
}> {
  const services = createDddServices(NodeFileSystem);
  const docs = services.shared.workspace.LangiumDocuments;
  const doc = await docs.getOrCreateDocument(URI.file(path.join(repoRoot, filename)));
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  const errors = (doc.diagnostics ?? [])
    .filter((d) => d.severity === 1)
    .map((d) => `${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`);
  return { model: doc.parseResult.value as Model, errors };
}

describe("parsing & validation of examples", () => {
  it("parses sales.ddd without errors", async () => {
    const { model, errors } = await parseExample("examples/sales.ddd");
    expect(errors).toEqual([]);
    const contexts = model.members.filter(
      (m): m is import("../src/language/generated/ast.js").BoundedContext =>
        m.$type === "BoundedContext",
    );
    expect(contexts).toHaveLength(1);
    const sales = contexts[0]!;
    expect(sales.name).toBe("Sales");
    const orderAgg = sales.members.find((m) => m.name === "Order");
    expect(orderAgg?.$type).toBe("Aggregate");
  });

  it("parses inventory.ddd without errors", async () => {
    const { errors } = await parseExample("examples/inventory.ddd");
    expect(errors).toEqual([]);
  });
});
