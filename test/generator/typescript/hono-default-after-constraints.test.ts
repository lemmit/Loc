// Regression: a create field with BOTH a default and min/max invariants
// must render `.min(...).max(...).default(...)` — the `.default(...)` last.
//
// `z.coerce.number().default(3)` returns a `ZodDefault`, which no longer
// exposes `.min` / `.max`.  Emitting `.default(3).min(1)` is a type error
// that poisons the whole request object's inferred type, so every
// `body.<field>` collapses to `unknown` in the route handler.  The default
// is now applied after the single-field invariant chain.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  system Sys {
    subdomain Ops {
      context Ops {
        aggregate Widget {
          name: string
          rating: int = 3
          invariant rating >= 1
          invariant rating <= 5
        }
        repository Widgets for Widget {}
      }
    }
    storage primary { type: postgres }
    deployable api {
      platform: node
      contexts: [Ops]
      port: 3000
    }
  }
`;

async function routesFile(): Promise<string> {
  const files = (await generateSystems(await parseValid(SRC))).files;
  const path = [...files.keys()].find((k) => k.endsWith("/http/widget.routes.ts"));
  expect(path, "widget.routes.ts not emitted").toBeDefined();
  return files.get(path!)!;
}

describe("Hono create schema — default applied after min/max", () => {
  it("renders .min().max().default(), never .default().min()", async () => {
    const routes = await routesFile();
    expect(routes).toContain("rating: z.coerce.number().int().min(1).max(5).default(3)");
    expect(routes).not.toMatch(/rating:[^,]*\.default\([^)]*\)\.(?:min|max)\(/);
  });
});
