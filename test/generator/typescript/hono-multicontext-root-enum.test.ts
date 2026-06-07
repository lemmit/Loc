// Regression: a multi-context Hono deployable must not emit a root-level
// (ambient) enum / value object once per hosted context.
//
// Root-level enums and value objects are an ambient shared kernel:
// enrichment folds them into EVERY bounded context so per-context
// emitters see them as local (src/ir/enrich/enrichments.ts).  When a
// single Hono deployable hosts several contexts, `emit.ts` unions the
// contexts into one synthetic `merged` context to emit the shared domain
// files.  A naive `flatMap` then carried one copy of each ambient type
// per hosted context, producing duplicate top-level declarations —
// `export const currencyEnum = pgEnum(...)` twice — which the Hono
// bundler rejects with "Multiple exports with the same name".
//
// This reproduces the Acme ERP playground failure (coreApi hosts five
// contexts that all reference the ambient `Currency` enum + `Money` VO).

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

// Two contexts on two modules, both referencing the ambient `Currency`
// enum + `Money` VO, hosted by one Hono deployable.
const SRC = `
enum Currency { USD, EUR, GBP }

valueobject Money {
  amount: decimal
  currency: string
}

system Sys {
  subdomain Sales {
    context Orders {
      aggregate Order {
        total: Money
        cur: Currency
      }
      repository Orders for Order {}
    }
  }
  subdomain Billing {
    context Invoices {
      aggregate Invoice {
        total: Money
        cur: Currency
      }
      repository Invoices for Invoice {}
    }
  }
  storage primary { type: postgres }
  deployable api {
    platform: hono
    contexts: [Orders, Invoices]
    port: 3000
  }
}
`;

async function generate(src: string): Promise<Map<string, string>> {
  return (await generateSystems(await parseValid(src))).files;
}

function fileEndingWith(files: Map<string, string>, suffix: string): string {
  const path = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(path, `${suffix} not emitted`).toBeDefined();
  return files.get(path!)!;
}

function countExports(body: string, decl: string): number {
  return [...body.matchAll(new RegExp(`export ${decl}\\b`, "g"))].length;
}

describe("multi-context Hono deployable — ambient root types are emitted once", () => {
  it("emits the ambient enum exactly once in db/schema.ts", async () => {
    const schema = fileEndingWith(await generate(SRC), "/db/schema.ts");
    expect(countExports(schema, "const currencyEnum")).toBe(1);
  });

  it("emits the ambient value object exactly once in domain/value-objects.ts", async () => {
    const vos = fileEndingWith(await generate(SRC), "/domain/value-objects.ts");
    expect(countExports(vos, "class Money")).toBe(1);
  });
});
