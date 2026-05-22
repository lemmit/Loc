import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrichments.js";
import { lowerModel } from "../../src/ir/lower.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { buildWireSpec, renderWireSpec } from "../../src/system/wire-spec.js";

// ---------------------------------------------------------------------------
// Wire-spec snapshot.  Locks the public format of
// `<outdir>/.loom/wire-spec.json` so future generator changes that
// alter wire shapes show up as a diffable snapshot review rather than
// silently changing the artifact.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

async function build(file: string) {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
    URI.file(path.join(repoRoot, file)),
  );
  await services.shared.workspace.DocumentBuilder.build([doc], {
    validation: true,
  });
  return enrichLoomModel(lowerModel(doc.parseResult.value as Model));
}

describe("wire-spec.json", () => {
  it("emits the expected document shape for examples/acme.ddd", async () => {
    const loom = await build("examples/acme.ddd");
    const sys = loom.systems[0]!;
    expect(buildWireSpec(sys)).toMatchSnapshot();
  });

  it("renders deterministic JSON with trailing newline", async () => {
    const loom = await build("examples/acme.ddd");
    const sys = loom.systems[0]!;
    const rendered = renderWireSpec(sys);
    expect(rendered.endsWith("\n")).toBe(true);
    // Parse-roundtrip must round-trip to the same shape.
    expect(JSON.parse(rendered)).toEqual(buildWireSpec(sys));
  });
});
