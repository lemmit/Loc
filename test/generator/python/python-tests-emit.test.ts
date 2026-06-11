import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — `test "…" { … }` blocks → pytest (plan S5).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/shell.ddd"),
  "utf8",
);

async function build() {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python test emission", () => {
  it("emits one pytest function per test block, slugged from the name", async () => {
    const files = await build();
    const tests = files.get("api/tests/test_widget.py")!;
    expect(tests).toContain("def test_widget_activates_from_draft() -> None:");
    expect(tests).toContain("def test_activate_requires_draft() -> None:");
    expect(tests).toContain("def test_price_invariant_rejects_short_currency() -> None:");
  });

  it("coerces create-input literals: kwargs, enum refs, positional VO ctor", async () => {
    const files = await build();
    const tests = files.get("api/tests/test_widget.py")!;
    expect(tests).toContain(
      'w = Widget.create(label="gizmo", size=1, status=WidgetStatus.Draft, price=Price(1.0, "USD"))',
    );
  });

  it("maps comparison matchers onto operators and expectThrows onto pytest.raises", async () => {
    const files = await build();
    const tests = files.get("api/tests/test_widget.py")!;
    expect(tests).toContain("    assert w.status == WidgetStatus.Active");
    expect(tests).toContain("    assert w.size > 0");
    expect(tests).toContain("    with pytest.raises(Exception):");
    expect(tests).toContain("        w.activate()");
  });

  it("emits no test file for aggregates without test blocks", async () => {
    const files = await build();
    const testFiles = [...files.keys()].filter((k) => k.startsWith("api/tests/"));
    expect(testFiles).toEqual(["api/tests/test_widget.py"]);
  });
});
