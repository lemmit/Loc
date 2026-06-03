// Phase 4a — hono emits resource-op call sites + s3 verb helpers.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
system Sys {
  subdomain Sales { context Sales {
    aggregate Order { name: string }
    workflow Archive {
      create(name: string) {
      let prev = salesFiles.get("orders/" + name)
      salesFiles.put("orders/" + name, name)
    }
    }
  } }
  storage pg { type: postgres }
  storage files { type: s3, config: { bucket: "app-files" } }
  resource salesState { for: Sales, kind: state, use: pg }
  resource salesFiles { for: Sales, kind: objectStore, use: files }
  deployable api { platform: hono, contexts: [Sales], dataSources: [salesState, salesFiles], port: 3000 }
}`;

describe("hono resource-op emission", () => {
  it("emits async put/get verb helpers in the s3 client module", async () => {
    const { model } = await parseString(SRC, { validate: false });
    const { files } = generateSystems(model);
    const s3 = files.get("api/resources/s3.ts")!;
    expect(s3).toMatch(/PutObjectCommand/);
    expect(s3).toMatch(/GetObjectCommand/);
    expect(s3).toMatch(/export async function salesFiles\$put\(key: string, body: unknown\)/);
    expect(s3).toMatch(/export async function salesFiles\$get\(key: string\)/);
    expect(s3).toMatch(/JSON\.stringify\(body\)/);
  });

  it("renders the workflow body calling the awaited verb helpers", async () => {
    const { model } = await parseString(SRC, { validate: false });
    const { files } = generateSystems(model);
    const wf = files.get("api/http/workflows.ts")!;
    expect(wf).toMatch(/await salesFiles\$get\(/);
    expect(wf).toMatch(/await salesFiles\$put\(/);
  });

  it("imports the verb helpers from the resource client module (so it compiles)", async () => {
    const { model } = await parseString(SRC, { validate: false });
    const { files } = generateSystems(model);
    const wf = files.get("api/http/workflows.ts")!;
    expect(wf).toMatch(/import \{ salesFiles\$get, salesFiles\$put \} from "\.\.\/resources\/s3";/);
  });
});
