import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrichments.js";
import { lowerModel } from "../../src/ir/lower.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { buildC4Model, renderC4Model } from "../../src/system/likec4.js";

// ---------------------------------------------------------------------------
// `<outdir>/.loom/architecture.c4` snapshot.  Locks the LikeC4 model so
// generator changes that alter the architecture projection show up as a
// diffable snapshot review.  (Validity against the real LikeC4 parser
// was confirmed manually with `likec4 validate`.)
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

describe("architecture.c4", () => {
  it("emits the expected LikeC4 model for examples/acme.ddd", async () => {
    const loom = await build("examples/acme.ddd");
    expect(buildC4Model(loom.systems[0]!)).toMatchSnapshot();
  });

  it("declares the spec, a container per deployable, and views", async () => {
    const sys = (await build("examples/acme.ddd")).systems[0]!;
    const out = buildC4Model(sys);
    expect(out).toContain("specification {");
    expect(out).toContain("element container");
    for (const d of sys.deployables) {
      expect(out).toContain(`container '${d.name}'`);
      expect(out).toContain(`technology '${d.platform}'`);
    }
    expect(out).toContain("view index {");
    expect(renderC4Model(sys).endsWith("\n")).toBe(true);
  });
});
