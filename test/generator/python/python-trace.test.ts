import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — `--trace` domain instrumentation (F5).  Under
// emitTrace, the domain layer emits `precondition_evaluated`,
// `value_computed`, and `invariant_evaluated` trace lines via the
// `log("trace", …)` facade (the catalog's TRACE level).  Off by default
// (byte-identical), opt-in via `generate system --trace`.  No obs e2e
// asserts these on any backend — cosmetic parity with Hono/.NET.
// Verified live (an OrderLine construction emits invariant_evaluated to
// stdout) and statically by the `domain.ddd --trace` corpus case.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/domain.ddd"),
  "utf8",
);

async function build(emitTrace: boolean) {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model, { emitTrace }).files;
}

describe("python --trace domain instrumentation", () => {
  it("off by default: no trace lines, no log import, plain _assert_invariants", async () => {
    const files = await build(false);
    for (const [p, c] of files) {
      if (!p.startsWith("api/app/domain/")) continue;
      expect(c).not.toContain('log("trace"');
      expect(c).not.toContain("from app.obs.log import log");
    }
    const order = files.get("api/app/domain/order.py")!;
    expect(order).toContain("def _assert_invariants(self) -> None:");
  });

  it("emits invariant_evaluated with the threaded __op label", async () => {
    const files = await build(true);
    const order = files.get("api/app/domain/order.py")!;
    expect(order).toContain("from app.obs.log import log");
    // The helper takes the __op label; the ctor threads "<init>".
    expect(order).toContain("def _assert_invariants(self, __op: str) -> None:");
    expect(order).toContain('self._assert_invariants("<init>")');
    expect(order).toContain("__inv_0_ok = (self._quantity > 0)");
    expect(order).toContain(
      'log("trace", "invariant_evaluated", aggregate="OrderLine", op=__op, expr="quantity > 0", passed=__inv_0_ok)',
    );
    expect(order).toContain("if not __inv_0_ok:");
  });

  it("emits value_computed after a single-segment field assign", async () => {
    const files = await build(true);
    const order = files.get("api/app/domain/order.py")!;
    // An operation that assigns a scalar field traces the new value.
    expect(order).toMatch(
      /log\("trace", "value_computed", aggregate="[A-Za-z]+", field="[a-z_]+", value=self\._[a-z_]+\)/,
    );
  });

  it("emits precondition_evaluated (temp var + trace + check) where preconditions exist", async () => {
    const files = await build(true);
    const traced = [...files.entries()].find(
      ([p, c]) => p.startsWith("api/app/domain/") && c.includes('"precondition_evaluated"'),
    );
    expect(traced).toBeDefined();
    const body = traced![1];
    expect(body).toMatch(/__pre_\d+_ok = \(/);
    expect(body).toMatch(
      /log\("trace", "precondition_evaluated", aggregate="[A-Za-z]+", op="[a-zA-Z]+", expr=".*", passed=__pre_\d+_ok\)/,
    );
  });
});
