// rewriteRelativeImports — the post-emit pass that fixes TS relative-import
// specifiers after a layout relocation (D-REALIZATION-AXES `directoryLayout:`).
// Unlike .NET, TS imports are path-based, so moving a file breaks both its own
// relative imports AND any other file that imports it.

import { describe, expect, it } from "vitest";
import { rewriteRelativeImports } from "../../../src/generator/typescript/layout-imports.js";

describe("rewriteRelativeImports", () => {
  it("is a no-op when nothing moved (byLayer default stays byte-identical)", () => {
    const out = new Map<string, string>([
      ["db/repositories/order-repository.ts", `import * as schema from "../schema";\n`],
      ["db/schema.ts", `export const x = 1;\n`],
    ]);
    const before = new Map(out);
    rewriteRelativeImports(out, new Map());
    expect(out).toEqual(before);
  });

  it("rewrites a MOVED file's own imports for its new location", () => {
    const out = new Map<string, string>([
      // repository moved to features/order/
      [
        "features/order/order-repository.ts",
        `import * as schema from "../schema";\nimport { Order } from "../../domain/order";\nimport * as Ids from "../../domain/ids";\n`,
      ],
      ["db/schema.ts", ""],
      ["features/order/order.ts", ""], // domain module also moved
      ["domain/ids.ts", ""], // pooled — stayed
    ]);
    const moved = new Map<string, string>([
      ["db/repositories/order-repository.ts", "features/order/order-repository.ts"],
      ["domain/order.ts", "features/order/order.ts"],
    ]);
    rewriteRelativeImports(out, moved);
    const repo = out.get("features/order/order-repository.ts")!;
    // schema stayed at db/schema → from features/order/ it is ../../db/schema
    expect(repo).toContain(`import * as schema from "../../db/schema";`);
    // the agg domain module ALSO moved to features/order/order → ./order
    expect(repo).toContain(`import { Order } from "./order";`);
    // ids stayed pooled at domain/ids → ../../domain/ids (unchanged value, but
    // recomputed from the new source dir — happens to match)
    expect(repo).toContain(`import * as Ids from "../../domain/ids";`);
  });

  it("rewrites a STAYED file that imports a moved target", () => {
    const out = new Map<string, string>([
      // http/index.ts did NOT move, but imports the routes that did
      ["http/index.ts", `import { orderRoutes } from "./order.routes";\n`],
      ["features/order/order.routes.ts", ""],
    ]);
    const moved = new Map<string, string>([
      ["http/order.routes.ts", "features/order/order.routes.ts"],
    ]);
    rewriteRelativeImports(out, moved);
    // from http/index.ts → ../features/order/order.routes
    expect(out.get("http/index.ts")).toContain(
      `import { orderRoutes } from "../features/order/order.routes";`,
    );
  });

  it('rewrites DYNAMIC `import("…")` specifiers (lazy obs/log in routes)', () => {
    const out = new Map<string, string>([
      ["features/order/order.routes.ts", `const log = (await import("../obs/log")).honoLog;\n`],
      ["obs/log.ts", ""],
    ]);
    const moved = new Map<string, string>([
      ["http/order.routes.ts", "features/order/order.routes.ts"],
    ]);
    rewriteRelativeImports(out, moved);
    // from features/order/ → ../../obs/log
    expect(out.get("features/order/order.routes.ts")).toContain(`import("../../obs/log")`);
  });

  it("leaves bare-module specifiers alone", () => {
    // The repository (db/repositories/<agg>) moved to features/order/; it
    // imports `../schema` (→ db/schema, stayed) and a bare module.
    const out = new Map<string, string>([
      [
        "features/order/order-repository.ts",
        `import { z } from "zod";\nimport * as schema from "../schema";\n`,
      ],
      ["db/schema.ts", ""],
    ]);
    const moved = new Map<string, string>([
      ["db/repositories/order-repository.ts", "features/order/order-repository.ts"],
    ]);
    rewriteRelativeImports(out, moved);
    const f = out.get("features/order/order-repository.ts")!;
    expect(f).toContain(`import { z } from "zod";`); // untouched
    expect(f).toContain(`import * as schema from "../../db/schema";`); // fixed
  });

  it("handles `export … from` re-exports and multi-line imports", () => {
    const out = new Map<string, string>([
      [
        "features/order/order-repository.ts",
        `import {\n  A,\n  B,\n} from "../../domain/value-objects";\nexport { C } from "../schema";\n`,
      ],
      ["domain/value-objects.ts", ""],
      ["db/schema.ts", ""],
    ]);
    const moved = new Map<string, string>([
      ["db/repositories/order-repository.ts", "features/order/order-repository.ts"],
    ]);
    rewriteRelativeImports(out, moved);
    const f = out.get("features/order/order-repository.ts")!;
    expect(f).toContain(`} from "../../domain/value-objects";`); // stayed pooled, recomputed equal
    expect(f).toContain(`export { C } from "../../db/schema";`); // fixed
  });
});
