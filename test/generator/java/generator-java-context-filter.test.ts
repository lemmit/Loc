// ---------------------------------------------------------------------------
// Java backend — capability filters (`filter for "..."`) ride
// Hibernate's @SQLRestriction: the non-principal, relational predicate
// renders to a static SQL fragment appended to every SELECT (the
// HasQueryFilter / Drizzle-WHERE analog).  Principal-referencing
// filters and non-relational shapes stay gated
// (loom.context-filter-unsupported — java joined the limited-families
// set).  Boot-verified end-to-end against Postgres via
// test/e2e/fixtures/java-build/context-filter.ddd (soft-deleted row
// hidden from list + by-id, still physically present).
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const SRC = readFileSync("test/e2e/fixtures/java-build/context-filter.ddd", "utf8");

const ROOT = "cf_api/src/main/java/com/loom/cfapi";

describe("java generator — capability filters (@SQLRestriction)", () => {
  it("annotates the entity with the rendered static SQL fragment", async () => {
    const files = await generateSystemFiles(SRC);
    const doc = files.get(`${ROOT}/features/docs/Doc.java`)!;
    expect(doc).toContain('@SQLRestriction("not (is_deleted)")');
    expect(doc).toContain("import org.hibernate.annotations.SQLRestriction;");
  });

  it("gates a principal-referencing filter (tenancy) fail-fast", async () => {
    const tenancy = `
system CF {
  user { id: string  name: string }
  subdomain D {
    context Docs {
      aggregate Doc {
        owner: string
        filter this.owner == currentUser.name
      }
      repository Docs for Doc { }
    }
  }
  api A from D
  storage primary { type: postgres }
  resource st { for: Docs, kind: state, use: primary }
  deployable cfApi {
    platform: java
    contexts: [Docs]
    dataSources: [st]
    serves: A
    port: 8081
  }
}
`;
    const loom = await buildLoomModel(tenancy);
    const errors = validateLoomModel(loom).filter(
      (d) => d.code === "loom.context-filter-unsupported",
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain("currentUser");
  });
});
