import { describe, expect, it } from "vitest";
import { buildC4Model, renderC4Model } from "../../src/system/likec4.js";
import { loadExampleModel, toLoomModel } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// `<outdir>/.loom/architecture.c4` snapshot.  Locks the LikeC4 model so
// generator changes that alter the architecture projection show up as a
// diffable snapshot review.  (Validity against the real LikeC4 parser
// was confirmed manually with `likec4 validate`.)
// ---------------------------------------------------------------------------

async function build(file: string) {
  return toLoomModel(await loadExampleModel(file));
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
