import { describe, expect, it } from "vitest";
import { buildWireSpec, renderWireSpec } from "../../src/system/wire-spec.js";
import { loadExampleModel, toLoomModel } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// Wire-spec snapshot.  Locks the public format of
// `<outdir>/.loom/wire-spec.json` so future generator changes that
// alter wire shapes show up as a diffable snapshot review rather than
// silently changing the artifact.
// ---------------------------------------------------------------------------

async function build(file: string) {
  return toLoomModel(await loadExampleModel(file));
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
