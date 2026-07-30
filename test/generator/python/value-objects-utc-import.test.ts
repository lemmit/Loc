import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// `app/domain/value_objects.py` imported `UTC` alongside `datetime` whenever
// ANY value object carried a `datetime` field.  A plain datetime FIELD uses the
// TYPE and never the constant, so the import was a stale F401 — which fails the
// emitted project's own `ruff check` gate, i.e. a build-break for any model
// with a datetime-carrying VO and no server-stamped `now`.  (The aggregate
// emitter already guarded this with a body probe; the VO emitter didn't.)
// ---------------------------------------------------------------------------

const SOURCE = `
system VoUtc {
  subdomain Ops {
    context Ops {
      valueobject Entry {
        at: datetime
        n: int
      }
      aggregate Ledger with crudish {
        entry: Entry
      }
      repository Ledgers for Ledger { }
    }
  }
  api OpsApi from Ops
  storage primary { type: postgres }
  resource opsState { for: Ops, kind: state, use: primary }
  deployable svc {
    platform: python
    contexts: [Ops]
    dataSources: [opsState]
    serves: OpsApi
    port: 4000
  }
}
`;

describe("python value_objects.py datetime imports", () => {
  it("imports `datetime` without `UTC` when no body stamps now(UTC)", async () => {
    const { model, errors } = await parseString(SOURCE);
    if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
    const vo = generateSystems(model).files.get("svc/app/domain/value_objects.py");
    expect(vo).toContain("from datetime import datetime");
    expect(vo).not.toContain("from datetime import UTC");
  });
});
