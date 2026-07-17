// Regression: the pooled `app/domain/repository_ports.py` narrows its imports
// by scanning the Protocol member signatures for referenced type names.  The
// strongly-typed-id harvest used a bare `/\b[A-Z][A-Za-z0-9]*Id\b/` regex and
// imported every match from `app.domain.ids`.  A value object (or enum) whose
// name ends in `Id` lives in `app.domain.value_objects`, not `app.domain.ids`,
// so harvesting it produced `from app.domain.ids import <Vo>` → `ImportError`
// at module load.  The harvest now cross-checks against the ids actually
// declared (`<Aggregate>Id` / `<Part>Id`).

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  system S {
    subdomain D { context C {
      valueobject RefId {
        code: string
      }
      aggregate Order with crudish {
        ref: RefId
        total: int
      }
      repository OrderRepo for Order {
        find byRef(r: RefId): Order[] where this.ref == r
      }
    }}
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    deployable api { platform: python  contexts: [C]  dataSources: [cState]  port: 3000 }
  }
`;

async function portsFile(): Promise<string> {
  const files = (await generateSystems(await parseValid(SRC))).files;
  const k = [...files.keys()].find((key) => key.endsWith("app/domain/repository_ports.py"));
  expect(k, "repository_ports.py not emitted").toBeDefined();
  return files.get(k!)!;
}

describe("python repository ports — id-suffixed value object import routing", () => {
  it("imports a `*Id` value object from value_objects, never from app.domain.ids", async () => {
    const port = await portsFile();
    // The VO is referenced in a port signature.
    expect(port).toContain("async def by_ref(self, r: RefId) -> list[Order]: ...");
    // …and imported from the module it actually lives in.
    expect(port).toContain("from app.domain.value_objects import RefId");
    // The ids import must carry only the real aggregate id, not the VO.
    const idsImport = port.split("\n").find((l) => l.startsWith("from app.domain.ids import"));
    expect(idsImport).toBe("from app.domain.ids import OrderId");
    expect(idsImport).not.toContain("RefId");
  });
});
