// A guarded Phoenix workflow short-circuits with `throw({:error, …})`,
// but the controller calls `run/2` inside a `case` — which does NOT
// catch throws.  An uncaught throw crashes the request (500) instead of
// yielding the `{:error, reason}` the controller maps to 403 / 400.  The
// workflow emitter wraps the body in `try/catch :throw` so a thrown
// `{:error, …}` becomes the function's return value.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/parse.js";

async function gen(src: string): Promise<Map<string, string>> {
  const { model } = await parseString(src, { validate: false });
  return generateSystems(model).files;
}

const GUARDED = `
system Sys {
  user { id: string, role: string }
  subdomain Sales { context Sales {
    aggregate Order { name: string }
    repository Orders for Order { }
    workflow Archive(name: string) {
      requires currentUser.role == "admin"
      precondition name.length > 0
      let o = Order.create({ name: name })
    }
  } }
  storage pg { type: postgres }
  resource salesState { for: Sales, kind: state, use: pg }
  deployable api { platform: phoenixLiveView, contexts: [Sales], dataSources: [salesState], port: 4000, auth: required }
}`;

describe("Phoenix workflow guard short-circuit", () => {
  it("wraps a guarded workflow body in try/catch so throw({:error, …}) is returned, not raised", async () => {
    const files = await gen(GUARDED);
    const wf = files.get("api/lib/api/sales/workflows/archive.ex")!;
    // The guards still short-circuit via throw …
    expect(wf).toMatch(/unless .*role == "admin", do: throw\(\{:error, :forbidden\}\)/);
    expect(wf).toMatch(/unless .*, do: throw\(\{:error, "Precondition failed: [^"]*"\}\)/);
    // … and a try/catch turns that throw back into a return value the
    // controller's `case run(...)` can pattern-match (→ 403 / 400).
    expect(wf).toMatch(/try do/);
    expect(wf).toMatch(/catch\n\s*:throw, \{:error, _\} = err -> err\n\s*end/);
    // The catch wraps the body: the throw lines sit between `try do` and
    // `catch`, so the guard can't escape uncaught.
    const tryIdx = wf.indexOf("try do");
    const throwIdx = wf.indexOf("throw({:error, :forbidden})");
    const catchIdx = wf.indexOf("    catch");
    expect(tryIdx).toBeGreaterThanOrEqual(0);
    expect(throwIdx).toBeGreaterThan(tryIdx);
    expect(catchIdx).toBeGreaterThan(throwIdx);
  });

  it("leaves a guard-free workflow body unwrapped (no dead try/catch)", async () => {
    const plain = `
system Sys {
  subdomain Sales { context Sales {
    aggregate Order { name: string }
    repository Orders for Order { }
    workflow Touch(name: string) {
      let o = Order.create({ name: name })
    }
  } }
  storage pg { type: postgres }
  resource salesState { for: Sales, kind: state, use: pg }
  deployable api { platform: phoenixLiveView, contexts: [Sales], dataSources: [salesState], port: 4000 }
}`;
    const files = await gen(plain);
    const wf = files.get("api/lib/api/sales/workflows/touch.ex")!;
    expect(wf).not.toMatch(/try do/);
    expect(wf).not.toMatch(/catch/);
  });
});
